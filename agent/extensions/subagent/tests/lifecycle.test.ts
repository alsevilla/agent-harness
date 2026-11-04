// Opt-in delivery lifecycle: disposal consent in grant equality, Learn proof, ignored-cache classification, manifests, receipts, runtime removal, partial failure and legacy behavior. Offline: gh is injected; every fixture is a disposable synthetic repo/tree under the assigned scratch root, removed only by the tested APIs or by these tests' own fixture cleanup.
import assert from "node:assert/strict";
import cpDefault, { spawnSync } from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import * as core from "../safety-core.ts";
import * as state from "../cleanup-state.ts";
import * as life from "../lifecycle.ts";

const C = core as any;
const S = state as any;
const L = life as any;
const MERGE = "fedcba9876543210fedcba9876543210fedcba98";
const GH_URL = "https://github.com/acme/widgets.git";
const SCRATCH = fs.realpathSync.native(process.env.DELIVERY_TEST_SCRATCH ?? os.tmpdir());
const root = fs.realpathSync.native(fs.mkdtempSync(path.join(SCRATCH, "lifecycle-")));
const EMPTY_GITCONFIG = path.join(root, "gitconfig");
fs.writeFileSync(EMPTY_GITCONFIG, "");
process.env.GIT_CONFIG_GLOBAL = EMPTY_GITCONFIG;
process.env.GIT_CONFIG_NOSYSTEM = "1";
const slash = (p: string) => p.replace(/\\/g, "/");
const sha = (text: string) => createHash("sha256").update(text).digest("hex");
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
fs.writeFileSync(`${PRIMARY}/.gitignore`, "ignored/\nnode_modules/\n.serena/\ndocs/knowledge/local/\n");
git(PRIMARY, "add", "-A");
git(PRIMARY, "commit", "-q", "-m", "init");
git(PRIMARY, "remote", "add", "origin", GH_URL);
const WT = `${PROJ}/worktrees/pi`;
fs.mkdirSync(WT, { recursive: true });
const LEARN_DIR = `${PRIMARY}/docs/knowledge/local/harness`;
fs.mkdirSync(LEARN_DIR, { recursive: true });

let n = 0;
interface Task { name: string; dir: string; branch: string; head: string; evidence: string; scratch: string }
function makeTask(): Task {
	const name = `task-${++n}`;
	const branch = `feat/${name}`;
	const dir = `${WT}/${name}`;
	git(PRIMARY, "worktree", "add", "-q", "-b", branch, dir);
	const t = { name, dir: slash(fs.realpathSync.native(dir)), branch, head: git(dir, "rev-parse", "HEAD"), evidence: `${WT}/_evidence/${name}`, scratch: `${WT}/_scratch/${name}` };
	fs.mkdirSync(`${t.evidence}/sub`, { recursive: true });
	fs.mkdirSync(t.scratch, { recursive: true });
	fs.writeFileSync(`${t.evidence}/REPORT.md`, "report\n");
	fs.writeFileSync(`${t.evidence}/sub/x.txt`, "x\n");
	fs.writeFileSync(`${t.scratch}/log.txt`, "log\n");
	return t;
}
const view = (t: Task, over: Record<string, unknown> = {}) => ({ number: 12, state: "MERGED", baseRefName: "main", headRefName: t.branch, headRefOid: t.head, isCrossRepository: false, mergeCommit: { oid: MERGE }, ...over });
const tag = { value: 2 };
// What the remote's tag resolves to (the peeled commit), as DeliveryLive.tagCommit reports it; undefined = not verifiable.
const tagSha: { value: string | undefined } = { value: MERGE };
function live(v: unknown) {
	return { env: () => ({}), pushUrl: (c: string, b: string) => C.livePushUrl(c, b), ghJson: () => v, tagStatus: () => tag.value, tagCommit: () => tagSha.value, now: () => Date.now() };
}
function terminalOwners(t: Task) {
	const owners = new S.OwnerTracker();
	owners.begin({ workerId: "w1", role: "release-engineer", cwd: t.dir, jobId: "bg-1" });
	owners.end("w1");
	return owners;
}
let files = 0;
// A Learn checkpoint: exact local record and index under the primary store (gitignored), hashes of the bytes.
function learn(over: { record?: string; text?: string; indexText?: (rel: string) => string } = {}) {
	const id = ++files;
	const record = over.record ?? `${LEARN_DIR}/lesson-${id}.md`;
	const index = `${LEARN_DIR}/README.md`;
	const text = over.text ?? `# Lesson ${id}\nClaim.\n`;
	fs.writeFileSync(record, text);
	const rel = path.posix.basename(record);
	fs.writeFileSync(index, over.indexText ? over.indexText(rel) : `- [lesson](${rel})\n`);
	return { state: "SAVED", record, index, recordSha256: sha(fs.readFileSync(record, "utf8")), indexSha256: sha(fs.readFileSync(index, "utf8")) } as any;
}
const NO_LESSON = { state: "NO LESSON", reason: "nothing durable" };
function binding(t: Task, action: "merge" | "release" = "merge", over: Record<string, unknown> = {}) {
	return { role: "release-engineer", candidate: t.dir, pushUrl: GH_URL, repo: "acme/widgets", branch: t.branch, base: "main", action, pr: 12, sha: action === "merge" ? t.head : MERGE, ...(action === "merge" ? { bound: { head: t.head, ref: `refs/heads/${t.branch}`, fingerprint: "a".repeat(64), exclude: [] } } : { version: "v1.2.3" }), disposal: { checkout: t.dir, evidence: t.evidence, scratch: t.scratch }, ...over };
}
const request = (t: Task, lifecycle?: unknown, over: Record<string, unknown> = {}) => ({ checkout: t.dir, branch: t.branch, base: "main", pr: 12, headSha: t.head, mergeCommit: MERGE, quiescent: true, ...(lifecycle === undefined ? {} : { lifecycle }), ...over });
function mint(t: Task, o: { store?: any; consent?: Record<string, unknown> | false; action?: "merge" | "release"; lifecycle?: any; over?: Record<string, unknown>; owners?: any } = {}) {
	const store = o.store ?? C.createGrantStore();
	const action = o.action ?? "merge";
	if (o.consent !== false) store.addDeliveryGrant(binding(t, action, o.consent));
	const lc = o.lifecycle ?? { action, ...(action === "release" ? { version: "v1.2.3" } : {}), learn: learn() };
	const res = C.prepareCleanup(request(t, lc, o.over), { store, owners: o.owners ?? terminalOwners(t), live: live(view(t)), primary: PRIMARY, mainCwd: PROJ, jobRunning: () => false });
	return { store, res, lc };
}
const finish = (plan: any, o: Record<string, unknown> = {}) => C.completeCleanupLifecycle(plan, { cleanExit: true, owners: new S.OwnerTracker(), jobRunning: () => false, mainCwd: PROJ, ...o });
// Stands in for the cleanup child's own successful `git worktree remove` on this synthetic fixture.
const removeCheckout = (t: Task) => git(PRIMARY, "worktree", "remove", t.dir);
const exists = (p: string) => fs.existsSync(p);
// Own synthetic fixtures only (mkdtemp under the assigned scratch root).
test.after(() => { try { if (root.startsWith(SCRATCH) && path.basename(root).startsWith("lifecycle-")) fs.rmSync(root, { recursive: true, force: true }); } catch { /* retained */ } });

test("disposal consent: exact derived paths only, part of grant equality, unscoped grants never match", () => {
	const t = makeTask();
	const store = C.createGrantStore();
	for (const bad of [{ ...binding(t).disposal, scratch: `${WT}/_scratch/other` }, { ...binding(t).disposal, evidence: `${WT}/_evidence/task-x/..` }, { checkout: t.dir, evidence: t.evidence }, { ...binding(t).disposal, extra: 1 }, "yes"]) {
		assert.throws(() => store.addDeliveryGrant(binding(t, "merge", { disposal: bad })), /disposal/);
	}
	store.addDeliveryGrant(binding(t, "merge", { disposal: undefined }));
	assert.equal(store.findDisposal(t.dir, "merge", 12, t.head), undefined, "an unscoped grant carries no disposal consent");
	store.addDeliveryGrant(binding(t));
	assert.equal(store.deliveryCount(), 2, "a scoped grant is a different grant");
	assert.ok(store.findDisposal(t.dir, "merge", 12, t.head));
	assert.equal(store.findDisposal(t.dir, "release", 12, t.head), undefined);
	const child = C.loadChildDelivery(C.serializeGrants([], [], store.copyDelivery(t.dir)));
	assert.ok(child.some((d: any) => d.disposal), "the child envelope round-trips the scoped grant");
	assert.throws(() => C.loadChildDelivery(JSON.stringify({ v: 1, deliveryActions: [{ ...store.copyDelivery(t.dir)[0], disposal: { checkout: t.dir, evidence: t.evidence, scratch: `${WT}/_scratch/zzz` } }] })), /disposal/);
});

test("no consent, or consent for another delivery: lifecycle mint is refused and nothing is written", () => {
	const t = makeTask();
	const a = mint(t, { consent: false });
	assert.equal(a.res.ok, false);
	assert.match(a.res.reason, /no explicit disposal approval/);
	const store = C.createGrantStore();
	store.addDeliveryGrant(binding(t, "merge", { disposal: undefined }));
	assert.match(mint(t, { store, consent: false }).res.reason, /no explicit disposal approval/, "an unscoped live merge grant is not consent");
	const r = mint(t, { consent: { pr: 13 } });
	assert.match(r.res.reason, /no explicit disposal approval/);
	assert.ok(!exists(`${WT}/_receipts`), "no receipt without a mint");
});

test("happy path: Learn SAVED, intent receipt first, consent consumed, runtime removes scratch then evidence after the checkout is gone; branch and receipts survive", () => {
	const t = makeTask();
	fs.mkdirSync(`${t.dir}/node_modules/pkg`, { recursive: true });
	fs.writeFileSync(`${t.dir}/node_modules/pkg/index.js`, "x");
	const { store, res } = mint(t);
	assert.equal(res.ok, true, JSON.stringify(res));
	assert.deepEqual(res.grant.disposal, { evidence: t.evidence, scratch: t.scratch });
	const intent = `${WT}/_receipts/${t.name}/intent-${res.grant.id}.json`;
	assert.ok(exists(intent), "intent receipt precedes any deletion");
	assert.ok(!exists(`${WT}/_receipts/${t.name}/final-${res.grant.id}.json`));
	assert.ok(exists(t.evidence) && exists(t.scratch));
	assert.equal(store.findDisposal(t.dir, "merge", 12, t.head), undefined, "consent is consumed by the mint (no replay)");
	assert.equal(mint(t, { store, consent: false, lifecycle: { action: "merge", learn: NO_LESSON } }).res.ok, false, "second mint has no authority");
	removeCheckout(t);
	const out = finish(res.lifecycle);
	assert.equal(out.state, "COMPLETE", JSON.stringify(out));
	assert.ok(!exists(t.scratch) && !exists(t.evidence) && !exists(t.dir));
	assert.ok(exists(`${WT}/_receipts/${t.name}/final-${res.grant.id}.json`));
	assert.ok(git(PRIMARY, "branch", "--list", t.branch).includes(t.branch), "branch preserved");
	const receipt = fs.readFileSync(`${WT}/_receipts/${t.name}/final-${res.grant.id}.json`, "utf8");
	assert.match(receipt, /"state": "COMPLETE"/);
	assert.ok(receipt.length < 4000, "small outcome, not an archive");
});

test("release lifecycle: needs the release consent and the existing remote tag; merge consent does not satisfy it", () => {
	const t = makeTask();
	tag.value = 2;
	assert.match(mint(t, { action: "release" }).res.reason, /tag does not exist/);
	tag.value = 0;
	const t2 = makeTask();
	const ok = mint(t2, { action: "release" });
	assert.equal(ok.res.ok, true, JSON.stringify(ok.res));
	const t3 = makeTask();
	const wrong = mint(t3, { action: "merge", lifecycle: { action: "release", version: "v1.2.3", learn: learn() } });
	assert.match(wrong.res.reason, /no explicit disposal approval/);
	tag.value = 2;
});

const OTHER = "0123456789abcdef0123456789abcdef01234567";
const TAGOBJ = "89abcdef0123456789abcdef0123456789abcdef";

test("release commit binding: an existing tag at another commit, or one that cannot be resolved, is refused before the intent receipt or any authority; matching tags pass", () => {
	tag.value = 0;
	try {
		for (const [name, sha, why] of [["other commit", OTHER, /does not point at the approved merge commit/], ["unresolvable", undefined, /could not be resolved/]] as const) {
			const t = makeTask();
			tagSha.value = sha;
			const r = mint(t, { action: "release" });
			assert.equal(r.res.ok, false, name);
			assert.match(r.res.reason, why, name);
			assert.ok(r.store.findDisposal(t.dir, "release", 12, MERGE), `${name}: consent kept`);
			assert.equal(r.store.cleanupCount(), 0, `${name}: no cleanup authority`);
			assert.ok(!exists(`${WT}/_receipts/${t.name}`), `${name}: no receipt`);
			assert.ok(exists(t.scratch) && exists(t.evidence), name);
		}
		tagSha.value = MERGE;
		const ok = mint(makeTask(), { action: "release" });
		assert.equal(ok.res.ok, true, JSON.stringify(ok.res));
	} finally { tag.value = 2; tagSha.value = MERGE; }
});

test("tag resolution parser: strict ls-remote output; peeled annotated target preferred, lightweight accepted, anything ambiguous or malformed is undefined", () => {
	const P = (out: string) => C.parseTagCommit(out, "v1.2.3");
	const R = "refs/tags/v1.2.3";
	assert.equal(P(`${MERGE}\t${R}\n`), MERGE, "lightweight");
	assert.equal(P(`${TAGOBJ}\t${R}\n${MERGE}\t${R}^{}\n`), MERGE, "annotated: the peeled commit, not the tag object");
	assert.equal(P(`${MERGE}\t${R}^{}\n${TAGOBJ}\t${R}\n`), MERGE, "order independent");
	assert.equal(P(`${MERGE}\t${R}\r\n`), MERGE, "CRLF");
	for (const [name, out] of [["empty", ""], ["other tag", `${MERGE}\trefs/tags/v1.2.30\n`], ["short sha", `abc123\t${R}\n`], ["uppercase", `${MERGE.toUpperCase()}\t${R}\n`], ["space separator", `${MERGE} ${R}\n`], ["duplicate direct", `${MERGE}\t${R}\n${OTHER}\t${R}\n`], ["duplicate peeled", `${TAGOBJ}\t${R}\n${MERGE}\t${R}^{}\n${OTHER}\t${R}^{}\n`], ["peeled only", `${MERGE}\t${R}^{}\n`], ["extra ref", `${MERGE}\t${R}\n${OTHER}\trefs/tags/v1.2.3-rc1\n`], ["trailing junk", `${MERGE}\t${R}\nwarning: x\n`], ["not a string", undefined]] as const) assert.equal(P(out as any), undefined, name);
});

test("default tag reader: one read-only ls-remote of exactly the tag and its peeled ref in a neutral cwd; a mismatching tag refuses the lifecycle end to end", () => {
	const cp = cpDefault as any;
	const original = { execFileSync: cp.execFileSync, spawnSync: cp.spawnSync };
	const calls: { args: string[]; cwd: string }[] = [];
	const t = makeTask();
	let out = `${TAGOBJ}\trefs/tags/v1.2.3\n${OTHER}\trefs/tags/v1.2.3^{}\n`;
	cp.execFileSync = (file: string, args: string[], o: any) => (file === "gh" ? JSON.stringify(view(t)) : original.execFileSync(file, args, o));
	cp.spawnSync = (file: string, args: string[], o: any) => {
		if (file !== "git" || args[0] !== "ls-remote") return original.spawnSync(file, args, o);
		calls.push({ args, cwd: o.cwd });
		return args.includes("--exit-code") ? { status: 0, signal: null, error: undefined, stdout: "", stderr: "" } : { status: 0, signal: null, error: undefined, stdout: out, stderr: "" };
	};
	syncBuiltinESMExports();
	try {
		const store = C.createGrantStore();
		store.addDeliveryGrant(binding(t, "release"));
		const lc = { action: "release", version: "v1.2.3", learn: learn() };
		const deps = { store, owners: terminalOwners(t), primary: PRIMARY, mainCwd: PROJ, jobRunning: () => false };
		const bad = C.prepareCleanup(request(t, lc), deps);
		assert.equal(bad.ok, false);
		assert.match(bad.reason, /does not point at the approved merge commit/);
		const read = calls.find((c) => !c.args.includes("--exit-code"))!;
		assert.deepEqual(read.args, ["ls-remote", "--tags", GH_URL, "refs/tags/v1.2.3", "refs/tags/v1.2.3^{}"]);
		assert.ok(!path.resolve(read.cwd).startsWith(path.resolve(t.dir)), "neutral cwd, not the target");
		out = `${TAGOBJ}\trefs/tags/v1.2.3\n${MERGE}\trefs/tags/v1.2.3^{}\n`;
		const good = C.prepareCleanup(request(t, lc), deps);
		assert.equal(good.ok, true, JSON.stringify(good));
	} finally { cp.execFileSync = original.execFileSync; cp.spawnSync = original.spawnSync; syncBuiltinESMExports(); }
});

test("CLEANUP_PENDING selection is scope-aware: an unscoped merge grant never hides a scoped release (or merge) grant for the same checkout; unscoped alone keeps the old retained-artifacts hint", () => {
	const t = makeTask();
	const store = C.createGrantStore();
	store.addDeliveryGrant(binding(t, "merge", { disposal: undefined }));
	store.addDeliveryGrant(binding(t, "release"));
	const owners = terminalOwners(t);
	const only = C.cleanupPending(C.createGrantStore(), owners, () => false);
	assert.deepEqual(only, []);
	const a = C.cleanupPending(store, owners, () => false);
	assert.equal(a.length, 1, "one entry per checkout");
	assert.equal(a[0].lifecycle?.action, "release");
	assert.equal(a[0].lifecycle?.version, "v1.2.3");
	assert.deepEqual(a[0].retainedArtifacts, []);
	// order independence: scoped first, unscoped second
	const s2 = C.createGrantStore();
	s2.addDeliveryGrant(binding(t, "release"));
	s2.addDeliveryGrant(binding(t, "merge", { disposal: undefined }));
	assert.equal(C.cleanupPending(s2, owners, () => false)[0].lifecycle?.action, "release");
	// merge-scoped and release-scoped are distinct entries; a repeated identical scope is not duplicated
	const s3 = C.createGrantStore();
	s3.addDeliveryGrant(binding(t, "merge"));
	s3.addDeliveryGrant(binding(t, "release"));
	assert.deepEqual(C.cleanupPending(s3, owners, () => false).map((e: any) => e.lifecycle.action).sort(), ["merge", "release"]);
	// unscoped only: legacy hint
	const s4 = C.createGrantStore();
	s4.addDeliveryGrant(binding(t, "merge", { disposal: undefined }));
	const legacy = C.cleanupPending(s4, owners, () => false);
	assert.equal(legacy.length, 1);
	assert.equal(legacy[0].lifecycle, undefined);
	assert.equal(legacy[0].retainedArtifacts.length, 2);
	const held = C.cleanupPending(store, new S.OwnerTracker(), () => false);
	assert.equal(held[0].state, "RETAINED");
	assert.equal(held[0].retainedArtifacts.length, 2, "a RETAINED scoped entry still lists its artifact folders as retained");
	const text = C.formatCleanupPending(legacy);
	assert.doesNotMatch(text, /artifact folders are always retained/);
});

test("Learn gate: BLOCKED, missing, hash mismatch, no index link, inside a target, not ignored and bad shapes all refuse before any authority is consumed", () => {
	const t = makeTask();
	const good = learn();
	const cases: [string, any][] = [
		["BLOCKED", { state: "BLOCKED", reason: "gap" }],
		["NO LESSON without reason", { state: "NO LESSON" }],
		["extra key", { ...good, extra: 1 }],
		["hash mismatch", { ...good, recordSha256: "0".repeat(64) }],
		["index hash mismatch", { ...good, indexSha256: "1".repeat(64) }],
		["missing record", { ...good, record: `${LEARN_DIR}/nope.md` }],
		["relative path", { ...good, record: "docs/knowledge/local/harness/x.md" }],
		["outside the store", { ...good, record: `${PRIMARY}/a.txt` }],
		["inside a target", { ...good, record: `${t.evidence}/REPORT.md` }],
	];
	for (const [name, lc] of cases) {
		const r = mint(t, { lifecycle: { action: "merge", learn: lc } });
		assert.equal(r.res.ok, false, name);
		assert.match(r.res.reason, /Learn checkpoint refused|lifecycle needs/, name);
		assert.equal(r.store.findDisposal(t.dir, "merge", 12, t.head) !== undefined, true, `${name}: consent not consumed`);
	}
	const noLink = learn({ indexText: () => "nothing here\n" });
	assert.match(mint(t, { lifecycle: { action: "merge", learn: noLink } }).res.reason, /does not link/);
	fs.mkdirSync(`${PRIMARY}/docs/knowledge/shared`, { recursive: true });
	fs.writeFileSync(`${PRIMARY}/docs/knowledge/shared/y.md`, "y\n");
	assert.match(mint(t, { lifecycle: { action: "merge", learn: { ...good, record: `${PRIMARY}/docs/knowledge/shared/y.md` } } }).res.reason, /Learn checkpoint refused/);
	const nl = mint(t, { lifecycle: { action: "merge", learn: NO_LESSON } });
	assert.equal(nl.res.ok, true, "NO LESSON with a reason proceeds");
	assert.equal(nl.res.lifecycle.learn.state, "NO LESSON");
});

test("Learn is re-read at completion: a record changed after the mint retains every target", () => {
	const t = makeTask();
	const { res, lc } = mint(t);
	assert.equal(res.ok, true);
	fs.appendFileSync(lc.learn.record, "tampered\n");
	removeCheckout(t);
	const out = finish(res.lifecycle);
	assert.equal(out.state, "RETAINED");
	assert.match(out.scratch.reason, /record hash differs/);
	assert.ok(exists(t.scratch) && exists(t.evidence));
});

test("receipt failure fails closed before consent is consumed or authority minted", () => {
	const t = makeTask();
	fs.mkdirSync(`${WT}/_receipts`, { recursive: true });
	fs.writeFileSync(`${WT}/_receipts/${t.name}`, "blocker");
	try {
		const { store, res } = mint(t);
		assert.equal(res.ok, false);
		assert.match(res.reason, /intent receipt/);
		assert.ok(store.findDisposal(t.dir, "merge", 12, t.head), "consent kept");
		assert.equal(store.cleanupCount(), 0);
	} finally { fs.rmSync(`${WT}/_receipts/${t.name}`, { force: true }); }
});

test("ignored content: known disposable caches pass in lifecycle mode only; everything else is retained with its path; legacy stays strict", () => {
	assert.deepEqual(L.classifyIgnored(["node_modules/", ".pytest_cache/", "pkg/__pycache__/", "tsconfig.tsbuildinfo", ".eslintcache"]), []);
	const kept = L.classifyIgnored([".serena/", "dist/", ".env", "node_modules/", "data.db", "sub/node_modules/"]).map((k: any) => k.path);
	assert.deepEqual(kept, [".serena/", "dist/", ".env", "data.db", "sub/node_modules/"]);
	const t = makeTask();
	fs.mkdirSync(`${t.dir}/.serena`);
	fs.writeFileSync(`${t.dir}/.serena/project.yml`, "p\n");
	const r = mint(t);
	assert.equal(r.res.ok, false);
	assert.match(r.res.reason, /ignored content is retained: \.serena\//);
	assert.ok(!exists(`${WT}/_receipts/${t.name}`), "no receipt for a refused mint");
	const t2 = makeTask();
	fs.mkdirSync(`${t2.dir}/node_modules`);
	fs.writeFileSync(`${t2.dir}/node_modules/a.js`, "x");
	const legacy = C.prepareCleanup(request(t2), { store: C.createGrantStore(), owners: terminalOwners(t2), live: live(view(t2)), primary: PRIMARY, mainCwd: PROJ, jobRunning: () => false });
	assert.equal(legacy.ok, false);
	assert.match(legacy.reason, /ignored content is retained: unknown ignored data is never assumed disposable/);
});

test("legacy cleanup is unchanged: no lifecycle key mints a checkout-only scope with no disposal and no plan", () => {
	const t = makeTask();
	const res = C.prepareCleanup(request(t), { store: C.createGrantStore(), owners: terminalOwners(t), live: live(view(t)), primary: PRIMARY, mainCwd: PROJ, jobRunning: () => false });
	assert.equal(res.ok, true, JSON.stringify(res));
	assert.equal(res.grant.disposal, undefined);
	assert.equal(res.lifecycle, undefined);
	assert.ok(!exists(`${WT}/_receipts/${t.name}`));
	assert.throws(() => C.createGrantStore().addCleanupGrant({ ...res.grant, disposal: { evidence: `${WT}/_evidence/zz`, scratch: `${WT}/_scratch/zz` } }), /invalid cleanup scope/);
});

test("manifests: links, hard links, specials, nested repos, databases, secrets and retention markers are refused; plain trees pass", () => {
	const dir = `${root}/m1`;
	fs.mkdirSync(`${dir}/a/b`, { recursive: true });
	fs.writeFileSync(`${dir}/a/b/f.txt`, "f");
	const ok = L.buildManifest(dir);
	assert.equal(ok.ok, true);
	assert.deepEqual(ok.manifest.entries.map((e: any) => e.rel), ["a", "a/b", "a/b/f.txt"]);
	const refuse = (name: string, make: (d: string) => void, why: RegExp) => {
		const d = `${root}/m-${name}`;
		fs.mkdirSync(d);
		make(d);
		const r = L.buildManifest(d);
		assert.equal(r.ok, false, name);
		assert.match(r.reason, why, name);
	};
	refuse("hardlink", (d) => { fs.writeFileSync(`${d}/o.txt`, "o"); fs.linkSync(`${d}/o.txt`, `${d}/o2.txt`); }, /hard link/);
	refuse("db", (d) => fs.writeFileSync(`${d}/x.db`, "d"), /database or secret/);
	refuse("wal", (d) => fs.writeFileSync(`${d}/x.db-wal`, "d"), /database or secret/);
	refuse("secret", (d) => fs.writeFileSync(`${d}/.env`, "S=1"), /database or secret/);
	refuse("retain", (d) => fs.writeFileSync(`${d}/.retain`, "keep"), /retention marker/);
	refuse("nested git", (d) => fs.mkdirSync(`${d}/.git`), /nested repository/);
	try {
		const d = `${root}/m-link`;
		fs.mkdirSync(d);
		fs.symlinkSync(root, `${d}/l`, "junction");
		const r = L.buildManifest(d);
		assert.equal(r.ok, false);
		assert.match(r.reason, /link/);
		assert.ok(exists(`${root}/proj`), "the link target is untouched");
	} catch (error) { if ((error as NodeJS.ErrnoException).code !== "EPERM") throw error; }
	assert.equal(L.buildManifest(`${root}/nonexistent`).ok, false);
	const big = `${root}/m-big`;
	fs.mkdirSync(big);
	for (let i = 0; i < L.MANIFEST_MAX_ENTRIES + 1; i++) fs.writeFileSync(`${big}/f${i}`, "");
	assert.match(L.buildManifest(big).reason, /too large/);
});

test("removal freshness: a change after approval retains with a race reason; scratch failure keeps evidence; unexpected new data is never removed", () => {
	const t = makeTask();
	const { res } = mint(t);
	assert.equal(res.ok, true);
	removeCheckout(t);
	fs.writeFileSync(`${t.scratch}/late.txt`, "new");
	const out = finish(res.lifecycle);
	assert.equal(out.state, "RETAINED");
	assert.match(out.scratch.reason, /changed since approval/);
	assert.match(out.evidence.reason, /scratch stage did not succeed/);
	assert.ok(exists(`${t.scratch}/late.txt`) && exists(`${t.evidence}/REPORT.md`), "everything preserved");
	const t2 = makeTask();
	const m2 = mint(t2);
	removeCheckout(t2);
	fs.writeFileSync(`${t2.evidence}/late.txt`, "new");
	const o2 = finish(m2.res.lifecycle);
	assert.equal(o2.scratch.state, "REMOVED");
	assert.equal(o2.evidence.state, "RETAINED");
	assert.equal(o2.state, "RETAINED");
	assert.ok(!exists(t2.scratch) && exists(`${t2.evidence}/late.txt`));
});

test("partial removal is reported honestly with no retry: a file replaced mid-removal (identity change) stops the stage", () => {
	const dir = `${root}/p1`;
	fs.mkdirSync(`${dir}/d`, { recursive: true });
	fs.writeFileSync(`${dir}/d/a.txt`, "a");
	fs.writeFileSync(`${dir}/d/b.txt`, "b");
	const direct = L.buildManifest(dir).manifest;
	const swapped = { ...direct, entries: direct.entries.map((e: any) => (e.rel === "d/b.txt" ? { ...e, ino: e.ino + 1 } : e)) };
	const p = L.removeApproved(dir, { ...swapped, digest: direct.digest });
	assert.equal(p.state, "PARTIAL");
	assert.match(p.reason, /identity changed during removal.*no retry or rollback/);
	assert.ok(exists(`${dir}/d/b.txt`), "the mismatched file is kept");
});

test("completion gates: failed child, checkout still present, active owner and session cwd inside a target all retain", () => {
	const t = makeTask();
	const { res } = mint(t);
	assert.equal(res.ok, true);
	const failed = finish(res.lifecycle, { cleanExit: false });
	assert.equal(failed.state, "RETAINED");
	assert.match(failed.scratch.reason, /did not close successfully/);
	assert.ok(exists(`${WT}/_receipts/${t.name}/final-${res.grant.id}.json`), "final receipt records the retained outcome");
	const t2 = makeTask();
	const m2 = mint(t2);
	const present = finish(m2.res.lifecycle);
	assert.match(present.checkout.reason, /still exists/);
	assert.ok(exists(t2.scratch));
	const t3 = makeTask();
	const m3 = mint(t3);
	removeCheckout(t3);
	const owners = new S.OwnerTracker();
	owners.begin({ workerId: "w9", role: "general-worker", cwd: t3.scratch });
	const busy = finish(m3.res.lifecycle, { owners });
	assert.match(busy.scratch.reason, /owner worker is still active/);
	const inside = finish(m3.res.lifecycle, { mainCwd: t3.evidence });
	assert.equal(inside.state, "RETAINED", "a replay of the same plan after a receipt exists never deletes either");
	assert.ok(exists(t3.scratch) && exists(t3.evidence));
});

test("mint refuses an active owner of an artifact folder and a main cwd inside a target", () => {
	const t = makeTask();
	const owners = terminalOwners(t);
	owners.begin({ workerId: "w2", role: "general-worker", cwd: t.evidence });
	assert.match(mint(t, { owners }).res.reason, /owner worker is still active/);
	const t2 = makeTask();
	const store = C.createGrantStore();
	store.addDeliveryGrant(binding(t2));
	const r = C.prepareCleanup(request(t2, { action: "merge", learn: learn() }), { store, owners: terminalOwners(t2), live: live(view(t2)), primary: PRIMARY, mainCwd: t2.scratch, jobRunning: () => false });
	assert.equal(r.ok, false);
});

test("wiring: the dialog shows the disposal block, the schemas expose the optional fields, shell deletion stays blocked", () => {
	const src = fs.readFileSync(path.join(import.meta.dirname, "..", "index.ts"), "utf8");
	assert.match(src, /DISPOSAL \(explicit opt-in, this dialog only\)/);
	assert.match(src, /disposal: Type\.Optional\(Type\.Object\(\{ checkout/);
	assert.match(src, /lifecycle: Type\.Optional\(Type\.Object\(\{ action: StringEnum/);
	assert.match(src, /finishLifecycle\(claimedCleanup, cleanExit, defaultCwd\)/);
	const t = makeTask();
	const g = { scope: "child", store: C.createGrantStore(), agentDir: path.join(root, "agent"), gateCommits: true };
	for (const command of [`rm -rf "${t.evidence}"`, `Remove-Item -LiteralPath "${t.scratch}" -Recurse`]) assert.equal(C.guardToolCall(g, "bash", { command }, PRIMARY)?.block, true, command);
});


test("child guard: the opted-in scope round-trips the envelope and allows exactly the checkout removal despite a disposable cache; a non-allowlisted ignored path denies it", () => {
	const GUARD_FILE = path.join(import.meta.dirname, "..", "safety-guard-entry.ts");
	const q = (p: string) => `"${p}"`;
	const t = makeTask();
	fs.mkdirSync(`${t.dir}/node_modules`);
	fs.writeFileSync(`${t.dir}/node_modules/a.js`, "x");
	const { res } = mint(t);
	assert.equal(res.ok, true, JSON.stringify(res));
	const main = C.createGrantStore();
	main.addCleanupGrant(res.grant);
	const launch = C.claimChildGuard(main, "release-engineer", PRIMARY, GUARD_FILE, undefined, true, undefined, res.grant.id);
	const child = C.createGrantStore();
	child.importCleanup(C.loadChildCleanup(launch.childEnv({})[C.CHILD_GRANT_ENV]));
	const g = { scope: "child", store: child, agentDir: path.join(root, "agent"), gateCommits: true, live: live(view(t)) };
	const run = (command: string) => C.guardToolCall(g, "bash", { command }, PRIMARY, C.livePushUrl);
	assert.equal(run(`rm -rf ${q(t.evidence)}`)?.block, true);
	assert.equal(run(`git worktree remove --force ${q(t.dir)}`)?.block, true);
	fs.mkdirSync(`${t.dir}/ignored`);
	fs.writeFileSync(`${t.dir}/ignored/k.txt`, "k");
	assert.equal(run(`git worktree remove ${q(t.dir)}`)?.block, true, "unknown ignored data denies");
	fs.rmSync(`${t.dir}/ignored`, { recursive: true });
	assert.equal(run(`git worktree remove ${q(t.dir)}`), undefined);
	assert.equal(run(`git worktree remove ${q(t.dir)}`)?.block, true, "replay");
});
