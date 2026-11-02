// Process gate: pure table logic, the injected-helper gate, the runner order/fail-closed integration (fake adapter and fake gate, no SDK/provider/model/OS call) and the compare policy.
// The real Windows process tests are in process-gate-real.test.mjs.
import assert from "node:assert/strict";
import test from "node:test";
import { runBenchmark } from "./lib/runner.mjs";
import { compareResults } from "./lib/compare.mjs";
import { GATE_METHOD, TICK_MARGIN_MS, uptimeMs, GateFailure, parseHelperOutput, closure, recordDescendants, attributedAlive, createProcessGate } from "./lib/process-gate.mjs";
import { task, manifest, root, fakeWorkspace, gate, fakeAdapter, fixMain, fixtureConfig } from "./fixtures/fake-runtime.mjs";

const ROOT = 100, SELF = 900;
// Timestamps are decimal strings (FILETIME ticks exceed 2^53): these values differ only beyond double precision.
const T0 = "133700000000000001", T1 = "133700000000000002", T2 = "133700000000000003";
const row = (pid, ppid, created) => ({ pid, ppid, created });
const text = (table, self = SELF, kills = []) => [`self ${self}`, ...kills.map((k) => `k ${k[0]} ${k[1]}`), ...table.map((e) => `p ${e.pid} ${e.ppid} ${e.created ?? "-"}`), "end", ""].join("\n");
const base = () => [row(ROOT, 1, T0), row(SELF, ROOT, T2)];
const code = (c) => (e) => e instanceof GateFailure && e.code === c;

test("parseHelperOutput: complete text parses; a truncated, malformed or self-less text is a tool failure, never an empty table", () => {
	assert.deepEqual(parseHelperOutput(text([row(5, 4, T1), row(6, 5, null)], 7, [[8, "terminated"]])), { self: 7, kills: [{ pid: 8, outcome: "terminated" }], table: [row(5, 4, T1), row(6, 5, null)] });
	assert.throws(() => parseHelperOutput(""), code("tool_failed"));
	assert.throws(() => parseHelperOutput("self 7\np 5 4 1\n"), code("tool_failed"), "no end marker");
	assert.throws(() => parseHelperOutput("p 5 4 1\nend\n"), code("tool_failed"), "no self");
	assert.throws(() => parseHelperOutput("self 7\nweird line\nend\n"), code("tool_failed"));
	assert.throws(() => parseHelperOutput("self 7\np 5 x 1\nend\n"), code("tool_failed"));
});

test("recordDescendants: transitive descendants with PID, parent and exact creation string; root and the inspection helper are excluded", () => {
	const table = [...base(), row(10, ROOT, T1), row(11, 10, T1), row(12, 11, T2), row(77, 1, T0), row(901, SELF, T2)];
	assert.deepEqual(recordDescendants(table, ROOT, SELF), [row(10, ROOT, T1), row(11, 10, T1), row(12, 11, T2)]);
	assert.throws(() => recordDescendants([row(10, 1, T1)], ROOT, SELF), code("root_unidentified"));
	assert.throws(() => recordDescendants([row(ROOT, 1, null)], ROOT, SELF), code("root_unidentified"));
	assert.throws(() => recordDescendants([...base(), row(10, ROOT, null)], ROOT, SELF), code("identity_unreadable"), "an unreadable descendant is ambiguous: fail closed");
});

test("closure compares creation times losslessly (BigInt on decimal strings, not 64-bit floats) and never attributes a child older than its parent", () => {
	assert.equal(Number(T1), Number(T2), "the doubles cannot tell these apart");
	assert.deepEqual(closure([row(ROOT, 1, T2), row(10, ROOT, T1)], [row(ROOT, 1, T2)]).map((e) => e.pid), [ROOT], "child created before its parent holder");
	assert.deepEqual(closure([row(ROOT, 1, T1), row(10, ROOT, T2)], [row(ROOT, 1, T1)]).map((e) => e.pid), [ROOT, 10]);
});

test("attributedAlive: identity is PID AND creation time; a reused PID is dead, its older children are not attributed, and an unrecorded dead intermediate is NOT assumed owned", () => {
	const recorded = [row(10, ROOT, T1), row(11, 10, T1)];
	// same identities alive
	assert.deepEqual(attributedAlive([...base(), row(10, ROOT, T1), row(11, 10, T1)], recorded, ROOT, SELF).map((e) => e.pid), [10, 11]);
	// PID 10 reused by a different process: it is not the recorded identity; the old child 11 (created before the new holder) is not attributed
	assert.deepEqual(attributedAlive([...base(), row(10, ROOT, T2), row(11, 10, T1), row(12, 10, T1)], recorded, ROOT, SELF).map((e) => e.pid), [11], "only the recorded identity 11; the unrecorded older child 12 of the new holder is not attributed");
	assert.deepEqual(attributedAlive([...base(), row(10, ROOT, T2)], recorded, ROOT, SELF), [], "the reused PID alone is dead as the recorded identity");
	// a late child of a still-alive recorded parent IS attributed (it descends from a verified identity)
	assert.deepEqual(attributedAlive([...base(), row(10, ROOT, T1), row(50, 10, T2)], recorded, ROOT, SELF).map((e) => e.pid), [10, 50]);
	// the recorded parent is gone: a late grandchild whose parent identity is dead and unrecorded is not attributed (reported blind spot, not guessed)
	assert.deepEqual(attributedAlive([...base(), row(60, 55, T2)], recorded, ROOT, SELF), []);
	// the helper and its compiler children are never attributed even when the closure reaches them
	assert.deepEqual(attributedAlive([...base(), row(901, SELF, T2)], [row(901, SELF, T2)], ROOT, SELF), []);
	assert.throws(() => attributedAlive([row(SELF, 1, T2)], recorded, ROOT, SELF), code("root_unidentified"));
});

const fakeRun = (...texts) => { const calls = []; const run = async (input, ms) => { calls.push({ input, ms }); const t = texts.shift(); if (t instanceof Error) throw t; return t; }; run.calls = calls; return run; };
const mk = (run, o = {}) => createProcessGate({ run, rootPid: ROOT, platform: "win32", ...o });

test("gate: nothing alive after the close is a confirmed attributed quiescence with no signal", async () => {
	const run = fakeRun(text([...base(), row(10, ROOT, T1)]), text(base()));
	const g = mk(run);
	const st = await g.begin(() => 5000);
	assert.deepEqual(st, { ok: true, recorded: [row(10, ROOT, T1)] });
	const r = await g.finish(st, () => 5000);
	assert.equal(r.confirmed, true); assert.equal(r.assessable, true); assert.equal(r.recorded, 1); assert.equal(r.attributedAlive, 0); assert.equal(r.terminated, 0); assert.equal(r.failure, null);
	assert.equal(r.method, GATE_METHOD);
	assert.ok(run.calls.every((c) => /^snapshot \d+\n$/.test(c.input)), "no terminate request");
});

test("gate: a recorded identity alive is terminated BY IDENTITY only (pid + exact creation), then reassessed", async () => {
	const run = fakeRun(text([...base(), row(10, ROOT, T1)]), text([...base(), row(10, ROOT, T1), row(20, 10, T2)]), text(base(), SELF, [[10, "terminated"], [20, "terminated"]]));
	const g = mk(run);
	const r = await g.finish(await g.begin(() => 5000), () => 5000);
	assert.equal(r.confirmed, true); assert.equal(r.attributedAlive, 2); assert.equal(r.terminated, 2);
	const req = run.calls[2].input.split("\n");
	assert.match(req[0], new RegExp(`^terminate ${ROOT} \\d+ \\d+$`));
	assert.deepEqual(req.slice(1).filter(Boolean), [`t 10 ${T1}`, `t 20 ${T2}`], "only identity lines (no name, no command line, no tree flag)");
});

test("gate: replaced/gone identities are not failures; denied, terminate_failed and an unchanged table stay unconfirmed", async () => {
	const alive = [...base(), row(10, ROOT, T1)];
	const ok = await mk(fakeRun(text(alive), text(alive), text(base(), SELF, [[10, "replaced"]]))).finish({ ok: true, recorded: [row(10, ROOT, T1)] }, () => 5000);
	assert.equal(ok.confirmed, true); assert.equal(ok.terminated, 0, "a replaced identity is never counted as terminated");
	for (const [outcome, failure] of [["denied", "terminate_failed"], ["terminate_failed", "terminate_failed"], ["wait_timeout", "terminate_failed"]]) {
		const st = { ok: true, recorded: [row(10, ROOT, T1)] };
		const run = fakeRun(text(alive), text(alive, SELF, [[10, outcome]]), text(alive, SELF, [[10, outcome]]));
		const r = await mk(run).finish(st, () => 5000);
		assert.equal(r.confirmed, false, outcome); assert.equal(r.failure, failure, outcome); assert.equal(r.assessable, true);
	}
	const st = { ok: true, recorded: [row(10, ROOT, T1)] };
	assert.equal((await mk(fakeRun(text(alive), text(alive), text(alive), text(alive), text(alive))).finish(st, () => 5000)).failure, "still_alive");
});

test("gate: targeted and remainingAlive are the existing observations: a natural exit between observations is a zero-termination proof; a persistent process keeps the last observed count", async () => {
	const alive = [...base(), row(10, ROOT, T1)], st = { ok: true, recorded: [row(10, ROOT, T1)] };
	const nat = await mk(fakeRun(text(alive), text(base(), SELF, [[10, "gone"]]))).finish(st, () => 5000);
	assert.deepEqual([nat.confirmed, nat.attributedAlive, nat.targeted, nat.terminated, nat.remainingAlive], [true, 1, 1, 0, 0]);
	const quiet = await mk(fakeRun(text(base()))).finish(st, () => 5000);
	assert.deepEqual([quiet.confirmed, quiet.attributedAlive, quiet.targeted, quiet.terminated, quiet.remainingAlive], [true, 0, 0, 0, 0]);
	const stuck = await mk(fakeRun(text(alive), text(alive, SELF, [[10, "terminate_failed"]]), text(alive, SELF, [[10, "terminate_failed"]]))).finish(st, () => 5000);
	assert.deepEqual([stuck.confirmed, stuck.attributedAlive, stuck.targeted, stuck.remainingAlive], [false, 1, 2, 1]);
	const none = await mk(fakeRun(new GateFailure("timeout"))).finish(st, () => 5000);
	assert.deepEqual([none.targeted, none.remainingAlive], [0, null], "no observation: no count is invented");
});

test("gate: every error is unconfirmed, never an empty table taken as success", async () => {
	const st = { ok: true, recorded: [row(10, ROOT, T1)] };
	for (const [why, run, failure] of [
		["tool error", fakeRun(new GateFailure("tool_failed")), "tool_failed"],
		["timeout", fakeRun(new GateFailure("timeout")), "timeout"],
		["unknown thrown error", fakeRun(new Error("RAW secret boom")), "tool_failed"],
		["empty output", fakeRun(""), "tool_failed"],
		["truncated output", fakeRun("self 900\np 100 1 5\n"), "tool_failed"],
		["root missing from the table", fakeRun(text([row(SELF, 5, T2)])), "root_unidentified"],
	]) {
		const r = await mk(run).finish(st, () => 5000);
		assert.equal(r.confirmed, false, why); assert.equal(r.assessable, false, why); assert.equal(r.failure, failure, why);
		assert.equal(JSON.stringify(r).includes("RAW"), false, "no raw error text");
	}
});

test("gate: a failed begin, an unsupported platform and a sub-millisecond remainder are unconfirmed without any helper call", async () => {
	const run = fakeRun(text(base()));
	assert.deepEqual(await mk(run, { platform: "linux" }).begin(() => 5000), { ok: false, failure: "unsupported_platform", recorded: [] });
	const r = await mk(run, { platform: "linux" }).finish({ ok: false, failure: "unsupported_platform", recorded: [] }, () => 5000);
	assert.equal(r.confirmed, false); assert.equal(r.failure, "unsupported_platform");
	assert.equal(run.calls.length, 0, "no spawn on a non-Windows platform");
	const b = await mk(run).begin(() => 0.9);
	assert.equal(b.ok, false); assert.equal(b.failure, "budget_spent");
	const f = await mk(run).finish({ ok: true, recorded: [] }, () => 0.5);
	assert.equal(f.confirmed, false); assert.equal(f.failure, "budget_spent");
	assert.equal(run.calls.length, 0, "a spent budget never starts a helper");
	const e = await mk(fakeRun(new GateFailure("timeout"))).begin(() => 5000);
	assert.deepEqual(e, { ok: false, failure: "timeout", recorded: [] });
});

test("gate: every helper call is bounded by the remaining original deadline (never a new grant)", async () => {
	const run = fakeRun(text(base()), text(base()));
	const g = mk(run);
	const st = await g.begin(() => 1234.9);
	await g.finish(st, () => 77.2);
	assert.deepEqual(run.calls.map((c) => c.ms), [1234, 77]);
});

// ---- review1 round 2: F1 (unreadable recorded identity), F6 (carried original deadline; pure fake clock) ----
test("F1: a recorded PID whose CURRENT row has an unreadable identity is ambiguous: fail closed, no signal, no quiescence; an unrelated unreadable row is not assumed owned", async () => {
	const st = { ok: true, recorded: [row(10, ROOT, T1)] };
	for (const [why, tbls] of [["post-close unreadable", [text([...base(), row(10, ROOT, null)])]], ["unreadable after a terminate round", [text([...base(), row(10, ROOT, T1)]), text([...base(), row(10, ROOT, null)], SELF, [[10, "terminated"]])]]]) {
		const run = fakeRun(...tbls);
		const r = await mk(run).finish(st, () => 5000);
		assert.equal(r.confirmed, false, why); assert.equal(r.failure, "identity_unreadable", why);
		assert.equal(run.calls.filter((c) => c.input.startsWith("terminate")).length, why === "post-close unreadable" ? 0 : 1, `${why}: no signal of the ambiguous identity`);
		assert.notEqual(r.remainingAlive, 0, why);
	}
	// a protected OS process that is NOT recorded and has no attributed parent is just unknown, not owned and not an error
	const ok = await mk(fakeRun(text([...base(), row(4321, 1, null)]))).finish(st, () => 5000);
	assert.equal(ok.confirmed, true); assert.equal(ok.failure, null);
	assert.throws(() => attributedAlive([...base(), row(10, ROOT, null)], [row(10, ROOT, T1)], ROOT, SELF), code("identity_unreadable"));
});

test("F1: the fixed native script keeps a GetExitCodeProcess failure UNKNOWN (tri-state), never gone (source check; the OS failure itself cannot be induced safely)", async () => {
	const { HELPER_ARGS } = await import("./lib/process-gate.mjs");
	const ps = Buffer.from(HELPER_ARGS[3], "base64").toString("utf16le");
	assert.doesNotMatch(ps, /static bool Active\(/, "no boolean Active: a failed query would read as exited");
	assert.match(ps, /static int State\(/); assert.match(ps, /GetExitCodeProcess\(h, out c\) \? \(c == 259 \? 1 : 0\) : -1/);
});

const fakeClock = (start = 1000000) => { const c = { t: start, log: [] }; c.uptime = () => { c.log.push("uptime"); return c.t; }; return c; };
const headOf = (input) => input.split("\n")[0].split(" ");
test("F6/P1: the carried deadline D is derived from uptime sampled FIRST, then the original remaining, minus the tick margin; capped at 15 s; small remainders start no helper", async () => {
	const clk = fakeClock(), log = clk.log, run = fakeRun(text(base()), text(base()), text(base()), text(base()));
	const rem = (v) => () => { log.push("remaining"); return v; };
	const g = mk(run, { uptimeMs: clk.uptime });
	await g.begin(rem(5000));
	assert.deepEqual(log.slice(0, 2), ["uptime", "remaining"], "uptime sampled before remaining");
	assert.deepEqual(headOf(run.calls[0].input), ["snapshot", String(1000000 + 5000 - TICK_MARGIN_MS)]);
	await g.finish({ ok: true, recorded: [] }, rem(600000));
	assert.deepEqual(headOf(run.calls[1].input), ["snapshot", String(1000000 + 15000 - TICK_MARGIN_MS)], "15 s cap");
	for (const v of [0, 0.5, 0.9, TICK_MARGIN_MS, TICK_MARGIN_MS + 0.9]) { const n = run.calls.length; const b = await g.begin(rem(v)); assert.equal(b.failure, "budget_spent", String(v)); assert.equal(run.calls.length, n, "no helper"); }
	await g.begin(rem(TICK_MARGIN_MS + 1)); assert.deepEqual(headOf(run.calls.at(-1).input), ["snapshot", String(1000000 + 1)]);
	assert.ok(Number.isSafeInteger(Number(headOf(run.calls[0].input)[1])));
});

test("F6/P2: no new grant: every later call derives D from the ORIGINAL remaining, so D never exceeds the original deadline (terminate carries wait and D)", async () => {
	const clk = fakeClock(), alive = [...base(), row(10, ROOT, T1)];
	const run = fakeRun(text(alive), text(alive), text(base(), SELF, [[10, "terminated"]]));
	const g = mk(run, { uptimeMs: clk.uptime });
	const original = clk.t + 5000; // the original deadline in the uptime domain
	const remaining = () => original - clk.t;
	const st = await g.begin(remaining); clk.t += 700;
	await g.finish(st, remaining);
	const ds = run.calls.map((c) => Number(headOf(c.input).at(-1)));
	assert.ok(ds.every((d) => d <= original - TICK_MARGIN_MS), JSON.stringify(ds));
	assert.deepEqual(headOf(run.calls[2].input).slice(0, 3), ["terminate", String(ROOT), String(Math.min(2000, Math.floor((original - clk.t) / 2)))]);
	assert.equal(headOf(run.calls[2].input).length, 4);
});

test("F6/P3: a helper return AFTER D (compile overrun, parent descheduled, close event before the timer) is a timeout: no proof, no further terminate round, even for a clean empty table", async () => {
	const clk = fakeClock(), alive = [...base(), row(10, ROOT, T1)];
	const b = await mk(async (input, ms) => { clk.t += ms + 1; return text(base()); }, { uptimeMs: clk.uptime }).begin(() => 5000);
	assert.deepEqual(b, { ok: false, failure: "timeout", recorded: [] });
	// finish: first snapshot late -> confirmed:false/timeout, remainingAlive stays null, no terminate
	let n = 0;
	const runA = async (input, ms) => { if (++n === 1) { clk.t += ms + 5; return text(base()); } throw new Error("no further call"); };
	const r = await mk(runA, { uptimeMs: clk.uptime }).finish({ ok: true, recorded: [row(10, ROOT, T1)] }, () => 5000);
	assert.deepEqual([r.confirmed, r.failure, r.assessable, r.remainingAlive, r.targeted], [false, "timeout", false, null, 0]); assert.equal(n, 1);
	// terminate round returns late: the last ON-TIME observation is kept, the late (clean) table is inadmissible, no third call
	let m = 0;
	const runB = async (input, ms) => { if (++m === 1) return text(alive); if (m === 2) { clk.t += ms + 5; return text(base(), SELF, [[10, "terminated"]]); } throw new Error("no further call"); };
	const r2 = await mk(runB, { uptimeMs: clk.uptime }).finish({ ok: true, recorded: [row(10, ROOT, T1)] }, () => 5000);
	assert.deepEqual([r2.confirmed, r2.failure, r2.remainingAlive, r2.targeted, r2.terminated], [false, "timeout", 1, 1, 0]); assert.equal(m, 2);
	// the original remaining spent during the call (even when the uptime check admits it) is also late
	let rem = 5000; const r3 = await mk(async () => { rem = 0.4; return text(base()); }, { uptimeMs: clk.uptime }).finish({ ok: true, recorded: [] }, () => rem);
	assert.deepEqual([r3.confirmed, r3.failure], [false, "timeout"]);
});

test("F6/P4: helper 'late' and kill outcome 'deadline' are timeouts: not terminated, not gone, not terminate_failed; no later request is made", async () => {
	const alive = [...base(), row(10, ROOT, T1), row(11, ROOT, T1)], st = { ok: true, recorded: [row(10, ROOT, T1), row(11, ROOT, T1)] };
	assert.throws(() => parseHelperOutput("self 7\nlate\nend\n"), code("timeout"));
	let calls = 0;
	const run = async () => (++calls === 1 ? text(alive) : text(alive, SELF, [[10, "terminated"], [11, "deadline"]]));
	const r = await mk(run).finish(st, () => 5000);
	assert.deepEqual([r.confirmed, r.failure, r.terminated, r.targeted], [false, "timeout", 1, 2]); assert.equal(calls, 2);
	assert.equal(parseHelperOutput("self 7\nclock 12345\nend\n").clock, 12345);
});

test("F6: uptimeMs is the public libuv uptime in whole ms (os.uptime()*1000 floored; a safe integer)", () => {
	const a = uptimeMs(); assert.ok(Number.isSafeInteger(a) && a > 0);
});

// ---- runner integration: capture -> close/drain -> gate -> history -> prepare ----
const cfg = (timeout = 400, grace = 100) => fixtureConfig({ limits: { roundSettleTimeoutMs: { value: 600000, source: "t" }, shutdownGraceMs: { value: grace, source: "t" }, taskTimeoutMs: { value: timeout, source: "t" } } });
function cutFirst(extra = {}) {
	let first = true;
	const ad = fakeAdapter({ mainScript: (s, t) => (first ? ((first = false), new Promise((r) => { s.release = () => r({ events: [], text: "" }); })) : fixMain(s, t)), ...extra });
	const close = ad.closeSession;
	ad.closeSession = async (s) => { s.release?.(); return close(s); };
	return ad;
}
// A source-shaped fake gate: begin before the close, finish after it; logs into the adapter log so the order is asserted on one timeline.
function fakeGate(ad, { confirmed = true, failure = null, begin = {}, over = {} } = {}) {
	const g = { method: "fake-gate/1", calls: [], async begin(rem) { g.calls.push(["begin", rem()]); ad.log.push(["gate-begin"]); return { ok: true, recorded: [{ pid: 4242424, created: "SECRETPID" }], ...begin }; },
		async finish(st, rem) { g.calls.push(["finish", rem(), st]); ad.log.push(["gate-finish"]); return { method: "fake-gate/1", confirmed, assessable: confirmed || failure === "still_alive", recorded: 1, attributedAlive: confirmed ? 0 : 1, terminated: 0, waitMs: 3, failure: confirmed ? null : failure ?? "still_alive", ...over }; } };
	return g;
}
const T = () => [task("H1"), task("H2"), task("H3")];
function withPrepareLog(ad) { const b = fakeWorkspace(root()); return { ...b, async prepare(t, d, o) { ad.log.push(["prepare", t.id]); return b.prepare(t, d, o); } }; }
const run = (tasks, mode, adapter, o = {}) => runBenchmark({ manifest: manifest(tasks), mode, adapter, workspace: o.workspace ?? fakeWorkspace(root()), acceptance: gate, config: o.config ?? cfg(), processGate: o.processGate });
const idx = (ad, pred) => ad.log.findIndex(pred);

test("long-fixed cut with an UNCONFIRMED gate stops: no history snapshot, no next workspace prepare, no new session; the SDK close stays confirmed and separate", async () => {
	const ad = cutFirst(); const pg = fakeGate(ad, { confirmed: false });
	const r = await run(T(), "long-fixed", ad, { workspace: withPrepareLog(ad), processGate: pg });
	assert.deepEqual(r.tasks.map((t) => t.id), ["H1"]);
	assert.deepEqual(r.notRun, ["H2", "H3"]);
	assert.equal(ad.log.filter((e) => e[0] === "prepare").length, 1, "only H1 was prepared");
	assert.equal(ad.log.filter((e) => e[0] === "snapshot").length, 0, "no history capture");
	assert.equal(ad.log.filter((e) => e[0] === "open" && e[2] === "main").length, 1, "no replacement session");
	assert.equal(r.tasks[0].shutdown.confirmed, true, "SDK close proof is not the gate proof");
	assert.equal(r.tasks[0].shutdown.processGate.confirmed, false);
	assert.deepEqual(r.continuationStop, { task: "H1", reason: "quiescence_unconfirmed" });
	assert.equal(r.tasks[0].continuation.stop.reason, "quiescence_unconfirmed");
	assert.equal(r.status, "unfinished");
	assert.match(r.error, /quiescence_unconfirmed/);
});

test("long-fixed cut with a CONFIRMED gate: order is capture -> close -> gate -> history snapshot -> next prepare, inside the original deadline", async () => {
	const ad = cutFirst(); const pg = fakeGate(ad);
	const r = await run(T(), "long-fixed", ad, { workspace: withPrepareLog(ad), processGate: pg });
	assert.deepEqual(r.tasks.map((t) => t.status), ["budget_exhausted", "completed", "completed"]);
	const order = [idx(ad, (e) => e[0] === "gate-begin"), idx(ad, (e) => e[0] === "close" && e[1] === 1), idx(ad, (e) => e[0] === "gate-finish"), idx(ad, (e) => e[0] === "snapshot"), idx(ad, (e) => e[0] === "prepare" && e[1] === "H2")];
	assert.ok(order.every((n) => n >= 0) && order.every((n, i) => i === 0 || order[i - 1] < n), `order ${order}`);
	assert.equal(pg.calls.filter((c) => c[0] === "begin").length, 1, "one gate per cut transition (H2/H3 completed: none)");
	assert.equal(pg.calls.filter((c) => c[0] === "finish").length, 1);
	// the supplied remainders are the ORIGINAL task deadline (cut at 300 of 400 ms): a new grant would show more than the reserve
	assert.ok(pg.calls.every((c) => c[1] <= 105 && c[1] >= 0), JSON.stringify(pg.calls.map((c) => c[1])));
	assert.equal(r.tasks[0].shutdown.processGate.confirmed, true);
	assert.equal(r.config.continuation.gate, "fake-gate/1");
});

test("gate privacy: only controlled counts/enums reach the result (no pid, identity, raw error)", async () => {
	const ad = cutFirst(); const pg = fakeGate(ad, { confirmed: false, failure: "timeout" });
	const r = await run(T(), "long-fixed", ad, { processGate: pg });
	const s = JSON.stringify(r);
	assert.equal(s.includes("4242424"), false); assert.equal(s.includes("SECRETPID"), false);
	assert.deepEqual(Object.keys(r.tasks[0].shutdown.processGate).sort(), ["assessable", "attributedAlive", "confirmed", "failure", "method", "recorded", "remainingAlive", "targeted", "terminated", "waitMs"]);
});

test("a gate that throws, or a begin that throws, is unconfirmed and stops the run (never success)", async () => {
	for (const bad of ["finish", "begin"]) {
		const ad = cutFirst(); const pg = fakeGate(ad);
		pg[bad] = async () => { throw new Error("RAW gate boom"); };
		const r = await run(T(), "long-fixed", ad, { workspace: withPrepareLog(ad), processGate: pg });
		assert.deepEqual(r.notRun, ["H2", "H3"], bad);
		assert.equal(r.continuationStop.reason, "quiescence_unconfirmed", bad);
		assert.equal(ad.log.filter((e) => e[0] === "prepare").length, 1, bad);
		assert.equal(JSON.stringify(r).includes("RAW gate boom"), false, bad);
	}
});

test("an unconfirmed SDK close stops as before and the gate is not assessed after it", async () => {
	const ad = cutFirst(); const c = ad.closeSession; ad.closeSession = async (s) => { await c(s); return { confirmed: false }; };
	const pg = fakeGate(ad);
	const r = await run(T(), "long-fixed", ad, { processGate: pg });
	assert.equal(r.shutdownUnconfirmed.task, "H1");
	assert.equal(pg.calls.filter((c2) => c2[0] === "finish").length, 0);
	assert.equal(r.tasks[0].shutdown.processGate.confirmed, false);
});

test("fresh mode, a completed task and the final task never invoke the gate; fresh records no gate policy", async () => {
	const ad = cutFirst(); const pg = fakeGate(ad);
	const r = await run(T(), "fresh", ad, { processGate: pg });
	assert.equal(pg.calls.length, 0, "fresh");
	assert.equal(r.config.continuation, undefined);
	const ad2 = fakeAdapter({ mainScript: fixMain }); const pg2 = fakeGate(ad2);
	await run(T(), "long-fixed", ad2, { processGate: pg2 });
	assert.equal(pg2.calls.length, 0, "completed transitions");
	const ad3 = cutFirst(); const pg3 = fakeGate(ad3);
	const r3 = await run([task("H1")], "long-fixed", ad3, { processGate: pg3 });
	assert.equal(pg3.calls.length, 0, "the final close has no next workspace");
	assert.equal(r3.tasks[0].shutdown.processGate, undefined);
});

test("without a gate the long-mode behaviour is unchanged and no gate policy is recorded", async () => {
	const ad = cutFirst();
	const r = await run(T(), "long-fixed", ad);
	assert.deepEqual(r.tasks.map((t) => t.status), ["budget_exhausted", "completed", "completed"]);
	assert.deepEqual(r.config.continuation, { policy: "faithful-history-restore/1" });
});

test("compare: a long result needs the same gate policy on both sides; fresh is not applicable; an absent gate matches an absent gate", () => {
	const res = (mode, gateId) => ({ mode, schemaVersion: "s", manifestDigest: "d", order: ["H1"], synthetic: false, status: "complete", tasks: [], notRun: [], config: { ...(mode === "fresh" ? {} : { continuation: { policy: "faithful-history-restore/1", ...(gateId ? { gate: gateId } : {}) } }) } });
	const why = (a, b) => compareResults(a, b).inconclusive.filter((m) => /gate policy/.test(m));
	assert.equal(why(res("long-fixed", GATE_METHOD), res("long-fixed", GATE_METHOD)).length, 0);
	assert.equal(why(res("long-fixed", null), res("long-fixed", null)).length, 0);
	assert.equal(why(res("long-fixed", null), res("long-fixed", GATE_METHOD)).length, 1, "no silent match with another or missing gate policy");
	assert.equal(why(res("long-fixed", "other/1"), res("long-fixed", GATE_METHOD)).length, 1);
	assert.equal(why(res("fresh", null), res("fresh", null)).length, 0, "fresh: not applicable");
});
