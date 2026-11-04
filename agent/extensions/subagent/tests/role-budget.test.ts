// Pure role-budget contract: validation, precedence, capability env, marker parsing, integer thresholds and the child state machine.
import assert from "node:assert/strict";
import test from "node:test";
import { applyBudgetEnv, BUDGET_ENV, BudgetMachine, budgetViolation, normalizeBudget, parseBudgetEnv, parseMarker, warnAt, type BudgetLaunch } from "../role-budget.ts";

const MAX = Number.MAX_SAFE_INTEGER;
const launch = (budget: BudgetLaunch["budget"], turnsBefore = 0, warned = false): BudgetLaunch => ({ budget, turnsBefore, warned });
const assistantEnd = (m: BudgetMachine, total = 10, stopReason = "toolUse") => m.assistantEnd({ role: "assistant", stopReason, usage: { totalTokens: total, input: total, output: 0, cacheRead: 0, cacheWrite: 0 } });
/** One completed tool turn: assistant message_end then turn_end with tool results. */
const toolTurn = (m: BudgetMachine, tokens?: unknown) => { assistantEnd(m); m.turnEnd({ outcome: "completed", message: { role: "assistant", stopReason: "toolUse" } }, tokens); };

test("both fields unset is disabled and an empty object is rejected", () => {
	assert.deepEqual(normalizeBudget(undefined, undefined), {});
	assert.match(normalizeBudget({}, undefined).error!, /needs maxTurns or contextBudget/);
	assert.match(normalizeBudget(undefined, {}).error!, /needs maxTurns or contextBudget/);
});

test("every invalid shape is rejected, never ignored", () => {
	for (const bad of [0, -1, 1.5, "3", Number.NaN, Infinity, MAX + 1, null, [], true]) {
		assert.ok(budgetViolation({ maxTurns: bad }, "b"), `maxTurns ${String(bad)}`);
		assert.ok(budgetViolation({ contextBudget: bad }, "b"), `contextBudget ${String(bad)}`);
	}
	for (const bad of [null, [], "x", 3]) assert.ok(normalizeBudget(bad, undefined).error && normalizeBudget(undefined, bad).error, String(bad));
	assert.match(budgetViolation({ maxTurns: 2, tokens: 5 }, "b")!, /unknown key tokens/);
	assert.equal(budgetViolation({ maxTurns: MAX, contextBudget: 1 }, "b"), null);
});

test("task budget overrides the role budget per field", () => {
	assert.deepEqual(normalizeBudget({ maxTurns: 5, contextBudget: 100 }, { maxTurns: 2 }).effective, { maxTurns: 2, contextBudget: 100 });
	assert.deepEqual(normalizeBudget({ maxTurns: 5 }, { contextBudget: 9 }).effective, { maxTurns: 5, contextBudget: 9 });
	assert.deepEqual(normalizeBudget(undefined, { maxTurns: 3 }).effective, { maxTurns: 3 });
	// An invalid role budget fails even when the task supplies a valid one.
	assert.match(normalizeBudget({ maxTurns: 0 }, { maxTurns: 3 }).error!, /role budget.maxTurns/);
});

test("capability env is numeric-only, replaces stale values and round-trips", () => {
	const env: Record<string, string | undefined> = { [BUDGET_ENV.contextBudget]: "999", [BUDGET_ENV.maxTurns]: "7" };
	applyBudgetEnv(env, launch({ maxTurns: 4 }, 3, true));
	assert.deepEqual(env, { [BUDGET_ENV.maxTurns]: "4", [BUDGET_ENV.turnsBefore]: "3", [BUDGET_ENV.warned]: "1" });
	assert.deepEqual(parseBudgetEnv(env), launch({ maxTurns: 4 }, 3, true));
	applyBudgetEnv(env, launch({ maxTurns: MAX, contextBudget: 8 }, 0, false));
	assert.deepEqual(parseBudgetEnv(env), launch({ maxTurns: MAX, contextBudget: 8 }, 0, false));
});

test("child env parse fails closed on missing or malformed requested configuration", () => {
	const ok = { [BUDGET_ENV.maxTurns]: "3", [BUDGET_ENV.turnsBefore]: "0", [BUDGET_ENV.warned]: "0" };
	assert.doesNotThrow(() => parseBudgetEnv(ok));
	assert.throws(() => parseBudgetEnv({}), /no limit/);
	assert.throws(() => parseBudgetEnv({ [BUDGET_ENV.turnsBefore]: "0", [BUDGET_ENV.warned]: "0" }), /no limit/);
	for (const bad of ["0", "-1", "05", "1e3", " 5", "", "1.5", "abc", String(MAX + 2)]) {
		assert.throws(() => parseBudgetEnv({ ...ok, [BUDGET_ENV.maxTurns]: bad }), /positive safe integer/, bad);
		assert.throws(() => parseBudgetEnv({ ...ok, [BUDGET_ENV.contextBudget]: bad }), /positive safe integer/, bad);
	}
	for (const bad of [undefined, "-1", "01", "x", ""]) assert.throws(() => parseBudgetEnv({ ...ok, [BUDGET_ENV.turnsBefore]: bad }), /non-negative/, String(bad));
	for (const bad of [undefined, "2", "true", ""]) assert.throws(() => parseBudgetEnv({ ...ok, [BUDGET_ENV.warned]: bad }), /0 or 1/, String(bad));
	assert.equal(parseBudgetEnv({ ...ok, [BUDGET_ENV.turnsBefore]: "0" }).turnsBefore, 0); // zero is a valid turnsBefore
});

test("warn threshold is exact ceil(cap*0.8) with no overflow near the safe-integer limit", () => {
	assert.deepEqual([1, 2, 4, 5, 6, 9, 10, 100].map(warnAt), [1, 2, 4, 4, 5, 8, 8, 80]);
	assert.equal(warnAt(MAX), MAX - Math.floor(MAX / 5));
	assert.ok(Number.isSafeInteger(warnAt(MAX)) && warnAt(MAX) < MAX);
});

test("markers accept only well-formed numeric/enum payloads", () => {
	const entry = (data: unknown, customType = "role-budget") => ({ type: "custom", customType, data });
	assert.deepEqual(parseMarker(entry({ v: 1, event: "warn80", status: "sent", turns: 4 })), { v: 1, event: "warn80", status: "sent", turns: 4 });
	assert.deepEqual(parseMarker(entry({ v: 1, event: "exhausted", reason: "context", turns: 2, contextTokens: null, warn80: "not_delivered" }))?.event, "exhausted");
	for (const bad of [entry({ v: 2, event: "warn80", status: "sent", turns: 1 }), entry({ v: 1, event: "warn80", status: "maybe", turns: 1 }), entry({ v: 1, event: "exhausted", reason: "time", turns: 1, contextTokens: 1, warn80: "sent" }), entry({ v: 1, event: "exhausted", reason: "turns", turns: -1, contextTokens: 1, warn80: "sent" }), entry({ v: 1, event: "exhausted", reason: "turns", turns: 1, contextTokens: "7", warn80: "sent" }), entry({ v: 1, event: "warn80", status: "sent", turns: 1 }, "other"), null, "x", { type: "custom", customType: "role-budget" }]) assert.equal(parseMarker(bad), undefined);
});

test("80% warns once at a boundary and only the next required request delivers it", () => {
	const m = new BudgetMachine(launch({ maxTurns: 5 }));
	for (let i = 0; i < 3; i++) toolTurn(m);
	assert.equal(m.request(), "none"); // 3/5 is below 80%
	toolTurn(m); // 4/5
	assert.equal(m.warnPending, true);
	assert.equal(m.request(), "warn");
	assert.equal(m.request(), "none"); // once only
	assert.equal(m.warned, true);
});

test("a run that ends at 80% without another request never delivers the warning", () => {
	const m = new BudgetMachine(launch({ maxTurns: 5 }));
	for (let i = 0; i < 4; i++) toolTurn(m);
	assert.equal(m.warnPending, true);
	assert.equal(m.warned, false); // agent_settled finds it still pending => not_delivered
});

test("100% records the limit at turn_end but only a following required request exhausts", () => {
	const m = new BudgetMachine(launch({ maxTurns: 3 }));
	for (let i = 0; i < 3; i++) toolTurn(m);
	assert.equal(m.limit, "turns");
	assert.equal(m.exhausted, false); // a terminating tool or natural end here never becomes partial
	assert.equal(m.stopping, true);
	assert.equal(m.request(), "exhaust");
	assert.equal(m.exhausted, true);
	assert.equal(m.request(), "none"); // once only
});

test("80% and 100% at the same boundary exhaust without a warning", () => {
	const m = new BudgetMachine(launch({ maxTurns: 2 }));
	toolTurn(m); // warnAt(2) is 2: the same boundary
	toolTurn(m);
	assert.equal(m.warnPending, false);
	assert.equal(m.request(), "exhaust");
});

test("turnsBefore carries earlier attempts and warned carries the warning-sent state", () => {
	const m = new BudgetMachine(launch({ maxTurns: 5 }, 3, false));
	toolTurn(m); // 4 of 5
	assert.equal(m.request(), "warn");
	const again = new BudgetMachine(launch({ maxTurns: 5 }, 3, true));
	toolTurn(again);
	assert.equal(again.warnPending, false); // already sent in an earlier attempt
	toolTurn(again);
	assert.equal(again.limit, "turns");
	const zero = new BudgetMachine(launch({ maxTurns: 1 }, 0));
	toolTurn(zero);
	assert.equal(zero.limit, "turns");
});

test("context is unknown (never 0) until an anchored response, for every missing SDK shape", () => {
	const m = new BudgetMachine(launch({ contextBudget: 100 }));
	m.turnEnd({ outcome: "completed", message: { role: "assistant", stopReason: "toolUse" } }, 5000); // not anchored: an SDK estimate alone is never trusted
	assert.equal(m.contextTokens, null);
	assert.equal(m.limit, undefined);
	for (const bad of [undefined, null, Number.NaN, -1, Infinity, "9999"]) {
		toolTurn(m, bad);
		assert.equal(m.contextTokens, null, String(bad));
		assert.equal(m.limit, undefined, String(bad));
	}
	toolTurn(m, 79);
	assert.equal(m.contextTokens, 79);
	assert.equal(m.warnPending, false);
	toolTurn(m, 80);
	assert.equal(m.warnPending, true);
	toolTurn(m, 100);
	assert.equal(m.limit, "context");
});

test("zero-usage and failed responses never anchor; compaction clears and a new response re-anchors", () => {
	const m = new BudgetMachine(launch({ contextBudget: 100 }));
	assistantEnd(m, 0, "toolUse");
	assistantEnd(m, 500, "error");
	assistantEnd(m, 500, "aborted");
	m.turnEnd({ outcome: "completed", message: { role: "assistant", stopReason: "toolUse" } }, 500);
	assert.equal(m.contextTokens, null);
	assistantEnd(m, 5);
	m.compacted();
	m.turnEnd({ outcome: "completed", message: { role: "assistant", stopReason: "toolUse" } }, 500);
	assert.equal(m.contextTokens, null); // post-compaction estimate is unanchored
	assert.equal(m.limit, undefined);
	toolTurn(m, 120);
	assert.equal(m.limit, "context");
});

test("error and aborted turns take no budget action", () => {
	const m = new BudgetMachine(launch({ maxTurns: 1 }));
	assistantEnd(m, 5, "error");
	m.turnEnd({ outcome: "error", message: { role: "assistant", stopReason: "error" } }, 1);
	m.turnEnd({ message: { role: "assistant", stopReason: "aborted" } }, 1);
	assert.equal(m.limit, undefined);
	assert.equal(m.request(), "none");
});

test("threshold math is exact at the safe-integer boundary", () => {
	const m = new BudgetMachine(launch({ maxTurns: MAX }, MAX - 2));
	toolTurn(m); // MAX - 1
	assert.equal(m.limit, undefined);
	toolTurn(m); // MAX
	assert.equal(m.limit, "turns");
});

// ---- current child context observation (repair 2): fresh per turn, never a sticky prior-usage flag ----
test("a context observation marker accepts only a known non-negative estimate or an explicit unknown", () => {
	const entry = (data: unknown, customType = "role-budget") => ({ type: "custom", customType, data });
	assert.deepEqual(parseMarker(entry({ v: 1, event: "context", tokens: 120, turns: 2 })), { v: 1, event: "context", tokens: 120, turns: 2 });
	assert.deepEqual(parseMarker(entry({ v: 1, event: "context", tokens: null, turns: 0 })), { v: 1, event: "context", tokens: null, turns: 0 });
	for (const bad of [{ tokens: "7" }, { tokens: -1 }, { tokens: 1.5 }, { tokens: Number.NaN }, { tokens: undefined }, { tokens: 1, turns: -1 }]) assert.equal(parseMarker(entry({ v: 1, event: "context", turns: 1, ...bad })), undefined, JSON.stringify(bad));
	assert.equal(parseMarker(entry({ v: 1, event: "context", tokens: 1, turns: 1 }, "other")), undefined);
});

test("the machine observes context only when a context limit is configured, and an errored turn is unknown rather than the previous estimate", () => {
	assert.equal(new BudgetMachine(launch({ maxTurns: 3 })).tracksContext, false);
	const m = new BudgetMachine(launch({ contextBudget: 100 }));
	assert.equal(m.tracksContext, true);
	toolTurn(m, 40);
	assert.equal(m.contextTokens, 40);
	assistantEnd(m, 5, "error");
	m.turnEnd({ outcome: "error", message: { role: "assistant", stopReason: "error" } }, 41);
	assert.equal(m.contextTokens, null); // this turn produced no estimate; the old 40 is not the current observation
});
