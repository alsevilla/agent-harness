// Side-by-side comparison: acceptance drop and high-severity rise are regressions; unavailable or mismatched data is INCONCLUSIVE.
import assert from "node:assert/strict";
import test from "node:test";
import { runBenchmark } from "./lib/runner.mjs";
import { compareResults } from "./lib/compare.mjs";
import { assistant, writerLaunch, task, manifest, root, fakeWorkspace, gate, fakeAdapter, fixMain, u, fixtureConfig, fixtureRoles } from "./fixtures/fake-runtime.mjs";

// The fake adapter stands in for the SDK here: synthetic:false so the offline comparison logic is exercised, not the SYNTHETIC gate.
const run = (tasks, opts = {}) => runBenchmark({ manifest: manifest(tasks), mode: opts.mode ?? "fresh", adapter: opts.adapter ?? fakeAdapter({ mainScript: fixMain, reviewText: opts.review ?? "NO FINDINGS", synthetic: false, reviewSelected: opts.reviewSelected, contractBody: opts.contractBody }), workspace: fakeWorkspace(root()), acceptance: gate, config: opts.config ?? fixtureConfig({ maxReworkRounds: { value: 0, source: "fixture" } }) });
// A delegated writer that did not fix the task: a healthy child, a failing check (scored, not infrastructure).
const failing = (s, text) => ({ events: [writerLaunch(), assistant(u(1, 1))], text: "no fix" });

test("identical runs show no regression and report side-by-side acceptance, rework and cost fields", async () => {
	const a = await run([task("H1"), task("H2")]);
	const b = await run([task("H1"), task("H2")]);
	const c = compareResults(a, b);
	assert.equal(c.verdict, "NO_REGRESSION");
	assert.equal(c.acceptance.drop, 0);
	assert.ok("reworkTurns" in c.rework.candidate && "endToEnd" in c.cost.candidate);
	assert.deepEqual(c.perTask.map((t) => t.id), ["H1", "H2"]);
});

test("an acceptance drop is a regression", async () => {
	const good = await run([task("H1"), task("H2")]);
	const bad = await run([task("H1"), task("H2")], { adapter: fakeAdapter({ mainScript: (s, t) => (t.includes("subject H2") ? failing(s, t) : fixMain(s, t)), reviewText: "NO FINDINGS", synthetic: false }) });
	const c = compareResults(good, bad);
	assert.equal(c.verdict, "REGRESSION");
	assert.ok(c.acceptance.drop > 0);
	assert.ok(c.reasons.some((r) => /acceptance/.test(r)));
});

test("a rise in high-severity reviewer findings is a regression even when acceptance is equal", async () => {
	const good = await run([task("H1")]);
	const worse = await run([task("H1")], { review: "FINDING high: wrong scope" });
	const c = compareResults(good, worse);
	assert.equal(c.verdict, "REGRESSION");
	assert.ok(c.reasons.some((r) => /high/.test(r)));
});

test("unavailable reviewer data or a different manifest/order is INCONCLUSIVE, never a pass", async () => {
	const good = await run([task("H1")]);
	const unavailable = await run([task("H1")], { review: "prose only" });
	assert.equal(compareResults(good, unavailable).verdict, "INCONCLUSIVE");
	const other = await run([task("H2")]);
	assert.equal(compareResults(good, other).verdict, "INCONCLUSIVE");
	const reordered = await run([task("H1"), task("H2")]);
	const reordered2 = await run([task("H2"), task("H1")]);
	assert.equal(compareResults(reordered, reordered2).verdict, "INCONCLUSIVE");
});

test("a failed or partial run is INCONCLUSIVE", async () => {
	const good = await run([task("H1")]);
	const failed = { ...good, status: "failed", error: "boom" };
	assert.equal(compareResults(good, failed).verdict, "INCONCLUSIVE");
});

const eight = Array.from({ length: 8 }, (_, i) => task(`H${i + 1}`));
const failEight = (s, t) => (t.includes("subject H8") ? failing(s, t) : fixMain(s, t));

test("equal 0.875 acceptance on both sides is NO_REGRESSION only relative to the baseline: allAccepted is false and the unaccepted task is named", async () => {
	const base = await run(eight, { adapter: fakeAdapter({ mainScript: failEight, reviewText: "NO FINDINGS", synthetic: false }) });
	const cand = await run(eight, { adapter: fakeAdapter({ mainScript: failEight, reviewText: "NO FINDINGS", synthetic: false }) });
	const c = compareResults(base, cand);
	assert.equal(c.verdict, "NO_REGRESSION");
	assert.equal(c.acceptance.baseline, 0.875);
	assert.equal(c.acceptance.candidate, 0.875);
	assert.equal(c.allAccepted, false);
	assert.deepEqual(c.unacceptedTasks, { baseline: ["H8"], candidate: ["H8"] });
	assert.equal(c.perTask.find((t) => t.id === "H8").baselineAccepted, false);
	assert.equal(c.perTask.find((t) => t.id === "H8").candidateAccepted, false);
	assert.match(c.caveat, /relative/);
	assert.match(c.caveat, /NOT all tasks passed/);
});

test("all tasks accepted on both sides: allAccepted is true and no task is listed as unaccepted", async () => {
	const base = await run(eight);
	const cand = await run(eight);
	const c = compareResults(base, cand);
	assert.equal(c.verdict, "NO_REGRESSION");
	assert.equal(c.allAccepted, true);
	assert.deepEqual(c.unacceptedTasks, { baseline: [], candidate: [] });
});

test("a lower acceptance rate in the candidate (baseline fully accepted) is a regression and names the unaccepted candidate task", async () => {
	const base = await run(eight);
	const cand = await run(eight, { adapter: fakeAdapter({ mainScript: failEight, reviewText: "NO FINDINGS", synthetic: false }) });
	const c = compareResults(base, cand);
	assert.equal(c.verdict, "REGRESSION");
	assert.equal(c.allAccepted, false);
	assert.deepEqual(c.unacceptedTasks, { baseline: [], candidate: ["H8"] });
});

test("a missing task in either result is INCONCLUSIVE, never no-regression", async () => {
	const base = await run(eight);
	const cand = await run(eight);
	const short = { ...cand, tasks: cand.tasks.slice(0, 7), notRun: ["H8"] };
	const c = compareResults(base, short);
	assert.equal(c.verdict, "INCONCLUSIVE");
	assert.ok(c.inconclusive.some((r) => /tasks/.test(r)));
});

test("synthetic results are never a baseline or candidate: INCONCLUSIVE", async () => {
	const base = await run(eight, { adapter: fakeAdapter({ mainScript: fixMain, reviewText: "NO FINDINGS" }) });
	const cand = await run(eight);
	const c = compareResults(base, cand);
	assert.equal(c.verdict, "INCONCLUSIVE");
	assert.ok(c.inconclusive.some((r) => /synthetic/.test(r)));
});

test("different rework cap value, configured reviewer model or mode is INCONCLUSIVE: the runs are not matched", async () => {
	const base = await run([task("H1")]);
	const cap = await run([task("H1")], { config: fixtureConfig({ maxReworkRounds: { value: 2, source: "fixture" } }) });
	assert.equal(compareResults(base, cap).verdict, "INCONCLUSIVE");
	const model = await run([task("H1")], { config: fixtureConfig({ maxReworkRounds: { value: 0, source: "fixture" }, roles: { ...fixtureRoles(), reviewer: { ...fixtureRoles().reviewer, model: "fake/other-review" } } }) });
	assert.equal(compareResults(base, model).verdict, "INCONCLUSIVE");
	const mode = await run([task("H1")], { mode: "long-fixed" });
	assert.equal(compareResults(base, mode).verdict, "INCONCLUSIVE");
});

// Evaluator identity: the reviewer that judged each cycle must match, not only the configured defaults.
const evaluatorReason = (c, field) => c.inconclusive.some((r) => /reviewer evaluator/.test(r) && r.includes(field));

test("same configured reviewer defaults but a fallback-selected effective reviewer is INCONCLUSIVE, never a regression verdict", async () => {
	const base = await run([task("H1")]);
	const fallback = await run([task("H1")], { reviewSelected: "fake/review-fallback" });
	assert.equal(base.config.roles.reviewer.model, fallback.config.roles.reviewer.model, "configured defaults match");
	const c = compareResults(base, fallback);
	assert.equal(c.verdict, "INCONCLUSIVE", JSON.stringify(c.inconclusive));
	assert.ok(evaluatorReason(c, "selectedModel"), c.inconclusive.join("\n"));
	assert.equal(c.perTask[0].evaluatorComparable, false);
});

test("a changed reviewer contract body with the same configured model is INCONCLUSIVE", async () => {
	const base = await run([task("H1")]);
	const changed = await run([task("H1")], { contractBody: "CHANGED REVIEWER CONTRACT" });
	const c = compareResults(base, changed);
	assert.equal(c.verdict, "INCONCLUSIVE", JSON.stringify(c.inconclusive));
	assert.ok(evaluatorReason(c, "contractBodySha256"), c.inconclusive.join("\n"));
});

// Oracle F3: the fixed reviewer's effective prompt and resource bytes are part of its identity; only the raw (cwd/time bearing) prompt digest is not.
test("changed reviewer guidance, base prompt or skills (resource or effective prompt hash) are INCONCLUSIVE, never NO_REGRESSION", async () => {
	const base = await run([task("H1")]);
	for (const field of ["resourcesSha256", "effectivePromptSha256"]) {
		const changed = await run([task("H1")], { adapter: fakeAdapter({ mainScript: fixMain, reviewText: "NO FINDINGS", synthetic: false, reviewResources: { [field]: "f".repeat(64), endResourcesSha256: "f".repeat(64) } }) });
		const c = compareResults(base, changed);
		assert.equal(c.verdict, "INCONCLUSIVE", field);
		assert.ok(evaluatorReason(c, field), c.inconclusive.join("\n"));
	}
});

test("a differing raw prompt digest alone (cwd/time variation) stays comparable; a resource edited during the review is INCONCLUSIVE", async () => {
	const base = await run([task("H1")]);
	const raw = await run([task("H1")], { adapter: fakeAdapter({ mainScript: fixMain, reviewText: "NO FINDINGS", synthetic: false, reviewResources: { promptSha256: "a".repeat(64) } }) });
	assert.equal(compareResults(base, raw).verdict, "NO_REGRESSION");
	const moved = await run([task("H1")], { adapter: fakeAdapter({ mainScript: fixMain, reviewText: "NO FINDINGS", synthetic: false, reviewResources: { stable: false, endResourcesSha256: "b".repeat(64) } }) });
	assert.equal(compareResults(base, moved).verdict, "INCONCLUSIVE");
	assert.equal(moved.totals.evaluator.unidentifiedCycles, 1);
});

test("a fully matching reviewer evaluator is comparable: NO_REGRESSION, recorded per cycle and summarised in totals", async () => {
	const base = await run([task("H1"), task("H2")]);
	const cand = await run([task("H1"), task("H2")]);
	const c = compareResults(base, cand);
	assert.equal(c.verdict, "NO_REGRESSION", JSON.stringify(c.inconclusive));
	assert.deepEqual(c.perTask.map((t) => t.evaluatorComparable), [true, true]);
	const e = base.tasks[0].reviewer.cycles[0].evaluator;
	assert.equal(e.selectedModel, "fake/review-model");
	assert.equal(e.observedModel, "fake/review-model");
	assert.equal(e.method, "sdk-isolated-session-role-contract");
	assert.equal(base.totals.evaluator.effective.length, 1);
	assert.equal(base.totals.evaluator.unidentifiedCycles, 0);
});

test("different rework cycle counts with the same reviewer evaluator stay comparable (first and final cycle compared, not counts)", async () => {
	const base = await run([task("H1")], { config: fixtureConfig({ maxReworkRounds: { value: 1, source: "fixture" } }) });
	// The candidate's first pass does not fix the file; the rework prompt does. Same reviewer on every cycle.
	const cand = await runBenchmark({ manifest: manifest([task("H1")]), mode: "fresh", adapter: fakeAdapter({ mainScript: (s, t) => (t.startsWith("REWORK") ? fixMain(s, t) : failing(s, t)), reviewText: "NO FINDINGS", synthetic: false }), workspace: fakeWorkspace(root()), acceptance: gate, config: fixtureConfig({ maxReworkRounds: { value: 1, source: "fixture" } }) });
	assert.equal(base.tasks[0].reviewer.cycles.length, 1);
	assert.equal(cand.tasks[0].reviewer.cycles.length, 2);
	const c = compareResults(base, cand);
	assert.equal(c.verdict, "NO_REGRESSION", JSON.stringify(c.inconclusive));
	assert.equal(c.perTask[0].evaluatorComparable, true);
});

test("a missing reviewer evaluator on any cycle is INCONCLUSIVE: unknown identity is never invented", async () => {
	const base = await run([task("H1")]);
	const cand = await run([task("H1")]);
	const stripped = structuredClone(cand);
	delete stripped.tasks[0].reviewer.cycles[0].evaluator;
	const c = compareResults(base, stripped);
	assert.equal(c.verdict, "INCONCLUSIVE");
	assert.ok(c.inconclusive.some((r) => /complete evaluator identity/.test(r)), c.inconclusive.join("\n"));
});

test("a changed configured reviewer fallback chain is INCONCLUSIVE even when the selected reviewer matches", async () => {
	const base = await run([task("H1")]);
	const cand = await run([task("H1")], { config: fixtureConfig({ maxReworkRounds: { value: 0, source: "fixture" }, roles: { ...fixtureRoles(), reviewer: { ...fixtureRoles().reviewer, fallbacks: [] } } }) });
	const c = compareResults(base, cand);
	assert.equal(c.verdict, "INCONCLUSIVE");
	assert.ok(c.inconclusive.some((r) => /reviewer model, thinking or fallbacks differ/.test(r)), c.inconclusive.join("\n"));
});

test("results from the previous schema are not comparable with this schema", async () => {
	const base = await run([task("H1")]);
	const cand = await run([task("H1")]);
	const c = compareResults({ ...base, schemaVersion: "harness-benchmark-result/1" }, cand);
	assert.equal(c.verdict, "INCONCLUSIVE");
	assert.ok(c.inconclusive.some((r) => /schemaVersion/.test(r)));
});
