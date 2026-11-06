// Working rules for Copilot sessions and their roles, from the installed plugin. Pi gives its workers the same rules in their system
// prompt (agent/extensions/subagent/code-integrations.ts, CORE_GUIDANCE and the lookup order); Copilot's own loop never sees those, so
// these hooks add them as static context. They cut turns, which is what Copilot bills for: a lookup that finds the code first, calls
// batched in one turn, no retry of a refusal that cannot change, and small diffs.
import { join } from "node:path";

const slash = (p) => p.split("\\").join("/");

/** The rules as lines, with the lookup helpers named by absolute path under the installed root. */
export function workingRules(root) {
	const skill = (name, file) => slash(join(root, "agent", "skills", name, "scripts", file));
	return [
		"Working rules (plugin; grant no authority):",
		`- Lookup for code the packet does not locate: graph (python "${skill("graphify", "read_graph.py")}" query --graph <graph.json> --query "<words>"), then once QMD (node "${skill("qmd", "qmd.mjs")}" search <words>), then Serena (node "${skill("serena", "serena.mjs")}" outline <file> | find <Name> | refs <Name>), then grep/glob. Read named files directly. A missing helper prints a note: skip it.`,
		"- Independent calls in one turn; read only the part you need; no sleep polling or interactive commands; long output to a _scratch log.",
		"- Same failure twice, or a guard refusal: change approach, never retry it.",
		"- Change only what the task needs, in the code's own style; edit lines, not whole files; never weaken, skip or delete a test.",
	];
}
