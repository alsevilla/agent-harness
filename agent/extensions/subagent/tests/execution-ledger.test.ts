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

test("inspection reuse notes must at least halve output, including command overhead", () => {
	for (const command of ["git status", `rg ${"long_pattern".repeat(20)}`]) {
		const display = command.length > 90 ? `${command.slice(0, 89)}…` : command;
		const note = `[unchanged: \`${display}\` returned exactly what it returned at step 1, and no file changed since; use that earlier output.]`;
		for (const length of [200, note.length * 2 - 1, note.length * 2]) {
			const l = createExecutionLedger();
			const content = text("x".repeat(length));
			l.onResult("bash", { command }, content, false, cwd);
			assert.deepEqual(l.onResult("bash", { command }, content, false, cwd), length >= note.length * 2 ? text(note) : undefined);
		}
	}
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

// The view used to be a message appended to every request; it held Pi's one cache breakpoint and changed each time, so every request
// wrote the whole history to the cache again (field report: 2.07M cache-write vs 0.75M cache-read tokens, $5.59 for one worker task).
test("the worker entry wires the ledger: the view rides in a tool result, never in a per-request message; handler order; off with PI_SUBAGENT_LEDGER=0", () => {
	const entry = fs.readFileSync(new URL("../safety-guard-entry.ts", import.meta.url), "utf8");
	assert.match(entry, /process\.env\.PI_SUBAGENT_LEDGER === "0" \? undefined : createExecutionLedger\(\)/);
	const context = entry.slice(entry.indexOf('pi.on("context"'), entry.indexOf('pi.on("tool_result"'));
	assert.doesNotMatch(context, /role: "custom"|\.view\(\)/, "the context hook adds no message");
	assert.match(entry, /view = ledger\?\.viewForResult\(\)/);
	assert.ok(entry.indexOf("ledger?.viewForResult()") > entry.indexOf("capShellOutput("), "after the output cap, so a capped output cannot cut it");
	assert.ok(entry.indexOf("ledger.onResult(") < entry.indexOf("dedupe.onResult("), "the ledger sees each read's own output");
	assert.match(entry, /ledger\?\.earlierCopiesGone\(\)/);
	assert.match(entry, /ledger\?\.compacted\(\)/);
	assert.doesNotMatch(fs.readFileSync(new URL("../index.ts", import.meta.url), "utf8"), /execution-ledger/, "workers only");
});

test("small read-only runs do not append inventories; required checks still surface", () => {
	const l = createExecutionLedger();
	for (let i = 0; i < 30; i++) {
		l.onResult("read", { path: `f${i}.ts` }, text("x".repeat(1000)), false, cwd);
		assert.equal(l.viewForResult(), undefined);
	}
	assert.ok(l.view(), "the ledger still records reads");
	l.noteTask("Run `npm test` before completion.");
	assert.match(l.viewForResult()!, /not run yet/);
});

test("small-read inventory deferral does not hide edits or command state", () => {
	for (const tool of ["edit", "bash"]) {
		const l = createExecutionLedger();
		for (let i = 0; i < 4; i++) l.onResult("read", { path: "a.ts", offset: i }, text("small"), false, cwd);
		l.onResult(tool, tool === "edit" ? { path: "a.ts" } : { command: "npm test" }, text("ok"), false, cwd);
		assert.match(l.viewForResult()!, tool === "edit" ? /Changed by you/ : /Checks \(latest run/);
	}
});

test("viewForResult: shown when it first has something, then only when it changed and at least 5 calls later; a compaction shows it again", () => {
	const l = createExecutionLedger();
	const shown: number[] = [];
	const call = (n: number, tool: string, input: Record<string, unknown>) => { l.onResult(tool, input, [{ type: "text", text: "x".repeat(20_000) }], false, "/w"); if (l.viewForResult()) shown.push(n); };
	for (let n = 1; n <= 4; n++) call(n, "read", { path: `src/f${n}.rs` });
	assert.deepEqual(shown, [4], "the first view, once there is enough to show");
	for (let n = 5; n <= 8; n++) call(n, "read", { path: `src/f${n}.rs` });
	assert.deepEqual(shown, [4], "changed, but not yet 5 calls later");
	call(9, "read", { path: "src/f9.rs" });
	assert.deepEqual(shown, [4, 9]);
	for (let n = 10; n <= 20; n++) call(n, "bash", { command: "git status" }); // inspections do not change the view
	assert.deepEqual(shown, [4, 9], "an unchanged view is not shown again");
	l.compacted();
	call(21, "read", { path: "src/g1.rs" }); call(22, "read", { path: "src/g2.rs" });
	assert.deepEqual(shown, [4, 9, 21], "after a compaction the view is shown again at the next call, then waits again");
});
