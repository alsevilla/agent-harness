// /learn prompt contract (static): the exported prompt resolves the installed engineering-harness module from the advertised SKILL.md path,
// dedupes via bounded QMD or file-search fallback, and dispatches release-engineer with explicit destination authority.
// Static checks only; they do not prove a live save, a live QMD query or a live subagent run.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "bun:test";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "../../../..");
const read = (rel: string) => fs.readFileSync(path.join(REPO, rel), "utf8");

test("package.json exports only the learn prompt template", () => {
	const manifest = JSON.parse(read("package.json"));
	assert.deepEqual(manifest.pi.prompts, ["./agent/prompts/learn.md"]);
	assert.ok(fs.existsSync(path.join(REPO, "agent/prompts/learn.md")));
});

test("learn prompt resolves the advertised engineering-harness SKILL.md and loads learn/index.md", () => {
	const prompt = read("agent/prompts/learn.md");
	assert.match(prompt, /^---\r?\ndescription: .+\r?\n---/);
	assert.match(prompt, /advertised/i);
	assert.match(prompt, /engineering-harness[\s\S]*SKILL\.md/);
	assert.match(prompt, /learn\/index\.md/);
	assert.match(prompt, /\$ARGUMENTS/);
	assert.doesNotMatch(prompt, /~\/\.pi\/agent\/skills/, "no hardcoded home-directory skill path");
});

test("learn prompt names the three outcomes and forbids unverified SAVED", () => {
	const prompt = read("agent/prompts/learn.md");
	for (const outcome of ["SAVED", "NO LESSON", "BLOCKED"]) assert.match(prompt, new RegExp(outcome));
	assert.match(prompt, /verif[\s\S]*destination[\s\S]*SAVED|SAVED[\s\S]*only after[\s\S]*verif/i);
});

test("learn prompt dedupes with bounded QMD or a file-search fallback, without refreshing the index", () => {
	const prompt = read("agent/prompts/learn.md");
	assert.match(prompt, /qmd_search/);
	assert.match(prompt, /maxResults[\s\S]{0,40}(<=|at most)\s*5|at most 5/);
	assert.match(prompt, /knowledge-general/);
	assert.match(prompt, /knowledge-harness/);
	assert.match(prompt, /fallback/i);
	assert.match(prompt, /no automatic QMD refresh|does not refresh|not refresh/i);
});

test("learn prompt dispatches release-engineer with absolute module path and explicit scope", () => {
	const prompt = read("agent/prompts/learn.md");
	assert.match(prompt, /subagent/);
	assert.match(prompt, /release-engineer/);
	assert.match(prompt, /background:\s*false|background: false/);
	for (const field of ["candidate", "evidence", "destination", "scope", "checks"]) assert.match(prompt, new RegExp(field));
	assert.match(prompt, /absolute/i);
	assert.match(prompt, /new (document|doc)[\s\S]{0,80}explicit/i);
});

test("learn module records the knowledge fields and authority rules from docs/knowledge/README.md", () => {
	const mod = read("agent/skills/engineering-harness/learn/index.md");
	for (const field of ["Title", "claim", "Source", "Evidence status", "Context and date", "Revalidate when"]) assert.match(mod, new RegExp(field));
	assert.match(mod, /docs\/knowledge\/README\.md/);
	assert.match(mod, /explicit[\s\S]{0,60}destination/i);
	assert.match(mod, /new document[\s\S]{0,80}explicit/i);
	assert.match(mod, /QMD[\s\S]{0,80}(not|never)[\s\S]{0,40}authority/i);
});

test("release-engineer LEARN path resolution uses the packet's absolute module path", () => {
	const role = read("agent/agents/release-engineer.md");
	assert.match(role, /LEARN[\s\S]{0,200}absolute[\s\S]{0,120}(packet|module path)/i);
});

test("README reconciles no-prompts claims for learn only", () => {
	const readme = read("README.md");
	assert.match(readme, /exports one prompt template, `\/learn`/);
	assert.match(readme, /other workflow and domain prompts[\s\S]{0,80}manual/i);
});

test("learn module defines the three-distinct-incident trigger with a confirmed shared root cause and REPORT evidence", () => {
	const mod = read("agent/skills/engineering-harness/learn/index.md");
	assert.match(mod, /three distinct completed incidents/i);
	assert.match(mod, /sharing a confirmed root cause/i);
	assert.match(mod, /completed Debug, Verify or worker REPORTs?/i);
	assert.match(mod, /Retries or attempts of the same task are one incident/i);
	assert.match(mod, /Similar error symptoms alone do not establish recurrence/i);
	assert.match(mod, /prompts main to (review|trigger) a LEARN review|trigger main LEARN review/i);
});

test("three-incident trigger is evidence-driven: no history scan, counter, ledger or background pipeline; three is not a minimum", () => {
	const mod = read("agent/skills/engineering-harness/learn/index.md");
	assert.match(mod, /no mandatory history scan/i);
	assert.match(mod, /already relevant to the current work/i);
	assert.match(mod, /no counter, ledger/i);
	assert.match(mod, /background pipeline/i);
	assert.match(mod, /not a minimum/i);
	assert.match(mod, /security or data-loss lesson/i);
	assert.match(mod, /correction was requested at least twice/i, "distinct correction-twice trigger preserved");
});

test("LEARN reviews verify evidence, updates the canonical record, stays selective and never substitutes for a root-cause fix", () => {
	const mod = read("agent/skills/engineering-harness/learn/index.md");
	assert.match(mod, /review the Verify evidence and root cause/i);
	assert.match(mod, /update the canonical (existing )?(record|lesson)[\s\S]{0,80}not (add|create) a duplicate/i);
	assert.match(mod, /Retrieve selectively/i);
	assert.match(mod, /revalidat/i);
	assert.match(mod, /never substitutes? for (a |the )?root-cause fix or (a )?regression test/i);
	assert.match(mod, /Saving remains an explicitly authorized release-engineer action/i);
	assert.match(mod, /main verifies the actual destination content/i);
});

test("knowledge storage: one small focused record per lesson, README as link index, exact record and index authority, readback before SAVED", () => {
	const mod = read("agent/skills/engineering-harness/learn/index.md");
	const readme = read("docs/knowledge/README.md");
	const prompt = read("agent/prompts/learn.md");
	assert.match(mod, /one small focused Markdown record/i);
	assert.match(mod, /docs\/knowledge\/harness\/<descriptive-slug>\.md/);
	assert.match(mod, /link index/i);
	assert.match(mod, /not the default prose bucket/i);
	assert.match(mod, /exact new record path[\s\S]{0,120}index path[\s\S]{0,120}mutation authority/i);
	assert.match(mod, /SAVED[\s\S]{0,80}only after[\s\S]{0,120}readback/i);
	assert.match(mod, /QMD[\s\S]{0,80}separate/i);
	assert.match(mod, /no transcripts?/i);
	assert.match(mod, /no automatic counters?/i);
	assert.match(readme, /link index/i);
	assert.match(readme, /one small focused/i);
	assert.match(readme, /Record fields/i);
	assert.match(prompt, /small focused record/i);
	assert.match(prompt, /record path/i);
	assert.match(prompt, /index path/i);
	assert.match(prompt, /readback/i);
});

test("dedupe updates the existing focused canonical record for the same or refined claim instead of adding a second record", () => {
	const mod = read("agent/skills/engineering-harness/learn/index.md");
	assert.match(mod, /same or refined claim[\s\S]{0,160}update the canonical record/i);
});

test("release-engineer write is limited to named knowledge or release artifacts and is never a shell or product bypass", () => {
	const role = read("agent/agents/release-engineer.md");
	assert.match(role, /`write`[\s\S]{0,120}new files? only/i);
	assert.match(role, /explicitly named[\s\S]{0,120}(knowledge|release)/i);
	assert.match(role, /shell (redirection|heredoc)[^\n]*not a bypass/i);
	assert.match(role, /normal guards still apply/i);
});

const CANONICAL_LEARN_FILES = ["agent/agents/release-engineer.md", "agent/skills/engineering-harness/ship/index.md", "agent/skills/engineering-harness/worktree/index.md", "agent/skills/engineering-harness/learn/index.md"];

test("LEARN runs before the final commit or PR; the old after-merge order is absent from every canonical copy", () => {
	for (const rel of [...CANONICAL_LEARN_FILES, "agent/prompts/learn.md", "agent/AGENTS.md"]) {
		assert.doesNotMatch(read(rel), /After successful merge and task-owned artifact disposition/, `${rel}: old after-merge LEARN order`);
	}
	for (const rel of CANONICAL_LEARN_FILES) assert.match(read(rel), /Before the final commit or PR/, `${rel}: LEARN before final commit or PR`);
	assert.match(read("agent/AGENTS.md"), /LEARN[^\n]{0,200}before the final commit or PR/);
	assert.match(read("agent/prompts/learn.md"), /before the final commit or PR/);
});

test("release-engineer assigned LEARN module applies before the final commit or PR, not after delivery", () => {
	const role = read("agent/agents/release-engineer.md");
	assert.match(role, /For LEARN work before the final commit or PR/);
	assert.doesNotMatch(role, /For LEARN work after delivery/);
});

test("LOCAL-ONLY default: LEARN saves only to the explicitly selected primary's existing ignored docs/knowledge/local/ store", () => {
	const mod = read("agent/skills/engineering-harness/learn/index.md");
	const prompt = read("agent/prompts/learn.md");
	const role = read("agent/agents/release-engineer.md");
	for (const text of [mod, prompt, role]) assert.match(text, /LOCAL-ONLY/, "LOCAL-ONLY default named");
	for (const text of [mod, prompt]) {
		assert.match(text, /docs\/knowledge\/local\//);
		assert.match(text, /explicitly selected primary/i);
		assert.match(text, /Do not assume a profile path/i);
		assert.match(text, /never edit `\.gitignore`/i);
	}
	assert.match(mod, /missing[^\n]{0,160}BLOCKED/i, "missing destination is BLOCKED");
	assert.match(role, /LOCAL-ONLY[^\n]{0,200}docs\/knowledge\/local\//);
});

test("a LOCAL record sits outside every packet candidate, _evidence and _scratch deletion target", () => {
	assert.match(read("agent/skills/engineering-harness/learn/index.md"), /outside all three packet deletion targets \(candidate, `_evidence` and `_scratch`\), so it survives their cleanup/);
	assert.match(read("agent/skills/engineering-harness/worktree/index.md"), /SAVED \(local:[^)]*outside all three deletion targets\)/);
	assert.match(read("agent/skills/engineering-harness/worktree/index.md"), /A destination inside any of the three deletion targets is not durable/);
	assert.match(read("agent/agents/release-engineer.md"), /outside every cleanup target/);
});

test("universal Git tracking, commit/PR-set and remote-integration requirements are removed from canonical LEARN, cleanup and knowledge text", () => {
	const files = [...CANONICAL_LEARN_FILES, "agent/prompts/learn.md", "agent/AGENTS.md", "agent/skills/engineering-harness/knowledge/index.md"];
	const forbidden = [/must not be git-ignored/, /not git-ignored/, /reports no match/, /named in the commit\/PR set/, /become Git-tracked/, /untracked until that commit exists/, /Git-tracked and not ignored/, /included in the same PR/, /waits for SAVED with verified remote integration/, /remote verification of the record and index/, /local SAVED[^.\n]{0,80}never sufficient/, /authorized follow-up PR before cleanup/];
	for (const rel of files) for (const pattern of forbidden) assert.doesNotMatch(read(rel), pattern, `${rel}: ${pattern}`);
});

test("shared publication is separate explicit authority, not a default completion gate", () => {
	for (const rel of ["agent/skills/engineering-harness/learn/index.md", "agent/AGENTS.md", "agent/skills/engineering-harness/worktree/index.md"]) {
		assert.match(read(rel), /Shared publication is separate explicit authority, not a default completion gate/, rel);
	}
});

test("local ignore policy: docs/knowledge/local/ stays in the existing .gitignore, is checked read-only and is never edited by LEARN", () => {
	assert.match(read(".gitignore"), /^docs\/knowledge\/local\/\r?$/m);
	assert.equal(spawnSync("git", ["check-ignore", "-q", "docs/knowledge/local/probe.md"], { cwd: REPO }).status, 0, "local notes stay ignored");
	assert.equal(spawnSync("git", ["check-ignore", "-q", "docs/knowledge/private/probe.md"], { cwd: REPO }).status, 0, "private notes stay ignored");
	assert.match(read("agent/skills/engineering-harness/learn/index.md"), /git check-ignore/);
});

test("KNOWLEDGE: QMD is optional prior evidence; ignored unindexed local notes get a bounded targeted read; nothing is indexed, embedded or refreshed", () => {
	const knowledge = read("agent/skills/engineering-harness/knowledge/index.md");
	assert.match(knowledge, /QMD is optional/);
	assert.match(knowledge, /docs\/knowledge\/local\//);
	assert.match(knowledge, /bounded/i);
	assert.match(knowledge, /unindexed/i);
	assert.match(knowledge, /do not index, embed or refresh/i);
});

test("saving grants no implicit staging, commit, push, publication or QMD index or refresh", () => {
	for (const rel of ["agent/skills/engineering-harness/learn/index.md", "agent/agents/release-engineer.md", "agent/prompts/learn.md"]) {
		assert.match(read(rel), /no implicit staging, commit, push, publication or QMD index or refresh/i, rel);
	}
});

test("LEARN module: SAVED is local file plus readback only; a late lesson may be saved locally outside targets; a shared copy needs a follow-up PR; a post-merge BLOCKED never rolls back the merge", () => {
	const mod = read("agent/skills/engineering-harness/learn/index.md");
	assert.match(mod, /SAVED means the file and readback exist; it is not proof of remote commit, merge or publication/);
	assert.match(mod, /may be saved locally outside the deletion targets/);
	assert.match(mod, /shared copy[^.]{0,120}authorized follow-up PR/);
	assert.match(mod, /cannot be claimed as already published/);
	assert.match(mod, /never rolls back the merge/);
	assert.match(mod, /no implicit staging/i);
});

test("learn prompt sequences LEARN before the final commit or PR, verifies the local ignore rule and reports SAVED as file plus readback only", () => {
	const prompt = read("agent/prompts/learn.md");
	assert.match(prompt, /before the final commit or PR/);
	assert.match(prompt, /existing ignore rule/);
	assert.match(prompt, /git check-ignore/);
	assert.match(prompt, /SAVED[^\n]{0,80}file plus readback/);
	assert.match(prompt, /not proof of remote commit, merge or publication/);
});

test("release-engineer and AGENTS: local SAVED outside every cleanup target is the knowledge checkpoint; shared integration is separate and authorized only when requested", () => {
	const role = read("agent/agents/release-engineer.md");
	assert.match(role, /local SAVED[\s\S]{0,160}outside every cleanup target/);
	const agents = read("agent/AGENTS.md");
	assert.match(agents, /post-merge cleanup waits for SAVED \(local, outside every cleanup target, with readback\) or a NO LESSON checkpoint/);
	assert.doesNotMatch(agents, /waits for its SAVED or NO LESSON checkpoint/);
});

test("LOCAL-REVIEW-REPAIR storage subject: private and local stores stay ignored and unindexed and never receive exported private, secret or unconfirmed notes", () => {
	const mod = read("agent/skills/engineering-harness/learn/index.md");
	assert.match(mod, /`docs\/knowledge\/private\/` and `docs\/knowledge\/local\/` remain ignored by the existing `\.gitignore` rule and unindexed and never receive exported private, secret or unconfirmed notes/);
	assert.match(mod, /release engineer checks the ignore rule read-only with `git check-ignore` and never edits `\.gitignore`/);
	assert.doesNotMatch(mod, /and never receives exported private/);
});

test("LOCAL-REVIEW-REPAIR: a LOCAL-ONLY destination that is not ignored is BLOCKED before SAVED; a shared record is not blocked by the local ignore check", () => {
	for (const rel of ["agent/skills/engineering-harness/learn/index.md", "agent/prompts/learn.md"]) {
		assert.match(read(rel), /LOCAL-ONLY destination[^\n]{0,200}not ignored[^\n]{0,160}BLOCKED/, `${rel}: un-ignored LOCAL-ONLY destination is BLOCKED`);
	}
	assert.match(read("agent/prompts/learn.md"), /LOCAL-ONLY destination[^\n]{0,200}git check-ignore/, "ignore check qualified to LOCAL-ONLY destinations");
	assert.match(read("agent/skills/engineering-harness/learn/index.md"), /shared record[^\n]{0,200}not blocked by the local ignore check/);
});

test("LOCAL-REVIEW-REPAIR: the local store is outside all three packet deletion targets; a primary-checkout candidate is retained, not deleted", () => {
	const mod = read("agent/skills/engineering-harness/learn/index.md");
	assert.match(mod, /primary[- ]checkout candidate is retained, not deleted/);
	assert.doesNotMatch(mod, /outside every packet candidate/);
	assert.doesNotMatch(read("agent/prompts/learn.md"), /outside every packet candidate/);
});

test("LOCAL-REVIEW-REPAIR: the Shared publication sentence starts a new sentence and keeps its exact policy wording", () => {
	const mod = read("agent/skills/engineering-harness/learn/index.md");
	assert.match(mod, /QMD index or refresh\. Shared publication is separate explicit authority, not a default completion gate\./);
	assert.doesNotMatch(mod, /; Shared publication/);
});

test("LOCAL-REVIEW-REPAIR: README supplies record fields only; the LOCAL-ONLY storage default in LEARN overrides its storage text", () => {
	assert.match(read("agent/skills/engineering-harness/learn/index.md"), /Record fields follow `docs\/knowledge\/README\.md` \(fields only; the LOCAL-ONLY storage default below overrides its storage text\)/);
});
