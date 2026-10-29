// CLI regression for --max-rework-rounds: an explicit whole number is required before any run starts. Synthetic adapter only.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { main, preflightMain, resourcesFor } from "./cli.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REAL = JSON.parse(fs.readFileSync(path.join(HERE, "manifest.json"), "utf8"));

// Output stays in a temp directory (os.tmpdir() is the approved TEMP for this run); the console is silenced per call.
const dir = (name) => fs.mkdtempSync(path.join(os.tmpdir(), `bench-cli-${name}-`));
async function quiet(fn) {
	const log = console.log;
	console.log = () => {};
	try { return await fn(); } finally { console.log = log; }
}

// Refusal: the manifest path is deliberately absent, so any run or manifest load would fail with ENOENT, not the flag message.
// A bare flag is followed by --scratch in every case, so it parses as boolean true (the defect under test).
for (const [label, flagTokens] of [
	["bare flag (followed by another flag)", ["--max-rework-rounds"]],
	["empty value", ["--max-rework-rounds", ""]],
	["negative value", ["--max-rework-rounds", "-1"]],
	["noninteger value", ["--max-rework-rounds", "1.5"]],
	["exponent form", ["--max-rework-rounds", "1e3"]],
	["unsafe integer", ["--max-rework-rounds", "9007199254740993"]],
]) {
	test(`refuses --max-rework-rounds ${label} before any run starts`, async () => {
		const d = dir("refuse");
		const out = path.join(d, "result.json");
		const scratch = path.join(d, "work");
		const argv = ["run", "--mode", "fresh", "--adapter", "synthetic", ...flagTokens, "--scratch", scratch, "--out", out, "--manifest", path.join(d, "absent.json")];
		await assert.rejects(quiet(() => main(argv)), (e) => /--max-rework-rounds/.test(e.message) && !/ENOENT/.test(e.message), `${label}: expected the flag refusal`);
		assert.equal(fs.existsSync(out), false, "no result file");
		assert.equal(fs.existsSync(scratch), false, "no scratch work directory");
	});
}

// C2: --diagnostic-chars is an explicit whole number >= 0, refused before any run starts (same rule as --max-rework-rounds).
for (const [label, flagTokens] of [
	["bare flag (followed by another flag)", ["--diagnostic-chars"]],
	["negative value", ["--diagnostic-chars", "-1"]],
	["fraction", ["--diagnostic-chars", "1.5"]],
]) {
	test(`refuses --diagnostic-chars ${label} before any run starts`, async () => {
		const d = dir("refuse-diag");
		const out = path.join(d, "result.json");
		const scratch = path.join(d, "work");
		const argv = ["run", "--mode", "fresh", "--adapter", "synthetic", ...flagTokens, "--scratch", scratch, "--out", out, "--manifest", path.join(d, "absent.json")];
		await assert.rejects(quiet(() => main(argv)), (e) => /--diagnostic-chars/.test(e.message) && !/ENOENT/.test(e.message), `${label}: expected the flag refusal`);
		assert.equal(fs.existsSync(out), false, "no result file");
	});
}

// C5/C6: --task selects named tasks in manifest order; an unknown id is refused before any run; an invalid run exits nonzero.
test("--task selects the named tasks in manifest order and records the selection; an unknown id is refused before any run", async () => {
	const d = dir("task");
	const manifest = path.join(d, "two.json");
	fs.writeFileSync(manifest, JSON.stringify({ schemaVersion: REAL.schemaVersion, name: "cli-two", expectedWriter: REAL.expectedWriter, tasks: [REAL.tasks[0], REAL.tasks[1]] }));
	const out = path.join(d, "result.json");
	await assert.rejects(quiet(() => main(["run", "--mode", "fresh", "--adapter", "synthetic", "--task", "NOPE", "--scratch", path.join(d, "work"), "--out", out, "--manifest", manifest])), /unknown task NOPE/);
	assert.equal(fs.existsSync(out), false, "no result file for an unknown task");
	const code = await quiet(() => main(["run", "--mode", "fresh", "--adapter", "synthetic", "--task", REAL.tasks[1].id, "--max-rework-rounds", "0", "--scratch", path.join(d, "work2"), "--out", out, "--manifest", manifest]));
	const r = JSON.parse(fs.readFileSync(out, "utf8"));
	assert.deepEqual(r.order, [REAL.tasks[1].id]);
	assert.deepEqual(r.selection, { tasks: [REAL.tasks[1].id], fullTaskCount: 2 });
	assert.deepEqual(r.config.diagnosticChars, { value: 300, source: "package roles.json role general-worker" });
	assert.equal(r.status, "invalid", "the synthetic main never delegates: method invalid, not complete");
	assert.equal(code, 1, "a non-complete run exits nonzero");
});

// Valid values: explicit 0 and a positive integer are kept, and the recorded source shows the typed value.
for (const v of ["0", "3"]) {
	test(`--max-rework-rounds ${v} is kept as the typed value with a source that shows it`, async () => {
		const d = dir("valid");
		const out = path.join(d, "result.json");
		const manifest = path.join(d, "one-task.json");
		fs.writeFileSync(manifest, JSON.stringify({ schemaVersion: REAL.schemaVersion, name: "cli-one-task", expectedWriter: REAL.expectedWriter, tasks: [REAL.tasks[0]] }));
		await quiet(() => main(["run", "--mode", "fresh", "--adapter", "synthetic", "--max-rework-rounds", v, "--scratch", path.join(d, "work"), "--out", out, "--manifest", manifest]));
		const r = JSON.parse(fs.readFileSync(out, "utf8"));
		assert.deepEqual(r.config.maxReworkRounds, { value: Number(v), source: `run flag --max-rework-rounds ${v}` });
		assert.equal(r.synthetic, true);
	});
}

// Oracle R4: the settlement timeout and shutdown grace are explicit whole milliseconds >= 1 (refused before any run), recorded with their source.
for (const flag of ["round-timeout-ms", "shutdown-grace-ms", "task-timeout-ms"]) {
	for (const [label, tokens] of [["bare flag", [`--${flag}`]], ["empty value", [`--${flag}`, ""]], ["zero", [`--${flag}`, "0"]], ["negative", [`--${flag}`, "-5"]], ["fraction", [`--${flag}`, "1.5"]], ["exponent", [`--${flag}`, "1e3"]], ["unsafe integer", [`--${flag}`, "9007199254740993"]]]) {
		test(`refuses --${flag} ${label} before any run starts`, async () => {
			const d = dir("refuse-ms");
			const out = path.join(d, "result.json");
			const argv = ["run", "--mode", "fresh", "--adapter", "synthetic", ...tokens, "--scratch", path.join(d, "work"), "--out", out, "--manifest", path.join(d, "absent.json")];
			await assert.rejects(quiet(() => main(argv)), (e) => e.message.includes(`--${flag}`) && !/ENOENT/.test(e.message));
			assert.equal(fs.existsSync(out), false);
		});
	}
}

test("--round-timeout-ms and --shutdown-grace-ms override the roles.json defaults with a source that shows the typed value", async () => {
	const d = dir("ms");
	const out = path.join(d, "result.json");
	const manifest = path.join(d, "one.json");
	fs.writeFileSync(manifest, JSON.stringify({ schemaVersion: REAL.schemaVersion, name: "cli-ms", expectedWriter: REAL.expectedWriter, tasks: [REAL.tasks[0]] }));
	await quiet(() => main(["run", "--mode", "fresh", "--adapter", "synthetic", "--round-timeout-ms", "7000", "--shutdown-grace-ms", "250", "--max-rework-rounds", "0", "--scratch", path.join(d, "work"), "--out", out, "--manifest", manifest]));
	const r = JSON.parse(fs.readFileSync(out, "utf8"));
	assert.deepEqual(r.config.limits.roundSettleTimeoutMs, { value: 7000, source: "run flag --round-timeout-ms 7000" });
	assert.deepEqual(r.config.limits.shutdownGraceMs, { value: 250, source: "run flag --shutdown-grace-ms 250" });
	await quiet(() => main(["run", "--mode", "fresh", "--adapter", "synthetic", "--max-rework-rounds", "0", "--scratch", path.join(d, "work2"), "--out", out, "--manifest", manifest]));
	const def = JSON.parse(fs.readFileSync(out, "utf8"));
	assert.equal(def.config.limits.roundSettleTimeoutMs.source, "package roles.json role general-worker");
	assert.equal(def.config.resources.mode, "synthetic-not-measured");
});

test("a live run refuses when the profile installation shadows candidate prompt resources (profile-installed mode, Phase 2 blocker); identical copies pass", () => {
	const cand = dir("cand");
	const agentDir = dir("profile");
	fs.mkdirSync(path.join(cand, "agent"), { recursive: true });
	fs.writeFileSync(path.join(cand, "agent", "AGENTS.md"), "policy v2");
	fs.writeFileSync(path.join(agentDir, "AGENTS.md"), "policy v1");
	assert.throws(() => resourcesFor("pi-sdk", cand, agentDir), /shadowed by the profile installation.*profile-installed.*Phase 2 measurement.*agent\/AGENTS\.md \[differs\]/s);
	fs.writeFileSync(path.join(agentDir, "AGENTS.md"), "policy v2");
	const ok = resourcesFor("pi-sdk", cand, agentDir);
	assert.equal(ok.mode, "profile-installed");
	assert.deepEqual(ok.shadowed, []);
	assert.match(ok.fingerprint, /^[0-9a-f]{64}$/);
});

// P2: the preflight opens and closes the main session only; it never prompts and never opens a reviewer.
const preflightAdapter = ({ active = ["read", "subagent", "subagent_control"], closed = { confirmed: true, ms: 3, pendingJobs: [] }, openError } = {}) => {
	const log = [];
	return { log, async openSession(o) { log.push(["open", o.role, o.taskId]); if (openError) throw openError; return { identity: { resources: { agentsFiles: [], skills: [], extensionErrors: [] } } }; }, async startContext() { return { activeTools: active }; }, async prompt() { log.push(["prompt"]); throw new Error("preflight must never prompt"); }, async closeSession() { log.push(["close"]); return closed; } };
};
const pfRoles = { main: { model: "fake/main", fallbacks: [], thinking: "high", source: "fixture" } };
const pfLimits = { roundSettleTimeoutMs: { value: 1000, source: "t" }, shutdownGraceMs: { value: 1000, source: "t" } };
const REPO = path.resolve(HERE, "..", "..");

test("preflight passes only with both native controls active and a confirmed shutdown, and never prompts", async () => {
	const ad = preflightAdapter();
	const r = await preflightMain({ adapter: ad, repo: REPO, scratch: dir("pf"), roles: pfRoles, limits: pfLimits });
	assert.equal(r.ok, true);
	assert.equal(r.prompted, false);
	assert.deepEqual(ad.log, [["open", "main", "preflight"], ["close"]]);
});

test("preflight fails when a native control is missing, the shutdown is unconfirmed or the open fails; the session is still closed", async () => {
	const base = { repo: REPO, roles: pfRoles, limits: pfLimits };
	const noControl = await preflightMain({ ...base, adapter: preflightAdapter({ active: ["read", "subagent"] }), scratch: dir("pf") });
	assert.equal(noControl.ok, false);
	assert.match(noControl.error, /subagent_control/);
	const hung = await preflightMain({ ...base, adapter: preflightAdapter({ closed: { confirmed: false, ms: 9, pendingJobs: [] } }), scratch: dir("pf") });
	assert.equal(hung.ok, false);
	assert.match(hung.error, /shutdown was not confirmed/);
	const failed = preflightAdapter({ openError: Object.assign(new Error("shadowed"), { kind: "resource_shadowing" }) });
	const r = await preflightMain({ ...base, adapter: failed, scratch: dir("pf") });
	assert.equal(r.ok, false);
	assert.match(r.error, /resource_shadowing: shadowed/);
	assert.equal(failed.log.some((e) => e[0] === "close"), false, "nothing to close when no session opened");
});

test("the preflight command needs the explicit no-prompt confirmation before it touches the SDK", async () => {
	await assert.rejects(quiet(() => main(["preflight", "--scratch", dir("pf"), "--pi-package-root", "/pi"])), /--confirm-no-prompt-preflight/);
});

// A3: the task deadline (20 minutes by default, grace reserved inside) with manifest task > run flag > roles.json default; synthetic adapter only, never a quality baseline.
const oneTask = (d, over = {}) => { const file = path.join(d, "one.json"); fs.writeFileSync(file, JSON.stringify({ schemaVersion: REAL.schemaVersion, name: "cli-deadline", expectedWriter: REAL.expectedWriter, tasks: [{ ...REAL.tasks[0], ...over }] })); return file; };
const runCli = async (d, extra, manifest) => { const out = path.join(d, "result.json"); await quiet(() => main(["run", "--mode", "fresh", "--adapter", "synthetic", "--max-rework-rounds", "0", ...extra, "--scratch", path.join(d, "work"), "--out", out, "--manifest", manifest])); return JSON.parse(fs.readFileSync(out, "utf8")); };

test("the task deadline defaults to the 20 minute roles.json value with the 60 s grace reserved inside, and the source is recorded", async () => {
	const d = dir("deadline-default");
	const r = await runCli(d, [], oneTask(d));
	assert.deepEqual(r.config.limits.taskTimeoutMs, { value: 1200000, source: "package roles.json role general-worker" });
	assert.equal(r.synthetic, true);
	const b = r.tasks[0].budget;
	assert.deepEqual([b.taskTimeoutMs, b.graceMs, b.workCutoffOffsetMs, b.deadlineOffsetMs, b.source], [1200000, 60000, 1140000, 1200000, "package roles.json role general-worker"]);
});

test("--task-timeout-ms overrides the default and a manifest task override wins over the run flag, each with its source", async () => {
	const flagDir = dir("deadline-flag");
	const flagged = await runCli(flagDir, ["--task-timeout-ms", "777000"], oneTask(flagDir));
	assert.deepEqual(flagged.config.limits.taskTimeoutMs, { value: 777000, source: "run flag --task-timeout-ms 777000" });
	assert.deepEqual([flagged.tasks[0].budget.taskTimeoutMs, flagged.tasks[0].budget.source], [777000, "run flag --task-timeout-ms 777000"]);
	const manDir = dir("deadline-manifest");
	const won = await runCli(manDir, ["--task-timeout-ms", "777000"], oneTask(manDir, { taskTimeoutMs: 123456 }));
	assert.deepEqual([won.tasks[0].budget.taskTimeoutMs, won.tasks[0].budget.source], [123456, `manifest task ${REAL.tasks[0].id}`]);
	assert.equal(won.tasks[0].budget.workCutoffOffsetMs, 123456 - 60000);
});

test("an override with no work window after the grace, or an invalid manifest task limit, is refused before any scratch or result is written", async () => {
	for (const [label, extra, over] of [["flag equal to the grace", ["--task-timeout-ms", "60000"], {}], ["manifest value below the grace", [], { taskTimeoutMs: 1000 }], ["manifest zero", [], { taskTimeoutMs: 0 }], ["manifest fraction", [], { taskTimeoutMs: 1.5 }], ["manifest string", [], { taskTimeoutMs: "1200000" }]]) {
		const d = dir("deadline-refuse");
		const out = path.join(d, "result.json");
		await assert.rejects(quiet(() => main(["run", "--mode", "fresh", "--adapter", "synthetic", "--max-rework-rounds", "0", ...extra, "--scratch", path.join(d, "work"), "--out", out, "--manifest", oneTask(d, over)])), /taskTimeoutMs|task-timeout-ms|work window/, label);
		assert.equal(fs.existsSync(out), false, `${label}: no result file`);
		assert.equal(fs.existsSync(path.join(d, "work")), false, `${label}: no scratch work`);
	}
});
