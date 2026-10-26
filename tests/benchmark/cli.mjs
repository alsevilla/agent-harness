#!/usr/bin/env node
// Benchmark CLI. Run by an operator or the main session from a shell outside any leaf; it is not a subagent or dispatch tool.
//   validate         schema + checkpoint contract of the manifest (offline)
//   validate-history commit/parent/subject identity, declared files, RED/GREEN acceptance in scratch (runs node tests)
//   run              one benchmark mode over the manifest; --adapter pi-sdk needs --pi-package-root and --confirm-live
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
import { candidateRuntime } from "./lib/runtime.mjs";
import { resolveBenchmarkRoles } from "./lib/roles.mjs";

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
		const adapterName = requireFlag(flags, "adapter");
		const scratch = scratchFor(flags, repo);
		const out = requireFlag(flags, "out");
		const { manifest } = loadManifest(flags);
		let adapter;
		if (adapterName === "pi-sdk") {
			if (!flags["confirm-live"]) throw new Error("--adapter pi-sdk starts provider-backed sessions; pass --confirm-live from the operator shell");
			adapter = createPiSdkAdapter({ piPackageRoot: requireFlag(flags, "pi-package-root") });
		} else if (adapterName === "synthetic") adapter = createSyntheticAdapter();
		else throw new Error("--adapter must be pi-sdk or synthetic");
		const candidate = candidateIdentity(repo);
		const runtime = candidateRuntime({ candidateRoot: repo });
		const roles = resolveBenchmarkRoles({ candidateRoot: repo, agentDir: await adapter.agentDir(), main: await adapter.resolveMainSpec({ candidateRoot: repo }) });
		const maxReworkRounds = reworkFlag ?? { value: roles.writer.value, source: roles.writer.source };
		const config = { maxReworkRounds, roles: { main: roles.main, reviewer: roles.reviewer }, registry: roles.files, runtime, recheckRuntime: () => candidateRuntime({ candidateRoot: repo }).fingerprint };
		const result = await runBenchmark({ manifest, mode, adapter, workspace: createWorkspace({ repo, scratchRoot: scratch }), config, writeResult: (r) => writeJson(out, { ...r, candidate }) });
		console.log(JSON.stringify({ status: result.status, error: result.error ?? null, mode, order: result.order, maxReworkRounds: result.config.maxReworkRounds, reviewer: result.config.roles.reviewer.model, accepted: result.totals.acceptance, endToEndCost: result.totals.endToEnd.cost, runtime: result.config.runtime.fingerprint, out }, null, 2));
		return result.status === "complete" ? 0 : 1;
	}
	if (command === "compare") {
		const files = positional;
		if (files.length !== 2) throw new Error("usage: compare <baseline.json> <candidate.json> [--out file]");
		const report = compareResults(JSON.parse(fs.readFileSync(files[0], "utf8")), JSON.parse(fs.readFileSync(files[1], "utf8")));
		if (flags.out) writeJson(flags.out, report);
		console.log(JSON.stringify({ verdict: report.verdict, reasons: report.reasons, inconclusive: report.inconclusive, allAccepted: report.allAccepted, unacceptedTasks: report.unacceptedTasks, caveat: report.caveat }, null, 2));
		return report.verdict === "REGRESSION" ? 1 : 0;
	}
	console.error("usage: cli.mjs validate | validate-history | run | compare  (see tests/benchmark/README.md)");
	return 2;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	main(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (e) => { console.error(e.message); process.exitCode = 1; });
}

export { main, parseArgs };
