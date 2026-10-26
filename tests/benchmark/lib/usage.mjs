// Usage ledgers. Numbers come only from SDK-reported usage; a missing value is null/unavailable, never zero.
// Cost is the SDK's cost.total (includes cache prices); the cache-tier part is cost.cacheRead + cost.cacheWrite.
// Worker (subagent) results report total cost only, so their cache-tier split is marked unavailable.
const finite = (v) => typeof v === "number" && Number.isFinite(v);

export function emptyLedger(kind = "model") {
	return { kind, calls: 0, unreported: 0, unpriced: 0, reported: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, cacheCost: 0, launches: 0, unreportedLaunches: 0, workerTurns: 0 };
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

// Subagent tool details: one launch per child result. Missing details are an unreported launch, not a zero-cost launch.
export function addWorkerUsage(l, details) {
	l.kind = "worker";
	if (!details || !Array.isArray(details.results)) { l.unreportedLaunches++; return l; }
	for (const r of details.results) {
		const u = r?.usage;
		if (!u) { l.unreportedLaunches++; continue; }
		l.launches++;
		l.workerTurns += finite(u.turns) ? u.turns : 0;
		l.input += finite(u.input) ? u.input : 0;
		l.output += finite(u.output) ? u.output : 0;
		l.cacheRead += finite(u.cacheRead) ? u.cacheRead : 0;
		l.cacheWrite += finite(u.cacheWrite) ? u.cacheWrite : 0;
		if (finite(u.cost)) { l.cost += u.cost; l.reported++; } else l.unpriced++;
	}
	return l;
}

export function addLedgers(a, b) {
	const out = emptyLedger(a.kind === "worker" || b.kind === "worker" ? "worker" : a.kind);
	for (const k of Object.keys(out)) if (k !== "kind") out[k] = a[k] + b[k];
	return out;
}

// Totals for reporting. status: none (worker only, no launches), unavailable (nothing measured), partial, measured.
export function ledgerTotals(l) {
	const isWorker = l.kind === "worker";
	const turns = isWorker ? l.workerTurns : l.calls;
	const missing = l.unreported + l.unreportedLaunches;
	let status;
	if (isWorker && l.launches === 0 && missing === 0) status = "none";
	else if (l.reported === 0 && l.launches === 0) status = "unavailable";
	else if (missing > 0 || l.unpriced > 0) status = "partial";
	else status = "measured";
	const tokensKnown = l.reported > 0 || (isWorker && l.launches > 0);
	const costKnown = status === "measured" || status === "none" || (status !== "unavailable" && l.unpriced === 0 && missing === 0);
	const costTotal = status === "none" ? 0 : costKnown ? l.cost : null;
	let cacheTier;
	let cacheTierNote;
	if (isWorker) {
		cacheTier = status === "none" ? 0 : null;
		cacheTierNote = "worker results report total cost only";
	} else cacheTier = costKnown ? l.cacheCost : null;
	const cost = { total: costTotal, cacheTier };
	if (cacheTierNote !== undefined) cost.cacheTierNote = cacheTierNote;
	return {
		kind: l.kind, status,
		calls: l.calls, turns: isWorker ? l.workerTurns : l.calls, unreportedTurns: l.unreported, unpricedTurns: l.unpriced,
		launches: l.launches, unreportedLaunches: l.unreportedLaunches,
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
