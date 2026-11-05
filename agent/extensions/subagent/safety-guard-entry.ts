// Stage 1 child-only guard. Loaded after pause-gate and decision-relay in every child (main never loads it).
// Reads PI_SAFETY_GRANTS once and removes it from the process environment before any tool can run; an invalid envelope blocks all tool calls.
import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { CHILD_GRANT_ENV, CHILD_READONLY_ENV, createGrantStore, guardToolCall, loadChildCleanup, loadChildDelivery, loadChildGate, loadChildGrants, loadChildLeases, loadChildPushTarget } from "./safety-core.ts";
import { createReadDedupe } from "./read-dedupe.ts";
import { createLookupNudge, launchLookupTools } from "./lookup-nudge.ts";
import { capWorkerContext, workerBudgetFromEnv, workerMaskFromEnv } from "./handoff-window.ts";

export default function safetyGuardEntry(pi: ExtensionAPI): void {
	const raw = process.env[CHILD_GRANT_ENV];
	delete process.env[CHILD_GRANT_ENV];
	// Read-only role or launch: the candidate root it may not change. Read once and removed, like the grant envelope.
	const readOnlyRoot = process.env[CHILD_READONLY_ENV] || undefined;
	delete process.env[CHILD_READONLY_ENV];
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
		return guardToolCall({ scope: "child", store, agentDir: getAgentDir(), gateCommits, pushTarget, readOnlyRoot, reads }, event.toolName, event.input as Record<string, unknown>, ctx.cwd);
	});
	// Workers only: a repeated read that returns unchanged text becomes a one-line note (read-dedupe.ts).
	const dedupe = createReadDedupe();
	// Workers only: threshold-triggered masking with budget fallbacks (handoff-window.ts, capWorkerContext). From ~80k estimated tokens,
	// including the actual system prompt, the request is shortened step by step until it fits the ~95k budget; if it still does not,
	// the host is asked to compact once. Best effort, not a hard bound. A masked earlier copy can no longer be "used", so the
	// duplicate-read note is off for the rest of the run once anything is masked.
	const capFrom = workerMaskFromEnv();
	const capBudget = workerBudgetFromEnv();
	let capped = false;
	let compactAsked = false;
	pi.on("context", (event: { messages: any[] }, ctx: any) => {
		let base = 0;
		try { base = Math.ceil(String(ctx?.getSystemPrompt?.() ?? "").length / 4); } catch { base = 0; }
		const result = capWorkerContext(event.messages, capFrom, capBudget, base);
		if (result.step === "over" && !compactAsked) {
			compactAsked = true;
			try { ctx?.compact?.({ customInstructions: "Keep the task packet, its stop condition, files changed, checks run with their results, and open problems; drop old tool output." }); } catch { /* best effort */ }
		}
		if (!result.messages) return undefined;
		if (!capped) { capped = true; dedupe.reset(); }
		return { messages: result.messages };
	});
	pi.on("tool_result", (event, ctx) => {
		if (capped) return undefined;
		const content = dedupe.onResult(event.toolName, event.input, event.content, event.isError === true, ctx.cwd);
		return content ? { content } : undefined;
	});
	pi.on("session_compact", () => { dedupe.reset(); capped = false; compactAsked = false; });
	// Workers only: the first broad grep/find of a run that has not used Serena, QMD or the graph gets one line naming them (lookup-nudge.ts).
	// The tool set is read at the first result, after every extension has registered and activated its tools.
	let nudge: ReturnType<typeof createLookupNudge> | undefined;
	pi.on("tool_result", (event) => {
		try { nudge ??= createLookupNudge(launchLookupTools(pi.getActiveTools())); } catch { return undefined; }
		const content = nudge.onResult(event.toolName, event.input, event.content, event.isError === true);
		return content ? { content } : undefined;
	});
}
