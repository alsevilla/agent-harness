// Main-session telemetry (Phase 1): numeric per-turn components from native assistant usage and compaction events. Never message text.
// Prompt tokens = input + cacheRead + cacheWrite of one request (output is never context). Unknown values stay null, never invented.

export interface MainTurn { turn: number; promptTokens: number | null; input: number; output: number; cacheRead: number; cacheWrite: number; cost: number | null }
export interface MainState {
	turns: number; // assistant turns since session start
	unreportedTurns: number; // assistant turns with no usage or a non-numeric input count
	unpricedTurns: number; // turns with usage but no finite cost
	totals: { input: number; output: number; cacheRead: number; cacheWrite: number; cost: number; cacheCost: number };
	last?: MainTurn;
	peakPrompt: number | null; // since session start
	peakPromptSinceCompaction: number | null;
	compactions: number;
	turnsSinceCompaction: number; // equals turns when no compaction happened
	lastCompaction?: { reason: string; tokensBefore: number | null; atTurn: number };
}

export const emptyMainState = (): MainState => ({
	turns: 0, unreportedTurns: 0, unpricedTurns: 0,
	totals: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, cacheCost: 0 },
	peakPrompt: null, peakPromptSinceCompaction: null, compactions: 0, turnsSinceCompaction: 0,
});

const finite = (v: unknown): number => (Number.isFinite(v) ? (v as number) : 0);
const maxOf = (a: number | null, b: number | null): number | null => (b === null ? a : a === null ? b : Math.max(a, b));

// Records one finalized message; only assistant messages count as turns. Usage is read, never stored.
export function recordMainTurn(state: MainState, message: any): void {
	if (message?.role !== "assistant") return;
	const usage = message.usage;
	const turn = ++state.turns;
	state.turnsSinceCompaction++;
	if (!usage || !Number.isFinite(usage.input)) {
		state.unreportedTurns++;
		state.last = { turn, promptTokens: null, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: null };
		return;
	}
	const input = usage.input, output = finite(usage.output), cacheRead = finite(usage.cacheRead), cacheWrite = finite(usage.cacheWrite);
	const cost = usage.cost ?? {};
	const total = Number.isFinite(cost.total) ? (cost.total as number) : null;
	const promptTokens = input + cacheRead + cacheWrite;
	state.last = { turn, promptTokens, input, output, cacheRead, cacheWrite, cost: total };
	state.peakPrompt = maxOf(state.peakPrompt, promptTokens);
	state.peakPromptSinceCompaction = maxOf(state.peakPromptSinceCompaction, promptTokens);
	const t = state.totals;
	t.input += input; t.output += output; t.cacheRead += cacheRead; t.cacheWrite += cacheWrite;
	if (total === null) state.unpricedTurns++;
	else {
		t.cost += total;
		t.cacheCost += finite(cost.cacheRead) + finite(cost.cacheWrite);
	}
}

// A compaction event starts a new since-compaction window; session totals keep growing. tokensBefore is the SDK-reported value (null when absent).
export function recordMainCompaction(state: MainState, entry: { tokensBefore?: unknown } | undefined, reason: string): void {
	state.compactions++;
	state.turnsSinceCompaction = 0;
	state.peakPromptSinceCompaction = null;
	state.lastCompaction = { reason, tokensBefore: Number.isFinite(entry?.tokensBefore) ? (entry!.tokensBefore as number) : null, atTurn: state.turns };
}

// Rebuilds the same state from the persisted session branch (startup, reload, resume, fork). Replay order equals live event order.
export function mainStateFromBranch(entries: readonly any[]): MainState {
	const state = emptyMainState();
	for (const entry of entries) {
		if (entry?.type === "message") recordMainTurn(state, entry.message);
		else if (entry?.type === "compaction") recordMainCompaction(state, entry, typeof entry.reason === "string" ? entry.reason : "unknown");
	}
	return state;
}

// Auxiliary usage entries (cache-tier warming, compaction and branch summary generation) are counted at display time from the branch; they are not turns.
export function auxiliaryUsage(entries: readonly any[]): { entries: number; cost: number; unpriced: number } {
	const aux = { entries: 0, cost: 0, unpriced: 0 };
	const add = (usage: any) => {
		aux.entries++;
		const total = usage?.cost?.total;
		if (Number.isFinite(total)) aux.cost += total;
		else aux.unpriced++;
	};
	for (const entry of entries) {
		if (entry?.type === "usage") add(entry.usage);
		else if ((entry?.type === "compaction" || entry?.type === "branch_summary") && entry.usage !== undefined) add(entry.usage);
	}
	return aux;
}

const fmt = (n: number) => n.toLocaleString("en-US", { maximumFractionDigits: 0 });
const money = (n: number) => `$${n.toFixed(4)}`;
// Context line: Pi estimate is labelled as such; a missing value or window is named, never shown as zero.
function contextLine(tokens: number | null, window: number | undefined): string {
	if (tokens === null && window === undefined) return "Context now: unavailable (no estimate; window unavailable)";
	if (tokens === null) return `Context now: unavailable (no estimate); window ${fmt(window!)} tokens`;
	if (window === undefined) return `Context now: ${fmt(tokens)} tokens (window unavailable)`;
	return `Context now: ${fmt(tokens)} of ${fmt(window)} tokens (${((tokens / window) * 100).toFixed(1)}%, runtime estimate)`;
}

export function formatMain(state: MainState, aux: { entries: number; cost: number; unpriced: number }, context: { tokens: number | null; window?: number }): string {
	if (state.turns === 0) return ["Main session usage: No main-session turns recorded yet.", `Auxiliary usage entries: ${aux.entries} (${money(aux.cost)}).`].join("\n");
	const t = state.totals;
	const lastCompaction = state.lastCompaction ? `last at ${fmt(state.lastCompaction.tokensBefore ?? 0)} tokens before (${state.lastCompaction.reason})` : "no compaction";
	const last = state.last;
	const lines = [
		"Main session usage: this runtime session (rebuilt from the session branch on reload or resume; resets on new or fork).",
		`Turns: ${state.turns} since session start; ${state.turnsSinceCompaction} since last compaction; ${state.compactions} compaction(s), ${lastCompaction}.`,
		last && last.promptTokens !== null
			? `Last turn prompt: ${fmt(last.promptTokens)} tokens (input ${fmt(last.input)} + cache read ${fmt(last.cacheRead)} + cache write ${fmt(last.cacheWrite)}); output ${fmt(last.output)}; cost ${last.cost === null ? "not reported" : money(last.cost)}.`
			: "Last turn prompt: unreported.",
		`Peak prompt: ${state.peakPrompt === null ? "unreported" : fmt(state.peakPrompt)} since session start; ${state.peakPromptSinceCompaction === null ? "unreported" : fmt(state.peakPromptSinceCompaction)} since last compaction.`,
		contextLine(context.tokens, context.window),
		`Totals: input ${fmt(t.input)} | output ${fmt(t.output)} | cache read ${fmt(t.cacheRead)} | cache write ${fmt(t.cacheWrite)}; cost ${money(t.cost)} (cache tier ${money(t.cacheCost)} included).`,
		`Auxiliary usage (cache warming, compaction summaries): ${aux.entries} entries, ${money(aux.cost)}; unpriced ${aux.unpriced}. Turns: unreported ${state.unreportedTurns}, unpriced ${state.unpricedTurns}, excluded from costs.`,
	];
	return lines.join("\n");
}
