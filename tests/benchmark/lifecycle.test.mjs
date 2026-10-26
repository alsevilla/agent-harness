// Background receipt / refusal / completion lifecycle and exactly-once worker accounting, against scripted fake adapters (no Pi, no provider).
// Oracle R1-R4: a receipt is pending until its completion, a refusal is a main tool error (recoverable), a bare empty result is unexplained.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { runBenchmark } from "./lib/runner.mjs";
import { assistant, u, task, manifest, root, fakeWorkspace, gate, fakeAdapter, fixtureConfig, writerLaunch } from "./fixtures/fake-runtime.mjs";

const run = (opts) => runBenchmark({ manifest: manifest(opts.tasks), mode: opts.mode ?? "fresh", adapter: opts.adapter, workspace: fakeWorkspace(root()), acceptance: gate, config: opts.config ?? fixtureConfig() });
const fix = (s) => fs.writeFileSync(path.join(s.cwd, "agent/work.txt"), "fixed");
const child = (agent, cost, turns = 1) => ({ agent, exitCode: 0, stopReason: "stop", usage: { input: 2, output: 2, cacheRead: 0, cacheWrite: 0, cost, turns, contextTokens: 4 } });
export const receipt = (jobId, toolCallId = `call-${jobId}`) => ({ type: "subagent", toolCallId, isError: false, text: `Started background job ${jobId}.`, details: { mode: "single", results: [], jobId, background: true } });
export const completion = (jobId, results, state = "completed") => ({ type: "completion", jobId, state, results });
export const refusal = (text = "Invalid parameters: nothing was launched.") => ({ type: "subagent", toolCallId: "call-refused", isError: true, text, details: { mode: "single", results: [] } });

test("a receipt plus its matching completion is a measured writer launch; worker usage counts once", async () => {
	const ad = fakeAdapter({ mainScript: (s) => { fix(s); return { events: [receipt("bg-1"), completion("bg-1", [child("general-worker", 0.03)]), assistant(u(1, 1))], text: "done" }; } });
	const r = await run({ tasks: [task("H1")], adapter: ad });
	assert.equal(r.status, "complete");
	const t = r.tasks[0];
	assert.equal(t.status, "completed");
	assert.equal(t.delegation.writerLaunches, 1);
	assert.equal(t.worker.launches, 1);
	assert.equal(t.worker.cost.total, 0.03);
	assert.deepEqual(t.delegation.receipts, [{ round: 0, jobId: "bg-1", mode: "single", completed: true }]);
});

test("duplicate completion events and a control-tool result for the same job never double count worker cost", async () => {
	const done = completion("bg-1", [child("general-worker", 0.03)]);
	const ad = fakeAdapter({ mainScript: (s) => { fix(s); return { events: [receipt("bg-1"), done, done, { type: "tool", name: "subagent_control", isError: false }, assistant(u(1, 1))], text: "done" }; } });
	const r = await run({ tasks: [task("H1")], adapter: ad });
	assert.equal(r.tasks[0].worker.launches, 1);
	assert.equal(r.tasks[0].worker.cost.total, 0.03);
});

test("a duplicate foreground subagent event with the same toolCallId is counted once", async () => {
	const fg = { ...writerLaunch(0.02), toolCallId: "call-fg" };
	const ad = fakeAdapter({ mainScript: (s) => { fix(s); return { events: [fg, fg, assistant(u(1, 1))], text: "done" }; } });
	const r = await run({ tasks: [task("H1")], adapter: ad });
	assert.equal(r.tasks[0].worker.launches, 1);
});

test("a receipt that never completes stops the run as infrastructure background_unsettled; the pending cost is unknown, not zero", async () => {
	const ad = fakeAdapter({ mainScript: (s) => { fix(s); return { events: [receipt("bg-1"), assistant(u(1, 1))], text: "done" }; } });
	const r = await run({ tasks: [task("H1"), task("H2")], adapter: ad });
	assert.equal(r.status, "invalid");
	assert.equal(r.tasks[0].status, "infrastructure");
	assert.equal(r.tasks[0].invalid.kind, "background_unsettled");
	assert.deepEqual(r.tasks[0].invalid.pendingJobs, ["bg-1"]);
	assert.deepEqual(r.notRun, ["H2"]);
	assert.equal(r.tasks[0].worker.cost.total, null);
	assert.equal(r.tasks[0].reviewer.cycles.length, 0, "no review while a worker may still be writing");
});

test("an adapter settlement that timed out is background_unsettled even when the events show no receipt", async () => {
	const ad = fakeAdapter({ mainScript: (s) => { fix(s); return { events: [writerLaunch(), assistant(u(1, 1))], text: "done", settlement: { settled: false, timedOut: true, pendingJobs: ["bg-9"], waitedMs: 5 } }; } });
	const r = await run({ tasks: [task("H1")], adapter: ad });
	assert.equal(r.tasks[0].invalid.kind, "background_unsettled");
	assert.deepEqual(r.tasks[0].invalid.pendingJobs, ["bg-9"]);
	assert.equal(r.tasks[0].invalid.timedOut, true);
});

test("a refused call is a recorded main tool error, not infrastructure: the main recovers with a measured writer and the task is valid", async () => {
	const ad = fakeAdapter({ mainScript: (s) => { fix(s); return { events: [refusal("Invalid modelTier: tasks[0]: expected economy or capable. token=sk-abcdefgh12345"), receipt("bg-2"), completion("bg-2", [child("general-worker", 0.01)]), assistant(u(1, 1))], text: "done" }; } });
	const r = await run({ tasks: [task("H1")], adapter: ad });
	assert.equal(r.status, "complete");
	const t = r.tasks[0];
	assert.equal(t.accepted, true);
	assert.equal(t.delegation.refusals.length, 1);
	assert.match(t.delegation.refusals[0].text, /Invalid modelTier/);
	assert.doesNotMatch(t.delegation.refusals[0].text, /sk-abcdefgh12345/, "redacted");
	assert.equal(t.worker.launches, 1, "a refusal launched nothing and is not a launch");
});

test("a refusal without any later measured writer is method invalid (missing_delegation), never infrastructure", async () => {
	const ad = fakeAdapter({ mainScript: (s) => ({ events: [refusal(), assistant(u(1, 1))], text: "gave up" }) });
	const r = await run({ tasks: [task("H1")], adapter: ad });
	assert.equal(r.tasks[0].status, "method_invalid");
	assert.equal(r.tasks[0].invalid.kind, "missing_delegation");
	assert.equal(r.tasks[0].delegation.refusals.length, 1);
});

test("a bare empty results array with no error and no background marker is unexplained and fails as infrastructure", async () => {
	const bare = { type: "subagent", toolCallId: "c", isError: false, text: "", details: { mode: "single", results: [] } };
	const ad = fakeAdapter({ mainScript: (s) => { fix(s); return { events: [bare, assistant(u(1, 1))], text: "done" }; } });
	const r = await run({ tasks: [task("H1")], adapter: ad });
	assert.equal(r.tasks[0].status, "infrastructure");
	assert.equal(r.tasks[0].invalid.kind, "launch_failed");
	assert.equal(r.tasks[0].invalid.launchStatus, "unreported");
});

test("a completion for a failed or aborted job is a terminal worker failure: infrastructure, but its usage is still counted once", async () => {
	const ad = fakeAdapter({ mainScript: (s) => { fix(s); return { events: [receipt("bg-1"), completion("bg-1", [{ ...child("general-worker", 0.05), exitCode: 1, stopReason: "error" }], "failed"), assistant(u(1, 1))], text: "done" }; } });
	const r = await run({ tasks: [task("H1")], adapter: ad });
	assert.equal(r.tasks[0].status, "infrastructure");
	assert.equal(r.tasks[0].invalid.kind, "launch_failed");
	assert.equal(r.tasks[0].invalid.launchStatus, "terminal-failure");
	assert.equal(r.tasks[0].worker.cost.total, 0.05);
});

// Oracle F2: a foreground result that is itself a terminal failure is infrastructure even with priced turns; usage stays counted once.
const fgCall = (results, id = "call-fg") => ({ type: "subagent", toolCallId: id, isError: results.some((r) => r.isError === true), text: "", details: { mode: "single", results } });
for (const [name, over] of [["isError", { isError: true }], ["nonzero exit", { exitCode: 1 }], ["error stop", { stopReason: "error" }], ["aborted stop", { stopReason: "aborted" }]]) {
	test(`a foreground writer result with ${name} and a priced turn is a terminal failure: infrastructure, usage counted exactly once`, async () => {
		const ad = fakeAdapter({ mainScript: (s) => { fix(s); return { events: [fgCall([{ ...child("general-worker", 0.05), ...over }]), assistant(u(1, 1))], text: "done" }; } });
		const r = await run({ tasks: [task("H1")], adapter: ad });
		assert.equal(r.tasks[0].status, "infrastructure");
		assert.equal(r.tasks[0].invalid.kind, "launch_failed");
		assert.equal(r.tasks[0].invalid.launchStatus, "terminal-failure");
		assert.equal(r.tasks[0].accepted, false);
		assert.equal(r.tasks[0].worker.cost.total, 0.05);
	});
}

test("a failed foreground debugger beside a healthy writer in one result set is still infrastructure", async () => {
	const ad = fakeAdapter({ mainScript: (s) => { fix(s); return { events: [fgCall([{ ...child("debugger", 0.03), exitCode: 1, stopReason: "error" }, child("general-worker", 0.04)]), assistant(u(1, 1))], text: "done" }; } });
	const r = await run({ tasks: [task("H1")], adapter: ad });
	assert.equal(r.tasks[0].status, "infrastructure");
	assert.equal(r.tasks[0].invalid.agent, "debugger");
	assert.equal(r.tasks[0].invalid.launchStatus, "terminal-failure");
	assert.ok(Math.abs(r.tasks[0].worker.cost.total - 0.07) < 1e-9);
});

test("a healthy foreground writer whose acceptance is red stays scoreable, and a pre-launch refusal stays recoverable", async () => {
	const ad = fakeAdapter({ mainScript: () => ({ events: [refusal(), fgCall([child("general-worker", 0.01)]), assistant(u(1, 1))], text: "did not fix it" }) });
	const r = await run({ tasks: [task("H1", { maxReworkRounds: 0 })], adapter: ad });
	assert.equal(r.tasks[0].status, "completed");
	assert.equal(r.tasks[0].accepted, false);
	assert.equal(r.tasks[0].delegation.refusals.length, 1);
});

test("a genuine quality failure (child finished, acceptance red) stays scoreable, not infrastructure", async () => {
	const ad = fakeAdapter({ mainScript: () => ({ events: [receipt("bg-1"), completion("bg-1", [child("general-worker", 0.01)]), assistant(u(1, 1))], text: "did not fix it" }) });
	const r = await run({ tasks: [task("H1", { maxReworkRounds: 0 })], adapter: ad });
	assert.equal(r.tasks[0].status, "completed");
	assert.equal(r.tasks[0].accepted, false);
});

test("the workspace is snapshotted only after the prompt (including its settlement) returns", async () => {
	const log = [];
	const ad = fakeAdapter({ mainScript: async (s) => { await new Promise((r) => setTimeout(r, 15)); fix(s); log.push("settled"); return { events: [receipt("bg-1"), completion("bg-1", [child("general-worker", 0.01)]), assistant(u(1, 1))], text: "done", settlement: { settled: true, timedOut: false, pendingJobs: [], waitedMs: 15 } }; } });
	const ws = fakeWorkspace(root());
	const snap = ws.snapshot;
	ws.snapshot = async (d) => { log.push("snapshot"); return snap(d); };
	const r = await runBenchmark({ manifest: manifest([task("H1")]), mode: "fresh", adapter: ad, workspace: ws, acceptance: gate, config: fixtureConfig() });
	assert.equal(r.tasks[0].accepted, true);
	assert.deepEqual(log.slice(0, 4), ["snapshot", "snapshot", "settled", "snapshot"], "task baseline and pre-prompt baseline, then the post-settle snapshot");
});

// --- Oracle R4/R5: configurable limits with recorded sources, and shutdown confirmation ---
test("the round settlement timeout and shutdown grace are recorded with their source; a task override beats the run limit", async () => {
	const seen = [];
	const ad = fakeAdapter({ mainScript: (s) => { fix(s); return { events: [writerLaunch(), assistant(u(1, 1))], text: "done" }; } });
	const prompt = ad.prompt;
	ad.prompt = async (s, text, opts) => { if (s.role === "main") seen.push(opts?.settle?.timeoutMs); return prompt(s, text, opts); };
	const r = await run({ tasks: [task("H1"), task("H2", { roundSettleTimeoutMs: 4321 })], adapter: ad });
	assert.deepEqual(seen, [600000, 4321]);
	assert.deepEqual(r.config.limits, { roundSettleTimeoutMs: { value: 600000, source: "fixture roles default" }, shutdownGraceMs: { value: 30000, source: "fixture roles default" } });
	assert.deepEqual(r.tasks[0].delegation.roundSettleTimeoutMs, { value: 600000, source: "fixture roles default" });
	assert.deepEqual(r.tasks[1].delegation.roundSettleTimeoutMs, { value: 4321, source: "manifest task H2" });
});

test("the limits are required: a missing or non-positive limit is refused before any session opens", async () => {
	const ad = fakeAdapter({ mainScript: (s) => ({ events: [], text: "" }) });
	const base = fixtureConfig();
	await assert.rejects(run({ tasks: [task("H1")], adapter: ad, config: { ...base, limits: undefined } }), /limits\.roundSettleTimeoutMs/);
	await assert.rejects(run({ tasks: [task("H1")], adapter: ad, config: { ...base, limits: { ...base.limits, shutdownGraceMs: { value: 0, source: "x" } } } }), /shutdownGraceMs must be a whole number of milliseconds > 0/);
	assert.equal(ad.log.length, 0);
});

test("a stopped round closes its session at once (even a shared one) and records the shutdown; an unconfirmed shutdown never leaves a valid task", async () => {
	const ad = fakeAdapter({ mainScript: () => ({ events: [receipt("bg-1"), assistant(u(1, 1))], text: "x" }) });
	const r = await run({ tasks: [task("H1")], adapter: ad, mode: "long-fixed" });
	assert.equal(r.tasks[0].status, "infrastructure");
	assert.deepEqual(r.tasks[0].shutdown, { confirmed: true, ms: null, pendingJobs: [] });
	assert.equal(ad.log.filter((e) => e[0] === "close").length, 1, "the shared main closed at the stop, once");
	const bad = fakeAdapter({ mainScript: (s) => { fix(s); return { events: [writerLaunch(), assistant(u(1, 1))], text: "done" }; } });
	bad.closeSession = async () => ({ confirmed: false, ms: 5, pendingJobs: ["bg-3"] });
	const r2 = await run({ tasks: [task("H1")], adapter: bad });
	assert.equal(r2.tasks[0].status, "infrastructure");
	assert.equal(r2.tasks[0].invalid.kind, "shutdown_unconfirmed");
	assert.equal(r2.status, "invalid");
	const r3 = await run({ tasks: [task("H1")], adapter: bad, mode: "long-fixed" });
	assert.equal(r3.status, "failed");
	assert.match(r3.error, /shutdown_unconfirmed/);
});
