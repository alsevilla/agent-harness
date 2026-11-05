// Field report: workers never called the installed Serena, QMD or Graphify and searched with grep/find instead, although the tools were
// active (verified with Pi 1.5.0) and the lookup order (code-integrations.ts) asked for them first. On the first broad search of a run in
// which no lookup tool has been used yet, the search result gets one appended line naming the lookup tools this launch has. The search
// itself is never blocked, a named single file is not a broad search, and nothing is added once a lookup tool has been used.

export interface LookupTools { serena: boolean; qmd: boolean; graph: boolean }

type Part = { type: string; text?: string };
const SHELL_BROAD = /(?:^|[\s;&|(])(?:rg|ripgrep)\b|\bgrep\s+(?:-[A-Za-z]*[rR][A-Za-z]*|--recursive)\b|\bfind\s+\S+[^|;&]*\s-i?name\b|\bSelect-String\b[^|;&]*-Recurse|\b(?:Get-ChildItem|gci|ls|dir)\b[^|;&]*\s-(?:Recurse|r)\b/i;
const GRAPH_HELPER = /\bread_graph\.py\b|(?:^|[\s;&|])(?:[^\s;&|]*[\\/])?graphify(?:\.(?:exe|cmd|py))?(?=\s|$)/i;

/** Whether this call is a lookup through Serena, QMD or the graph. */
export function isLookupCall(toolName: string, input: unknown): boolean {
	if (toolName.startsWith("serena_") || toolName.startsWith("qmd_") || toolName.startsWith("graphify_")) return true;
	const command = (input as { command?: unknown })?.command;
	return (toolName === "bash" || toolName === "powershell") && typeof command === "string" && GRAPH_HELPER.test(command);
}

/** Whether this call searches broadly: the find tool, grep over a folder, or a recursive shell search. A single named file is not. */
export function isBroadSearch(toolName: string, input: unknown): boolean {
	const args = (input ?? {}) as { path?: unknown; command?: unknown };
	if (toolName === "find") return true;
	if (toolName === "grep") return typeof args.path !== "string" || !/\.[A-Za-z0-9]{1,8}$/.test(args.path);
	if ((toolName === "bash" || toolName === "powershell") && typeof args.command === "string") return SHELL_BROAD.test(args.command);
	return false;
}

export function lookupNudgeText(tools: LookupTools): string {
	const named = [tools.graph ? "the graph (the graphify skill's read_graph.py helper, or the listed graph report)" : "", tools.qmd ? "qmd_search for prior decisions and specs" : "", tools.serena ? "Serena (find symbol, symbols overview, references) for definitions and callers" : ""].filter(Boolean);
	return `[harness] This launch has ${named.join(", ")}, and none has been used yet. For code the packet does not locate, use them before broad grep or find; keep grep for literal text, config and renames.`;
}

export function createLookupNudge(tools: LookupTools) {
	let looked = false;
	let nudged = false;
	const any = tools.serena || tools.qmd || tools.graph;
	return {
		/** Content with the one-line note appended to the first broad search's result, or undefined to keep the result as it is. */
		onResult(toolName: string, input: unknown, content: unknown, isError: boolean): Part[] | undefined {
			if (isLookupCall(toolName, input)) { looked = true; return undefined; }
			if (!any || looked || nudged || isError || !Array.isArray(content) || !isBroadSearch(toolName, input)) return undefined;
			nudged = true;
			return [...(content as Part[]), { type: "text", text: lookupNudgeText(tools) }];
		},
		get nudged() { return nudged; },
	};
}

/** Lookup tools this worker actually has: active serena_/qmd_ tools, and the graphify skill or extension in the launch arguments. */
export function launchLookupTools(activeTools: readonly string[], argv: readonly string[] = process.argv): LookupTools {
	return {
		serena: activeTools.some((t) => t.startsWith("serena_")),
		qmd: activeTools.some((t) => t.startsWith("qmd_")),
		graph: argv.some((a) => /[\\/]graphify[\\/]SKILL\.md$/i.test(a) || /[\\/]graphify-pi[\\/]/i.test(a)) || activeTools.some((t) => t.startsWith("graphify_")),
	};
}
