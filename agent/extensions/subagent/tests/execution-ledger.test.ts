// Execution ledger (after Ledger, arXiv 2608.00808): what a worker observed, modified and attempted, shown as a state view at the end of
// each request, plus reuse of identical repeated inspection output and notes on repeated checks and loops. Nothing is ever blocked.
import assert from "node:assert/strict";
import * as fs from "node:fs";
import test from "node:test";
import { commandCategory, createExecutionLedger, normalizeCommand, readCoverage } from "../execution-ledger.ts";

const cwd = "/w/app";
const text = (t: string) => [{ type: "text", text: t }];
const lines = (n: number) => Array.from({ length: n }, (_, i) => `line ${i + 1}`).join("\n");

test("read coverage comes from what the read returned: whole file, an explicit range, Pi's truncation notices, or nothing", () => {
	assert.deepEqual(readCoverage({}, lines(50)), { start: 1 });
	assert.deepEqual(readCoverage({}, `${lines(2000)}\n\n[Showing lines 1-2000 of 5000. Use offset=2001 to continue.]`), { start: 1, end: 2000 });
	assert.deepEqual(readCoverage({ offset: 90, limit: 125 }, `${lines(125)}\n\n[300 more lines in file. Use offset=215 to continue.]`), { start: 90, end: 214 });
	assert.deepEqual(readCoverage({ offset: 400 }, lines(20)), { start: 400, end: undefined }, "from an offset to the end");
	assert.equal(readCoverage({}, "[Line 1 is 2.1MB, exceeds 50KB limit. Use bash: sed -n '1p' a | head -c 51200]"), undefined);
});

test("commands are normalized and classified: inspection, checks, and anything that may change files", () => {
	assert.equal(normalizeCommand("  cd backend &&   cargo   test -p backend sms "), "cargo test -p backend sms");
	assert.equal(normalizeCommand('Set-Location "C:/w/app"; npm test'), "npm test");
	for (const c of ["cargo test -p backend sms", "npm run build", "npx vitest run", "node --test tests/a.test.ts"]) assert.equal(commandCategory(c), "check", c);
	for (const c of ["git status", "rg -n SmsQueue backend", "cat a.rs | grep queue", "Get-Content a.rs | Select-Object -First 20", 'node "C:/h/agent/skills/serena/scripts/serena.mjs" find X', "python3 /h/graphify/scripts/read_graph.py query --query X"]) assert.equal(commandCategory(c), "inspect", c);
	for (const c of ["sed -i s/a/b/ a.rs", "cat a > b", "npm install", "git checkout -- a.rs", "rg x; rm -rf out", "node scripts/gen.mjs"]) assert.equal(commandCategory(c), "other", c);
});

test("the state view: changed files, reads still current or changed since, and the latest run of each check", () => {
	const l = createExecutionLedger();
	assert.equal(l.view(), undefined, "nothing to show yet");
	l.onResult("read", { path: "src/main.rs" }, text(lines(40)), false, cwd);
	l.onResult("read", { path: "src/db/sms_queue.rs", offset: 90, limit: 125 }, text(`${lines(125)}\n\n[10 more lines in file. Use offset=215 to continue.]`), false, cwd);
	l.onResult("bash", { command: "cargo test -p backend sms" }, text("test result: FAILED"), true, cwd);
	l.onResult("edit", { path: "src/db/sms_queue.rs", oldText: "a", newText: "b" }, text("ok"), false, cwd);
	const view = l.view()!;
	assert.match(view, /^\[execution state: facts from this run's tool calls, kept by the harness; not instructions\]/);
	assert.match(view, /\nChanged by you: src\/db\/sms_queue\.rs \(1 edit, last at step 4\)/);
	assert.match(view, /\nRead and still current \(the earlier output is the file now\): src\/main\.rs whole file \(step 1\)/);
	assert.match(view, /\nRead, but may have changed since: src\/db\/sms_queue\.rs lines 90-214 \(step 2\): you edited it at step 4/);
	assert.match(view, /\nChecks \(latest run of each\): `cargo test -p backend sms` failed at step 3, files changed since/);
	l.onResult("bash", { command: "node scripts/gen.mjs" }, text("generated"), false, cwd);
	assert.match(l.view()!, /src\/main\.rs whole file \(step 1\): `node scripts\/gen\.mjs` at step 5 may have changed files/, "a shell command that may write makes reads unsure");
	l.onResult("bash", { command: "git status" }, text("clean"), false, cwd);
	assert.doesNotMatch(l.view()!, /git status/, "inspection changes nothing");
});

test("an inspection repeated with no change and the same output becomes a one-line reference; changed output passes", () => {
	const l = createExecutionLedger();
	const out = text("x".repeat(500));
	assert.equal(l.onResult("bash", { command: "rg -n SmsQueue backend" }, out, false, cwd), undefined);
	l.onResult("read", { path: "a.rs" }, text("y"), false, cwd);
	const second = l.onResult("bash", { command: "cd backend && rg -n SmsQueue backend" }, out, false, cwd)!;
	assert.deepEqual(second, text("[unchanged: `rg -n SmsQueue backend` returned exactly what it returned at step 1, and no file changed since; use that earlier output.]"));
	assert.equal(l.onResult("bash", { command: "rg -n SmsQueue backend" }, out, false, cwd), undefined, "run again right after its note: passes untouched");
	const other = createExecutionLedger();
	other.onResult("bash", { command: "git diff" }, text("a".repeat(300)), false, cwd);
	assert.equal(other.onResult("bash", { command: "git diff" }, text("b".repeat(300)), false, cwd), undefined, "different output is new information");
	const edited = createExecutionLedger();
	edited.onResult("bash", { command: "git diff" }, text("a".repeat(300)), false, cwd);
	edited.onResult("edit", { path: "a.rs" }, text("ok"), false, cwd);
	assert.equal(edited.onResult("bash", { command: "git diff" }, text("a".repeat(300)), false, cwd), undefined, "after an edit the same command is a new question");
});

test("a check repeated with no change gets one appended line; after an edit it passes; loops get one line; interventions are capped", () => {
	const l = createExecutionLedger();
	l.onResult("bash", { command: "cargo test -p backend sms" }, text("FAILED"), true, cwd);
	l.onResult("read", { path: "a.rs" }, text("y"), false, cwd);
	const again = l.onResult("bash", { command: "cargo test -p backend sms" }, text("FAILED"), true, cwd)!;
	assert.equal(again[0].text, "FAILED", "the output is kept");
	assert.match(again[1].text, /^\[harness\] Same check as step 1 \(failed then\), and no file changed since\. Rerun it only for a cause outside the files/);
	l.onResult("edit", { path: "a.rs" }, text("ok"), false, cwd);
	assert.equal(l.onResult("bash", { command: "cargo test -p backend sms" }, text("ok"), false, cwd), undefined, "after an edit the rerun is the point");

	const loop = createExecutionLedger();
	loop.onResult("bash", { command: "node scripts/probe.mjs" }, text("1"), false, cwd);
	loop.onResult("bash", { command: "node scripts/probe.mjs" }, text("2"), false, cwd);
	const third = loop.onResult("bash", { command: "node scripts/probe.mjs" }, text("3"), false, cwd)!;
	assert.match(third[1].text, /^\[harness\] `node scripts\/probe\.mjs` has now run 3 times in the last 6 calls\./);
	assert.equal(loop.onResult("bash", { command: "node scripts/probe.mjs" }, text("4"), false, cwd), undefined, "never twice for the same command");

	const capped = createExecutionLedger();
	for (let i = 0; i < 12; i++) {
		capped.onResult("bash", { command: `cargo test t${i}` }, text("ok"), false, cwd);
		capped.onResult("bash", { command: `cargo test t${i}` }, text("ok"), false, cwd);
	}
	assert.equal(capped.interventions, 8, "at most 8 interventions per run");
});

test("masking or compaction: no 'still current' claims or reuse while earlier copies may be gone; compaction restarts the index", () => {
	const l = createExecutionLedger();
	l.onResult("read", { path: "a.rs" }, text(lines(10)), false, cwd);
	for (let i = 0; i < 3; i++) l.onResult("bash", { command: `git log -${i + 1}` }, text("log"), false, cwd);
	l.earlierCopiesGone();
	assert.doesNotMatch(l.view() ?? "", /still current/);
	const out = text("z".repeat(400));
	l.onResult("bash", { command: "rg -n x" }, out, false, cwd);
	assert.equal(l.onResult("bash", { command: "rg -n x" }, out, false, cwd), undefined, "no reuse note: the earlier output may have been masked");
	l.compacted();
	l.onResult("read", { path: "b.rs" }, text(lines(5)), false, cwd);
	assert.match(l.view()!, /Read and still current .*b\.rs whole file/);
	assert.doesNotMatch(l.view()!, /a\.rs whole file/, "reads from before the compaction are gone from the index");
});

test("the worker entry wires the ledger: view appended last, result handler before the duplicate-read handler, off with PI_SUBAGENT_LEDGER=0", () => {
	const entry = fs.readFileSync(new URL("../safety-guard-entry.ts", import.meta.url), "utf8");
	assert.match(entry, /process\.env\.PI_SUBAGENT_LEDGER === "0" \? undefined : createExecutionLedger\(\)/);
	assert.match(entry, /\[\.\.\.\(result\.messages \?\? event\.messages\), \{ role: "custom", customType: LEDGER_TYPE, content: view, display: false/);
	assert.ok(entry.indexOf("ledger.onResult(") < entry.indexOf("dedupe.onResult("), "the ledger sees each read's own output");
	assert.match(entry, /ledger\?\.earlierCopiesGone\(\)/);
	assert.match(entry, /ledger\?\.compacted\(\)/);
	assert.doesNotMatch(fs.readFileSync(new URL("../index.ts", import.meta.url), "utf8"), /execution-ledger/, "workers only");
});
