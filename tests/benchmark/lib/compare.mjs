// Side-by-side comparison of two runs. Regression: acceptance rate drops or high-severity reviewer findings rise.
// NO_REGRESSION is RELATIVE to the baseline on the same matched tasks. It is NOT all tasks passed: read allAccepted and
// unacceptedTasks. Synthetic, failed, unavailable, mismatched or incomplete data is INCONCLUSIVE, never a pass.
// Rework and cost are reported side by side, not gated here.

const side = (r) => ({ mode: r.mode, status: r.status });
const CAVEAT = "NO_REGRESSION is relative to the baseline on the same matched tasks; it is NOT all tasks passed. Check allAccepted and unacceptedTasks.";

// Reviewer evaluator guard. A matched task is comparable only when every reviewer cycle on both sides has a complete recorded
// evaluator, the FIRST cycle and the FINAL cycle evaluators are equal, and the distinct evaluators across all cycles are equal.
// Cycle counts may differ because of rework; the measured candidate runtime is deliberately not compared here.
const sig = (e) => JSON.stringify(e);
const describeDiff = (a, b) => Object.keys(a).filter((k) => sig(a[k]) !== sig(b[k])).map((k) => `${k} ${sig(a[k])} vs ${sig(b[k])}`).join(", ") || "identity fields equal";

function evaluatorCheck(b, c) {
	const bc = b?.reviewer?.cycles ?? [], cc = c?.reviewer?.cycles ?? [];
	if (bc.length === 0 || cc.length === 0) return { comparable: false, reasons: ["no reviewer cycle to compare"] };
	const missing = [];
	if (bc.some((x) => !x.evaluator)) missing.push("baseline reviewer cycle lacks complete evaluator identity");
	if (cc.some((x) => !x.evaluator)) missing.push("candidate reviewer cycle lacks complete evaluator identity");
	if (missing.length) return { comparable: false, reasons: missing };
	const reasons = [];
	if (sig(bc[0].evaluator) !== sig(cc[0].evaluator)) reasons.push(`first cycle differs (${describeDiff(bc[0].evaluator, cc[0].evaluator)})`);
	if (sig(bc.at(-1).evaluator) !== sig(cc.at(-1).evaluator)) reasons.push(`final cycle differs (${describeDiff(bc.at(-1).evaluator, cc.at(-1).evaluator)})`);
	const setB = new Set(bc.map((x) => sig(x.evaluator))), setC = new Set(cc.map((x) => sig(x.evaluator)));
	if (setB.size !== setC.size || [...setB].some((s) => !setC.has(s))) reasons.push("distinct reviewer evaluators across cycles differ");
	return { comparable: reasons.length === 0, reasons };
}

export function compareResults(base, cand) {
	const inconclusive = [];
	const reasons = [];
	if (base.schemaVersion !== cand.schemaVersion) inconclusive.push("schemaVersion differs");
	if (base.manifestDigest !== cand.manifestDigest) inconclusive.push("manifest digest differs (different benchmark)");
	if (JSON.stringify(base.order) !== JSON.stringify(cand.order)) inconclusive.push("task order differs");
	if (base.mode !== cand.mode) inconclusive.push(`mode differs (${base.mode} vs ${cand.mode})`);
	for (const [name, r] of [["baseline", base], ["candidate", cand]]) {
		if (r.synthetic === true) inconclusive.push(`${name} is a synthetic result: not benchmark evidence`);
		if (r.status !== "complete") inconclusive.push(`${name} run status is ${r.status}${r.error ? `: ${r.error}` : ""}`);
		const ids = (r.tasks ?? []).map((t) => t.id);
		if (ids.length !== (r.order ?? []).length || JSON.stringify(ids) !== JSON.stringify(r.order ?? [])) inconclusive.push(`${name} has ${ids.length} task result(s) for ${(r.order ?? []).length} ordered task(s): tasks do not match the order`);
		if (r.totals?.reviewer?.unavailableCycles > 0) inconclusive.push(`${name} has ${r.totals.reviewer.unavailableCycles} unavailable reviewer cycle(s)`);
	}
	const cap = (r) => r.config?.maxReworkRounds?.value ?? null;
	if (cap(base) === null || cap(base) !== cap(cand)) inconclusive.push(`rework cap differs or is missing (${cap(base)} vs ${cap(cand)})`);
	for (const role of ["main", "reviewer"]) {
		const b = base.config?.roles?.[role], c = cand.config?.roles?.[role];
		if (!b || !c || b.model !== c.model || b.thinking !== c.thinking || sig(b.fallbacks ?? []) !== sig(c.fallbacks ?? [])) inconclusive.push(`configured ${role} model, thinking or fallbacks differ (${b?.model ?? "none"} vs ${c?.model ?? "none"})`);
	}
	const evaluators = (base.tasks ?? []).map((b, i) => evaluatorCheck(b, (cand.tasks ?? [])[i]));
	base.tasks?.forEach((b, i) => { if (!evaluators[i].comparable) inconclusive.push(`reviewer evaluator not comparable for task ${b.id}: ${evaluators[i].reasons.join("; ")}`); });
	const rate = (r) => r.totals?.acceptance?.rate ?? null;
	const bRate = rate(base), cRate = rate(cand);
	if (bRate === null || cRate === null) inconclusive.push("acceptance rate unavailable");
	const high = (r, k) => r.totals?.highFindings?.[k] ?? null;
	const rise = (k) => (high(base, k) === null || high(cand, k) === null ? null : high(cand, k) - high(base, k));
	const riseFirst = rise("first"), riseFinal = rise("final");
	if (riseFirst === null || riseFinal === null) inconclusive.push("high-severity findings unavailable");
	let verdict;
	if (inconclusive.length) verdict = "INCONCLUSIVE";
	else {
		if (cRate < bRate) reasons.push(`acceptance dropped ${bRate.toFixed(3)} -> ${cRate.toFixed(3)}`);
		if (riseFirst > 0) reasons.push(`first-pass high-severity findings rose by ${riseFirst}`);
		if (riseFinal > 0) reasons.push(`final high-severity findings rose by ${riseFinal}`);
		verdict = reasons.length ? "REGRESSION" : "NO_REGRESSION";
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
