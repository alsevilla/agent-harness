// Optional per-role child budgets (maxTurns, contextBudget). Pure helpers shared by the parent (validation, env, markers, counters) and the child entry.
// Boundary stop only: SDK context tokens are estimates and the stop is cooperative, never a provider-token or first-request ceiling.

export interface RoleBudget { maxTurns?: number; contextBudget?: number }
export const BUDGET_KEYS = ["maxTurns", "contextBudget"] as const;

export const BUDGET_ENV = {
	maxTurns: "PI_SUBAGENT_ROLE_MAX_TURNS",
	contextBudget: "PI_SUBAGENT_ROLE_CONTEXT_TOKENS",
	turnsBefore: "PI_SUBAGENT_ROLE_TURNS_BEFORE",
	warned: "PI_SUBAGENT_ROLE_WARNED",
} as const;

export const MARKER_TYPE = "role-budget";
/** Fixed, task-independent text; appended to one already-required model request only (never queued as a steer or turn trigger). */
export const WARNING_TEXT = "Role budget notice: about 80% of your configured turn or context budget is used. Finish the current step, avoid new broad exploration, and report your partial results and remaining work.";

const isPlain = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const positive = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v > 0;

/** Strict shape: plain object, known keys only, positive safe integers, at least one field. */
export function budgetViolation(value: unknown, label: string): string | null {
	if (!isPlain(value)) return `${label} must be an object with maxTurns and/or contextBudget`;
	const unknown = Object.keys(value).filter((key) => !(BUDGET_KEYS as readonly string[]).includes(key));
	if (unknown.length) return `${label} has unknown key ${unknown.join(", ")}`;
	if (!BUDGET_KEYS.some((key) => key in value)) return `${label} needs maxTurns or contextBudget`;
	for (const key of BUDGET_KEYS) if (key in value && !positive(value[key])) return `${label}.${key} must be a positive safe integer`;
	return null;
}

/** Per-field precedence: task over role. Both unset is disabled (effective undefined). Any invalid input is an error, never ignored. */
export function normalizeBudget(role: unknown, task: unknown): { effective?: RoleBudget; error?: string } {
	for (const [label, value] of [["role budget", role], ["budget", task]] as const) {
		if (value === undefined) continue;
		const violation = budgetViolation(value, label);
		if (violation) return { error: violation };
	}
	const merged: RoleBudget = { ...(role as RoleBudget | undefined), ...(task as RoleBudget | undefined) };
	return BUDGET_KEYS.some((key) => merged[key] !== undefined) ? { effective: merged } : {};
}

/** 80% threshold without float or overflow: ceil(cap * 4 / 5). */
export const warnAt = (cap: number): number => cap - Math.floor(cap / 5);

export interface BudgetLaunch { budget: RoleBudget; turnsBefore: number; warned: boolean }

/** Numeric-only capability env for one child attempt. Every key is set or deleted so no stale inherited value survives. */
export function applyBudgetEnv(env: Record<string, string | undefined>, launch: BudgetLaunch): void {
	for (const key of BUDGET_KEYS) {
		const name = BUDGET_ENV[key];
		if (launch.budget[key] === undefined) delete env[name]; else env[name] = String(launch.budget[key]);
	}
	env[BUDGET_ENV.turnsBefore] = String(launch.turnsBefore);
	env[BUDGET_ENV.warned] = launch.warned ? "1" : "0";
}

/** Child-side strict parse. Throws on anything missing or malformed so the extension fails to load (the child exits before its first prompt). */
export function parseBudgetEnv(env: Record<string, string | undefined>): BudgetLaunch {
	const budget: RoleBudget = {};
	for (const key of BUDGET_KEYS) {
		const raw = env[BUDGET_ENV[key]];
		if (raw === undefined) continue;
		const value = /^[1-9][0-9]*$/.test(raw) ? Number(raw) : NaN;
		if (!positive(value)) throw new Error(`${BUDGET_ENV[key]} must be a positive safe integer`);
		budget[key] = value;
	}
	if (budget.maxTurns === undefined && budget.contextBudget === undefined) throw new Error("role budget requested but no limit is configured");
	const before = env[BUDGET_ENV.turnsBefore];
	const turnsBefore = before !== undefined && /^(0|[1-9][0-9]*)$/.test(before) ? Number(before) : NaN;
	if (!Number.isSafeInteger(turnsBefore)) throw new Error(`${BUDGET_ENV.turnsBefore} must be a non-negative safe integer`);
	const warned = env[BUDGET_ENV.warned];
	if (warned !== "0" && warned !== "1") throw new Error(`${BUDGET_ENV.warned} must be 0 or 1`);
	return { budget, turnsBefore, warned: warned === "1" };
}

export type BudgetMarker =
	| { v: 1; event: "warn80"; status: "sent" | "not_delivered"; turns: number }
	| { v: 1; event: "exhausted"; reason: "turns" | "context"; turns: number; contextTokens: number | null; warn80: "sent" | "not_delivered" }
	/** The child's current context observation: an available anchored SDK estimate, or null = unknown (never 0). Latest one wins; only emitted when a context limit is configured. */
	| { v: 1; event: "context"; tokens: number | null; turns: number };

/** Typed result of a budgeted child attempt: `exhausted` is a controlled non-success stop with partial output, never an accepted completion. */
export interface BudgetResult {
	state: "exhausted" | "not_exhausted";
	reason?: "turns" | "context";
	turns?: number;
	/** SDK estimate at the limit; null = unknown (never 0). */
	contextTokens?: number | null;
	warn80: "sent" | "not_delivered";
	limits: RoleBudget;
	/** True when no further attempt was started because the job's turn budget was already spent. */
	noNewAttempt?: boolean;
}

const count = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;

/** Parent-side: only a well-formed numeric/enum marker counts; free text is never read. */
export function parseMarker(entry: unknown): BudgetMarker | undefined {
	if (!isPlain(entry) || entry.type !== "custom" || entry.customType !== MARKER_TYPE || !isPlain(entry.data)) return undefined;
	const d = entry.data;
	if (d.v !== 1 || !count(d.turns)) return undefined;
	if (d.event === "context" && (d.tokens === null || count(d.tokens))) return { v: 1, event: "context", tokens: d.tokens as number | null, turns: d.turns };
	if (d.event === "warn80" && (d.status === "sent" || d.status === "not_delivered")) return { v: 1, event: "warn80", status: d.status, turns: d.turns };
	if (d.event === "exhausted" && (d.reason === "turns" || d.reason === "context") && (d.contextTokens === null || count(d.contextTokens)) && (d.warn80 === "sent" || d.warn80 === "not_delivered")) {
		return { v: 1, event: "exhausted", reason: d.reason, turns: d.turns, contextTokens: d.contextTokens as number | null, warn80: d.warn80 };
	}
	return undefined;
}

const totalOf = (usage: any): number => {
	if (!isPlain(usage)) return 0;
	const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0);
	return n(usage.totalTokens) || n(usage.input) + n(usage.output) + n(usage.cacheRead) + n(usage.cacheWrite);
};

/** Anchored usage: a finished assistant response that reported tokens. Child-side only: the parent counts the child's reported observation, never this flag. */
const anchoredAssistant = (message: any): boolean =>
	isPlain(message) && message.role === "assistant" && message.stopReason !== "error" && message.stopReason !== "aborted" && totalOf(message.usage) > 0;

/**
 * Child-side state machine. Turns are logical-job scoped (turnsBefore carries earlier attempts); context is this attempt only.
 * The limit is only recorded at turn_end; it stops work at the next already-required model request (context event), so a genuinely
 * terminal run (natural end or terminating tool) never becomes partial and a warning is never delivered without a request.
 */
export class BudgetMachine {
	turns: number;
	warned: boolean;
	warnPending = false;
	limit: "turns" | "context" | undefined;
	exhausted = false;
	contextTokens: number | null = null;
	private anchored = false;
	private cfg: BudgetLaunch;
	constructor(cfg: BudgetLaunch) { this.cfg = cfg; this.turns = cfg.turnsBefore; this.warned = cfg.warned; }
	assistantEnd(message: unknown): void {
		if (!isPlain(message) || message.role !== "assistant") return;
		this.turns++;
		if (anchoredAssistant(message)) this.anchored = true;
	}
	compacted(): void { this.anchored = false; this.contextTokens = null; }
	/** Only a context limit needs (and reports) a context observation. */
	get tracksContext(): boolean { return this.cfg.budget.contextBudget !== undefined; }
	/** `tokens` is ctx.getContextUsage()?.tokens: only trusted when anchored and a finite non-negative number; otherwise unknown (null), never 0. */
	turnEnd(event: { outcome?: unknown; message?: unknown }, tokens: unknown): void {
		if (this.exhausted || this.limit) return;
		const stop = isPlain(event.message) ? event.message.stopReason : undefined;
		if ((event.outcome !== undefined && event.outcome !== "completed") || stop === "error" || stop === "aborted") { this.contextTokens = null; return; } // no fresh estimate this turn: the previous one is not the current observation
		this.contextTokens = this.anchored && typeof tokens === "number" && Number.isFinite(tokens) && tokens >= 0 ? tokens : null;
		const { maxTurns, contextBudget } = this.cfg.budget;
		if (maxTurns !== undefined && this.turns >= maxTurns) this.limit = "turns";
		else if (contextBudget !== undefined && this.contextTokens !== null && this.contextTokens >= contextBudget) this.limit = "context";
		if (this.limit) return;
		const near = (maxTurns !== undefined && this.turns >= warnAt(maxTurns)) || (contextBudget !== undefined && this.contextTokens !== null && this.contextTokens >= warnAt(contextBudget));
		if (near && !this.warned) this.warnPending = true;
	}
	/** Called when a model request is already being prepared (context event): the only point where work is known to be active. */
	request(): "exhaust" | "warn" | "none" {
		if (this.exhausted) return "none";
		if (this.limit) { this.exhausted = true; return "exhaust"; }
		if (this.warnPending && !this.warned) { this.warned = true; this.warnPending = false; return "warn"; }
		return "none";
	}
	/** True once the limit is known: compaction and cache-warm requests that follow are wasted spend. */
	get stopping(): boolean { return this.exhausted || this.limit !== undefined; }
}
