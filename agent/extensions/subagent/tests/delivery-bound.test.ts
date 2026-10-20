// Fingerprint-bound delivery grants (RED first). Opt-in: an unbound grant is byte-for-byte unchanged. Offline: gh is injected, git runs on local fixture repos only.
//   DELIVERY_TEST_SCRATCH=<scratch> node --test agent/extensions/subagent/tests/delivery-bound.test.ts
import assert from "node:assert/strict";
import cpDefault, { spawnSync } from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createHash } from "node:crypto";
import test from "node:test";
import * as core from "../safety-core.ts";
import * as fp from "../candidate-fingerprint.ts";

const C = core as any;
const F = fp as any;
const GH_URL = "https://github.com/acme/widgets.git";
const SCRATCH = fs.realpathSync.native(process.env.DELIVERY_TEST_SCRATCH ?? os.tmpdir());
const root = fs.mkdtempSync(path.join(SCRATCH, "bound-"));
const EMPTY_GITCONFIG = path.join(root, "gitconfig");
fs.writeFileSync(EMPTY_GITCONFIG, "");
process.env.GIT_CONFIG_GLOBAL = EMPTY_GITCONFIG;
process.env.GIT_CONFIG_NOSYSTEM = "1";
const git = (dir: string, ...args: string[]) => {
	const run = spawnSync("git", args, { cwd: dir, encoding: "utf8", windowsHide: true });
	assert.equal(run.status, 0, `git ${args.join(" ")}: ${run.stderr}`);
	return run.stdout.trim();
};
const commit = (repo: string, msg: string) => git(repo, "-c", "user.name=t", "-c", "user.email=t@example.test", "commit", "-q", "-m", msg);
let counter = 0;
// Candidate on feat/x with a committed .gitignore (ignored/ and _evidence/).
function makeRepo(): string {
	const dir = path.join(root, `repo-${++counter}`);
	fs.mkdirSync(dir, { recursive: true });
	git(dir, "init", "-q");
	fs.writeFileSync(path.join(dir, ".gitignore"), "ignored/\n_evidence/\n");
	fs.writeFileSync(path.join(dir, "f.txt"), "aaaa\n");
	git(dir, "add", "-A");
	commit(dir, "init");
	git(dir, "branch", "feat/x");
	git(dir, "checkout", "-q", "feat/x");
	git(dir, "remote", "add", "origin", GH_URL);
	return fs.realpathSync.native(dir);
}
const write = (repo: string, name: string, text: string) => { fs.mkdirSync(path.dirname(path.join(repo, name)), { recursive: true }); fs.writeFileSync(path.join(repo, name), text); };
const headOf = (repo: string) => git(repo, "rev-parse", "HEAD");
const bindingOf = (repo: string, over: Record<string, unknown> = {}) => ({ role: C.LEASE_ROLE, candidate: repo, pushUrl: GH_URL, repo: "acme/widgets", branch: "feat/x", base: "main", ...over });
const boundBinding = (repo: string, opts: Record<string, unknown> = {}, over: Record<string, unknown> = {}) => bindingOf(repo, { bound: C.bindDelivery(repo, "feat/x", opts), ...over });
const T0 = Date.parse("2030-01-01T00:00:00.000Z");
const newStore = () => C.createGrantStore(() => T0);
const views: Record<string, any> = {};
const live = (over: Record<string, unknown> = {}) => ({
	env: () => ({}),
	pushUrl: (c: string, b: string) => C.livePushUrl(c, b),
	ghJson: (args: string[]) => {
		if (args[0] === "pr" && args[1] === "view") return views[args[2]];
		if (args[0] === "pr" && args[1] === "list") return [{ number: 12, mergeCommit: { oid: "fedcba9876543210fedcba9876543210fedcba98" }, mergedAt: new Date(T0 + 1000).toISOString(), isCrossRepository: false, headRefName: "feat/x", baseRefName: "main" }];
		throw new Error("unexpected gh");
	},
	tagStatus: () => 2,
	...over,
});
const run = (store: unknown, repo: string, command: string, over: Record<string, unknown> = {}) => C.guardToolCall({ scope: "child", store, agentDir: path.join(root, "agent"), live: live(over) }, "bash", { command }, repo);
const blocked = (v: unknown) => (v as { block?: boolean } | undefined)?.block === true;
// Command text is assembled so this source never contains a literal publish command.
const PUSH = ["git", "push", "origin", "feat/x"].join(" ");
const mergeCmd = (sha: string) => ["gh", "pr", "merge", `12 --repo acme/widgets --squash --match-head-commit ${sha}`].join(" ");
const RELEASE = ["gh", "release", "create", "v1.2.3 --repo acme/widgets --target fedcba9876543210fedcba9876543210fedcba98 --title \"R\" --generate-notes"].join(" ");
const CREATE = ["gh", "pr", "create", `--repo acme/widgets --base main --head feat/x --title "T" --body "B"`].join(" ");
const setView = (sha: string) => { views[12] = { state: "OPEN", baseRefName: "main", headRefName: "feat/x", headRefOid: sha, isCrossRepository: false }; };

test("unbound grant is byte-for-byte unchanged: no bound field, no deliveryBound key, same record semantics", () => {
	const repo = makeRepo();
	const store = newStore();
	const rec = store.addDeliveryGrant(bindingOf(repo));
	assert.equal("bound" in rec, false);
	const text = C.serializeGrants([], [], [rec]);
	assert.deepEqual(Object.keys(JSON.parse(text)).sort(), ["delivery", "grants", "v"]);
	assert.equal(run(store, repo, PUSH), undefined);
	write(repo, "new.txt", "x\n");
	assert.equal(run(store, repo, PUSH), undefined, "unbound grants do not care about local state");
});

test("production fingerprint helper: deterministic, typed, bounded", () => {
	const repo = makeRepo();
	const a = F.candidateFingerprint(repo);
	assert.equal(a.value, F.candidateFingerprint(repo).value);
	assert.equal(a.head, headOf(repo));
	write(repo, "f.txt", "bbbb\n");
	assert.notEqual(F.candidateFingerprint(repo).value, a.value);
	const absent = () => { throw Object.assign(new Error("x"), { code: "ENOENT" }); };
	assert.throws(() => F.candidateFingerprint(repo, [], { status: Buffer.from(Array.from({ length: 6000 }, (_, i) => ` D f${i}\0`).join("")), lstat: absent }), /limit/i, "record cap");
	assert.throws(() => F.candidateFingerprint(repo, [], { maxBytes: 3 }), /limit/i, "byte cap");
});

test("bindDelivery refuses detached HEAD, another branch, UNSUPPORTED entries, bad or tracked excludes and expect mismatch", () => {
	const repo = makeRepo();
	const ok = C.bindDelivery(repo, "feat/x", {});
	assert.equal(ok.head, headOf(repo));
	assert.equal(ok.ref, "refs/heads/feat/x");
	assert.match(ok.fingerprint, /^[0-9a-f]{64}$/);
	assert.deepEqual(ok.exclude, []);
	assert.equal(C.bindDelivery(repo, "feat/x", { expect: ok.fingerprint }).fingerprint, ok.fingerprint);
	assert.throws(() => C.bindDelivery(repo, "feat/x", { expect: "0".repeat(64) }), /expected fingerprint/);
	assert.throws(() => C.bindDelivery(repo, "feat/x", { expect: "xyz" }), /expect/);
	git(repo, "branch", "feat/y");
	assert.throws(() => C.bindDelivery(repo, "feat/y", {}), /checked out|attached/i);
	for (const bad of [["../x"], [".git"], [".git/hooks"], ["/abs"], ["C:/abs"], [""], ["."], ["a\\b"], ["f.txt"], Array.from({ length: 9 }, (_, i) => `d${i}`)]) assert.throws(() => C.bindDelivery(repo, "feat/x", { exclude: bad }), undefined, JSON.stringify(bad));
	assert.deepEqual(C.bindDelivery(repo, "feat/x", { exclude: ["out/", "build", "out"] }).exclude, ["build", "out"], "normalized, sorted, deduplicated");
	const nested = path.join(repo, "nested");
	fs.mkdirSync(nested);
	git(nested, "init", "-q");
	write(repo, "nested/inner.txt", "x\n");
	assert.throws(() => C.bindDelivery(repo, "feat/x", {}), /unsupported/i);
	fs.rmSync(nested, { recursive: true, force: true });
	git(repo, "checkout", "-q", "--detach");
	assert.throws(() => C.bindDelivery(repo, "feat/x", {}), /checked out|attached/i);
});

test("push, merge and release are allowed on the exact bound state and refused after every kind of change; PR create/edit are unchecked", { timeout: 120_000 }, () => {
	const mutations: Array<[string, (r: string) => void]> = [
		["new commit", (r) => { write(r, "g.txt", "g\n"); git(r, "add", "g.txt"); commit(r, "more"); }],
		["unstaged edit", (r) => write(r, "f.txt", "zzzz\n")],
		["staged-only edit", (r) => { write(r, "f.txt", "bbbb\n"); git(r, "add", "f.txt"); write(r, "f.txt", "aaaa\n"); }],
		["untracked file", (r) => write(r, "new.txt", "x\n")],
		["deleted file", (r) => fs.rmSync(path.join(r, "f.txt"))],
		["branch switch", (r) => git(r, "checkout", "-q", "-b", "elsewhere")],
	];
	for (const [name, mutate] of mutations) {
		const repo = makeRepo();
		const store = newStore();
		store.addDeliveryGrant(boundBinding(repo, {}, { version: "v1.2.3" }));
		setView(headOf(repo));
		assert.equal(run(store, repo, PUSH), undefined, `${name}: push fresh`);
		assert.equal(run(store, repo, mergeCmd(headOf(repo))), undefined, `${name}: merge fresh`);
		assert.equal(run(store, repo, RELEASE), undefined, `${name}: release fresh`);
		const bound = store.copyDelivery(repo)[0].bound;
		mutate(repo);
		setView(headOf(repo));
		for (const [label, cmd] of [["push", PUSH], ["merge", mergeCmd(headOf(repo))], ["release", RELEASE]]) assert.ok(blocked(run(store, repo, cmd)), `${name}: ${label} stale`);
		assert.equal(run(store, repo, CREATE), undefined, `${name}: PR create is not fingerprint-checked`);
		assert.deepEqual(store.copyDelivery(repo)[0].bound, bound, `${name}: use never rebinds`);
	}
});

test("legitimate metadata does not invalidate: ref updates, upstream, ignored files, _evidence output; excluded untracked output is allowed but staging into it is not", () => {
	const repo = makeRepo();
	const store = newStore();
	store.addDeliveryGrant(boundBinding(repo));
	git(repo, "update-ref", "refs/remotes/origin/feat/x", headOf(repo));
	git(repo, "config", "branch.feat/x.remote", "origin");
	write(repo, "ignored/log.txt", "1\n");
	write(repo, "_evidence/r/out.md", "1\n");
	assert.equal(run(store, repo, PUSH), undefined);
	const store2 = newStore();
	store2.addDeliveryGrant(boundBinding(repo, { exclude: ["out"] }));
	write(repo, "out/a.txt", "1\n");
	assert.equal(run(store2, repo, PUSH), undefined, "excluded untracked output");
	git(repo, "add", "-f", "out/a.txt");
	assert.ok(blocked(run(store2, repo, PUSH)), "staging into an excluded dir changes the unfiltered staged digest");
});

test("merge needs --match-head-commit equal to the bound HEAD", () => {
	const repo = makeRepo();
	const store = newStore();
	store.addDeliveryGrant(boundBinding(repo));
	const other = "1".repeat(40);
	setView(other);
	assert.ok(blocked(run(store, repo, mergeCmd(other))));
	setView(headOf(repo));
	assert.equal(run(store, repo, mergeCmd(headOf(repo))), undefined);
});

test("fail closed: injected reader errors and UNSUPPORTED entries refuse this grant; another unbound grant independently still allows", () => {
	const repo = makeRepo();
	const only = newStore();
	only.addDeliveryGrant(boundBinding(repo));
	const both = newStore();
	both.addDeliveryGrant(boundBinding(repo));
	both.addDeliveryGrant(bindingOf(repo, { base: "dev" }));
	assert.ok(blocked(run(only, repo, PUSH, { bound: () => { throw new Error("git read failure"); } })));
	const nested = path.join(repo, "nested");
	fs.mkdirSync(nested);
	git(nested, "init", "-q");
	write(repo, "nested/inner.txt", "x\n");
	assert.ok(blocked(run(only, repo, PUSH)), "UNSUPPORTED record");
	assert.equal(run(both, repo, PUSH), undefined, "binding constrains only its own grant");
});

test("store: bound identity separates records; new bound state replaces the older bound record only; unbound untouched", () => {
	const repo = makeRepo();
	const store = newStore();
	const first = store.addDeliveryGrant(boundBinding(repo));
	assert.equal(store.addDeliveryGrant(boundBinding(repo)).issuedAt, first.issuedAt);
	assert.equal(store.deliveryCount(), 1);
	assert.equal(store.findDelivery(bindingOf(repo)), undefined, "unbound request never matches a bound record");
	store.addDeliveryGrant(bindingOf(repo));
	assert.equal(store.deliveryCount(), 2);
	assert.equal(store.findDelivery(boundBinding(repo))?.bound.head, first.bound.head);
	write(repo, "n.txt", "n\n");
	store.addDeliveryGrant(boundBinding(repo));
	assert.equal(store.deliveryCount(), 2, "replaced, not appended");
	const all = store.listDelivery();
	assert.equal(all.filter((d: any) => d.bound).length, 1);
	assert.notEqual(all.find((d: any) => d.bound).bound.fingerprint, first.bound.fingerprint);
	assert.equal(all.filter((d: any) => !d.bound).length, 1);
});

test("envelope: bound records use the separate deliveryBound key; round trip; shape tampering fails closed", () => {
	const repo = makeRepo();
	const store = newStore();
	store.addDeliveryGrant(bindingOf(repo, { base: "dev" }));
	store.addDeliveryGrant(boundBinding(repo));
	const records = store.copyDelivery(repo);
	const text = C.serializeGrants([], [], records);
	const env = JSON.parse(text);
	assert.equal(env.v, 1);
	assert.equal(env.delivery.length, 1);
	assert.equal(env.deliveryBound.length, 1);
	assert.ok(env.delivery.every((r: any) => !("bound" in r)), "an old loader that ignores deliveryBound never sees a bound record as unbound");
	assert.deepEqual(C.loadChildDelivery(text).map((r: any) => r.base).sort(), ["dev", "main"]);
	assert.deepEqual(C.loadChildDelivery(text).find((r: any) => r.bound), records.find((r: any) => r.bound));
	const edit = (fn: (e: any) => void) => { const e = JSON.parse(text); fn(e); return JSON.stringify(e); };
	const cases: Array<[string, (e: any) => void]> = [
		["bound inside delivery", (e) => { e.delivery.push(e.deliveryBound[0]); }],
		["unbound inside deliveryBound", (e) => { delete e.deliveryBound[0].bound; }],
		["missing fingerprint", (e) => { delete e.deliveryBound[0].bound.fingerprint; }],
		["bad head", (e) => { e.deliveryBound[0].bound.head = "abc"; }],
		["ref not the branch", (e) => { e.deliveryBound[0].bound.ref = "refs/heads/other"; }],
		["unknown bound key", (e) => { e.deliveryBound[0].bound.extra = 1; }],
		["bad exclude", (e) => { e.deliveryBound[0].bound.exclude = ["../x"]; }],
		["deliveryBound not a list", (e) => { e.deliveryBound = {}; }],
	];
	for (const [name, fn] of cases) assert.throws(() => C.loadChildDelivery(edit(fn)), undefined, name);
	// A tampered but well-formed fingerprint is not trusted: the child recomputes and it simply fails at use.
	const tampered = C.loadChildDelivery(edit((e) => { e.deliveryBound[0].bound.fingerprint = "0".repeat(64); }));
	const child = newStore();
	child.importDelivery(tampered.filter((r: any) => r.bound));
	assert.ok(blocked(run(child, repo, PUSH)));
});

test("hygiene: candidate git config cannot run programs; argv is hardened and runs from a neutral cwd", () => {
	const repo = makeRepo();
	const marker = path.join(root, `marker-${counter}.txt`).split(path.sep).join("/");
	const hook = path.join(root, `hook-${counter}.sh`).split(path.sep).join("/");
	fs.writeFileSync(hook, `#!/bin/sh\necho ran >> "${marker}"\nexit 0\n`);
	git(repo, "config", "core.fsmonitor", hook);
	write(repo, "a.bin", "bin\n");
	write(repo, ".gitattributes", "*.bin diff=evil\n");
	git(repo, "config", "diff.evil.textconv", hook);
	git(repo, "add", "a.bin");
	git(repo, "config", "diff.external", hook);
	fs.rmSync(marker, { force: true });
	const calls: Array<{ file: string; args: string[]; cwd?: string }> = [];
	const cp = cpDefault as any;
	const original = cp.execFileSync;
	cp.execFileSync = (file: string, args: string[], options: any) => { calls.push({ file, args, cwd: options?.cwd }); return original(file, args, options); };
	syncBuiltinESMExports();
	try { F.candidateFingerprint(repo); } finally { cp.execFileSync = original; syncBuiltinESMExports(); }
	assert.equal(fs.existsSync(marker), false, "fsmonitor/textconv/ext-diff from the candidate config ran nothing");
	if (process.versions.bun) return; // Bun does not route the child_process namespace patch: the behavioral assertion above still ran; argv assertions run under node
	assert.ok(calls.length >= 3);
	for (const c of calls) {
		assert.equal(c.file, "git");
		assert.ok(c.args.includes("--no-optional-locks"), c.args.join(" "));
		assert.ok(c.args.join(" ").includes("-c core.fsmonitor=false"), c.args.join(" "));
		assert.equal(c.args[0], "-C");
		assert.ok(path.isAbsolute(String(c.cwd)) && !path.resolve(String(c.cwd)).toLowerCase().startsWith(repo.toLowerCase()), "neutral cwd");
	}
	const diff = calls.find((c) => c.args.includes("diff"));
	for (const flag of ["--cached", "--binary", "--no-renames", "--no-ext-diff", "--no-textconv"]) assert.ok(diff?.args.includes(flag), flag);
});

test("planPushRequest: a bound delivery is not covered-by-delivery (it could refuse later); an unbound one still is; commits never covered", () => {
	const repo = makeRepo();
	const target = { candidate: repo, pushUrl: GH_URL, branch: "feat/x" };
	const store = newStore();
	store.addDeliveryGrant(boundBinding(repo));
	assert.deepEqual(C.planPushRequest(store, target, { commits: false }), { action: "ask" });
	store.addDeliveryGrant(bindingOf(repo));
	assert.deepEqual(C.planPushRequest(store, target, { commits: false }), { action: "covered-by-delivery" });
	assert.deepEqual(C.planPushRequest(store, target, { commits: true }), { action: "ask" });
});

test("status labels a bound grant honestly and secret-free; README states the limits", () => {
	const repo = makeRepo();
	const store = newStore();
	const rec = store.addDeliveryGrant(boundBinding(repo));
	const text = C.authorizationStatus(store, T0);
	assert.match(text, new RegExp(`bound: HEAD ${rec.bound.head.slice(0, 7)}, fp ${rec.bound.fingerprint.slice(0, 12)}, excl 0 \\(not rechecked in status\\)`));
	assert.doesNotMatch(text, new RegExp(rec.bound.fingerprint));
	assert.match(text, /binding constrains only this grant/i);
	const readme = fs.readFileSync(path.resolve(import.meta.dirname, "..", "README.md"), "utf8");
	for (const needle of [/binding constrains only this grant/i, /unbound/i, /trusted-context/i, /not race-free/i, /deliveryBound/, /ignored files/i, /PR create\/edit are not fingerprint-checked/i, /no pull, checkout or commit/i]) assert.match(readme, needle);
});

// ---- Repair: repository-local filters, linked ancestors, index flags that hide tracked edits. Each was reproduced against the first implementation (REPAIR REPORT).
const asLinkAllowed = (target: string, link: string): boolean => { try { fs.symlinkSync(target, link, "junction"); return true; } catch { return false; } };
const bindFails = (repo: string, re: RegExp) => assert.throws(() => C.bindDelivery(repo, "feat/x"), re);

for (const key of ["clean", "process"]) {
	test(`repository-local ${key} filter is never executed and fails closed (same-size edit)`, () => {
		const repo = makeRepo();
		const marker = path.join(root, `filter-${key}-marker`).replaceAll("\\", "/");
		write(repo, ".gitattributes", "f.txt filter=evil\n");
		git(repo, "add", ".gitattributes");
		commit(repo, "attrs");
		git(repo, "config", `filter.evil.${key}`, `echo ran >> '${marker}'; cat`);
		write(repo, "f.txt", "bbbb\n");
		bindFails(repo, /filter/);
		assert.equal(fs.existsSync(marker), false, "the repository-local program must not run");
	});
}

test("a linked ancestor (junction) is never traversed: tracked parent, untracked parent; ignored links are not walked", () => {
	const outside = path.join(root, "outside-secret");
	fs.mkdirSync(outside);
	fs.writeFileSync(path.join(outside, "f.txt"), "outside private bytes\n");
	const repo = makeRepo();
	write(repo, "dir/f.txt", "tracked\n");
	git(repo, "add", "-A");
	commit(repo, "dir");
	fs.rmSync(path.join(repo, "dir"), { recursive: true });
	if (!asLinkAllowed(outside, path.join(repo, "dir"))) return; // capability: junction creation unavailable
	bindFails(repo, /link/);
	const outsideDigest = createHash("sha256").update(fs.readFileSync(path.join(outside, "f.txt"))).digest("hex");
	try { assert.ok(!JSON.stringify(F.candidateFingerprint(repo)).includes(outsideDigest)); } catch (error) { assert.match(String(error), /link/); }
	fs.unlinkSync(path.join(repo, "dir"));
	git(repo, "checkout", "--", "dir");
	assert.doesNotThrow(() => C.bindDelivery(repo, "feat/x"), "restored real directory binds");
	assert.ok(asLinkAllowed(outside, path.join(repo, "lnk")));
	bindFails(repo, /link/); // untracked linked directory: Git's discovery would traverse it
	fs.unlinkSync(path.join(repo, "lnk"));
	assert.ok(asLinkAllowed(outside, path.join(repo, "ignored")));
	assert.doesNotThrow(() => C.bindDelivery(repo, "feat/x"), "an ignored link is not traversed by Git and is not walked");
	fs.unlinkSync(path.join(repo, "ignored"));
});

test("index flags that hide tracked edits fail closed: assume-unchanged, skip-worktree, sparse checkout", () => {
	const repo = makeRepo();
	const store = newStore();
	store.addDeliveryGrant(boundBinding(repo));
	assert.equal(run(store, repo, PUSH), undefined);
	git(repo, "update-index", "--assume-unchanged", "f.txt");
	write(repo, "f.txt", "unreviewed text\n");
	assert.equal(git(repo, "status", "--porcelain=v1"), "", "premise: Git status hides the edit");
	bindFails(repo, /index|hid|assume|skip/i);
	assert.ok(blocked(run(store, repo, PUSH)), "a stale bound grant must not stay fresh");
	git(repo, "update-index", "--no-assume-unchanged", "f.txt");
	git(repo, "update-index", "--skip-worktree", "f.txt");
	bindFails(repo, /index|hid|assume|skip/i);
	git(repo, "update-index", "--no-skip-worktree", "f.txt");
	git(repo, "checkout", "--", "f.txt");
	write(repo, "other/x.txt", "x\n");
	git(repo, "add", "-A");
	commit(repo, "other");
	git(repo, "sparse-checkout", "set", "--cone", "nothing");
	assert.equal(fs.existsSync(path.join(repo, "other", "x.txt")), false, "premise: sparse checkout removed the path");
	bindFails(repo, /index|hid|assume|skip|sparse/i);
	git(repo, "sparse-checkout", "disable");
	assert.doesNotThrow(() => C.bindDelivery(repo, "feat/x"));
});

test("a global (trusted) filter driver is not a repository-local filter and does not block binding", () => {
	const repo = makeRepo();
	const globalFile = path.join(root, "gitconfig-with-filter");
	fs.writeFileSync(globalFile, "[filter \"g\"]\n\tclean = cat\n");
	const previous = process.env.GIT_CONFIG_GLOBAL;
	process.env.GIT_CONFIG_GLOBAL = globalFile;
	try { assert.doesNotThrow(() => C.bindDelivery(repo, "feat/x")); } finally { process.env.GIT_CONFIG_GLOBAL = previous; }
});

// R1: an indexed mode-120000 path replaced by a junction must be refused BEFORE `git status` (Git for Windows would enter it and read outside bytes/.gitignore).
for (const symlinks of ["false", "true"]) {
	test(`tracked symlink replaced by a junction fails closed before status (core.symlinks=${symlinks}), even with child exclusions`, () => {
		if (process.platform !== "win32") return; // POSIX Git never enters links; link-text behavior is covered elsewhere
		const outside = path.join(root, `outside-r1-${symlinks}`);
		fs.mkdirSync(outside);
		fs.writeFileSync(path.join(outside, "private.txt"), "outside private bytes\n");
		fs.writeFileSync(path.join(outside, ".gitignore"), "never-match\n");
		const repo = makeRepo();
		const oid = spawnSync("git", ["hash-object", "-w", "--stdin"], { cwd: repo, input: "target", encoding: "utf8" }).stdout.trim();
		git(repo, "update-index", "--add", "--cacheinfo", `120000,${oid},link`);
		commit(repo, "tracked link");
		git(repo, "config", "core.symlinks", symlinks);
		if (!asLinkAllowed(outside, path.join(repo, "link"))) return; // capability: junction creation unavailable
		const original = cpDefault.execFileSync;
		const argvs: string[][] = [];
		(cpDefault as any).execFileSync = (file: string, args: string[], opts: unknown) => { argvs.push(args); return (original as any)(file, args, opts); };
		syncBuiltinESMExports();
		try {
			bindFails(repo, /link|junction/);
			assert.throws(() => C.bindDelivery(repo, "feat/x", { exclude: ["link/private.txt", "link/.gitignore"] }), /link|junction/);
			assert.equal(argvs.some((a) => a.includes("status")), false, "git status must never run (no outside discovery)");
		} finally { (cpDefault as any).execFileSync = original; syncBuiltinESMExports(); fs.unlinkSync(path.join(repo, "link")); }
	});
}
