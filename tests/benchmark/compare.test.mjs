// Side-by-side comparison: acceptance drop and high-severity rise are regressions; unavailable or mismatched data is INCONCLUSIVE.
import assert from "node:assert/strict";
import fs from "node:fs";
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

test("a different measurement exclusion policy (or one side lacking it) is INCONCLUSIVE: policies are never silently mixed", async () => {
	const base = await run([task("H1")]);
	const cand = await run([task("H1")]);
	const withPolicy = (r, tool) => ({ ...r, config: { ...r.config, measurementPolicy: { toolState: tool } } });
	const pol = { id: "p", roots: [".serena/"] };
	for (const [a, b] of [[pol, null], [null, pol], [pol, { ...pol, roots: [".other/"] }]]) {
		const c = compareResults(withPolicy(base, a), withPolicy(cand, b));
		assert.equal(c.verdict, "INCONCLUSIVE");
		assert.ok(c.inconclusive.some((r) => /measurement exclusion policy/.test(r)), c.inconclusive.join("\n"));
	}
	assert.ok(!compareResults(withPolicy(base, pol), withPolicy(cand, pol)).inconclusive.some((r) => /measurement exclusion policy/.test(r)));
});

test("a schema 4 result is INCONCLUSIVE against a schema 5 result", async () => {
	const base = await run([task("H1")]);
	const c = compareResults({ ...base, schemaVersion: "harness-benchmark-result/4" }, await run([task("H1")]));
	assert.equal(c.verdict, "INCONCLUSIVE");
	assert.ok(c.inconclusive.some((r) => /schemaVersion/.test(r)));
});

// A task cut by the task deadline (budget_exhausted) or a review that never ran is missing quality evidence: never NO_REGRESSION, even if the result is mislabelled complete.
test("a budget_exhausted task or an unknown review cycle is INCONCLUSIVE, never NO_REGRESSION", async () => {
	const good = await run([task("H1")]);
	const cut = JSON.parse(JSON.stringify(good));
	cut.tasks[0].status = "budget_exhausted";
	cut.tasks[0].budget = { ...(cut.tasks[0].budget ?? {}), exhausted: true, stage: "acceptance" };
	const c = compareResults(good, cut);
	assert.equal(c.verdict, "INCONCLUSIVE");
	assert.ok(c.inconclusive.some((r) => /budget/.test(r)), c.inconclusive.join("\n"));
	const unknown = JSON.parse(JSON.stringify(good));
	unknown.tasks[0].reviewer.cycles.at(-1).status = "unknown";
	assert.equal(compareResults(good, unknown).verdict, "INCONCLUSIVE");
	assert.equal(compareResults(unknown, good).verdict, "INCONCLUSIVE");
});

// F7: effective per-task capacity controls (task timeout, round settlement, shutdown grace and the derived budget fields) are measurement controls: a missing or different value is
// INCONCLUSIVE; the provenance string and absolute clock timestamps are not comparison keys.
const withLimits = (over) => fixtureConfig({ maxReworkRounds: { value: 0, source: "fixture" }, limits: { ...fixtureConfig().limits, ...over } });
const lim = (value, source = "fixture") => ({ value, source });
test("a different task timeout (1200000 vs 2400000) is INCONCLUSIVE, not NO_REGRESSION", async () => {
	const a = await run([task("H1")]);
	const b = await run([task("H1")], { config: withLimits({ taskTimeoutMs: lim(2400000) }) });
	const c = compareResults(a, b);
	assert.equal(c.verdict, "INCONCLUSIVE");
	assert.ok(c.inconclusive.some((r) => /taskTimeoutMs/.test(r)), c.inconclusive.join("|"));
});
test("a different round settlement or shutdown grace is INCONCLUSIVE", async () => {
	const a = await run([task("H1")]);
	for (const over of [{ roundSettleTimeoutMs: lim(500000) }, { shutdownGraceMs: lim(10000) }]) {
		const c = compareResults(a, await run([task("H1")], { config: withLimits(over) }));
		assert.equal(c.verdict, "INCONCLUSIVE", JSON.stringify(over));
	}
});
test("a missing capacity field on either side is INCONCLUSIVE (no implicit unlimited default)", async () => {
	const a = await run([task("H1")]);
	const b = structuredClone(a);
	delete b.config.limits.shutdownGraceMs;
	assert.equal(compareResults(a, b).verdict, "INCONCLUSIVE");
	const c = structuredClone(a);
	delete c.tasks[0].budget.taskTimeoutMs;
	assert.equal(compareResults(a, c).verdict, "INCONCLUSIVE");
	assert.equal(compareResults(c, a).verdict, "INCONCLUSIVE");
});
test("identical values with different provenance strings and different absolute timestamps stay comparable", async () => {
	const a = await run([task("H1")]);
	const b = await run([task("H1")], { config: withLimits({ taskTimeoutMs: lim(1200000, "a different run flag"), shutdownGraceMs: lim(30000, "other source") }) });
	b.startedAt = "2099-01-01T00:00:00.000Z"; b.finishedAt = "2099-01-01T01:00:00.000Z"; b.tasks[0].budget.exhaustedAtOffsetMs = 999;
	assert.equal(compareResults(a, b).verdict, "NO_REGRESSION");
});
test("a per-task manifest override is caught even when the run defaults are identical", async () => {
	const a = await run([task("H1")]);
	const b = await run([task("H1", { taskTimeoutMs: 2400000 })]);
	assert.deepEqual(a.config.limits, b.config.limits);
	const c = compareResults(a, b);
	assert.equal(c.verdict, "INCONCLUSIVE");
	assert.ok(c.inconclusive.some((r) => /H1/.test(r) && /taskTimeoutMs/.test(r)), c.inconclusive.join("|"));
});

// ---- Bounded-budget contract (bounded-budget-comparison/1): a genuine, structured deadline cut is a FAILED attempt, not an invalid run. Baseline-data eligibility is separate from
// the quality verdict: a missing review is UNKNOWN (never zero, never a pass), but a proven acceptance drop stays a REGRESSION.
const clone = (r) => JSON.parse(JSON.stringify(r));
// Turns a completed fake run into what the runner records for a deadline cut: budget_exhausted + accepted:false + structured stage, no review, a drained shutdown whose pendingJobs lists the job
// pending when the abort started (confirmed:true), and the run "unfinished" with budgetExhausted. Totals are recomputed the way the runner does.
function cutOf(result, ids, mutate) {
	const r = clone(result);
	for (const id of ids) {
		const t = r.tasks.find((x) => x.id === id);
		t.status = "budget_exhausted"; t.accepted = false; t.error = "task budget exhausted during main_prompt";
		t.budget = { ...t.budget, exhausted: true, stage: "main_prompt", exhaustedAtOffsetMs: 1140003 };
		t.reviewer.cycles = []; t.acceptance.cycles = [];
		t.shutdown = { confirmed: true, ms: 10, pendingJobs: ["bg-3"], pendingOperations: [] };
	}
	const accepted = r.tasks.filter((t) => t.accepted).length;
	r.totals.acceptance = { accepted, total: r.tasks.length, rate: accepted / r.tasks.length };
	r.totals.highFindings = { first: null, final: null };
	r.status = "unfinished"; r.budgetExhausted = ids; r.error = `task ${ids.at(-1)} budget exhausted during main_prompt`;
	mutate?.(r);
	return r;
}
const two = () => [task("H1"), task("H2")];

test("a structured deadline cut counts as a failed attempt in the denominator: proven acceptance drop stays REGRESSION although the review of the cut task is unknown", async () => {
	const base = await run(two());
	const cut = cutOf(await run(two()), ["H2"]);
	const c = compareResults(base, cut);
	assert.equal(c.verdict, "REGRESSION", JSON.stringify(c));
	assert.deepEqual(c.inconclusive, []);
	assert.equal(c.acceptance.baseline, 1);
	assert.equal(c.acceptance.candidate, 0.5);
	assert.ok(c.reasons.some((r) => /acceptance dropped/.test(r)));
	assert.equal(c.attemptCoverage.candidate.eligible, true);
	assert.deepEqual(c.attemptCoverage.candidate.deadlineCut, ["H2"]);
	assert.equal(c.attemptCoverage.candidate.recorded, 2);
	assert.equal(c.quality.status, "unknown");
	assert.deepEqual(c.unacceptedTasks, { baseline: [], candidate: ["H2"] });
});

test("deadline cuts on both sides with equal acceptance: eligible data but unknown quality is INCONCLUSIVE, never NO_REGRESSION", async () => {
	const a = cutOf(await run(two()), ["H2"]);
	const b = cutOf(await run(two()), ["H2"]);
	const c = compareResults(a, b);
	assert.equal(c.verdict, "INCONCLUSIVE", JSON.stringify(c));
	assert.equal(c.baselineEligible, true);
	assert.deepEqual(c.inconclusive, []);
	assert.equal(c.acceptance.baseline, 0.5);
	assert.equal(c.acceptance.candidate, 0.5);
	assert.equal(c.quality.status, "unknown");
	assert.ok(c.quality.unknown.length > 0);
	assert.equal(c.perTask.find((t) => t.id === "H2").baselineHighFirst, null, "a missing review is null, not zero");
	assert.equal(c.highFindings.first.baseline, null);
});

test("an all-completed candidate against a cut baseline (acceptance improved) is still INCONCLUSIVE: unknown quality is never a pass", async () => {
	const c = compareResults(cutOf(await run(two()), ["H2"]), await run(two()));
	assert.equal(c.verdict, "INCONCLUSIVE", JSON.stringify(c));
	assert.equal(c.baselineEligible, true);
	assert.equal(c.acceptance.drop, -0.5);
});

test("a cut final attempt is not accepted even when an earlier round of that task passed", async () => {
	const base = await run(two());
	const bad = cutOf(await run(two()), ["H2"], (r) => { r.tasks[1].reworkRounds = 1; r.tasks[1].acceptance.cycles = [{ round: 0, testsPassed: true, pass: 4, fail: 0 }]; });
	const c = compareResults(base, bad);
	assert.equal(c.perTask[1].candidateAccepted, false);
	assert.equal(c.verdict, "REGRESSION");
	const lying = cutOf(await run(two()), ["H2"], (r) => { r.tasks[1].accepted = true; });
	const l = compareResults(base, lying);
	assert.equal(l.verdict, "INCONCLUSIVE");
	assert.equal(l.attemptCoverage.candidate.eligible, false);
});

test("complete, known review quality with a known high-severity increase stays a REGRESSION; zero high stays NO_REGRESSION", async () => {
	const good = await run(two());
	assert.equal(compareResults(good, await run(two())).verdict, "NO_REGRESSION");
	const worse = await run(two(), { review: "FINDING high: wrong scope" });
	assert.equal(compareResults(good, worse).verdict, "REGRESSION");
	assert.equal(compareResults(good, await run(two())).quality.status, "known");
});

// Ineligible attempt data: a timeout label alone never makes a run usable.
const ineligible = {
	"duplicate task record": (r) => { r.tasks[1].id = "H1"; r.order = ["H1", "H1"]; },
	"a task that was never recorded": (r) => { r.tasks = r.tasks.slice(0, 1); r.notRun = ["H2"]; },
	"unconfirmed shutdown": (r) => { r.tasks[1].shutdown = { confirmed: false, ms: null, pendingJobs: ["bg-3"], pendingOperations: ["review_close"] }; },
	"pending operations at close": (r) => { r.tasks[1].shutdown.pendingOperations = ["main_prompt"]; },
	"missing shutdown proof": (r) => { delete r.tasks[1].shutdown; },
	"a recorded run-level shutdownUnconfirmed": (r) => { r.shutdownUnconfirmed = { task: "H2" }; },
	"a run budgetExhausted list that disagrees with the tasks": (r) => { r.budgetExhausted = []; },
	"a flag only: budget_exhausted without the structured exhausted flag": (r) => { r.tasks[1].budget.exhausted = false; },
	"an exhausted budget flag on a task that did not finish as budget_exhausted": (r) => { r.tasks[1].status = "completed"; },
	"a cut with no recorded stage": (r) => { delete r.tasks[1].budget.stage; },
	"an arbitrary error that merely says timeout": (r) => { r.tasks[1].status = "error"; r.tasks[1].budget.exhausted = false; r.budgetExhausted = []; },
	"a provider/pre-start error on another task": (r) => { r.tasks[0].status = "error"; r.tasks[0].accepted = false; },
	"an infrastructure-invalid task": (r) => { r.tasks[0].status = "infrastructure"; r.tasks[0].invalid = { class: "infrastructure", kind: "shutdown_unconfirmed" }; },
	"an invalid run": (r) => { r.status = "invalid"; },
	"a failed run": (r) => { r.status = "failed"; },
	"an unfinished run with no recorded deadline task": (r) => { r.tasks[1].status = "completed"; r.tasks[1].accepted = true; r.tasks[1].budget.exhausted = false; r.budgetExhausted = []; },
	"acceptance totals that disagree with the task records": (r) => { r.totals.acceptance = { accepted: 2, total: 2, rate: 1 }; },
};
for (const [label, mutate] of Object.entries(ineligible)) {
	test(`ineligible attempt data is never baseline data: ${label}`, async () => {
		const a = cutOf(await run(two()), ["H2"]);
		const b = cutOf(await run(two()), ["H2"], mutate);
		for (const [x, y, side] of [[a, b, "candidate"], [b, a, "baseline"]]) {
			const c = compareResults(x, y);
			assert.equal(c.verdict, "INCONCLUSIVE", `${side}: ${JSON.stringify(c.inconclusive)}`);
			assert.equal(c.baselineEligible, false);
			assert.equal(c.attemptCoverage[side].eligible, false);
			assert.ok(c.inconclusive.length > 0);
		}
	});
}

test("a structured cut during a setup stage is a legitimate whole-budget outcome when drained; the stage is never parsed from error text", async () => {
	const a = cutOf(await run(two()), ["H2"], (r) => { r.tasks[1].budget.stage = "workspace_prepare"; r.tasks[1].error = "anything"; });
	const c = compareResults(a, cutOf(await run(two()), ["H2"]));
	assert.equal(c.attemptCoverage.baseline.eligible, true);
	assert.equal(c.baselineEligible, true);
});

test("a deadline cut keeps the comparison matched: a differing effective deadline or an unproven topology is INCONCLUSIVE and not eligible", async () => {
	const a = cutOf(await run(two()), ["H2"]);
	const other = cutOf(await run(two(), { config: withLimits({ taskTimeoutMs: lim(2400000) }) }), ["H2"]);
	const c = compareResults(a, other);
	assert.equal(c.verdict, "INCONCLUSIVE");
	assert.equal(c.baselineEligible, false);
	const noTopology = cutOf(await run(two()), ["H2"], (r) => { r.config.topology.ok = false; });
	assert.equal(compareResults(a, noTopology).verdict, "INCONCLUSIVE");
});

test("null cost stays unknown with its known subtotal preserved; nothing is inferred", async () => {
	const base = await run(two());
	const cut = cutOf(await run(two()), ["H2"], (r) => {
		r.totals.endToEnd = { ...r.totals.endToEnd, cost: null };
		r.totals.worker = { ...r.totals.worker, status: "partial", cost: { total: null, cacheTier: null, knownPricedSubtotal: 2.3426103450000006, unresolved: [{ id: "x#0", reason: "aborted_in_flight_usage_unknown" }] } };
	});
	const c = compareResults(base, cut);
	assert.equal(c.cost.candidate.endToEnd.cost, null);
	assert.equal(c.cost.candidate.worker.total, null);
	assert.equal(c.cost.candidate.worker.knownPricedSubtotal, 2.3426103450000006);
	assert.ok(!("savings" in c));
});

test("the comparison names its contract and the source schema it applied without rewriting inputs", async () => {
	const base = await run(two()), cut = cutOf(await run(two()), ["H2"]);
	const before = JSON.stringify(cut);
	const c = compareResults(base, cut);
	assert.equal(c.contract, "bounded-budget-comparison/1");
	assert.equal(c.appliedPolicy.sourceSchema, base.schemaVersion);
	assert.equal(JSON.stringify(cut), before);
});

// Read-only characterization of the real two-task Profile B pilot (H4 accepted, H9 deadline-cut during the main prompt): 2 attempts, rate 0.5, quality unknown, overall INCONCLUSIVE.
// The file lives outside the repository (evidence); the case skips when it is absent. It is never rewritten.
const PILOT = "C:/Users/MSI/worktrees/.pi/_evidence/token-efficiency/benchmark-profile-b-pilot-h4-h9.json";
test("real pilot (read-only): two eligible attempts, acceptance 0.5, quality unknown, overall INCONCLUSIVE and not a full 8-task baseline", { skip: !fs.existsSync(PILOT) }, () => {
	const pilot = JSON.parse(fs.readFileSync(PILOT, "utf8"));
	const c = compareResults(pilot, clone(pilot));
	assert.equal(c.attemptCoverage.baseline.eligible, true, JSON.stringify(c.attemptCoverage.baseline));
	assert.equal(c.attemptCoverage.baseline.recorded, 2);
	assert.deepEqual(c.attemptCoverage.baseline.deadlineCut, ["H9"]);
	assert.equal(c.attemptCoverage.baseline.fullTaskSet, false);
	assert.equal(c.attemptCoverage.baseline.fullTaskCount, 8);
	assert.equal(c.acceptance.baseline, 0.5);
	assert.equal(c.quality.status, "unknown");
	assert.equal(c.verdict, "INCONCLUSIVE");
	assert.equal(c.baselineEligible, true);
	assert.equal(c.cost.baseline.endToEnd?.cost ?? null, null);
});

test("a missing review never zero-fills: an otherwise equal completed task without review cycles makes quality unknown", async () => {
	const good = await run(two());
	const noReview = clone(good);
	noReview.tasks[1].reviewer.cycles = [];
	noReview.totals.highFindings = { first: null, final: null };
	const c = compareResults(good, noReview);
	assert.equal(c.verdict, "INCONCLUSIVE");
	assert.equal(c.quality.status, "unknown");
	assert.equal(c.baselineEligible, true);
});

// ---- Canonical acceptance (fix round 2): the rate/counts are DERIVED from the per-task final outcomes; a cached totals.acceptance can never override them, and an inconsistent one is reported, never trusted.
const withSummary = (r, s) => { r.totals.acceptance = s; return r; };
const failOne = (r, i = 1) => { r.tasks[i].accepted = false; const accepted = r.tasks.filter((t) => t.accepted).length; return withSummary(r, { accepted, total: r.tasks.length, rate: accepted / r.tasks.length }); };
const STALE = { accepted: 1, total: 2, rate: 1 };

test("canonical acceptance: a stale cached rate cannot hide a proven drop for a structured cut or a completed candidate, on either side", async () => {
	const good = await run(two());
	const cut = withSummary(cutOf(await run(two()), ["H2"]), STALE);
	const failed = withSummary(failOne(clone(good)), STALE);
	for (const bad of [cut, failed]) {
		const c = compareResults(good, bad);
		assert.equal(c.verdict, "REGRESSION", JSON.stringify(c));
		assert.equal(c.acceptance.candidate, 0.5);
		assert.equal(c.acceptance.drop, 0.5);
		assert.equal(c.baselineEligible, false, "an inconsistent summary is not clean baseline data");
		assert.ok(c.attemptCoverage.candidate.summaryWarnings.length > 0);
		// mirrored: the stale summary is on the baseline; the candidate is canonically better, so no regression and never a pass
		const m = compareResults(bad, good);
		assert.equal(m.acceptance.baseline, 0.5);
		assert.notEqual(m.verdict, "NO_REGRESSION");
		assert.notEqual(m.verdict, "REGRESSION");
		assert.equal(m.baselineEligible, false);
	}
});

test("canonical acceptance: malformed cached summaries (type, range, NaN/Infinity, counts) never override the task outcomes and never yield NO_REGRESSION", async () => {
	const good = await run(two());
	const bads = [{ ...STALE, rate: "0.5" }, { ...STALE, rate: null }, { ...STALE, rate: NaN }, { ...STALE, rate: Infinity }, { ...STALE, rate: 2 }, { ...STALE, rate: -1 }, { ...STALE, rate: true }, { ...STALE, rate: {} }, { accepted: "1", total: 2, rate: 0.5 }, { accepted: 1, total: 3, rate: 0.5 }, { accepted: true, total: 2, rate: 0.5 }, null, "x", 0.5];
	for (const s of bads) {
		const drop = compareResults(good, withSummary(failOne(clone(good)), s));
		assert.equal(drop.verdict, "REGRESSION", JSON.stringify(s));
		assert.equal(drop.acceptance.candidate, 0.5, JSON.stringify(s));
		const same = compareResults(good, withSummary(clone(good), s));
		assert.equal(same.verdict, "INCONCLUSIVE", JSON.stringify(s));
		assert.equal(same.acceptance.candidate, 1);
		assert.equal(same.baselineEligible, false);
	}
});

test("canonical acceptance: a consistent summary, or none at all, keeps the normal verdict (known quality, equal acceptance is NO_REGRESSION)", async () => {
	const good = await run(two());
	assert.equal(compareResults(good, clone(good)).verdict, "NO_REGRESSION");
	const noSummary = clone(good); delete noSummary.totals.acceptance;
	const c = compareResults(good, noSummary);
	assert.equal(c.verdict, "NO_REGRESSION");
	assert.equal(c.acceptance.candidate, 1);
	assert.deepEqual(c.attemptCoverage.candidate.summaryWarnings, []);
	// a cached summary claiming a drop is stale when the tasks prove none: reported, not trusted, and no pass is claimed
	const lower = compareResults(good, withSummary(clone(good), { accepted: 1, total: 2, rate: 0.5 }));
	assert.equal(lower.acceptance.candidate, 1);
	assert.notEqual(lower.verdict, "REGRESSION");
	assert.notEqual(lower.verdict, "NO_REGRESSION");
});

test("canonical acceptance: an unknown per-task accepted is acceptance UNKNOWN (not 0 or 1) and a cached rate is never borrowed", async () => {
	const good = await run(two());
	for (const v of ["true", 1, 0, null, undefined, {}, []]) {
		const bad = withSummary(clone(good), { accepted: 2, total: 2, rate: 1 });
		bad.tasks[1].accepted = v;
		const c = compareResults(good, bad);
		assert.equal(c.verdict, "INCONCLUSIVE", String(v));
		assert.equal(c.acceptance.candidate, null);
		assert.equal(c.acceptance.drop, null);
		assert.equal(c.baselineEligible, false);
	}
});

test("canonical acceptance: duplicate or reordered task ids leave acceptance unknown and ineligible", async () => {
	const good = await run(two());
	const dup = clone(good); dup.tasks[1].id = "H1"; dup.order = ["H1", "H1"];
	const re = clone(good); re.tasks.reverse();
	for (const bad of [dup, re]) {
		const c = compareResults(good, bad);
		assert.equal(c.verdict, "INCONCLUSIVE");
		assert.equal(c.acceptance.candidate, null);
		assert.equal(c.baselineEligible, false);
	}
});

test("canonical acceptance: a cut is never accepted in the denominator even when its cached state or an earlier round said accepted", async () => {
	const good = await run(two());
	const lying = cutOf(await run(two()), ["H2"], (r) => { r.tasks[1].accepted = true; r.tasks[1].acceptance.cycles = [{ round: 0, testsPassed: true, pass: 4, fail: 0 }]; r.totals.acceptance = { accepted: 2, total: 2, rate: 1 }; });
	const c = compareResults(good, lying);
	assert.equal(c.acceptance.candidate, 0.5);
	assert.equal(c.verdict, "INCONCLUSIVE");
	assert.equal(c.baselineEligible, false);
	assert.equal(compareResults(good, cutOf(await run(two()), ["H2"], (r) => { r.totals.highFindings = { first: 0, final: 0 }; })).verdict, "REGRESSION");
});

test("canonical acceptance: a proven drop with unknown quality is REGRESSION; unknown quality with no drop stays INCONCLUSIVE", async () => {
	const good = await run(two());
	const noReview = clone(good); noReview.tasks[0].reviewer.cycles = []; noReview.totals.highFindings = { first: null, final: null };
	assert.equal(compareResults(good, failOne(clone(noReview))).verdict, "REGRESSION");
	assert.equal(compareResults(good, noReview).verdict, "INCONCLUSIVE");
});

test("real pilot with a stale cached rate (in-memory clone only): derived 0.5, summary reported, never trusted; the saved file is never written", { skip: !fs.existsSync(PILOT) }, () => {
	const raw = fs.readFileSync(PILOT, "utf8");
	const pilot = JSON.parse(raw);
	const stale = clone(pilot); stale.totals.acceptance.rate = 1;
	const good = clone(pilot); good.tasks[1].status = "completed"; good.tasks[1].budget.exhausted = false; good.tasks[1].accepted = true; good.status = "complete"; good.budgetExhausted = [];
	const c = compareResults(good, stale);
	assert.equal(c.acceptance.candidate, 0.5);
	assert.ok(c.attemptCoverage.candidate.summaryWarnings.length > 0);
	assert.equal(c.baselineEligible, false);
	assert.equal(compareResults(pilot, clone(pilot)).attemptCoverage.baseline.summaryWarnings.length, 0);
	assert.equal(fs.readFileSync(PILOT, "utf8"), raw);
});

// ---- Canonical high-severity quality: the per-task review cycles (the runner's own schema) are the only quality proof; cached totals.highFindings must equal their rollup.
const withHigh = (r, i, n, cycle = 0) => {
	const c = r.tasks[i].reviewer.cycles.at(cycle === 0 ? 0 : -1);
	c.findings = Array.from({ length: n }, (_, k) => ({ severity: k % 2 ? "critical" : "high", text: `f${k}` })); c.highCount = n;
};
const cache = (r, first, final = first) => { r.totals.highFindings = { first, final }; };
const highRun = () => run(two(), { review: "FINDING high: bad thing" });
const quiet = (c) => { assert.equal(c.verdict, "INCONCLUSIVE"); assert.equal(c.quality.status, "unknown"); assert.ok(c.quality.unknown.length > 0); assert.equal(c.highFindings.first.rise, null); assert.equal(c.highFindings.final.rise, null); };

test("high quality: an honest canonical increase is a REGRESSION; consistent zero findings pass; legitimate offsets keep the aggregate policy", async () => {
	const good = await run(two());
	assert.equal(compareResults(good, clone(good)).verdict, "NO_REGRESSION");
	const c = compareResults(good, await highRun());
	assert.equal(c.verdict, "REGRESSION"); assert.equal(c.highFindings.first.rise, 2); assert.equal(c.quality.status, "known");
	const a = clone(good), b = clone(good);
	withHigh(a, 0, 1); cache(a, 1); withHigh(b, 1, 1); cache(b, 1);
	assert.equal(compareResults(a, b).verdict, "NO_REGRESSION");
	const edited = clone(good); withHigh(edited, 0, 2); cache(edited, 2);
	assert.equal(compareResults(good, edited).verdict, "REGRESSION");
});

test("high quality: stale, negative or malformed cached totals and inconsistent cycles are UNKNOWN, never a pass or a fabricated regression", async () => {
	const good = await run(two());
	const cases = {
		"cycle 2 but cache 0": (r) => withHigh(r, 0, 2),
		"cycle 2 first and final but cache 0": (r) => { withHigh(r, 0, 2); withHigh(r, 0, 2, -1); },
		"cache 4 but canonical 0": (r) => cache(r, 4),
		"cache 1e9": (r) => cache(r, 1e9),
		"negative cache with canonical 2": (r) => { withHigh(r, 0, 2); cache(r, -5); },
		"negative cache with canonical 0": (r) => cache(r, -5),
		"fractional cache": (r) => cache(r, 0.5),
		"string cache": (r) => cache(r, "0"),
		"null cache": (r) => cache(r, null),
		"missing cache": (r) => { delete r.totals.highFindings; },
		"count 0 but a high finding": (r) => { withHigh(r, 0, 1); r.tasks[0].reviewer.cycles[0].highCount = 0; },
		"count 1 but no finding": (r) => { r.tasks[0].reviewer.cycles[0].highCount = 1; cache(r, 1); },
		"count 1.5": (r) => { withHigh(r, 0, 1); r.tasks[0].reviewer.cycles[0].highCount = 1.5; cache(r, 1.5); },
		"count -1 offset by +1": (r) => { r.tasks[0].reviewer.cycles[0].highCount = -1; withHigh(r, 1, 1); cache(r, 0); },
		"count string": (r) => { r.tasks[0].reviewer.cycles[0].highCount = "0"; },
		"unknown severity": (r) => { r.tasks[0].reviewer.cycles[0].findings = [{ severity: "urgent", text: "x" }]; },
		"findings not an array": (r) => { r.tasks[0].reviewer.cycles[0].findings = null; },
		"unparsed cycle": (r) => { r.tasks[0].reviewer.cycles[0].status = "unavailable"; },
		"incomplete cycle": (r) => { delete r.tasks[0].reviewer.cycles[0].status; },
		"null cycle": (r) => { r.tasks[0].reviewer.cycles[0] = null; },
	};
	for (const [name, mutate] of Object.entries(cases)) {
		const cand = clone(good); mutate(cand);
		assert.doesNotThrow(() => compareResults(good, cand), name);
		try { quiet(compareResults(good, cand)); quiet(compareResults(cand, good)); } catch (e) { e.message = `${name}: ${e.message}`; throw e; }
	}
});

test("high quality: an inconsistent cache with a proven acceptance drop is still a REGRESSION; a cut after an earlier review stays unknown", async () => {
	const good = await run(two());
	const bad = failOne(clone(good)); cache(bad, 4);
	const c = compareResults(good, bad);
	assert.equal(c.verdict, "REGRESSION"); assert.equal(c.quality.status, "unknown");
	const cut = cutOf(good, ["H2"]); cut.tasks[1].reviewer.cycles = clone(good.tasks[1].reviewer.cycles); cache(cut, 0);
	assert.equal(compareResults(good, cut).quality.status, "unknown");
});

// Teardown proof applies to EVERY status path: a complete-labelled run or task never short-circuits the final-shutdown requirement.
const badTeardown = {
	"confirmed:false": (s) => { s.confirmed = false; },
	"missing shutdown record": (s, t) => { delete t.shutdown; },
	"truthy string confirmed": (s) => { s.confirmed = "true"; },
	"numeric confirmed": (s) => { s.confirmed = 1; },
	"object confirmed": (s) => { s.confirmed = {}; },
	"array confirmed": (s) => { s.confirmed = []; },
	"missing confirmed": (s) => { delete s.confirmed; },
	"pending operations at close": (s) => { s.pendingOperations = ["main_prompt"]; },
	"missing pendingOperations": (s) => { delete s.pendingOperations; },
	"malformed pendingOperations": (s) => { s.pendingOperations = "none"; },
	"empty shutdown object": (s, t) => { t.shutdown = {}; },
};
const rootShapes = { "complete root": async () => run(two()), "unfinished root with a cut row": async () => cutOf(await run(two()), ["H2"]) };
for (const [shape, make] of Object.entries(rootShapes)) {
	for (const [label, mutate] of Object.entries(badTeardown)) {
		test(`teardown proof (${shape}): ${label} is never baseline-eligible or a pass`, async () => {
			const good = await make(), bad = clone(good);
			mutate(bad.tasks[0].shutdown ?? {}, bad.tasks[0]);
			for (const [x, y, side] of [[good, bad, "candidate"], [bad, good, "baseline"]]) {
				const c = compareResults(x, y);
				assert.equal(c.baselineEligible, false, side);
				assert.equal(c.attemptCoverage[side].eligible, false, side);
				assert.notEqual(c.verdict, "NO_REGRESSION", side);
				assert.ok(c.attemptCoverage[side].reasons.some((r) => /shutdown/.test(r)), side);
			}
		});
	}
	test(`teardown proof (${shape}): a recorded run-level shutdownUnconfirmed or invalid marker blocks eligibility`, async () => {
		const good = await make();
		for (const mark of [{ shutdownUnconfirmed: { task: "H1" } }, { invalid: { class: "infrastructure" } }]) {
			const c = compareResults(good, Object.assign(clone(good), mark));
			assert.equal(c.baselineEligible, false); assert.notEqual(c.verdict, "NO_REGRESSION");
		}
	});
}
test("teardown proof: a confirmed final close whose pre-close pendingJobs is non-empty stays eligible on a complete run", async () => {
	const a = await run(two()), b = clone(a);
	for (const t of b.tasks) t.shutdown = { confirmed: true, ms: 10, pendingJobs: ["bg-3"], pendingOperations: [] };
	const c = compareResults(a, b);
	assert.equal(c.baselineEligible, true); assert.equal(c.verdict, "NO_REGRESSION");
});
test("teardown proof: an unconfirmed task makes an otherwise proven acceptance drop a REGRESSION metric but never a valid pass", async () => {
	const good = await run(two()), bad = failOne(clone(good)); bad.tasks[0].shutdown.confirmed = false;
	const c = compareResults(good, bad);
	assert.equal(c.baselineEligible, false); assert.notEqual(c.verdict, "NO_REGRESSION"); assert.ok(c.acceptance.drop > 0);
});
