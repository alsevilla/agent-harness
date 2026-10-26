// Usage ledger: measured vs unavailable, cache-tier cost from SDK-reported cost parts, worker usage from subagent details.
import assert from "node:assert/strict";
import test from "node:test";
import { emptyLedger, addAssistantUsage, addWorkerUsage, ledgerTotals, addLedgers, sumCosts } from "./lib/usage.mjs";

const msg = (usage) => ({ role: "assistant", usage, content: [{ type: "text", text: "PRIVATE body text" }] });
const usage = (input, output, cacheRead, cacheWrite, total) => ({ input, output, cacheRead, cacheWrite, totalTokens: input + output + cacheRead + cacheWrite, cost: { input: total / 2, output: total / 4, cacheRead: total / 8, cacheWrite: total / 8, total } });

test("an assistant turn with usage adds tokens and SDK cost including the cache-tier parts", () => {
	const t = ledgerTotals(addAssistantUsage(emptyLedger(), msg(usage(10, 5, 100, 20, 0.4))));
	assert.deepEqual([t.turns, t.input, t.output, t.cacheRead, t.cacheWrite], [1, 10, 5, 100, 20]);
	assert.equal(t.status, "measured");
	assert.equal(t.cost.total, 0.4);
	assert.equal(t.cost.cacheTier, 0.1);
});

test("a turn without usage or without a finite cost is counted as unreported or unpriced, never as zero", () => {
	let l = addAssistantUsage(emptyLedger(), msg(undefined));
	assert.equal(ledgerTotals(l).status, "unavailable");
	assert.equal(ledgerTotals(l).input, null);
	l = addAssistantUsage(l, msg({ input: 3, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 4 }));
	const t = ledgerTotals(l);
	assert.equal(t.unreportedTurns, 1);
	assert.equal(t.unpricedTurns, 1);
	assert.equal(t.status, "partial");
	assert.equal(t.cost.total, null);
});

test("non-assistant messages are ignored", () => {
	assert.equal(ledgerTotals(addAssistantUsage(emptyLedger(), { role: "user", content: "x" })).turns, 0);
});

test("subagent tool details add worker launches and per-child totals; cache split stays unavailable", () => {
	const details = { mode: "single", results: [{ agent: "debugger", usage: { input: 7, output: 3, cacheRead: 0, cacheWrite: 0, cost: 0.02, turns: 2, contextTokens: 9 } }, { agent: "reviewer", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0.01, turns: 1, contextTokens: 2 } }] };
	const t = ledgerTotals(addWorkerUsage(emptyLedger(), details));
	assert.equal(t.launches, 2);
	assert.equal(t.turns, 3);
	assert.equal(t.cost.total, 0.03);
	assert.equal(t.cost.cacheTier, null);
	assert.equal(t.cost.cacheTierNote, "worker results report total cost only");
});

test("missing subagent details are not counted as a measured zero-cost launch", () => {
	const t = ledgerTotals(addWorkerUsage(emptyLedger(), undefined));
	assert.equal(t.launches, 0);
	assert.equal(t.status, "unavailable");
});

test("ledgers add without losing unavailable markers; sumCosts propagates null", () => {
	const a = addAssistantUsage(emptyLedger(), msg(usage(1, 1, 0, 0, 0.1)));
	const b = addAssistantUsage(emptyLedger(), msg(undefined));
	const t = ledgerTotals(addLedgers(a, b));
	assert.equal(t.turns, 2);
	assert.equal(t.unreportedTurns, 1);
	assert.equal(t.status, "partial");
	assert.equal(sumCosts([0.1, 0.2]), 0.30000000000000004);
	assert.equal(sumCosts([0.1, null]), null);
});

// C2: a launch with no child assistant turn is a failed attempt, never a measured zero-cost workload.
test("a launch with no child turn is a failed attempt: not measured, cost and tokens unknown (null), never zero", () => {
	const details = { mode: "single", results: [{ agent: "general-worker", exitCode: 1, stopReason: "error", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 } }] };
	const t = ledgerTotals(addWorkerUsage(emptyLedger(), details));
	assert.equal(t.launches, 0);
	assert.equal(t.failedLaunches, 1);
	assert.equal(t.status, "failed");
	assert.equal(t.cost.total, null);
	assert.equal(t.input, null);
});

test("a measured child is counted; a failed sibling is listed separately and makes the worker total partial (cost unknown)", () => {
	const details = { mode: "single", results: [
		{ agent: "general-worker", usage: { input: 5, output: 2, cacheRead: 0, cacheWrite: 0, cost: 0.02, turns: 1, contextTokens: 3 } },
		{ agent: "debugger", exitCode: 1, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 } },
	] };
	const t = ledgerTotals(addWorkerUsage(emptyLedger(), details));
	assert.equal(t.launches, 1);
	assert.equal(t.failedLaunches, 1);
	assert.equal(t.status, "partial");
	assert.equal(t.cost.total, null);
});
