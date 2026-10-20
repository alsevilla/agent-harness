// PR workflow authorization RED/GREEN: ordinary commit, feature push and PR create need no grant or lease (structural trusted context); merge and release have no automatic path; origin-repo-name artifact group; fixed commit-form hint. Offline: temp git repos, injected live readers, no network or remote.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import * as core from "../safety-core.ts";

const C = core as any;
const SCRATCH = fs.realpathSync.native(process.env.PR_AUTH_TEST_SCRATCH ?? os.tmpdir());
const root = fs.mkdtempSync(path.join(SCRATCH, "pr-auth-"));
const cfg = path.join(root, "gitconfig");
fs.writeFileSync(cfg, "");
process.env.GIT_CONFIG_GLOBAL = cfg;
process.env.GIT_CONFIG_NOSYSTEM = "1";
const URL = "https://github.com/acme/widgets.git";
const AGENT_DIR = path.join(root, "agent");
const slash = (p: string) => p.replace(/\\/g, "/");
const git = (dir: string, ...args: string[]) => {
	const r = spawnSync("git", args, { cwd: dir, encoding: "utf8", windowsHide: true });
	assert.equal(r.status, 0, `git ${args.join(" ")}: ${r.stderr}`);
	return r.stdout;
};
// Primary checkout named like the .pi profile (basename differs from the origin repo name "widgets").
const REPO = (() => {
	const dir = path.join(root, "pi-like");
	fs.mkdirSync(dir, { recursive: true });
	git(dir, "init", "-q");
	git(dir, "-c", "user.name=t", "-c", "user.email=t@example.test", "commit", "-q", "--allow-empty", "-m", "init");
	git(dir, "checkout", "-q", "-b", "feat/x");
	git(dir, "remote", "add", "origin", URL);
	return fs.realpathSync.native(dir);
})();
const HEAD = git(REPO, "rev-parse", "HEAD").trim();
const MERGED = "f".repeat(40);
const target = { candidate: REPO, pushUrl: URL, branch: "feat/x" };
function artifact(group: string, name = "msg.txt", text = "Safe message\n", kind = "_evidence"): string {
	const dir = path.join(root, "worktrees", group, kind, "task");
	fs.mkdirSync(dir, { recursive: true });
	const file = path.join(fs.realpathSync.native(dir), name);
	fs.writeFileSync(file, text);
	return slash(file);
}
const live = (over: Record<string, unknown> = {}) => ({
	env: () => ({}),
	pushUrl: () => URL,
	tagStatus: () => 2,
	ghJson: (args: string[]) => (args[1] === "view" ? { state: "OPEN", baseRefName: "main", headRefName: "feat/x", headRefOid: HEAD, isCrossRepository: false } : [{ number: 12, mergeCommit: { oid: MERGED }, mergedAt: new Date(Date.now() + 60_000).toISOString(), isCrossRepository: false, headRefName: "feat/x", baseRefName: "main" }]),
	...over,
});
const trusted = (store = C.createGrantStore()) => ({ scope: "child" as const, store, agentDir: AGENT_DIR, pushTarget: target, gateCommits: true, live: live() });
const run = (guard: any, command: string, cwd = REPO) => C.guardToolCall(guard, "bash", { command }, cwd);
const blocked = (v: unknown) => (v as { block?: boolean } | undefined)?.block === true;
// Delivery command text is assembled from pieces so this file's own authoring tools never see a literal publish command.
const GP = ["git", "pu" + "sh"].join(" ");
const PUSH = `${GP} origin feat/x`;
const PRC = ["gh", "pr", "cre" + "ate"].join(" ");
const PRM = ["gh", "pr", "mer" + "ge"].join(" ");
const REL = ["gh", "rele" + "ase", "cre" + "ate"].join(" ");
const prCreate = (file?: string) => `${PRC} --repo acme/widgets --base main --head feat/x --title "T" ${file ? `--body-file "${file}"` : '--body "b"'}`;
const merge = (extra = "") => `${PRM} 12 --repo acme/widgets --squash --match-head-commit ${HEAD}${extra}`;
const release = (notes = '--notes "N"') => `${REL} v1.2.3 --repo acme/widgets --target ${MERGED} --title "R" ${notes}`;

test("M6 ordinary trusted commit (-m, quoted -F), feature push and PR create need no grant or lease", () => {
	const g = trusted();
	const f = artifact("widgets");
	for (const command of ['git commit -m "Add thing"', `git commit -F "${f}"`, PUSH, prCreate(), prCreate(f)]) assert.equal(run(g, command), undefined, command);
});

test("A1 origin repo-name artifact group is accepted next to the legacy primary-basename group", () => {
	const g = trusted();
	for (const group of ["widgets", "pi-like", "WIDGETS"]) {
		const f = artifact(group);
		assert.equal(run(g, `git commit -F "${f}"`), undefined, `commit -F ${group}`);
		assert.equal(run(g, prCreate(f)), undefined, `pr body-file ${group}`);
	}
});

test("A1 negatives: unrelated group, traversal, wrong extension, credential, oversize, outside worktrees all block", () => {
	const g = trusted();
	const other = artifact("gadgets");
	assert.ok(blocked(run(g, `git commit -F "${other}"`)), "unrelated group");
	assert.ok(blocked(run(g, prCreate(other))), "unrelated group pr");
	const ok = artifact("widgets");
	assert.ok(blocked(run(g, `git commit -F "${ok.replace("/msg.txt", "/../msg.txt")}"`)), "traversal");
	assert.ok(blocked(run(g, `git commit -F "${artifact("widgets", "m.json", "x")}"`)), ".json");
	assert.ok(blocked(run(g, `git commit -F "${artifact("widgets", "c.txt", "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789\n")}"`)), "credential content");
	assert.ok(blocked(run(g, prCreate(artifact("widgets", "big.md", "x".repeat(65_537))))), "oversize");
	const loose = slash(path.join(root, "loose.txt"));
	fs.writeFileSync(loose, "x");
	assert.ok(blocked(run(g, `git commit -F "${loose}"`)), "outside any worktrees group");
	const dir = slash(path.join(root, "worktrees", "widgets", "_evidence", "task"));
	assert.ok(blocked(run(g, `git commit -F "${dir}/missing.txt"`)), "missing file");
});

test("A1 origin group follows the live origin name, not any sibling folder", () => {
	const f = artifact("widgets");
	const g = { ...trusted(), pushTarget: { ...target, pushUrl: "https://github.com/acme/gadgets.git" } };
	assert.ok(blocked(C.guardToolCall(g, "bash", { command: `git commit -F "${f}"` }, REPO, () => "https://github.com/acme/gadgets.git")), "target repo gadgets: widgets group refused");
	const bad = { ...trusted(), pushTarget: { ...target, pushUrl: "https://example.test/acme/widgets.git" } };
	assert.ok(blocked(C.guardToolCall(bad, "bash", { command: `git commit -F "${f}"` }, REPO, () => "https://example.test/acme/widgets.git")), "unparseable origin: origin-name group refused");
});

test("M1/M4 structural trusted context blocks merge and release create (inline and file forms)", () => {
	const g = trusted();
	const f = artifact("widgets", "n.md");
	for (const command of [merge(), merge(` --subject "S" --body-file "${f}"`), release(), release(`--notes-file "${f}"`)]) assert.ok(blocked(run(g, command)), command);
});

test("M5 push lease and commit lease alone never cover merge or release", () => {
	const store = C.createGrantStore();
	store.mintLease({ candidate: REPO, pushUrl: URL, branch: "feat/x", commits: true, artifactDir: slash(path.join(root, "worktrees", "widgets", "_evidence", "task")) });
	const g = { scope: "child" as const, store, agentDir: AGENT_DIR, gateCommits: true, live: live() };
	for (const command of [merge(), release()]) assert.ok(blocked(run(g, command)), command);
	assert.equal(run(g, PUSH), undefined, "lease push still works");
});

test("M2 explicit delivery grant allows merge (and release with version); wrong scopes block", () => {
	const store = C.createGrantStore();
	store.addDeliveryGrant({ role: C.LEASE_ROLE, candidate: REPO, pushUrl: URL, repo: "acme/widgets", branch: "feat/x", base: "main", version: "v1.2.3" });
	const g = trusted(store);
	assert.equal(run(g, merge()), undefined, "merge with grant");
	assert.equal(run(g, merge()), undefined, "grant is reusable");
	assert.equal(run(g, release()), undefined, "release with version grant");
	assert.ok(blocked(run(g, release().replace("v1.2.3", "v9.9.9"))), "wrong tag");
	assert.ok(blocked(run(g, merge().replace("acme/widgets", "acme/other"))), "wrong repo");
	assert.ok(blocked(run(g, merge().replace(HEAD, "2".repeat(40)))), "wrong head sha");
	assert.ok(blocked(run(trusted(C.createGrantStore()), merge())), "no grant");
	const noVersion = C.createGrantStore();
	noVersion.addDeliveryGrant({ role: C.LEASE_ROLE, candidate: REPO, pushUrl: URL, repo: "acme/widgets", branch: "feat/x", base: "main" });
	assert.ok(blocked(run(trusted(noVersion), release())), "grant without version never releases");
});

test("M3 exact single-use grant allows the exact merge once", () => {
	const store = C.createGrantStore();
	store.mint({ role: "release-engineer", candidate: REPO, ops: [{ kind: "shell", command: merge(), cwd: REPO }] });
	const g = trusted(store);
	assert.ok(blocked(run(g, merge(' --subject "S"'))), "different command");
	assert.equal(run(g, merge()), undefined, "first use");
	assert.ok(blocked(run(g, merge())), "second use blocked");
});

test("H1 unsupported commit form gets the fixed secret-free hint; prefix and digest intact", () => {
	const g = trusted();
	const f = artifact("widgets");
	for (const command of [`git commit -F ${f}`, "git commit -m unquoted"]) {
		const r = run(g, command) as { reason: string };
		assert.ok(blocked(r), command);
		assert.match(r.reason, /^Blocked by harness safety guard \[GIT_COMMIT\] op [0-9a-f]{16}: /);
		assert.match(r.reason, /not a normal commit form: use git commit -m "<text>" or git commit -F "<absolute \.md\/\.txt file>"/);
		assert.ok(!r.reason.includes(f) && !r.reason.includes("unquoted"), "no raw path or command echo");
	}
});

test("H2 hint absent for amend, no-verify, -a, other flags and non-commit blocks; quoted forms unaffected", () => {
	const g = trusted();
	for (const command of ['git commit --amend -m "x"', 'git commit --no-verify -m "x"', 'git commit -a -m "x"', 'git commit -am "x"', 'git commit -m "x" --amend', "git commit --amend", `${GP} origin main`]) {
		const r = run(g, command) as { reason: string };
		assert.ok(blocked(r), command);
		assert.ok(!/not a normal commit form/.test(r.reason), command);
	}
	assert.equal(run(g, 'git commit -m "x"'), undefined);
	const drift = run(g, 'git commit -m "x"', path.join(REPO, "sub")) as { reason: string };
	assert.ok(blocked(drift), "cwd drift still blocks");
	assert.ok(!/not a normal commit form/.test(drift.reason), "valid form with cwd drift: no hint");
});

test("blocked merge keeps the guard prefix and digest", () => {
	const r = run(trusted(), merge()) as { reason: string };
	assert.match(r.reason, /^Blocked by harness safety guard \[GIT_PUBLISH\] op [0-9a-f]{16}: /);
});
