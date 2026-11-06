// Every dedicated /subagent command is documented: a row in the README's command table, a mention in the subagent README, and a word
// in the in-app help line (fold and trace were each missing from one of these after they shipped).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), "utf8");
const COMMANDS = ["trace", "changes", "fold", "usage", "roles", "create"];

test("each dedicated /subagent command has a README table row, a subagent README mention and a place in the help line", () => {
	const readme = read("../../../../README.md");
	const sub = read("../README.md");
	const index = read("../index.ts");
	const help = /Use \/subagent steer[^"]*/.exec(index)?.[0] ?? "";
	assert.ok(help, "the help line exists");
	for (const cmd of COMMANDS) {
		assert.match(readme, new RegExp(`^\\| \`/subagent ${cmd}\\b`, "m"), `README table: /subagent ${cmd}`);
		assert.match(sub, new RegExp(`/subagent ${cmd}\\b`), `subagent README: /subagent ${cmd}`);
		assert.match(help, new RegExp(`\\b${cmd}\\b`), `help line: ${cmd}`);
	}
});
