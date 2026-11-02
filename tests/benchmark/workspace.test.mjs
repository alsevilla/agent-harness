// Harness-only replay: explicit roots from git history, held-out tests from the post-task commit, path guards, change snapshots.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { listHarnessTree, materializeHarness, writeCommitFiles, snapshot, diffSnapshots, assertInside, createWorkspace, TOOL_STATE_POLICY, rmWithRetry, RM_MAX_ATTEMPTS } from "./lib/workspace.mjs";

const git = (cwd, ...args) => execFileSync("git", ["-c", "commit.gpgsign=false", "-c", "user.name=bench", "-c", "user.email=bench@example.invalid", ...args], { cwd, encoding: "utf8" }).trim();
const write = (root, rel, text) => { fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true }); fs.writeFileSync(path.join(root, rel), text); };

function fixtureRepo() {
	const repo = fs.mkdtempSync(path.join(os.tmpdir(), "bench-repo-"));
	git(repo, "init", "-q");
	write(repo, "agent/a.ts", "parent-a\n");
	write(repo, "tests/a.test.mjs", "parent-test\n");
	write(repo, "unrelated/outside.txt", "outside\n");
	git(repo, "add", "-A"); git(repo, "commit", "-qm", "parent");
	const parent = git(repo, "rev-parse", "HEAD");
	write(repo, "agent/a.ts", "child-a\n");
	write(repo, "tests/a.test.mjs", "child-test\n");
	write(repo, "agent/new.ts", "new\n");
	git(repo, "add", "-A"); git(repo, "commit", "-qm", "child");
	return { repo, parent, child: git(repo, "rev-parse", "HEAD") };
}

test("materialize writes only harness roots of the parent commit and refuses paths outside the scratch root", () => {
	const { repo, parent } = fixtureRepo();
	const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "bench-scratch-"));
	const dest = path.join(scratch, "parent");
	const result = materializeHarness({ repo, commit: parent, dest, scratchRoot: scratch });
	assert.equal(result.files, 2);
	assert.equal(fs.readFileSync(path.join(dest, "agent/a.ts"), "utf8"), "parent-a\n");
	assert.equal(fs.existsSync(path.join(dest, "unrelated")), false, "non-harness history is never extracted");
	assert.throws(() => materializeHarness({ repo, commit: parent, dest: path.join(os.tmpdir(), "escape-" + Date.now()), scratchRoot: scratch }), /outside the assigned scratch/);
});

test("RFID-named harness paths are excluded from the replay and reported by name only, never extracted", () => {
	const { repo } = fixtureRepo();
	write(repo, "agent/rfid-reader.ts", "x\n");
	git(repo, "add", "-A"); git(repo, "commit", "-qm", "rfid");
	const head = git(repo, "rev-parse", "HEAD");
	const tree = listHarnessTree({ repo, commit: head });
	assert.deepEqual(tree.excluded, ["agent/rfid-reader.ts"]);
	assert.equal(tree.paths.includes("agent/rfid-reader.ts"), false);
	const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "bench-scratch-"));
	const result = materializeHarness({ repo, commit: head, dest: path.join(scratch, "ws"), scratchRoot: scratch });
	assert.deepEqual(result.excludedRfidNamed, ["agent/rfid-reader.ts"]);
	assert.equal(fs.existsSync(path.join(scratch, "ws/agent/rfid-reader.ts")), false);
});

test("held-out files are read from the post-task commit and overwrite worker edits", () => {
	const { repo, parent, child } = fixtureRepo();
	const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "bench-scratch-"));
	const dest = path.join(scratch, "ws");
	materializeHarness({ repo, commit: parent, dest, scratchRoot: scratch });
	write(dest, "tests/a.test.mjs", "worker-weakened-test\n");
	writeCommitFiles({ repo, commit: child, paths: ["tests/a.test.mjs"], dest, scratchRoot: scratch });
	assert.equal(fs.readFileSync(path.join(dest, "tests/a.test.mjs"), "utf8"), "child-test\n");
	assert.throws(() => writeCommitFiles({ repo, commit: child, paths: ["unrelated/outside.txt"], dest, scratchRoot: scratch }), /harness/);
});

test("snapshot diffs report added, modified and removed files relative to the workspace", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bench-snap-"));
	write(dir, "agent/a.ts", "1");
	write(dir, "agent/b.ts", "1");
	const before = snapshot(dir);
	write(dir, "agent/a.ts", "2");
	fs.rmSync(path.join(dir, "agent/b.ts"));
	write(dir, "agent/c.ts", "3");
	assert.deepEqual(diffSnapshots(before, snapshot(dir)), { added: ["agent/c.ts"], modified: ["agent/a.ts"], removed: ["agent/b.ts"] });
});

test("snapshot honors a cooperative stop between files (an interrupted kernel read is not claimed)", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bench-snap-"));
	write(dir, "a.ts", "1");
	assert.throws(() => snapshot(dir, { stop: () => true }), (e) => e.code === "ETIMEDOUT");
	assert.equal(snapshot(dir, { stop: () => false }).size, 1);
});

test("assertInside accepts only descendants of the scratch root", () => {
	assert.doesNotThrow(() => assertInside("C:/s/x/y", "C:/s"));
	assert.throws(() => assertInside("C:/other/y", "C:/s"), /outside/);
	assert.throws(() => assertInside("C:/s/../other", "C:/s"), /outside/);
});

test("the real workspace exposes the tool-state policy and prepare reports the materialized tracked paths it is judged against", async () => {
	const { repo, parent } = fixtureRepo();
	const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "bench-scratch-"));
	const ws = createWorkspace({ repo, scratchRoot: scratch });
	assert.equal(ws.toolStatePolicy, TOOL_STATE_POLICY);
	const prepared = await ws.prepare({ parent }, path.join(scratch, "fresh", "H1"));
	assert.ok(prepared.paths.includes("agent/a.ts"));
	assert.ok(!prepared.paths.some((p) => p.startsWith(".serena")), "the generated root .serena/ state is not materialized");
});

test("the policy is the untracked, newly generated root .serena/ only: tracked, baseline, sibling, nested and look-alike paths are never tool state", () => {
	const { isToolState } = TOOL_STATE_POLICY;
	const ctx = { tracked: new Set([".serena/tracked.yml"]), before: new Map([[".serena/tracked.yml", "h"], [".serena/pre.txt", "h"]]) };
	assert.equal(isToolState(".serena/cache/x.pkl", ctx), true);
	for (const p of [".serena/tracked.yml", ".serena/pre.txt", ".serena2/x", ".serena", ".serenax/x", "sub/.serena/x", "agent/work.txt", "parse.out", ".h4-checks/build-env.test.ts"]) assert.equal(isToolState(p, ctx), false, p);
	assert.equal(isToolState(".serena/y", { tracked: new Set(), before: undefined }), false, "no trusted baseline, no exclusion");
	assert.equal(isToolState(".serena/y", { tracked: undefined, before: new Map() }), false, "no trusted tracked set, no exclusion");
});

// F6: timeoutMs is the TOTAL budget of one materialization; the remaining time is recomputed before every owned subprocess and nothing launches after the cutoff.
import cp from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
const withGitDouble = (costMs, fn) => {
	const orig = cp.execFileSync; const calls = []; const clock = { t: 0 };
	cp.execFileSync = (exe, args, opts) => { if (exe !== "git") return orig(exe, args, opts); calls.push({ command: args[0], timeout: opts.timeout }); clock.t += costMs; return args[0] === "ls-tree" ? "agent/a.ts\0" : Buffer.from("abc blob 7\nparent-a\n"); };
	syncBuiltinESMExports();
	try { return fn(clock, calls); } finally { cp.execFileSync = orig; syncBuiltinESMExports(); }
};
const tmpScratch = () => fs.mkdtempSync(path.join(os.tmpdir(), "bench-scratch-"));

test("sequential ls-tree and cat-file share one total budget: the second call gets the remainder, not another full window", () => {
	withGitDouble(110, (clock, calls) => {
		const scratch = tmpScratch(); const dest = path.join(scratch, "ws");
		assert.throws(() => materializeHarness({ repo: "unused", commit: "c".repeat(40), dest, scratchRoot: scratch, timeoutMs: 119, now: () => clock.t }), (e) => e.code === "ETIMEDOUT");
		assert.deepEqual(calls.map((c) => c.command), ["ls-tree", "cat-file"]);
		assert.equal(calls[0].timeout, 119);
		assert.equal(calls[1].timeout, 9);
		assert.equal(fs.existsSync(dest), false, "an exhausted materialization writes nothing");
	});
});

test("no subprocess is launched after the budget is spent, and a launched one always has a finite positive timeout (never 0 = unbounded)", () => {
	withGitDouble(120, (clock, calls) => {
		const scratch = tmpScratch();
		assert.throws(() => materializeHarness({ repo: "unused", commit: "c".repeat(40), dest: path.join(scratch, "ws"), scratchRoot: scratch, timeoutMs: 119, now: () => clock.t }), (e) => e.code === "ETIMEDOUT");
		assert.deepEqual(calls.map((c) => c.command), ["ls-tree"], "cat-file never launches");
	});
	withGitDouble(0, (clock, calls) => {
		const scratch = tmpScratch();
		clock.t = 0;
		assert.throws(() => materializeHarness({ repo: "unused", commit: "c".repeat(40), dest: path.join(scratch, "ws"), scratchRoot: scratch, timeoutMs: 0.5, now: () => clock.t }), (e) => e.code === "ETIMEDOUT");
		assert.equal(calls.length, 0, "a sub-millisecond remainder floors to 0 and must not launch an unbounded call");
	});
});

test("the workspace passes the runner's remaining-time supplier to every owned subprocess", async () => {
	let remaining = 100; const seen = [];
	const orig = cp.execFileSync;
	cp.execFileSync = (exe, args, opts) => { if (exe !== "git") return orig(exe, args, opts); seen.push(opts.timeout); remaining -= 40; return args[0] === "ls-tree" ? "agent/a.ts\0" : Buffer.from("abc blob 7\nparent-a\n"); };
	syncBuiltinESMExports();
	try {
		const scratch = tmpScratch();
		await createWorkspace({ repo: "unused", scratchRoot: scratch }).prepare({ parent: "d".repeat(40), id: "H1" }, path.join(scratch, "fresh", "H1"), { remainingMs: () => remaining });
	} finally { cp.execFileSync = orig; syncBuiltinESMExports(); }
	assert.deepEqual(seen, [100, 60]);
});

// Secondary bounded rm retry (synthetic rm/sleep/clock: no real lock, no destructive OS repro). It is never quiescence proof.
const lock = (code) => Object.assign(new Error(`${code} locked`), { code });
test("rm retry: a transient lock code is retried within the cap, then succeeds", () => {
	for (const code of ["EPERM", "EACCES", "EBUSY", "ENOTEMPTY"]) {
		let n = 0; const slept = [];
		rmWithRetry("d", { rm: () => { if (++n < 3) throw lock(code); }, sleep: (ms) => slept.push(ms) });
		assert.equal(n, 3, code); assert.equal(slept.length, 2);
	}
});
test("rm retry: any other error is immediate and original", () => {
	let n = 0; const err = lock("ENOENT");
	assert.throws(() => rmWithRetry("d", { rm: () => { n++; throw err; }, sleep: () => assert.fail("no sleep") }), (e) => e === err && e.rmAttempts === 1);
	assert.equal(n, 1);
});
test("rm retry: exhaustion rethrows the ORIGINAL error with attempts and elapsed; never an unbounded loop", () => {
	let n = 0, t = 0; const err = lock("EBUSY");
	assert.throws(() => rmWithRetry("d", { rm: () => { n++; throw err; }, sleep: (ms) => { t += ms; }, now: () => t }), (e) => e === err && e.rmAttempts === RM_MAX_ATTEMPTS && e.rmElapsedMs === t && t > 0);
	assert.equal(n, RM_MAX_ATTEMPTS);
});
test("rm retry: no retry or sleep once the remaining task budget is spent", () => {
	let n = 0; const err = lock("EPERM");
	assert.throws(() => rmWithRetry("d", { remaining: () => 10, rm: () => { n++; throw err; }, sleep: () => assert.fail("budget spent") }), (e) => e === err && e.rmAttempts === 1);
	assert.equal(n, 1);
});
test("rm retry: the remaining budget is rechecked BEFORE every removal attempt, so a sleep that overshoots never allows a post-budget rm; the original error and attempt data are kept", () => {
	// Pure fake clock: attempt 1 sees 60 ms left; the 50 ms sleep really takes 100 ms, so attempt 2 would start 40 ms after the budget.
	let time = 0, n = 0; const err = lock("EPERM"), seen = [];
	assert.throws(() => rmWithRetry("d", { remaining: () => 60 - time, now: () => time, rm: () => { seen.push(60 - time); n++; throw err; }, sleep: () => { time += 100; } }), (e) => e === err && e.code === "EPERM" && e.rmAttempts === 1 && e.rmElapsedMs === 100);
	assert.equal(n, 1, "rm was NOT called after the budget expired"); assert.deepEqual(seen, [60]);
	// An oversleep that still leaves a whole ms retries normally; the exact boundary (0.9 ms left) does not.
	for (const [left, calls] of [[1, 2], [0.9, 1], [0, 1], [-5, 1]]) {
		let t = 0, c = 0;
		assert.equal((() => { try { rmWithRetry("d", { remaining: () => 200 + left - t, now: () => t, rm: () => { c++; if (c === 1) throw lock("EBUSY"); }, sleep: () => { t += 200; } }); return "ok"; } catch (e) { return e.code; } })(), calls === 2 ? "ok" : "EBUSY", String(left));
		assert.equal(c, calls, `left ${left}`);
	}
	// A budget already spent before the FIRST removal removes nothing.
	assert.throws(() => rmWithRetry("d", { remaining: () => 0, rm: () => assert.fail("no rm after the budget"), sleep: () => assert.fail("no sleep") }), (e) => e.rmAttempts === 0);
});
test("materialize removes the old workspace through the bounded retry and still refuses paths outside the scratch root", () => {
	const { repo, parent } = fixtureRepo(); const scratch = tmpScratch(); const dest = path.join(scratch, "shared");
	fs.mkdirSync(dest, { recursive: true }); fs.writeFileSync(path.join(dest, "stale.txt"), "s");
	materializeHarness({ repo, commit: parent, dest, scratchRoot: scratch });
	assert.equal(fs.existsSync(path.join(dest, "stale.txt")), false);
	assert.throws(() => materializeHarness({ repo, commit: parent, dest: os.tmpdir(), scratchRoot: scratch }), /outside the assigned scratch root/);
});
