// Child entry wiring with a producer-shaped fake of the public ExtensionAPI/ExtensionContext (no Pi SDK runtime, session, provider or model).
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test, { afterEach } from "node:test";
import roleBudgetEntry from "../role-budget-entry.ts";
import pauseGate from "../pause-gate.ts";
import { applyBudgetEnv, BUDGET_ENV, WARNING_TEXT, type BudgetLaunch } from "../role-budget.ts";

type Handler = (event: any, ctx: any) => unknown;
const envKeys = Object.values(BUDGET_ENV);
afterEach(() => { for (const key of envKeys) delete process.env[key]; });

function setEnv(launch: BudgetLaunch) { applyBudgetEnv(process.env as Record<string, string | undefined>, launch); }

/** Fake pi: only `on` and `appendEntry` exist; any other call (steer, sendMessage, triggerTurn...) is recorded as forbidden. */
function harness(options: { tokens?: number | null | undefined; pending?: boolean } = {}) {
	const handlers = new Map<string, Handler[]>();
	const entries: Array<{ type: string; data: any }> = [];
	const forbidden: string[] = [];
	let aborts = 0;
	const state = { tokens: options.tokens, pending: options.pending ?? false };
	const pi = new Proxy({}, { get: (_t, prop: string) => prop === "on" ? (name: string, fn: Handler) => { handlers.set(name, [...(handlers.get(name) ?? []), fn]); } : prop === "appendEntry" ? (type: string, data: any) => { entries.push({ type, data }); } : () => { forbidden.push(prop); } });
	const ctx = { signal: undefined, abort: () => { aborts++; }, hasPendingMessages: () => state.pending, getContextUsage: () => state.tokens === undefined ? undefined : { tokens: state.tokens, contextWindow: 1000, percent: null } };
	return {
		pi, entries, forbidden, state, get aborts() { return aborts; },
		install() { (roleBudgetEntry as (p: unknown) => void)(pi); },
		fire: (name: string, event: any = {}) => { let last: unknown; for (const fn of handlers.get(name) ?? []) { const r = fn({ type: name, ...event }, ctx); if (r !== undefined) last = r; } return last; },
		has: (name: string) => handlers.has(name),
	};
}

const usage = (total: number) => ({ totalTokens: total, input: total, output: 0, cacheRead: 0, cacheWrite: 0 });
const assistant = (total = 10, stopReason = "toolUse") => ({ role: "assistant", stopReason, usage: usage(total), content: [] });
/** One completed tool turn as the SDK fires it: message_end(assistant) then turn_end with tool results. */
function toolTurn(h: ReturnType<typeof harness>, total = 10, tokens?: number | null) {
	if (tokens !== undefined) h.state.tokens = tokens;
	assert.equal(h.fire("message_end", { message: assistant(total) }), undefined);
	h.fire("turn_end", { outcome: "completed", message: assistant(total), toolResults: [{ role: "toolResult" }] });
}
const original = [{ role: "user", content: "task", timestamp: 1 }, { role: "assistant", content: [], timestamp: 2 }];

test("loading without a valid capability env fails (child exits before its first prompt)", () => {
	assert.throws(() => harness().install(), /no limit/);
	process.env[BUDGET_ENV.maxTurns] = "05";
	process.env[BUDGET_ENV.turnsBefore] = "0";
	process.env[BUDGET_ENV.warned] = "0";
	assert.throws(() => harness().install(), /positive safe integer/);
	process.env[BUDGET_ENV.maxTurns] = "3";
	delete process.env[BUDGET_ENV.warned];
	assert.throws(() => harness().install(), /0 or 1/);
});

test("80% injects one fixed user message into the already-required request and keeps every original message", () => {
	setEnv({ budget: { maxTurns: 5 }, turnsBefore: 0, warned: false });
	const h = harness();
	h.install();
	for (let i = 0; i < 3; i++) toolTurn(h);
	assert.equal(h.fire("context", { messages: original }), undefined); // below 80%: list untouched
	toolTurn(h);
	assert.equal(h.entries.length, 0); // nothing is recorded until a request carries it
	const result = h.fire("context", { messages: original }) as { messages: any[] };
	assert.equal(result.messages.length, 3);
	assert.equal(result.messages[0], original[0]);
	assert.equal(result.messages[1], original[1]);
	assert.deepEqual({ ...result.messages[2], timestamp: typeof result.messages[2].timestamp }, { role: "user", content: WARNING_TEXT, timestamp: "number" });
	assert.equal(original.length, 2); // input not mutated
	assert.equal(h.fire("context", { messages: original }), undefined); // once only
	assert.deepEqual(h.entries.map((e) => [e.type, e.data.event, e.data.status]), [["role-budget", "warn80", "sent"]]);
	assert.deepEqual(h.forbidden, []);
	assert.equal(h.aborts, 0);
});

test("context-only budget warns from the public estimate once anchored, and unknown never counts as zero", () => {
	setEnv({ budget: { contextBudget: 100 }, turnsBefore: 0, warned: false });
	const h = harness({ tokens: undefined });
	h.install();
	toolTurn(h, 10, undefined); // getContextUsage() undefined
	toolTurn(h, 10, null); // null after compaction
	assert.equal(h.fire("context", { messages: original }), undefined);
	toolTurn(h, 10, 79);
	assert.equal(h.fire("context", { messages: original }), undefined);
	toolTurn(h, 10, 80);
	assert.equal((h.fire("context", { messages: original }) as any).messages.length, 3);
});

test("a run that ends naturally at 80% records not_delivered and never wakes the model", () => {
	setEnv({ budget: { maxTurns: 5 }, turnsBefore: 0, warned: false });
	const h = harness();
	h.install();
	for (let i = 0; i < 3; i++) toolTurn(h);
	h.fire("message_end", { message: assistant() });
	h.state.tokens = 1;
	h.fire("turn_end", { outcome: "completed", message: assistant(), toolResults: [] }); // natural final answer: turn 4 of 5
	h.fire("agent_settled", { aborted: false });
	assert.deepEqual(h.entries.map((e) => [e.data.event, e.data.status]), [["warn80", "not_delivered"]]);
	assert.deepEqual(h.forbidden, []);
	assert.equal(h.aborts, 0);
});

test("a terminating tool at the limit is not retroactively stopped: no request means no abort or marker", () => {
	setEnv({ budget: { maxTurns: 2 }, turnsBefore: 0, warned: false });
	const h = harness();
	h.install();
	toolTurn(h);
	toolTurn(h); // limit recorded, toolResults present but the run ends (terminating tool): no context event follows
	h.fire("agent_settled", { aborted: false });
	assert.equal(h.aborts, 0);
	assert.deepEqual(h.entries.filter((e) => e.data.event === "exhausted"), []);
});

test("100% with work still active appends one trusted marker, aborts once and injects nothing", () => {
	setEnv({ budget: { maxTurns: 3 }, turnsBefore: 0, warned: false });
	const h = harness({ tokens: 40 });
	h.install();
	toolTurn(h);
	toolTurn(h);
	toolTurn(h); // limit; the 80% warning (turn 3) was pending and never delivered
	assert.equal(h.fire("context", { messages: original }), undefined);
	assert.equal(h.aborts, 1);
	assert.equal(h.fire("context", { messages: original }), undefined);
	assert.equal(h.aborts, 1);
	const exhausted = h.entries.filter((e) => e.data.event === "exhausted");
	assert.equal(exhausted.length, 1);
	assert.deepEqual(exhausted[0].data, { v: 1, event: "exhausted", reason: "turns", turns: 3, contextTokens: 40, warn80: "not_delivered" });
	assert.equal(h.entries.length, 1);
	h.fire("turn_end", { outcome: "aborted", message: assistant(1, "aborted"), toolResults: [] });
	h.fire("agent_settled", { aborted: true });
	assert.equal(h.aborts, 1);
	assert.equal(h.entries.length, 1);
	assert.deepEqual(h.forbidden, []);
});

test("cache warming and compaction are suppressed once the limit is known, not before", () => {
	setEnv({ budget: { maxTurns: 2 }, turnsBefore: 0, warned: false });
	const h = harness();
	h.install();
	toolTurn(h);
	assert.equal(h.fire("cache_warming_decision", { action: "warm" }), undefined);
	assert.equal(h.fire("session_before_compact", { reason: "threshold" }), undefined);
	toolTurn(h); // limit known
	assert.deepEqual(h.fire("cache_warming_decision", { action: "warm" }), { action: "stop" });
	assert.deepEqual(h.fire("session_before_compact", { reason: "threshold" }), { cancel: true });
	h.fire("context", { messages: original }); // exhausted
	assert.deepEqual(h.fire("cache_warming_decision", { action: "warm" }), { action: "stop" });
	assert.deepEqual(h.fire("session_before_compact", { reason: "overflow" }), { cancel: true });
});

test("compaction clears the anchor and the next anchored response restores context measurement", () => {
	setEnv({ budget: { contextBudget: 100 }, turnsBefore: 0, warned: false });
	const h = harness();
	h.install();
	toolTurn(h, 10, 50);
	h.fire("session_compact", { reason: "threshold" });
	h.fire("turn_end", { outcome: "completed", message: assistant(), toolResults: [{}] }); // estimate only: unanchored
	h.state.tokens = 500;
	h.fire("turn_end", { outcome: "completed", message: assistant(), toolResults: [{}] });
	assert.equal(h.fire("context", { messages: original }), undefined);
	assert.equal(h.aborts, 0);
	toolTurn(h, 10, 500); // re-anchored
	h.fire("context", { messages: original });
	assert.equal(h.aborts, 1);
});

const observations = (h: ReturnType<typeof harness>) => h.entries.filter((e) => e.type === "role-budget" && e.data.event === "context").map((e) => e.data.tokens);

test("a context-capped child reports its current observation each turn: unknown without an anchor or SDK estimate, known only with both", () => {
	setEnv({ budget: { contextBudget: 1000 }, turnsBefore: 0, warned: false });
	const h = harness();
	h.install();
	toolTurn(h, 0, 300); // estimate available but no anchored (positive-usage) response: unknown
	h.state.tokens = undefined; // toolTurn leaves the estimate alone for undefined
	toolTurn(h, 10); // anchored, but the SDK has no estimate: unknown (never 0)
	toolTurn(h, 10, 300); // anchored and available
	assert.deepEqual(observations(h), [null, null, 300]);
	assert.deepEqual(h.forbidden, []);
});

test("compaction reports unknown at once and the next anchored turn reports a known estimate again", () => {
	setEnv({ budget: { contextBudget: 1000 }, turnsBefore: 0, warned: false });
	const h = harness();
	h.install();
	toolTurn(h, 10, 300);
	h.fire("session_compact", { reason: "threshold" });
	toolTurn(h, 10, 200); // new response re-anchors
	assert.deepEqual(observations(h), [300, null, 200]);
});

test("a turn-capped child with no context limit appends no observation entries", () => {
	setEnv({ budget: { maxTurns: 5 }, turnsBefore: 0, warned: false });
	const h = harness();
	h.install();
	toolTurn(h, 10, 300);
	h.fire("session_compact", { reason: "threshold" });
	assert.deepEqual(observations(h), []);
});

test("turnsBefore and warned from earlier attempts carry across fallback", () => {
	setEnv({ budget: { maxTurns: 5 }, turnsBefore: 3, warned: true });
	const h = harness();
	h.install();
	toolTurn(h); // 4 of 5: warning already sent by an earlier attempt
	assert.equal(h.fire("context", { messages: original }), undefined);
	toolTurn(h); // 5 of 5
	h.fire("context", { messages: original });
	assert.equal(h.aborts, 1);
	assert.equal(h.entries[0].data.turns, 5);
});

const temp = () => fs.mkdtempSync(path.join(process.env.TEMP ?? os.tmpdir(), "pause-gate-"));
async function pauseHandlers(control: string) {
	const handlers = new Map<string, Handler>();
	process.env.PI_SUBAGENT_CONTROL_FILE = control;
	(pauseGate as (p: unknown) => void)({ on: (name: string, fn: Handler) => handlers.set(name, fn) });
	delete process.env.PI_SUBAGENT_CONTROL_FILE;
	return handlers;
}
const withSilentStdout = <T>(fn: () => Promise<T>): Promise<T> => fn(); // worker_pause_state lines on stdout are harmless to the child test runner
const settles = (promise: Promise<unknown>, ms: number) => Promise.race([promise.then(() => true), new Promise<boolean>((r) => setTimeout(() => r(false), ms))]);

test("pause gate releases an aborted run at every hold boundary but keeps non-aborted holds", async () => {
	await withSilentStdout(async () => {
		const dir = temp();
		const control = path.join(dir, "control.json");
		fs.writeFileSync(control, "1");
		const handlers = await pauseHandlers(control);
		try {
		for (const name of ["before_provider_request", "tool_call", "agent_before_settle", "before_agent_start"]) {
			assert.equal(await settles(handlers.get(name)!({}, { signal: AbortSignal.abort() }), 1000), true, `${name} aborted`);
		}
		const held = handlers.get("before_provider_request")!({}, { signal: new AbortController().signal });
		assert.equal(await settles(held, 300), false, "non-aborted user hold stays held");
		const controller = new AbortController();
		const midHold = handlers.get("tool_call")!({}, { signal: controller.signal });
		controller.abort(); // abort arrives while paused
		assert.equal(await settles(midHold, 1000), true);
		fs.writeFileSync(control, "0");
		assert.equal(await settles(held, 1000), true, "resume releases the held boundary");
		} finally {
			fs.writeFileSync(control, "0"); // a failing run must not leave hold loops alive
			await new Promise((resolve) => setTimeout(resolve, 250));
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});
});
