// Acceptance runs ordinary node --test files in the replay workspace; missing files never count as a pass.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { runAcceptance } from "./lib/acceptance.mjs";

const dir = () => fs.mkdtempSync(path.join(os.tmpdir(), "bench-acc-"));

test("passing test files are accepted with pass counts parsed from the TAP output", () => {
	const d = dir();
	fs.writeFileSync(path.join(d, "ok.test.mjs"), "import test from 'node:test'; test('a', () => {});\n");
	const r = runAcceptance({ cwd: d, files: ["ok.test.mjs"] });
	assert.equal(r.accepted, true);
	assert.equal(r.exitCode, 0);
	assert.equal(r.pass >= 1, true);
	assert.equal(r.fail, 0);
});

test("a failing assertion is not accepted, and its counts are kept", () => {
	const d = dir();
	fs.writeFileSync(path.join(d, "bad.test.mjs"), "import test from 'node:test'; import assert from 'node:assert/strict'; test('b', () => assert.equal(1, 2));\n");
	const r = runAcceptance({ cwd: d, files: ["bad.test.mjs"] });
	assert.equal(r.accepted, false);
	assert.notEqual(r.exitCode, 0);
	assert.ok(r.fail >= 1);
});

test("a missing acceptance file is refused with a reason and never counted as passing", () => {
	const r = runAcceptance({ cwd: dir(), files: ["absent.test.mjs"] });
	assert.equal(r.accepted, false);
	assert.match(r.reason, /missing acceptance test absent\.test\.mjs/);
});

test("the acceptance command uses the suite's own toolchain: node TAP by default, the Bun CLI for Bun-written suites", async () => {
	const { acceptanceCommand } = await import("./lib/acceptance.mjs");
	assert.deepEqual(acceptanceCommand(undefined, ["a.test.mjs"]).args.slice(-1), ["a.test.mjs"]);
	assert.ok(acceptanceCommand("node", ["a.test.mjs"]).args.includes("--test-reporter=tap"));
	assert.deepEqual(acceptanceCommand("bun", ["b.test.ts"]), { exe: "bun", args: ["test", "b.test.ts"] });
	assert.throws(() => acceptanceCommand("jest", ["x"]), /node or bun/);
});
