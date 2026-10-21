// Fingerprint-bound merge grants (mandatory binding) and the fingerprint helper. Offline: gh is injected, git runs on local fixture repos only.
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
const RELEASE_SHA = "fedcba9876543210fedcba9876543210fedcba98";
const bindingOf = (repo: string, over: Record<string, unknown> = {}) => ({ role: C.LEASE_ROLE, candidate: repo, pushUrl: GH_URL, repo: "acme/widgets", branch: "feat/x", base: "main", ...over });
// Merge grant: PR + reviewed HEAD SHA + mandatory fingerprint binding (sha === bound.head).
const boundBinding = (repo: string, opts: Record<string, unknown> = {}, over: Record<string, unknown> = {}) => { const bound = C.bindDelivery(repo, "feat/x", opts); return bindingOf(repo, { action: "merge", pr: 12, sha: bound.head, bound, ...over }); };
const releaseBinding = (repo: string, over: Record<string, unknown> = {}) => bindingOf(repo, { action: "release", pr: 12, sha: RELEASE_SHA, version: "v1.2.3", ...over });
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

test("action grants travel under the deliveryActions key only; legacy keys and unbound or combined shapes are refused", () => {
	const repo = makeRepo();
	const store = newStore();
	const rec = store.addDeliveryGrant(boundBinding(repo));
	const text = C.serializeGrants([], [], [rec]);
	assert.deepEqual(Object.keys(JSON.parse(text)).sort(), ["deliveryActions", "grants", "v"]);
	assert.equal(C.loadChildDelivery(text).length, 1);
	assert.throws(() => C.loadChildDelivery(JSON.stringify({ v: 1, grants: [], delivery: [rec] })), /legacy/);
	assert.throws(() => C.loadChildDelivery(JSON.stringify({ v: 1, grants: [], deliveryBound: [rec] })), /legacy/);
	const bound = rec.bound;
	assert.throws(() => store.addDeliveryGrant(bindingOf(repo)), RangeError, "no action");
	assert.throws(() => store.addDeliveryGrant(bindingOf(repo, { action: "merge", pr: 12, sha: bound.head })), RangeError, "unbound merge");
	assert.throws(() => store.addDeliveryGrant(boundBinding(repo, {}, { pr: undefined })), RangeError, "pr-less merge");
	assert.throws(() => store.addDeliveryGrant(boundBinding(repo, {}, { sha: "1".repeat(40) })), RangeError, "sha differs from bound HEAD");
	assert.throws(() => store.addDeliveryGrant(boundBinding(repo, {}, { version: "v1.2.3" })), RangeError, "merge + version");
	assert.throws(() => store.addDeliveryGrant(releaseBinding(repo, { bound })), RangeError, "bound release");
	assert.throws(() => store.addDeliveryGrant(releaseBinding(repo, { pr: undefined })), RangeError, "pr-less release");
	assert.throws(() => store.addDeliveryGrant(releaseBinding(repo, { sha: undefined })), RangeError, "release without target sha");
	assert.throws(() => store.addDeliveryGrant(releaseBinding(repo, { version: undefined })), RangeError, "release without version");
	assert.equal(store.addDeliveryGrant(releaseBinding(repo)).action, "release");
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

test("merge is allowed on the exact bound state and refused after every kind of change; a merge grant never covers push or release", { timeout: 120_000 }, () => {
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
		store.addDeliveryGrant(boundBinding(repo));
		const approved = headOf(repo);
		setView(approved);
		assert.equal(run(store, repo, mergeCmd(approved)), undefined, `${name}: merge fresh`);
		assert.ok(blocked(run(store, repo, PUSH)), `${name}: a merge grant is not a push`);
		assert.ok(blocked(run(store, repo, RELEASE)), `${name}: a merge grant is not a release`);
		const bound = store.copyDelivery(repo)[0].bound;
		mutate(repo);
		setView(headOf(repo));
		assert.ok(blocked(run(store, repo, mergeCmd(headOf(repo)))), `${name}: merge of a drifted candidate`);
		assert.ok(blocked(run(store, repo, mergeCmd(approved))), `${name}: merge of the approved SHA on a drifted candidate`);
		assert.deepEqual(store.copyDelivery(repo)[0].bound, bound, `${name}: use never rebinds`);
	}
});
test("legitimate metadata does not invalidate: ref updates, upstream, ignored files, _evidence output; excluded untracked output is allowed but staging into it is not", () => {
	const repo = makeRepo();
	const store = newStore();
	store.addDeliveryGrant(boundBinding(repo));
	const sha = headOf(repo);
	setView(sha);
	git(repo, "update-ref", "refs/remotes/origin/feat/x", sha);
	git(repo, "config", "branch.feat/x.remote", "origin");
	write(repo, "ignored/log.txt", "1\n");
	write(repo, "_evidence/r/out.md", "1\n");
	assert.equal(run(store, repo, mergeCmd(sha)), undefined);
	const store2 = newStore();
	store2.addDeliveryGrant(boundBinding(repo, { exclude: ["out"] }));
	write(repo, "out/a.txt", "1\n");
	assert.equal(run(store2, repo, mergeCmd(sha)), undefined, "excluded untracked output");
	git(repo, "add", "-f", "out/a.txt");
	assert.ok(blocked(run(store2, repo, mergeCmd(sha))), "staging into an excluded dir changes the unfiltered staged digest");
});
test("merge needs the exact PR, --match-head-commit equal to the approved bound HEAD and the live PR head", () => {
	const repo = makeRepo();
	const store = newStore();
	store.addDeliveryGrant(boundBinding(repo));
	const sha = headOf(repo);
	const other = "1".repeat(40);
	setView(other);
	assert.ok(blocked(run(store, repo, mergeCmd(other))), "other SHA");
	assert.ok(blocked(run(store, repo, mergeCmd(sha))), "live PR head moved after approval");
	setView(sha);
	assert.ok(blocked(run(store, repo, mergeCmd(sha).replace(" 12 ", " 13 "))), "another PR number");
	assert.equal(run(store, repo, mergeCmd(sha)), undefined);
});
test("fail closed: injected reader errors and UNSUPPORTED entries refuse the merge grant", () => {
	const repo = makeRepo();
	const only = newStore();
	only.addDeliveryGrant(boundBinding(repo));
	const sha = headOf(repo);
	setView(sha);
	assert.ok(blocked(run(only, repo, mergeCmd(sha), { bound: () => { throw new Error("git read failure"); } })));
	const nested = path.join(repo, "nested");
	fs.mkdirSync(nested);
	git(nested, "init", "-q");
	write(repo, "nested/inner.txt", "x\n");
	assert.ok(blocked(run(only, repo, mergeCmd(sha))), "UNSUPPORTED record");
});
test("store: SHA and bound identity separate records; a new bound state for the same scope replaces the older one", () => {
	const repo = makeRepo();
	const store = newStore();
	const first = store.addDeliveryGrant(boundBinding(repo));
	assert.equal(store.addDeliveryGrant(boundBinding(repo)).issuedAt, first.issuedAt);
	assert.equal(store.deliveryCount(), 1);
	assert.equal(store.findDelivery(boundBinding(repo))?.bound.head, first.bound.head);
	store.addDeliveryGrant(releaseBinding(repo));
	assert.equal(store.deliveryCount(), 2, "a release approval is a separate record");
	write(repo, "n.txt", "n\n");
	store.addDeliveryGrant(boundBinding(repo));
	assert.equal(store.deliveryCount(), 2, "same SHA, new fingerprint: replaced, not appended");
	const all = store.listDelivery();
	assert.notEqual(all.find((d: any) => d.action === "merge").bound.fingerprint, first.bound.fingerprint);
	assert.equal(all.filter((d: any) => d.action === "release").length, 1);
});
test("envelope: records round trip under deliveryActions; shape tampering fails closed", () => {
	const repo = makeRepo();
	const store = newStore();
	store.addDeliveryGrant(releaseBinding(repo));
	store.addDeliveryGrant(boundBinding(repo));
	const records = store.copyDelivery(repo);
	const text = C.serializeGrants([], [], records);
	const env = JSON.parse(text);
	assert.equal(env.v, 1);
	assert.equal(env.deliveryActions.length, 2);
	assert.equal("delivery" in env || "deliveryBound" in env, false, "an old loader sees no grant at all");
	assert.deepEqual(C.loadChildDelivery(text).find((r: any) => r.bound), records.find((r: any) => r.bound));
	const merge = (e: any) => e.deliveryActions.find((r: any) => r.action === "merge");
	const edit = (fn: (e: any) => void) => { const e = JSON.parse(text); fn(e); return JSON.stringify(e); };
	const cases: Array<[string, (e: any) => void]> = [
		["merge without bound", (e) => { delete merge(e).bound; }],
		["missing fingerprint", (e) => { delete merge(e).bound.fingerprint; }],
		["bad head", (e) => { merge(e).bound.head = "abc"; }],
		["sha differs from bound head", (e) => { merge(e).sha = "1".repeat(40); }],
		["ref not the branch", (e) => { merge(e).bound.ref = "refs/heads/other"; }],
		["unknown bound key", (e) => { merge(e).bound.extra = 1; }],
		["bad exclude", (e) => { merge(e).bound.exclude = ["../x"]; }],
		["merge with version", (e) => { merge(e).version = "v1.2.3"; }],
		["unknown action", (e) => { merge(e).action = "publish"; }],
		["no action", (e) => { delete merge(e).action; }],
		["deliveryActions not a list", (e) => { e.deliveryActions = {}; }],
	];
	for (const [name, fn] of cases) assert.throws(() => C.loadChildDelivery(edit(fn)), undefined, name);
	// A tampered but well-formed fingerprint is not trusted: the child recomputes and it simply fails at use.
	const tampered = C.loadChildDelivery(edit((e) => { merge(e).bound.fingerprint = "0".repeat(64); }));
	const child = newStore();
	child.importDelivery(tampered.filter((r: any) => r.bound));
	const sha = headOf(repo);
	setView(sha);
	assert.ok(blocked(run(child, repo, mergeCmd(sha))));
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

test("planPushRequest: merge and release grants never cover a push or commit", () => {
	const repo = makeRepo();
	const target = { candidate: repo, pushUrl: GH_URL, branch: "feat/x" };
	const store = newStore();
	store.addDeliveryGrant(boundBinding(repo));
	store.addDeliveryGrant(releaseBinding(repo));
	assert.deepEqual(C.planPushRequest(store, target, { commits: false }), { action: "ask" });
	assert.deepEqual(C.planPushRequest(store, target, { commits: true }), { action: "ask" });
});
test("status labels merge and release grants secret-free; README states the limits", () => {
	const repo = makeRepo();
	const store = newStore();
	const rec = store.addDeliveryGrant(boundBinding(repo));
	store.addDeliveryGrant(releaseBinding(repo));
	const text = C.authorizationStatus(store, T0);
	assert.match(text, new RegExp(`- merge: repo acme/widgets, branch feat/x, base main, PR 12, SHA ${rec.sha.slice(0, 7)}, artifact dir none, valid, fp ${rec.bound.fingerprint.slice(0, 12)}, excl 0 \\(not rechecked in status\\)`));
	assert.match(text, /- release: repo acme\/widgets, branch feat\/x, base main, PR 12, SHA fedcba9, version v1\.2\.3, latest no/);
	assert.doesNotMatch(text, new RegExp(rec.bound.fingerprint));
	const readme = fs.readFileSync(path.resolve(import.meta.dirname, "..", "README.md"), "utf8");
	for (const needle of [/not race-free/i, /deliveryActions/, /ignored files/i, /no pull, checkout or commit/i, /legacy/i]) assert.match(readme, needle);
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
	const sha = headOf(repo);
	setView(sha);
	assert.equal(run(store, repo, mergeCmd(sha)), undefined);
	git(repo, "update-index", "--assume-unchanged", "f.txt");
	write(repo, "f.txt", "unreviewed text\n");
	assert.equal(git(repo, "status", "--porcelain=v1"), "", "premise: Git status hides the edit");
	bindFails(repo, /index|hid|assume|skip/i);
	assert.ok(blocked(run(store, repo, mergeCmd(sha))), "a stale bound grant must not stay fresh");
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
