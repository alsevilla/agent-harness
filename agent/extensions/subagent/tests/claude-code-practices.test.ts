// Practices adapted from Claude Code: a tighter cap on long shell output, auto-format after edits from the user's profile only, the
// ledger tracking the checks a packet names, and /subagent changes (what a worker changed and how to undo it, never run automatically).
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { capShellOutput, OUTPUT_CAP_DEFAULT, outputCapFromEnv } from "../output-cap.ts";
import { createAutoFormat, loadFormatConfig } from "../auto-format.ts";
import { createExecutionLedger, packetChecks } from "../execution-ledger.ts";
import { formatChanges, type TraceRecord } from "../trace.ts";

const text = (t: string) => [{ type: "text", text: t }];
const tmp = (prefix: string) => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));

test("long shell output keeps its start and end, with the full text on disk; short output, other tools and off pass", () => {
	const dir = tmp("cap-");
	try {
		const log = `START ${"a".repeat(30_000)} END`;
		const out = capShellOutput("bash", text(log), {}, OUTPUT_CAP_DEFAULT, dir)!;
		const t = out[0].text!;
		assert.ok(t.startsWith("START "), "the start stays");
		assert.ok(t.endsWith(" END"), "the end stays");
		assert.ok(t.length < 11_000);
		const saved = /the full output is in (\S+); read it/.exec(t)![1];
		assert.equal(fs.readFileSync(saved, "utf8"), log, "the full output is on disk");
		assert.match(t, /\[… 20,010 characters cut to keep your context small: /);
		const piFile = capShellOutput("powershell", text(log), { fullOutputPath: "C:\\tmp\\pi-bash-1.log" }, OUTPUT_CAP_DEFAULT, dir)![0].text!;
		assert.match(piFile, /the full output is in C:\\tmp\\pi-bash-1\.log/, "Pi's own full-output file is reused");
		assert.equal(capShellOutput("bash", text("short"), {}, OUTPUT_CAP_DEFAULT, dir), undefined);
		assert.equal(capShellOutput("read", text(log), {}, OUTPUT_CAP_DEFAULT, dir), undefined, "reads are not shell output");
		assert.equal(capShellOutput("bash", text(log), {}, 0, dir), undefined, "0 turns it off");
		assert.equal(outputCapFromEnv({}), 16_000);
		assert.equal(outputCapFromEnv({ PI_SUBAGENT_OUTPUT_CAP: "0" }), 0);
		assert.equal(outputCapFromEnv({ PI_SUBAGENT_OUTPUT_CAP: "500" }), 11_000, "never below head + tail + a margin");
	} finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("auto-format: rules from the profile file only, a changed file gets one line, a failure gets its output, no rule or no change adds nothing", () => {
	const dir = tmp("fmt-");
	try {
		const cfgFile = path.join(dir, "format.json");
		assert.equal(loadFormatConfig(cfgFile), undefined, "no file: nothing runs");
		fs.writeFileSync(cfgFile, JSON.stringify({ rules: [{ match: [".rs"], command: ["rustfmt", "{file}"] }, { match: ["rs"], command: ["bad"] }, { match: [".ts"], command: ["prettier"] }] }));
		const cfg = loadFormatConfig(cfgFile)!;
		assert.deepEqual(cfg.rules.map((r) => r.command[0]), ["rustfmt"], "rules without a dot extension or without {file} are dropped");
		const file = path.join(dir, "a.rs");
		fs.writeFileSync(file, "fn  main(){}\n");
		const calls: unknown[][] = [];
		const fake = ((cmd: string, args: string[]) => { calls.push([cmd, args]); fs.writeFileSync(file, "fn main() {}\n"); return { status: 0, stdout: "", stderr: "" }; }) as never;
		const fmt = createAutoFormat(cfg, fake);
		const out = fmt.onResult("edit", { path: "a.rs" }, text("ok"), false, dir)!;
		assert.equal(out[1].text, "[harness] Formatted a.rs with rustfmt; read the changed lines again before your next edit there.");
		assert.equal((calls[0][1] as string[]).at(-1)?.replace(/^"|"$/g, ""), file, "{file} is the absolute path");
		const noop = createAutoFormat(cfg, (() => ({ status: 0, stdout: "", stderr: "" })) as never);
		assert.equal(noop.onResult("edit", { path: "a.rs" }, text("ok"), false, dir), undefined, "an unchanged file adds nothing");
		const failing = createAutoFormat(cfg, (() => ({ status: 1, stdout: "", stderr: "error: expected one of `;`\n  --> a.rs:1:4" })) as never);
		assert.match(failing.onResult("write", { path: "a.rs" }, text("ok"), false, dir)![1].text!, /^\[harness\] rustfmt reported a problem in a\.rs: error: expected one of `;` --> a\.rs:1:4$/);
		assert.equal(fmt.onResult("edit", { path: "a.md" }, text("ok"), false, dir), undefined, "no rule for the extension");
		assert.equal(fmt.onResult("edit", { path: "a.rs" }, text("failed"), true, dir), undefined, "a failed edit is not formatted");
		assert.equal(createAutoFormat(undefined).onResult("edit", { path: "a.rs" }, text("ok"), false, dir), undefined);
	} finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("the ledger lists the checks the packet names until each has run", () => {
	const task = "Task: Pace the SMS sender.\nChecks:\n- `cargo test -p backend sms_queue`\n- `cargo clippy -p backend -- -D warnings`\n```\n$ npm run build\n```\nRead `backend/src/main.rs` first.";
	assert.deepEqual(packetChecks(task), ["npm run build", "cargo test -p backend sms_queue", "cargo clippy -p backend -- -D warnings"]);
	const l = createExecutionLedger();
	l.noteTask(task);
	l.onResult("read", { path: "backend/src/main.rs" }, text("x"), false, "/w");
	l.onResult("edit", { path: "backend/src/sms.rs" }, text("ok"), false, "/w");
	l.onResult("bash", { command: "cd backend && cargo test -p backend sms_queue -- --nocapture" }, text("ok"), false, "/w");
	l.onResult("read", { path: "backend/src/sms.rs" }, text("y"), false, "/w");
	assert.match(l.view()!, /\nChecks the packet names, not run yet: `npm run build`; `cargo clippy -p backend -- -D warnings`/);
	l.onResult("bash", { command: "npm run build" }, text("ok"), false, "/w");
	l.onResult("bash", { command: "cargo clippy -p backend -- -D warnings" }, text("ok"), false, "/w");
	assert.match(l.view()!, /\nEvery check the packet names has run at least once\./);
});

test("/subagent changes lists a worker's edited files with their git state and the undo commands, and runs none of them", () => {
	const repo = tmp("changes-");
	const git = (...args: string[]) => spawnSync("git", args, { cwd: repo, encoding: "utf8" });
	try {
		git("init", "-q");
		fs.mkdirSync(path.join(repo, "src"));
		fs.writeFileSync(path.join(repo, "src", "a.rs"), "one\n");
		git("add", "-A");
		git("-c", "user.name=t", "-c", "user.email=t@example.test", "commit", "-q", "-m", "init");
		fs.writeFileSync(path.join(repo, "src", "a.rs"), "one\ntwo\n");
		fs.writeFileSync(path.join(repo, "src", "new.rs"), "fn x() {}\n");
		const tool = (name: string, target: string, state: "ok" | "error" = "ok") => ({ name, command: `${name} · ${target}`, state, output: "", target, startedAt: 0, endedAt: 1 });
		const record: TraceRecord = { id: "w:4", name: "backend-worker", task: "t", state: "failed", model: "m", cwd: repo, startedAt: 0, tools: [tool("edit", "src/a.rs"), tool("edit", "src/a.rs"), tool("write", "src/new.rs"), tool("edit", "src/gone.rs", "error")] };
		const reader = (cwd: string, args: string[]) => { const r = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" }); return r.status === 0 ? r.stdout : undefined; };
		const out = formatChanges(record, reader);
		assert.match(out, /^Changes by #4 backend-worker \(failed\) in .*changes-.*:\n/);
		assert.match(out, /\n {2}src\/a\.rs {2}\(2 edits\) {2}modified \+1 -0/);
		assert.match(out, /\n {2}src\/new\.rs {2}\(1 write\) {2}new, untracked/);
		assert.doesNotMatch(out, /gone\.rs/, "a failed edit changed nothing");
		assert.match(out, /To undo \(not run; it discards every uncommitted change in these files, including any made before this worker; run it yourself or ask main to request approval\):\n {2}git restore -- src\/a\.rs\n {2}delete the new files: src\/new\.rs$/);
		assert.equal(fs.readFileSync(path.join(repo, "src", "a.rs"), "utf8"), "one\ntwo\n", "nothing was restored");
		assert.match(formatChanges({ ...record, tools: [] }, reader), /: no successful edit or write\.$/);
	} finally { fs.rmSync(repo, { recursive: true, force: true }); }
});

test("the worker entry wires format, the output cap last, and the packet checks; the monitor routes /subagent changes", () => {
	const entry = fs.readFileSync(new URL("../safety-guard-entry.ts", import.meta.url), "utf8");
	assert.match(entry, /createAutoFormat\(loadFormatConfig\(path\.join\(getAgentDir\(\), "format\.json"\)\)\)/, "commands come from the user's profile only");
	assert.ok(entry.lastIndexOf('pi.on("tool_result"') === entry.indexOf('pi.on("tool_result", (event: any) => {\n\t\ttry {\n\t\t\tconst content = capShellOutput('), "the output cap is the last result handler");
	assert.ok(entry.indexOf("ledger.onResult(") < entry.indexOf("capShellOutput("), "the ledger records the whole output first");
	assert.match(entry, /ledger\?\.noteTask\(text\)/);
	const monitor = fs.readFileSync(new URL("../monitor.ts", import.meta.url), "utf8");
	assert.match(monitor, /else if \(text === "changes" \|\| text\.startsWith\("changes "\)\) this\.changes\(ctx, text\.slice\(7\)\.trim\(\)\)/);
	assert.doesNotMatch(monitor.slice(monitor.indexOf("changes(ctx: ExtensionContext")), /\["restore"|"checkout"|"clean"/, "the command only reads");
});
