// Runner contract with injected fakes: session policy per mode, fixed order, manual compaction between tasks, rework accounting,
// reviewer parsing (fail closed), held-out tests, unrelated-change detection, usage gaps and recording.
import assert from "node:assert/strict";
import test from "node:test";
import { runBenchmark, parseReviewOutput } from "./lib/runner.mjs";
import { assistant, subagent, u, task, manifest, root, fakeWorkspace, gate, fakeAdapter, fixMain, fixtureConfig } from "./fixtures/fake-runtime.mjs";
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
	const ad = fakeAdapter({ mainScript: (s, text) => { calls++; if (calls === 1) return { events: [assistant(u(10, 10, 0, 0, 0.01))], text: "first try" }; return fixMain(s, text, u(3, 3, 0, 0, 0.002)); } });
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
	const never = () => fakeAdapter({ mainScript: (s) => ({ events: [assistant(u(1, 1))], text: "no fix" }) });
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
	const ad = fakeAdapter({ mainScript: (s) => { fs.writeFileSync(path.join(s.cwd, "agent/work.txt"), "fixed"); fs.writeFileSync(path.join(s.cwd, "tests/gate.txt"), "weakened"); fs.writeFileSync(path.join(s.cwd, "agent/extra.txt"), "noise"); return { events: [assistant(u(1, 1))], text: "x" }; } });
	const r = await run({ tasks: [task("H1", { maxReworkRounds: 0 })], adapter: ad });
	const t = r.tasks[0];
	assert.deepEqual(t.changedFiles.unrelated, ["agent/extra.txt"]);
	assert.equal(t.accepted, false, "an unrelated diff blocks acceptance even when the gate passes");
	assert.deepEqual(t.heldOutOverwritten, ["tests/gate.txt"]);
	assert.equal(t.acceptance.cycles[0].testsPassed, true, "held-out gate restored before the gate runs");
});

test("usage gaps are unavailable, not zero: a turn without usage marks the task partial and the total cost null", async () => {
	const ad = fakeAdapter({ mainScript: (s) => { fs.writeFileSync(path.join(s.cwd, "agent/work.txt"), "fixed"); return { events: [{ type: "assistant", message: { role: "assistant", content: [] } }], text: "x" }; } });
	const r = await run({ tasks: [task("H1")], adapter: ad });
	assert.equal(r.tasks[0].main.status, "unavailable");
	assert.equal(r.tasks[0].main.cost.total, null);
	assert.equal(r.totals.endToEnd.cost, null);
});

test("worker (subagent) usage is a separate ledger that feeds end-to-end cost; the worker cache-tier split is unavailable", async () => {
	const ad = fakeAdapter({ mainScript: (s) => { fs.writeFileSync(path.join(s.cwd, "agent/work.txt"), "fixed"); return { events: [assistant(u(10, 10, 0, 0, 0.1)), subagent(0.03)], text: "x" }; } });
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
	assert.equal(r.schemaVersion, "harness-benchmark-result/2");
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
	const ad = fakeAdapter({ mainScript: (s) => { fs.writeFileSync(path.join(s.cwd, "agent/work.txt"), "fixed"); return { events: [assistant(u(1, 1))], text: "x" }; } });
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
