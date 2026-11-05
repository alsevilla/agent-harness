// Field report: workers never called the installed Serena, QMD or Graphify and searched with grep/find instead, although the tools were
// active (verified with Pi 1.5.0) and the lookup order (code-integrations.ts) asked for them first. On the first broad search of a run in
// which no lookup tool has been used yet, the search result gets one appended line naming the lookup tools this launch has. The search
// itself is never blocked, a named single file is not a broad search, and nothing is added once a lookup tool has been used.
// Second report: workers still made no Serena calls, because packets name the files and workers read them whole. When the serena
// skill is loaded and no lookup was used, the first whole read of a large source file gets one line pointing at its outline.

export interface LookupTools { serena: boolean; qmd: boolean; graph: boolean }

type Part = { type: string; text?: string };
const SHELL_BROAD = /(?:^|[\s;&|(])(?:rg|ripgrep)\b|\bgrep\s+(?:-[A-Za-z]*[rR][A-Za-z]*|--recursive)\b|\bfind\s+\S+[^|;&]*\s-i?name\b|\bSelect-String\b[^|;&]*-Recurse|\b(?:Get-ChildItem|gci|ls|dir)\b[^|;&]*\s-(?:Recurse|r)\b/i;
const SERENA_HELPER = /\bserena\.mjs\b/i;
const GRAPH_HELPER = /\bread_graph\.py\b|(?:^|[\s;&|])(?:[^\s;&|]*[\\/])?graphify(?:\.(?:exe|cmd|py))?(?=\s|$)/i;

/** Whether this call is a lookup through the Serena helper, QMD or the graph. */
export function isLookupCall(toolName: string, input: unknown): boolean {
	if (toolName.startsWith("qmd_") || toolName.startsWith("graphify_")) return true;
	const command = (input as { command?: unknown })?.command;
	return (toolName === "bash" || toolName === "powershell") && typeof command === "string" && (GRAPH_HELPER.test(command) || SERENA_HELPER.test(command));
}

/** Whether this call searches broadly: the find tool, grep over a folder, or a recursive shell search. A single named file is not. */
export function isBroadSearch(toolName: string, input: unknown): boolean {
	const args = (input ?? {}) as { path?: unknown; command?: unknown };
	if (toolName === "find") return true;
	if (toolName === "grep") return typeof args.path !== "string" || !/\.[A-Za-z0-9]{1,8}$/.test(args.path);
	if ((toolName === "bash" || toolName === "powershell") && typeof args.command === "string") return SHELL_BROAD.test(args.command);
	return false;
}

const CODE_FILE = /\.(?:rs|ts|tsx|js|jsx|mjs|cjs|py|go|java|kt|cs|cpp|cc|c|h|hpp|swift|rb|php|scala|vue|svelte)$/i;
/** Roughly 300 lines of source. */
export const LARGE_READ_CHARS = 12_000;

/** A read of a whole source file (no offset or limit) whose text is large. */
export function isLargeCodeRead(toolName: string, input: unknown, content: unknown): boolean {
	const args = (input ?? {}) as { path?: unknown; offset?: unknown; limit?: unknown };
	if (toolName !== "read" || typeof args.path !== "string" || !CODE_FILE.test(args.path) || args.offset !== undefined || args.limit !== undefined || !Array.isArray(content)) return false;
	return (content as Part[]).reduce((n, part) => n + (part?.type === "text" && typeof part.text === "string" ? part.text.length : 0), 0) >= LARGE_READ_CHARS;
}

export const LARGE_READ_NUDGE = "[harness] That was a whole read of a large source file. For the next one, run the Serena helper's outline first (see 'Code symbols through Serena' in your instructions), then read only the range you need.";

export function lookupNudgeText(tools: LookupTools): string {
	const named = [tools.graph ? "the graph (the graphify skill's read_graph.py helper, or the listed graph report)" : "", tools.qmd ? "qmd_search for prior decisions and specs" : "", tools.serena ? "Serena (the serena skill: outline, find, refs) for definitions and callers" : ""].filter(Boolean);
	return `[harness] This launch has ${named.join(", ")}, and none has been used yet. For code the packet does not locate, use them before broad grep or find; keep grep for literal text, config and renames.`;
}

export function createLookupNudge(tools: LookupTools) {
	let looked = false;
	let nudged = false;
	let largeNudged = false;
	const any = tools.serena || tools.qmd || tools.graph;
	return {
		/** Content with the one-line note appended to the first broad search's result, or undefined to keep the result as it is. */
		onResult(toolName: string, input: unknown, content: unknown, isError: boolean): Part[] | undefined {
			if (isLookupCall(toolName, input)) { looked = true; return undefined; }
			if (tools.serena && !looked && !largeNudged && !isError && isLargeCodeRead(toolName, input, content)) {
				largeNudged = true;
				return [...(content as Part[]), { type: "text", text: LARGE_READ_NUDGE }];
			}
			if (!any || looked || nudged || isError || !Array.isArray(content) || !isBroadSearch(toolName, input)) return undefined;
			nudged = true;
			return [...(content as Part[]), { type: "text", text: lookupNudgeText(tools) }];
		},
		get nudged() { return nudged; },
	};
}

/** Lookup tools this worker actually has: the serena and graphify skills or extension in the launch arguments, and active qmd_ tools. */
export function launchLookupTools(activeTools: readonly string[], argv: readonly string[] = process.argv): LookupTools {
	return {
		serena: argv.some((a) => /[\\/]serena[\\/]SKILL\.md$/i.test(a)),
		qmd: activeTools.some((t) => t.startsWith("qmd_")),
		graph: argv.some((a) => /[\\/]graphify[\\/]SKILL\.md$/i.test(a) || /[\\/]graphify-pi[\\/]/i.test(a)) || activeTools.some((t) => t.startsWith("graphify_")),
	};
}
