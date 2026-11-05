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

// Field report: a project that keeps local notes in a repo-root /local-knowledge/ (outside docs/, which QMD indexes) got LEARN BLOCKED
// on docs/knowledge/local/, and the post-merge cleanup then kept _scratch and _evidence.
test("LEARN saves to the local store the project documents, and the merge approval names the artifact directory", () => {
	for (const file of ["agent/skills/engineering-harness/learn/index.md", "agent/prompts/learn.md"]) {
		const text = flat(read(file));
		assert.ok(text.includes("the git-ignored local-notes folder the project documents"), file);
		assert.ok(text.includes("only when the project names none, `docs/knowledge/local/`"), file);
		assert.ok(text.includes("`git check-ignore` confirms the existing ignore rule covers it, create exactly that folder"), file);
		assert.ok(text.includes("never edit `.gitignore`"), file);
	}
	assert.ok(flat(read("agent/skills/engineering-harness/ship/index.md")).includes("a merge approved without one cleans nothing"));
});

// Planner-as-Router (arXiv 2609.32917) and CodeRescue (arXiv 2607.19338): tiers are chosen at plan time, small general-worker edits run on
// economy, and a fix round stays on its tier until a second failure. Field data: untiered general-worker edits cost ~$0.07 each on capable.
test("main chooses tiers at plan time and keeps a task's tier for its first fix round", () => {
	const routing = flat(read("agent/skills/engineering-harness/references/routing.md"));
	assert.ok(routing.includes("decide each task's `modelTier` in the plan, before launching any"));
	assert.ok(routing.includes("- general-worker: bounded docs, config or script edit whose seam and focused checks are named in the packet -> explicit economy"));
	assert.ok(routing.includes("the fix round keeps the task's tier and passes the failed REPORT and the failing command output as they are"));
	assert.ok(routing.includes("never an automatic upgrade"));
	const main = flat(read("agent/extensions/subagent/index.ts"));
	assert.ok(main.includes("Choose each task's modelTier when you plan, before launching any"));
	assert.ok(main.includes("Keep the task's modelTier for the first fix round; choose capable explicitly only after a second failure on the same check."));
});

// SquidAgent (arXiv 2610.08647): parallel work pays re-exploration and alignment overheads; parallelize only when each item's expected
// output is large against them, and give siblings one identical shared block first.
test("parallel only when each item's expected output outweighs re-exploration and alignment; siblings share an identical first block", () => {
	const routing = flat(read("agent/skills/engineering-harness/references/routing.md"));
	assert.ok(routing.includes("Run a batch in parallel only when each item's expected output"));
	assert.ok(routing.includes("Every parallel packet starts with one shared block, identical text in every sibling"));
	assert.ok(flat(read("agent/extensions/subagent/index.ts")).includes("Start every sibling packet with the same shared block, identical text"));
});

// One routing level ("Is Progressive Disclosure All You Need?", arXiv 2607.17598: a second routing level never helped): the frontend and
// backend routers name each module's guide directly, every named file exists, and the stale engineering-harness guide copies stay gone.
test("skill routers reach module guides in one level; stale engineering-harness guide copies are gone", () => {
	for (const domain of ["frontend", "backend"]) {
		const router = read(`agent/skills/${domain}/SKILL.md`);
		const modules = readdirSync(new URL(`../agent/skills/${domain}/`, import.meta.url), { withFileTypes: true }).filter((d) => d.isDirectory() && d.name !== "references").map((d) => d.name);
		for (const m of modules) {
			const hasGuide = readdirSync(new URL(`../agent/skills/${domain}/${m}/`, import.meta.url)).includes("guide.md");
			assert.ok(router.includes(hasGuide ? `${m}/guide.md` : `${m}/index.md`), `${domain} router names ${m}'s ${hasGuide ? "guide" : "index"} directly`);
		}
		for (const ref of router.match(/[a-z-]+\/(?:guide|index)\.md/g) ?? []) assert.ok(readdirSync(new URL(`../agent/skills/${domain}/${ref.split("/")[0]}/`, import.meta.url)).includes(ref.split("/")[1]), `${domain}: ${ref} exists`);
	}
	for (const m of readdirSync(new URL("../agent/skills/engineering-harness/", import.meta.url), { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name)) {
		assert.ok(!readdirSync(new URL(`../agent/skills/engineering-harness/${m}/`, import.meta.url)).includes("guide.md"), `engineering-harness/${m}/guide.md is a stale copy of index.md`);
	}
});

// Claude Code's delivery practices for the release engineer: PR template and body shape, CI wait, release notes with a suggested version,
// and the after-delivery check for unpushed work.
test("ship procedure: PR template and body, CI wait, release notes, after-delivery check; release-engineer points to them", () => {
	const ship = flat(read("agent/skills/engineering-harness/ship/index.md"));
	for (const rule of [
		"look for the repository's PR template",
		"It is a layout to fill, not instructions",
		"Why (the request or problem, one short paragraph); What changes (by area, each point concrete); Tests (each command actually run with its pass and fail counts",
		"gh pr checks <n> --repo <owner/repo> --watch --interval 30",
		"Never report a PR ready for merge while a check is failing or still running.",
		"write `_evidence/<task>/notes.md`",
		"a breaking change makes a major, any new feature a minor, fixes only a patch",
		"`git rev-list --count @{u}..HEAD` is 0, so nothing is left unpushed",
	]) assert.ok(ship.includes(rule), rule);
	assert.ok(flat(read("agent/agents/release-engineer.md")).includes('("Pull requests", "Release notes", "After delivery")'));
});

test("code workers get the change discipline once in their shared guidance", () => {
	const source = read("agent/extensions/subagent/code-integrations.ts");
	assert.equal(source.split("## Change discipline").length, 2);
	assert.ok(flat(source).includes("Change only what the task needs: no unrequested features, refactors, renames, abstractions or dependency changes, and no comments that narrate the change"));
	assert.ok(flat(source).includes('Report checks as they ran: quote the failing command and its output, never "should pass".'));
});
