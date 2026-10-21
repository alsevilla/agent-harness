// Optional trusted PR base (prBase): bound context transport, create/edit enforcement and old-loader fail-closed behavior. Offline: no gh, no network; git fixtures only.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import * as core from "../safety-core.ts";

const C = core as any;
const root = fs.realpathSync.native(fs.mkdtempSync(path.join(process.env.PR_BASE_TEST_SCRATCH ?? os.tmpdir(), "pr-base-")));
const cfg = path.join(root, "gitconfig");
fs.writeFileSync(cfg, "");
process.env.GIT_CONFIG_GLOBAL = cfg;
process.env.GIT_CONFIG_NOSYSTEM = "1";
const URL = "https://github.com/acme/widgets.git";
const GUARD_FILE = path.join(import.meta.dirname, "..", "safety-guard-entry.ts");
const git = (dir: string, ...args: string[]) => {
	const r = spawnSync("git", args, { cwd: dir, encoding: "utf8", windowsHide: true });
	assert.equal(r.status, 0, `git ${args.join(" ")}: ${r.stderr}`);
	return r.stdout;
};
const REPO = (() => {
	const dir = path.join(root, "repo");
	fs.mkdirSync(dir, { recursive: true });
	git(dir, "init", "-q");
	git(dir, "-c", "user.name=t", "-c", "user.email=t@example.test", "commit", "-q", "--allow-empty", "-m", "init");
	git(dir, "checkout", "-q", "-b", "feat/x");
	git(dir, "remote", "add", "origin", URL);
	return fs.realpathSync.native(dir);
})();
const GP = ["git", "pu" + "sh"].join(" ");
const PRC = ["gh", "pr", "cre" + "ate"].join(" ");
const PRE = ["gh", "pr", "ed" + "it"].join(" ");
const create = (base: string) => `${PRC} --repo acme/widgets --base ${base} --head feat/x --title "T" --body "b"`;
const edit = `${PRE} 12 --repo acme/widgets --title "T"`;
const blocked = (v: unknown) => (v as { block?: boolean } | undefined)?.block === true;
const VIEW = (base: string) => ({ state: "OPEN", baseRefName: base, headRefName: "feat/x", headRefOid: "a".repeat(40), isCrossRepository: false });
const live = (base = "main") => ({ env: () => ({}), pushUrl: () => URL, tagStatus: () => 2, ghJson: () => VIEW(base) });
const guardFor = (pushTarget: unknown, base = "main") => ({ scope: "child" as const, store: C.createGrantStore(), agentDir: path.join(root, "agent"), pushTarget, gateCommits: true, live: live(base) });
const run = (g: unknown, command: string) => C.guardToolCall(g, "bash", { command }, REPO);
const launch = (prBase?: string, role = C.LEASE_ROLE, withLeases = true, store = C.createGrantStore(), window = { open: true }) => C.claimChildGuard(store, role, REPO, GUARD_FILE, window, withLeases, prBase);
const envelopeOf = (l: any): string => l.childEnv({})[C.CHILD_GRANT_ENV];

// The pre-change loader, verbatim from HEAD 0c27325: it rebuilds the target from candidate/branch/pushUrl and so drops any extra field (the concern that forces a distinct bound key).
function oldLoadChildPushTarget(text: string) {
	const parsed = JSON.parse(text) as { v?: number; pushTarget?: unknown };
	if (!parsed || parsed.v !== 1) throw new TypeError("invalid grant envelope");
	if (parsed.pushTarget === undefined) return undefined;
	const value = parsed.pushTarget as Record<string, unknown>;
	if (!value || typeof value.candidate !== "string" || !path.isAbsolute(value.candidate) || typeof value.pushUrl !== "string") throw new TypeError("invalid push target");
	const target = C.pushBranchTarget(value.candidate, String(value.branch));
	if (!target || target.pushUrl !== value.pushUrl) throw new TypeError("invalid push target");
	return target;
}

test("known base travels in a distinct bound key and roundtrips; absent base keeps the legacy envelope byte-for-byte shape", () => {
	const l = launch("main");
	const env = JSON.parse(envelopeOf(l));
	assert.equal("pushTarget" in env, false, "bound context never uses the legacy key an old loader would downgrade");
	assert.deepEqual(env.pushTargetBound, { candidate: REPO, pushUrl: URL, branch: "feat/x", base: "main" });
	assert.deepEqual(C.loadChildPushTarget(envelopeOf(l)), { candidate: REPO, pushUrl: URL, branch: "feat/x", base: "main" });
	assert.equal(C.loadChildGate(envelopeOf(l)), true);
	const legacy = JSON.parse(envelopeOf(launch()));
	assert.deepEqual(legacy.pushTarget, { candidate: REPO, pushUrl: URL, branch: "feat/x" });
	assert.equal("pushTargetBound" in legacy, false);
	assert.deepEqual(C.loadChildPushTarget(JSON.stringify(legacy)), legacy.pushTarget);
	// Slash-containing and dotted base names are valid branch names.
	assert.equal(C.loadChildPushTarget(envelopeOf(launch("release/1.x"))).base, "release/1.x");
});

test("prBase is honoured only for the trusted release-engineer launch; refusal happens before any grant is claimed or the window closed", () => {
	const store = C.createGrantStore();
	for (const [role, withLeases] of [["scout", true], ["scout", false], [C.LEASE_ROLE, false]] as Array<[string, boolean]>) {
		const window = { open: true };
		assert.throws(() => launch("main", role, withLeases, store, window), /prBase/, `${role} leases=${withLeases}`);
		assert.equal(window.open, true, "a refused launch does not close the claim window");
	}
	for (const bad of ["", " main", "a..b", "-x", "a b", "feat/x", 5, null, {}, ["main"], "x".repeat(101), "a//b", "a.lock"]) {
		assert.throws(() => launch(bad as never), /prBase|base/, JSON.stringify(bad));
	}
	const nonRepo = fs.mkdtempSync(path.join(root, "plain-"));
	assert.throws(() => C.claimChildGuard(C.createGrantStore(), C.LEASE_ROLE, nonRepo, GUARD_FILE, { open: true }, true, "main"), /prBase/, "no verifiable feature branch to bind");
	assert.doesNotThrow(() => launch(undefined), "absent prBase stays the legacy launch");
});

test("PR create must name exactly the bound base; edit may only touch a PR whose live base is the bound one; legacy target stays syntactic", () => {
	const bound = { candidate: REPO, pushUrl: URL, branch: "feat/x", base: "main" };
	assert.equal(run(guardFor(bound), create("main")), undefined, "matching base");
	assert.ok(blocked(run(guardFor(bound), create("release"))), "other base");
	assert.ok(blocked(run(guardFor(bound), create("develop"))), "other valid base");
	assert.equal(run(guardFor(bound, "main"), edit), undefined, "edit of the bound-base PR");
	assert.ok(blocked(run(guardFor(bound, "release"), edit)), "edit of a PR with another live base");
	const legacy = { candidate: REPO, pushUrl: URL, branch: "feat/x" };
	assert.equal(run(guardFor(legacy), create("release")), undefined, "legacy: any syntactically valid base (documented residual)");
	assert.equal(run(guardFor(legacy, "release"), edit), undefined);
	assert.ok(blocked(run(guardFor(legacy), create("feat/x"))), "base equal to feature branch");
	// push and commit rules are unchanged by a bound base
	assert.equal(run(guardFor(bound), `${GP} origin feat/x`), undefined);
});

test("mutated, stripped or ambiguous bound envelopes throw instead of silently degrading to legacy", () => {
	const good = JSON.parse(envelopeOf(launch("main")));
	const withBound = (patch: (b: any) => void) => { const e = structuredClone(good); patch(e.pushTargetBound); return JSON.stringify(e); };
	const cases: Array<[string, string]> = [];
	for (const base of [5, null, "", {}, [], true, "../x", "a..b", "feat/x", " main", "x".repeat(101)]) cases.push([`base ${JSON.stringify(base)}`, withBound((b) => { b.base = base; })]);
	cases.push(["base key removed", withBound((b) => { delete b.base; })]);
	cases.push(["extra key", withBound((b) => { b.extra = 1; })]);
	cases.push(["branch changed", withBound((b) => { b.branch = "feat/y"; })]);
	cases.push(["pushUrl changed", withBound((b) => { b.pushUrl = "https://github.com/acme/other.git"; })]);
	cases.push(["both keys", JSON.stringify({ ...good, pushTarget: { candidate: REPO, pushUrl: URL, branch: "feat/x" } })]);
	cases.push(["both keys, legacy carrying the base", JSON.stringify({ ...good, pushTarget: good.pushTargetBound })]);
	for (const bad of [null, [], "x", 5, true]) cases.push([`bound ${JSON.stringify(bad)}`, JSON.stringify({ ...good, pushTargetBound: bad })]);
	const legacy = JSON.parse(envelopeOf(launch()));
	cases.push(["legacy key carrying a base", JSON.stringify({ ...legacy, pushTarget: { ...legacy.pushTarget, base: "main" } })]);
	for (const [name, text] of cases) assert.throws(() => C.loadChildPushTarget(text), TypeError, name);
	const stripped = { ...good }; delete stripped.pushTargetBound;
	assert.equal(C.loadChildPushTarget(JSON.stringify(stripped)), undefined, "stripped key is the no-target state, which blocks every automatic PR/push path");
	assert.ok(blocked(run({ ...guardFor(undefined), gateCommits: true }, create("main"))), "no target: create blocked");
});

test("old loader compatibility: a bound envelope is invisible to the pre-change loader (fail closed), and a base smuggled into the legacy key would have been silently dropped", () => {
	const env = envelopeOf(launch("main"));
	const old = oldLoadChildPushTarget(env);
	assert.equal(old, undefined, "old loader sees no push target");
	const g = { ...guardFor(old), gateCommits: C.loadChildGate(env) };
	for (const command of [create("main"), create("release"), edit, `${GP} origin feat/x`, 'git commit -m "x"']) assert.ok(blocked(run(g, command)), `old loader blocks ${command}`);
	const naive = JSON.stringify({ v: 1, grants: [], gateCommits: true, pushTarget: { candidate: REPO, pushUrl: URL, branch: "feat/x", base: "main" } });
	const dropped = oldLoadChildPushTarget(naive);
	assert.equal("base" in dropped, false, "why a plain optional field in the old key is unsafe: the old loader discards it");
	assert.ok(!blocked(run({ ...guardFor(dropped), gateCommits: true }, create("release"))), "...and would allow the unbound base");
	assert.throws(() => C.loadChildPushTarget(naive), TypeError, "the new loader refuses that downgraded shape");
});

test("serializeGrants writes the bound key only for a base and never both keys", () => {
	const bound = C.serializeGrants([], [], [], true, { candidate: REPO, pushUrl: URL, branch: "feat/x", base: "main" });
	const plain = C.serializeGrants([], [], [], true, { candidate: REPO, pushUrl: URL, branch: "feat/x" });
	assert.deepEqual(Object.keys(JSON.parse(bound)).filter((k) => k.startsWith("pushTarget")), ["pushTargetBound"]);
	assert.deepEqual(Object.keys(JSON.parse(plain)).filter((k) => k.startsWith("pushTarget")), ["pushTarget"]);
});
