// Narrow automatic post-merge CHECKOUT cleanup: main-minted exact scope, live re-verification in mint and guard, runtime owner tracking, envelope, handoff. Offline: gh is injected; git fixtures are disposable local repos under the scratch root. No real removal ever runs (the guard only decides).
import assert from "node:assert/strict";
import * as cpMod from "node:child_process";
import { spawnSync } from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import * as core from "../safety-core.ts";
import * as state from "../cleanup-state.ts";
import * as F from "../candidate-fingerprint.ts";

const C = core as any;
const S = state as any;
const T0 = Date.parse("2030-01-01T00:00:00.000Z");
const MERGE = "fedcba9876543210fedcba9876543210fedcba98";
const GH_URL = "https://github.com/acme/widgets.git";
const SCRATCH = fs.realpathSync.native(process.env.DELIVERY_TEST_SCRATCH ?? os.tmpdir());
const root = fs.realpathSync.native(fs.mkdtempSync(path.join(SCRATCH, "cleanup-")));
const EMPTY_GITCONFIG = path.join(root, "gitconfig");
fs.writeFileSync(EMPTY_GITCONFIG, "");
process.env.GIT_CONFIG_GLOBAL = EMPTY_GITCONFIG;
process.env.GIT_CONFIG_NOSYSTEM = "1";
const slash = (p: string) => p.replace(/\\/g, "/");
const git = (dir: string, ...args: string[]) => {
	const run = spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.test", ...args], { cwd: dir, encoding: "utf8", windowsHide: true });
	assert.equal(run.status, 0, `git ${args.join(" ")}: ${run.stderr}`);
	return run.stdout.trim();
};
const PROJ = slash(path.join(root, "proj"));
const PRIMARY = `${PROJ}/pi`;
fs.mkdirSync(PRIMARY, { recursive: true });
git(PRIMARY, "init", "-q", "-b", "main");
fs.writeFileSync(`${PRIMARY}/a.txt`, "a\n");
fs.writeFileSync(`${PRIMARY}/.gitignore`, "ignored/\n");
git(PRIMARY, "add", "-A");
git(PRIMARY, "commit", "-q", "-m", "init");
git(PRIMARY, "remote", "add", "origin", GH_URL);
const WT = `${PROJ}/worktrees/pi`;
fs.mkdirSync(WT, { recursive: true });
const GUARD_FILE = path.join(import.meta.dirname, "..", "safety-guard-entry.ts");
const AGENT_DIR = path.join(root, "agent");
const q = (p: string) => `"${p}"`;
const REMOVE = (p: string) => `git worktree remove ${q(p)}`;

let n = 0;
interface Task { dir: string; branch: string; head: string; evidence: string; scratch: string }
function makeTask(): Task {
	const name = `task-${++n}`;
	const branch = `feat/${name}`;
	const dir = `${WT}/${name}`;
	git(PRIMARY, "worktree", "add", "-q", "-b", branch, dir);
	return { dir: slash(fs.realpathSync.native(dir)), branch, head: git(dir, "rev-parse", "HEAD"), evidence: `${WT}/_evidence/${name}`, scratch: `${WT}/_scratch/${name}` };
}
const view = (t: Task, over: Record<string, unknown> = {}) => ({ number: 12, state: "MERGED", baseRefName: "main", headRefName: t.branch, headRefOid: t.head, isCrossRepository: false, mergeCommit: { oid: MERGE }, ...over });
const env = { value: {} as Record<string, string> };
const clock = { value: T0 };
function live(v: unknown) {
	return { env: () => env.value, pushUrl: (c: string, b: string) => C.livePushUrl(c, b), ghJson: () => { if (v === "throw") throw new Error("gh down"); return v; }, tagStatus: () => 2, now: () => clock.value };
}
const request = (t: Task, over: Record<string, unknown> = {}) => ({ checkout: t.dir, branch: t.branch, base: "main", pr: 12, headSha: t.head, mergeCommit: MERGE, quiescent: true, ...over });
function terminalOwners(t: Task, role = "release-engineer") {
	const owners = new S.OwnerTracker();
	owners.begin({ workerId: "w1", role, cwd: t.dir, jobId: "bg-1" });
	owners.end("w1");
	return owners;
}
function mint(t: Task, o: { store?: any; owners?: any; live?: any; req?: Record<string, unknown>; primary?: string; mainCwd?: string; jobRunning?: (id: string) => boolean } = {}) {
	const store = o.store ?? C.createGrantStore(() => clock.value);
	const res = C.prepareCleanup(request(t, o.req), { store, owners: o.owners ?? terminalOwners(t), live: o.live ?? live(view(t)), primary: o.primary ?? PRIMARY, mainCwd: o.mainCwd ?? PROJ, jobRunning: o.jobRunning ?? (() => false) });
	return { store, res };
}
// A child store holding exactly the claimed envelope, like safety-guard-entry builds it.
function childFrom(grant: any) {
	const main = C.createGrantStore(() => clock.value);
	main.addCleanupGrant(grant);
	const launch = C.claimChildGuard(main, "release-engineer", PRIMARY, GUARD_FILE, undefined, true, undefined, grant.id);
	const text = launch.childEnv({})[C.CHILD_GRANT_ENV];
	const child = C.createGrantStore(() => clock.value);
	child.importCleanup(C.loadChildCleanup(text));
	return { child, text, launch, main };
}
const guardOf = (child: any, l: any, over: Record<string, unknown> = {}) => ({ scope: "child", store: child, agentDir: AGENT_DIR, gateCommits: true, live: l, ...over });
const blocked = (r: any) => r?.block === true;
function setup() {
	const t = makeTask();
	const { res } = mint(t);
	assert.equal(res.ok, true, JSON.stringify(res));
	return { t, grant: res.grant, ...childFrom(res.grant) };
}
const run = (g: any, command: string, cwd = PRIMARY) => C.guardToolCall(g, "bash", { command }, cwd, C.livePushUrl);

test("RED1 exact checkout removal is allowed once from the primary; replay is denied and the tree is untouched", () => {
	const { t, child } = setup();
	const g = guardOf(child, live(view(t)));
	assert.equal(run(g, REMOVE(t.dir)), undefined);
	assert.ok(blocked(run(g, REMOVE(t.dir))), "replay");
	assert.ok(fs.existsSync(t.dir), "the guard decides only; nothing was removed");
});

test("bare and untrusted forms stay denied: no grant, main scope, artifact deletion even with a grant", () => {
	const { t, child } = setup();
	const bare = guardOf(C.createGrantStore(), live(view(t)));
	assert.ok(blocked(run(bare, REMOVE(t.dir))), "no grant");
	assert.ok(blocked(C.guardToolCall({ scope: "main", store: child, agentDir: AGENT_DIR, live: live(view(t)) }, "bash", { command: REMOVE(t.dir) }, PRIMARY)), "main scope never uses child cleanup records");
	const g = guardOf(child, live(view(t)));
	for (const p of [t.evidence, t.scratch, `${WT}/..`, WT]) {
		for (const command of [`rm -r ${q(p)}`, `rm -rf ${q(p)}`, `Remove-Item -LiteralPath ${q(p)} -Recurse`, REMOVE(p)]) assert.ok(blocked(run(g, command)), command);
	}
	assert.equal(run(g, REMOVE(t.dir)), undefined, "the denied attempts consumed nothing");
});

test("every non-exact form is denied and consumes nothing", () => {
	const { t, child } = setup();
	const g = guardOf(child, live(view(t)));
	const other = makeTask();
	const R = REMOVE(t.dir);
	const forms = [
		`git worktree remove --force ${q(t.dir)}`, `git worktree remove -f ${q(t.dir)}`, `git worktree remove ${q(t.dir)} --force`, `git worktree remove -f -f ${q(t.dir)}`,
		`git -C ${q(PRIMARY)} worktree remove ${q(t.dir)}`, `git worktree prune`, `git worktree prune ${q(t.dir)}`, `git branch -D ${t.branch}`, `git clean -fdx`, `git reset --hard`,
		`${R} && rm -rf x`, `${R}; rm -rf x`, `${R} | cat`, `${R} > out.txt`, `${R} & `, `${R}\nrm -rf x`,
		`git worktree remove "$(echo ${t.dir})"`, `git worktree remove "${t.dir}\`x\`"`, `X=1 ${R}`, `env ${R}`, `sh -c '${R}'`, `bash -c "${R}"`, `powershell -Command ${R}`,
		`git worktree remove ${t.dir}`, `git worktree remove '${t.dir}'`, `git worktree remove ${q(t.dir)} ${q(other.dir)}`, `git worktree remove ${q(`${t.dir}/`)}`, `git worktree remove ${q(`${t.dir}/*`)}`, `git worktree remove ${q(`${WT}/task-*`)}`,
		`git worktree remove ${q(`${t.dir}/..`)}`, `git worktree remove ${q(`${t.dir}/../${path.basename(t.dir)}`)}`, `git worktree remove ${q(path.basename(t.dir))}`, `git worktree remove ${q(".")}`, `git worktree remove ${q(t.dir.replace(/\//g, "\\"))}`,
		`git worktree remove ${q(PRIMARY)}`, `git worktree remove ${q(WT)}`, `git worktree remove ${q(other.dir)}`, `git  worktree remove ${q(t.dir)}`, `${R} `,
	];
	for (const command of forms) assert.ok(blocked(run(g, command)), command);
	assert.equal(run(g, R), undefined, "still exactly allowed afterwards");
});

test("terminal and cwd gates: only the primary root is an allowed cwd", () => {
	const { t, child } = setup();
	const g = guardOf(child, live(view(t)));
	for (const cwd of [t.dir, `${t.dir}/.git`, WT, PROJ, os.tmpdir(), `${PRIMARY}/.git`]) assert.ok(blocked(run(g, REMOVE(t.dir), cwd)), cwd);
	assert.equal(run(g, REMOVE(t.dir)), undefined);
});

test("live gates at guard time: every dirty, unmerged, ignored, active-registration or unknown state denies", { timeout: 180_000 }, () => {
	const cases: { name: string; mutate?: (t: Task) => (() => void) | void; v?: (t: Task) => unknown; envSet?: Record<string, string> }[] = [
		{ name: "tracked modification", mutate: (t) => { fs.writeFileSync(`${t.dir}/a.txt`, "changed\n"); } },
		{ name: "staged change", mutate: (t) => { fs.writeFileSync(`${t.dir}/b.txt`, "b\n"); git(t.dir, "add", "b.txt"); } },
		{ name: "untracked file", mutate: (t) => { fs.writeFileSync(`${t.dir}/u.txt`, "u\n"); } },
		{ name: "ignored directory (unknown ignored data is retained)", mutate: (t) => { fs.mkdirSync(`${t.dir}/ignored`); fs.writeFileSync(`${t.dir}/ignored/x.db`, "x"); } },
		{ name: "ignored sidecar-like file", mutate: (t) => { fs.mkdirSync(`${t.dir}/ignored`); fs.writeFileSync(`${t.dir}/ignored/data.db-wal`, "x"); } },
		{ name: "HEAD moved by a new commit", mutate: (t) => { fs.writeFileSync(`${t.dir}/c.txt`, "c\n"); git(t.dir, "add", "c.txt"); git(t.dir, "commit", "-q", "-m", "more"); } },
		{ name: "detached HEAD", mutate: (t) => { git(t.dir, "checkout", "-q", "--detach"); } },
		{ name: "locked registration", mutate: (t) => { git(PRIMARY, "worktree", "lock", t.dir); return () => git(PRIMARY, "worktree", "unlock", t.dir); } },
		{ name: "hard link inside the checkout", mutate: (t) => { fs.linkSync(`${t.dir}/a.txt`, path.join(root, `hl-${n}`)); } },
		{ name: "PR still open", v: (t) => view(t, { state: "OPEN" }) },
		{ name: "PR closed unmerged", v: (t) => view(t, { state: "CLOSED" }) },
		{ name: "PR base differs", v: (t) => view(t, { baseRefName: "develop" }) },
		{ name: "PR head oid differs (force-push after approval)", v: (t) => view(t, { headRefOid: "1".repeat(40) }) },
		{ name: "PR branch differs", v: (t) => view(t, { headRefName: "feat/other" }) },
		{ name: "cross-repository PR", v: (t) => view(t, { isCrossRepository: true }) },
		{ name: "merge commit differs", v: (t) => view(t, { mergeCommit: { oid: "2".repeat(40) } }) },
		{ name: "no merge commit", v: (t) => view(t, { mergeCommit: null }) },
		{ name: "different PR number", v: (t) => view(t, { number: 13 }) },
		{ name: "gh failure", v: () => "throw" },
		{ name: "unusable gh answer", v: () => "not an object" },
		{ name: "GH_REPO redirect", envSet: { GH_REPO: "evil/repo" } },
		{ name: "GH_HOST redirect", envSet: { GH_HOST: "evil.example" } },
		{ name: "origin changed", mutate: () => { git(PRIMARY, "remote", "set-url", "origin", "https://github.com/acme/other.git"); return () => git(PRIMARY, "remote", "set-url", "origin", GH_URL); } },
		{ name: "origin push configuration unsafe", mutate: () => { git(PRIMARY, "config", "remote.origin.pushurl", "https://github.com/acme/elsewhere.git"); return () => git(PRIMARY, "config", "--unset", "remote.origin.pushurl"); } },
	];
	for (const c of cases) {
		const t = makeTask();
		const minted = mint(t);
		assert.equal(minted.res.ok, true, c.name);
		const { child } = childFrom(minted.res.grant);
		const undo = c.mutate?.(t);
		const saved = env.value;
		if (c.envSet) env.value = c.envSet;
		try {
			const g = guardOf(child, live(c.v ? c.v(t) : view(t)));
			assert.ok(blocked(run(g, REMOVE(t.dir))), c.name);
		} finally { env.value = saved; if (typeof undo === "function") undo(); }
	}
});

test("guard time: stale, absent and other-path scopes deny; an aliased path never mints", { timeout: 180_000 }, () => {
	const t = makeTask();
	const { child } = childFrom(mint(t).res.grant);
	clock.value = T0 + 11 * 60_000;
	try { assert.ok(blocked(run(guardOf(child, live(view(t))), REMOVE(t.dir))), "stale grant"); } finally { clock.value = T0; }
	const other = makeTask();
	assert.ok(blocked(run(guardOf(child, live(view(other))), REMOVE(other.dir))), "other task");
	const alias = `${WT}/alias-${n}`;
	fs.symlinkSync(t.dir, alias, "junction");
	try { assert.equal(mint(t, { req: { checkout: alias } }).res.ok, false, "junction alias"); } finally { fs.rmSync(alias, { force: true }); }
	const gone = makeTask();
	const { child: c2 } = childFrom(mint(gone).res.grant);
	git(PRIMARY, "worktree", "remove", gone.dir);
	assert.ok(blocked(run(guardOf(c2, live(view(gone))), REMOVE(gone.dir))), "absent folder");
});

test("mint refuses without runtime proof: unknown, active, paused, wrong-role, overlapping owners and main cwd", { timeout: 180_000 }, () => {
	const t = makeTask();
	assert.equal(mint(t, { owners: new S.OwnerTracker() }).res.ok, false, "no known owner");
	const active = new S.OwnerTracker();
	active.begin({ workerId: "w1", role: "release-engineer", cwd: t.dir, jobId: "bg-1" });
	assert.equal(mint(t, { owners: active }).res.ok, false, "active owner");
	const sub = terminalOwners(t);
	sub.begin({ workerId: "w2", role: "general-worker", cwd: `${t.dir}/sub`, jobId: "bg-2" });
	assert.equal(mint(t, { owners: sub }).res.ok, false, "active worker inside the target");
	const parent = terminalOwners(t);
	parent.begin({ workerId: "w3", role: "general-worker", cwd: WT });
	assert.equal(mint(t, { owners: parent }).res.ok, false, "active worker above the target");
	assert.equal(mint(t, { owners: terminalOwners(t, "general-worker") }).res.ok, false, "no delivery owner recorded");
	assert.equal(mint(t, { jobRunning: () => true }).res.ok, false, "running or paused job");
	assert.equal(mint(t, { mainCwd: `${t.dir}/sub` }).res.ok, false, "main cwd inside the target");
	assert.equal(mint(t, { mainCwd: t.dir }).res.ok, false, "main cwd is the target");
	assert.equal(mint(t, { primary: PROJ }).res.ok, false, "launch cwd is not the primary");
	assert.equal(mint(t, { primary: t.dir }).res.ok, false, "launch cwd is the target");
	assert.equal(mint(t, { req: { quiescent: false } }).res.ok, false, "no main quiescence declaration");
	assert.equal(mint(t, { req: { quiescent: undefined } }).res.ok, false);
	assert.equal(mint(t).res.ok, true, "control: terminal delivery owner mints");
});

test("mint refuses forged, malformed and out-of-placement requests", { timeout: 180_000 }, () => {
	const t = makeTask();
	const bad: Record<string, unknown>[] = [
		{ extra: 1 }, { checkout: PRIMARY }, { checkout: WT }, { checkout: `${WT}/..` }, { checkout: `${t.dir}/` }, { checkout: t.dir.replace(/\//g, "\\") }, { checkout: path.basename(t.dir) },
		{ branch: "main" }, { branch: "feat/other" }, { branch: "--force" }, { base: t.branch }, { base: "" }, { pr: 0 }, { pr: "12" }, { pr: 1.5 }, { headSha: "abc" }, { headSha: "1".repeat(40) }, { mergeCommit: "zz" }, { quiescent: "yes" },
	];
	for (const over of bad) assert.equal(mint(t, { req: over }).res.ok, false, JSON.stringify(over));
	const store = C.createGrantStore();
	assert.equal(mint(t, { store, req: { pr: 99 } }).res.ok, false);
	assert.equal(store.cleanupCount(), 0, "refusals mint nothing");
	assert.equal(mint(t, { live: live(view(t, { state: "OPEN" })) }).res.ok, false);
	fs.writeFileSync(`${t.dir}/u.txt`, "u");
	assert.equal(mint(t).res.ok, false, "dirty at mint");
	fs.rmSync(`${t.dir}/u.txt`);
	assert.equal(mint(t).res.ok, true);
	const stray = `${PROJ}/elsewhere/pi/task-x`;
	fs.mkdirSync(path.dirname(stray), { recursive: true });
	git(PRIMARY, "worktree", "add", "-q", "-b", "feat/stray", stray);
	const st = { dir: slash(fs.realpathSync.native(stray)), branch: "feat/stray", head: git(stray, "rev-parse", "HEAD"), evidence: "", scratch: "" };
	assert.equal(mint(st, { owners: terminalOwners(st), live: live(view(st)) }).res.ok, false, "off-placement checkout");
});

test("store and launch: revoke clears, claim is single, cleanup launch runs outside the target with trusted role, other launches carry nothing", () => {
	const t = makeTask();
	const { store, res } = mint(t);
	assert.equal(store.cleanupCount(), 1);
	store.revokeAll();
	assert.equal(store.cleanupCount(), 0, "abort revokes");
	assert.throws(() => C.claimChildGuard(store, "release-engineer", PRIMARY, GUARD_FILE, undefined, true, undefined, res.grant.id), /revoked|missing|expired/);
	store.addCleanupGrant(res.grant);
	store.revokeAll(true);
	assert.equal(store.cleanupCount(), 0, "shutdown revokes");
	store.addCleanupGrant(res.grant);
	for (const [role, cwd, trusted] of [["release-engineer", t.dir, true], ["release-engineer", `${t.dir}/sub`, true], ["release-engineer", WT, true], ["release-engineer", PROJ, true], ["release-engineer", PRIMARY, false], ["general-worker", PRIMARY, true]] as const) {
		assert.throws(() => C.claimChildGuard(store, role, cwd, GUARD_FILE, undefined, trusted, undefined, res.grant.id), role + cwd);
		assert.equal(store.cleanupCount(), 1, "a refused launch claims nothing");
	}
	const ok = C.claimChildGuard(store, "release-engineer", PRIMARY, GUARD_FILE, undefined, true, undefined, res.grant.id);
	assert.equal(store.cleanupCount(), 0, "claimed once");
	const parsed = JSON.parse(ok.childEnv({})[C.CHILD_GRANT_ENV]);
	assert.equal(parsed.cleanupActions.length, 1);
	assert.equal(parsed.deliveryActions, undefined, "a cleanup child carries no delivery or push scope");
	assert.equal(parsed.leases, undefined);
	assert.throws(() => C.claimChildGuard(store, "release-engineer", PRIMARY, GUARD_FILE, undefined, true, undefined, res.grant.id), "replay of the id");
	store.addCleanupGrant(res.grant);
	const fb = C.claimChildGuard(store, "release-engineer", PRIMARY, GUARD_FILE, { open: false }, true, undefined, res.grant.id);
	assert.equal(JSON.parse(fb.childEnv({})[C.CHILD_GRANT_ENV] ?? "{}").cleanupActions, undefined, "a fallback spawn never gets the scope");
	const ordinary = C.claimChildGuard(store, "release-engineer", t.dir, GUARD_FILE, undefined, true);
	assert.equal(JSON.parse(ordinary.childEnv({})[C.CHILD_GRANT_ENV] ?? "{}").cleanupActions, undefined, "an ordinary launch of the target carries no cleanup");
});

test("envelope: strict loader fails closed on tampering; absence grants nothing", () => {
	const { text } = setup();
	const base = JSON.parse(text);
	assert.deepEqual(C.loadChildCleanup(JSON.stringify({ v: 1, grants: [] })), [], "absent key");
	const tamper: ((g: any) => void)[] = [
		(g) => { g.extra = 1; }, (g) => { g.role = "general-worker"; }, (g) => { g.candidate = "relative/x"; }, (g) => { g.candidate = PRIMARY; }, (g) => { g.candidate = `${WT}/../x`; }, (g) => { g.headSha = "xyz"; }, (g) => { g.pr = "12"; }, (g) => { g.branch = "main"; },
		(g) => { g.primary = PROJ; }, (g) => { delete g.mergeCommit; }, (g) => { g.issuedAt = "now"; }, (g) => { g.pushUrl = "https://example.com/x/y.git"; }, (g) => { g.repo = "evil/repo"; },
	];
	for (const f of tamper) {
		const copy = structuredClone(base);
		f(copy.cleanupActions[0]);
		assert.throws(() => C.loadChildCleanup(JSON.stringify(copy)), undefined, JSON.stringify(copy.cleanupActions[0]));
	}
	assert.throws(() => C.loadChildCleanup(JSON.stringify({ ...base, cleanupActions: "x" })));
	assert.throws(() => C.loadChildCleanup(JSON.stringify({ ...base, cleanupActions: Array(5).fill(base.cleanupActions[0]) })));
	// The real guard entry applying this envelope is exercised in cleanup-runtime.node.ts (child process).
});

// Metadata-only discovery: wraps every Node fs and child_process entry point for the duration of one call and records what it touched.
const IO = { fs: ["existsSync", "statSync", "lstatSync", "realpathSync", "readFileSync", "readdirSync", "openSync", "accessSync", "opendirSync"], cp: ["execFileSync", "spawnSync", "execSync", "spawn", "exec", "execFile", "fork"] };
function recordIo<T>(fn: () => T): { result: T; calls: string[] } {
	const calls: string[] = [];
	const patched: [any, string, any][] = [];
	for (const [mod, names] of [[fs as any, IO.fs], [cpMod as any, IO.cp]] as const) {
		const target = mod.default ?? mod;
		for (const name of names) {
			const orig = target[name];
			if (typeof orig !== "function") continue;
			const wrapped = (...args: unknown[]) => { calls.push(`${name}(${String(args[0])})`); return orig.apply(target, args); };
			if (orig.native) (wrapped as any).native = orig.native;
			patched.push([target, name, orig]);
			target[name] = wrapped;
		}
	}
	syncBuiltinESMExports();
	try { return { result: fn(), calls }; } finally {
		for (const [target, name, orig] of patched) target[name] = orig;
		syncBuiltinESMExports();
	}
}

test("recordIo is not vacuous: it sees fs and child-process use made inside the window", () => {
	const { calls } = recordIo(() => { fs.existsSync(root); spawnSync("git", ["--version"], { windowsHide: true }); });
	assert.ok(calls.some((c) => c.startsWith("existsSync(")), calls.join());
	assert.ok(calls.some((c) => c.startsWith("spawnSync(git")), calls.join());
});

test("pending discovery is a cheap runtime-metadata projection: 4 merge grants, zero Git/gh/subprocess/fs I/O, never READY or MERGED, no mergeCommit or launchCwd", () => {
	const tasks = [makeTask(), makeTask(), makeTask(), makeTask()];
	const store = C.createGrantStore();
	for (const t of tasks) store.addDeliveryGrant({ role: "release-engineer", candidate: t.dir, pushUrl: GH_URL, repo: "acme/widgets", branch: t.branch, base: "main", action: "merge", pr: 12, sha: t.head, bound: { head: t.head, ref: `refs/heads/${t.branch}`, fingerprint: "a".repeat(64), exclude: [] } });
	assert.equal(store.listDelivery().length, 4);
	const owners = terminalOwners(tasks[0]);
	owners.begin({ workerId: "w2", role: "release-engineer", cwd: tasks[1].dir }); // still active: retained with an in-memory reason
	const liveCalls: string[] = [];
	const tripLive = new Proxy({}, { get: (_t, k) => (...a: unknown[]) => { liveCalls.push(String(k)); throw new Error("live must not be consulted"); } });
	const { result: entries, calls } = recordIo(() => C.cleanupPending(store, owners, () => false, tripLive));
	assert.deepEqual(calls, [], "no fs, Git, gh or other subprocess access");
	assert.deepEqual(liveCalls, [], "no live counter call (gh, tag, push URL, clock) for any of the 4 grants");
	assert.equal(entries.length, 4, "positive control: entries are returned, not a vacuous fail-closed empty list");
	const byDir = new Map(entries.map((e: any) => [e.checkout, e]));
	const first: any = byDir.get(tasks[0].dir);
	assert.equal(first.state, "PENDING_UNVERIFIED");
	assert.deepEqual(first.request, { checkout: tasks[0].dir, branch: tasks[0].branch, base: "main", pr: 12, headSha: tasks[0].head });
	assert.deepEqual(first.retainedArtifacts.map((x: any) => x.path).sort(), [tasks[0].evidence, tasks[0].scratch].sort());
	assert.ok(first.retainedArtifacts.every((x: any) => /never deleted automatically/.test(x.reason) && !("exists" in x)), "no existence claim");
	const held: any = byDir.get(tasks[1].dir);
	assert.equal(held.state, "RETAINED");
	assert.match(held.reason, /owner/);
	assert.equal((byDir.get(tasks[2].dir) as any).state, "RETAINED");
	assert.match((byDir.get(tasks[2].dir) as any).reason, /no known owner/, "unknown ownership retains");
	for (const e of entries as any[]) for (const k of ["mergeCommit", "launchCwd"]) assert.ok(!(k in e) && !(e.request && k in e.request), `${k} is omitted`);
	const text = C.formatCleanupPending(entries);
	assert.match(text, /^CLEANUP_PENDING \(runtime metadata only/);
	assert.match(text, /"state":"PENDING_UNVERIFIED"/);
	assert.doesNotMatch(text, /"state":"READY"|"MERGED"|mergeCommit"|launchCwd/);
	assert.deepEqual(C.cleanupPending(C.createGrantStore(), owners, () => false), [], "no runtime delivery record, no pending");
	const nonMerge = C.createGrantStore();
	nonMerge.addDeliveryGrant({ role: "release-engineer", candidate: tasks[0].dir, pushUrl: GH_URL, repo: "acme/widgets", branch: tasks[0].branch, base: "main", action: "release", pr: 12, sha: tasks[0].head, version: "v1.2.3" });
	assert.deepEqual(C.cleanupPending(nonMerge, owners, () => false), [], "only merge grants are pending (a release grant is not)");
	assert.equal(C.formatCleanupPending([]), "");
	// Unchanged safety: discovery grants nothing. The explicit mint still needs and verifies the live merged PR.
	assert.equal(mint(tasks[0]).res.ok, true, "positive control: the explicit mint verifies live and succeeds");
	assert.equal(mint(tasks[0], { live: live(view(tasks[0], { state: "OPEN" })) }).res.ok, false, "mint refuses a PR that is not MERGED");
});

test("owner tracker: begin/end, reservations block overlapping launches, clear forgets (unknown fails closed)", () => {
	const P = "C:/x/worktrees/pi/t";
	const o = new S.OwnerTracker();
	assert.match(o.check(P, () => false) ?? "", /owner/);
	o.begin({ workerId: "a", role: "release-engineer", cwd: P });
	assert.match(o.check(P, () => false) ?? "", /active/);
	o.end("a"); o.end("a"); o.end("zzz");
	assert.equal(o.check(P, () => false), undefined);
	o.reserve(P, Date.now() + 60_000);
	assert.throws(() => o.begin({ workerId: "b", role: "general-worker", cwd: `${P}/sub` }), /cleanup/);
	assert.throws(() => o.begin({ workerId: "b", role: "general-worker", cwd: "C:/x/worktrees/pi" }), /cleanup/);
	o.begin({ workerId: "c", role: "release-engineer", cwd: "C:/x/pi" });
	o.releaseUnclaimed();
	o.begin({ workerId: "d", role: "general-worker", cwd: P });
	o.clear();
	assert.match(o.check(P, () => false) ?? "", /owner/);
	o.reserve(P, Date.now() - 1);
	o.begin({ workerId: "e", role: "general-worker", cwd: P });
});

test("authorization status shows only a secret-free cleanup count", () => {
	const t = makeTask();
	const { store } = mint(t);
	const text = C.authorizationStatus(store, T0);
	assert.match(text, /cleanup scopes: 1/);
	assert.ok(!text.includes(t.dir) && !text.includes(MERGE));
});

test("runtime emits CLEANUP_PENDING from code, not only prose", () => {
	const dir = path.join(import.meta.dirname, "..");
	assert.match(fs.readFileSync(path.join(dir, "safety-core.ts"), "utf8"), /CLEANUP_PENDING/);
	assert.match(fs.readFileSync(path.join(dir, "index.ts"), "utf8"), /cleanupPending\(/);
	assert.match(fs.readFileSync(path.join(dir, "background.ts"), "utf8"), /pendingNote/);
});

// ---- F1: hardened local proof (hidden index states, configured programs) ----
const MARKER_JS = path.join(root, "marker.js");
fs.writeFileSync(MARKER_JS, "require('node:fs').writeFileSync(process.argv[2], 'ran');\n");
const HIDE: Record<string, (t: Task) => void> = {
	"assume-unchanged": (t) => git(t.dir, "update-index", "--assume-unchanged", "a.txt"),
	"skip-worktree": (t) => git(t.dir, "update-index", "--skip-worktree", "a.txt"),
	"sparse checkout": (t) => { fs.writeFileSync(`${t.dir}/b.txt`, "b\n"); git(t.dir, "add", "b.txt"); git(t.dir, "commit", "-q", "-m", "b"); git(t.dir, "sparse-checkout", "set", "--no-cone", "/b.txt"); },
	"gitlink": (t) => git(t.dir, "update-index", "--add", "--cacheinfo", `160000,${t.head},sub`),
};
for (const [name, hide] of Object.entries(HIDE)) {
	test(`F1 hidden index state (${name}): mint refuses and the guard denies; user bytes are preserved`, () => {
		const USER = `UNIQUE-USER-DATA-${name}\n`;
		const m = makeTask();
		hide(m);
		fs.writeFileSync(`${m.dir}/a.txt`, USER);
		const mh = { ...m, head: git(m.dir, "rev-parse", "HEAD") };
		assert.equal(mint(mh, { live: live(view(mh)), req: { headSha: mh.head } }).res.ok, false, "mint must refuse");
		const s = setup();
		hide(s.t);
		fs.writeFileSync(`${s.t.dir}/a.txt`, USER);
		const sh = { ...s.t, head: git(s.t.dir, "rev-parse", "HEAD") };
		for (const t of [s.t, sh]) assert.ok(blocked(run(guardOf(s.child, live(view(t))), REMOVE(s.t.dir))), "guard denies");
		assert.ok(fs.existsSync(s.t.dir) && fs.existsSync(m.dir), "nothing removed");
		for (const t of [m, s.t]) if (fs.existsSync(`${t.dir}/a.txt`)) assert.equal(fs.readFileSync(`${t.dir}/a.txt`, "utf8"), USER);
	});
}

// fsmonitor is covered by the actual-Git execution regressions below (the monitor DOES run in the permitted removal command, so it is refused, not merely disabled in the proof).
for (const kind of ["filter"] as const) {
	test(`F1 configured program (${kind}): the program never runs in mint or guard (filter refused)`, () => {
		const s = setup(); // minted while clean and unconfigured
		const m = makeTask();
		const marker = `${root}/marker-${kind}`;
		fs.rmSync(marker, { force: true });
		const cmd = `node ${q(slash(MARKER_JS))} ${q(marker)}`;
		const info = `${PRIMARY}/.git/info/attributes`;
		const key = kind === "fsmonitor" ? "core.fsmonitor" : "filter.x.clean";
		try {
			git(PRIMARY, "config", key, cmd);
			if (kind === "filter") { fs.writeFileSync(info, "a.txt filter=x\n"); fs.writeFileSync(`${m.dir}/a.txt`, "touched\n"); fs.writeFileSync(`${s.t.dir}/a.txt`, "touched\n"); }
			// fsmonitor is disabled by the hardened helper (the proof proceeds without running it); a repository-local filter is refused outright.
			assert.equal(mint(m).res.ok, kind === "fsmonitor", "mint");
			assert.equal(blocked(run(guardOf(s.child, live(view(s.t))), REMOVE(s.t.dir))), kind === "filter", "guard");
		} finally {
			git(PRIMARY, "config", "--unset-all", key);
			fs.rmSync(info, { force: true });
		}
		assert.ok(!fs.existsSync(marker), "the configured program must never run");
		assert.ok(fs.existsSync(s.t.dir));
	});
}

// ---- F1 remainder: the permitted `git worktree remove` runs a configured core.fsmonitor, so repository-local/worktree fsmonitor settings are refused ----
const MONITOR_JS = path.join(root, "monitor.js");
// Writes an outside receipt, then creates ignored user data inside the target (what a status-time monitor could do to data produced during the scan).
fs.writeFileSync(MONITOR_JS, "const fs=require('node:fs');fs.writeFileSync(process.argv[2],'ran');fs.mkdirSync(process.argv[3]+'/ignored',{recursive:true});fs.writeFileSync(process.argv[3]+'/ignored/user.db','UNIQUE-IGNORED-DATA');\n");
const monitorCmd = (marker: string, target: string) => `node ${q(slash(MONITOR_JS))} ${q(marker)} ${q(target)}`;
let shellRuns = 0;
// Executes the exact guard-allowed command in the disposable fixture (the guard itself only decides).
const execAllowed = (t: Task) => { shellRuns++; return spawnSync(REMOVE(t.dir), { shell: true, cwd: PRIMARY, encoding: "utf8", windowsHide: true }); };
// Resets ALL primary fixture config a row may have set (local, includeIf, config.worktree, extension) so rows cannot contaminate each other.
const includeKeys: string[] = [];
const unsetLocal = () => {
	for (const k of ["core.fsmonitor", "include.path", "extensions.worktreeConfig", ...includeKeys.splice(0)]) spawnSync("git", ["config", "--unset-all", k], { cwd: PRIMARY, windowsHide: true });
	fs.rmSync(`${PRIMARY}/.git/config.worktree`, { force: true });
};
const primaryDirty = () => spawnSync("git", ["config", "--show-scope", "--get-regexp", "^(core\\.fsmonitor|include\\.path|includeif\\..*|extensions\\.worktreeconfig)$"], { cwd: PRIMARY, encoding: "utf8", windowsHide: true }).stdout.trim();

test("F1 actual Git (T3 observation control): a direct disposable `git worktree remove` really runs the configured monitor", (tc) => {
	const t = makeTask();
	const marker = `${root}/marker-observe`;
	fs.rmSync(marker, { force: true });
	try {
		git(PRIMARY, "config", "core.fsmonitor", monitorCmd(marker, t.dir));
		const res = spawnSync("git", ["worktree", "remove", t.dir], { cwd: PRIMARY, encoding: "utf8", windowsHide: true });
		if (!fs.existsSync(marker)) { tc.skip(`NOT RUN: this Git build does not invoke core.fsmonitor in worktree remove (exit ${res.status}); T1/T2 prove nothing here`); return; }
		assert.ok(true);
	} finally { unsetLocal(); }
});

test("F1 actual Git (T1): a clean mint with a local monitor that writes outside and creates ignored data is refused; no monitor, bytes preserved", () => {
	const t = makeTask();
	const marker = `${root}/marker-t1`;
	fs.rmSync(marker, { force: true });
	let exec = "not run";
	try {
		git(PRIMARY, "config", "core.fsmonitor", monitorCmd(marker, t.dir));
		const res = mint(t).res;
		if (res.ok) { // pre-fix behavior: the proof passed, so actually run the permitted command on this disposable checkout
			const before = shellRuns;
			const r = execAllowed(t);
			exec = `MINTED; permitted removal ran (exit ${r.status}); runs ${shellRuns - before}; monitorRan=${fs.existsSync(marker)}; checkoutGone=${!fs.existsSync(t.dir)}`;
		}
		assert.equal(res.ok, false, `mint must refuse a repository-local fsmonitor: ${exec}`);
		assert.ok(!fs.existsSync(marker), "the monitor never ran");
		assert.ok(fs.existsSync(t.dir) && !fs.existsSync(`${t.dir}/ignored`), "checkout untouched");
		assert.equal(fs.readFileSync(`${t.dir}/a.txt`, "utf8"), "a\n");
	} finally { unsetLocal(); }
});

test("F1 actual Git (T2): a monitor configured after a clean mint is denied by the guard; no shell command runs and the checkout is preserved", () => {
	const s = setup();
	const marker = `${root}/marker-t2`;
	fs.rmSync(marker, { force: true });
	const runsBefore = shellRuns;
	let exec = "not run";
	try {
		git(PRIMARY, "config", "core.fsmonitor", monitorCmd(marker, s.t.dir));
		const verdict = run(guardOf(s.child, live(view(s.t))), REMOVE(s.t.dir));
		if (!blocked(verdict)) { const r = execAllowed(s.t); exec = `ALLOWED; permitted removal ran (exit ${r.status}); monitorRan=${fs.existsSync(marker)}; checkoutGone=${!fs.existsSync(s.t.dir)}`; }
		assert.ok(blocked(verdict), `guard must deny: ${exec}`);
		assert.equal(shellRuns, runsBefore, "no shell invocation");
		assert.ok(!fs.existsSync(marker), "the monitor never ran");
		assert.ok(fs.existsSync(s.t.dir) && !fs.existsSync(`${s.t.dir}/ignored`));
		assert.equal(fs.readFileSync(`${s.t.dir}/a.txt`, "utf8"), "a\n");
	} finally { unsetLocal(); }
});

test("F1 actual Git (positive control): with no monitor the exact allowed form genuinely removes the clean disposable checkout", () => {
	const s = setup();
	assert.equal(run(guardOf(s.child, live(view(s.t))), REMOVE(s.t.dir)), undefined, "guard allows");
	const r = execAllowed(s.t);
	assert.equal(r.status, 0, r.stderr);
	assert.ok(!fs.existsSync(s.t.dir), "the disposable checkout was removed");
});

const CORE_INCLUDE = (body: string) => { const f = path.join(root, `inc-${++n}.cfg`); fs.writeFileSync(f, body); git(PRIMARY, "config", "--add", "include.path", slash(f)); };
const SCOPES: Record<string, (t: Task, marker: string) => void> = {
	"hook command": (t, m) => git(PRIMARY, "config", "core.fsmonitor", monitorCmd(m, t.dir)),
	"true": () => git(PRIMARY, "config", "core.fsmonitor", "true"),
	"false": () => git(PRIMARY, "config", "core.fsmonitor", "false"),
	"valueless": () => CORE_INCLUDE("[core]\n\tfsmonitor\n"),
	"mixed case via local include": () => CORE_INCLUDE("[CoRe]\n\tFsMoNiTor = true\n"),
	"local include with a hook": (t, m) => CORE_INCLUDE(`[core]\n\tfsmonitor = ${monitorCmd(m, t.dir).replace(/\\/g, "/").replace(/"/g, '\\"')}\n`),
	"worktree config": (t) => { git(PRIMARY, "config", "extensions.worktreeConfig", "true"); git(t.dir, "config", "--worktree", "core.fsmonitor", "false"); },
};
// Runner-independent observer: Git itself writes one JSON start event (with argv) per process into a per-call unique scratch file. The process env is restored in finally.
interface Traced<R> { result?: R; error?: unknown; argvs: string[][] }
const subcommandOf = (argv: string[]) => { for (let i = 1; i < argv.length; i++) { if (argv[i] === "-C" || argv[i] === "-c") i++; else if (!argv[i].startsWith("-")) return argv[i]; } return ""; };
function traceGit<R>(f: () => R): Traced<R> {
	const file = path.join(root, `trace2-${++n}-${process.hrtime.bigint()}.json`);
	const saved = process.env.GIT_TRACE2_EVENT;
	process.env.GIT_TRACE2_EVENT = file;
	let out: { result?: R; error?: unknown };
	try { out = { result: f() }; } catch (error) { out = { error }; } finally { if (saved === undefined) delete process.env.GIT_TRACE2_EVENT; else process.env.GIT_TRACE2_EVENT = saved; }
	const lines = fs.existsSync(file) ? fs.readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean) : [];
	const argvs = lines.map((l) => JSON.parse(l)).filter((e) => e.event === "start" && Array.isArray(e.argv)).map((e) => e.argv as string[]);
	return { ...out, argvs };
}
const FSMON_QUERY = "^core\\.fsmonitor$";
const ranConfigQuery = (r: Traced<unknown>) => r.argvs.some((a) => subcommandOf(a) === "config" && a.includes(FSMON_QUERY));
const ranSub = (r: Traced<unknown>, sub: string) => r.argvs.some((a) => subcommandOf(a) === sub);
for (const [name, configure] of Object.entries(SCOPES)) {
	test(`F1 fsmonitor scope matrix (${name}): shared preflight and candidateFingerprint refuse before ls-files/status; the monitor never runs`, () => {
		const t = makeTask();
		const marker = `${root}/marker-matrix`;
		fs.rmSync(marker, { force: true });
		try {
			configure(t, marker);
			for (const call of [() => F.preflight(t.dir), () => F.candidateFingerprint(t.dir)]) {
				const r = traceGit(call);
				assert.ok(r.error instanceof RangeError && /fsmonitor/.test((r.error as Error).message), `refused: ${String(r.error)}`);
				assert.ok(ranConfigQuery(r), "trace observed the fsmonitor config query (non-vacuous)");
				assert.ok(!ranSub(r, "status") && !ranSub(r, "ls-files"), "no ls-files/status call");
			}
			assert.ok(!fs.existsSync(marker), "no monitor");
			assert.equal(mint(t).res.ok, false, "mint refuses");
		} finally { unsetLocal(); }
	});
}

test("F1 fsmonitor controls: no setting passes; a harmless global/system-scope value (the hardened command-scope override is always present and never refuses)", () => {
	const t = makeTask();
	const canary = traceGit(() => F.preflight(t.dir));
	assert.equal(canary.error, undefined, "no setting");
	assert.ok(ranConfigQuery(canary) && ranSub(canary, "ls-files"), "known-clean canary: the trace observes the config query and the listing");
	const saved = process.env.GIT_CONFIG_GLOBAL;
	const globalCfg = path.join(root, "global-fsmonitor.cfg");
	fs.writeFileSync(globalCfg, "[core]\n\tfsmonitor = true\n");
	process.env.GIT_CONFIG_GLOBAL = globalCfg;
	try {
		const r = traceGit(() => F.preflight(t.dir));
		assert.equal(r.error, undefined, "global scope is trusted");
		assert.ok(ranConfigQuery(r) && ranSub(r, "ls-files"), "proceeded to the listing");
		const fp = traceGit(() => F.candidateFingerprint(t.dir));
		assert.equal(fp.error, undefined, "fingerprint with global scope");
		assert.ok(ranSub(fp, "ls-files") && ranSub(fp, "status"), "fingerprint reached ls-files and status");
	} finally { process.env.GIT_CONFIG_GLOBAL = saved; }
});

// ---- Primary-only fsmonitor: removal runs with cwd = primary, so a setting visible only from the primary (its local/worktree config or a primary-conditional include) must also refuse; the target view stays empty ----
const PRIMARY_INCLUDE = (cond: string, body: (t: Task, m: string) => string): ((t: Task, m: string) => void) => (t, m) => {
	const f = path.join(root, `pinc-${++n}.cfg`);
	fs.writeFileSync(f, body(t, m));
	const key = `includeIf.${cond}.path`;
	includeKeys.push(key);
	git(PRIMARY, "config", "--add", key, slash(f));
};
const hookBody = (t: Task, m: string) => `[core]\n\tfsmonitor = ${monitorCmd(m, t.dir).replace(/\\/g, "/").replace(/"/g, '\\"')}\n`;
const PRIMARY_ONLY: Record<string, (t: Task, marker: string) => void> = {
	"primary config.worktree hook": (t, m) => { git(PRIMARY, "config", "extensions.worktreeConfig", "true"); git(PRIMARY, "config", "--worktree", "core.fsmonitor", monitorCmd(m, t.dir)); },
	"primary config.worktree false": () => { git(PRIMARY, "config", "extensions.worktreeConfig", "true"); git(PRIMARY, "config", "--worktree", "core.fsmonitor", "false"); },
	"primary includeIf gitdir hook": PRIMARY_INCLUDE(`gitdir:${PRIMARY}/.git`, hookBody),
	"primary includeIf onbranch:main hook": PRIMARY_INCLUDE("onbranch:main", hookBody),
};
for (const [name, configure] of Object.entries(PRIMARY_ONLY)) {
	test(`F1 primary-only (${name}): target preflight passes yet mint refuses; after mint the guard denies and pending retains; nothing runs, bytes preserved`, () => {
		unsetLocal();
		assert.equal(primaryDirty(), "", "fixture primary starts clean (no contamination)");
		const t = makeTask();
		const marker = `${root}/marker-primary-${n}`;
		fs.rmSync(marker, { force: true });
		try {
			// Control, before mint: the clean primary mints and is READY.
			const s = setup();
			assert.equal(mint(s.t).res.ok, true, "positive control: clean primary mints");
			configure(t, marker);
			configure(s.t, marker);
			assert.notEqual(primaryDirty(), "", "the primary really carries the setting");
			assert.doesNotThrow(() => F.preflight(t.dir), "gap: the target-only preflight cannot see a primary-only setting");
			// Before mint.
			const minted = mint(t).res;
			const probe = (d: Task) => { const before = shellRuns; const x = execAllowed(d); return `ALLOWED; permitted removal ran (exit ${x.status}); runs ${shellRuns - before}; monitorRan=${fs.existsSync(marker)}; checkoutGone=${!fs.existsSync(d.dir)}`; };
			assert.equal(minted.ok, false, `mint refuses: ${minted.ok ? probe(t) : "n/a"}`);
			// After mint (grant minted before the setting existed).
			const runsBefore = shellRuns;
			const verdict = run(guardOf(s.child, live(view(s.t))), REMOVE(s.t.dir));
			assert.ok(blocked(verdict), `guard denies: ${blocked(verdict) ? "n/a" : probe(s.t)}`);
			assert.equal(shellRuns, runsBefore, "no shell invocation");
			assert.equal(mint(s.t).res.ok, false, "a fresh mint refuses (shared verifyCleanup)");
			assert.ok(!fs.existsSync(marker), "the monitor never ran");
			for (const d of [t.dir, s.t.dir]) { assert.ok(fs.existsSync(d) && !fs.existsSync(`${d}/ignored`), "checkout untouched"); assert.equal(fs.readFileSync(`${d}/a.txt`, "utf8"), "a\n"); }
		} finally { unsetLocal(); }
	});
}

test("F1 primary-only (observation control): a direct disposable removal from the primary really runs a primary-only worktree-config monitor", (tc) => {
	unsetLocal();
	const t = makeTask();
	const marker = `${root}/marker-primary-observe`;
	fs.rmSync(marker, { force: true });
	try {
		PRIMARY_ONLY["primary config.worktree hook"](t, marker);
		assert.doesNotThrow(() => F.preflight(t.dir));
		const res = spawnSync("git", ["worktree", "remove", t.dir], { cwd: PRIMARY, encoding: "utf8", windowsHide: true });
		if (!fs.existsSync(marker)) { tc.skip(`NOT RUN: this Git build does not invoke a primary-only fsmonitor in worktree remove (exit ${res.status})`); return; }
		assert.ok(true);
	} finally { unsetLocal(); }
});

test("F1 primary-only (positive control): a clean primary still allows genuine removal", () => {
	unsetLocal();
	assert.equal(primaryDirty(), "");
	const s = setup();
	assert.equal(run(guardOf(s.child, live(view(s.t))), REMOVE(s.t.dir)), undefined, "guard allows");
	assert.equal(execAllowed(s.t).status, 0);
	assert.ok(!fs.existsSync(s.t.dir), "removed");
});

// ---- F2: slow PR read first, local proof last ----
const MUTATIONS: Record<string, (t: Task) => void> = {
	"new ignored data": (t) => { fs.mkdirSync(`${t.dir}/ignored`, { recursive: true }); fs.writeFileSync(`${t.dir}/ignored/user.db`, "UNIQUE-IGNORED"); },
	"tracked edit": (t) => fs.writeFileSync(`${t.dir}/a.txt`, "UNIQUE-TRACKED\n"),
	"head change": (t) => { git(t.dir, "commit", "-q", "--allow-empty", "-m", "moved"); },
};
const mutating = (t: Task, f: () => void) => ({ ...live(view(t)), ghJson: () => { f(); return view(t); } });
for (const [name, mutate] of Object.entries(MUTATIONS)) {
	test(`F2 ${name} during the live PR read: mint and guard both refuse and the data is preserved`, () => {
		const a = makeTask();
		assert.equal(mint(a, { live: mutating(a, () => mutate(a)) }).res.ok, false, "mint");
		const s = setup();
		assert.ok(blocked(run(guardOf(s.child, mutating(s.t, () => mutate(s.t))), REMOVE(s.t.dir))), "guard");
		for (const t of [a, s.t]) {
			if (name === "new ignored data") assert.equal(fs.readFileSync(`${t.dir}/ignored/user.db`, "utf8"), "UNIQUE-IGNORED");
			else if (name === "tracked edit") assert.equal(fs.readFileSync(`${t.dir}/a.txt`, "utf8"), "UNIQUE-TRACKED\n");
			assert.ok(fs.existsSync(t.dir));
		}
	});
}

test("F3 owner tracker: a claimed reservation survives releaseUnclaimed and clear; only a clean confirmed close (or TTL) releases it", () => {
	const P = "C:/x/worktrees/pi/t";
	const o = new S.OwnerTracker();
	o.reserve(P, Date.now() + 60_000, "id1");
	o.reserve("C:/x/worktrees/pi/u", Date.now() + 60_000, "id2");
	o.markClaimed("id1");
	o.releaseUnclaimed();
	assert.throws(() => o.begin({ workerId: "a", role: "general-worker", cwd: P }), /cleanup/, "claimed stays");
	o.begin({ workerId: "b", role: "general-worker", cwd: "C:/x/worktrees/pi/u" });
	o.clear();
	assert.throws(() => o.begin({ workerId: "c", role: "general-worker", cwd: P }), /cleanup/, "session reset keeps a claimed reservation");
	o.closeClaimed("id1", false);
	assert.throws(() => o.begin({ workerId: "d", role: "general-worker", cwd: P }), /cleanup/, "an aborted or failed close retains until TTL (grandchild state unknown)");
	o.closeClaimed("id1", true);
	o.begin({ workerId: "e", role: "general-worker", cwd: P });
});
