// Release delivery grant (RED first): strict command grammar, live gates, artifact-file rules, store lifecycle and envelope. Offline: gh and git reads are injected through guard.live; git fixtures are local repos only.
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
const state = { clock: T0, env: {} as Record<string, string>, views: {} as Record<string, any>, merged: [] as any[], calls: [] as string[], ghThrow: false, tags: 2, pushUrl: undefined as undefined | ((c: string, b: string) => string | undefined) };
function resetState() {
	state.clock = T0;
	state.env = {};
	state.ghThrow = false;
	state.tags = 2;
	state.calls = [];
	state.pushUrl = undefined;
	state.views = { 12: { state: "OPEN", baseRefName: "main", headRefName: "feat/x", headRefOid: HEAD, isCrossRepository: false } };
	state.merged = [{ number: 12, mergeCommit: { oid: MERGED }, mergedAt: new Date(T0 + 1000).toISOString(), isCrossRepository: false, headRefName: "feat/x", baseRefName: "main" }];
}
resetState();
const liveReaders = () => ({
	env: () => state.env,
	pushUrl: (c: string, b: string) => (state.pushUrl ? state.pushUrl(c, b) : C.livePushUrl(c, b)),
	ghJson: (args: string[]) => {
		state.calls.push(args.join(" "));
		if (state.ghThrow) throw new Error("network timeout");
		if (args[0] === "pr" && args[1] === "view") return state.views[args[2]];
		if (args[0] === "pr" && args[1] === "list") return state.merged;
		throw new Error(`unexpected gh call ${args.join(" ")}`);
	},
	tagStatus: () => state.tags,
});
const newStore = () => C.createGrantStore(() => state.clock);
const bindingOf = (over: Record<string, unknown> = {}) => ({ role: C.LEASE_ROLE, candidate: CAND, pushUrl: GH_URL, repo: "acme/widgets", branch: "feat/x", base: "main", ...over });
function storeWith(over: Record<string, unknown> = {}) {
	const store = newStore();
	store.addDeliveryGrant(bindingOf(over));
	return store;
}
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
		`gh pr create --repo acme/widgets --base main --head feat/x --title "T" --body-file "C:\\Users\\MSI\\x.md"`,
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

test("delivery positives: five stages in bash and powershell with real forms; the record is not consumed", () => {
	resetState();
	const store = storeWith({ version: "v1.2.3", latest: true, artifactDir: A });
	const cases = [
		`gh pr create --repo acme/widgets --base main --head feat/x --title "Add delivery grant" --body "Ships the guard"`,
		`gh pr create --repo acme/widgets --base main --head feat/x --title "Add delivery grant" --body-file "${A}/pr.md"`,
		`gh pr edit 12 --repo acme/widgets --title "Add delivery grant" --body-file "${A}/pr.md"`,
		`gh pr merge 12 --repo acme/widgets --squash --match-head-commit ${HEAD} --subject "Add delivery grant" --body-file "${A}/merge.md"`,
		`gh release create v1.2.3 --repo acme/widgets --target ${MERGED} --title "Release 1.2.3" --notes-file "${A}/notes.md" --latest`,
		`git push origin feat/x`,
	];
	for (const tool of ["bash", "powershell"]) for (const command of cases) assert.equal(run(store, command, CAND, tool), undefined, `${tool} ${command}`);
	assert.ok(state.calls.some((c) => c.startsWith("pr view 12 --repo acme/widgets")), "live PR ownership read used");
	assert.equal(store.copyDelivery(CAND).length, 1, "delivery is non-consuming");
});

test("delivery live gates: wrong repo, base, head, branch, PR, cwd, closed or cross PR, stale head, tag and merged SHA drift all block", () => {
	resetState();
	const store = storeWith({ version: "v1.2.3", artifactDir: A });
	const attempts: Array<[string, string]> = [
		[`gh pr create --repo acme/other --base main --head feat/x --title "T" --body "b"`, CAND],
		[`gh pr create --repo acme/widgets --base develop --head feat/x --title "T" --body "b"`, CAND],
		[`gh pr create --repo acme/widgets --base main --head feat/y --title "T" --body "b"`, CAND],
		[`gh pr create --repo acme/widgets --base main --head feat/x --title "T" --body "b"`, OTHER],
		[`gh pr edit 13 --repo acme/widgets --title "T"`, CAND],
		[`gh pr merge 12 --repo acme/widgets --squash --match-head-commit ${MERGED}`, CAND],
		[`gh release create v1.2.3 --repo acme/widgets --target ${OLD_MERGED} --title "R" --generate-notes`, CAND],
		[`gh release create v9.9.9 --repo acme/widgets --target ${MERGED} --title "R" --generate-notes`, CAND],
		[`gh release create v1.2.3 --repo acme/widgets --target ${MERGED} --title "R" --generate-notes --latest`, CAND],
		[`git push origin master`, CAND],
		[`git push origin feat/y`, CAND],
	];
	for (const [command, cwd] of attempts) assert.ok(blocked(run(store, command, cwd)), `${command} in ${cwd}`);
	state.views[12] = { ...state.views[12], state: "MERGED" };
	assert.ok(blocked(run(store, `gh pr edit 12 --repo acme/widgets --title "T"`)), "closed PR");
	state.views[12] = { ...state.views[12], state: "OPEN", isCrossRepository: true };
	assert.ok(blocked(run(store, `gh pr edit 12 --repo acme/widgets --title "T"`)), "cross-repository PR");
	state.views[12] = { ...state.views[12], isCrossRepository: false, headRefOid: "2".repeat(40) };
	assert.ok(blocked(run(store, `gh pr merge 12 --repo acme/widgets --squash --match-head-commit ${HEAD}`)), "stale head: merge bound to the moved head");
	state.views[12] = { ...state.views[12], headRefOid: HEAD, baseRefName: "release" };
	assert.ok(blocked(run(store, `gh pr edit 12 --repo acme/widgets --title "T"`)), "PR base differs from the approved base");
	resetState();
	state.tags = 0;
	assert.ok(blocked(run(store, `gh release create v1.2.3 --repo acme/widgets --target ${MERGED} --title "R" --generate-notes`)), "tag already exists remotely");
	resetState();
	const drift = { ...childGuard(store), live: { ...liveReaders(), pushUrl: () => "https://github.com/acme/other.git" } };
	assert.ok(blocked(C.guardToolCall(drift, "bash", { command: `gh pr edit 12 --repo acme/widgets --title "T"` }, CAND)), "live push URL drift");
});

test("delivery failures: gh throws or returns no JSON, GH_HOST/GH_REPO, compound commands, dot-dot artifacts, wrong scope and another candidate block; a 3 hour clock advance keeps a live session record", () => {
	resetState();
	const store = storeWith({ version: "v1.2.3", artifactDir: A });
	const edit = `gh pr edit 12 --repo acme/widgets --title "T"`;
	assert.equal(run(store, edit), undefined, "control");
	state.ghThrow = true;
	assert.ok(blocked(run(store, edit)), "gh throws or times out");
	state.ghThrow = false;
	state.views[12] = undefined;
	assert.ok(blocked(run(store, edit)), "gh returns no usable JSON");
	resetState();
	state.env = { GH_HOST: "ghe.example.test" };
	assert.ok(blocked(run(store, edit)), "GH_HOST present");
	state.env = { GH_REPO: "acme/other" };
	assert.ok(blocked(run(store, edit)), "GH_REPO present");
	resetState();
	assert.ok(blocked(run(store, `${edit} && rm -rf x`)), "compound command");
	assert.ok(blocked(run(store, `echo x; ${edit}`)), "leading compound");
	assert.ok(blocked(run(store, `gh pr edit 12 --repo acme/widgets --title "T" --body-file "${A}/../x.md"`)), "dot-dot artifact");
	assert.ok(blocked(C.guardToolCall({ scope: "main", store, agentDir: AGENT_DIR, live: liveReaders() }, "bash", { command: edit }, CAND)), "main scope never uses delivery");
	assert.ok(blocked(run(newStore(), edit)), "no delivery copy in this child");
	const other = storeWith({ candidate: OTHER, version: "v1.2.3" });
	assert.ok(blocked(run(other, edit, CAND)), "record bound to another candidate");
	state.clock = T0 + 3 * HOUR;
	assert.equal(run(store, edit), undefined, "session delivery stays live after 3 hours (no time expiry)");
});

test("delivery artifacts: only an approved md/txt regular file inside the approved directory is read; escapes, bad content and secret-like text block", () => {
	resetState();
	const store = storeWith({ artifactDir: A });
	const create = (file: string) => `gh pr create --repo acme/widgets --base main --head feat/x --title "T" --body-file "${file}"`;
	assert.equal(run(store, create(`${A}/pr.md`)), undefined, "control inside the directory");
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
	for (const file of bad) assert.ok(blocked(run(store, create(file))), file);
	assert.ok(blocked(run(storeWith({}), create(`${A}/pr.md`))), "file form blocked without an approved artifact directory");
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
	const first = store.addDeliveryGrant(bindingOf({ version: "v1.2.3" }));
	assert.equal("expiresAt" in first, false, "session-scoped record carries no expiry");
	assert.equal(first.issuedAt, T0);
	state.clock = T0 + 3 * HOUR;
	assert.deepEqual(store.findDelivery(bindingOf({ version: "v1.2.3" })), first, "identical live request finds the same record");
	assert.equal(store.addDeliveryGrant(bindingOf({ version: "v1.2.3" })).issuedAt, first.issuedAt, "re-add keeps the same issuedAt");
	assert.equal(store.deliveryCount(), 1);
	store.addDeliveryGrant(bindingOf({ version: "v1.2.3", base: "release" }));
	assert.equal(store.deliveryCount(), 2, "different binding is a new record");
	store.revokeAll();
	assert.equal(store.deliveryCount(), 2, "abort (revokeAll with no argument) keeps delivery");
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

test("delivery envelope: round trip keeps the record; tampered role, repo, base, artifact dir or latest fail closed; any expiresAt or TTL field is refused as session-scoped", () => {
	resetState();
	const store = storeWith({ version: "v1.2.3", latest: true, artifactDir: A });
	const record = store.copyDelivery(CAND)[0];
	const text = C.serializeGrants([], [], [record]);
	assert.deepEqual(C.loadChildDelivery(text), [record]);
	assert.deepEqual(C.loadChildDelivery('{"v":1,"grants":[]}'), [], "old envelope has no delivery");
	const tamper = (edit: (r: Record<string, unknown>) => void) => {
		const envelope = JSON.parse(text);
		envelope.delivery = envelope.delivery.map((r: Record<string, unknown>) => { const c = { ...r }; edit(c); return c; });
		return JSON.stringify(envelope);
	};
	const cases: Array<[string, (r: Record<string, unknown>) => void]> = [
		["role", (r) => { r.role = "general-worker"; }],
		["repo not derived from push URL", (r) => { r.repo = "acme/other"; }],
		["base equal to branch", (r) => { r.base = "feat/x"; }],
		["artifact dir not canonical", (r) => { r.artifactDir = `${A}/`; }],
		["artifact dir outside placement", (r) => { r.artifactDir = `${slash(root)}/plain`; }],
		["latest without version", (r) => { r.version = undefined; }],
		["protected branch", (r) => { r.branch = "main"; }],
	];
	for (const [name, edit] of cases) assert.throws(() => C.loadChildDelivery(tamper(edit)), undefined, name);
	const ttlCases: Array<[string, (r: Record<string, unknown>) => void]> = [
		["legacy 30 min expiresAt", (r) => { r.expiresAt = (r.issuedAt as number) + LEGACY_TTL; }],
		["expiresAt above 30 min", (r) => { r.expiresAt = (r.issuedAt as number) + LEGACY_TTL + 1; }],
		["null expiresAt", (r) => { r.expiresAt = null; }],
		["ttlMs field", (r) => { r.ttlMs = LEGACY_TTL; }],
	];
	for (const [name, edit] of ttlCases) assert.throws(() => C.loadChildDelivery(tamper(edit)), /delivery records are session-scoped; expiresAt or TTL is unsupported/, name);
});

test("delivery mint refuses invalid bindings before any record exists", () => {
	const store = newStore();
	assert.throws(() => store.addDeliveryGrant(bindingOf({ branch: "master" })), RangeError, "protected branch");
	assert.throws(() => store.addDeliveryGrant(bindingOf({ pushUrl: "https://u:tok@github.com/acme/widgets.git" })), RangeError, "credentialed URL");
	assert.throws(() => store.addDeliveryGrant(bindingOf({ repo: "acme/other" })), RangeError, "repo not from URL");
	assert.throws(() => store.addDeliveryGrant(bindingOf({ latest: true })), RangeError, "latest without version");
	assert.throws(() => store.addDeliveryGrant(bindingOf({ version: "1.2" })), RangeError, "bad version");
	assert.throws(() => store.addDeliveryGrant(bindingOf({ role: "general-worker" })), RangeError, "role");
	assert.equal(store.deliveryCount(), 0);
});

test("live readers run from a neutral cwd with explicit git -C: gh and git lookups never resolve from the candidate", (t) => {
	if (process.versions.bun) { t.skip("NOT RUN: Bun syncBuiltinESMExports does not refresh the ESM namespace; child_process stubs cannot apply and real gh/git would run"); return; }
	resetState();
	const store = storeWith({ version: "v1.2.3", artifactDir: A });
	const edit = `gh pr edit 12 --repo acme/widgets --title "T"`;
	const release = `gh release create v1.2.3 --repo acme/widgets --target ${MERGED} --title "R" --generate-notes`;
	const stub = {
		gh: (args: string[]) => {
			if (args[0] === "pr" && args[1] === "view") return state.views[args[2]];
			if (args[0] === "pr" && args[1] === "list") return state.merged;
			throw new Error(`unexpected gh call ${args.join(" ")}`);
		},
		lsRemote: () => 2,
	};
	const { verdicts, calls } = withExecCapture(stub, (captured) => ({
		verdicts: [edit, release].map((command) => C.guardToolCall({ scope: "child", store, agentDir: AGENT_DIR }, "bash", { command }, CAND)),
		calls: captured,
	}));
	assert.deepEqual(verdicts, [undefined, undefined], "allowed through the default readers");
	const gh = calls.filter((c) => c.file === "gh");
	const ls = calls.filter((c) => c.file === "git" && c.args[0] === "ls-remote");
	const git = calls.filter((c) => c.file === "git" && c.args[0] !== "ls-remote");
	assert.ok(gh.length >= 2 && ls.length === 1 && git.length >= 1, `calls gh=${gh.length} ls-remote=${ls.length} git=${git.length}`);
	for (const c of [...gh, ...ls]) assert.ok(neutral(c.cwd), `${c.file} ${c.args.join(" ")} cwd=${String(c.cwd)}`);
	for (const c of git) {
		assert.equal(c.args[0], "-C", `git ${c.args.join(" ")}`);
		assert.equal(c.args[1], CAND, `git -C target ${c.args.join(" ")}`);
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

test("release merged-PR match: one matching live entry is enough; unrelated older entries do not block; wrong, ambiguous or malformed matches block", () => {
	const rel = `gh release create v1.2.3 --repo acme/widgets --target ${MERGED} --title "R" --generate-notes`;
	const mine = { number: 12, mergeCommit: { oid: MERGED }, mergedAt: new Date(T0 + 1000).toISOString(), isCrossRepository: false, headRefName: "feat/x", baseRefName: "main" };
	const other = { number: 11, mergeCommit: { oid: OLD_MERGED }, mergedAt: new Date(T0 - 5000).toISOString(), isCrossRepository: false, headRefName: "feat/old", baseRefName: "main" };
	resetState();
	const store = storeWith({ version: "v1.2.3", artifactDir: A });
	state.merged = [other, mine];
	assert.equal(run(store, rel), undefined, "one matching plus an unrelated older entry");
	const cases: Array<[string, unknown]> = [
		["two matching entries", [mine, { ...mine, number: 13 }]],
		["zero matching entries", [other]],
		["fork PR with the matching SHA", [{ ...mine, isCrossRepository: true }]],
		["wrong base", [{ ...mine, baseRefName: "release" }]],
		["old matching PR without the approved PR number", [{ ...mine, mergedAt: new Date(T0 - 1000).toISOString() }]],
		["malformed null live entry", [null, mine]],
		["malformed live list", "not a list"],
	];
	for (const [name, merged] of cases) {
		resetState();
		state.merged = merged as any[];
		assert.ok(blocked(run(store, rel)), name);
	}
});

test("release issuedAt cutoff with no approved PR number: merge one ms before the grant issuedAt blocks; exactly at and one ms after pass", () => {
	const rel = `gh release create v1.2.3 --repo acme/widgets --target ${MERGED} --title "R" --generate-notes`;
	const cases: Array<[string, number, boolean]> = [
		["mergedAt one ms before issuedAt", -1, true],
		["mergedAt exactly issuedAt", 0, false],
		["mergedAt one ms after issuedAt", 1, false],
	];
	for (const [name, offsetMs, expectBlock] of cases) {
		resetState();
		const store = storeWith({ version: "v1.2.3", artifactDir: A });
		const { issuedAt } = store.copyDelivery(CAND)[0];
		assert.equal(issuedAt, T0, "grant stamped at the controlled clock");
		state.merged = [{ number: 12, mergeCommit: { oid: MERGED }, mergedAt: new Date(issuedAt + offsetMs).toISOString(), isCrossRepository: false, headRefName: "feat/x", baseRefName: "main" }];
		const verdict = run(store, rel);
		if (expectBlock) assert.ok(blocked(verdict), name);
		else assert.equal(verdict, undefined, name);
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
