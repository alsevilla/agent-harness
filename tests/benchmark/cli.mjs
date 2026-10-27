#!/usr/bin/env node
// Benchmark CLI. Run by an operator or the main session from a shell outside any leaf; it is not a subagent or dispatch tool.
//   validate         schema + checkpoint contract of the manifest (offline)
//   validate-history commit/parent/subject identity, declared files, RED/GREEN acceptance in scratch (runs node tests)
//   run              one benchmark mode over the manifest; --adapter pi-sdk needs --pi-package-root and --confirm-live
//   preflight        operator-owned, no prompt: open the main session, prove both native controls and a confirmed shutdown; --confirm-no-prompt-preflight
//   compare          side-by-side comparison of two result files
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { validateManifest, manifestErrors, checkCheckpointContract } from "./lib/manifest.mjs";
import { validateHistory } from "./lib/history.mjs";
import { runBenchmark, MODES } from "./lib/runner.mjs";
import { createWorkspace } from "./lib/workspace.mjs";
import { createPiSdkAdapter } from "./lib/sdk-adapter.mjs";
import { createSyntheticAdapter } from "./lib/synthetic-adapter.mjs";
import { compareResults } from "./lib/compare.mjs";
import { candidateRuntime, resourceShadowing } from "./lib/runtime.mjs";
import { resolveBenchmarkRoles } from "./lib/roles.mjs";
import { TOPOLOGY_METHOD, describeProblems, safeTopologyReason } from "./lib/topology.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_REPO = path.resolve(HERE, "..", "..");
const DEFAULT_MANIFEST = path.join(HERE, "manifest.json");

function parseArgs(argv) {
	const [command, ...rest] = argv;
	const flags = {}; const positional = [];
	for (let i = 0; i < rest.length; i++) {
		const a = rest[i];
		if (a.startsWith("--")) {
			const key = a.slice(2);
			const next = rest[i + 1];
			if (next === undefined || next.startsWith("--")) flags[key] = true;
			else { flags[key] = next; i++; }
		} else positional.push(a);
	}
	return { command, flags, positional };
}

const git = (repo, ...args) => execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();

function candidateIdentity(repo) {
	const head = git(repo, "rev-parse", "HEAD");
	const status = git(repo, "status", "--porcelain");
	return { repo, branch: git(repo, "rev-parse", "--abbrev-ref", "HEAD"), head, dirtyEntries: status ? status.split("\n").length : 0 };
}

// --max-rework-rounds needs an explicit whole number >= 0: a bare flag (true), an empty, signed, fractional or unsafe value is refused.
function reworkCapFlag(flags) {
	const raw = flags["max-rework-rounds"];
	if (raw === undefined) return null;
	if (typeof raw !== "string" || !/^(0|[1-9]\d*)$/.test(raw)) throw new Error(`--max-rework-rounds requires an explicit whole number >= 0, got ${typeof raw === "string" ? JSON.stringify(raw) : "no value (bare flag)"}`);
	const value = Number(raw);
	if (!Number.isSafeInteger(value)) throw new Error(`--max-rework-rounds must be a safe integer, got ${raw}`);
	return { value, source: `run flag --max-rework-rounds ${raw}` };
}

// --diagnostic-chars: the same explicit whole-number rule (>= 0) for the diagnostic text cap; the source shows the typed value.
function diagnosticCharsFlag(flags) {
	const raw = flags["diagnostic-chars"];
	if (raw === undefined) return null;
	if (typeof raw !== "string" || !/^(0|[1-9]\d*)$/.test(raw)) throw new Error(`--diagnostic-chars requires an explicit whole number >= 0, got ${typeof raw === "string" ? JSON.stringify(raw) : "no value (bare flag)"}`);
	const value = Number(raw);
	if (!Number.isSafeInteger(value)) throw new Error(`--diagnostic-chars must be a safe integer, got ${raw}`);
	return { value, source: `run flag --diagnostic-chars ${raw}` };
}

// --round-timeout-ms / --shutdown-grace-ms: whole milliseconds >= 1 (an explicit typed value; a bare flag, zero, signed or fractional value is refused).
function millisFlag(flags, name) {
	const raw = flags[name];
	if (raw === undefined) return null;
	if (typeof raw !== "string" || !/^[1-9]\d*$/.test(raw) || !Number.isSafeInteger(Number(raw))) throw new Error(`--${name} requires an explicit whole number of milliseconds >= 1, got ${typeof raw === "string" ? JSON.stringify(raw) : "no value (bare flag)"}`);
	return { value: Number(raw), source: `run flag --${name} ${raw}` };
}

// The resource mode of a live run is "profile-installed": sessions load AGENTS.md, skills and role prompts from the profile agent directory, so a candidate edit
// that a profile copy shadows is not what would be measured. Such a run is refused (a Phase 2 measurement blocker), never labelled as the candidate.
function resourcesFor(adapterName, repo, agentDir) {
	if (adapterName !== "pi-sdk") return { mode: "synthetic-not-measured", fingerprint: null, files: 0, shadowed: [] };
	const resources = resourceShadowing({ candidateRoot: repo, agentDir });
	if (resources.shadowed.length) throw new Error(`candidate prompt resources are shadowed by the profile installation (mode profile-installed); this run would not measure the candidate. Install the candidate resources into the profile first, then rerun. Blocker (Phase 2 measurement): ${resources.shadowed.map((f) => `${f.path} [${f.state}]`).join(", ")}`);
	return resources;
}

// The agent topology proof of the exact candidate runtime at this cwd, produced by the real adapter check BEFORE any workspace, session, provider or prompt.
// A check that cannot run is a structured blocking result (never an assumed pass); only an allowlisted reason code is kept, never a foreign error message.
export async function checkTopology({ adapter, repo, cwd }) {
	try { return await adapter.agentTopology({ runtime: candidateRuntime({ candidateRoot: repo }), cwd }); } catch (e) {
		const reason = safeTopologyReason(e);
		return { method: TOPOLOGY_METHOD, ok: false, problems: [{ kind: "topology_unproven", ...(reason ? { reason } : {}) }], fingerprint: null };
	}
}
const topologyBlocker = (t) => `agent_topology: ${describeProblems(t) || "unproven"}`;

// --task H1,H2 selects named tasks (manifest order kept); an empty or unknown selection is refused before any run.
function selectTasks(manifest, flags) {
	if (flags.task === undefined) return manifest;
	if (typeof flags.task !== "string" || flags.task === "") throw new Error("--task requires one or more task ids, comma-separated");
	const wanted = flags.task.split(",").map((s) => s.trim()).filter(Boolean);
	const known = manifest.tasks.map((t) => t.id);
	const unknown = wanted.filter((id) => !known.includes(id));
	if (unknown.length) throw new Error(`unknown task ${unknown.join(", ")} (manifest tasks: ${known.join(", ")})`);
	return { ...manifest, tasks: manifest.tasks.filter((t) => wanted.includes(t.id)) };
}

function requireFlag(flags, name) {
	if (typeof flags[name] !== "string" || flags[name] === "") throw new Error(`--${name} is required`);
	return flags[name];
}

function loadManifest(flags) {
	const file = flags.manifest ? path.resolve(flags.manifest) : DEFAULT_MANIFEST;
	return { file, manifest: JSON.parse(fs.readFileSync(file, "utf8")) };
}

function scratchFor(flags, repo) {
	const scratch = path.resolve(requireFlag(flags, "scratch"));
	const root = path.resolve(repo);
	if (scratch === root || scratch.startsWith(root + path.sep)) throw new Error("--scratch must be outside the candidate checkout");
	return scratch;
}

function writeJson(file, value) {
	fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
	fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

// Operator-owned no-prompt preflight: opens the main session exactly as a run does (candidate extensions, native lifecycle bound), proves both native controls
// are active, never sends a prompt, then closes it and requires the shutdown to be confirmed. It opens no reviewer and no child worker. Opening a session reads
// local configuration only (no model request is made by this code); it cannot prove the SDK makes no provider call while opening, so the operator confirms the check.
export async function preflightMain({ adapter, repo, scratch, roles, limits }) {
	const cwd = path.join(scratch, "preflight-main");
	fs.mkdirSync(cwd, { recursive: true });
	const out = { ok: false, prompted: false, controls: { required: ["subagent", "subagent_control"], active: [] }, shutdown: null, resources: null, error: null };
	let session = null;
	try {
		session = await adapter.openSession({ cwd, role: "main", compactionEnabled: false, taskId: "preflight", runtime: candidateRuntime({ candidateRoot: repo }), roleSpec: roles.main, limits });
		out.controls.active = (await adapter.startContext(session)).activeTools;
		out.resources = session.identity?.resources ?? null;
	} catch (e) {
		out.error = `${e.kind ?? "open_failed"}: ${e.message}`;
	} finally {
		if (session) out.shutdown = await adapter.closeSession(session);
	}
	const missing = out.controls.required.filter((t) => !out.controls.active.includes(t));
	if (!out.error && missing.length) out.error = `native controls not active: ${missing.join(", ")}`;
	if (!out.error && out.shutdown?.confirmed !== true) out.error = "shutdown was not confirmed";
	out.ok = out.error === null;
	return out;
}

async function main(argv) {
	const { command, flags, positional } = parseArgs(argv);
	const repo = flags.repo ? path.resolve(flags.repo) : DEFAULT_REPO;
	if (command === "validate") {
		const { file, manifest } = loadManifest(flags);
		const schema = manifestErrors(manifest);
		const errors = [...schema, ...(schema.length ? [] : checkCheckpointContract(manifest))];
		console.log(JSON.stringify({ manifest: file, tasks: manifest.tasks?.map((t) => t.id) ?? [], errors }, null, 2));
		return errors.length ? 1 : 0;
	}
	if (command === "validate-history") {
		const { manifest } = loadManifest(flags);
		validateManifest(manifest);
		const scratch = scratchFor(flags, repo);
		const report = validateHistory({ manifest, repo, scratchRoot: scratch });
		const out = { ...report, candidate: candidateIdentity(repo), scratch, generatedAt: new Date().toISOString() };
		if (flags.out) writeJson(flags.out, out);
		console.log(JSON.stringify({ ok: report.ok, tasks: report.tasks.map((t) => ({ id: t.id, problems: t.problems, red: t.red?.accepted, green: t.green?.accepted })) }, null, 2));
		return report.ok ? 0 : 1;
	}
	if (command === "run") {
		const mode = requireFlag(flags, "mode");
		if (!MODES[mode]) throw new Error(`--mode must be one of ${Object.keys(MODES).join(", ")}`);
		const reworkFlag = reworkCapFlag(flags);
		const diagFlag = diagnosticCharsFlag(flags);
		const roundFlag = millisFlag(flags, "round-timeout-ms");
		const graceFlag = millisFlag(flags, "shutdown-grace-ms");
		const taskFlag = millisFlag(flags, "task-timeout-ms");
		const adapterName = requireFlag(flags, "adapter");
		const scratch = scratchFor(flags, repo);
		const out = requireFlag(flags, "out");
		const { manifest: fullManifest } = loadManifest(flags);
		const manifest = selectTasks(fullManifest, flags);
		let adapter;
		if (adapterName === "pi-sdk") {
			if (!flags["confirm-live"]) throw new Error("--adapter pi-sdk starts provider-backed sessions; pass --confirm-live from the operator shell");
			adapter = createPiSdkAdapter({ piPackageRoot: requireFlag(flags, "pi-package-root") });
		} else if (adapterName === "synthetic") adapter = createSyntheticAdapter();
		else throw new Error("--adapter must be pi-sdk or synthetic");
		const candidate = candidateIdentity(repo);
		// Real adapter only (a synthetic run measures nothing): a topology that does not resolve every canonical role as a package role ends the run here as a structured
		// blocker with the diagnostic persisted; no workspace, session, provider or prompt exists, so no shutdown is claimed.
		const topology = adapterName === "pi-sdk" ? await checkTopology({ adapter, repo, cwd: scratch }) : null;
		if (topology && topology.ok !== true) {
			writeJson(out, { status: "blocked", blocker: { kind: "agent_topology", problems: topology.problems }, topology, candidate, tasksRun: 0 });
			console.log(JSON.stringify({ status: "blocked", blocker: topologyBlocker(topology), out }, null, 2));
			return 1;
		}
		const runtime = candidateRuntime({ candidateRoot: repo });
		const roles = resolveBenchmarkRoles({ candidateRoot: repo, agentDir: await adapter.agentDir(), main: await adapter.resolveMainSpec({ candidateRoot: repo }) });
		const maxReworkRounds = reworkFlag ?? { value: roles.writer.value, source: roles.writer.source };
		const diagnosticChars = diagFlag ?? { value: roles.writer.diagnosticChars.value, source: roles.writer.diagnosticChars.source };
		const limits = { roundSettleTimeoutMs: roundFlag ?? roles.writer.roundSettleTimeoutMs, shutdownGraceMs: graceFlag ?? roles.writer.shutdownGraceMs, taskTimeoutMs: taskFlag ?? roles.writer.taskTimeoutMs };
		const resources = resourcesFor(adapterName, repo, await adapter.agentDir());
		const config = { limits, resources, topology, maxReworkRounds, diagnosticChars, roles: { main: roles.main, reviewer: roles.reviewer }, registry: roles.files, runtime, recheckRuntime: () => candidateRuntime({ candidateRoot: repo }).fingerprint };
		const selection = { tasks: manifest.tasks.map((t) => t.id), fullTaskCount: fullManifest.tasks.length };
		const result = await runBenchmark({ manifest, mode, adapter, workspace: createWorkspace({ repo, scratchRoot: scratch }), config, writeResult: (r) => writeJson(out, { ...r, candidate, selection }) });
		console.log(JSON.stringify({ status: result.status, error: result.error ?? null, invalid: result.invalid ?? null, expectedWriter: result.expectedWriter, mode, order: result.order, maxReworkRounds: result.config.maxReworkRounds, reviewer: result.config.roles.reviewer.model, accepted: result.totals.acceptance, endToEndCost: result.totals.endToEnd.cost, runtime: result.config.runtime.fingerprint, out }, null, 2));
		return result.status === "complete" ? 0 : 1;
	}
	if (command === "preflight") {
		if (!flags["confirm-no-prompt-preflight"]) throw new Error("preflight opens and closes a main session with the candidate extensions (no prompt, no worker); pass --confirm-no-prompt-preflight from the operator shell");
		const scratch = scratchFor(flags, repo);
		const adapter = createPiSdkAdapter({ piPackageRoot: requireFlag(flags, "pi-package-root") });
		const roles = resolveBenchmarkRoles({ candidateRoot: repo, agentDir: await adapter.agentDir(), main: await adapter.resolveMainSpec({ candidateRoot: repo }) });
		const limits = { roundSettleTimeoutMs: millisFlag(flags, "round-timeout-ms") ?? roles.writer.roundSettleTimeoutMs, shutdownGraceMs: millisFlag(flags, "shutdown-grace-ms") ?? roles.writer.shutdownGraceMs };
		const report = { candidate: candidateIdentity(repo), limits, resources: null, topology: null, blocker: null, check: null };
		try { report.resources = resourcesFor("pi-sdk", repo, await adapter.agentDir()); } catch (e) { report.blocker = e.message; }
		// Both blockers are reported; a blocked preflight opens no session, so it records no shutdown.
		report.topology = await checkTopology({ adapter, repo, cwd: scratch });
		if (report.topology.ok !== true) report.blocker = [report.blocker, topologyBlocker(report.topology)].filter(Boolean).join(" | ");
		if (report.blocker === null) report.check = await preflightMain({ adapter, repo, scratch, roles, limits });
		const ok = report.blocker === null && report.check.ok === true;
		if (flags.out) writeJson(flags.out, report);
		console.log(JSON.stringify({ ok, blocker: report.blocker, check: report.check && { ok: report.check.ok, controls: report.check.controls, shutdown: report.check.shutdown, error: report.check.error } }, null, 2));
		return ok ? 0 : 1;
	}
	if (command === "compare") {
		const files = positional;
		if (files.length !== 2) throw new Error("usage: compare <baseline.json> <candidate.json> [--out file]");
		const report = compareResults(JSON.parse(fs.readFileSync(files[0], "utf8")), JSON.parse(fs.readFileSync(files[1], "utf8")));
		if (flags.out) writeJson(flags.out, report);
		console.log(JSON.stringify({ verdict: report.verdict, reasons: report.reasons, inconclusive: report.inconclusive, allAccepted: report.allAccepted, unacceptedTasks: report.unacceptedTasks, caveat: report.caveat }, null, 2));
		return report.verdict === "REGRESSION" ? 1 : 0;
	}
	console.error("usage: cli.mjs validate | validate-history | run | preflight | compare  (see tests/benchmark/README.md)");
	return 2;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	main(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (e) => { console.error(e.message); process.exitCode = 1; });
}

export { main, parseArgs, resourcesFor };
