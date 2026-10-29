import { TOPOLOGY_METHOD } from "./topology.mjs";

// Side-by-side comparison of two runs. Regression: acceptance rate drops or high-severity reviewer findings rise.
// NO_REGRESSION is RELATIVE to the baseline on the same matched tasks. It is NOT all tasks passed: read allAccepted and
// unacceptedTasks. Synthetic, failed, unavailable, mismatched or incomplete data is INCONCLUSIVE, never a pass.
// Rework and cost are reported side by side, not gated here.
//
// Contract bounded-budget-comparison/1 (applied to existing schema-6 data; no input is rewritten). Two separate questions:
//  1. Attempt coverage / baselineEligible: every expected task has exactly one record, each is a completed attempt or a STRUCTURED deadline cut (status budget_exhausted + budget.exhausted + stage,
//     accepted:false), and every final shutdown is confirmed drained. A cut task is a failed attempt in the acceptance denominator. Error text is never parsed.
//  2. Quality: a missing/unknown required review or unknown high-severity count is UNKNOWN (null, never zero, never a pass). A proven acceptance drop or a known high-severity rise is still a
//     REGRESSION; unknown quality with otherwise equal acceptance is INCONCLUSIVE, never NO_REGRESSION.
export const CONTRACT = "bounded-budget-comparison/1";
const side = (r) => ({ mode: r.mode, status: r.status });
const CAVEAT = "NO_REGRESSION is relative to the baseline on the same matched tasks; it is NOT all tasks passed. Check allAccepted and unacceptedTasks. Unknown review quality is never a pass.";

// pendingJobs may list the jobs pending when the close STARTED; confirmed:true means they were aborted and drained, so only confirmed and pendingOperations decide.
const drained = (t) => t?.shutdown?.confirmed === true && Array.isArray(t.shutdown.pendingOperations) && t.shutdown.pendingOperations.length === 0;
const isCut = (t) => t.status === "budget_exhausted" || t.budget?.exhausted === true;

// Canonical acceptance, derived ONLY from the per-task final outcomes over the expected attempt set (unique ids equal to the order). A cut is always unaccepted; a completed task needs a strict
// boolean. Anything else is unknown (null): a cached totals.acceptance is never borrowed to fill it in.
function derivedAcceptance(r) {
	const tasks = r.tasks ?? [], order = r.order ?? [];
	if (!order.length || new Set(order).size !== order.length || JSON.stringify(tasks.map((t) => t.id)) !== JSON.stringify(order)) return null;
	let accepted = 0;
	for (const t of tasks) {
		const ok = isCut(t) ? false : t.accepted;
		if (typeof ok !== "boolean") return null;
		if (ok) accepted++;
	}
	return { accepted, total: tasks.length, rate: accepted / tasks.length };
}
const isCount = (n) => Number.isInteger(n) && n >= 0;
// A cached summary is redundant: reported (fixed category, no raw values) when malformed or different from the derived value, never trusted.
function summaryProblem(s, d) {
	if (s === undefined) return false;
	if (s === null || typeof s !== "object" || !isCount(s.accepted) || !isCount(s.total) || s.accepted > s.total || typeof s.rate !== "number" || !Number.isFinite(s.rate) || s.rate < 0 || s.rate > 1) return true;
	return d !== null && (s.accepted !== d.accepted || s.total !== d.total || Math.abs(s.rate - d.rate) > 1e-9);
}

function attemptCoverage(r) {
	const tasks = r.tasks ?? [], order = r.order ?? [], reasons = [];
	const ids = tasks.map((t) => t.id);
	if (r.status !== "complete" && r.status !== "unfinished") reasons.push(`run status is ${r.status}${r.error ? `: ${r.error}` : ""}`);
	if (new Set(order).size !== order.length || new Set(ids).size !== ids.length) reasons.push("duplicate task ids");
	if (ids.length !== order.length || JSON.stringify(ids) !== JSON.stringify(order)) reasons.push(`${ids.length} task result(s) for ${order.length} ordered task(s): tasks do not match the order`);
	if ((r.notRun ?? []).length) reasons.push(`task(s) not run (${r.notRun.join(", ")})`);
	if (r.selection?.tasks && JSON.stringify(r.selection.tasks) !== JSON.stringify(order)) reasons.push("selection does not match the task order");
	const cut = [];
	for (const t of tasks) {
		if (isCut(t)) {
			cut.push(t.id);
			if (t.status !== "budget_exhausted" || t.budget?.exhausted !== true || typeof t.budget.stage !== "string" || !t.budget.stage) reasons.push(`task ${t.id} budget outcome is not structured (status, exhausted flag and stage must all be recorded)`);
			if (t.accepted !== false) reasons.push(`task ${t.id} cut by the budget is not recorded as unaccepted`);
		} else if (t.status !== "completed") reasons.push(`task ${t.id} status is ${t.status}: neither a completed attempt nor a structured budget cut`);
		else if (typeof t.accepted !== "boolean") reasons.push(`task ${t.id} acceptance outcome is not a recorded boolean: acceptance is unknown`);
	}
	if (cut.length) {
		if (r.status !== "unfinished") reasons.push(`budget-exhausted task(s) (${cut.join(", ")}) in a run not recorded as unfinished`);
		if (JSON.stringify(r.budgetExhausted ?? []) !== JSON.stringify(cut)) reasons.push("run budgetExhausted list does not match the task records");
	} else if (r.status === "unfinished") reasons.push("run is unfinished without a recorded budget-exhausted task");
	// Final teardown proof is required for EVERY recorded attempt on EVERY status path: a complete label or cached aggregate is never proof.
	if (r.shutdownUnconfirmed) reasons.push("run records an unconfirmed shutdown");
	if (r.invalid) reasons.push("run records an invalid task");
	for (const t of tasks) if (!drained(t)) reasons.push(`task ${t.id} final shutdown is not confirmed drained`);
	const derived = derivedAcceptance(r);
	const summaryWarnings = summaryProblem(r.totals?.acceptance, derived) ? ["cached acceptance summary is malformed or disagrees with the task records (derived from the task records instead)"] : [];
	const accepted = derived?.accepted ?? null;
	const full = Number.isInteger(r.selection?.fullTaskCount) ? r.selection.fullTaskCount : null;
	return { eligible: reasons.length === 0 && summaryWarnings.length === 0, reasons, summaryWarnings, derived, expectedTasks: order.length, recorded: tasks.length, accepted, deadlineCut: cut, fullTaskCount: full, fullTaskSet: full === null ? null : order.length === full };
}

// Canonical high-severity evidence, recomputed ONLY from the per-task review cycles in the runner's schema (status "ok", findings[{severity,text}], highCount = critical+high findings; first = first
// cycle, final = last cycle, root = sum over tasks). A cached totals.highFindings is redundant: it must be present and equal to the rollup, else quality is UNKNOWN (fixed reason, no raw values).
// Anything missing or malformed is UNKNOWN (null): nothing is zero-filled, and an inconsistent cache can neither pass nor fabricate a regression.
const SEVERITIES = new Set(["critical", "high", "medium", "low"]);
function cycleProblem(c) {
	if (c === null || typeof c !== "object" || c.status !== "ok") return "a review cycle that is unknown or unavailable";
	if (!isCount(c.highCount)) return "a review cycle with a malformed high-severity count";
	if (!Array.isArray(c.findings) || c.findings.some((f) => f === null || typeof f !== "object" || !SEVERITIES.has(f.severity))) return "a review cycle with malformed findings";
	if (c.findings.filter((f) => f.severity === "critical" || f.severity === "high").length !== c.highCount) return "a review cycle whose high-severity count disagrees with its findings";
	return null;
}
function quality(r) {
	const unknown = [], first = [], final = [];
	for (const t of r.tasks ?? []) {
		const cycles = Array.isArray(t.reviewer?.cycles) ? t.reviewer.cycles : [];
		const problem = cycles.map(cycleProblem).find((p) => p);
		if (isCut(t)) unknown.push(`task ${t.id} was cut by the budget: its final review did not run`);
		else if (cycles.length === 0) unknown.push(`task ${t.id} has no recorded review cycle`);
		else if (problem) unknown.push(`task ${t.id} has ${problem}`);
		else { first.push(cycles[0].highCount); final.push(cycles.at(-1).highCount); }
	}
	const known = !unknown.length && first.length > 0;
	const canon = { first: known ? first.reduce((a, b) => a + b, 0) : null, final: known ? final.reduce((a, b) => a + b, 0) : null };
	const h = r.totals?.highFindings;
	if (known && (h?.first !== canon.first || h?.final !== canon.final)) unknown.push("cached high-severity totals are unavailable, malformed or disagree with the per-task review cycles");
	else if (!known && !first.length && !unknown.length) unknown.push("no task review evidence");
	return { unknown, ...canon };
}

// Reviewer evaluator guard. A matched task is comparable only when every reviewer cycle on both sides has a complete recorded
// evaluator, the FIRST cycle and the FINAL cycle evaluators are equal, and the distinct evaluators across all cycles are equal.
// Cycle counts may differ because of rework; the measured candidate runtime is deliberately not compared here.
const sig = (e) => JSON.stringify(e);
const describeDiff = (a, b) => Object.keys(a).filter((k) => sig(a[k]) !== sig(b[k])).map((k) => `${k} ${sig(a[k])} vs ${sig(b[k])}`).join(", ") || "identity fields equal";

function evaluatorCheck(b, c) {
	const bc = b?.reviewer?.cycles ?? [], cc = c?.reviewer?.cycles ?? [];
	// A review that never ran (missing cycle, unknown or unavailable) has no evaluator to compare: unknown quality (reported separately), not an evaluator mismatch.
	if ([bc, cc].some((x) => x.length === 0 || x.some((y) => y?.status !== "ok"))) return { comparable: null, reasons: ["review evidence missing"] };
	const missing = [];
	if (bc.some((x) => !x?.evaluator)) missing.push("baseline reviewer cycle lacks complete evaluator identity");
	if (cc.some((x) => !x?.evaluator)) missing.push("candidate reviewer cycle lacks complete evaluator identity");
	if (missing.length) return { comparable: false, reasons: missing };
	const reasons = [];
	if (sig(bc[0].evaluator) !== sig(cc[0].evaluator)) reasons.push(`first cycle differs (${describeDiff(bc[0].evaluator, cc[0].evaluator)})`);
	if (sig(bc.at(-1).evaluator) !== sig(cc.at(-1).evaluator)) reasons.push(`final cycle differs (${describeDiff(bc.at(-1).evaluator, cc.at(-1).evaluator)})`);
	const setB = new Set(bc.map((x) => sig(x.evaluator))), setC = new Set(cc.map((x) => sig(x.evaluator)));
	if (setB.size !== setC.size || [...setB].some((s) => !setC.has(s))) reasons.push("distinct reviewer evaluators across cycles differ");
	return { comparable: reasons.length === 0, reasons };
}

// Measurement capacity controls. The effective VALUES (not their provenance strings, not absolute clock timestamps) must be present and equal on both sides, for the run limits and
// for every task's own effective budget: a manifest per-task override can differ while the run defaults are identical. A missing value is never an implicit unlimited default.
const LIMIT_KEYS = ["taskTimeoutMs", "roundSettleTimeoutMs", "shutdownGraceMs"];
const finite = (v) => (Number.isFinite(v) ? v : null);
const limitValues = (r) => Object.fromEntries(LIMIT_KEYS.map((k) => [k, finite(r.config?.limits?.[k]?.value)]));
const taskValues = (t) => ({ taskTimeoutMs: finite(t?.budget?.taskTimeoutMs), roundSettleTimeoutMs: finite(t?.delegation?.roundSettleTimeoutMs?.value), shutdownGraceMs: finite(t?.delegation?.shutdownGraceMs?.value), "budget.graceMs": finite(t?.budget?.graceMs), "budget.workCutoffOffsetMs": finite(t?.budget?.workCutoffOffsetMs), "budget.deadlineOffsetMs": finite(t?.budget?.deadlineOffsetMs) });
function capacityDiffs(label, b, c) {
	return Object.keys(b).filter((k) => b[k] === null || c[k] === null || b[k] !== c[k]).map((k) => `${label} ${k} differs or is missing (${b[k] ?? "missing"} vs ${c[k] ?? "missing"})`);
}

// Long-mode continuation policy (a method property: after a confirmed cut the session is restored from its faithful history). Fresh runs have no continuation, so a fresh result is NOT APPLICABLE
// whether or not the field exists (old saved fresh data is read as is, never rewritten). A long result must record the same policy on both sides; a missing one is not assumed compatible.
const continuationPolicy = (r) => (r.mode === "fresh" ? "not-applicable" : (r.config?.continuation?.policy ?? null));

export function compareResults(base, cand) {
	const inconclusive = [];
	const reasons = [];
	const unknownQuality = [];
	const coverage = { baseline: attemptCoverage(base), candidate: attemptCoverage(cand) };
	const qual = { baseline: quality(base), candidate: quality(cand) };
	if (base.schemaVersion !== cand.schemaVersion) inconclusive.push("schemaVersion differs");
	if (base.manifestDigest !== cand.manifestDigest) inconclusive.push("manifest digest differs (different benchmark)");
	if (JSON.stringify(base.order) !== JSON.stringify(cand.order)) inconclusive.push("task order differs");
	if (base.mode !== cand.mode) inconclusive.push(`mode differs (${base.mode} vs ${cand.mode})`);
	else if (continuationPolicy(base) === null || continuationPolicy(base) !== continuationPolicy(cand)) inconclusive.push(`long-mode continuation policy differs or is missing (${continuationPolicy(base) ?? "missing"} vs ${continuationPolicy(cand) ?? "missing"})`);
	for (const [name, r] of [["baseline", base], ["candidate", cand]]) {
		if (r.synthetic === true) inconclusive.push(`${name} is a synthetic result: not benchmark evidence`);
		// The agent topology proof is a METHOD guard: a missing proof (an older run) or another proof method is not comparable. Per-run cwd, ids and the proof fingerprint are not compared.
		else if (r.config?.topology?.method !== TOPOLOGY_METHOD || r.config.topology.ok !== true) inconclusive.push(`${name} lacks a passing agent topology proof of method ${TOPOLOGY_METHOD} (older or unproven runs are not comparable)`);
		// A structured deadline cut is a failed attempt (eligible data); anything else not complete, incomplete, duplicated or undrained is not baseline data.
		for (const x of coverage[name].reasons) inconclusive.push(`${name} attempt data not eligible: ${x}`);
		for (const x of qual[name].unknown) unknownQuality.push(`${name}: ${x}`);
	}
	if (sig(base.config?.measurementPolicy ?? null) !== sig(cand.config?.measurementPolicy ?? null)) inconclusive.push("measurement exclusion policy differs or is missing on one side");
	const cap = (r) => r.config?.maxReworkRounds?.value ?? null;
	if (cap(base) === null || cap(base) !== cap(cand)) inconclusive.push(`rework cap differs or is missing (${cap(base)} vs ${cap(cand)})`);
	inconclusive.push(...capacityDiffs("run limit", limitValues(base), limitValues(cand)));
	(base.tasks ?? []).forEach((t, i) => inconclusive.push(...capacityDiffs(`task ${t.id}`, taskValues(t), taskValues((cand.tasks ?? [])[i]))));
	for (const role of ["main", "reviewer"]) {
		const b = base.config?.roles?.[role], c = cand.config?.roles?.[role];
		if (!b || !c || b.model !== c.model || b.thinking !== c.thinking || sig(b.fallbacks ?? []) !== sig(c.fallbacks ?? [])) inconclusive.push(`configured ${role} model, thinking or fallbacks differ (${b?.model ?? "none"} vs ${c?.model ?? "none"})`);
	}
	const evaluators = (base.tasks ?? []).map((b, i) => evaluatorCheck(b, (cand.tasks ?? [])[i]));
	base.tasks?.forEach((b, i) => { if (evaluators[i].comparable === false) inconclusive.push(`reviewer evaluator not comparable for task ${b.id}: ${evaluators[i].reasons.join("; ")}`); });
	const bRate = coverage.baseline.derived?.rate ?? null, cRate = coverage.candidate.derived?.rate ?? null;
	if (bRate === null || cRate === null) inconclusive.push("acceptance rate unavailable");
	const high = (r, k) => qual[r === base ? "baseline" : "candidate"][k];
	// A high-severity rise is only a claim when the review quality of BOTH sides is fully known; an unknown count is never treated as zero.
	const rise = (k) => (unknownQuality.length || high(base, k) === null || high(cand, k) === null ? null : high(cand, k) - high(base, k));
	const riseFirst = rise("first"), riseFinal = rise("final");
	let verdict;
	if (inconclusive.length) verdict = "INCONCLUSIVE";
	else {
		// A proven regression is reported even when quality is unknown; unknown quality only blocks a pass.
		if (cRate < bRate) reasons.push(`acceptance dropped ${bRate.toFixed(3)} -> ${cRate.toFixed(3)}`);
		if (riseFirst > 0) reasons.push(`first-pass high-severity findings rose by ${riseFirst}`);
		if (riseFinal > 0) reasons.push(`final high-severity findings rose by ${riseFinal}`);
		const stale = coverage.baseline.summaryWarnings.length + coverage.candidate.summaryWarnings.length > 0;
		if (!reasons.length && stale) inconclusive.push("a cached acceptance summary is inconsistent with the task records: no pass is claimed");
		verdict = reasons.length ? "REGRESSION" : unknownQuality.length || stale ? "INCONCLUSIVE" : "NO_REGRESSION";
	}
	const costOf = (r) => ({ endToEnd: r.totals?.endToEnd ?? null, main: r.totals?.main?.cost ?? null, worker: r.totals?.worker?.cost ?? null, reviewer: r.totals?.reviewer?.usage?.cost ?? null, compaction: r.totals?.compaction?.cost ?? null });
	const reworkOf = (r) => ({ reworkTurns: r.totals?.rework?.turns ?? null, reworkRounds: r.totals?.rework?.rounds ?? null });
	const perTask = (base.tasks ?? []).map((b, i) => {
		const c = (cand.tasks ?? [])[i] ?? {};
		return { id: b.id, evaluatorComparable: evaluators[i].comparable, baselineAccepted: b.accepted, candidateAccepted: c.accepted ?? null, baselineHighFirst: b.reviewer?.cycles?.[0]?.highCount ?? null, candidateHighFirst: c.reviewer?.cycles?.[0]?.highCount ?? null, baselineReworkRounds: b.reworkRounds, candidateReworkRounds: c.reworkRounds ?? null };
	});
	const unaccepted = (r) => (r.tasks ?? []).filter((t) => t.accepted !== true).map((t) => t.id);
	const unacceptedTasks = { baseline: unaccepted(base), candidate: unaccepted(cand) };
	return {
		verdict, reasons, inconclusive,
		contract: CONTRACT,
		appliedPolicy: { sourceSchema: base.schemaVersion, candidateSchema: cand.schemaVersion, deadlineOutcomes: "structured-budget-cut-is-failed-attempt", missingReview: "unknown", continuation: { baseline: continuationPolicy(base) ?? "missing", candidate: continuationPolicy(cand) ?? "missing" } },
		// baselineEligible: the pair is usable matched bounded-budget data (complete attempt coverage, drained shutdowns, same method and limits). It is NOT a verdict and NOT a full 8-task baseline.
		baselineEligible: coverage.baseline.eligible && coverage.candidate.eligible && inconclusive.length === 0,
		attemptCoverage: coverage,
		quality: { status: unknownQuality.length ? "unknown" : "known", unknown: unknownQuality },
		allAccepted: unacceptedTasks.baseline.length === 0 && unacceptedTasks.candidate.length === 0,
		unacceptedTasks,
		caveat: CAVEAT,
		baseline: side(base), candidate: side(cand),
		acceptance: { baseline: bRate, candidate: cRate, drop: bRate === null || cRate === null ? null : bRate - cRate },
		highFindings: { first: { baseline: high(base, "first"), candidate: high(cand, "first"), rise: riseFirst }, final: { baseline: high(base, "final"), candidate: high(cand, "final"), rise: riseFinal } },
		rework: { baseline: reworkOf(base), candidate: reworkOf(cand) },
		cost: { baseline: costOf(base), candidate: costOf(cand) },
		perTask,
	};
}
