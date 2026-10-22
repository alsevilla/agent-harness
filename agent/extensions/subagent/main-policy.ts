// Native main-session activation: the installed compact policy (agent/AGENTS.md) reaches the main session as one
// engineering_policy prompt section, with the absolute installed SKILL.md path. The live profile (no package root) stays silent.
import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const SECTION = "engineering_policy";

const posix = (file: string) => file.replace(/\\/g, "/");

/**
 * Section body for the installed policy, or undefined when the policy is already loaded verbatim as project context (no duplicate).
 * An unreadable or empty policy yields a transparent notice naming the path; the session still answers and the skill stays explicit.
 */
export function policyBody(root: string | null, contextFiles: Array<{ content: string }>): string | undefined {
	if (!root) return undefined;
	const file = path.join(root, "AGENTS.md");
	const notice = (reason: string) => `Engineering policy unavailable (${reason}): ${posix(file)}. Continue without it; load the harness explicitly with /skill:engineering-harness when routing is needed.`;
	let policy: string;
	try {
		policy = fs.readFileSync(file, "utf8").trim();
	} catch (error) {
		return notice((error as NodeJS.ErrnoException).code ?? "unreadable");
	}
	if (!policy) return notice("empty");
	if (contextFiles.some((entry) => entry.content.includes(policy))) return undefined;
	return [
		policy,
		"",
		`Installed harness skill (absolute): ${posix(path.join(root, "skills", "engineering-harness", "SKILL.md"))}`,
		`Where the policy names agent/skills/, use ${posix(root)}/skills/ instead.`,
	].join("\n");
}

/** `root` is the verified native package resource root (agents.ts packageRoot()); null in the live profile, which stays silent. */
export function registerMainPolicy(pi: ExtensionAPI, root: string | null): void {
	if (!root) return;
	pi.on("before_agent_start", (event) => {
		const body = policyBody(root, event.systemPromptOptions.contextFiles);
		if (body !== undefined) event.systemPromptOptions.sections[SECTION] = body;
	});
}
