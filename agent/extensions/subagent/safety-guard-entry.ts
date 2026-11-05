// Stage 1 child-only guard. Loaded after pause-gate and decision-relay in every child (main never loads it).
// Reads PI_SAFETY_GRANTS once and removes it from the process environment before any tool can run; an invalid envelope blocks all tool calls.
import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { CHILD_GRANT_ENV, CHILD_READONLY_ENV, createGrantStore, guardToolCall, loadChildCleanup, loadChildDelivery, loadChildGate, loadChildGrants, loadChildLeases, loadChildPushTarget } from "./safety-core.ts";
import { createReadDedupe } from "./read-dedupe.ts";
import { capWorkerContext, workerMaskFromEnv } from "./handoff-window.ts";

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
	// Workers only: past ~80k estimated tokens, older large tool outputs are masked so requests stay under Haiku's 100k price line.
	// A masked earlier copy can no longer be "used", so the duplicate-read note is off for the rest of the run once masking engages.
	const capFrom = workerMaskFromEnv();
	let capped = false;
	pi.on("context", (event: { messages: any[] }) => {
		const messages = capWorkerContext(event.messages, capFrom);
		if (!messages) return undefined;
		if (!capped) { capped = true; dedupe.reset(); }
		return { messages };
	});
	pi.on("tool_result", (event, ctx) => {
		if (capped) return undefined;
		const content = dedupe.onResult(event.toolName, event.input, event.content, event.isError === true, ctx.cwd);
		return content ? { content } : undefined;
	});
	pi.on("session_compact", () => { dedupe.reset(); capped = false; });
}
