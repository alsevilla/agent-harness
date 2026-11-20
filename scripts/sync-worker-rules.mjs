#!/usr/bin/env node
// Copies agent/shared/worker-rules.md into the marked block of every implementation worker. The block stays inside each role
// file because the Copilot plugin loads agent/agents/*.md directly, without Pi's shared child guidance.
// Run: npm run sync:worker-rules   (tests/policy-essentials.test.ts fails while any copy differs)
import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export const WORKERS = ["backend-worker", "database-worker", "frontend-worker", "general-worker", "platform-worker"];
export const START = "<!-- shared:worker-rules -->"; // source: agent/shared/worker-rules.md
export const END = "<!-- /shared:worker-rules -->";
const root = new URL("../", import.meta.url);

export function withRules(text, rules) {
	const a = text.indexOf(START), b = text.indexOf(END);
	if (a < 0 || b < a) throw new Error("worker-rules markers missing or out of order");
	return text.slice(0, a + START.length) + "\n" + rules.trimEnd() + "\n" + text.slice(b);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	const rules = readFileSync(new URL("agent/shared/worker-rules.md", root), "utf8");
	for (const name of WORKERS) {
		const file = new URL(`agent/agents/${name}.md`, root);
		const before = readFileSync(file, "utf8");
		const after = withRules(before, rules);
		if (after !== before) { writeFileSync(file, after); console.log(`updated ${name}`); }
	}
}
