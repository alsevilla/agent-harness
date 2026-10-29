// Background receipt / refusal / completion lifecycle and exactly-once worker accounting, against scripted fake adapters (no Pi, no provider).
// Oracle R1-R4: a receipt is pending until its completion, a refusal is a main tool error (recoverable), a bare empty result is unexplained.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { runBenchmark } from "./lib/runner.mjs";
import { assistant, u, task, manifest, root, fakeWorkspace, gate, fakeAdapter, fixtureConfig, writerLaunch, subagent } from "./fixtures/fake-runtime.mjs";

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
	assert.deepEqual(t.delegation.receipts, [{ round: 0, jobId: "bg-1", mode: "single", roles: null, atMs: null, completed: true }], "requested roles and the offset are absent (null), not guessed, when the native receipt did not carry them");
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
	assert.deepEqual(r.config.limits, { roundSettleTimeoutMs: { value: 600000, source: "fixture roles default" }, shutdownGraceMs: { value: 30000, source: "fixture roles default" }, taskTimeoutMs: { value: 1200000, source: "fixture roles default" } });
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
	assert.deepEqual(r.tasks[0].shutdown, { confirmed: true, ms: null, pendingJobs: [], pendingOperations: [] });
	assert.equal(ad.log.filter((e) => e[0] === "close").length, 1, "the shared main closed at the stop, once");
	const bad = fakeAdapter({ mainScript: (s) => { fix(s); return { events: [writerLaunch(), assistant(u(1, 1))], text: "done" }; } });
	bad.closeSession = async () => ({ confirmed: false, ms: 5, pendingJobs: ["bg-3"] });
	const r2 = await run({ tasks: [task("H1")], adapter: bad });
	assert.equal(r2.tasks[0].status, "infrastructure");
	assert.equal(r2.tasks[0].invalid.kind, "shutdown_unconfirmed");
	assert.equal(r2.status, "invalid");
	const r3 = await run({ tasks: [task("H1")], adapter: bad, mode: "long-fixed" });
	// The final shared close is the final task's own: an unconfirmed one invalidates that task (same as fresh mode) instead of failing later in an outer cleanup.
	assert.equal(r3.status, "invalid");
	assert.equal(r3.tasks[0].invalid.kind, "shutdown_unconfirmed");
	assert.match(r3.error, /shutdown_unconfirmed/);
});

// --- C6 (cumulative writer): the measured expected writer is required once per TASK, not once per round ---
const runTasks = (tasks, adapter, workspace = fakeWorkspace(root())) => runBenchmark({ manifest: manifest(tasks), mode: "fresh", adapter, workspace, acceptance: gate, config: fixtureConfig() });
const rework = (text) => text.startsWith("REWORK");
// H1 never gets fixed (the writer ran in round 0 only); H2 is fixed by its own writer.
const reworkScript = (round1) => (s, text) => {
	if (s.taskId === "H2") { fix(s); return { events: [writerLaunch(0.02), assistant(u(1, 1, 0, 0, 0.01))], text: "h2" }; }
	return rework(text) ? round1(s) : { events: [writerLaunch(0.03), assistant(u(10, 2, 0, 0, 0.1))], text: "tried" };
};
async function noWriterRework(round1) {
	const ad = fakeAdapter({ mainScript: reworkScript(round1) });
	return { r: await runTasks([task("H1", { maxReworkRounds: 1 }), task("H2")], ad), ad };
}
const assertScoredFalseAndNextRuns = (r) => {
	assert.equal(r.status, "complete");
	const t = r.tasks[0];
	assert.equal(t.status, "completed");
	assert.equal(t.accepted, false, "a genuinely unfixed quality failure at the cap is scored false");
	assert.equal(t.invalid, undefined);
	assert.equal(t.reworkRounds, 1);
	assert.equal(t.acceptance.cycles.length, 2);
	assert.equal(t.reviewer.cycles.length, 2);
	assert.equal(r.tasks.length, 2, "the next task runs");
	assert.equal(r.tasks[1].accepted, true);
	assert.deepEqual(r.notRun, []);
	assert.equal(t.delegation.writerLaunches, 1, "the writer ledger is the round 0 launch only: nothing is added or invented");
	assert.equal(t.worker.launches, 1);
	assert.ok(Math.abs(t.worker.cost.total - 0.03) < 1e-12);
};

test("writer in round 0 then an idle rework turn is valid: completed, scored false at the cap, next task runs, counted exactly", async () => {
	const { r } = await noWriterRework(() => ({ events: [assistant(u(4, 1, 0, 0, 0.04))], text: "nothing to do" }));
	assertScoredFalseAndNextRuns(r);
	const t = r.tasks[0];
	assert.equal(t.main.turns, 2);
	assert.ok(Math.abs(t.main.cost.total - 0.14) < 1e-12, `main 0.10 + idle rework 0.04, got ${t.main.cost.total}`);
	assert.equal(t.reworkTurns, 1, "the idle rework turn is the rework ledger");
	assert.deepEqual(t.mainDiagnostics.rounds.map((x) => [x.round, x.assistantTurns, x.writerLaunches]), [[0, 1, 1], [1, 1, 0]]);
	const sumTurns = r.tasks.reduce((s, x) => s + x.main.turns + x.worker.turns + x.reviewer.usage.turns, 0);
	assert.equal(r.totals.endToEnd.turns, sumTurns, "end to end sums exactly the recorded parts");
});

test("writer in round 0 then a debugger-only rework is valid and the debugger launch is recorded with its actual role", async () => {
	const { r } = await noWriterRework(() => ({ events: [subagent(0.01, "debugger"), assistant(u(4, 1, 0, 0, 0.04))], text: "diagnosed" }));
	// the debugger is a measured child (worker ledger) but not the writer
	assert.equal(r.status, "complete");
	const t = r.tasks[0];
	assert.equal(t.status, "completed");
	assert.equal(t.accepted, false);
	assert.equal(t.delegation.writerLaunches, 1);
	assert.deepEqual(t.delegation.launches.map((l) => [l.round, l.agent]), [[0, "general-worker"], [1, "debugger"]]);
	assert.equal(r.tasks.length, 2);
	assert.equal(t.reviewer.cycles.length, 2);
});

test("writer in round 0 then a refusal-only rework is valid (a refusal launched nothing); the refusal is recorded and nothing is forced", async () => {
	const { r } = await noWriterRework(() => ({ events: [refusal("blocked by guard: deletion needs the operator"), assistant(u(4, 1, 0, 0, 0.04))], text: "cannot delete" }));
	assertScoredFalseAndNextRuns(r);
	assert.equal(r.tasks[0].delegation.refusals.length, 1);
	assert.equal(r.tasks[0].delegation.refusals[0].round, 1);
});

test("round 0 without a measured writer stays missing_delegation even if a later round would launch one", async () => {
	const ad = fakeAdapter({ mainScript: (s) => ({ events: [subagent(0, "debugger"), assistant(u(1, 1))], text: "no writer" }) });
	const r = await runTasks([task("H1", { maxReworkRounds: 1 })], ad);
	assert.equal(r.tasks[0].invalid.kind, "missing_delegation");
	assert.equal(r.tasks[0].reviewer.cycles.length, 0);
	assert.equal(ad.log.filter((e) => e[3] === "rework").length, 0);
});

test("safeguards still apply in a rework round after an earlier writer: direct main write, failed child, no assistant turn, unsettled background", async () => {
	const cases = [
		["direct_main_write", () => ({ events: [{ type: "tool", name: "write", isError: false }, assistant(u(1, 1))], text: "x" })],
		["launch_failed", () => ({ events: [{ type: "subagent", details: { mode: "single", results: [{ agent: "general-worker", exitCode: 1, stopReason: "error", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 } }] } }, assistant(u(1, 1))], text: "x" })],
		["launch_failed", () => ({ events: [{ type: "subagent", toolCallId: "c", isError: false, text: "", details: { mode: "single", results: [] } }, assistant(u(1, 1))], text: "x" })],
		["no_assistant_turn", () => ({ events: [], text: "" })],
		["background_unsettled", () => ({ events: [receipt("bg-7"), assistant(u(1, 1))], text: "x" })],
	];
	for (const [kind, round1] of cases) {
		const { r } = await noWriterRework(round1);
		const t = r.tasks[0];
		assert.equal(t.invalid.kind, kind, kind);
		assert.equal(t.invalid.round, 1);
		assert.equal(r.status, "invalid");
		assert.deepEqual(r.notRun, ["H2"]);
		assert.equal(t.reviewer.cycles.length, 1, "no review for the stopped round");
	}
});

// F5: the final shared-session close belongs to the FINAL task: it is bounded by the remaining ORIGINAL task budget (not a fresh shutdown grace), its terminal audits
// are folded into the owning task before totals are computed, and a close that hangs or overruns makes the task unfinished, never complete.
const closeAudit = (cost) => ({ type: "audit", jobId: "bg-1", jobKey: "sess-A/bg-1", ownerSession: "sess-A", state: "completed", results: [{ agent: "general-worker", position: 0, exitCode: 0, usage: { input: 2, output: 1, turns: 1, cost } }] });
const longConfig = (clock) => fixtureConfig({ clock: () => clock.now, limits: { taskTimeoutMs: { value: 200, source: "test" }, shutdownGraceMs: { value: 50, source: "test" }, roundSettleTimeoutMs: { value: 1000, source: "test" } } });
const finalCloseAdapter = (clock, mainClose) => {
	const ad = fakeAdapter({ mainScript: (s) => { fix(s); return { events: [writerLaunch(0), assistant(u(1, 1))], text: "done" }; } });
	ad.mainCloseBudgets = [];
	ad.closeSession = async (s, o) => { if (s.role === "review") { clock.now = 199; return { confirmed: true }; } ad.mainCloseBudgets.push(o?.budgetMs); return mainClose(clock); };
	return ad;
};
for (const mode of ["long-fixed", "long-compacted"]) {
	test(`${mode}: a final shared close that overruns the original deadline is unfinished (not complete) and its shutdown-only audit is still counted once`, async () => {
		const clock = { now: 0 };
		const ad = finalCloseAdapter(clock, (c) => { c.now += 49; return { confirmed: true, audits: [closeAudit(0.5)] }; }); // ignores its budget: 199 + 49 = 248 > 200
		const r = await run({ tasks: [task("H1")], adapter: ad, mode, config: longConfig(clock) });
		assert.ok(ad.mainCloseBudgets.every((b) => b <= 1 && b >= 0), `close budget is the remaining original budget, not a fresh grace: ${ad.mainCloseBudgets}`);
		assert.equal(ad.mainCloseBudgets.length, 1);
		assert.equal(r.status, "unfinished");
		assert.equal(r.tasks[0].status, "budget_exhausted");
		assert.equal(r.tasks[0].budget.stage, "session_close");
		assert.equal(r.tasks[0].accepted, false);
		assert.equal(r.tasks[0].worker.cost.total, 0.5);
		assert.equal(r.totals.worker.cost.total, 0.5);
	});
	test(`${mode}: a final shared close that never returns is unconfirmed and unfinished; nothing restarts`, async () => {
		const clock = { now: 0 };
		const ad = finalCloseAdapter(clock, () => new Promise(() => {}));
		const r = await run({ tasks: [task("H1")], adapter: ad, mode, config: longConfig(clock) });
		assert.ok(ad.mainCloseBudgets[0] <= 1);
		assert.equal(r.status, "unfinished");
		assert.equal(r.tasks[0].status, "budget_exhausted");
		assert.equal(r.tasks[0].shutdown.confirmed, false);
		assert.equal(ad.log.filter((l) => l[0] === "open").length, 2, "one main and one reviewer session; no restart");
	});
	test(`${mode}: a final close inside the remaining budget completes and its shutdown-only audit lands on the owner`, async () => {
		const clock = { now: 0 };
		const ad = finalCloseAdapter(clock, (c) => { c.now += 0.5; return { confirmed: true, audits: [closeAudit(0.5)] }; });
		const r = await run({ tasks: [task("H1")], adapter: ad, mode, config: longConfig(clock) });
		assert.equal(r.status, "complete");
		assert.equal(r.tasks[0].status, "completed");
		assert.equal(r.tasks[0].worker.cost.total, 0.5);
		assert.equal(r.totals.worker.cost.total, 0.5);
		assert.equal(r.tasks[0].delegation.audits.length, 1);
	});
}

test("an outer emergency close (a failure between tasks) is bounded by the active task's original deadline, never a fresh grace", async () => {
	const clock = { now: 0 };
	const ad = fakeAdapter({ mainScript: (s) => { fix(s); return { events: [writerLaunch(0), assistant(u(1, 1))], text: "done" }; } });
	ad.compact = async () => { clock.now = 400; throw new Error("compaction boom"); }; // the second task's own deadline (clock start 0 + 200) has passed
	const budgets = [];
	ad.closeSession = async (s, o) => { if (s.role !== "review") budgets.push(o?.budgetMs); return { confirmed: true }; };
	const r = await run({ tasks: [task("H1"), task("H2")], adapter: ad, mode: "long-compacted", config: longConfig(clock) });
	assert.equal(r.status, "failed");
	assert.deepEqual(budgets, [0]);
});
