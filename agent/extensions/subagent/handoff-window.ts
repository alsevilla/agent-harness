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

/** Main session only in practice: leaves have no subagent tool, so their requests contain nothing to collapse. */
export function registerHandoffWindow(pi: Pick<ExtensionAPI, "on">, env: NodeJS.ProcessEnv = process.env): number {
	const window = handoffWindowFromEnv(env);
	if (window === 0) return 0; // off: no handler, today's behavior exactly
	pi.on("context", (event: { messages: Message[] }) => {
		const messages = collapseHandoffs(event.messages, window);
		return messages ? { messages } : undefined;
	});
	return window;
}
