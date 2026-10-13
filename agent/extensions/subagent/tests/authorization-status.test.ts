// Session authorization RED: push/commit planner (covered, ask, covered-by-delivery), missing-branch and root diagnosis, and the secret-free /authorization status. Offline: temp git repos only, no push, no network.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
// Namespace import: an absent export fails inside the test body (behavioral RED), not at link time.
import * as core from "../safety-core.ts";

const C = core as any;
const PUSH_URL = "https://example.test/owner/repo.git";
const GH_URL = "https://github.com/owner/repo.git"; // delivery grants derive their repo from github.com only

// Hermetic git: no user or system config reaches these fixtures.
const EMPTY_GITCONFIG = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "auth-status-cfg-")), "gitconfig");
fs.writeFileSync(EMPTY_GITCONFIG, "");
process.env.GIT_CONFIG_GLOBAL = EMPTY_GITCONFIG;
process.env.GIT_CONFIG_NOSYSTEM = "1";
const git = (dir: string, ...args: string[]): string => {
	const run = spawnSync("git", args, { cwd: dir, encoding: "utf8", windowsHide: true });
	assert.equal(run.status, 0, `git ${args.join(" ")}: ${run.stderr}`);
	return run.stdout;
};
// Repo with feat/x checked out, feat/y present, origin set to the given URL.
function commitRepo(url = PUSH_URL): string {
	const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "auth-status-")));
	git(dir, "init", "-q");
	git(dir, "-c", "user.name=t", "-c", "user.email=t@example.test", "commit", "-q", "--allow-empty", "-m", "init");
	git(dir, "branch", "feat/x");
	git(dir, "branch", "feat/y");
	git(dir, "checkout", "-q", "feat/x");
	git(dir, "remote", "add", "origin", url);
	return dir;
}
// Placement-valid artifact directory (<tmp>/worktrees/<repo>/_scratch/<task>) holding one message file.
function artifactFixture(): { dir: string; file: string } {
	const base = fs.realpathSync(os.tmpdir()).replace(/\\/g, "/");
	const dir = path.join(base, "worktrees", `pi-auth-${randomBytes(4).toString("hex")}`, "_scratch", "task");
	fs.mkdirSync(dir, { recursive: true });
	const real = fs.realpathSync.native(dir).replace(/\\/g, "/");
	const file = `${real}/msg.txt`;
	fs.writeFileSync(file, "feat x: add y\n");
	return { dir: real, file };
}
const target = (repo: string, branch = "feat/x", url = PUSH_URL) => ({ candidate: repo, pushUrl: url, branch });

test("planner: repeats are covered; push-only to commit re-prompts; a commit lease covers push-only; a different artifact directory re-prompts", () => {
	const repo = commitRepo();
	const art = artifactFixture();
	const store = C.createGrantStore();
	assert.equal(C.planPushRequest(store, target(repo), { commits: false }).action, "ask", "no lease asks");
	store.mintLease({ candidate: repo, pushUrl: PUSH_URL, branch: "feat/x" });
	assert.equal(C.planPushRequest(store, target(repo), { commits: false }).action, "covered", "push-only repeat is covered with no dialog");
	assert.equal(C.planPushRequest(store, target(repo), { commits: true, artifactDir: art.dir }).action, "ask", "push-only to push+commit re-prompts");
	store.mintLease({ candidate: repo, pushUrl: PUSH_URL, branch: "feat/x", commits: true, artifactDir: art.dir });
	assert.equal(C.planPushRequest(store, target(repo), { commits: true, artifactDir: art.dir }).action, "covered", "same commit scope is covered");
	assert.equal(C.planPushRequest(store, target(repo), { commits: false }).action, "covered", "push-only is covered by a commit lease");
	assert.equal(C.planPushRequest(store, target(repo), { commits: true, artifactDir: artifactFixture().dir }).action, "ask", "a different artifact directory re-prompts");
});

test("planner: an existing delivery covers a push-only request with no lease minted; it never covers a commit request", () => {
	const repo = commitRepo(GH_URL);
	const store = C.createGrantStore();
	store.addDeliveryGrant({ role: "release-engineer", candidate: repo, pushUrl: GH_URL, repo: "owner/repo", branch: "feat/x", base: "main" });
	assert.equal(C.planPushRequest(store, target(repo, "feat/x", GH_URL), { commits: false }).action, "covered-by-delivery");
	assert.equal(store.leaseCount(), 0, "delivery covering a push mints no lease");
	assert.equal(C.planPushRequest(store, target(repo, "feat/x", GH_URL), { commits: true, artifactDir: artifactFixture().dir }).action, "ask", "delivery never authorizes commits");
});

test("diagnosis: missing branch, wrong root, two push URLs and unsafe push config each give a fixed reason; the live wrapper stays undefined", () => {
	const repo = commitRepo();
	assert.deepEqual(C.diagnosePushBranch(repo, "feat/x"), { pushUrl: PUSH_URL });
	assert.equal(C.livePushUrl(repo, "feat/x"), PUSH_URL);
	assert.match(C.diagnosePushBranch(repo, "feat/z").reason, /local branch is missing/);
	assert.equal(C.livePushUrl(repo, "feat/z"), undefined);
	const sub = path.join(repo, "sub");
	fs.mkdirSync(sub);
	assert.match(C.diagnosePushBranch(sub, "feat/x").reason, /not the repository root/);
	git(repo, "remote", "set-url", "--add", "origin", "https://example.test/other.git");
	assert.match(C.diagnosePushBranch(repo, "feat/x").reason, /more than one push URL/);
	git(repo, "remote", "set-url", "--delete", "origin", "https://example.test/other.git");
	git(repo, "config", "remote.origin.mirror", "true");
	assert.match(C.diagnosePushBranch(repo, "feat/x").reason, /push configuration is unsafe/);
	assert.equal(C.livePushUrl(repo, "feat/x"), undefined);
	for (const text of [C.diagnosePushBranch(repo, "feat/x").reason ?? "", C.diagnosePushBranch(sub, "feat/x").reason ?? ""]) assert.ok(!text.includes("://") && !text.includes(PUSH_URL), "reason has no URL");
});

test("status repo labels never include credentials from URL components", () => {
	for (const [url, expected, secret] of [
		["https://example.test/owner/repo.git?auth=/PRIVATEVALUE/SECRETEND", "owner/repo", "PRIVATEVALUE/SECRETEND"],
		["https://example.test/owner/repo.git#fragment=/PRIVATEVALUE/SECRETEND", "owner/repo", ""],
		["git@example.test:owner/repo.git", "owner/repo", ""],
		["git@example.test:owner/repo.git?auth=QUERYSECRET", "repo not shown", "QUERYSECRET"],
		["git@example.test:owner/repo.git#FRAGMENTSECRET", "repo not shown", "FRAGMENTSECRET"],
		["ssh://git@example.test/owner/repo.git", "owner/repo", ""],
		["not a valid origin /PRIVATEVALUE/SECRETEND", "repo not shown", "PRIVATEVALUE/SECRETEND"],
	] as const) {
		const repo = commitRepo(url);
		const store = C.createGrantStore();
		store.mintLease({ candidate: repo, pushUrl: url, branch: "feat/x" });
		const text = C.authorizationStatus(store, Date.now());
		assert.ok(text.includes(`repo ${expected}`), url);
		if (secret) assert.ok(!text.includes(secret), `status leaks ${secret}`);
	}
});

test("status: read-only and secret-free; lease scope, delivery binding and validity show; no URL, digest, bearer, id or raw command", () => {
	const repo = commitRepo(GH_URL);
	const art = artifactFixture();
	const store = C.createGrantStore();
	store.mintLease({ candidate: repo, pushUrl: GH_URL, branch: "feat/x", commits: true, artifactDir: art.dir });
	store.addDeliveryGrant({ role: "release-engineer", candidate: repo, pushUrl: GH_URL, repo: "owner/repo", branch: "feat/x", base: "main" });
	const command = "git push --force origin feat/x";
	const [record] = store.mint({ role: null, candidate: repo, ops: [{ kind: "shell", command, cwd: repo }] });
	const before = store.copyLeases(repo).length;
	const text = C.authorizationStatus(store, Date.now());
	assert.equal(typeof text, "string");
	for (const needle of ["push+commit", "owner/repo", "feat/x", "single-use", "session", "valid"]) assert.ok(text.includes(needle), needle);
	for (const secret of [GH_URL, "https://", "token", "Bearer", command, record.bearer, record.id, record.op.command]) assert.ok(!text.includes(secret), `status leaks ${secret.slice(0, 12)}`);
	assert.ok(text.length < 4000, "bounded output");
	assert.equal(store.copyLeases(repo).length, before, "status mutates no state");
	git(repo, "checkout", "-q", "feat/y");
	git(repo, "update-ref", "-d", "refs/heads/feat/x");
	const drifted = C.authorizationStatus(store, Date.now());
	assert.ok(drifted.includes("invalid") && drifted.includes("local branch is missing"), "a missing branch shows as invalid with its reason");
});
