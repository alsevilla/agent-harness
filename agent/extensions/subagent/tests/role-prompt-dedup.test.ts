// Role/shared prompt dedup contract: the removed redundant restatements stay absent, privacy-neutralized wording stays, and
// every role keeps its no-helper boundary. Prompt wording is otherwise free to change.
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { after, test } from "node:test";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

// Controlled "present" world: every integration file the FULL launch names exists in a temp profile; no ambient ~/.pi or ~/.graphify input.
const PROFILE = mkdtempSync(path.join(tmpdir(), "dedup-profile-"));
const EMPTY_GLOBAL = mkdtempSync(path.join(tmpdir(), "dedup-global-empty-"));
const FILES = {
	ponytailExt: path.join(PROFILE, "npm", "node_modules", "@dietrichgebert", "ponytail", "pi-extension", "index.js"),
	ponytailSkill: path.join(PROFILE, "npm", "node_modules", "@dietrichgebert", "ponytail", "skills", "ponytail-review", "SKILL.md"),
	serena: path.join(PROFILE, "npm", "node_modules", "@bacnh85", "pi-serena", "extensions", "index.ts"),
	graphifyExt: path.join(PROFILE, "npm", "node_modules", "graphify-pi", "extensions", "graphify.ts"),
	graphifySkill: path.join(PROFILE, "skills", "graphify", "SKILL.md"),
	qmd: path.join(PROFILE, "extensions", "qmd", "index.ts"),
};
for (const file of Object.values(FILES)) { mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, "// controlled fixture\n"); }
after(() => { fs.rmSync(PROFILE, { recursive: true, force: true }); fs.rmSync(EMPTY_GLOBAL, { recursive: true, force: true }); });
const FULL_LAUNCH = ["--extension", FILES.ponytailExt, "--extension", FILES.serena, "--extension", FILES.qmd, "--extension", FILES.graphifyExt, "--skill", FILES.graphifySkill, "--tools", "read,grep,find,ls,serena_find_symbol,qmd_search"];
// Node equivalent of the former module mock: resolve the Pi package to a data: module exposing only getAgentDir.
(globalThis as any).__piTestAgentDir = () => PROFILE;
registerHooks({
  resolve(specifier: string, context: object, nextResolve: (s: string, c: object) => { url: string }) {
    if (specifier === "@earendil-works/pi-coding-agent") return { url: "data:text/javascript," + encodeURIComponent("export const getAgentDir = () => globalThis.__piTestAgentDir();"), shortCircuit: true };
    return nextResolve(specifier, context);
  },
} as never);
const { assembleChildSystemPrompt, graphReferenceGuidance } = await import("../code-integrations.ts");

const repo = fileURLToPath(new URL("../../../../", import.meta.url)).replace(/\\/g, "/").replace(/\/$/, "");
const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const normalize = (text: string) => text.replace(/\r\n/g, "\n").replace(/\\/g, "/").split(repo).join("<CANDIDATE>");
const sentences = (text: string) => normalize(text).split(/\n+|(?<=\.) /).map((s) => s.trim()).filter((s) => s.length >= 20);
const sentenceHashes = (text: string) => new Set(sentences(text).map((s) => sha(s).slice(0, 8)));
const bodyOf = (text: string) => text.replace(/\r\n/g, "\n").replace(/^---\n[\s\S]*?\n---\n?/, "");

// Redundant restatements removed by the dedup. Each is already stated by the Leaf boundary paragraph of the same prompt.
const REDUNDANT = ["Never spawn another agent.", "Never spawn helpers."];
const REDUNDANT_HASHES = new Set(REDUNDANT.flatMap((s) => [...sentenceHashes(s)]));
// Privacy neutralization of pinned live role sentences (source wording, checked against the pre-change HEAD sentences): `from` is the pre-change sentence hash, `to` the generic replacement. Exempt only these exact role/hash pairs.
const PRIVACY_NEUTRALIZED = [
	{ role: "observability-specialist", from: "014b3dd7", to: "Never log device identifiers, account or contact data merely for convenience." },
	{ role: "performance-specialist", from: "e7084086", to: "- external notification/network latency." },
	{ role: "performance-specialist", from: "3e3eb18f", to: "For externally driven bursts such as device taps, open arrival-rate testing is" },
	{ role: "backend-worker", from: "741e9d34", to: "- `concurrency-specialist`;" },
	{ role: "observability-specialist", from: "741e9d34", to: "- `concurrency-specialist`;" },
	{ role: "release-engineer", from: "c503145c", to: 'gh pr create --repo acme/widgets --base main --head feat/x --title "Add delivery grant" --body-file "D:/work/worktrees/app/_evidence/task/pr.md"' },
	{ role: "release-engineer", from: "5deee955", to: 'gh pr merge 12 --repo acme/widgets --squash --match-head-commit 0123456789abcdef0123456789abcdef01234567 --subject "Add delivery grant" --body-file "D:/work/worktrees/app/_evidence/task/pr.md"' },
	{ role: "release-engineer", from: "08b235a8", to: 'gh release create v1.2.3 --repo acme/widgets --target 0123456789abcdef0123456789abcdef01234567 --title "v1.2.3" --notes-file "D:/work/worktrees/app/_evidence/task/notes.md" --latest' },
];

const fixture = JSON.parse(fs.readFileSync(new URL("./fixtures/role-prompt-dedup.before.json", import.meta.url), "utf8")) as {
	entries: Record<string, { chars: number; frontmatterSha: string; headings: string[]; sentenceHashes: string[] }>;
};
// Only live (agent/) shapes remain: the retired pi-package defaults shape was removed with the pi-package layout.
function assembled(shape: string, role: string): { text: string; sourceText: string } {
	assert.equal(shape, "live");
	assert.notEqual(role, "sqlite-specialist", "retired role fixture must not be assembled as a live role");
	const sourceText = fs.readFileSync(new URL(`../../../agents/${role}.md`, import.meta.url), "utf8");
	const agent = { name: role, systemPrompt: bodyOf(sourceText), source: "user", filePath: "", description: role, tools: [] };
	return { text: assembleChildSystemPrompt(agent as never, { codeIntegrationsEnabled: true, cwd: repo, packageRoot: null, launchArgs: FULL_LAUNCH, qmdExtension: FILES.qmd, globalGraphDirectory: EMPTY_GLOBAL }), sourceText };
}

test("release cleanup policy assigns only safe post-merge task-owned removal to release engineer", () => {
	const release = fs.readFileSync(new URL("../../../agents/release-engineer.md", import.meta.url), "utf8");
	const ship = fs.readFileSync(new URL("../../../skills/engineering-harness/ship/index.md", import.meta.url), "utf8");
	const worktree = fs.readFileSync(new URL("../../../skills/engineering-harness/worktree/index.md", import.meta.url), "utf8");
	const learn = fs.readFileSync(new URL("../../../skills/engineering-harness/learn/index.md", import.meta.url), "utf8");
	assert.match(release, /release engineer owns\s+safe cleanup of explicitly named task-owned worktrees/i);
	assert.match(ship, /release engineer owns\s+safe cleanup of explicitly named task-owned worktrees/i);
	assert.match(worktree, /release engineer owns\s+safe cleanup of explicitly named task-owned worktrees/i);
	for (const text of [release, ship, worktree, learn]) {
		assert.match(text, /knowledge-disposition checkpoint/i);
		assert.match(text, /SAVED/);
		assert.match(text, /NO LESSON/);
		assert.match(text, /BLOCKED/);
		assert.match(text, /archive|report/i);
	}
	for (const text of [release, worktree]) {
		assert.match(text, /git worktree remove/);
		assert.match(text, /(?:without|no)\s+`?--force`?/);
		assert.match(text, /CLEANUP_PENDING/);
		assert.match(text, /(?:missing terminal or quiescence|quiescence evidence)/i);
	}
});

const skillText = (rel: string) => fs.readFileSync(new URL(`../../../skills/engineering-harness/${rel}`, import.meta.url), "utf8");

test("post-merge cleanup removes exactly three named targets and never bulk-copies, archives, sweeps or forces", () => {
	const worktree = skillText("worktree/index.md");
	assert.ok(worktree.includes("The cleanup set is exactly three targets"), "exactly three targets");
	assert.match(worktree, /`git worktree remove <exact absolute path>`[^\n]{0,40}no `--force`/);
	assert.ok(worktree.includes("exact `_evidence/<task>` directory"), "exact evidence target");
	assert.ok(worktree.includes("exact `_scratch/<task>` directory"), "exact scratch target");
	assert.ok(worktree.includes("host-appropriate removal operation"), "packet supplies exact removal operation per target");
	assert.ok(worktree.includes("one exact path at a time"), "artifact directories removed one exact path at a time");
	assert.ok(!worktree.includes("The cleanup set is exactly three paths"), "old three-paths wording removed");
	assert.ok(!worktree.includes("unique evidence is preserved outside every deletion target"), "contradictory unique-evidence wording removed");
	for (const term of ["no archive-by-default", "no bulk copy", "no sweep", "no wildcard", "no parent-directory removal", "no prune", "no branch deletion"]) assert.ok(worktree.includes(term), term);
});

test("post-merge cleanup waits for the knowledge checkpoint; a BLOCKED checkpoint retains the target and never rolls back the merge", () => {
	assert.ok(skillText("worktree/index.md").includes("runs once the knowledge checkpoint is SAVED"), "worktree: canonical knowledge gate before cleanup");
	assert.ok(skillText("worktree/index.md").includes("or after a NO LESSON checkpoint"), "worktree: NO LESSON alternative");
	assert.ok(skillText("ship/index.md").includes("worktree/index.md"), "ship points to the canonical knowledge gate");
	assert.ok(!skillText("ship/index.md").includes("merged state includes"), "ship does not duplicate the gate paragraph");
	const worktree = skillText("worktree/index.md");
	assert.ok(worktree.includes("BLOCKED knowledge checkpoint"), "BLOCKED retention");
	assert.ok(worktree.includes("never rolls back the merge"), "no rollback of merge");
	assert.ok(worktree.includes("may be saved locally outside the deletion targets"), "late local lesson stays outside targets");
	assert.ok(worktree.includes("cannot be claimed as already published"), "shared copy is not claimed as published");
});

test("shared publication is verified from a freshly fetched base by blob id, never by squash-prone commit ancestry; a destination inside a deletion target is never durable", () => {
	const worktree = skillText("worktree/index.md");
	for (const term of ["freshly fetched remote base", "git fetch", "git rev-parse", "git -C <exact checkout path> hash-object", "not commit ancestry", "A destination inside any of the three deletion targets is not durable"]) assert.ok(worktree.includes(term), term);
	const release = fs.readFileSync(new URL("../../../agents/release-engineer.md", import.meta.url), "utf8");
	assert.match(release, /worktree\/index\.md/, "release-engineer points to the canonical cleanup gate");
	assert.match(release, /local SAVED[\s\S]{0,160}outside every cleanup target/);
});

test("cleanup retains a target with unique or unreproduced required evidence or user data; no default archive or bulk copy", () => {
	assert.match(skillText("worktree/index.md"), /unique or unreproduced[^.]{0,120}RETAINED/);
	assert.ok(skillText("worktree/index.md").includes("not copied or archived by default"), "no default archive or bulk copy");
});

test("release-engineer body mirrors the exact three-target cleanup and keeps arbitrary directory deletion forbidden", () => {
	const release = fs.readFileSync(new URL("../../../agents/release-engineer.md", import.meta.url), "utf8");
	assert.match(release, /exact `_evidence\/<task>` and `_scratch\/<task>` directories the packet names/);
	assert.match(release, /arbitrary directory deletion/);
	assert.match(release, /wildcard, sweep/);
});

test("public README cleanup section distinguishes authorized exact task artifact deletion from arbitrary directories", () => {
	const readme = fs.readFileSync(new URL("../../../../README.md", import.meta.url), "utf8");
	const section = /## Worktree placement and disposition\r?\n([\s\S]*?)\r?\n## /.exec(readme)?.[1] ?? "";
	assert.ok(section.length > 0, "cleanup section present");
	assert.ok(section.includes("exact `_evidence/<task>` and `_scratch/<task>` directories"), "exact artifact targets");
	assert.ok(section.includes("arbitrary directories are never deleted"), "arbitrary directories forbidden");
	assert.ok(!section.includes("Main performs disposition"), "release engineer performs; main schedules");
});

test("post-merge cleanup retains active, paused, service, database, shared, unique, unauthorized and unmerged targets with a concrete reason", () => {
	const worktree = skillText("worktree/index.md");
	for (const term of ["active or paused job", "-wal", "-shm", "explicit retention", "missing authority", "shared or uniquely owned data", "user data", "Unmerged or PR-only candidates are retained"]) assert.ok(worktree.includes(term), term);
});

test("post-merge cleanup keeps temp, log and report destinations outside every deletion target; no file is recreated after delete", () => {
	const worktree = skillText("worktree/index.md");
	for (const term of ["temp, log and report destinations lie outside all three deletion targets", "inline or approved external report", "no file is recreated in a removed target"]) assert.ok(worktree.includes(term), term);
});

// Authorized retirement: a separate, narrow, user-authorized mode. Routine post-merge cleanup keeps its unconditional no-force/no-parent ban.
const retirementSection = () => /### Authorized retirement[^\n]*\r?\n([\s\S]*?)(?:\r?\n### |\r?\nLoad `references\/extended\.md`|$)/.exec(skillText("worktree/index.md"))?.[1] ?? "";
const releaseText = () => fs.readFileSync(new URL("../../../agents/release-engineer.md", import.meta.url), "utf8");
test("retirement: routine post-merge cleanup keeps its ordinary ban and is explicitly separate from the retirement mode", () => {
	const worktree = skillText("worktree/index.md");
	assert.ok(retirementSection().length > 200, "worktree has a distinct Authorized retirement section");
	for (const term of ["The cleanup set is exactly three targets", "no shared-parent removal", "no parent-directory removal", "Routine cleanup never resets/cleans, force-removes, deletes branches or deletes arbitrary directories", "Two distinct modes"]) assert.ok(worktree.includes(term), term);
	assert.match(releaseText(), /In routine mode[^\n]{0,40}no reset, clean, force-removal, branch deletion, wildcard, sweep/);
	assert.match(releaseText(), /In routine mode the only removals are the exact checkout/);
	assert.ok(releaseText().includes("`git worktree remove` using the exact absolute path, without `--force`"), "routine no-force sentence unchanged");
});

test("retirement: requires user-disposition authority naming each exact path and operation; dirty discard needs explicit discard consent that merge or general cleanup never implies", () => {
	const section = retirementSection();
	for (const term of ["user-disposition authority", "names each exact absolute path or data item and the exact operation", "explicit discard consent", "consent to merge or to general cleanup is not discard consent", "parent approval is never implied", "readiness or role guidance grants nothing"]) assert.ok(section.includes(term), term);
	const release = releaseText();
	for (const term of ["Authorized retirement", "explicit discard consent", "worktree/index.md"]) assert.ok(release.includes(term), `release-engineer: ${term}`);
});

test("retirement: force-removes only listed discarded checkouts, then the exact approved parent; rejects active, primary, live-database and unknown-owner targets", () => {
	const section = retirementSection();
	for (const term of ["git worktree remove --force <exact absolute path>", "only the listed discarded checkouts", "exact approved retired parent", "primary checkout", "active or paused worker", "running service", "live database", "unknown actual ownership", "new ongoing data", "own cwd", "terminal known owners", "fresh process, lock and link checks", "explicit user statement that nothing ongoing", "no global handle proof is required", "no sweep, wildcard or arbitrary parent"]) assert.ok(section.includes(term), term);
	for (const term of ["no branch deletion", "no reset", "no clean", "no prune", "no history rewrite"]) assert.ok(section.includes(term), term);
	assert.doesNotMatch(section, /[A-Za-z]:[\\/]+Users[\\/]|worktrees[\\/]+[A-Za-z0-9_.-]+[\\/]/, "the current retirement case is an example, never hardcoded paths");
});

test("retirement: guard refusal and operator grants stay required; artifacts and reports stay outside targets; order is preflight, knowledge, checkouts, registrations, parent, verification", () => {
	const section = retirementSection();
	for (const term of ["guard refusal", "exact operator grant", "no guard bypass", "no ungated Node deletion", "SAVED or NO LESSON checkpoint", "outside every target", "no fabricated lesson", "no automatic archive", "without following links", "proven link behavior", "stop all remaining operations", "partial report"]) assert.ok(section.includes(term), term);
	const orderBullet = section.slice(section.indexOf("- Order:"));
	assert.ok(orderBullet.startsWith("- Order:"), "explicit Order bullet");
	const order = ["preflight every target", "SAVED or NO LESSON checkpoint", "force-remove each listed discarded checkout", "all nested registrations are removed and confirmed", "remove the exact approved retired parent", "verify exact target absence", "registration absence", "protected data readback"].map((term) => orderBullet.indexOf(term));
	assert.ok(order.every((at) => at >= 0), `ordering terms present: ${order}`);
	assert.deepEqual([...order].sort((a, b) => a - b), order, "operation order");
});

test("retirement: SHIP, AGENTS and README point to the worktree retirement mode without granting authority", () => {
	assert.match(skillText("ship/index.md"), /Authorized retirement[^\n]{0,200}worktree\/index\.md|worktree\/index\.md[^\n]{0,200}Authorized retirement/);
	const agents = fs.readFileSync(new URL("../../../skills/engineering-harness/references/policy-detail.md", import.meta.url), "utf8"); // moved from AGENTS.md (Phase 1)
	assert.match(agents, /Keep active\/dirty worktrees[^.]{0,160}(?:explicit user-authorized retirement|Authorized retirement)/);
	const readme = fs.readFileSync(new URL("../../../../README.md", import.meta.url), "utf8");
	const section = /## Worktree placement and disposition\r?\n([\s\S]*?)\r?\n## /.exec(readme)?.[1] ?? "";
	assert.ok(section.includes("Authorized retirement"), "README names the retirement mode");
	assert.ok(section.includes("arbitrary directories are never deleted"), "README keeps the ordinary ban");
});

test("release-engineer states that named write paths are instruction-enforced, not hard destination or filesystem isolation, and does not claim guard confinement", () => {
	const release = releaseText();
	const boundary = /## Mutation boundary\r?\n([\s\S]*?)\r?\n## /.exec(release)?.[1] ?? "";
	const writeParagraph = boundary.split(/\r?\n\r?\n/).find((p) => p.startsWith("Native `write`")) ?? "";
	assert.ok(writeParagraph.includes("instruction-enforced"), "named paths are instruction-enforced");
	assert.ok(writeParagraph.includes("not hard destination or filesystem isolation"), "native write guard is not isolation");
	assert.ok(writeParagraph.includes("shell and `edit` remain powerful"), "shell and edit remain powerful");
	assert.doesNotMatch(boundary, /guard (?:confines|restricts|limits|enforces|prevents)|hard (?:destination|filesystem) (?:enforcement|confinement) (?:is|by)|confined by the (?:native )?write guard/i, "no runtime-confinement claim");
});

test("legacy worktree, ship and learn guide.md files are tiny pointers to the same-folder canonical index.md, not independent procedures", () => {
	for (const mod of ["worktree", "ship", "learn"]) {
		const guide = skillText(`${mod}/guide.md`);
		const lines = guide.split(/\r?\n/).filter((line) => line.trim() !== "");
		assert.ok(guide.length <= 500 && lines.length <= 4, `${mod}/guide.md: pointer-only, got ${guide.length} chars / ${lines.length} lines`);
		assert.equal(lines.filter((line) => /^#{1,6} /.test(line)).length, 1, `${mod}/guide.md: at most one heading`);
		assert.match(guide, /`index\.md`/, `${mod}/guide.md: names the same-folder canonical index.md`);
		assert.match(guide, /canonical/i, `${mod}/guide.md: states canonical authority`);
		for (const old of [/Before mutation|Before an authorized commit|Confirm:|Placement|relocation|Completion and cleanup|Optional retrospective|Three-incident|git worktree remove|CLEANUP_PENDING|Do not run SHIP|Capture only stable|\bLEARN\b|\bSHIP\b/]) assert.doesNotMatch(guide, old, `${mod}/guide.md: restates the old procedure`);
		assert.ok(skillText(`${mod}/index.md`).includes("## "), `${mod}/index.md: canonical procedure exists`);
	}
});

// 4C in-run retry: each code worker gained one sentence (fix a failing focused check in the same run, at most 2 tries; else return the recovery fields).
const IN_RUN_RETRY_RULE = "When a focused check fails after your edit, fix it in this run (at most 2 tries) before returning; if it still fails, return the failed command, an output excerpt, the changed files and your intended fix.";
const RETRY_ROLES = ["frontend-worker", "backend-worker", "database-worker", "general-worker"];

// Structural applicability: the Rust detail follows a Cargo manifest near the working directory, not the role name.
test("Rust build detail is emitted only when a Cargo manifest is structurally near the working directory", () => {
	const withCargo = mkdtempSync(path.join(tmpdir(), "dedup-cargo-"));
	mkdirSync(path.join(withCargo, ".git"));
	writeFileSync(path.join(withCargo, "Cargo.toml"), "[package]\nname = \"x\"\n");
	const withoutCargo = mkdtempSync(path.join(tmpdir(), "dedup-nocargo-"));
	mkdirSync(path.join(withoutCargo, ".git"));
	const agent = { name: "general-worker", systemPrompt: "ROLE BODY" } as never;
	const options = { codeIntegrationsEnabled: true, packageRoot: null, launchArgs: FULL_LAUNCH, qmdExtension: FILES.qmd, globalGraphDirectory: EMPTY_GLOBAL };
	assert.match(assembleChildSystemPrompt(agent, { ...options, cwd: withCargo }), /## Rust build output/);
	assert.doesNotMatch(assembleChildSystemPrompt(agent, { ...options, cwd: withoutCargo }), /## Rust build output/);
});

test("the historical sqlite-specialist fixture is explicitly retired and has no live prompt source", () => {
	assert.ok(fixture.entries["live/sqlite-specialist"], "preserve immutable historical baseline");
	assert.ok(!fs.existsSync(new URL("../../../agents/sqlite-specialist.md", import.meta.url)));
	assert.ok(fs.existsSync(new URL("../../../agents/database-specialist.md", import.meta.url)));
});

test("the redundant no-helper restatements are absent from every assembled prompt that stated them", () => {
	const offenders: string[] = [];
	for (const [key, before] of Object.entries(fixture.entries)) {
		const [shape, role] = key.split("/");
		if (role === "sqlite-specialist") continue; // Historical fixture retained; role retired in favor of database-specialist.
		const after = sentenceHashes(assembled(shape, role).text);
		if (before.sentenceHashes.some((h) => REDUNDANT_HASHES.has(h))) for (const h of REDUNDANT_HASHES) if (after.has(h)) offenders.push(key);
	}
	assert.deepEqual([...new Set(offenders)], [], "redundant no-helper restatement still present");
});

test("privacy-neutralized role sentences: each original was in the pre-change fixture and is replaced exactly by its generic wording", () => {
	for (const p of PRIVACY_NEUTRALIZED) {
		const before = fixture.entries[`live/${p.role}`];
		assert.ok(before?.sentenceHashes.includes(p.from), `${p.role}: pre-change sentence ${p.from} missing from fixture`);
		const after = sentenceHashes(assembled("live", p.role).text);
		assert.ok(after.has(sha(p.to).slice(0, 8)), `${p.role}: generic wording missing`);
		assert.ok(!after.has(p.from), `${p.role}: original sentence still present`);
	}
});

test("the graph reference paragraph states the write-authority limit once, without repeating the artifact-placement candidate rule", () => {
	const root = mkdtempSync(path.join(tmpdir(), "dedup-graph-"));
	mkdirSync(path.join(root, ".git"));
	mkdirSync(path.join(root, "graphify-out"));
	writeFileSync(path.join(root, "graphify-out", "GRAPH_REPORT.md"), "# report\n");
	const globalDir = mkdtempSync(path.join(tmpdir(), "dedup-global-"));
	const text = graphReferenceGuidance(root, globalDir);
	assert.doesNotMatch(text, /widen write authority/, "authority is stated once, in core");
	const prompt = assembleChildSystemPrompt({ name: "general-worker", systemPrompt: "ROLE BODY" } as never, { codeIntegrationsEnabled: true, cwd: root, packageRoot: null, launchArgs: [], globalGraphDirectory: globalDir });
	assert.equal(prompt.split("Graph references never widen write authority.").length - 1, 1);
	assert.doesNotMatch(text, /Source edits and tests stay in the assigned candidate; graph/);
});

test("variant requirements survive dedup: oracle subscription guard, release-engineer integrations, reviewer verdict contract", () => {
	assert.match(assembled("live", "oracle").text, /Claude subscription guard/);
	assert.match(assembled("live", "release-engineer").text, /QMD\/Ponytail integrations/);
	assert.match(assembled("live", "reviewer").text, /APPROVE WITH NOTES/);
	assert.match(assembled("live", "scout").text, /Pi thinking levels control GPT reasoning directly/);
});

// Essential no-helper boundary for all 19 live roles (the fixture covers the 18 pre-platform generic roles): the leaf prohibition, the no-subagent-tool statement and the shell-launch prohibition remain, and the removed restatements stay absent.
test("every live role keeps the no-helper boundary and no longer restates the removed phrases", () => {
	const names = fs.readdirSync(new URL("../../../agents/", import.meta.url)).filter((f) => f.endsWith(".md")).map((f) => f.slice(0, -3)).sort();
	assert.equal(names.length, 21, "live role count (20 baseline + additive planner)");
	const missing: string[] = [];
	for (const role of names) {
		const text = assembled("live", role).text;
		if (!/Never launch\/delegate\/supervise helpers/.test(text)) missing.push(`${role}: leaf prohibition`);
		if (!/this leaf has no subagent tool/.test(text)) missing.push(`${role}: no-subagent-tool statement`);
		if (!/Do not use shell commands to launch Pi or other agents/.test(text)) missing.push(`${role}: shell-launch prohibition`);
		for (const phrase of REDUNDANT) if (text.includes(phrase)) missing.push(`${role}: restated "${phrase}"`);
	}
	assert.deepEqual(missing, []);
});

test("every code worker fixes a failing focused check in the same run before returning, and recovery carries the failure evidence", () => {
	for (const role of RETRY_ROLES) {
		const text = fs.readFileSync(new URL(`../../../agents/${role}.md`, import.meta.url), "utf8").replace(/\r\n/g, "\n");
		assert.equal(text.split(IN_RUN_RETRY_RULE).length, 2, `${role}: in-run retry rule stated exactly once`);
	}
	const recovery = fs.readFileSync(new URL("../../../skills/engineering-harness/references/recovery.md", import.meta.url), "utf8").replace(/\s+/g, " ");
	assert.match(recovery, /Do not launch another role only to rerun checks that already passed on the same code/);
	assert.match(recovery, /recovery packet carries the failed command, an output excerpt, the changed files and the intended fix/);
	assert.match(recovery, /in-run tries do not change the retry cap/);
});
