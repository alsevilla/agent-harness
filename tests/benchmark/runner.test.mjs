// Runner contract with injected fakes: session policy per mode, fixed order, manual compaction between tasks, rework accounting,
// reviewer parsing (fail closed), held-out tests, unrelated-change detection, usage gaps and recording.
import assert from "node:assert/strict";
import test from "node:test";
import { runBenchmark, parseReviewOutput, boundedDiagnostic } from "./lib/runner.mjs";
import { assistant, subagent, writerLaunch, u, task, manifest, root, fakeWorkspace, gate, fakeAdapter, fixMain, fixtureConfig } from "./fixtures/fake-runtime.mjs";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const run = (opts) => runBenchmark({ manifest: manifest(opts.tasks), mode: opts.mode ?? "fresh", adapter: opts.adapter, workspace: fakeWorkspace(root()), acceptance: gate, config: opts.config ?? fixtureConfig(), writeResult: opts.writeResult });

test("fresh mode opens and closes one new main session per task, in manifest order", async () => {
	const ad = fakeAdapter({ mainScript: fixMain });
	const r = await run({ tasks: [task("H1"), task("H2")], adapter: ad });
	assert.equal(r.status, "complete");
	assert.deepEqual(r.order, ["H1", "H2"]);
	assert.equal(ad.log.filter((e) => e[0] === "open" && e[2] === "main").length, 2);
	assert.equal(ad.log.filter((e) => e[0] === "close").length, 4, "two main and two reviewer sessions closed");
	assert.equal(r.config.sessionPolicy, "new-per-task");
});

test("long-fixed reuses one main session with compaction disabled and never compacts", async () => {
	const ad = fakeAdapter({ mainScript: fixMain });
	const r = await run({ tasks: [task("H1"), task("H2"), task("H3")], adapter: ad, mode: "long-fixed" });
	assert.equal(ad.log.filter((e) => e[0] === "open" && e[2] === "main").length, 1);
	assert.equal(ad.log.filter((e) => e[0] === "compact").length, 0);
	assert.ok(r.tasks.every((t) => t.compactionBefore === null));
	assert.equal(ad.log.find((e) => e[0] === "open" && e[2] === "main")[3], false);
});

test("long-compacted performs exactly one manual compaction between consecutive tasks, none before the first", async () => {
	const ad = fakeAdapter({ mainScript: fixMain });
	const r = await run({ tasks: [task("H1"), task("H2"), task("H3")], adapter: ad, mode: "long-compacted" });
	const seq = ad.log.filter((e) => (e[0] === "compact" || e[0] === "prompt") && e[2] !== "review").map((e) => (e[0] === "compact" ? "C" : e[3] === "rework" ? "R" : "T"));
	assert.deepEqual(seq, ["T", "C", "T", "C", "T"]);
	assert.equal(r.tasks[0].compactionBefore, null);
	assert.equal(r.tasks[1].compactionBefore.tokensBefore, 900);
	assert.equal(r.totals.compaction.calls, 2);
});

test("a failed manual compaction fails the arm closed; completed tasks are kept and the rest are listed as not run", async () => {
	const r = await run({ tasks: [task("H1"), task("H2"), task("H3")], adapter: fakeAdapter({ mainScript: fixMain, compactFails: true }), mode: "long-compacted" });
	assert.equal(r.status, "failed");
	assert.match(r.error, /summary model unavailable/);
	assert.deepEqual(r.tasks.map((t) => t.id), ["H1"]);
	assert.deepEqual(r.notRun, ["H2", "H3"]);
});

test("rework follows a failing gate; rework turns count only turns of rework prompts", async () => {
	let calls = 0;
	const ad = fakeAdapter({ mainScript: (s, text) => { calls++; if (calls === 1) return { events: [writerLaunch(), assistant(u(10, 10, 0, 0, 0.01))], text: "first try" }; return fixMain(s, text, u(3, 3, 0, 0, 0.002)); } });
	const r = await run({ tasks: [task("H1")], adapter: ad });
	const t = r.tasks[0];
	assert.equal(t.accepted, true);
	assert.equal(t.reworkRounds, 1);
	assert.equal(t.reworkTurns, 1, "one assistant turn came from the single rework prompt");
	assert.equal(t.main.turns, 2);
	assert.equal(t.acceptance.cycles.length, 2);
	assert.equal(t.acceptance.cycles[0].testsPassed, false);
	assert.equal(t.acceptance.cycles[1].testsPassed, true);
});

test("rework cap precedence: manifest task > run config > roles.json default; each task records the winning value and its source", async () => {
	const never = () => fakeAdapter({ mainScript: (s) => ({ events: [writerLaunch(), assistant(u(1, 1))], text: "no fix" }) });
	const r1 = await run({ tasks: [task("H1")], adapter: never() });
	assert.equal(r1.tasks[0].reworkRounds, 2);
	assert.deepEqual(r1.tasks[0].maxReworkRounds, { value: 2, source: "fixture roles default" });
	assert.equal(r1.tasks[0].accepted, false);
	const r2 = await run({ tasks: [task("H1", { maxReworkRounds: 0 })], adapter: never() });
	assert.equal(r2.tasks[0].reworkRounds, 0);
	assert.deepEqual(r2.tasks[0].maxReworkRounds, { value: 0, source: "manifest task H1" });
	const r3 = await run({ tasks: [task("H1")], adapter: never(), config: fixtureConfig({ maxReworkRounds: { value: 1, source: "run flag --max-rework-rounds" } }) });
	assert.equal(r3.tasks[0].reworkRounds, 1);
	assert.deepEqual(r3.tasks[0].maxReworkRounds, { value: 1, source: "run flag --max-rework-rounds" });
	assert.deepEqual(r3.config.maxReworkRounds, { value: 1, source: "run flag --max-rework-rounds" });
	const r4 = await run({ tasks: [task("H1", { maxReworkRounds: 0 })], adapter: never(), config: fixtureConfig({ maxReworkRounds: { value: 1, source: "run flag --max-rework-rounds" } }) });
	assert.deepEqual(r4.tasks[0].maxReworkRounds, { value: 0, source: "manifest task H1" }, "the task override beats the run flag");
});

test("reviewer output: FINDING lines parsed by severity; NO FINDINGS is zero; unrecognised output is unavailable, never zero", () => {
	assert.deepEqual(parseReviewOutput("FINDING high: breaks routing\nFINDING medium: naming\nFINDING critical: data loss"), { status: "ok", findings: [{ severity: "high", text: "breaks routing" }, { severity: "medium", text: "naming" }, { severity: "critical", text: "data loss" }], highCount: 2 });
	assert.deepEqual(parseReviewOutput("looks fine to me\nNO FINDINGS"), { status: "ok", findings: [], highCount: 0 });
	assert.deepEqual(parseReviewOutput("I think it is probably fine."), { status: "unavailable", findings: [], highCount: null });
});

test("an unavailable reviewer does not trigger rework, is recorded as unavailable, and makes the total unavailable", async () => {
	const r = await run({ tasks: [task("H1")], adapter: fakeAdapter({ mainScript: fixMain, reviewText: "unstructured prose" }) });
	assert.equal(r.tasks[0].reworkRounds, 0);
	assert.equal(r.tasks[0].reviewer.cycles[0].status, "unavailable");
	assert.equal(r.tasks[0].reviewer.cycles[0].highCount, null);
	assert.equal(r.totals.reviewer.unavailableCycles, 1);
	assert.equal(r.totals.highFindings.final, null);
});

test("a high-severity reviewer finding triggers rework even when the gate passes", async () => {
	const r = await run({ tasks: [task("H1")], adapter: fakeAdapter({ mainScript: fixMain, reviewText: "FINDING high: missing guard" }) });
	assert.equal(r.tasks[0].reworkRounds, 2);
	assert.equal(r.tasks[0].reviewer.cycles[0].highCount, 1);
	assert.equal(r.totals.highFindings.first, 1);
});

test("unrelated changes block acceptance; worker edits to held-out tests are overwritten and recorded", async () => {
	const ad = fakeAdapter({ mainScript: (s) => { fs.writeFileSync(path.join(s.cwd, "agent/work.txt"), "fixed"); fs.writeFileSync(path.join(s.cwd, "tests/gate.txt"), "weakened"); fs.writeFileSync(path.join(s.cwd, "agent/extra.txt"), "noise"); return { events: [writerLaunch(), assistant(u(1, 1))], text: "x" }; } });
	const r = await run({ tasks: [task("H1", { maxReworkRounds: 0 })], adapter: ad });
	const t = r.tasks[0];
	assert.deepEqual(t.changedFiles.unrelated, ["agent/extra.txt"]);
	assert.equal(t.accepted, false, "an unrelated diff blocks acceptance even when the gate passes");
	assert.deepEqual(t.heldOutOverwritten, ["tests/gate.txt"]);
	assert.equal(t.acceptance.cycles[0].testsPassed, true, "held-out gate restored before the gate runs");
});

test("usage gaps are unavailable, not zero: a turn without usage marks the task partial and the total cost null", async () => {
	const ad = fakeAdapter({ mainScript: (s) => { fs.writeFileSync(path.join(s.cwd, "agent/work.txt"), "fixed"); return { events: [writerLaunch(), { type: "assistant", message: { role: "assistant", content: [] } }], text: "x" }; } });
	const r = await run({ tasks: [task("H1")], adapter: ad });
	assert.equal(r.tasks[0].main.status, "unavailable");
	assert.equal(r.tasks[0].main.cost.total, null);
	assert.equal(r.totals.endToEnd.cost, null);
});

test("worker (subagent) usage is a separate ledger that feeds end-to-end cost; the worker cache-tier split is unavailable", async () => {
	const ad = fakeAdapter({ mainScript: (s) => { fs.writeFileSync(path.join(s.cwd, "agent/work.txt"), "fixed"); return { events: [assistant(u(10, 10, 0, 0, 0.1)), subagent(0.03, "general-worker")], text: "x" }; } });
	const r = await run({ tasks: [task("H1")], adapter: ad });
	const t = r.tasks[0];
	assert.equal(t.worker.launches, 1);
	assert.equal(t.worker.cost.total, 0.03);
	assert.equal(t.main.cost.total, 0.1);
	assert.ok(Math.abs(r.totals.endToEnd.cost - 0.15) < 1e-12, `main 0.10 + worker 0.03 + reviewer 0.02, got ${r.totals.endToEnd.cost}`);
	assert.equal(r.totals.endToEnd.cacheTier, null);
});

test("start context is captured before each task's first main prompt, so a shared session shows growth", async () => {
	const r = await run({ tasks: [task("H1"), task("H2")], adapter: fakeAdapter({ mainScript: fixMain }), mode: "long-fixed" });
	assert.equal(r.tasks[0].startContext.systemPromptChars, 500);
	assert.ok(r.tasks[1].startContext.contextTokens > r.tasks[0].startContext.contextTokens);
});

test("the result records schema, mode, order, config, environment, manifest digest, synthetic flag", async () => {
	const r = await run({ tasks: [task("H1"), task("H2")], adapter: fakeAdapter({ mainScript: fixMain }), mode: "long-fixed" });
	assert.equal(r.schemaVersion, "harness-benchmark-result/5");
	assert.equal(r.expectedWriter, "general-worker");
	assert.equal(r.mode, "long-fixed");
	assert.deepEqual(r.order, ["H1", "H2"]);
	assert.equal(r.synthetic, true);
	assert.match(r.manifestDigest, /^[0-9a-f]{64}$/);
	assert.equal(typeof r.environment.node, "string");
	assert.equal(r.environment.adapter.name, "fake-adapter");
	assert.deepEqual(r.config.maxReworkRounds, { value: 2, source: "fixture roles default" });
	assert.equal(r.config.sessionPolicy, "shared-fixed-order");
	assert.equal(r.config.compaction, "none");
	assert.equal(r.config.reviewer, "fresh-session-per-review");
	assert.deepEqual(r.config.roles.reviewer, fixtureConfig().roles.reviewer, "the configured reviewer spec is recorded as configured");
	assert.deepEqual(r.config.runtime, { fingerprint: "fixture-runtime-1", endFingerprint: null, root: "fixture-candidate", extensions: ["fixture-extension.ts"] });
});

test("results are written after every task and once at the end, so partial evidence survives a later failure", async () => {
	const seen = [];
	await run({ tasks: [task("H1"), task("H2")], adapter: fakeAdapter({ mainScript: fixMain }), writeResult: (r) => seen.push(r.tasks.length) });
	assert.deepEqual(seen, [1, 2, 2]);
});

test("an invalid rework cap or an unknown mode is refused before any session opens", async () => {
	const ad = fakeAdapter({ mainScript: fixMain });
	await assert.rejects(run({ tasks: [task("H1")], adapter: ad, config: fixtureConfig({ maxReworkRounds: { value: -1, source: "run flag" } }) }), /maxReworkRounds/);
	await assert.rejects(run({ tasks: [task("H1")], adapter: ad, config: fixtureConfig({ maxReworkRounds: { value: 2, source: "" } }) }), /source/);
	await assert.rejects(run({ tasks: [task("H1")], adapter: ad, config: fixtureConfig({ maxReworkRounds: 2 }) }), /maxReworkRounds/, "a bare number has no source and is refused");
	await assert.rejects(run({ tasks: [task("H1", { maxReworkRounds: -2 })], adapter: ad }), /maxReworkRounds/);
	await assert.rejects(run({ tasks: [task("H1")], adapter: ad, config: fixtureConfig({ roles: undefined }) }), /roles/);
	await assert.rejects(run({ tasks: [task("H1")], adapter: ad, mode: "nope" }), /unknown mode/);
	assert.equal(ad.log.length, 0);
});

test("configured models and their observed identity are recorded per task: main session and each reviewer cycle, served model from events", async () => {
	const ad = fakeAdapter({ mainScript: (s) => { fs.writeFileSync(path.join(s.cwd, "agent/work.txt"), "fixed"); return { events: [writerLaunch(), assistant(u(1, 1))], text: "x" }; } });
	const r = await run({ tasks: [task("H1")], adapter: ad });
	const t = r.tasks[0];
	assert.equal(t.models.main.configured.model, "fake/main-model");
	assert.equal(t.models.main.opened.selected.model, "fake/main-model");
	assert.deepEqual(t.models.main.served, [{ provider: "fake", model: "fake-model" }]);
	assert.equal(t.models.reviewer.configured.model, "fake/review-model");
	assert.equal(t.reviewer.cycles[0].identity.selected.model, "fake/review-model");
	assert.deepEqual(t.reviewer.cycles[0].served, [{ provider: "fake", model: "fake-model" }]);
	assert.equal(t.reviewer.cycles[0].identity.servedThinking, "unknown", "served thinking is never certified");
});

test("a candidate runtime that changes during the run fails the run instead of recording a mixed measurement", async () => {
	const ad = fakeAdapter({ mainScript: fixMain });
	const r = await run({ tasks: [task("H1")], adapter: ad, config: fixtureConfig({ recheckRuntime: () => "changed-fingerprint" }) });
	assert.equal(r.status, "failed");
	assert.match(r.error, /candidate runtime changed during the run/);
	assert.equal(r.config.runtime.endFingerprint, "changed-fingerprint");
});

test("an unchanged candidate runtime is recorded at the start and the end of the run", async () => {
	const r = await run({ tasks: [task("H1")], adapter: fakeAdapter({ mainScript: fixMain }), config: fixtureConfig({ recheckRuntime: () => "fixture-runtime-1" }) });
	assert.equal(r.status, "complete");
	assert.equal(r.config.runtime.endFingerprint, "fixture-runtime-1");
});

// --- Method validity (C2-C6): launch diagnostics, held-out comparison per round, fail-closed stops, delegation ---
const runWith = (opts) => runBenchmark({ manifest: manifest(opts.tasks), mode: "fresh", adapter: opts.adapter, workspace: opts.workspace ?? fakeWorkspace(root()), acceptance: gate, config: opts.config ?? fixtureConfig(), writeResult: opts.writeResult });
// A delegated writer whose child never produced a turn (spawn or prelaunch failure).
const failedWriter = (over = {}) => ({ type: "subagent", details: { mode: "single", results: [{ agent: "general-worker", exitCode: 1, stopReason: "error", errorMessage: "spawn failed token=sk-abcdefgh12345", stderr: "boom", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 }, ...over }] } });

test("held-out acceptance: an untouched added or modified file is not flagged; a main edit is flagged in its own round; the set resets per round", async () => {
	const ws = fakeWorkspace(root());
	const heldOut = ws.heldOut;
	ws.heldOut = async (t, dir) => { await heldOut(t, dir); fs.writeFileSync(path.join(dir, "tests/added.txt"), "held-green"); };
	let calls = 0;
	const ad = fakeAdapter({ mainScript: (s) => {
		calls++;
		if (calls === 1) { fs.writeFileSync(path.join(s.cwd, "tests/gate.txt"), "tampered"); return { events: [writerLaunch(), assistant(u(1, 1))], text: "t" }; }
		return fixMain(s, "rework");
	} });
	const r = await runWith({ tasks: [task("H1", { acceptanceTests: ["tests/gate.txt", "tests/added.txt"] })], adapter: ad, workspace: ws });
	const t = r.tasks[0];
	assert.equal(t.acceptance.cycles.length, 2);
	assert.deepEqual(t.acceptance.cycles[0].heldOutOverwritten, ["tests/gate.txt"], "the main edit to the modified acceptance file is flagged");
	assert.deepEqual(t.acceptance.cycles[1].heldOutOverwritten, [], "round 1 starts from the restored file; nothing overwritten");
	assert.deepEqual(t.heldOutOverwritten, [], "the record reflects the final round only");
	assert.equal(t.accepted, true);
});

test("a worker launch with no child turn stops the run before review, rework and the next task; partial results are kept and the run is invalid", async () => {
	let mains = 0;
	const ad = fakeAdapter({ mainScript: () => { mains++; return { events: [failedWriter(), assistant(u(1, 1))], text: "delegated" }; } });
	const r = await runWith({ tasks: [task("H1"), task("H2")], adapter: ad });
	assert.equal(r.status, "invalid");
	assert.match(r.error, /H1 infrastructure: launch_failed/);
	assert.equal(r.tasks.length, 1);
	assert.deepEqual(r.notRun, ["H2"]);
	const t = r.tasks[0];
	assert.equal(t.status, "infrastructure");
	assert.equal(t.invalid.class, "infrastructure");
	assert.equal(t.invalid.kind, "launch_failed");
	assert.equal(t.reviewer.cycles.length, 0);
	assert.equal(t.reworkRounds, 0);
	assert.equal(mains, 1, "no rework prompt");
	assert.equal(ad.log.filter((e) => e[0] === "prompt" && e[3] === "review").length, 0, "no review prompt");
	assert.equal(t.worker.launches, 0);
	assert.equal(t.worker.failedLaunches, 1);
	assert.equal(t.worker.status, "failed");
	assert.equal(r.totals.worker.status, "failed");
	assert.equal(r.totals.endToEnd.cost, null, "unknown worker cost stays unknown, never zero");
	assert.equal(t.delegation.launches[0].status, "no-child-turn");
	assert.equal(t.delegation.launches[0].errorMessage, "spawn failed token=[REDACTED]");
	assert.equal(t.main.turns, 1, "the partial main ledger is kept");
});

test("a main session with no assistant turn is an infrastructure failure: no review, run invalid", async () => {
	const r = await runWith({ tasks: [task("H1")], adapter: fakeAdapter({ mainScript: () => ({ events: [], text: "" }) }) });
	assert.equal(r.status, "invalid");
	assert.equal(r.tasks[0].invalid.kind, "no_assistant_turn");
	assert.equal(r.tasks[0].invalid.class, "infrastructure");
	assert.equal(r.tasks[0].reviewer.cycles.length, 0);
});

test("a healthy writer whose task check fails is scored (completed, not accepted), not an infrastructure failure", async () => {
	const r = await runWith({ tasks: [task("H1", { maxReworkRounds: 0 })], adapter: fakeAdapter({ mainScript: () => ({ events: [writerLaunch(), assistant(u(1, 1))], text: "tried" }) }) });
	assert.equal(r.status, "complete");
	assert.equal(r.tasks[0].status, "completed");
	assert.equal(r.tasks[0].accepted, false);
	assert.equal(r.tasks[0].reviewer.cycles.length, 1);
	assert.equal(r.tasks[0].invalid, undefined);
	assert.equal(r.totals.acceptance.accepted, 0);
});

test("a main pass with no general-worker launch is method invalid (missing_delegation): no review; a debugger launch alone does not satisfy the writer", async () => {
	const ad = fakeAdapter({ mainScript: (s) => { fs.writeFileSync(path.join(s.cwd, "agent/work.txt"), "fixed"); return { events: [subagent(0, "debugger"), assistant(u(1, 1))], text: "done" }; } });
	const r = await runWith({ tasks: [task("H1"), task("H2")], adapter: ad });
	assert.equal(r.status, "invalid");
	assert.equal(r.tasks[0].status, "method_invalid");
	assert.equal(r.tasks[0].invalid.class, "methodinvalid");
	assert.equal(r.tasks[0].invalid.kind, "missing_delegation");
	assert.deepEqual(r.tasks[0].invalid.launchedAgents, ["debugger"], "the actual roles are recorded, not inferred");
	assert.equal(r.tasks[0].reviewer.cycles.length, 0);
	assert.deepEqual(r.notRun, ["H2"]);
});

test("a direct main edit or write is method invalid (direct_main_write) even when the writer also launched; it never scores as success", async () => {
	const ad = fakeAdapter({ mainScript: (s) => { fs.writeFileSync(path.join(s.cwd, "agent/work.txt"), "fixed"); return { events: [{ type: "tool", name: "edit", isError: false }, writerLaunch(), assistant(u(1, 1))], text: "done" }; } });
	const r = await runWith({ tasks: [task("H1")], adapter: ad });
	assert.equal(r.status, "invalid");
	assert.equal(r.tasks[0].invalid.kind, "direct_main_write");
	assert.equal(r.tasks[0].invalid.class, "methodinvalid");
	assert.equal(r.tasks[0].accepted, false);
	assert.equal(r.tasks[0].reviewer.cycles.length, 0);
});

test("a valid delegated writer is accepted; an extra debugger launch is optional and recorded with its actual role", async () => {
	const ad = fakeAdapter({ mainScript: (s) => { fs.writeFileSync(path.join(s.cwd, "agent/work.txt"), "fixed"); return { events: [subagent(0, "debugger"), writerLaunch(0.01), assistant(u(1, 1))], text: "done" }; } });
	const r = await runWith({ tasks: [task("H1")], adapter: ad });
	assert.equal(r.status, "complete");
	const t = r.tasks[0];
	assert.equal(t.accepted, true);
	assert.deepEqual(t.delegation.launches.map((l) => [l.agent, l.status]), [["debugger", "measured"], ["general-worker", "measured"]]);
	assert.equal(t.delegation.writerLaunches, 1);
	assert.equal(t.worker.launches, 2);
});

test("main diagnostics: tool names, counts and errors; bounded sanitized final text; launch record has role and status, never packet text", async () => {
	const ad = fakeAdapter({ mainScript: (s) => { fs.writeFileSync(path.join(s.cwd, "agent/work.txt"), "fixed"); return { events: [{ type: "tool", name: "read", isError: false }, { type: "tool", name: "grep", isError: true, errorText: "no match api_key=abc123secret" }, { type: "tool", name: "read", isError: false }, writerLaunch(), assistant(u(1, 1))], text: `final ANTHROPIC_API_KEY=sk-ant-api03-abcdefgh12345 ${"x".repeat(500)}` }; } });
	const r = await runWith({ tasks: [task("H1")], adapter: ad, config: fixtureConfig({ diagnosticChars: { value: 40, source: "run flag --diagnostic-chars 40" } }) });
	const t = r.tasks[0];
	assert.deepEqual(t.mainDiagnostics.tools.read, { calls: 2, errors: 0 });
	assert.equal(t.mainDiagnostics.tools.grep.calls, 1);
	assert.equal(t.mainDiagnostics.tools.grep.errors, 1);
	assert.match(t.mainDiagnostics.tools.grep.firstError, /api_key=\[REDACTED\]/);
	assert.doesNotMatch(t.mainDiagnostics.tools.grep.firstError, /abc123secret/);
	assert.equal(t.mainDiagnostics.finalText.text.length, 40);
	assert.equal(t.mainDiagnostics.finalText.truncated, true);
	assert.doesNotMatch(t.mainDiagnostics.finalText.text, /sk-ant-api03/);
	assert.deepEqual(r.config.diagnosticChars, { value: 40, source: "run flag --diagnostic-chars 40" });
	assert.equal(t.delegation.launches[0].status, "measured");
	assert.equal(t.delegation.launches[0].agent, "general-worker");
	assert.equal(JSON.stringify(t.delegation).includes("Harness task"), false, "no packet text in the launch record");
});

test("a per-task diagnostic override wins over the run cap and records its source", async () => {
	const r = await runWith({ tasks: [task("H1", { diagnosticChars: 10 })], adapter: fakeAdapter({ mainScript: fixMain }) });
	assert.deepEqual(r.tasks[0].delegation.diagnosticChars, { value: 10, source: "manifest task H1" });
	assert.ok(r.tasks[0].mainDiagnostics.finalText.text.length <= 10);
});

test("boundedDiagnostic redacts credentials before truncating; the head is kept, or the tail on request, within the cap", () => {
	const s = boundedDiagnostic("Authorization: Bearer abc.def-123 and secret=hunter2 ghp_abcdefghijklmnop", 300);
	assert.doesNotMatch(s.text, /abc\.def|hunter2|ghp_abcdef/);
	assert.match(s.text, /\[REDACTED\]/);
	assert.deepEqual(boundedDiagnostic("x".repeat(500), 300), { text: "x".repeat(300), truncated: true });
	assert.deepEqual(boundedDiagnostic("0123456789", 4, { tail: true }), { text: "6789", truncated: true });
	assert.deepEqual(boundedDiagnostic(undefined, 4), { text: null, truncated: false });
});

// Synthetic values only. Redaction runs before bounding, so no fragment of a secret survives at any head or tail cut.
test("boundedDiagnostic redacts AWS key IDs, Basic auth, URL userinfo and JSON-quoted secrets, at every head and tail cut", () => {
	const aws = "AKIAZZZZSYNTHETIC123";
	const aws2 = "ASIAZZZZSYNTHETIC456";
	const basic = "dGVzdDpzeW50aGV0aWM=";
	const raw = `ids=${aws},${aws2} key failed; AUTHORIZATION: basic ${basic} via https://synth-user:synth-pass@example.test/x {"token": "synth-json-value", "PASSWORD":"synth-pw"} token count 42`;
	const leaked = ["AKIAZZZZ", "ASIAZZZZ", "dGVzdDpz", "synth-user", "synth-pass", "synth-json", "synth-pw"];
	const full = boundedDiagnostic(raw, 10000);
	assert.equal(full.text, "ids=[REDACTED],[REDACTED] key failed; AUTHORIZATION: basic [REDACTED] via https://[REDACTED]@example.test/x {\"token\": \"[REDACTED]\", \"PASSWORD\":\"[REDACTED]\"} token count 42");
	for (let limit = 1; limit <= full.text.length; limit++) {
		const head = boundedDiagnostic(raw, limit).text;
		const tail = boundedDiagnostic(raw, limit, { tail: true }).text;
		for (const fragment of leaked) {
			assert.ok(!head.includes(fragment), `head ${limit} leaked ${fragment}`);
			assert.ok(!tail.includes(fragment), `tail ${limit} leaked ${fragment}`);
		}
	}
	assert.equal(boundedDiagnostic("Error: exit 1 in cli.mjs", 300).text, "Error: exit 1 in cli.mjs");
});

test("the diagnostic cap is required config: a missing or invalid cap is refused before any session opens", async () => {
	const ad = fakeAdapter({ mainScript: fixMain });
	const { diagnosticChars, ...noCap } = fixtureConfig();
	await assert.rejects(runWith({ tasks: [task("H1")], adapter: ad, config: noCap }), /diagnosticChars/);
	await assert.rejects(runWith({ tasks: [task("H1")], adapter: ad, config: fixtureConfig({ diagnosticChars: { value: -1, source: "x" } }) }), /diagnosticChars/);
	assert.equal(ad.log.length, 0);
});

// --- H4 method fix: per-round telemetry and the generated tool-state measurement policy ---
test("each round records its index, assistant turns, writer launches and tool call counts (no arguments, no inference from totals)", async () => {
	const ad = fakeAdapter({ mainScript: (s, text) => text.startsWith("REWORK")
		? { events: [{ type: "tool", name: "read", isError: false }, { type: "tool", name: "read", isError: true, errorText: "nope" }, assistant(u(1, 1)), assistant(u(1, 1))], text: "r1" }
		: { events: [{ type: "tool", name: "subagent", isError: false }, writerLaunch(), writerLaunch(), assistant(u(1, 1))], text: "r0" } });
	const r = await runWith({ tasks: [task("H1", { maxReworkRounds: 1 })], adapter: ad });
	assert.deepEqual(r.tasks[0].mainDiagnostics.rounds, [
		{ round: 0, assistantTurns: 1, writerLaunches: 2, toolCalls: 1, tools: { subagent: { calls: 1, errors: 0 } } },
		{ round: 1, assistantTurns: 2, writerLaunches: 0, toolCalls: 2, tools: { read: { calls: 2, errors: 1 } } },
	]);
});

const serenaRun = async ({ files, workspace, adapterFix = true }) => {
	const ad = fakeAdapter({ mainScript: (s) => {
		if (adapterFix) fs.writeFileSync(path.join(s.cwd, "agent/work.txt"), "fixed");
		for (const [p, text] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(s.cwd, p)), { recursive: true }); fs.writeFileSync(path.join(s.cwd, p), text); }
		return { events: [writerLaunch(), assistant(u(1, 1))], text: "done" };
	} });
	return runWith({ tasks: [task("H1", { maxReworkRounds: 0 })], adapter: ad, workspace });
};
const sha256 = (t) => crypto.createHash("sha256").update(t).digest("hex");

test("generated untracked root .serena/ state is excluded from scored changes but reported with paths and hashes and kept in the raw inventory", async () => {
	const r = await serenaRun({ files: { ".serena/cache/a.pkl": "A", ".serena/project.local.yml": "B" }, workspace: fakeWorkspace(root()) });
	const t = r.tasks[0];
	assert.equal(t.accepted, true);
	assert.deepEqual(t.changedFiles.unrelated, []);
	assert.deepEqual(t.changedFiles.changed, ["agent/work.txt"]);
	assert.deepEqual(t.changedFiles.toolStateChanges, [{ path: ".serena/cache/a.pkl", sha256: sha256("A") }, { path: ".serena/project.local.yml", sha256: sha256("B") }]);
	assert.deepEqual(t.changedFiles.inventory.added, [".serena/cache/a.pkl", ".serena/project.local.yml"], "every raw path stays visible");
	assert.deepEqual(r.config.measurementPolicy.toolState.roots, [".serena/"], "the exclusion policy is part of the comparable config");
});

test("real out-of-scope artifacts and look-alike paths are never excluded: they fail the task as unrelated beside .serena state", async () => {
	const files = { ".serena/x": "x", ".h4-checks/build-env.test.ts": "1", "parse.out": "2", "parse.err": "3", ".serena2/x": "4", "sub/.serena/x": "5", ".serenax": "6", "random.log": "7" };
	const r = await serenaRun({ files, workspace: fakeWorkspace(root()) });
	const t = r.tasks[0];
	assert.equal(t.accepted, false);
	assert.deepEqual(t.changedFiles.unrelated, [".h4-checks/build-env.test.ts", ".serena2/x", ".serenax", "parse.err", "parse.out", "random.log", "sub/.serena/x"]);
	assert.deepEqual(t.changedFiles.toolStateChanges.map((x) => x.path), [".serena/x"]);
	assert.equal(t.changedFiles.inventory.added.length, 8);
});

test("a tracked or preexisting .serena file cannot hide: a modified or removed one is an unrelated change, not tool state", async () => {
	for (const act of [(p) => fs.writeFileSync(p, "edited"), (p) => fs.rmSync(p)]) {
		const ws = fakeWorkspace(root(), { tracked: { ".serena/project.yml": "tracked" } });
		const ad = fakeAdapter({ mainScript: (s) => { fs.writeFileSync(path.join(s.cwd, "agent/work.txt"), "fixed"); act(path.join(s.cwd, ".serena/project.yml")); return { events: [writerLaunch(), assistant(u(1, 1))], text: "d" }; } });
		const r = await runWith({ tasks: [task("H1", { maxReworkRounds: 0 })], adapter: ad, workspace: ws });
		assert.deepEqual(r.tasks[0].changedFiles.unrelated, [".serena/project.yml"]);
		assert.deepEqual(r.tasks[0].changedFiles.toolStateChanges, []);
		assert.equal(r.tasks[0].accepted, false);
	}
});

test("a workspace without a tool-state policy excludes nothing and records no exclusion", async () => {
	const ws = fakeWorkspace(root());
	delete ws.toolStatePolicy;
	const r = await serenaRun({ files: { ".serena/x": "x" }, workspace: ws });
	assert.deepEqual(r.tasks[0].changedFiles.unrelated, [".serena/x"]);
	assert.equal(r.config.measurementPolicy.toolState, null);
});
