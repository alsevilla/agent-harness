// Essential rules only. Prompt and doc wording is free to change; these checks fail only when a rule that protects the user
// (no helper launches from leaves, one writer, delivery and merge gates, worker retry) disappears from the text agents read.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import test from "node:test";

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8").replace(/\r\n/g, "\n");
const flat = (text: string) => text.replace(/\s+/g, " ");
const roles = readdirSync(new URL("../agent/agents/", import.meta.url)).filter((f) => f.endsWith(".md")).map((f) => f.slice(0, -3)).sort();

test("main policy keeps its never-rules and stays short", () => {
	const policy = read("agent/AGENTS.md");
	const text = flat(policy);
	for (const rule of [
		"Leaves never launch helpers",
		"One writer owns each candidate",
		"Never launch delivery before every required check has passed on the exact candidate",
		"Merge needs its own explicit approval naming the exact PR and the approved candidate HEAD SHA",
		"Do not weaken valid tests",
		"never accept PASS from a digest",
		"Act once you know enough: never re-derive established facts or re-open the user's decisions",
	]) assert.ok(text.includes(rule), rule);
	assert.ok(policy.length <= 6500, `AGENTS.md is ${policy.length} chars; it is read on every main turn`);
});

test("every role keeps the leaf boundary and states it once", () => {
	assert.equal(roles.length, 21);
	for (const role of roles) {
		const text = read(`agent/agents/${role}.md`);
		assert.match(text, /Never launch\/delegate\/supervise helpers/, role);
		assert.match(text, /this leaf has no subagent tool/, role);
		assert.match(text, /Do not use shell commands to launch Pi or other agents/, role);
		for (const restated of ["Never spawn another agent.", "Never spawn helpers."]) assert.ok(!text.includes(restated), `${role}: restates "${restated}"`);
	}
});

test("every code worker fixes a failing focused check in the same run, at most twice", () => {
	const rule = "When a focused check fails after your edit, fix it in this run (at most 2 tries) before returning; if it still fails, return the failed command, an output excerpt, the changed files and your intended fix.";
	for (const role of ["frontend-worker", "backend-worker", "database-worker", "general-worker"]) assert.equal(read(`agent/agents/${role}.md`).split(rule).length, 2, role);
});

// Phase 4: every role lists the five shared sections in this order. release-engineer keeps its delivery/SHIP/LEARN layout (its merge and
// release shapes moved to ship/merge-release.md instead).
const FIVE_SECTION_ROLES = roles.filter((role) => role !== "release-engineer");
test("restructured roles use the five shared sections in order", () => {
	const five = ["Knows/loads", "Before starting", "Workflow", "Where to look", "Common failures"];
	for (const role of FIVE_SECTION_ROLES) {
		const heads = [...read(`agent/agents/${role}.md`).matchAll(/^## (.*)$/gm)].map((m) => m[1]);
		assert.deepEqual(heads.filter((h) => five.includes(h)), five, role);
	}
});

test("release-engineer cleanup never forces a worktree removal in routine mode", () => {
	const text = read("agent/agents/release-engineer.md");
	assert.match(text, /git worktree remove/);
	assert.match(text, /(?:without|no)\s+`?--force`?/);
});
