// /subagent trace: a worker's tool calls as pasteable text, with repeats, whole reads of large files, errors and the outputs carried longest.
import assert from "node:assert/strict";
import test from "node:test";
import { formatTrace, formatTraceIndex, pickWorker, traceTarget, type TraceRecord, type TraceTool } from "../trace.ts";

const tool = (name: string, command: string, outputChars: number, extra: Partial<TraceTool> = {}): TraceTool => ({ name, command, state: "ok", output: "", outputChars, startedAt: 0, endedAt: 2000, ...extra });
const worker = (over: Partial<TraceRecord> = {}): TraceRecord => ({ id: "w:3", name: "backend-worker", task: "Pace shared SMS sender submissions\nkeep retries", state: "completed", model: "anthropic/claude-sonnet-5-5", startedAt: 0, endedAt: 600_000, tools: [], ...over });

test("trace lines: tool, target, size, duration and flags; summary counts repeats, large whole reads, errors and the heaviest carried outputs", () => {
	const r = worker({ tools: [
		tool("read", "read · backend/src/db/sms_queue.rs", 14_200),
		tool("read", "read · backend/src/db/sms_queue.rs", 3_100, { range: "90+125" }),
		tool("bash", "$ cargo test -p backend sms_queue (timeout 600s)", 8_300, { state: "error" }),
		tool("read", "read · backend/src/db/sms_queue.rs", 14_200),
		tool("edit", "edit · backend/src/db/sms_queue.rs", 120),
		tool("edit", "edit · backend/src/db/sms_queue.rs", 120),
		tool("bash", "$ cargo test -p backend sms_queue (timeout 600s)", 2_000),
	] });
	const text = formatTrace(r);
	const lines = text.split("\n");
	assert.equal(lines[0], "Tool trace: #3 backend-worker · completed · claude-sonnet-5-5 · 10 min");
	assert.equal(lines[1], "Task: Pace shared SMS sender submissions keep retries");
	assert.equal(lines[2], "7 tool calls (read 3, bash 2, edit 2); output 42.0k chars (~10.5k tokens); repeats 2 (16.2k chars); whole reads of large files 2; errors 1");
	assert.match(lines[3], /^Carried longest \(each output stays in context for the later calls\): #1 14\.2k chars × 6 later calls, #4 14\.2k chars × 3 later calls, #3 8\.3k chars × 4 later calls/);
	assert.match(text, /\n {2}1 {2}read {7}backend\/src\/db\/sms_queue\.rs {2,}14\.2k chars +2s {2}whole read of a large file\n/);
	assert.match(text, /\n {2}2 {2}read {7}backend\/src\/db\/sms_queue\.rs \(90\+125\) {2,}3\.1k chars +2s\n/);
	assert.match(text, /\n {2}3 {2}bash {7}cargo test -p backend sms_queue \(timeout 600s\) {2,}8\.3k chars +2s {2}error\n/);
	assert.match(text, /\n {2}4 {2}read .*repeat of #1; whole read of a large file\n/);
	assert.doesNotMatch(text, /\n {2}6 {2}edit .*repeat/, "a second edit of the same file is new work, not a repeat");
	assert.match(text, /\n {2}7 {2}bash .*repeat of #3$/);
});

test("targets are trimmed to one line; the index lists workers; a worker is picked by number or role", () => {
	assert.equal(traceTarget(tool("bash", "$ " + "x".repeat(100), 1)).length, 72);
	assert.equal(traceTarget(tool("grep", "grep · backend/src · SmsQueue", 1)), "backend/src · SmsQueue");
	const records = [worker({ id: "w:1", name: "scout", tools: [tool("find", "find · *.rs", 10)] }), worker(), worker({ id: "w:5", name: "scout", state: "running" })];
	assert.equal(formatTraceIndex([]), "No workers in this Pi session yet (records reset on /reload or a session change).");
	assert.match(formatTraceIndex(records), /^Workers in this Pi session \(newest last\)\. Run \/subagent trace <#number or role> for one worker's tool calls:\n {2}#1 scout · completed · 1 tool calls · Pace shared SMS/);
	assert.equal(pickWorker(records, "#3")?.id, "w:3");
	assert.equal(pickWorker(records, "1")?.id, "w:1");
	assert.equal(pickWorker(records, "scout")?.id, "w:5", "a role name picks its newest worker");
	assert.equal(pickWorker(records, "nobody"), undefined);
	assert.match(formatTrace(worker({ tools: [tool("read", "read · a.rs", 0, { state: "running", endedAt: undefined })] })), /running/);
});

test("the /subagent command routes trace to a notice, not a chat message, so main's context does not grow", async () => {
	const fs = await import("node:fs");
	const source = fs.readFileSync(new URL("../monitor.ts", import.meta.url), "utf8");
	assert.match(source, /else if \(text === "trace" \|\| text\.startsWith\("trace "\)\) this\.trace\(ctx, text\.slice\(5\)\.trim\(\)\)/);
	assert.match(source, /ctx\.ui\.notify\(record \? formatTrace\(record\)/);
	assert.match(source, /tool\.outputChars = fullTextLength\(result\)/);
});
