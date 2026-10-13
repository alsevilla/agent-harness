import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { hostModules } from "./host-modules.ts";
const TESTS_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO = fileURLToPath(new URL("../../../../", import.meta.url));
const HOST_MODULES = hostModules();
const HOST_RELEASE = JSON.parse(fs.readFileSync(path.join(HOST_MODULES, "@earendil-works", "pi-coding-agent", "package.json"), "utf8")).version;
const TEST_TIMEOUT_MS = 60_000;

test("explicit host-module selection is validated before the installed release fallback", () => {
	const validModules = HOST_MODULES;
	assert.ok(fs.existsSync(path.join(validModules, "@earendil-works", "pi-coding-agent", "dist", "index.js")), `missing installed SDK ${HOST_RELEASE}`);
	const invalidModules = path.join(os.tmpdir(), `missing-host-node_modules-${process.pid}`);
	assert.equal(fs.existsSync(invalidModules), false, `expected absent invalid path: ${invalidModules}`);
	const testFile = path.join(TESTS_DIR, "main-policy-activation.test.ts");
	const env = { ...process.env, NATIVE_PROBE_HOST_MODULES: validModules };
	const valid = spawnSync("bun", ["test", testFile], { cwd: REPO, env, encoding: "utf8", timeout: TEST_TIMEOUT_MS, windowsHide: true });
	assert.equal(valid.error, undefined, valid.error?.message);
	assert.equal(valid.signal, null);
	assert.equal(typeof valid.status, "number");
	assert.equal(valid.status, 0, `${valid.stdout}
${valid.stderr}`);
	assert.match(valid.stdout + valid.stderr, /8 pass/);
	assert.match(valid.stdout + valid.stderr, /Ran 8 tests across 1 file/);
	assert.ok((valid.stdout + valid.stderr).includes(`[${HOST_RELEASE}] a native install`));

	const invalid = spawnSync("bun", ["test", testFile], { cwd: REPO, env: { ...process.env, NATIVE_PROBE_HOST_MODULES: invalidModules }, encoding: "utf8", timeout: TEST_TIMEOUT_MS, windowsHide: true });
	assert.equal(invalid.error, undefined, invalid.error?.message);
	assert.equal(invalid.signal, null);
	assert.equal(typeof invalid.status, "number");
	assert.notEqual(invalid.status, 0, `${invalid.stdout}
${invalid.stderr}`);
	assert.match(invalid.stderr, /NATIVE_PROBE_HOST_MODULES selected/);
	assert.ok(invalid.stderr.includes(invalidModules), `invalid path missing from stderr: ${invalid.stderr}`);
});
