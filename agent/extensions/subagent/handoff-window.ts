// Main-session handoff window: keeps main's request context from growing with every subagent result.
// Before each model request, Pi's `context` event hands over a deep copy of the messages; returning `{ messages }` changes
// that request only, never the saved transcript. The newest results stay word for word; older settled PASS results are
// replaced in the request by one line built from their STATUS/NEXT/EVIDENCE fields. Deterministic: no model call.
//
// Kept word for word, always: anything without a STATUS line (launch receipts, other tools), any error,
// any non-PASS STATUS, any RISKS other than "none", any non-completed or partial background notice, and any result
// the one-line form would not at least halve (a normal short reply saves too little to be worth the prefix change).
// Cache stability: older results collapse in batches of `window` and a collapsed line never changes, so the request
// prefix changes once per batch rather than on every new result.
//
// Main's own large tool outputs (read, bash, grep, find, ls) get the same treatment: the newest `window` stay word for word,
// older ones are masked in whole batches by a one-line stub naming the tool and its file or command. Errors and short
// outputs are never masked. Plain masking, not summarization: it saves tokens without a model call or a guessed digest.
import { stoppedJobsCardPart, type StoppedJob } from "./stopped-jobs.ts";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const HANDOFF_WINDOW_ENV = "PI_SUBAGENT_HANDOFF_WINDOW";
export const DEFAULT_HANDOFF_WINDOW = 5;
const MIN_WINDOW = 5; // research guidance: shrinking below 5 recent results hurts more than it saves
const RESULT_TOOLS = new Set(["subagent", "subagent_control"]);
const COMPLETION_TYPE = "subagent-completion";
const FIELD = /^\s*(STATUS|NEXT|RISKS?|EVIDENCE)\s*:\s*(.*)$/i;
const CLIP = 160;

type Text = { type: string; text?: string };
type Message = { role?: string; toolName?: string; customType?: string; isError?: boolean; content?: unknown; details?: any; [key: string]: unknown };
interface Fields { status: string[]; next: string[]; risks: string[]; evidence: string[] }
interface Handoff { index: number; label: string; fields: Fields; length: number }

/** 0 turns the window off; integers >= 5 set it; anything else (unset, invalid, 1-4) uses the default of 5. */
export function handoffWindowFromEnv(env: NodeJS.ProcessEnv = process.env): number {
	const raw = env[HANDOFF_WINDOW_ENV]?.trim();
	if (raw === undefined || raw === "") return DEFAULT_HANDOFF_WINDOW;
	if (raw === "0") return 0;
	return /^\d{1,4}$/.test(raw) && Number(raw) >= MIN_WINDOW ? Number(raw) : DEFAULT_HANDOFF_WINDOW;
}

const clip = (text: string) => { const one = text.replace(/\s+/g, " ").trim(); return one.length > CLIP ? `${one.slice(0, CLIP - 1)}…` : one; };

function fieldsOf(text: string): Fields {
	const fields: Fields = { status: [], next: [], risks: [], evidence: [] };
	for (const line of text.split(/\r?\n/)) {
		const match = FIELD.exec(line);
		if (!match) continue;
		const key = match[1].toUpperCase();
		const value = match[2].trim();
		if (key === "STATUS") fields.status.push(value);
		else if (key === "NEXT") fields.next.push(value);
		else if (key.startsWith("RISK")) fields.risks.push(value);
		else fields.evidence.push(value);
	}
	return fields;
}

const isPass = (status: string) => /^PASS\b/i.test(status);
const noRisk = (risk: string) => /^none\.?$/i.test(risk.trim());
/** Collapsible only when every reported STATUS is PASS and every RISKS line is "none". */
const settledPass = (f: Fields) => f.status.length > 0 && f.status.every(isPass) && f.risks.every(noRisk);

const textOf = (content: unknown): string | undefined => {
	if (typeof content === "string") return content;
	if (!Array.isArray(content) || content.some((part: Text) => part?.type !== "text")) return undefined; // images or unknown parts: keep word for word
	return content.map((part: Text) => part.text ?? "").join("\n");
};

function recognize(message: Message, index: number): Handoff | undefined {
	if (message.role === "toolResult" && RESULT_TOOLS.has(String(message.toolName))) {
		if (message.isError) return undefined;
		const text = textOf(message.content);
		if (text === undefined) return undefined;
		const agents = Array.isArray(message.details?.results) ? message.details.results.map((r: any) => r?.agent).filter((a: unknown) => typeof a === "string") : [];
		return { index, label: `${message.toolName}${agents.length ? ` ${[...new Set(agents)].join(",")}` : ""}`, fields: fieldsOf(text), length: text.length };
	}
	if (message.role === "custom" && message.customType === COMPLETION_TYPE) {
		const text = textOf(message.content);
		if (text === undefined) return undefined;
		let notice: any;
		try { notice = JSON.parse(text); } catch { return undefined; }
		if (notice?.runtime?.state !== "completed" || notice?.result?.shown !== "all") return undefined; // failed, aborted or partial: keep
		const job = typeof notice.runtime.job === "string" ? notice.runtime.job : "bg";
		const workers = Array.isArray(notice.runtime.workers) ? notice.runtime.workers.filter((w: unknown) => typeof w === "string") : [];
		const child = `${notice.untrusted?.priorityLines ?? ""}\n${notice.untrusted?.excerpt ?? ""}`;
		const target = typeof notice.result?.target === "string" ? notice.result.target : undefined;
		return { index, label: `${target ?? job}${workers.length ? ` ${workers.join(",")}` : ""}`, fields: fieldsOf(child), length: text.length };
	}
	return undefined;
}
/** A finished handoff carries at least one STATUS line; receipts and other output are not counted toward the window. */
const handoffOf = (message: Message, index: number) => { const found = recognize(message, index); return found && found.fields.status.length ? found : undefined; };

/** The single line that replaces an older settled PASS result in the request. */
export function collapsedLine(handoff: Handoff): string {
	const f = handoff.fields;
	const parts = [`STATUS ${f.status.map(clip).join(" ; ")}`];
	if (f.next.length) parts.push(`NEXT ${f.next.map(clip).join(" ; ")}`);
	if (f.evidence.length) parts.push(`EVIDENCE ${f.evidence.map(clip).join(" ; ")}`);
	return `[older subagent result, shortened: ${handoff.label}] ${parts.join(" | ")} | may be outdated; full report: EVIDENCE or subagent_control result`;
}

/**
 * Returns a new message list with older settled PASS results collapsed, or undefined when nothing changes.
 * Never mutates its input. `window` 0 is off. The newest `window` recognized results stay word for word; of the older
 * ones, only whole batches of `window` collapse, so each collapsed line is fixed once written.
 */
export function collapseHandoffs<T extends Message>(messages: readonly T[], window: number): T[] | undefined {
	if (!(window > 0)) return undefined;
	const handoffs: Handoff[] = [];
	messages.forEach((message, index) => { const found = message && typeof message === "object" ? handoffOf(message, index) : undefined; if (found) handoffs.push(found); });
	const older = handoffs.length - window;
	const batch = Math.floor(Math.max(0, older) / window) * window;
	if (batch === 0) return undefined;
	// A result is shortened only when that at least halves it: a short four-line reply is left alone, since replacing it saves little and still changes the prefix.
	const collapse = handoffs.slice(0, batch).filter((h) => settledPass(h.fields)).map((h) => ({ h, line: collapsedLine(h) })).filter(({ h, line }) => line.length * 2 <= h.length);
	if (!collapse.length) return undefined;
	const out = messages.slice();
	for (const { h, line } of collapse) {
		const original = messages[h.index];
		out[h.index] = { ...original, content: original.role === "custom" && typeof original.content === "string" ? line : [{ type: "text", text: line }] } as T;
	}
	return out;
}

const MASK_TOOLS = new Set(["read", "bash", "grep", "find", "ls"]);
const MASK_MIN = 2000; // characters; a shorter output saves too little to be worth changing the prefix

const argLabel = (tool: string, args: any): string => {
	if (!args || typeof args !== "object") return "";
	if (tool === "read" && typeof args.path === "string") return clip(`${args.path}${args.offset !== undefined || args.limit !== undefined ? ` (offset ${args.offset ?? 0}, limit ${args.limit ?? "all"})` : ""}`);
	if (tool === "bash" && typeof args.command === "string") return clip(args.command);
	try { return clip(JSON.stringify(args)); } catch { return ""; }
};

/** The single line that replaces an older large tool output in the request. */
export function maskedLine(tool: string, label: string, length: number): string {
	return `[older ${tool} output, shortened: ${label || "(no arguments)"}] ${length.toLocaleString("en-US")} characters; run it again if you still need the content`;
}

/** Returns a new message list with older large read/bash/grep/find/ls outputs masked, or undefined when nothing changes. Never mutates its input. */
export function maskToolOutputs<T extends Message>(messages: readonly T[], window: number, batched = true, minChars = MASK_MIN): T[] | undefined {
	if (!(window > 0)) return undefined;
	const calls = new Map<string, any>();
	for (const m of messages) if (m?.role === "assistant" && Array.isArray(m.content)) for (const part of m.content as any[]) if (part?.type === "toolCall" && typeof part.id === "string") calls.set(part.id, part.arguments);
	const outputs: { index: number; tool: string; length: number; id: unknown }[] = [];
	messages.forEach((m, index) => {
		if (m?.role !== "toolResult" || m.isError || !MASK_TOOLS.has(String(m.toolName))) return;
		const text = textOf(m.content);
		if (text === undefined || text.length < minChars || text.startsWith("[older ")) return;
		outputs.push({ index, tool: String(m.toolName), length: text.length, id: m.toolCallId });
	});
	// Batched (default): whole batches only, so the cached prefix changes once per batch. Unbatched: every output older than the window.
	const batch = batched ? Math.floor(Math.max(0, outputs.length - window) / window) * window : Math.max(0, outputs.length - window);
	if (batch === 0) return undefined;
	const out = messages.slice();
	for (const o of outputs.slice(0, batch)) {
		const label = argLabel(o.tool, typeof o.id === "string" ? calls.get(o.id) : undefined);
		out[o.index] = { ...messages[o.index], content: [{ type: "text", text: maskedLine(o.tool, label, o.length) }] } as T;
	}
	return out;
}

// Threshold-triggered worker masking with budget fallbacks (best effort; the estimate is approximate and compaction is asynchronous,
// so this is not a hard bound). Workers keep every tool output word for word, and Claude Haiku 5.5 prices a request over 100k input
// tokens at 5x: a debugger run that averaged ~107k per request cost $0.20 instead of ~$0.06. From WORKER_MASK_ENV estimated tokens
// (default 80k) the request is shortened in steps, re-measuring after each, and stops at the first that fits WORKER_BUDGET_ENV (95k):
//   batch      main's stable batching (older large outputs, newest five kept, whole batches only)
//   all-older  every older large output, not just whole batches
//   small-older  every older output of 500 characters or more (long test runs leave many mid-size outputs)
//   bounded    remaining large outputs except the latest cut to head and tail
//   last-resort  every older output of 500+ characters masked, and the latest bounded to its first and last 8,000 characters
//   over       still over budget (assistant text dominates): the caller asks the host to compact once per run
// Sizes are calibrated against the provider: characters / 4 undercounts code and tool output (measured peaks of 128k and 140k
// against a 95k budget), so the estimate is scaled by the provider-reported input of the latest request (requestScale).
export const WORKER_MASK_ENV = "PI_SUBAGENT_WORKER_MASK_TOKENS";
export const WORKER_BUDGET_ENV = "PI_SUBAGENT_WORKER_TOKEN_BUDGET";
export const DEFAULT_WORKER_MASK_TOKENS = 80_000;
export const DEFAULT_WORKER_TOKEN_BUDGET = 95_000;
const MIN_WORKER_MASK_TOKENS = 20_000;
const BOUND_CHARS = 8_000; // an output over this is cut to its first and last BOUND_KEEP characters in the bounded step
const BOUND_KEEP = 2_000;
const tokensFromEnv = (raw: string | undefined, fallback: number, allowOff: boolean): number => {
	if (raw === undefined || raw.trim() === "") return fallback;
	const n = Number(raw.trim());
	if (allowOff && n === 0) return 0;
	return Number.isFinite(n) && n >= MIN_WORKER_MASK_TOKENS ? Math.floor(n) : fallback;
};
export function workerMaskFromEnv(env: NodeJS.ProcessEnv = process.env): number {
	return tokensFromEnv(env[WORKER_MASK_ENV], DEFAULT_WORKER_MASK_TOKENS, true);
}
/** The budget the fallbacks aim under; never below the trigger. */
export function workerBudgetFromEnv(env: NodeJS.ProcessEnv = process.env): number {
	return Math.max(tokensFromEnv(env[WORKER_BUDGET_ENV], DEFAULT_WORKER_TOKEN_BUDGET, false), workerMaskFromEnv(env));
}

// When masking pays depends on the model serving the request. Masking rewrites the cached history from the first masked output, so on a
// model whose price does not rise with request size it only adds cache writes (a 40-call simulated run: 15% dearer with masking than
// without). Claude Haiku 5.5 charges 5x for input beyond 100k, so there it pays, and starting at 90k beat 80k on every run length tried
// (40, 70 and 100 calls) while keeping every request under 100k; shrinking deeper (to 75k) cost more on long runs. Decided per request
// from the model that serves it, so a fallback attempt (a new worker on the fallback model) follows its own model.
export const HAIKU_MASK_TOKENS = 90_000;
export const FLAT_PRICE_MASK_TOKENS = 200_000; // no surcharge: a guard for quality and request size only
export interface MaskPolicy { from: number; budget: number; reason: string }
export function workerMaskPolicy(model: { provider?: string; id?: string } | undefined, env: NodeJS.ProcessEnv = process.env): MaskPolicy {
	if ((env[WORKER_MASK_ENV] ?? "").trim() !== "") return { from: workerMaskFromEnv(env), budget: workerBudgetFromEnv(env), reason: `${WORKER_MASK_ENV} is set` };
	const provider = String(model?.provider ?? "").toLowerCase();
	const id = String(model?.id ?? "").toLowerCase();
	const budget = (from: number) => Math.max(tokensFromEnv(env[WORKER_BUDGET_ENV], DEFAULT_WORKER_TOKEN_BUDGET, false), from);
	if (provider === "anthropic" && /^claude-haiku-5-5(\b|$)/.test(id)) return { from: HAIKU_MASK_TOKENS, budget: budget(HAIKU_MASK_TOKENS), reason: "Claude Haiku 5.5 charges 5x for input beyond 100k" };
	if (provider === "anthropic" && /^claude-(sonnet|opus|fable|mythos)-/.test(id)) return { from: FLAT_PRICE_MASK_TOKENS, budget: budget(FLAT_PRICE_MASK_TOKENS), reason: "no long-request surcharge: masking would only add cache writes" };
	// Other providers (Codex, Copilot, including Copilot's Claude models) and unknown models: their pricing and context limits are not known here.
	return { from: DEFAULT_WORKER_MASK_TOKENS, budget: budget(DEFAULT_WORKER_MASK_TOKENS), reason: "pricing and context limit not known for this model" };
}

/** Rough request size: characters of text, thinking and tool-call arguments divided by 4 (images not counted). */
export function estimateTokens(messages: readonly Message[]): number {
	let chars = 0;
	for (const m of messages) {
		const content = (m as any)?.content;
		if (typeof content === "string") { chars += content.length; continue; }
		if (!Array.isArray(content)) continue;
		for (const part of content as any[]) {
			if (typeof part?.text === "string") chars += part.text.length;
			else if (typeof part?.thinking === "string") chars += part.thinking.length;
			else if (part?.type === "toolCall") { try { chars += JSON.stringify(part.arguments ?? {}).length; } catch { /* skip */ } }
		}
	}
	return Math.ceil(chars / 4);
}
/** Cut every text tool output over BOUND_CHARS, except the latest tool result, to its head and tail. Undefined when nothing changes. */
export function boundToolOutputs<T extends Message>(messages: readonly T[], includeLatest = false, max = BOUND_CHARS, keep = BOUND_KEEP): T[] | undefined {
	let latest = -1;
	messages.forEach((m, i) => { if (m?.role === "toolResult") latest = i; });
	let changed = false;
	const out = messages.map((m, i) => {
		if ((i === latest && !includeLatest) || m?.role !== "toolResult") return m;
		const text = textOf(m.content);
		if (text === undefined || text.length <= max) return m;
		changed = true;
		const cut = text.length - 2 * keep;
		return { ...m, content: [{ type: "text", text: `${text.slice(0, keep)}\n[… ${cut.toLocaleString("en-US")} characters shortened to stay in budget; read again with offset and limit, or rerun, if you need them …]\n${text.slice(-keep)}` }] } as T;
	});
	return changed ? out : undefined;
}
// Last resort for the current request (field report on v1.14.0 + #53: a debugger still sent 4 requests over 100k, peak 119,337, because
// the newest outputs were never touched and compaction only helps the next request): every older output of 500+ characters is masked
// and the latest is bounded to its first and last 8,000 characters.
const LAST_RESORT_KEEP = 8_000;
function lastResort<T extends Message>(messages: readonly T[]): T[] | undefined {
	const masked = maskToolOutputs(messages, 1, false, SMALL_MASK_MIN);
	const bounded = boundToolOutputs(masked ?? messages, true, 2 * LAST_RESORT_KEEP, LAST_RESORT_KEEP);
	return bounded ?? masked;
}
export type CapStep = "batch" | "all-older" | "small-older" | "bounded" | "last-resort" | "over";
export interface CapResult<T> { messages?: T[]; step?: CapStep; before: number; after: number; scale: number }
const SMALL_MASK_MIN = 500;
/**
 * Provider tokens per estimated token, from the latest assistant message that reports usage: its request carried every message before
 * it plus `base` (system prompt and tools), and the provider counted input + cacheRead + cacheWrite. Never below 1 (an estimate is
 * only ever scaled up) and at most 4; 1 when no usage is known yet.
 */
export function requestScale(messages: readonly Message[], base = 0): number {
	for (let i = messages.length - 1; i >= 0; i--) {
		const m = messages[i] as any;
		if (m?.role !== "assistant" || !m.usage) continue;
		const real = [m.usage.input, m.usage.cacheRead, m.usage.cacheWrite].reduce((sum: number, v: unknown) => sum + (Number.isFinite(v) ? (v as number) : 0), 0);
		const estimated = base + estimateTokens(messages.slice(0, i));
		if (!(real > 0) || !(estimated > 0)) return 1;
		return Math.min(4, Math.max(1, real / estimated));
	}
	return 1;
}
/**
 * Worker request shortening. `base` is the estimated size of everything outside `messages` (the system prompt and tools). Nothing
 * changes below `from`; above it each step runs only while the re-measured request is still at or over `budget`.
 */
export function capWorkerContext<T extends Message>(messages: readonly T[], from: number, budget = Math.max(from, DEFAULT_WORKER_TOKEN_BUDGET), base = 0, scale = requestScale(messages, base)): CapResult<T> {
	const measure = (list: readonly T[]) => Math.ceil((base + estimateTokens(list)) * scale);
	const before = measure(messages);
	if (!(from > 0) || before < from) return { before, after: before, scale };
	let current = messages as T[];
	let step: CapStep | undefined;
	let size = before;
	const attempt = (next: T[] | undefined, name: CapStep) => {
		if (!next) return;
		current = next; step = name; size = measure(next);
	};
	attempt(maskToolOutputs(current, DEFAULT_HANDOFF_WINDOW), "batch");
	if (size >= budget) attempt(maskToolOutputs(current, DEFAULT_HANDOFF_WINDOW, false), "all-older");
	if (size >= budget) attempt(maskToolOutputs(current, DEFAULT_HANDOFF_WINDOW, false, SMALL_MASK_MIN), "small-older");
	if (size >= budget) attempt(boundToolOutputs(current), "bounded");
	if (size >= budget) attempt(lastResort(current), "last-resort");
	if (size >= budget) step = "over";
	return { messages: current === messages ? undefined : current, step, before, after: size, scale };
}

/** Both request-only shortenings in order: subagent results first, then main's own large tool outputs. */
export function shortenContext<T extends Message>(messages: readonly T[], window: number): T[] | undefined {
	const handoffs = collapseHandoffs(messages, window);
	const masked = maskToolOutputs(handoffs ?? messages, window);
	return masked ?? handoffs;
}

// Runtime state card: while jobs run or worker decisions wait, each main request ends with one hidden line naming them, so a compacted
// conversation still knows what is in flight and never re-launches it. Appended at the very end, so the cached prefix is untouched.
export const STATE_CARD_TYPE = "subagent-state";
export interface StateJob { jobId: string; state: string; paused?: boolean; workers?: { name?: string }[] }
export function stateCard(jobs: readonly StateJob[], epoch: string, openDecisions: number, stopped: readonly StoppedJob[] = []): string | undefined {
	const running = jobs.filter((j) => j.state === "running");
	if (!running.length && !openDecisions && !stopped.length) return undefined;
	const list = running.slice(0, 8).map((j) => `${j.jobId}@${epoch} (${[...new Set((j.workers ?? []).map((w) => w.name).filter(Boolean))].join(", ") || "starting"}${j.paused ? ", paused" : ""})`);
	const parts = [running.length ? `running: ${list.join("; ")}${running.length > 8 ? `; +${running.length - 8} more` : ""}` : "no running jobs"];
	if (openDecisions) parts.push(`${openDecisions} worker decision${openDecisions === 1 ? "" : "s"} waiting (subagent_control decisions)`);
	if (stopped.length) parts.push(stoppedJobsCardPart([...stopped]));
	return `[runtime state, not user text] ${parts.join("; ")}. Completions arrive automatically; do not re-launch running work.`;
}

export const CLEARED_CARD = "[runtime state, not user text] no running jobs and no waiting worker decisions now.";

/**
 * The state card as if it were stored in the history. Pi puts the conversation's one cache breakpoint on the last block of the last
 * user message, so a card appended to the end of every request held that breakpoint: each cache entry ended in a card the next request
 * no longer had there, nothing matched, and main's whole history was written to the cache again on every request while a job ran.
 * Instead each card text is inserted right after the message that was last when it first appeared, and stays there on every later
 * request, so requests only extend the cached prefix. A new card is recorded only when the text changes, plus one cleared card when
 * the state empties, so an old "running" card is never the latest word. Anchors are positions in the raw history (the shortenings map
 * messages one to one); after a compaction or anything else that moves them, the trail starts again at the end.
 */
export function createCardTrail() {
	let trail: { index: number; stamp: unknown; text: string }[] = [];
	let current: string | undefined;
	return {
		apply<T extends Message>(history: readonly T[], view: readonly T[], card: string | undefined): T[] | undefined {
			trail = trail.filter((entry) => entry.index < history.length && history[entry.index]?.timestamp === entry.stamp);
			if (!trail.length) current = undefined; // compacted or rewritten: nothing recorded survives
			if (card !== current) {
				const text = card ?? CLEARED_CARD;
				const last = history.length - 1;
				if (last >= 0 && (card !== undefined || current !== undefined)) trail.push({ index: last, stamp: history[last]?.timestamp, text });
				current = card;
			}
			if (!trail.length) return undefined;
			const out: T[] = [];
			let next = 0;
			view.forEach((message, i) => {
				out.push(message);
				for (; next < trail.length && trail[next].index === i; next++) out.push({ role: "custom", customType: STATE_CARD_TYPE, content: trail[next].text, display: false, timestamp: trail[next].stamp } as unknown as T);
			});
			return out;
		},
	};
}

/** Main session only in practice: leaves have no subagent tool, so their requests contain nothing to collapse. */
export function registerHandoffWindow(pi: Pick<ExtensionAPI, "on">, env: NodeJS.ProcessEnv = process.env, state?: () => string | undefined): number {
	const window = handoffWindowFromEnv(env);
	if (window === 0 && !state) return 0; // off and no state card: no handler, today's behavior exactly
	const trail = createCardTrail();
	pi.on("context", (event: { messages: Message[] }) => {
		const shortened = window > 0 ? shortenContext(event.messages, window) : undefined;
		let card: string | undefined;
		try { card = state?.(); } catch { card = undefined; }
		const withCards = state ? trail.apply(event.messages, shortened ?? event.messages, card) : undefined;
		const messages = withCards ?? shortened;
		return messages ? { messages } : undefined;
	});
	return window;
}
