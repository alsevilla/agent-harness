// Stage 1 child-only guard. Loaded after pause-gate and decision-relay in every child (main never loads it).
// Reads PI_SAFETY_GRANTS once and removes it from the process environment before any tool can run; an invalid envelope blocks all tool calls.
import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { CHILD_GRANT_ENV, createGrantStore, guardToolCall, loadChildDelivery, loadChildGate, loadChildGrants, loadChildLeases } from "./safety-core.ts";

export default function safetyGuardEntry(pi: ExtensionAPI): void {
	const raw = process.env[CHILD_GRANT_ENV];
	delete process.env[CHILD_GRANT_ENV];
	const store = createGrantStore();
	let invalid: string | undefined;
	let gateCommits = false;
	try {
		if (raw) {
			store.importRecords(loadChildGrants(raw));
			store.importLeases(loadChildLeases(raw));
			store.importDelivery(loadChildDelivery(raw));
			gateCommits = loadChildGate(raw);
		}
	} catch {
		invalid = "Blocked by harness safety guard: invalid child grant envelope; all tool calls refused.";
	}
	pi.on("tool_call", (event, ctx) => {
		if (invalid) return { block: true, reason: invalid };
		return guardToolCall({ scope: "child", store, agentDir: getAgentDir(), gateCommits }, event.toolName, event.input as Record<string, unknown>, ctx.cwd);
	});
}
