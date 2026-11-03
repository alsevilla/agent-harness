// Child-only entry, loaded by an explicit --extension pair only when a role budget is effective (never the main session).
// Public seams only: message_end/turn_end/session_compact/agent_settled events, the context transform on a request that is already being prepared,
// ctx.getContextUsage()/abort(), pi.appendEntry() and the cache/compaction decision events. No steer, sendMessage, triggerTurn or nextTurn: nothing here can wake the model.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { BudgetMachine, MARKER_TYPE, parseBudgetEnv, WARNING_TEXT } from "./role-budget.ts";

export default function roleBudgetEntry(pi: ExtensionAPI): void {
	// Throws on missing or malformed configuration: the extension fails to load and the child exits before RPC reads its prompt (never an uncapped run).
	const machine = new BudgetMachine(parseBudgetEnv(process.env));
	const warnStatus = () => (machine.warned ? "sent" : "not_delivered") as "sent" | "not_delivered";
	let notDeliveredLogged = false;

	pi.on("message_end", (event) => { machine.assistantEnd(event.message); });
	// Current context observation for the parent's coverage count (numeric only, appended entry: no request, no wake). Only when a context limit exists.
	const observe = () => { if (machine.tracksContext) pi.appendEntry(MARKER_TYPE, { v: 1, event: "context", tokens: machine.contextTokens, turns: machine.turns }); };
	pi.on("session_compact", () => { machine.compacted(); observe(); });
	pi.on("turn_end", (event, ctx) => {
		let tokens: unknown;
		try { tokens = ctx.getContextUsage()?.tokens; } catch { tokens = undefined; } // unknown, never 0
		machine.turnEnd(event, tokens);
		observe();
	});
	// The only place a limit stops work or a warning is delivered: a request is already being prepared, so this adds no request of its own.
	pi.on("context", (event, ctx) => {
		const action = machine.request();
		if (action === "exhaust") {
			pi.appendEntry(MARKER_TYPE, { v: 1, event: "exhausted", reason: machine.limit, turns: machine.turns, contextTokens: machine.contextTokens, warn80: warnStatus() });
			ctx.abort();
			return undefined;
		}
		if (action === "warn") {
			pi.appendEntry(MARKER_TYPE, { v: 1, event: "warn80", status: "sent", turns: machine.turns });
			// Request-only copy: every original message stays, the notice is appended last and is not part of the transcript.
			return { messages: [...event.messages, { role: "user", content: WARNING_TEXT, timestamp: Date.now() }] };
		}
		return undefined;
	});
	pi.on("agent_settled", () => {
		if (machine.warnPending && !machine.warned && !notDeliveredLogged) {
			notDeliveredLogged = true;
			pi.appendEntry(MARKER_TYPE, { v: 1, event: "warn80", status: "not_delivered", turns: machine.turns });
		}
	});
	// Once the limit is known, a summary or idle cache refresh would only add spend before the stop.
	pi.on("cache_warming_decision", () => (machine.stopping ? { action: "stop" as const } : undefined));
	pi.on("session_before_compact", () => (machine.stopping ? { cancel: true } : undefined));
}
