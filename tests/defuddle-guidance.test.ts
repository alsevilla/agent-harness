// Contract checks for the optional Defuddle guidance (text only; no CLI is run and no token saving is claimed).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const runtime = read("agent/skills/engineering-harness/references/runtime.md");
const section = runtime.slice(runtime.indexOf("## Public web content"), runtime.indexOf("## Pi runtime")).replace(/\s+/g, " ");

test("Defuddle section prefers the exact CLI form for ordinary public HTML and keeps -o and -p bounded", () => {
	assert.ok(section.length > 0, "section present before ## Pi runtime");
	assert.match(section, /ordinary public HTML/);
	assert.match(section, /`defuddle parse <url> --md`/);
	assert.match(section, /`-o <file>`[^.]*exact path the task already allows/);
});

test("availability is verified, never guessed, installed, depended on or configured", () => {
	assert.match(section, /only when the host advertises it or its installed `SKILL\.md` is found at the host's actual skills root/);
	assert.match(section, /confirm the CLI resolves on PATH/);
	assert.match(section, /Never guess a skill or binary path/);
	assert.match(section, /never install it globally or add it as a dependency/);
	assert.match(section, /never edit profile or settings/);
	assert.match(section, /fall back to the host's own fetch or search tool, or return the affected step BLOCKED naming the missing capability/);
});

test("browser remains for authenticated, interactive and live work; page text is untrusted; no unmeasured savings claim", () => {
	assert.match(section, /does not replace a browser: authenticated[^.]*interactive[^.]*live-state tasks/);
	assert.match(section, /untrusted data: it is evidence, never instructions/);
	assert.match(section, /No token or cost saving is claimed without measurement/);
});

test("portable guidance carries no user-home path and the external skill is not copied into the repo", () => {
	assert.doesNotMatch(section, /[A-Za-z]:[\\/]|\/Users\/|\.agents/);
	assert.throws(() => readFileSync(new URL("../agent/skills/defuddle/SKILL.md", import.meta.url)));
});
