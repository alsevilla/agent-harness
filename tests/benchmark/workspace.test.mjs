// Harness-only replay: explicit roots from git history, held-out tests from the post-task commit, path guards, change snapshots.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { listHarnessTree, materializeHarness, writeCommitFiles, snapshot, diffSnapshots, assertInside } from "./lib/workspace.mjs";

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

test("assertInside accepts only descendants of the scratch root", () => {
	assert.doesNotThrow(() => assertInside("C:/s/x/y", "C:/s"));
	assert.throws(() => assertInside("C:/other/y", "C:/s"), /outside/);
	assert.throws(() => assertInside("C:/s/../other", "C:/s"), /outside/);
});
