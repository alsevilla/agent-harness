// Contract for the Node-only test entrypoint: every test file is discovered exactly once, no suite depends on Bun,
// and the package scripts point at the canonical runner.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
// @ts-expect-error plain .mjs entrypoint without types
import { ROOT, WRAPPED, discoverTests, plan } from "../scripts/run-node-tests.mjs";

const files: string[] = discoverTests();

test("runner discovery equals every git-visible test file (nothing silently omitted)", () => {
	const git = execFileSync("git", ["ls-files", "-co", "--exclude-standard", "-z"], { cwd: ROOT, encoding: "utf8" }).split("\0").filter((f) => /\.(?:test\.(?:ts|mjs)|node\.ts)$/.test(f) && fs.existsSync(path.join(ROOT, f)));
	assert.deepEqual(files, git.sort());
	assert.ok(files.length > 0);
});

test("each discovered file runs exactly once: wrapper-covered suites are excluded only while their wrapper launches them", () => {
	const { run, covered } = plan(files);
	assert.equal(new Set(run).size, run.length);
	assert.deepEqual([...run, ...covered].sort(), files);
	assert.deepEqual(covered.sort(), Object.keys(WRAPPED).sort());
	assert.throws(() => plan(files, path.join(ROOT, "tests", "fixtures")), /wrapper-covered|ENOENT/);
});

test("no test source imports bun:test, calls the Bun global or branches on a Bun runtime", () => {
	const banned = /bun:test|\bBun\.|process\.versions\.bun|import\.meta\.dir\b|\bspawnSync\(\s*"bun"/;
	const self = "tests/node-only-runner.test.ts";
	const hits = files.filter((f) => f !== self && banned.test(fs.readFileSync(path.join(ROOT, f), "utf8")));
	assert.deepEqual(hits, []);
});

test("package scripts use the canonical Node runner", () => {
	const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
	assert.equal(pkg.scripts.test, "node scripts/run-node-tests.mjs");
	assert.equal(pkg.scripts["test:list"], "node scripts/run-node-tests.mjs --list");
	assert.equal(pkg.dependencies, undefined);
	assert.equal(pkg.devDependencies, undefined);
});
