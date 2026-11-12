// Durable worker trace (worker-trace.ts): one JSON-lines file per worker with its launch, tool calls, results and guard refusals.
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { createWorkerTrace, pruneTraces, TRACE_RETENTION_MS, traceDir } from "../worker-trace.ts";

const lines = (file: string) => fs.readFileSync(file, "utf8").trim().split("\n").map((l) => JSON.parse(l));
const meta = { role: "database-specialist", model: "anthropic/claude-haiku-5-5", cwd: "D:/work/RFID/RFIDAttendance-Rust", readOnlyRoot: "D:/work/RFID/RFIDAttendance-Rust", jobId: "bg-3", workerId: "0:4", task: "Design the attendance schema." };

test("a trace records the launch, each tool call with its arguments, each result with its guard rule, and the exit", () => {
	const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "worker-trace-"));
	try {
		const trace = createWorkerTrace(agentDir, meta, {})!;
		assert.equal(path.dirname(trace.file), traceDir(agentDir));
		assert.match(path.basename(trace.file), /^\d{4}-\d{2}-\d{2}T[\d-]+Z-database-specialist-0_4\.jsonl$/);
		trace.event({ type: "tool_execution_start", toolCallId: "c1", toolName: "powershell", args: { command: `[IO.File]::WriteAllText("DATABASE-DESIGN.md", "x")` } });
		trace.event({ type: "tool_execution_end", toolCallId: "c1", toolName: "powershell", isError: true, result: { content: [{ type: "text", text: "Blocked by harness safety guard [READ_ONLY_ROLE] op 1234: .NET file method writes into the candidate checkout" }] } });
		trace.event({ type: "tool_execution_start", toolCallId: "c2", toolName: "read", args: { path: "src/db.rs", huge: "x".repeat(10_000) } });
		trace.event({ type: "tool_execution_end", toolCallId: "c2", toolName: "read", isError: false, result: { content: [{ type: "text", text: "fn main() {}" }] } });
		trace.event({ type: "message_update" }); // other events are not recorded
		trace.close(0, "stop");
		trace.event({ type: "tool_execution_start", toolCallId: "late", toolName: "bash", args: {} }); // nothing after close
		const [launch, call1, result1, call2, result2, end, ...rest] = lines(trace.file);
		assert.deepEqual(rest, []);
		assert.equal(launch.type, "worker");
		assert.deepEqual({ role: launch.role, model: launch.model, readOnlyRoot: launch.readOnlyRoot, jobId: launch.jobId, task: launch.task }, { role: meta.role, model: meta.model, readOnlyRoot: meta.readOnlyRoot, jobId: "bg-3", task: meta.task });
		assert.deepEqual([call1.type, call1.tool, call1.args.command], ["call", "powershell", `[IO.File]::WriteAllText("DATABASE-DESIGN.md", "x")`]);
		assert.deepEqual([result1.type, result1.isError, result1.guard], ["result", true, "READ_ONLY_ROLE"]);
		assert.match(result1.excerpt, /^Blocked by harness safety guard \[READ_ONLY_ROLE\]/);
		assert.match(call2.args.huge, /… \[10000 chars\]$/);
		assert.ok(call2.args.huge.length < 4_100);
		assert.deepEqual([result2.isError, result2.guard, result2.excerpt, result2.chars], [false, undefined, undefined, 12]);
		assert.deepEqual([end.type, end.exitCode, end.stopReason], ["end", 0, "stop"]);
		for (const entry of [launch, call1, result1, end]) assert.ok(!Number.isNaN(Date.parse(entry.t)));
	} finally { fs.rmSync(agentDir, { recursive: true, force: true }); }
});

test("PI_SUBAGENT_TRACE_LOG=0 turns tracing off; an unwritable folder starts no trace instead of failing", () => {
	const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "worker-trace-"));
	try {
		assert.equal(createWorkerTrace(agentDir, meta, { PI_SUBAGENT_TRACE_LOG: "0" }), undefined);
		assert.equal(fs.existsSync(traceDir(agentDir)), false);
		fs.mkdirSync(path.join(agentDir, "run-state"));
		fs.writeFileSync(traceDir(agentDir), "a file where the folder should be");
		assert.equal(createWorkerTrace(agentDir, meta, {}), undefined);
	} finally { fs.rmSync(agentDir, { recursive: true, force: true }); }
});

test("traces older than 14 days are removed when a worker starts; newer ones and other files stay", () => {
	const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "worker-trace-"));
	try {
		const dir = traceDir(agentDir);
		fs.mkdirSync(dir, { recursive: true });
		const now = Date.now();
		const file = (name: string, ageMs: number) => { const f = path.join(dir, name); fs.writeFileSync(f, "{}\n"); fs.utimesSync(f, new Date(now - ageMs), new Date(now - ageMs)); return f; };
		const old = file("old.jsonl", TRACE_RETENTION_MS + 60_000), recent = file("recent.jsonl", 60_000), other = file("notes.txt", TRACE_RETENTION_MS + 60_000);
		createWorkerTrace(agentDir, meta, {}, new Date(now));
		assert.deepEqual([fs.existsSync(old), fs.existsSync(recent), fs.existsSync(other)], [false, true, true]);
		pruneTraces(path.join(agentDir, "absent")); // a missing folder is not an error
	} finally { fs.rmSync(agentDir, { recursive: true, force: true }); }
});
