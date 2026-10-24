// Merge and release action grants: strict command grammar, live gates, artifact-file rules, store lifecycle and envelope. Offline: gh and git reads are injected through guard.live; git fixtures are local repos only.
import assert from "node:assert/strict";
import cpDefault from "node:child_process";
import { spawnSync } from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
// Namespace import: a missing export fails inside the test body (behavioral RED), not at link time.
import * as core from "../safety-core.ts";

const C = core as any;
const HOUR = 60 * 60_000;
const LEGACY_TTL = 30 * 60_000; // only as a tamper fixture: an old 30-minute record must be refused
const T0 = Date.parse("2030-01-01T00:00:00.000Z");
const HEAD = "0123456789abcdef0123456789abcdef01234567";
const MERGED = "fedcba9876543210fedcba9876543210fedcba98";
const OLD_MERGED = "1111111111111111111111111111111111111111";
const GH_URL = "https://github.com/acme/widgets.git";
const BOUND = { head: HEAD, ref: "refs/heads/feat/x", fingerprint: "a".repeat(64), exclude: [] as string[] };

// Scratch root: DELIVERY_TEST_SCRATCH (set to the approved implementation scratch path); artifact fixtures sit under worktrees/pi/_evidence so placement is exercised.
const SCRATCH = fs.realpathSync.native(process.env.DELIVERY_TEST_SCRATCH ?? os.tmpdir());
const root = fs.mkdtempSync(path.join(SCRATCH, "delivery-"));
const EMPTY_GITCONFIG = path.join(root, "gitconfig");
fs.writeFileSync(EMPTY_GITCONFIG, "");
process.env.GIT_CONFIG_GLOBAL = EMPTY_GITCONFIG;
process.env.GIT_CONFIG_NOSYSTEM = "1";
const slash = (p: string) => p.replace(/\\/g, "/");
const git = (dir: string, ...args: string[]) => {
	const run = spawnSync("git", args, { cwd: dir, encoding: "utf8", windowsHide: true });
	assert.equal(run.status, 0, `git ${args.join(" ")}: ${run.stderr}`);
	return run.stdout;
};
function makeRepo(name: string): string {
	const dir = path.join(root, name);
	fs.mkdirSync(dir, { recursive: true });
	git(dir, "init", "-q");
	git(dir, "-c", "user.name=t", "-c", "user.email=t@example.test", "commit", "-q", "--allow-empty", "-m", "init");
	git(dir, "branch", "feat/x");
	git(dir, "remote", "add", "origin", GH_URL);
	return fs.realpathSync.native(dir);
}
const CAND = makeRepo("candidate");
const OTHER = makeRepo("other-candidate");
const ART_DIR = path.join(root, "worktrees", "pi", "_evidence", "task-1");
fs.mkdirSync(ART_DIR, { recursive: true });
fs.writeFileSync(path.join(ART_DIR, "pr.md"), "Summary line\nAttribution: M\u00fcller (multi-line UTF-8 stays in the file)\n");
fs.writeFileSync(path.join(ART_DIR, "merge.md"), "Merge note\n");
fs.writeFileSync(path.join(ART_DIR, "notes.md"), "Release notes\n");
const A = slash(fs.realpathSync.native(ART_DIR));
const GUARD_FILE = path.join(import.meta.dirname, "..", "safety-guard-entry.ts");
const AGENT_DIR = path.join(root, "agent");

// Injected live readers (no network, no real gh). views/merged are keyed like gh JSON; undefined means gh returned nothing usable.
const state = { clock: T0, env: {} as Record<string, string>, views: {} as Record<string, any>, mergedViews: {} as Record<string, any>, calls: [] as string[], ghThrow: false, tags: 2, pushUrl: undefined as undefined | ((c: string, b: string) => string | undefined), bound: { ...BOUND } as any };
function resetState() {
	state.clock = T0;
	state.env = {};
	state.ghThrow = false;
	state.tags = 2;
	state.calls = [];
	state.pushUrl = undefined;
	state.bound = { ...BOUND };
	state.views = { 12: { state: "OPEN", baseRefName: "main", headRefName: "feat/x", headRefOid: HEAD, isCrossRepository: false } };
	state.mergedViews = { 12: { number: 12, state: "MERGED", baseRefName: "main", headRefName: "feat/x", isCrossRepository: false, mergeCommit: { oid: MERGED } } };
}
const MERGED_VIEW_FIELDS = "number,state,baseRefName,headRefName,isCrossRepository,mergeCommit";
resetState();
const liveReaders = () => ({
	env: () => state.env,
	pushUrl: (c: string, b: string) => (state.pushUrl ? state.pushUrl(c, b) : C.livePushUrl(c, b)),
	ghJson: (args: string[]) => {
		state.calls.push(args.join(" "));
		if (state.ghThrow) throw new Error("network timeout");
		if (args[0] === "pr" && args[1] === "view") return args.includes(MERGED_VIEW_FIELDS) ? (args.length === 7 && args[3] === "--repo" && args[4] === "acme/widgets" && args[5] === "--json" ? state.mergedViews[args[2]] : (() => { throw new Error(`unexpected merged view call ${args.join(" ")}`); })()) : state.views[args[2]];
		throw new Error(`unexpected gh call ${args.join(" ")}`);
	},
	tagStatus: () => state.tags,
	bound: () => state.bound,
});
const verifyReleaseVia = (store: any) => C.verifyDeliveryTarget(store.findDelivery(bindingOf({ pr: 4242, version: "v1.2.3", artifactDir: A })) ?? bindingOf({ pr: 4242, version: "v1.2.3", artifactDir: A }), liveReaders());
const newStore = () => C.createGrantStore(() => state.clock);
const baseOf = (over: Record<string, unknown> = {}) => ({ role: C.LEASE_ROLE, candidate: CAND, pushUrl: GH_URL, repo: "acme/widgets", branch: "feat/x", base: "main", ...over });
// Release grant: PR + exact tag + target SHA (the merge commit). Merge grant: PR + reviewed HEAD + mandatory bound state (injected reader supplies the live state).
const bindingOf = (over: Record<string, unknown> = {}) => baseOf({ action: "release", pr: 12, sha: MERGED, version: "v1.2.3", ...over });
const mergeOf = (over: Record<string, unknown> = {}) => baseOf({ action: "merge", pr: 12, sha: HEAD, bound: { ...BOUND }, ...over });
function storeWith(over: Record<string, unknown> = {}) {
	const store = newStore();
	store.addDeliveryGrant(bindingOf(over));
	return store;
}
function mergeStore(over: Record<string, unknown> = {}) {
	const store = newStore();
	store.addDeliveryGrant(mergeOf(over));
	return store;
}
const MERGE = `gh pr merge 12 --repo acme/widgets --squash --match-head-commit ${HEAD}`;
const RELEASE = `gh release create v1.2.3 --repo acme/widgets --target ${MERGED} --title "R" --generate-notes`;
const EDIT = `gh pr edit 12 --repo acme/widgets --title "T"`;
const childGuard = (store: unknown) => ({ scope: "child" as const, store, agentDir: AGENT_DIR, live: liveReaders() });
const run = (store: unknown, command: string, cwd = CAND, tool = "bash") => C.guardToolCall(childGuard(store), tool, { command }, cwd);
const blocked = (value: unknown) => (value as { block?: boolean } | undefined)?.block === true;
const isInside = (p: string, dir: string) => { const rel = path.relative(dir, p); return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel)); };
const neutral = (cwd: unknown) => typeof cwd === "string" && path.isAbsolute(cwd) && !isInside(path.resolve(cwd), CAND);
type ExecCall = { file: string; args: string[]; cwd?: string };
// Records the real child_process calls the guard's default live readers make. gh and git ls-remote are answered by the stub (no network, no real gh); other git calls run for real.
function withExecCapture<T>(stub: { gh: (args: string[]) => unknown; lsRemote: () => number }, body: (calls: ExecCall[]) => T): T {
	const cp = cpDefault as any;
	const original = { execFileSync: cp.execFileSync, spawnSync: cp.spawnSync };
	const calls: ExecCall[] = [];
	cp.execFileSync = (file: string, args: string[], options: any) => {
		calls.push({ file, args, cwd: options?.cwd });
		if (file === "gh") return JSON.stringify(stub.gh(args));
		return original.execFileSync(file, args, options);
	};
	cp.spawnSync = (file: string, args: string[], options: any) => {
		calls.push({ file, args, cwd: options?.cwd });
		if (file === "git" && args[0] === "ls-remote") return { status: stub.lsRemote(), signal: null, error: undefined, stdout: "", stderr: "" };
		return original.spawnSync(file, args, options);
	};
	syncBuiltinESMExports();
	try {
		return body(calls);
	} finally {
		cp.execFileSync = original.execFileSync;
		cp.spawnSync = original.spawnSync;
		syncBuiltinESMExports();
	}
}

test("delivery constants: no TTL constant (session-scoped) and the approved accept/refuse grammar", () => {
	assert.equal(C.DELIVERY_TTL_MS, undefined, "delivery is session-scoped: no TTL constant");
	const accepted: Array<[string, string]> = [
		[`gh pr create --repo acme/widgets --base main --head feat/x --title "Add delivery grant" --body "Ships the guard"`, "create"],
		[`gh pr create --repo acme/widgets --base main --head feat/x --title "Add delivery grant" --body-file "${A}/pr.md"`, "create"],
		[`gh pr edit 12 --repo acme/widgets --title "Add delivery grant"`, "edit"],
		[`gh pr edit 12 --repo acme/widgets --title "Add delivery grant" --body-file "${A}/pr.md"`, "edit"],
		[`gh pr merge 12 --repo acme/widgets --squash --match-head-commit ${HEAD}`, "merge"],
		[`gh pr merge 12 --repo acme/widgets --squash --match-head-commit ${HEAD} --subject "Add delivery grant" --body-file "${A}/merge.md"`, "merge"],
		[`gh release create v1.2.3 --repo acme/widgets --target ${MERGED} --title "Release 1.2.3" --notes "Notes" --latest`, "release"],
		[`gh release create v1.2.3 --repo acme/widgets --target ${MERGED} --title "Release 1.2.3" --notes-file "${A}/notes.md"`, "release"],
		[`gh release create v1.2.3 --repo acme/widgets --target ${MERGED} --title "Release 1.2.3" --generate-notes`, "release"],
	];
	for (const [command, kind] of accepted) assert.equal(C.parseDeliveryCommand(command)?.kind, kind, command);
	const rejected = [
		`gh pr create --repo acme/widgets --base main --head feat/x --title Unquoted --body "x"`,
		`gh pr create --repo acme/widgets --base main --head feat/x --title 'Colon: title' --body "x"`,
		`gh pr create --repo acme/widgets --base main --head feat/x --title "Caf\u00e9" --body "x"`,
		`gh pr create --repo acme/widgets --base main --head feat/x --title "T" --body-file "D:\\work\\x.md"`,
		`gh pr create --repo acme/widgets --base main --head feat/x --title "T" --body-file -`,
		`gh pr create --repo acme/widgets --base main --head feat/x --title "T" --body-file "$HOME/x.md"`,
		`gh pr create --repo acme/widgets --base main --head feat/x --title "T" --body-file 'C:/x.md'`,
		`gh pr create --repo acme/widgets --base main --head feat/x --title "T" --body "a" --body-file "C:/x.md"`,
		`gh pr create --repo acme/widgets --base main --head feat/x --title "T" --body "a" --body "b"`,
		`gh pr create --repo acme/widgets --base main --head feat/x --title "T" --body "a" --notes-file "C:/x.md"`,
		`gh pr create --repo acme/widgets --base main --head feat/x --title "T" --body "a" --web`,
		`gh pr create --repo acme/widgets --base main --head acme:feat/x --title "T" --body "a"`,
		`gh pr create --repo acme/widgets --base main --head feat/x --title "T" --body "$(id)"`,
		`gh pr create --repo acme/widgets --base main --head feat/x --title "T" --body "a!"`,
		`gh pr create --repo acme/widgets --base main --head feat/x --title "T;id" --body "a"`,
		`gh pr create --repo acme/widgets --base main --head feat/x --title "T"  --body "x"`,
		`gh pr create --repo acme/widgets --base main --head feat/x --title "T" --body "x" `,
		`gh pr merge 12 --repo acme/widgets --merge --match-head-commit ${HEAD}`,
		`gh pr merge 12 --repo acme/widgets --squash --admin --match-head-commit ${HEAD}`,
		`gh pr merge 12 --repo acme/widgets --squash --match-head-commit main`,
		`gh pr merge 12 --repo acme/widgets --squash --match-head-commit ${HEAD} --notes-file "${A}/merge.md"`,
		`gh pr merge 12 --repo acme/widgets --squash --match-head-commit ${HEAD} --subject "T" --subject "U"`,
		`gh pr edit 12 --repo acme/widgets`,
		`gh pr edit 12 --repo acme/widgets --title "T" --base develop`,
		`gh release create v1.2.3 --repo acme/widgets --target ${MERGED} --title "R" --notes "N" --latest=false`,
		`gh release create v1.2.3 --repo acme/widgets --target ${MERGED} --title "R" --generate-notes --draft`,
		`gh release create v1.2.3 --repo acme/widgets --target main --title "R" --generate-notes`,
		`gh release create v1.2.3 --repo acme/widgets --target ${MERGED} --title "R" --generate-notes ./asset.zip`,
		`gh release create v1.2.3 --repo acme/widgets --target ${MERGED} --title "R" --notes-file "${A}/notes.md" --generate-notes`,
		`gh pr view 12 --repo acme/widgets`,
		`gh pr create --repo acme/widgets --base main --head feat/x --title "T" --body-file "${A}/pr.md" && rm -rf x`,
	];
	for (const command of rejected) assert.equal(C.parseDeliveryCommand(command), undefined, command);
});

test("delivery repo: only github.com origin URL forms derive owner/name", () => {
	assert.equal(C.parseRepoFromPushUrl("https://github.com/acme/widgets.git"), "acme/widgets");
	assert.equal(C.parseRepoFromPushUrl("https://github.com/acme/widgets"), "acme/widgets");
	assert.equal(C.parseRepoFromPushUrl("git@github.com:acme/widgets.git"), "acme/widgets");
	assert.equal(C.parseRepoFromPushUrl("ssh://git@github.com/acme/widgets.git"), "acme/widgets");
	for (const url of ["https://gitlab.com/acme/widgets.git", "https://github.com.evil.test/acme/widgets.git", "https://github.com/acme/widgets/extra", "https://github.com/acme/..", "https://github.com/acme/.git", "https://github.com/-acme/widgets", "https://user:tok@github.com/acme/widgets.git", "git@example.test:acme/widgets.git", "file:///tmp/x"]) assert.equal(C.parseRepoFromPushUrl(url), undefined, url);
});

test("delivery positives: each action grant allows only its own exact command in bash and powershell; the record is not consumed", () => {
	resetState();
	const merge = mergeStore({ artifactDir: A });
	const release = storeWith({ latest: true, artifactDir: A });
	const mergeCmd = `gh pr merge 12 --repo acme/widgets --squash --match-head-commit ${HEAD} --subject "Add delivery grant" --body-file "${A}/merge.md"`;
	const releaseCmd = `gh release create v1.2.3 --repo acme/widgets --target ${MERGED} --title "Release 1.2.3" --notes-file "${A}/notes.md" --latest`;
	for (const tool of ["bash", "powershell"]) {
		assert.equal(run(merge, mergeCmd, CAND, tool), undefined, `${tool} merge`);
		assert.equal(run(release, releaseCmd, CAND, tool), undefined, `${tool} release`);
	}
	assert.ok(state.calls.some((c) => c.startsWith("pr view 12 --repo acme/widgets")), "live PR read used");
	assert.equal(merge.copyDelivery(CAND).length, 1, "delivery is non-consuming");
});

test("separate approvals: a merge grant never releases, a release grant never merges, and neither covers push, create or edit", () => {
	resetState();
	const m = mergeStore();
	const r = storeWith();
	assert.equal(run(m, MERGE), undefined, "merge grant merges");
	assert.ok(blocked(run(m, RELEASE)), "merge grant cannot release");
	assert.equal(run(r, RELEASE), undefined, "release grant releases");
	assert.ok(blocked(run(r, MERGE)), "release grant cannot merge");
	const both = newStore();
	both.addDeliveryGrant(mergeOf());
	both.addDeliveryGrant(bindingOf());
	assert.equal(run(both, MERGE), undefined);
	assert.equal(run(both, RELEASE), undefined);
	for (const store of [m, r, both]) for (const command of [`git push origin feat/x`, `gh pr create --repo acme/widgets --base main --head feat/x --title "T" --body "b"`, EDIT]) assert.ok(blocked(run(store, command)), `no grant carries ${command}`);
	// A grant minted for merge must not become a release by claiming both approvals.
	assert.throws(() => newStore().addDeliveryGrant(mergeOf({ version: "v1.2.3" })), RangeError, "merge+version");
	assert.throws(() => newStore().addDeliveryGrant(bindingOf({ bound: { ...BOUND } })), RangeError, "release+bound");
	assert.throws(() => newStore().addDeliveryGrant(baseOf({ pr: 12, version: "v1.2.3" })), RangeError, "legacy combined shape");
});

test("merge approval needs exact PR + reviewed SHA identity: pr-less, unbound, sha-less and wrong-identity shapes never mint or match", () => {
	resetState();
	for (const [name, over] of [["no pr", { pr: undefined }], ["no sha", { sha: undefined }], ["short sha", { sha: "abc" }], ["no bound", { bound: undefined }], ["sha differs from bound HEAD", { sha: "1".repeat(40) }]] as Array<[string, any]>) assert.throws(() => newStore().addDeliveryGrant(mergeOf(over)), RangeError, name);
	const store = mergeStore();
	assert.equal(run(store, MERGE), undefined, "control");
	assert.ok(blocked(run(store, MERGE.replace(" 12 ", " 13 "))), "another PR");
	assert.ok(blocked(run(store, MERGE.replace(HEAD, "2".repeat(40)))), "another SHA");
	state.views[12] = { ...state.views[12], headRefOid: "2".repeat(40) };
	assert.ok(blocked(run(store, MERGE)), "live PR head differs from the approved SHA");
	state.views[12] = { ...state.views[12], headRefOid: HEAD };
	state.bound = { ...BOUND, fingerprint: "b".repeat(64) };
	assert.ok(blocked(run(store, MERGE)), "candidate fingerprint drift");
	state.bound = { ...BOUND, head: "3".repeat(40) };
	assert.ok(blocked(run(store, MERGE)), "candidate HEAD drift");
	state.bound = { ...BOUND };
	assert.equal(run(store, MERGE), undefined, "back on the approved state");
});

test("release approval needs exact PR, version and target SHA; an existing tag fails closed; no mergedAt fallback", () => {
	resetState();
	for (const [name, over] of [["no pr", { pr: undefined }], ["no sha", { sha: undefined }], ["no version", { version: undefined }], ["bad version", { version: "1.2" }]] as Array<[string, any]>) assert.throws(() => newStore().addDeliveryGrant(bindingOf(over)), RangeError, name);
	const store = storeWith();
	assert.equal(run(store, RELEASE), undefined, "control");
	assert.ok(blocked(run(store, RELEASE.replace(MERGED, OLD_MERGED))), "another target SHA");
	assert.ok(blocked(run(store, RELEASE.replace("v1.2.3", "v9.9.9"))), "another tag");
	for (const tags of [0, 1, -1]) { state.tags = tags; assert.ok(blocked(run(store, RELEASE)), `tag status ${tags} (exists or unreadable)`); }
	state.tags = 2;
	state.mergedViews[12] = { ...state.mergedViews[12], number: 99 };
	assert.ok(blocked(run(store, RELEASE)), "merged PR number differs from the approved PR (mergedAt is never a substitute)");
	state.mergedViews[12] = { ...state.mergedViews[12], mergedAt: new Date(T0 + 99 * HOUR).toISOString(), number: 98 };
	assert.ok(blocked(run(store, RELEASE)), "a later mergedAt does not qualify another PR");
});

test("exact single-use operation grants cannot carry merge or release (no pin or confirmation bypass), alone or in a mixed batch", () => {
	const argv = (cmd: string) => cmd;
	for (const command of [MERGE, argv(`gh pr merge 12 --repo acme/widgets --squash`), argv(`gh pr merge 12 --repo acme/widgets --admin`), RELEASE, argv(`gh release create v1.2.3 --repo acme/widgets`), argv(`bash -c "${MERGE}"`)]) {
		assert.throws(() => C.authorizableOp("shell", command, CAND, AGENT_DIR, true), /delivery action grant/, command);
	}
	assert.throws(() => C.authorizableOp("shell", MERGE, CAND, AGENT_DIR, false), /delivery action grant/, "main scope too");
	assert.ok(C.authorizableOp("shell", `git push origin master`, CAND, AGENT_DIR, true), "other risky operations stay grantable");
});

test("delivery live gates: wrong repo, base, head, branch, PR, cwd, closed, cross or missing PR and drift all block", () => {
	resetState();
	const store = mergeStore({ artifactDir: A });
	assert.equal(run(store, MERGE), undefined, "control");
	const attempts: Array<[string, string]> = [
		[MERGE.replace("acme/widgets", "acme/other"), CAND],
		[MERGE, OTHER],
		[`${MERGE} --body-file "${A}/missing.md"`, CAND],
	];
	for (const [command, cwd] of attempts) assert.ok(blocked(run(store, command, cwd)), `${command} in ${cwd}`);
	const views: Array<[string, any]> = [
		["closed", { state: "CLOSED" }], ["merged", { state: "MERGED" }], ["cross-repository", { isCrossRepository: true }], ["cross-repository missing", { isCrossRepository: undefined }],
		["cross-repository null", { isCrossRepository: null }], ["other head", { headRefName: "feat/y" }], ["other base", { baseRefName: "release" }],
	];
	for (const [name, patch] of views) {
		resetState();
		state.views[12] = { ...state.views[12], ...patch };
		assert.ok(blocked(run(store, MERGE)), name);
	}
	resetState();
	state.views = {};
	assert.ok(blocked(run(store, MERGE)), "PR not found");
	resetState();
	const drift = { ...childGuard(store), live: { ...liveReaders(), pushUrl: () => "https://github.com/acme/other.git" } };
	assert.ok(blocked(C.guardToolCall(drift, "bash", { command: MERGE }, CAND)), "live push URL drift");
});

test("delivery failures: gh throws or returns no JSON, GH_HOST/GH_REPO, compound commands, dot-dot artifacts, main scope and another candidate block; a 3 hour clock advance keeps a live session record", () => {
	resetState();
	const store = mergeStore({ artifactDir: A });
	assert.equal(run(store, MERGE), undefined, "control");
	state.ghThrow = true;
	assert.ok(blocked(run(store, MERGE)), "gh throws or times out");
	state.ghThrow = false;
	state.views[12] = undefined;
	assert.ok(blocked(run(store, MERGE)), "gh returns no usable JSON");
	resetState();
	state.env = { GH_HOST: "ghe.example.test" };
	assert.ok(blocked(run(store, MERGE)), "GH_HOST present");
	state.env = { GH_REPO: "acme/other" };
	assert.ok(blocked(run(store, MERGE)), "GH_REPO present");
	resetState();
	assert.ok(blocked(run(store, `${MERGE} && rm -rf x`)), "compound command");
	assert.ok(blocked(run(store, `echo x; ${MERGE}`)), "leading compound");
	assert.ok(blocked(run(store, `${MERGE} --body-file "${A}/../x.md"`)), "dot-dot artifact");
	assert.ok(blocked(C.guardToolCall({ scope: "main", store, agentDir: AGENT_DIR, live: liveReaders() }, "bash", { command: MERGE }, CAND)), "main scope never uses delivery");
	assert.ok(blocked(run(newStore(), MERGE)), "no delivery copy in this child");
	const other = mergeStore({ candidate: OTHER });
	assert.ok(blocked(run(other, MERGE, CAND)), "record bound to another candidate");
	state.clock = T0 + 3 * HOUR;
	assert.equal(run(store, MERGE), undefined, "session delivery stays live after 3 hours (no time expiry)");
});
test("structural trusted context never merges: standard merge blocks without an explicit grant", () => {
    resetState();
    const repo = makeRepo("trusted-merge");
    git(repo, "checkout", "-q", "feat/x");
    git(repo, "-c", "user.name=t", "-c", "user.email=t@example.test", "commit", "-q", "--allow-empty", "-m", "feature");
    const head = git(repo, "rev-parse", "HEAD").trim();
    assert.match(head, /^[0-9a-f]{40}$/);
    state.views = { 12: { state: "OPEN", baseRefName: "main", headRefName: "feat/x", headRefOid: head, isCrossRepository: false } };
    const command = `gh pr merge 12 --repo acme/widgets --squash --match-head-commit ${head}`;
    assert.equal(C.parseDeliveryCommand(command)?.kind, "merge", "test command must parse before behavior assertion");
    const target = { candidate: repo, pushUrl: GH_URL, branch: "feat/x" };
    const trusted = { scope: "child" as const, store: newStore(), agentDir: AGENT_DIR, pushTarget: target, gateCommits: true, live: liveReaders() };
    const runTrusted = (cmd = command) => C.guardToolCall(trusted, "bash", { command: cmd }, repo);
    assert.ok(blocked(runTrusted()), "matching live PR still blocks: merge has no automatic path");
    for (const [name, view, cmd] of [
        ["stale SHA", { ...state.views[12], headRefOid: HEAD }, command],
        ["wrong repo", state.views[12], command.replace("acme/widgets", "other/repo")],
        ["closed PR", { ...state.views[12], state: "CLOSED" }, command],
        ["fork PR", { ...state.views[12], isCrossRepository: true }, command],
        ["wrong head", { ...state.views[12], headRefName: "feat/other" }, command],
        ["equal base", { ...state.views[12], baseRefName: "feat/x" }, command],
    ] as Array<[string, any, string]>) {
        state.views = { 12: view };
        assert.ok(runTrusted(cmd), name);
    }
    state.views = {};
    assert.ok(runTrusted(), "missing live PR read blocks");
});

test("structural trusted context does not merge even with an approved-group body file", () => {
    resetState();
    const repo = makeRepo("feat");
    git(repo, "checkout", "-q", "feat/x");
    git(repo, "-c", "user.name=t", "-c", "user.email=t@example.test", "commit", "-q", "--allow-empty", "-m", "feature");
    const head = git(repo, "rev-parse", "HEAD").trim();
    state.views = { 12: { state: "OPEN", baseRefName: "main", headRefName: "feat/x", headRefOid: head, isCrossRepository: false } };
    const group = path.join(path.dirname(repo), "worktrees", path.basename(repo));
    const scratch = path.join(group, "_scratch", "pr-create-friction");
    fs.mkdirSync(scratch, { recursive: true });
    const bodyFile = path.join(scratch, "approved-body.md");
    fs.writeFileSync(bodyFile, "A safe merge note.\\n");
    const command = `gh pr merge 12 --repo acme/widgets --squash --match-head-commit ${head} --body-file "${slash(bodyFile)}"`;
    assert.equal(C.parseDeliveryCommand(command)?.kind, "merge", "test command must parse before behavior assertion");
    const target = { candidate: repo, pushUrl: GH_URL, branch: "feat/x" };
    const trusted = { scope: "child" as const, store: newStore(), agentDir: AGENT_DIR, pushTarget: target, gateCommits: true, live: liveReaders() };
    assert.ok(blocked(C.guardToolCall(trusted, "bash", { command }, repo)), "approved-group merge body file still blocks without an explicit grant");
});

test("structural trusted context refuses a merge with an outside-group credential body file", () => {
    resetState();
    const repo = makeRepo("trusted-merge-body-file");
    git(repo, "checkout", "-q", "feat/x");
    git(repo, "-c", "user.name=t", "-c", "user.email=t@example.test", "commit", "-q", "--allow-empty", "-m", "feature");
    const head = git(repo, "rev-parse", "HEAD").trim();
    state.views = { 12: { state: "OPEN", baseRefName: "main", headRefName: "feat/x", headRefOid: head, isCrossRepository: false } };
    const outside = path.join(root, "outside.json");
    fs.writeFileSync(outside, "token=synthetic-credential\\n");
    const command = `gh pr merge 12 --repo acme/widgets --squash --match-head-commit ${head} --body-file "${slash(outside)}"`;
    const target = { candidate: repo, pushUrl: GH_URL, branch: "feat/x" };
    const trusted = { scope: "child" as const, store: newStore(), agentDir: AGENT_DIR, pushTarget: target, gateCommits: true, live: liveReaders() };
    assert.ok(blocked(C.guardToolCall(trusted, "bash", { command }, repo)), "outside-group credential file must be refused");
});

test("delivery artifacts: only an approved md/txt regular file inside the approved directory is read; escapes, bad content and secret-like text block", () => {
	resetState();
	const store = mergeStore({ artifactDir: A });
	const merge = (file: string) => `${MERGE} --body-file "${file}"`;
	assert.equal(run(store, merge(`${A}/pr.md`)), undefined, "control inside the directory");
	const outside = path.join(root, "outside");
	fs.mkdirSync(outside, { recursive: true });
	fs.writeFileSync(path.join(outside, "x.md"), "outside\n");
	fs.writeFileSync(path.join(ART_DIR, "bad.json"), "{}\n");
	fs.writeFileSync(path.join(ART_DIR, "empty.md"), "");
	fs.writeFileSync(path.join(ART_DIR, "big.md"), "a".repeat(65537));
	fs.writeFileSync(path.join(ART_DIR, "nul.md"), "a\u0000b\n");
	fs.writeFileSync(path.join(ART_DIR, "cred.md"), "token=abc123\n");
	fs.mkdirSync(path.join(ART_DIR, "adir.md"), { recursive: true });
	fs.linkSync(path.join(outside, "x.md"), path.join(ART_DIR, "hard.md"));
	const bad = [`${slash(path.join(outside, "x.md"))}`, `${A}/../outside/x.md`, `${A}/bad.json`, `${A}/pr`, `${A}/adir.md`, `${A}/missing.md`, `${A}/empty.md`, `${A}/big.md`, `${A}/nul.md`, `${A}/cred.md`, `${A}/hard.md`, `${A}/./pr.md`, `${A}//pr.md`];
	for (const file of bad) assert.ok(blocked(run(store, merge(file))), file);
	assert.ok(blocked(run(mergeStore({}), merge(`${A}/pr.md`))), "file form blocked without an approved artifact directory");
	assert.equal(C.checkArtifactFile(`${A}/pr.md`, A), undefined, "direct check control");
});
test("artifact directory at approval: placement, existence, no alias and no containment with the candidate are enforced", () => {
	assert.equal(C.validateArtifactDir(A, CAND), A, "approved directory is accepted");
	const refuse = [`${slash(root)}/plain`, `C:/`, `${slash(CAND)}/_evidence/t1`, slash(path.dirname(CAND)), "relative/worktrees/pi/_evidence/t", `${A}/..`, `${A}\\pr`, `${A}/pr.md`, `${A}/`, `${A}/\u00e9`];
	for (const input of refuse) assert.throws(() => C.validateArtifactDir(input, CAND), RangeError, input);
});

test("artifact junction escape: a junction inside the artifact directory is refused as an alias or link escape", (t) => {
	resetState();
	const target = path.join(root, "junction-target");
	fs.mkdirSync(target, { recursive: true });
	fs.writeFileSync(path.join(target, "secret-note.md"), "outside\n");
	const jn = path.join(ART_DIR, "jn");
	try { fs.symlinkSync(target, jn, "junction"); } catch (error) { t.skip(`NOT RUN: junction creation failed: ${(error as Error).message}`); return; }
	assert.ok(fs.existsSync(path.join(jn, "secret-note.md")), "junction fixture resolves to a real file");
	assert.equal(C.checkArtifactFile(`${A}/jn/secret-note.md`, A), "alias or link escape");
});

test("artifact symlink file: a symlink named .md is refused as not a regular file", (t) => {
	resetState();
	const target = path.join(root, "symlink-target");
	fs.mkdirSync(target, { recursive: true });
	fs.writeFileSync(path.join(target, "note.md"), "outside\n");
	const sym = path.join(ART_DIR, "sym.md");
	try { fs.symlinkSync(path.join(target, "note.md"), sym, "file"); } catch (error) { t.skip(`NOT RUN: symlink creation failed: ${(error as Error).message}`); return; }
	assert.ok(fs.lstatSync(sym).isSymbolicLink(), "symlink fixture exists");
	assert.equal(C.checkArtifactFile(`${A}/sym.md`, A), "not a regular file");
});

test("artifact directory alias: a junction standing in for the artifact directory is refused", (t) => {
	const alias = path.join(root, "worktrees", "pi", "_evidence", "task-alias");
	try { fs.symlinkSync(ART_DIR, alias, "junction"); } catch (error) { t.skip(`NOT RUN: junction-as-directory creation failed: ${(error as Error).message}`); return; }
	assert.throws(() => C.validateArtifactDir(slash(alias), CAND), /alias or link/);
});

test("artifact directory 8.3 short name: a short-name alias of the artifact directory is refused", (t) => {
	const longWin = ART_DIR.replace(/\//g, "\\");
	const shortName = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `(New-Object -ComObject Scripting.FileSystemObject).GetFolder('${longWin}').ShortPath`], { encoding: "utf8", windowsHide: true }).stdout.trim();
	if (!shortName || shortName.toLowerCase() === longWin.toLowerCase()) { t.skip("NOT RUN: no 8.3 short name exists for the artifact directory on this volume"); return; }
	assert.throws(() => C.validateArtifactDir(slash(shortName), CAND), /^RangeError: artifact directory is an alias or link \(8\.3 short name\)$/, "8.3 alias refused with its own reason");
});

test("delivery store: identical binding reuses one record with the same issuedAt and no time field; a different binding is new; abort keeps delivery; explicit revoke clears it; cap of four", () => {
	resetState();
	const store = newStore();
	const first = store.addDeliveryGrant(bindingOf());
	assert.equal("expiresAt" in first, false, "session-scoped record carries no expiry");
	assert.equal(first.issuedAt, T0);
	state.clock = T0 + 3 * HOUR;
	assert.deepEqual(store.findDelivery(bindingOf()), first, "identical live request finds the same record");
	assert.equal(store.addDeliveryGrant(bindingOf()).issuedAt, first.issuedAt, "re-add keeps the same issuedAt");
	assert.equal(store.deliveryCount(), 1);
	store.addDeliveryGrant(bindingOf({ sha: OLD_MERGED }));
	store.addDeliveryGrant(bindingOf({ base: "release" }));
	assert.equal(store.deliveryCount(), 3, "different SHA or base is a new record");
	store.revokeAll();
	assert.equal(store.deliveryCount(), 3, "abort (revokeAll with no argument) keeps delivery");
	store.revokeAll(true);
	assert.equal(store.deliveryCount(), 0, "explicit revoke clears delivery");
	const capped = newStore();
	for (let i = 0; i < 4; i++) capped.addDeliveryGrant(bindingOf({ branch: `feat/n${i}` }));
	assert.throws(() => capped.addDeliveryGrant(bindingOf({ branch: "feat/n9" })), RangeError, "cap of four live records");
});
test("delivery lifecycle: release-engineer user or package children get the same session record; project-source and other roles get none; fresh parent and revoke clear it", () => {
	resetState();
	const store = storeWith({ version: "v1.2.3", latest: true, artifactDir: A });
	const issuedAt = store.copyDelivery(CAND)[0].issuedAt;
	const first = C.claimChildGuard(store, C.LEASE_ROLE, CAND, GUARD_FILE, { open: true }, true);
	const fallback = C.claimChildGuard(store, C.LEASE_ROLE, CAND, GUARD_FILE, { open: false }, true);
	state.clock = T0 + 5 * 60_000;
	const later = C.claimChildGuard(store, C.LEASE_ROLE, CAND, GUARD_FILE, { open: true }, true);
	assert.deepEqual([first.deliveryCount, fallback.deliveryCount, later.deliveryCount], [1, 1, 1]);
	for (const launch of [first, fallback, later]) {
		const [copy] = C.loadChildDelivery(launch.childEnv({})[C.CHILD_GRANT_ENV]);
		assert.equal(copy.issuedAt, issuedAt, "same issuedAt on every spawn");
		assert.equal("expiresAt" in copy, false, "no expiry field");
	}
	assert.equal(store.copyDelivery(CAND).length, 1, "copies are non-consuming");
	assert.equal(C.claimChildGuard(store, C.LEASE_ROLE, CAND, GUARD_FILE, { open: true }, false).deliveryCount, 0, "project-source release-engineer");
	assert.equal(C.claimChildGuard(store, "general-worker", CAND, GUARD_FILE, { open: true }, true).deliveryCount, 0, "other role");
	state.clock = T0 + 3 * HOUR;
	assert.equal(store.copyDelivery(CAND).length, 1, "still copied 3 hours later (no time expiry)");
	assert.equal(C.claimChildGuard(store, C.LEASE_ROLE, CAND, GUARD_FILE, { open: true }, true).deliveryCount, 1, "still copied to a new child");
	assert.equal(C.createGrantStore(() => state.clock).copyDelivery(CAND).length, 0, "a fresh parent store inherits no delivery");
	store.revokeAll(true);
	assert.equal(store.copyDelivery(CAND).length, 0, "explicit revoke clears the copy source");
	assert.equal(C.claimChildGuard(store, C.LEASE_ROLE, CAND, GUARD_FILE, { open: true }, true).deliveryCount, 0, "revoked record is not copied");
});

test("delivery envelope: round trip keeps the record under deliveryActions; legacy keys, tampered fields and any expiresAt or TTL field fail closed", () => {
	resetState();
	const store = storeWith({ latest: true, artifactDir: A });
	const record = store.copyDelivery(CAND)[0];
	const text = C.serializeGrants([], [], [record]);
	assert.deepEqual(C.loadChildDelivery(text), [record]);
	assert.deepEqual(C.loadChildDelivery('{"v":1,"grants":[]}'), [], "old envelope has no delivery");
	assert.throws(() => C.loadChildDelivery(JSON.stringify({ v: 1, grants: [], delivery: [record] })), /legacy/, "legacy delivery key");
	const tamper = (edit: (r: Record<string, unknown>) => void) => {
		const envelope = JSON.parse(text);
		envelope.deliveryActions = envelope.deliveryActions.map((r: Record<string, unknown>) => { const c = { ...r }; edit(c); return c; });
		return JSON.stringify(envelope);
	};
	const cases: Array<[string, (r: Record<string, unknown>) => void]> = [
		["role", (r) => { r.role = "general-worker"; }],
		["repo not derived from push URL", (r) => { r.repo = "acme/other"; }],
		["base equal to branch", (r) => { r.base = "feat/x"; }],
		["artifact dir not canonical", (r) => { r.artifactDir = `${A}/`; }],
		["artifact dir outside placement", (r) => { r.artifactDir = `${slash(root)}/plain`; }],
		["release without version", (r) => { delete r.version; }],
		["release without pr", (r) => { delete r.pr; }],
		["release without sha", (r) => { delete r.sha; }],
		["no action", (r) => { delete r.action; }],
		["merge claim without bound", (r) => { r.action = "merge"; delete r.version; delete r.latest; }],
		["protected branch", (r) => { r.branch = "main"; }],
	];
	for (const [name, edit] of cases) assert.throws(() => C.loadChildDelivery(tamper(edit)), undefined, name);
	const ttlCases: Array<[string, (r: Record<string, unknown>) => void]> = [
		["legacy 30 min expiresAt", (r) => { r.expiresAt = (r.issuedAt as number) + LEGACY_TTL; }],
		["null expiresAt", (r) => { r.expiresAt = null; }],
		["ttlMs field", (r) => { r.ttlMs = LEGACY_TTL; }],
	];
	for (const [name, edit] of ttlCases) assert.throws(() => C.loadChildDelivery(tamper(edit)), /delivery records are session-scoped; expiresAt or TTL is unsupported/, name);
});

test("live readers run from a neutral cwd with explicit git -C: gh and git lookups never resolve from the candidate", (t) => {
	resetState();
	const store = storeWith();
	const repo = makeRepo("neutral-edit");
	git(repo, "checkout", "-q", "feat/x");
	const trusted = { scope: "child" as const, store: newStore(), agentDir: AGENT_DIR, pushTarget: { candidate: repo, pushUrl: GH_URL, branch: "feat/x" }, gateCommits: true };
	const stub = {
		gh: (args: string[]) => {
			if (args[0] === "pr" && args[1] === "view") return args.includes(MERGED_VIEW_FIELDS) ? state.mergedViews[args[2]] : state.views[args[2]];
			throw new Error(`unexpected gh call ${args.join(" ")}`);
		},
		lsRemote: () => 2,
	};
	const { verdicts, calls } = withExecCapture(stub, (captured) => ({
		verdicts: [C.guardToolCall({ scope: "child", store, agentDir: AGENT_DIR }, "bash", { command: RELEASE }, CAND), C.guardToolCall(trusted, "bash", { command: EDIT }, repo)],
		calls: captured,
	}));
	assert.deepEqual(verdicts, [undefined, undefined], "release grant and automatic PR edit allowed through the default readers");
	const gh = calls.filter((c) => c.file === "gh");
	const ls = calls.filter((c) => c.file === "git" && c.args[0] === "ls-remote");
	const gits = calls.filter((c) => c.file === "git" && c.args[0] !== "ls-remote");
	assert.ok(gh.length >= 2 && ls.length === 1 && gits.length >= 1, `calls gh=${gh.length} ls-remote=${ls.length} git=${gits.length}`);
	for (const c of [...gh, ...ls]) assert.ok(neutral(c.cwd), `${c.file} ${c.args.join(" ")} cwd=${String(c.cwd)}`);
	for (const c of gits) {
		assert.equal(c.args[0], "-C", `git ${c.args.join(" ")}`);
		assert.ok([CAND, repo].includes(c.args[1]), `git -C target ${c.args.join(" ")}`);
		assert.ok(neutral(c.cwd), `git cwd=${String(c.cwd)}`);
	}
});
test("delivery copy drops records whose artifact directory vanished; the record stays, external envelopes still fail closed", () => {
	resetState();
	const gone = path.join(root, "worktrees", "pi", "_evidence", "task-gone");
	fs.mkdirSync(gone, { recursive: true });
	fs.writeFileSync(path.join(gone, "pr.md"), "gone\n");
	const store = storeWith({ version: "v1.2.3", artifactDir: A });
	store.addDeliveryGrant(bindingOf({ branch: "feat/x2", artifactDir: slash(fs.realpathSync.native(gone)) }));
	const goneRecord = store.copyDelivery(CAND).find((r: any) => r.branch === "feat/x2");
	assert.ok(goneRecord, "fixture record exists before deletion");
	fs.rmSync(gone, { recursive: true, force: true });
	const copies = store.copyDelivery(CAND);
	assert.deepEqual(copies.map((r: any) => r.branch), ["feat/x"], "vanished-directory record is not copied");
	assert.equal(store.deliveryCount(), 2, "vanished-directory record stays in the store");
	assert.throws(() => C.loadChildDelivery(C.serializeGrants([], [], [goneRecord])), RangeError, "external envelope with a vanished directory still fails closed");
	assert.equal(C.loadChildDelivery(C.serializeGrants([], [], copies)).length, 1, "remaining record loads");
});

test("delivery version: strict SemVer per field; v-prefix and bare forms allowed; leading zeros denied; cap constant is four", () => {
	const rel = (tag: string) => `gh release create ${tag} --repo acme/widgets --target ${MERGED} --title "R" --generate-notes`;
	for (const tag of ["v0.0.0", "v1.2.3", "1.2.3", "v10.0.1"]) assert.equal(C.parseDeliveryCommand(rel(tag))?.kind, "release", tag);
	for (const tag of ["v01.2.3", "v1.02.3", "v1.2.03", "v00.1.2", "v1.2"]) assert.equal(C.parseDeliveryCommand(rel(tag)), undefined, tag);
	assert.equal(C.MAX_DELIVERY_GRANTS, 4);
});

test("release merged-PR match: exact approved PR is fetched directly (no list, any age, exact number and repo); every wrong or malformed answer blocks", () => {
	const rel = `gh release create v1.2.3 --repo acme/widgets --target ${MERGED} --title "R" --generate-notes`;
	resetState();
	const store = storeWith({ version: "v1.2.3", artifactDir: A, pr: 4242 });
	const mine = { number: 4242, state: "MERGED", baseRefName: "main", headRefName: "feat/x", isCrossRepository: false, mergeCommit: { oid: MERGED } };
	state.mergedViews = { 4242: mine };
	assert.equal(run(store, rel), undefined, "approved PR older than any bounded list is found by exact number");
	assert.deepEqual(state.calls.filter((c) => c.startsWith("pr ")), [`pr view 4242 --repo acme/widgets --json ${MERGED_VIEW_FIELDS}`], "exactly one exact view, no list/history lookup");
	assert.equal(verifyReleaseVia(store), undefined);
	const cases: Array<[string, unknown]> = [
		["open", { ...mine, state: "OPEN" }], ["closed", { ...mine, state: "CLOSED" }], ["state missing", { ...mine, state: undefined }], ["state lowercase", { ...mine, state: "merged" }],
		["other number", { ...mine, number: 77 }], ["number string", { ...mine, number: "4242" }], ["number missing", { ...mine, number: undefined }],
		["fork", { ...mine, isCrossRepository: true }], ["fork missing", { ...mine, isCrossRepository: undefined }], ["fork null", { ...mine, isCrossRepository: null }],
		["other head", { ...mine, headRefName: "feat/y" }], ["head missing", { ...mine, headRefName: undefined }], ["other base", { ...mine, baseRefName: "release" }], ["base missing", { ...mine, baseRefName: undefined }],
		["other merge sha", { ...mine, mergeCommit: { oid: OLD_MERGED } }], ["merge commit missing", { ...mine, mergeCommit: undefined }], ["merge commit null", { ...mine, mergeCommit: null }], ["oid number", { ...mine, mergeCommit: { oid: 1 } }], ["oid missing", { ...mine, mergeCommit: {} }],
		["oid short", { ...mine, mergeCommit: { oid: MERGED.slice(0, 7) } }], ["oid uppercase", { ...mine, mergeCommit: { oid: MERGED.toUpperCase() } }],
		["array", [mine]], ["null", null], ["string", "MERGED"], ["number", 4242], ["undefined (not found)", undefined],
	];
	for (const [name, view] of cases) {
		resetState();
		state.mergedViews = { 4242: view };
		assert.ok(blocked(run(store, rel)), name);
		assert.notEqual(verifyReleaseVia(store), undefined, `mint-time ${name}`);
	}
	resetState();
	state.ghThrow = true;
	assert.ok(blocked(run(store, rel)), "network/gh error");
	assert.equal(state.calls.some((c) => c.startsWith("pr list")), false, "no list fallback on failure");
	resetState();
	state.mergedViews = { 12: { ...mine, number: 12 } };
	assert.ok(blocked(run(store, rel)), "an approved PR number that is not the merged PR (grant is 4242) is not substituted");
});

test("release has no time-based fallback: mergedAt never substitutes for the approved PR number or target SHA", () => {
	for (const offsetMs of [-1, 0, 1, 99 * HOUR]) {
		resetState();
		const store = storeWith();
		state.mergedViews = { 12: { number: 77, state: "MERGED", baseRefName: "main", headRefName: "feat/x", isCrossRepository: false, mergeCommit: { oid: MERGED }, mergedAt: new Date(T0 + offsetMs).toISOString() } };
		assert.ok(blocked(run(store, RELEASE)), `other PR, mergedAt offset ${offsetMs}`);
	}
});
test("artifact file refusal reasons are exact; a real regular fixture passes", () => {
	const dir = path.join(root, "worktrees", "pi", "_evidence", "exact");
	fs.mkdirSync(dir, { recursive: true });
	const D = slash(fs.realpathSync.native(dir));
	const outsideDir = path.join(root, "exact-outside");
	fs.mkdirSync(outsideDir, { recursive: true });
	fs.writeFileSync(path.join(outsideDir, "x.md"), "outside\n");
	fs.writeFileSync(path.join(dir, "pr.md"), "Summary\n");
	fs.writeFileSync(path.join(dir, "bad.json"), "{}\n");
	fs.writeFileSync(path.join(dir, "empty.md"), "");
	fs.writeFileSync(path.join(dir, "big.md"), "a".repeat(65537));
	fs.writeFileSync(path.join(dir, "nul.md"), "a\u0000b\n");
	fs.writeFileSync(path.join(dir, "cred.md"), "token=abc123\n");
	fs.mkdirSync(path.join(dir, "adir.md"));
	fs.linkSync(path.join(outsideDir, "x.md"), path.join(dir, "hard.md"));
	assert.equal(fs.statSync(path.join(dir, "hard.md")).nlink, 2, "hardlink fixture really has two links");
	const expected: Array<[string, string | undefined]> = [
		[`${D}/pr.md`, undefined],
		[`${D}/bad.json`, "extension"],
		[`${D}/pr`, "extension"],
		[`${D}/missing.md`, "missing"],
		[`${D}/empty.md`, "size"],
		[`${D}/big.md`, "size"],
		[`${D}/nul.md`, "NUL byte"],
		[`${D}/cred.md`, "credential-like text"],
		[`${D}/adir.md`, "not a regular file"],
		[`${D}/hard.md`, "hard link"],
		[`${D}x/pr.md`, "outside the approved artifact directory"],
		[`${slash(outsideDir)}/x.md`, "outside the approved artifact directory"],
		[`${D}/../exact/pr.md`, "path"],
		[`${D}//pr.md`, "path"],
		[`${D}/./pr.md`, "path"],
	];
	for (const [file, reason] of expected) assert.equal(C.checkArtifactFile(file, D), reason, file);
});

test("docs: release-engineer and subagent README show approved command shapes that parse; root README risk row covers delivery", () => {
	const repo = path.resolve(import.meta.dirname, "..", "..", "..", "..");
	for (const file of [path.join(repo, "agent", "agents", "release-engineer.md"), path.join(repo, "agent", "extensions", "subagent", "README.md")]) {
		const shapes = fs.readFileSync(file, "utf8").split(/\r?\n/).map((l) => l.trim()).filter((l) => /^(git push origin |gh pr (create|edit|merge) |gh release create )/.test(l));
		assert.ok(shapes.length >= 5, `${file}: approved command shapes listed (${shapes.length})`);
		assert.doesNotMatch(fs.readFileSync(file, "utf8"), /fixed 30 min|30-minute release|Expiry: fixed/, `${file}: no 30-minute delivery expiry remains`);
		for (const shape of shapes) assert.ok(shape.startsWith("git push origin ") ? C.parseNormalPush(shape) : C.parseDeliveryCommand(shape), `${file}: ${shape}`);
	}
	const row = fs.readFileSync(path.join(repo, "README.md"), "utf8").split(/\r?\n/).find((l) => l.includes("request_authorization") && l.includes("push_branch"));
	assert.ok(row, "root README risk row names request_authorization and push_branch");
	for (const needle of ["delivery", "session", "revoke", "running children"]) assert.ok(row.toLowerCase().includes(needle), `root README risk row: ${needle}`);
	assert.doesNotMatch(row, /30-minute|30 min/, "root README row: no 30-minute delivery expiry");
});
