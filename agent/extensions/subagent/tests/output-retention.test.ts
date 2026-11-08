import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { OUTPUT_LOG_RETENTION_MS, pruneWorkerOutput } from "../output-cap.ts";

const oldName = "0123456789abcdef.log";
const recentName = "fedcba9876543210.log";
const now = Date.now();
function log(root: string, owner: string, name = oldName, age = OUTPUT_LOG_RETENTION_MS + 1_000) {
	const dir = path.join(root, owner);
	fs.mkdirSync(dir, { recursive: true });
	const file = path.join(dir, name);
	fs.writeFileSync(file, "saved output");
	fs.utimesSync(file, new Date(now - age), new Date(now - age));
	return file;
}

test("retention removes only expired logs of exited owners, preserving recent, active and legacy logs", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "output-retention-"));
	try {
		const stale = log(root, "123");
		const recent = log(root, "123", recentName, 1_000);
		const boundary = log(root, "124", oldName, OUTPUT_LOG_RETENTION_MS);
		const active = log(root, "125");
		const legacy = log(root, "");
		const unrelated = log(root, "123", "notes.txt");
		log(root, "126");
		pruneWorkerOutput(root, now, (pid) => pid === 125);
		assert.equal(fs.existsSync(stale), false);
		assert.equal(fs.existsSync(path.join(root, "126")), false, "empty expired owner directory removed");
		for (const file of [recent, boundary, active, legacy, unrelated]) assert.ok(fs.existsSync(file), file);
		pruneWorkerOutput(root, now, () => { throw new Error("cannot determine liveness"); });
		assert.ok(fs.existsSync(active), "unknown liveness fails closed");
		pruneWorkerOutput(path.join(root, "absent"), now);
	} finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("retention skips links and retains a real running process regardless of log age", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "output-retention-"));
	try {
		const active = log(root, String(process.pid));
		pruneWorkerOutput(root, now);
		assert.ok(fs.existsSync(active));
		if (process.platform !== "win32") {
			const outside = log(root, "outside");
			fs.symlinkSync(path.join(root, "outside"), path.join(root, "123"));
			fs.mkdirSync(path.join(root, "124"));
			const link = path.join(root, "124", oldName);
			fs.symlinkSync(outside, link);
			pruneWorkerOutput(root, now, () => false);
			assert.ok(fs.existsSync(outside));
			assert.ok(fs.lstatSync(link).isSymbolicLink());
			assert.ok(fs.lstatSync(path.join(root, "123")).isSymbolicLink());
		}
	} finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("default output storage is owned by the worker PID and duplicate output reuses its file", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "output-retention-"));
	try {
		const moduleURL = new URL("../output-cap.ts", import.meta.url).href;
		const source = `import { capShellOutput } from ${JSON.stringify(moduleURL)};
		const content = [{type: 'text', text: 'x'.repeat(20000)}];
		capShellOutput('bash', content, {}, 16000);
		capShellOutput('bash', content, {}, 16000);
		console.log(process.pid);`;
		const result = spawnSync(process.execPath, ["--experimental-strip-types", "--disable-warning=MODULE_TYPELESS_PACKAGE_JSON", "--input-type=module", "-e", source], {
			encoding: "utf8", env: { ...process.env, TMPDIR: root, TMP: root, TEMP: root },
		});
		assert.equal(result.status, 0, result.stderr);
		const dir = path.join(root, "pi-worker-output", result.stdout.trim());
		const names = fs.readdirSync(dir);
		assert.equal(names.length, 1);
		assert.equal(fs.readFileSync(path.join(dir, names[0]), "utf8"), "x".repeat(20000));
	} finally { fs.rmSync(root, { recursive: true, force: true }); }
});
