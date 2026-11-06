// Stage 1 child-only guard. Loaded after pause-gate and decision-relay in every child (main never loads it).
// Reads PI_SAFETY_GRANTS once and removes it from the process environment before any tool can run; an invalid envelope blocks all tool calls.
import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { CHILD_GRANT_ENV, CHILD_GRANT_NOTE_ENV, CHILD_READONLY_ENV, createGrantStore, guardToolCall, loadChildCleanup, loadChildDelivery, loadChildGate, loadChildGrants, loadChildLeases, loadChildPushTarget } from "./safety-core.ts";
import { createReadDedupe } from "./read-dedupe.ts";
import { createExecutionLedger } from "./execution-ledger.ts";
import { createAutoFormat, loadFormatConfig } from "./auto-format.ts";
import { capShellOutput, outputCapFromEnv } from "./output-cap.ts";
import * as path from "node:path";
import { createLookupNudge, launchLookupTools } from "./lookup-nudge.ts";
import { capWorkerContext, workerMaskPolicy } from "./handoff-window.ts";

export default function safetyGuardEntry(pi: ExtensionAPI): void {
	const raw = process.env[CHILD_GRANT_ENV];
	delete process.env[CHILD_GRANT_ENV];
	// Read-only role or launch: the candidate root it may not change. Read once and removed, like the grant envelope.
	const readOnlyRoot = process.env[CHILD_READONLY_ENV] || undefined;
	delete process.env[CHILD_READONLY_ENV];
	// Why main's launch carried no approval although one was requested (advisory; appended to grantable refusals).
	const grantNote = process.env[CHILD_GRANT_NOTE_ENV] || undefined;
	delete process.env[CHILD_GRANT_NOTE_ENV];
	const store = createGrantStore();
	let invalid: string | undefined;
	let gateCommits = false;
	let pushTarget: ReturnType<typeof loadChildPushTarget>;
	try {
		if (raw) {
			store.importRecords(loadChildGrants(raw));
			store.importLeases(loadChildLeases(raw));
			store.importDelivery(loadChildDelivery(raw));
			store.importCleanup(loadChildCleanup(raw));
			gateCommits = loadChildGate(raw);
			pushTarget = loadChildPushTarget(raw);
		}
	} catch {
		invalid = "Blocked by harness safety guard: invalid child grant envelope; all tool calls refused.";
	}
	const reads = new Set<string>(); // files this worker has read in this run (read before edit)
	pi.on("tool_call", (event, ctx) => {
		if (invalid) return { block: true, reason: invalid };
		return guardToolCall({ scope: "child", store, agentDir: getAgentDir(), gateCommits, pushTarget, readOnlyRoot, reads, grantNote }, event.toolName, event.input as Record<string, unknown>, ctx.cwd);
	});
	// Workers only: a repeated read that returns unchanged text becomes a one-line note (read-dedupe.ts).
	const dedupe = createReadDedupe();
	// Workers only: threshold-triggered masking with budget fallbacks (handoff-window.ts, capWorkerContext). From a threshold that depends on
	// the model serving the request (workerMaskPolicy: 90k on Claude Haiku 5.5, 200k on Anthropic models without a long-request surcharge,
	// 80k otherwise), including the actual system prompt, the request is shortened step by step until it fits the budget; if it still does not,
	// the host is asked to compact once. Best effort, not a hard bound. A masked earlier copy can no longer be "used", so the
	// duplicate-read note is off for the rest of the run once anything is masked.
	// Workers only: the execution ledger (execution-ledger.ts, after Ledger, arXiv 2608.00808). PI_SUBAGENT_LEDGER=0 turns it off.
	const ledger = process.env.PI_SUBAGENT_LEDGER === "0" ? undefined : createExecutionLedger();
	let capped = false;
	let compactAsked = false;
	pi.on("context", (event: { messages: any[] }, ctx: any) => {
		// The task packet is the first user message ("Task: ..."); the ledger tracks the checks it names.
		try {
			const first = event.messages.find((m) => m?.role === "user");
			const text = typeof first?.content === "string" ? first.content : Array.isArray(first?.content) ? first.content.map((p: any) => p?.text ?? "").join("\n") : "";
			if (text) ledger?.noteTask(text);
		} catch { /* the view simply lists no packet checks */ }
		let base = 0;
		try { base = Math.ceil(String(ctx?.getSystemPrompt?.() ?? "").length / 4); } catch { base = 0; }
		// Per request, from the model serving it (a fallback attempt is a new worker on its own model): see workerMaskPolicy.
		let policy = workerMaskPolicy(undefined);
		try { policy = workerMaskPolicy(ctx?.model); } catch { /* the default policy */ }
		const result = capWorkerContext(event.messages, policy.from, policy.budget, base);
		if (result.step === "over" && !compactAsked) {
			compactAsked = true;
			try { ctx?.compact?.({ customInstructions: "Keep the task packet, its stop condition, files changed, checks run with their results, and open problems; drop old tool output." }); } catch { /* best effort */ }
		}
		if (result.messages && !capped) { capped = true; dedupe.reset(); ledger?.earlierCopiesGone(); }
		// Nothing is appended here: a message added to every request would hold Pi's cache breakpoint and change each time, so no cache
		// entry would ever match the next request. The ledger's view travels in a tool result instead (the last tool_result handler).
		return result.messages ? { messages: result.messages } : undefined;
	});
	// Registered before the duplicate-read handler, so the ledger records each read's own output (Pi chains tool_result handlers).
	pi.on("tool_result", (event, ctx) => {
		if (!ledger) return undefined;
		try {
			const content = ledger.onResult(event.toolName, event.input, event.content, event.isError === true, ctx.cwd);
			return content ? { content } : undefined;
		} catch { return undefined; }
	});
	// Workers only: format a file right after an edit, with commands from the user's profile format.json only (auto-format.ts).
	const autoFormat = createAutoFormat(loadFormatConfig(path.join(getAgentDir(), "format.json")));
	pi.on("tool_result", (event, ctx) => {
		try {
			const content = autoFormat.onResult(event.toolName, event.input, event.content, event.isError === true, ctx.cwd);
			return content ? { content } : undefined;
		} catch { return undefined; }
	});
	pi.on("tool_result", (event, ctx) => {
		if (capped) return undefined;
		const content = dedupe.onResult(event.toolName, event.input, event.content, event.isError === true, ctx.cwd);
		return content ? { content } : undefined;
	});
	pi.on("session_compact", () => { dedupe.reset(); ledger?.compacted(); capped = false; compactAsked = false; });
	// Workers only: the first broad grep/find of a run that has not used the Serena helper, QMD or the graph gets one line naming them (lookup-nudge.ts).
	// The tool set is read at the first result, after every extension has registered and activated its tools.
	let nudge: ReturnType<typeof createLookupNudge> | undefined;
	pi.on("tool_result", (event) => {
		try { nudge ??= createLookupNudge(launchLookupTools(pi.getActiveTools())); } catch { return undefined; }
		const content = nudge.onResult(event.toolName, event.input, event.content, event.isError === true);
		return content ? { content } : undefined;
	});
	// Workers only, last: a long shell output keeps its start and end, with the full text on disk (output-cap.ts). After the ledger,
	// which records the whole output first. Then the ledger's state view, when it changed and is due, goes at the end of this result:
	// stored in the history like the output, so every later request extends the cached prefix instead of replacing its last block.
	const outputCap = outputCapFromEnv();
	pi.on("tool_result", (event: any) => {
		try {
			const content = capShellOutput(event.toolName, event.content, event.details, outputCap);
			let view: string | undefined;
			try { view = ledger?.viewForResult(); } catch { view = undefined; }
			if (!view) return content ? { content } : undefined;
			return { content: [...(content ?? event.content ?? []), { type: "text", text: view }] };
		} catch { return undefined; }
	});
}
