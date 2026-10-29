// Usage ledgers. Numbers come only from SDK-reported usage; a missing value is null/unavailable, never zero.
// Cost is the SDK's cost.total (includes cache prices); the cache-tier part is cost.cacheRead + cost.cacheWrite.
// Worker (subagent) results report total cost only, so their cache-tier split is marked unavailable.
const finite = (v) => typeof v === "number" && Number.isFinite(v);

export function emptyLedger(kind = "model") {
	return { kind, calls: 0, unreported: 0, unpriced: 0, reported: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, cacheCost: 0, launches: 0, failedLaunches: 0, unreportedLaunches: 0, workerTurns: 0, interrupted: 0, unresolved: [] };
}

// A launch whose cost is not known, with a stable id and a reason code (never text). Counted once per id; the launch counts as unreported.
export function markUnknown(l, id, reason) {
	if (!l.unresolved.some((u) => u.id === id)) { l.unresolved.push({ id, reason }); l.unreportedLaunches++; }
	return l;
}
// A later measurement of the same job (its terminal audit) replaces the unknowns that job left: the exact id or any of its `#position` children.
function resolveUnknown(l, id) {
	const gone = l.unresolved.filter((u) => u.id === id || u.id.startsWith(`${id}#`));
	l.unresolved = l.unresolved.filter((u) => !gone.includes(u));
	// Each reason was counted in exactly one counter when it was recorded; undo that one.
	const counter = { no_child_turn: "failedLaunches", unpriced: "unpriced", aborted_in_flight_usage_unknown: "interrupted" };
	for (const u of gone) { const k = counter[u.reason] ?? "unreportedLaunches"; l[k] = Math.max(0, l[k] - 1); }
}

// One model call (assistant turn, review call or compaction summary). usage may be absent.
export function addUsage(l, usage) {
	l.calls++;
	if (!usage || !finite(usage.input)) { l.unreported++; return l; }
	l.reported++;
	l.input += usage.input;
	l.output += finite(usage.output) ? usage.output : 0;
	l.cacheRead += finite(usage.cacheRead) ? usage.cacheRead : 0;
	l.cacheWrite += finite(usage.cacheWrite) ? usage.cacheWrite : 0;
	const total = usage.cost?.total;
	if (!finite(total)) { l.unpriced++; return l; }
	l.cost += total;
	l.cacheCost += (finite(usage.cost.cacheRead) ? usage.cost.cacheRead : 0) + (finite(usage.cost.cacheWrite) ? usage.cost.cacheWrite : 0);
	return l;
}

export function addAssistantUsage(l, message) {
	if (message?.role !== "assistant") return l;
	return addUsage(l, message.usage);
}

// One child result. Price completeness is the existing LogicalUsage flag (unpricedTurns, carried in phase1): the native aggregate adds 0 for a turn with no price, so a finite
// cost alone never proves a complete price. A result without the flag is an older plain usage summary and is priced as before.
const unpricedOf = (r) => (finite(r?.phase1?.unpricedTurns) ? r.phase1.unpricedTurns : finite(r?.usage?.unpricedTurns) ? r.usage.unpricedTurns : 0);
function addChild(l, r, rid) {
	const u = r?.usage;
	if (!u || !finite(u.turns)) { l.unreportedLaunches++; if (rid) l.unresolved.push({ id: rid, reason: "no_usage_reported" }); return; }
	// No child assistant turn: a failed attempt, kept apart from measured usage (never a measured zero workload).
	if (u.turns === 0) { l.failedLaunches++; if (rid) l.unresolved.push({ id: rid, reason: "no_child_turn" }); return; }
	l.launches++;
	l.workerTurns += finite(u.turns) ? u.turns : 0;
	l.input += finite(u.input) ? u.input : 0;
	l.output += finite(u.output) ? u.output : 0;
	l.cacheRead += finite(u.cacheRead) ? u.cacheRead : 0;
	l.cacheWrite += finite(u.cacheWrite) ? u.cacheWrite : 0;
	// A finite cost is the known priced subtotal; any unpriced turn keeps the child (and so the total) partial.
	if (finite(u.cost)) { l.cost += u.cost; l.reported++; }
	if (!finite(u.cost) || unpricedOf(r) > 0) { l.unpriced++; if (rid) l.unresolved.push({ id: rid, reason: "unpriced" }); }
}

// Subagent tool details: one launch per child result. Missing details are an unreported launch, not a zero-cost launch.
export function addWorkerUsage(l, details, id) {
	l.kind = "worker";
	if (!details || !Array.isArray(details.results)) { l.unreportedLaunches++; if (id) l.unresolved.push({ id, reason: "no_results_reported" }); return l; }
	for (const [i, r] of details.results.entries()) addChild(l, r, id ? `${id}#${Number.isInteger(r?.position) ? r.position : i}` : null);
	return l;
}

// --- One background job, reconciled per child. A job is one stable execution identity (owner session + job id); each child keeps its position, so two children with the
// same role stay two charges. Every observation of the job (its completion, its hidden terminal audit, a later richer snapshot) is merged into it, never summed.
const hasUsage = (r) => finite(r?.usage?.turns);
const fullyPriced = (r) => hasUsage(r) && finite(r.usage.cost) && unpricedOf(r) === 0;
const sameUsage = (a, b) => ["turns", "input", "output", "cacheRead", "cacheWrite", "cost"].every((k) => a.usage[k] === b.usage[k]) && unpricedOf(a) === unpricedOf(b);
export const newJob = (key) => ({ key, children: new Map(), aborted: false, observed: false, noResults: false, conflicts: new Set() });
// Richer data fills what a child lacks (usage, price completeness); two complete but different reports of one child are a conflict, which stays unknown (no guessed charge).
function mergeChild(prev, next) {
	if (!hasUsage(prev)) return hasUsage(next) ? next : prev;
	if (!hasUsage(next) || sameUsage(prev, next)) return prev;
	if (fullyPriced(prev) && fullyPriced(next)) return null;
	if (fullyPriced(next) && next.usage.turns >= prev.usage.turns) return next;
	if (fullyPriced(prev) && prev.usage.turns >= next.usage.turns) return prev;
	return null;
}
// partial: evidence that is not the job's completion or audit (a retrieved control result, an unattributed record): its children are kept, but the job is never proven complete.
export function observeJob(job, { state, results }, { partial = false } = {}) {
	if (!partial) job.observed = true;
	if (state === "aborted" && !partial) job.aborted = true;
	if (!Array.isArray(results) || results.length === 0) { if (!partial) job.noResults = true; return job; }
	for (const [i, r] of results.entries()) {
		const pos = Number.isInteger(r?.position) ? r.position : i;
		if (job.conflicts.has(pos)) continue;
		const prev = job.children.get(pos);
		if (!prev) { job.children.set(pos, r); continue; }
		const merged = mergeChild(prev, r);
		if (merged === null) { job.children.delete(pos); job.conflicts.add(pos); } else job.children.set(pos, merged);
	}
	return job;
}
// The job's children enter a ledger once. A job nothing ever reported is an unknown launch; an aborted job's in-flight stream may hold usage no event reported,
// so each of its children is also interrupted (never turned into a number).
export function addJobUsage(l, job) {
	l.kind = "worker";
	if (!job.observed) markUnknown(l, job.key, "completion_not_received");
	if (job.noResults && job.children.size === 0 && job.conflicts.size === 0) markUnknown(l, job.key, "no_results_in_audit");
	const positions = [...new Set([...job.children.keys(), ...job.conflicts])].sort((a, b) => a - b);
	for (const pos of positions) {
		const rid = `${job.key}#${pos}`;
		if (job.conflicts.has(pos)) { l.unreportedLaunches++; l.unresolved.push({ id: rid, reason: "conflicting_usage" }); }
		else addChild(l, job.children.get(pos), rid);
		if (job.aborted) { l.interrupted++; l.unresolved.push({ id: rid, reason: "aborted_in_flight_usage_unknown" }); }
	}
	return l;
}

// One hidden terminal audit (job key = owner session + job id; each result keeps its stable position). Replaces any unknown the same job left pending.
export function addAuditUsage(l, audit) {
	resolveUnknown(l, audit.jobKey);
	return addJobUsage(l, observeJob(newJob(audit.jobKey), audit));
}

export function addLedgers(a, b) {
	const out = emptyLedger(a.kind === "worker" || b.kind === "worker" ? "worker" : a.kind);
	for (const k of Object.keys(out)) if (k !== "kind" && k !== "unresolved") out[k] = a[k] + b[k];
	out.unresolved = [...a.unresolved, ...b.unresolved];
	return out;
}

// Totals for reporting. status: none (worker only, no launches), failed (worker attempts with no child turn), unavailable (nothing measured), partial, measured.
export function ledgerTotals(l) {
	const isWorker = l.kind === "worker";
	const turns = isWorker ? l.workerTurns : l.calls;
	const missing = l.unreported + l.unreportedLaunches + l.interrupted;
	let status;
	if (isWorker && l.launches === 0 && l.failedLaunches === 0 && missing === 0) status = "none";
	else if (isWorker && l.launches === 0 && l.failedLaunches > 0) status = "failed";
	else if (l.reported === 0 && l.launches === 0) status = "unavailable";
	else if (missing > 0 || l.unpriced > 0 || l.failedLaunches > 0) status = "partial";
	else status = "measured";
	const tokensKnown = l.reported > 0 || (isWorker && l.launches > 0);
	// Cost is known only for a complete measurement; a failed or partial worker total is unknown (null), never a zero.
	const costKnown = status === "measured" || status === "none";
	const costTotal = status === "none" ? 0 : costKnown ? l.cost : null;
	let cacheTier;
	let cacheTierNote;
	if (isWorker) {
		cacheTier = status === "none" ? 0 : null;
		cacheTierNote = "worker results report total cost only";
	} else cacheTier = costKnown ? l.cacheCost : null;
	const cost = { total: costTotal, cacheTier };
	// Known finite priced cost is kept when the total is unavailable; it is a lower bound, never the total.
	if (costTotal === null) { cost.knownPricedSubtotal = l.cost; cost.unresolved = l.unresolved.map((u) => ({ ...u })); }
	if (cacheTierNote !== undefined) cost.cacheTierNote = cacheTierNote;
	return {
		kind: l.kind, status,
		calls: l.calls, turns: isWorker ? l.workerTurns : l.calls, unreportedTurns: l.unreported, unpricedTurns: l.unpriced,
		launches: l.launches, failedLaunches: l.failedLaunches, unreportedLaunches: l.unreportedLaunches,
		input: tokensKnown && !isWorker ? l.input : tokensKnown ? l.input : null,
		output: tokensKnown ? l.output : null,
		cacheRead: tokensKnown ? l.cacheRead : null,
		cacheWrite: tokensKnown ? l.cacheWrite : null,
		cost,
	};
}

// Sum of cost values; any unavailable part makes the whole sum unavailable (null), never a partial total.
export function sumCosts(values) {
	if (values.some((v) => !finite(v))) return null;
	return values.reduce((s, v) => s + v, 0);
}
