// Session authorization RED: trusted release-engineer normal-commit gate, commit lease binding (branch, root, origin, env, merge states, -F artifacts), exact-grant fallback, envelope validation and lease store cap. Offline: temp git repos only, no push, no network.
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
const cwd = fs.realpathSync(os.tmpdir());
const agentDir = path.join(cwd, "fake-agent");
const GUARD_FILE = path.join(import.meta.dirname, "..", "safety-guard-entry.ts");
const PUSH_URL = "https://example.test/owner/repo.git";
const rules = (command: string): string[] => C.classifyShell(command).rules;
const gatedChild = (store: unknown) => ({ scope: "child", store, agentDir, gateCommits: true });
const allowed = (store: unknown, repo: string, command: string, tool = "bash") => C.guardToolCall(gatedChild(store), tool, { command }, repo) === undefined;

// Hermetic git: no user or system config reaches these fixtures.
const EMPTY_GITCONFIG = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "commit-lease-cfg-")), "gitconfig");
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
	const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "commit-lease-")));
	git(dir, "init", "-q");
	git(dir, "-c", "user.name=t", "-c", "user.email=t@example.test", "commit", "-q", "--allow-empty", "-m", "init");
	git(dir, "branch", "feat/x");
	git(dir, "branch", "feat/y");
	git(dir, "checkout", "-q", "feat/x");
	git(dir, "remote", "add", "origin", url);
	return dir;
}
// Placement-valid artifact directory (<tmp>/worktrees/<repo>/_scratch/<task>) holding one message file.
function artifactFixture(text = "feat x: add y\n", name = "msg.txt"): { dir: string; file: string } {
	const base = fs.realpathSync(os.tmpdir()).replace(/\\/g, "/");
	const dir = `${base}/worktrees/pi-auth-${randomBytes(4).toString("hex")}/_scratch/task`;
	fs.mkdirSync(dir, { recursive: true });
	const real = fs.realpathSync.native(dir).replace(/\\/g, "/");
	const file = `${real}/${name}`;
	fs.writeFileSync(file, text);
	return { dir: real, file };
}

test("commit grammar: exact -m and -F forms parse; every other shape is not a normal commit", () => {
	const art = artifactFixture();
	assert.deepEqual(C.parseNormalCommit('git commit -m "feat x: add y"'), { message: "feat x: add y" });
	assert.deepEqual(C.parseNormalCommit("git commit -m 'feat x'"), { message: "feat x" });
	assert.deepEqual(C.parseNormalCommit(`git commit -F "${art.file}"`), { file: art.file });
	const denied = [
		"git commit", "git commit -m", 'git commit -m ""', 'git commit -m "x" -m "y"', 'git commit -m "$(id)"', 'git commit -m "a\\"b"', 'git commit -m "a$b"', 'git commit -m "x\u00e9"',
		"git commit -m x", 'git commit --message "x"', 'git commit --message="x"', 'git commit  -m "x"', 'Git commit -m "x"', 'git commit -m "x"\u200b',
		'git commit -a -m "x"', 'git commit -am "x"', 'git commit --all -m "x"', 'git commit --amend -m "x"', 'git commit --am -m "x"', 'git commit --ame -m "x"', 'git commit --amen -m "x"', 'git commit --amend --no-edit',
		'git commit --no-verify -m "x"', 'git commit -n -m "x"', 'git commit --allow-empty -m "x"', 'git commit --author="A <a@x>" -m "x"', 'git commit --date="2020-01-01" -m "x"',
		'git commit --fixup=HEAD -m "x"', 'git commit --squash=HEAD -m "x"', "git commit -c HEAD", "git commit -C HEAD", 'git commit -S -m "x"', 'git commit --gpg-sign -m "x"', 'git commit --no-gpg-sign -m "x"',
		'git commit -s -m "x"', 'git commit --signoff -m "x"', 'git commit -m "x" --no-edit', 'git commit -m "x" -- a.txt', 'git commit a.txt -m "x"', 'git commit -m "x" a.txt',
		`git commit -F "relative.txt"`, `git commit -F "../msg.txt"`, "git commit -F msg.txt", 'git commit -F "C:/x/../y.txt"', 'git commit -m "x" > out.txt', 'git commit -m "x" | cat', 'git commit -m "x" &', "git commit -m 'x' 2>&1",
		'git -c user.name=x commit -m "x"', 'git -C . commit -m "x"', 'env GIT_AUTHOR_NAME=x git commit -m "x"', 'GIT_DIR=x git commit -m "x"', 'sudo git commit -m "x"',
		'git commit -m "x" && git push origin feat/x', 'git commit -m "x"; echo', 'git add . && git commit -m "x"', 'git commit -m "x" && git commit -m "y"',
		'git commit-tree HEAD -m "x"', 'echo "git commit -m x"', "git commit -m \"x\"\n",
	];
	for (const command of denied) assert.equal(C.parseNormalCommit(command), undefined, JSON.stringify(command));
});

test("commit classification: recognized amend abbreviations are GIT_DESTRUCTIVE; plain commits stay unclassified for ungated callers", () => {
	for (const command of ["git commit --amend -m x", "git commit --am -m x", "git commit --ame -m x", "git commit --amen -m x", "env X=1 git commit --am", "sh -c 'git commit --amen'"]) {
		assert.ok(rules(command).includes("GIT_DESTRUCTIVE"), command);
	}
	for (const command of ['git commit -m "x"', "git commit -a -m x", "git commit --allow-empty -m x", "git commit --no-verify -m x", "git commit -F msg.txt"]) {
		assert.deepEqual(rules(command), [], command);
	}
});

test("commit gate: gated git commit shapes decide GIT_COMMIT (grantable); other git shapes and ungated callers stay as today", () => {
	const decide = (command: string, gate: boolean) => C.decideToolCall("bash", { command }, cwd, agentDir, gate);
	const art = artifactFixture();
	for (const command of [`git commit -m "x"`, `git commit -F "${art.file}"`, "git commit -a -m x", "git commit --no-verify -m x", "env X=1 git commit -m x", "git -c a=b commit -m x", "sh -c 'git commit -m x'", 'git add . && git commit -m "x"', 'git commit -m "x" && git push origin feat/x']) {
		const decision = decide(command, true);
		assert.equal(decision.action, "block", command);
		assert.ok(decision.rules.includes("GIT_COMMIT"), command);
		assert.equal(decision.grantable, true, command);
		assert.ok(decide(command, false).action === "allow" || !decide(command, false).rules.includes("GIT_COMMIT"), `ungated ${command}`);
	}
	const amend = decide("git commit --amend -m x", true);
	assert.ok(amend.rules.includes("GIT_COMMIT") && amend.rules.includes("GIT_DESTRUCTIVE"), "amend is destructive and gated");
	for (const command of ["git status", "git log --oneline", "git commit-tree HEAD", 'echo "git commit -m x"', "git push origin feat/x"]) {
		assert.equal(decide(command, true).rules?.includes?.("GIT_COMMIT") ?? false, false, command);
	}
	assert.equal(decide("git status", true).action, "allow");
	assert.equal(C.guardToolCall({ scope: "main", store: C.createGrantStore(), agentDir, gateCommits: true }, "bash", { command: "git commit -a -m x" }, cwd), undefined, "main never gates commits");
});

test("commit lease: a commits lease allows the exact normal commit for bash and powershell, repeatedly and without consuming it; a push-only lease does not", () => {
	const repo = commitRepo();
	const art = artifactFixture();
	const store = C.createGrantStore();
	store.mintLease({ candidate: repo, pushUrl: PUSH_URL, branch: "feat/x", commits: true, artifactDir: art.dir });
	for (const command of ['git commit -m "feat x: add y"', `git commit -F "${art.file}"`]) {
		for (const tool of ["bash", "powershell"]) {
			for (let i = 0; i < 2; i++) assert.equal(allowed(store, repo, command, tool), true, `${tool} ${command} #${i}`);
		}
	}
	const pushOnly = C.createGrantStore();
	pushOnly.mintLease({ candidate: repo, pushUrl: PUSH_URL, branch: "feat/x" });
	assert.equal(allowed(pushOnly, repo, 'git commit -m "feat x: add y"'), false, "push-only lease never covers a commit");
});

test("commit lease drift: moved HEAD, subdirectory cwd, origin URL change, unsafe push config, wrong branch and no lease all block", () => {
	const command = 'git commit -m "feat x: add y"';
	const store = (repo: string, branch = "feat/x") => {
		const s = C.createGrantStore();
		s.mintLease({ candidate: repo, pushUrl: PUSH_URL, branch, commits: true });
		return s;
	};
	let repo = commitRepo();
	const moved = store(repo);
	git(repo, "checkout", "-q", "feat/y");
	assert.equal(allowed(moved, repo, command), false, "HEAD on another branch blocks");
	repo = commitRepo();
	fs.mkdirSync(path.join(repo, "sub"));
	assert.equal(allowed(store(repo), path.join(repo, "sub"), command), false, "subdirectory cwd is not the candidate root");
	repo = commitRepo();
	git(repo, "remote", "set-url", "origin", "https://example.test/other/repo.git");
	assert.equal(allowed(store(repo), repo, command), false, "origin URL drift blocks");
	repo = commitRepo();
	git(repo, "config", "remote.origin.pushurl", "https://example.test/other/repo.git");
	assert.equal(allowed(store(repo), repo, command), false, "extra push URL config blocks");
	repo = commitRepo();
	assert.equal(allowed(store(repo, "feat/y"), repo, command), false, "lease for another branch blocks");
	repo = commitRepo();
	assert.equal(allowed(C.createGrantStore(), repo, command), false, "no lease blocks");
});

test("commit lease state: MERGE_HEAD, CHERRY_PICK_HEAD, REVERT_HEAD, rebase and sequencer state each block a commit lease", () => {
	const command = 'git commit -m "feat x: add y"';
	const sha = "0".repeat(40) + "\n";
	const states: Array<[string, "file" | "dir"]> = [["MERGE_HEAD", "file"], ["CHERRY_PICK_HEAD", "file"], ["REVERT_HEAD", "file"], ["rebase-merge", "dir"], ["rebase-apply", "dir"], ["sequencer", "dir"]];
	for (const [name, kind] of states) {
		const repo = commitRepo();
		const store = C.createGrantStore();
		store.mintLease({ candidate: repo, pushUrl: PUSH_URL, branch: "feat/x", commits: true });
		assert.equal(allowed(store, repo, command), true, `${name} clean baseline`);
		const marker = path.join(repo, ".git", name);
		if (kind === "file") fs.writeFileSync(marker, sha);
		else fs.mkdirSync(marker);
		assert.equal(allowed(store, repo, command), false, `${name} in progress blocks`);
	}
});

test("commit lease env: redirect variables block a commit lease; harness identity variables do not", () => {
	const command = 'git commit -m "feat x: add y"';
	const repo = commitRepo();
	const store = C.createGrantStore();
	store.mintLease({ candidate: repo, pushUrl: PUSH_URL, branch: "feat/x", commits: true });
	const redirects = ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_COMMON_DIR", "GIT_NAMESPACE", "GIT_CONFIG_COUNT", "GIT_CONFIG_PARAMETERS", "GIT_CONFIG_KEY_0", "GIT_CONFIG_VALUE_0"];
	for (const name of redirects) {
		const prior = process.env[name];
		process.env[name] = "x";
		try {
			assert.equal(allowed(store, repo, command), false, `${name} blocks`);
		} finally {
			if (prior === undefined) delete process.env[name];
			else process.env[name] = prior;
		}
	}
	const identity = ["GIT_AUTHOR_NAME", "GIT_AUTHOR_EMAIL", "GIT_COMMITTER_NAME", "GIT_COMMITTER_EMAIL"];
	const priorIdentity = identity.map((name) => process.env[name]);
	for (const name of identity) process.env[name] = "Harness Identity";
	try {
		assert.equal(allowed(store, repo, command), true, "harness-provided identity is preserved");
	} finally {
		identity.forEach((name, i) => (priorIdentity[i] === undefined ? delete process.env[name] : (process.env[name] = priorIdentity[i])));
	}
});

test("message artifacts: -F must name a file inside the leased artifact directory and pass the artifact checks", () => {
	const repo = commitRepo();
	const art = artifactFixture();
	const other = artifactFixture();
	const json = artifactFixture("feat x: add y\n", "msg.json");
	const secret = artifactFixture("token = abc123\n");
	const store = (artifactDir?: string) => {
		const s = C.createGrantStore();
		s.mintLease({ candidate: repo, pushUrl: PUSH_URL, branch: "feat/x", commits: true, ...(artifactDir ? { artifactDir } : {}) });
		return s;
	};
	assert.equal(allowed(store(art.dir), repo, `git commit -F "${art.file}"`), true, "bound artifact passes");
	assert.equal(allowed(store(art.dir), repo, `git commit -F "${other.file}"`), false, "file outside the bound directory blocks");
	assert.equal(allowed(store(json.dir), repo, `git commit -F "${json.file}"`), false, "non .md/.txt message file blocks");
	assert.equal(allowed(store(secret.dir), repo, `git commit -F "${secret.file}"`), false, "credential-like message text blocks");
	assert.equal(allowed(store(), repo, `git commit -F "${art.file}"`), false, "unbound commit lease refuses -F");
});

test("exact single-use grant covers an unsupported commit shape; a commit lease does not", () => {
	const repo = commitRepo();
	const command = 'git commit -a -m "feat x: add y"';
	const store = C.createGrantStore();
	store.mintLease({ candidate: repo, pushUrl: PUSH_URL, branch: "feat/x", commits: true });
	assert.equal(allowed(store, repo, command), false, "lease does not cover -a");
	const op = C.authorizableOp("shell", command, repo, agentDir, true);
	store.mint({ role: "release-engineer", candidate: repo, ops: [op] });
	assert.equal(allowed(store, repo, command), true, "first exact grant use");
	assert.equal(allowed(store, repo, command), false, "exact grant is single-use");
});

test("trusted gate is decided at launch: only a release-engineer child with leases gets gateCommits in its envelope", () => {
	const repo = commitRepo();
	const launch = C.claimChildGuard(C.createGrantStore(), "release-engineer", repo, GUARD_FILE, { open: true }, true);
	assert.equal(launch.gateCommits, true);
	assert.equal(JSON.parse(launch.childEnv({})[C.CHILD_GRANT_ENV]).gateCommits, true, "gated even with no grants or leases");
	assert.equal(C.claimChildGuard(C.createGrantStore(), "release-engineer", repo, GUARD_FILE, { open: true }, false).gateCommits, false, "project source is not trusted");
	assert.equal(C.claimChildGuard(C.createGrantStore(), "worker", repo, GUARD_FILE, { open: true }, true).gateCommits, false, "other roles are policy-only");
});

test("envelope gateCommits: exactly boolean true enables gating; absent or false does not; any other value fails closed", () => {
	assert.equal(C.loadChildGate('{"v":1,"grants":[],"gateCommits":true}'), true);
	assert.equal(C.loadChildGate('{"v":1,"grants":[]}'), false);
	assert.throws(() => C.loadChildGate('{"v":1,"grants":[],"gateCommits":false}'), undefined, "explicit false fails closed");
	for (const text of ['{"v":1,"grants":[],"gateCommits":"true"}', '{"v":1,"grants":[],"gateCommits":1}', '{"v":2,"grants":[],"gateCommits":true}']) {
		assert.throws(() => C.loadChildGate(text), undefined, text);
	}
});

test("envelope leases: commits must be exactly true when present; artifactDir needs commits and a valid absolute directory; legacy push-only leases load", () => {
	const repo = commitRepo();
	const art = artifactFixture();
	const base = { role: "release-engineer", candidate: repo, pushUrl: PUSH_URL, branch: "feat/x" };
	const legacy = C.loadChildLeases(JSON.stringify({ v: 1, grants: [], leases: [base] }));
	assert.equal(legacy.length, 1);
	assert.equal(legacy[0].commits, undefined);
	const bound = C.loadChildLeases(JSON.stringify({ v: 1, grants: [], leases: [{ ...base, commits: true, artifactDir: art.dir }] }));
	assert.equal(bound[0].commits, true);
	assert.equal(bound[0].artifactDir, art.dir);
	for (const lease of [{ ...base, commits: "yes" }, { ...base, commits: false }, { ...base, commits: true, artifactDir: "relative/dir" }, { ...base, artifactDir: art.dir }]) {
		assert.throws(() => C.loadChildLeases(JSON.stringify({ v: 1, grants: [], leases: [lease] })), undefined, JSON.stringify(lease));
	}
});

test("lease store: commit upgrades in place and never downgrades; eight distinct bindings max; artifact directory round trips", () => {
	const repo = commitRepo();
	const art = artifactFixture();
	const store = C.createGrantStore();
	store.mintLease({ candidate: repo, pushUrl: PUSH_URL, branch: "feat/x" });
	store.mintLease({ candidate: repo, pushUrl: PUSH_URL, branch: "feat/x", commits: true, artifactDir: art.dir });
	store.mintLease({ candidate: repo, pushUrl: PUSH_URL, branch: "feat/x", commits: false });
	const upgraded = store.copyLeases(repo);
	assert.equal(upgraded.length, 1, "same binding is one lease");
	assert.equal(upgraded[0].commits, true, "never downgraded");
	assert.equal(upgraded[0].artifactDir, art.dir);
	const round = C.loadChildLeases(C.serializeGrants([], upgraded));
	assert.equal(round[0].commits, true);
	assert.equal(round[0].artifactDir, art.dir);
	const capped = C.createGrantStore();
	for (let i = 0; i < 8; i++) capped.mintLease({ candidate: repo, pushUrl: PUSH_URL, branch: `b${i}`, commits: true });
	assert.equal(capped.leaseCount(), 8);
	assert.throws(() => capped.mintLease({ candidate: repo, pushUrl: PUSH_URL, branch: "b8", commits: true }), RangeError, "ninth binding refused");
});

