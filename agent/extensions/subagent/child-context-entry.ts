// Child-only entry, loaded by an explicit --extension pair for eligible delegated roles (never the main session).
// Uses the public before_agent_start systemPromptOptions.contextFiles seam; any failure leaves the full context.
import * as path from "node:path";
import { type ExtensionAPI, getAgentDir } from "@earendil-works/pi-coding-agent";
import { compactChildContext } from "./child-context.ts";

export default function childContext(pi: ExtensionAPI): void {
	pi.on("before_agent_start", (event) => {
		try {
			compactChildContext(event.systemPromptOptions.contextFiles, path.join(getAgentDir(), "AGENTS.md"));
		} catch {
			/* fail open: full context */
		}
	});
}
