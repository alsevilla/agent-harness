// Session usage ledger views (Phase 1): settled-task records, nearest-rank percentiles, strict /subagent usage parsing and planner consultations.
// Numeric data only: no task text, prompts, messages or model roles beyond the configured/observed model identifiers.
import type { ModelTier } from "./agents.ts";

export type Advice = "unknown" | "accepted" | "rejected";
export type TaskStatus = "completed" | "failed" | "aborted";
export interface TaskUsageRecord {
	id: string; // "t-N": process-wide sequence, unique and stable for the life of the runtime process
	role: string;
	tier?: ModelTier; // tier of the selected agent (explicit or role default); absent when the role has no tier
	slot?: "fallback"; // explicit fallback start, provenance only
	background: boolean;
	status: TaskStatus;
	attempts: number; // physical launches, fallback attempts included
	turns: number; // finalized assistant turns across every attempt
	input: number; // provider input, excluding cache reads and writes (the SDK usage fields are disjoint)
	output: number; // includes reasoning (the SDK folds reasoning into output)
	cacheRead: number;
	cacheWrite: number;
	cost: number; // SDK-reported cost of priced turns only
	unpricedTurns: number;
	firstTurnPromptTokens: number | null; // prompt of the first turn = input + cacheRead + cacheWrite; null when that turn reported no usage
	peakPromptTokens: number | null; // largest prompt over the turns that reported usage; output is never part of a prompt
	configuredModel?: string; // first attempt's requested model (roles.json or dispatch default)
	observedModel?: string; // served identity reported by the final attempt; absent when none was observed
	consultationId?: string; // planner consultation this settled task answered
}
export interface ConsultationRecord { id: string; trigger: string; taskId?: string; advice: Advice }
export interface ConsultationMeta { trigger: string; taskId?: string }

// Process-wide sequences: IDs never repeat within one runtime process, even after a session reset.
let taskSequence = 0;
let consultationSequence = 0;
export const nextTaskId = (): string => `t-${++taskSequence}`;
export const nextConsultationId = (): string => `cons-${++consultationSequence}`;
const seqOf = (id: string): number => Number(id.slice(id.indexOf("-") + 1));

const TOKEN = /^[A-Za-z0-9._-]{1,64}$/;
// Planner consultation metadata is telemetry only: explicit, validated, nothing inferred. Absent keys are omitted, not undefined.
export function parseConsultationMeta(value: unknown): ConsultationMeta {
	if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("consultation must be an object with trigger and optional taskId");
	const input = value as Record<string, unknown>;
	const unknown = Object.keys(input).find((key) => key !== "trigger" && key !== "taskId");
	if (unknown !== undefined) throw new Error(`unknown consultation key "${unknown}"; allowed: trigger, taskId`);
	if (input.trigger === undefined) throw new Error("consultation.trigger is required");
	if (typeof input.trigger !== "string" || !TOKEN.test(input.trigger)) throw new Error("consultation.trigger must be 1-64 letters, digits, '.', '_' or '-'");
	if (input.taskId !== undefined && (typeof input.taskId !== "string" || !TOKEN.test(input.taskId))) throw new Error("consultation.taskId must be 1-64 letters, digits, '.', '_' or '-'");
	return input.taskId === undefined ? { trigger: input.trigger } : { trigger: input.trigger, taskId: input.taskId };
}

// Adds a consultation to a run scope at launch; the ID is returned for the launch and its settled task.
export function openConsultation(scope: { consultations: ConsultationRecord[] }, meta: ConsultationMeta): string {
	const valid = parseConsultationMeta(meta);
	const id = nextConsultationId();
	scope.consultations.push({ id, advice: "unknown", ...valid });
	return id;
}
// Removes a consultation that never launched (for example a background start that threw), so it cannot stay pending.
export function dropConsultation(consultations: ConsultationRecord[], id: string): void {
	const index = consultations.findIndex((c) => c.id === id);
	if (index >= 0) consultations.splice(index, 1);
}
// Operator/main advice on a consultation: last write wins; unknown IDs and values are refused.
export function applyAdvice(consultations: ConsultationRecord[], id: string, advice: Advice): void {
	if (advice !== "accepted" && advice !== "rejected") throw new Error(`advice must be accepted or rejected, got ${String(advice)}`);
	const record = consultations.find((c) => c.id === id);
	if (!record) throw new Error(`Unknown consultation ${id} in this run`);
	record.advice = advice;
}

// Nearest-rank percentile over finite values: rank = ceil(p/100 * n), 1-based. Empty input has no value (undefined, shown as n/a).
export function percentile(values: readonly number[], p: number): number | undefined {
	if (!(p > 0 && p <= 100)) throw new Error(`percentile must be in (0, 100], got ${p}`);
	const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
	if (sorted.length === 0) return undefined;
	return sorted[Math.max(0, Math.ceil((p / 100) * sorted.length) - 1)];
}

export type UsageView = { kind: "summary" | "by-role" | "main" | "planner" } | { kind: "top"; n: number };
// Strict parsing: one view per call; --top takes a positive whole number. Errors name the valid options.
export function parseUsageArgs(args: string): UsageView {
	const tokens = args.trim() === "" ? [] : args.trim().split(/\s+/);
	const views: UsageView[] = [];
	for (let i = 0; i < tokens.length; i++) {
		const token = tokens[i];
		if (token === "--by-role" || token === "--main" || token === "--planner") views.push({ kind: token.slice(2) as "by-role" | "main" | "planner" });
		else if (token === "--top") {
			const value = tokens[++i];
			if (value === undefined || !/^[1-9]\d*$/.test(value)) throw new Error(`--top needs a positive whole number, e.g. /subagent usage --top 5 (got ${value === undefined ? "nothing" : `"${value}"`})`);
			views.push({ kind: "top", n: Number(value) });
		} else throw new Error(`Unknown usage option "${token}". Use one usage view at a time: /subagent usage, --by-role, --top N, --main or --planner.`);
	}
	if (views.length > 1) throw new Error("Use one usage view at a time: --by-role, --top N, --main or --planner.");
	return views[0] ?? { kind: "summary" };
}

const NO_TASKS = "No settled agent tasks yet this run.";
const fmtInt = (n: number) => n.toLocaleString("en-US", { maximumFractionDigits: 0 });
const fmtAvg = (n: number) => n.toLocaleString("en-US", { maximumFractionDigits: 1 });
const fmtCost = (n: number | undefined) => (n === undefined ? "n/a" : `$${n.toFixed(4)}`);
const fmtOpt = (n: number | undefined) => (n === undefined ? "n/a" : fmtInt(n));
const priced = (t: TaskUsageRecord) => t.turns > 0 && t.unpricedTurns === 0;

export interface RoleSummary {
	role: string; settled: number; completed: number; failed: number; aborted: number;
	turns: number; turnsAvg: number; turnsP50: number; turnsP95: number; // turns percentiles include zero-turn tasks
	peakCount: number; peakP50?: number; peakP95?: number; // peaks exclude tasks without reported usage
	output: number; outputPerTurn?: number;
	cost: number; pricedTasks: number; avgCost?: number; // average over priced tasks only
}
// Per-role aggregation over settled tasks only. Zero or missing values stay undefined (n/a), never zero.
export function summarizeByRole(tasks: readonly TaskUsageRecord[]): RoleSummary[] {
	const groups = new Map<string, TaskUsageRecord[]>();
	for (const t of tasks) groups.set(t.role, [...(groups.get(t.role) ?? []), t]);
	return [...groups.keys()].sort().map((role) => {
		const rows = groups.get(role)!;
		const turns = rows.reduce((sum, t) => sum + t.turns, 0);
		const output = rows.reduce((sum, t) => sum + t.output, 0);
		const peaks = rows.map((t) => t.peakPromptTokens).filter((n): n is number => n !== null);
		const pricedRows = rows.filter(priced);
		const pricedCost = pricedRows.reduce((sum, t) => sum + t.cost, 0);
		const turnValues = rows.map((t) => t.turns);
		return {
			role, settled: rows.length,
			completed: rows.filter((t) => t.status === "completed").length,
			failed: rows.filter((t) => t.status === "failed").length,
			aborted: rows.filter((t) => t.status === "aborted").length,
			turns, turnsAvg: turns / rows.length,
			turnsP50: percentile(turnValues, 50)!, turnsP95: percentile(turnValues, 95)!,
			peakCount: peaks.length, peakP50: percentile(peaks, 50), peakP95: percentile(peaks, 95),
			output, outputPerTurn: turns > 0 ? output / turns : undefined,
			cost: rows.reduce((sum, t) => sum + t.cost, 0), pricedTasks: pricedRows.length,
			avgCost: pricedRows.length > 0 ? pricedCost / pricedRows.length : undefined,
		};
	});
}

export function formatByRole(tasks: readonly TaskUsageRecord[]): string {
	const header = "Subagent usage by role: this runtime run; settled tasks only; percentiles nearest-rank; n/a = no reported value.";
	if (tasks.length === 0) return `${header}\n${NO_TASKS}`;
	const lines = summarizeByRole(tasks).map((r) =>
		`${r.role}: ${r.settled} settled (${r.completed} completed, ${r.failed} failed, ${r.aborted} aborted); turns avg ${fmtAvg(r.turnsAvg)} p50 ${fmtInt(r.turnsP50)} p95 ${fmtInt(r.turnsP95)}; ` +
		(r.peakCount > 0 ? `peak prompt p50 ${fmtOpt(r.peakP50)} p95 ${fmtOpt(r.peakP95)} (${r.peakCount} with usage)` : "peak prompt n/a (0 with usage)") +
		`; output ${fmtInt(r.output)} (${r.outputPerTurn === undefined ? "n/a" : fmtAvg(r.outputPerTurn)} per turn); cost ${fmtCost(r.cost)} (avg ${fmtCost(r.avgCost)} over ${r.pricedTasks} priced)`,
	);
	return [header, ...lines].join("\n");
}

// Unknown cost ranks last (no priced turn); ties keep sequence order. The input array is not reordered.
export function topTasks(tasks: readonly TaskUsageRecord[], n: number): TaskUsageRecord[] {
	const rank = (a: TaskUsageRecord, b: TaskUsageRecord) => {
		const known = Number(priced(b)) - Number(priced(a));
		if (known !== 0) return known;
		if (priced(a) && a.cost !== b.cost) return b.cost - a.cost;
		return seqOf(a.id) - seqOf(b.id);
	};
	return [...tasks].sort(rank).slice(0, n);
}

export function formatTop(tasks: readonly TaskUsageRecord[], n: number): string {
	if (tasks.length === 0) return NO_TASKS;
	const shown = topTasks(tasks, n);
	const lines = shown.map((t, i) =>
		`${i + 1}. ${t.id} · ${t.role}${t.tier !== undefined ? ` · tier ${t.tier}` : ""} · ${t.status} · turns ${t.turns} · prompt first ${fmtOpt(t.firstTurnPromptTokens ?? undefined)} peak ${fmtOpt(t.peakPromptTokens ?? undefined)} · ` +
		`output ${fmtInt(t.output)}${t.turns > 0 ? ` (${fmtAvg(t.output / t.turns)}/turn)` : ""} · cost ${priced(t) ? fmtCost(t.cost) : "n/a"}` +
		`${t.observedModel !== undefined ? ` · observed ${t.observedModel}` : ""}`,
	);
	return [`Top ${shown.length} of ${tasks.length} settled agent tasks by cost (unknown cost last):`, ...lines].join("\n");
}

export interface PlannerReport {
	total: number; unassigned: number; accepted: number; rejected: number; unknown: number; pending: number;
	tasks: { taskId: string; count: number; settled: number }[];
}
// Planner consultations: grouped only by explicit taskId; unassigned consultations are counted, never shown as a task.
export function plannerReport(scope: { tasks: readonly TaskUsageRecord[]; consultations: readonly ConsultationRecord[] }): PlannerReport {
	const settledBy = (c: ConsultationRecord) => scope.tasks.filter((t) => t.consultationId === c.id);
	const groups = new Map<string, { count: number; settled: number }>();
	for (const c of scope.consultations) {
		if (c.taskId === undefined) continue;
		const g = groups.get(c.taskId) ?? { count: 0, settled: 0 };
		g.count++; if (settledBy(c).length > 0) g.settled++;
		groups.set(c.taskId, g);
	}
	const all = scope.consultations;
	return {
		total: all.length,
		unassigned: all.filter((c) => c.taskId === undefined).length,
		accepted: all.filter((c) => c.advice === "accepted").length,
		rejected: all.filter((c) => c.advice === "rejected").length,
		unknown: all.filter((c) => c.advice === "unknown").length,
		pending: all.filter((c) => settledBy(c).length === 0).length,
		tasks: [...groups].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([taskId, g]) => ({ taskId, ...g })),
	};
}

export function formatPlanner(scope: { tasks: readonly TaskUsageRecord[]; consultations: readonly ConsultationRecord[] }): string {
	if (scope.consultations.length === 0) return "No planner consultations recorded this run (metadata is optional; unrecorded decisions stay unknown).";
	const report = plannerReport(scope);
	const header = `Planner consultations: ${report.total} (accepted ${report.accepted}, rejected ${report.rejected}, unknown ${report.unknown}; pending ${report.pending}).`;
	const byTask = report.tasks.map((t) => `${t.taskId}: ${t.count} consultations (${t.settled} settled)`);
	const lines = scope.consultations.map((c) => {
		const linked = scope.tasks.filter((t) => t.consultationId === c.id);
		const tokens = linked.reduce((sum, t) => sum + t.input + t.output + t.cacheRead + t.cacheWrite, 0);
		const cost = linked.reduce((sum, t) => sum + t.cost, 0);
		const state = linked.length > 0 ? `settled · ${tokens.toLocaleString("en-US")} tokens · ${fmtCost(cost)}` : "pending (no settled planner task)";
		return `${c.id} · trigger ${c.trigger} · task ${c.taskId ?? "unassigned"} · advice ${c.advice} · ${state}`;
	});
	return [header, ...byTask, `unassigned: ${report.unassigned}`, ...lines].join("\n");
}
