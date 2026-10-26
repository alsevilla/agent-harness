// CLI regression for --max-rework-rounds: an explicit whole number is required before any run starts. Synthetic adapter only.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { main } from "./cli.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REAL = JSON.parse(fs.readFileSync(path.join(HERE, "manifest.json"), "utf8"));

// Output stays in a temp directory (os.tmpdir() is the approved TEMP for this run); the console is silenced per call.
const dir = (name) => fs.mkdtempSync(path.join(os.tmpdir(), `bench-cli-${name}-`));
async function quiet(fn) {
	const log = console.log;
	console.log = () => {};
	try { return await fn(); } finally { console.log = log; }
}

// Refusal: the manifest path is deliberately absent, so any run or manifest load would fail with ENOENT, not the flag message.
// A bare flag is followed by --scratch in every case, so it parses as boolean true (the defect under test).
for (const [label, flagTokens] of [
	["bare flag (followed by another flag)", ["--max-rework-rounds"]],
	["empty value", ["--max-rework-rounds", ""]],
	["negative value", ["--max-rework-rounds", "-1"]],
	["noninteger value", ["--max-rework-rounds", "1.5"]],
	["exponent form", ["--max-rework-rounds", "1e3"]],
	["unsafe integer", ["--max-rework-rounds", "9007199254740993"]],
]) {
	test(`refuses --max-rework-rounds ${label} before any run starts`, async () => {
		const d = dir("refuse");
		const out = path.join(d, "result.json");
		const scratch = path.join(d, "work");
		const argv = ["run", "--mode", "fresh", "--adapter", "synthetic", ...flagTokens, "--scratch", scratch, "--out", out, "--manifest", path.join(d, "absent.json")];
		await assert.rejects(quiet(() => main(argv)), (e) => /--max-rework-rounds/.test(e.message) && !/ENOENT/.test(e.message), `${label}: expected the flag refusal`);
		assert.equal(fs.existsSync(out), false, "no result file");
		assert.equal(fs.existsSync(scratch), false, "no scratch work directory");
	});
}

// Valid values: explicit 0 and a positive integer are kept, and the recorded source shows the typed value.
for (const v of ["0", "3"]) {
	test(`--max-rework-rounds ${v} is kept as the typed value with a source that shows it`, async () => {
		const d = dir("valid");
		const out = path.join(d, "result.json");
		const manifest = path.join(d, "one-task.json");
		fs.writeFileSync(manifest, JSON.stringify({ schemaVersion: REAL.schemaVersion, name: "cli-one-task", tasks: [REAL.tasks[0]] }));
		await quiet(() => main(["run", "--mode", "fresh", "--adapter", "synthetic", "--max-rework-rounds", v, "--scratch", path.join(d, "work"), "--out", out, "--manifest", manifest]));
		const r = JSON.parse(fs.readFileSync(out, "utf8"));
		assert.deepEqual(r.config.maxReworkRounds, { value: Number(v), source: `run flag --max-rework-rounds ${v}` });
		assert.equal(r.synthetic, true);
	});
}
