// Text contract checks for the optional design-system-artifacts module; no UI quality is assessed.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";

const path = (p: string) => new URL(`../${p}`, import.meta.url);
const read = (p: string) => readFileSync(path(p), "utf8").replace(/\s+/g, " ");
const modulePath = "agent/skills/frontend/design-system-artifacts/index.md";

test("module exists as an index only, without a nested SKILL.md or scripts", () => {
	assert.ok(existsSync(path(modulePath)), "module index present");
	assert.ok(!existsSync(path("agent/skills/frontend/design-system-artifacts/SKILL.md")));
	assert.ok(!existsSync(path("agent/skills/frontend/design-system-artifacts/scripts")));
});

test("module defines the procedure, reuse and conditional modes", () => {
	const m = read(modulePath);
	assert.match(m, /^# design-system-artifacts/);
	assert.match(m, /existing tokens, components and brand/i);
	assert.match(m, /semantic colors/i);
	assert.match(m, /contrast/i);
	assert.match(m, /dark and light only when/i);
	assert.match(m, /compact, non-persisted design handoff/i);
});

test("persistence is explicit-path only and ownership is preserved", () => {
	const m = read(modulePath);
	assert.match(m, /DESIGN\.md or a page override only at a path named by the explicit task or accepted plan/);
	assert.match(m, /never a universal file gate/i);
	assert.match(m, /ui-ux-specialist owns material/);
	assert.match(m, /frontend-worker implements/);
	assert.match(m, /main owns assignment/i);
	assert.match(m, /leaves launch no helpers/i);
});

test("router entries point at the module with correct relative paths", () => {
	const skill = read("agent/skills/frontend/SKILL.md");
	assert.match(skill, /\| Optional design tokens\/theme\/design spec\/page override \| design-system-artifacts\/index\.md \|/);
	const routing = read("agent/skills/frontend/references/routing.md");
	assert.match(routing, /\| Tokens, theme, design spec or page override absent from accepted UI \| design-system-artifacts \| ui-ux-specialist for material choices; frontend-worker implements accepted tokens \|/);
	assert.ok(existsSync(path("agent/skills/frontend/" + "design-system-artifacts/index.md")));
});

test("module has no executable commands or network directives", () => {
	const m = read(modulePath);
	assert.doesNotMatch(m, /\b(npm|npx|curl|wget|pip|bun)\s/);
	assert.doesNotMatch(m, /https?:\/\//);
	assert.ok(m.length < 3200, "module stays compact");
});
