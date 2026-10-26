// Phase 1 main-session telemetry: per-turn prompt/output/cache components, compaction and reset lifecycle, branch rebuild, honest unavailable values.
import assert from "node:assert/strict";
import test from "node:test";
import { auxiliaryUsage, emptyMainState, formatMain, mainStateFromBranch, recordMainCompaction, recordMainTurn } from "../main-usage.ts";

const assistant = (usage: unknown, text = "PRIVATE conversation text") => ({ role: "assistant", content: [{ type: "text", text }], usage });
const usage = (input: number, output: number, cacheRead = 0, cacheWrite = 0, cost = 0.01) => ({
	input, output, cacheRead, cacheWrite, totalTokens: input + output + cacheRead + cacheWrite,
	cost: { input: cost / 2, output: cost / 4, cacheRead: cost / 8, cacheWrite: cost / 8, total: cost },
});

test("a turn records prompt tokens as input + cacheRead + cacheWrite and never adds output", () => {
	const s = emptyMainState();
	recordMainTurn(s, assistant(usage(1000, 300, 5000, 200, 0.2)));
	assert.equal(s.turns, 1);
	assert.equal(s.last?.promptTokens, 6200);
	assert.equal(s.last?.output, 300);
	assert.equal(s.peakPrompt, 6200);
	assert.equal(s.totals.input, 1000);
	assert.equal(s.totals.cacheRead, 5000);
	assert.equal(s.totals.cacheWrite, 200);
	assert.equal(s.totals.output, 300);
	assert.ok(Math.abs(s.totals.cost - 0.2) < 1e-12);
	assert.ok(Math.abs(s.totals.cacheCost - 0.05) < 1e-12, "cache-tier cost is reported separately and included in the total");
});

test("non-assistant messages are ignored; an assistant turn without usage is counted as unreported", () => {
	const s = emptyMainState();
	recordMainTurn(s, { role: "toolResult", content: [], usage: usage(9, 9) });
	recordMainTurn(s, { role: "user", content: "x" });
	assert.equal(s.turns, 0);
	recordMainTurn(s, { role: "assistant", content: [] });
	assert.equal(s.turns, 1);
	assert.equal(s.unreportedTurns, 1);
	assert.equal(s.last?.promptTokens, null);
	assert.equal(s.peakPrompt, null);
});

test("malformed usage values are treated as unreported, never thrown or invented", () => {
	const s = emptyMainState();
	recordMainTurn(s, assistant({ input: "lots", output: Number.NaN, cacheRead: undefined, cacheWrite: null, cost: "free" }));
	assert.equal(s.turns, 1);
	assert.equal(s.unreportedTurns, 1, "a non-numeric input makes the prompt unreported");
	assert.equal(s.last?.promptTokens, null);
	assert.equal(s.totals.cost, 0);
	assert.equal(s.unpricedTurns, 0, "an unreported turn is not also counted as unpriced");
	recordMainTurn(s, assistant({ input: 5, output: 1, cacheRead: 0, cacheWrite: 0, cost: "free" }));
	assert.equal(s.unpricedTurns, 1, "a reported turn with a non-numeric cost is unpriced");
	assert.equal(s.totals.cost, 0);
	assert.equal(s.last?.promptTokens, 5);
});

test("compaction starts a new since-compaction window; session totals keep growing", () => {
	const s = emptyMainState();
	recordMainTurn(s, assistant(usage(100, 1, 0, 0)));
	recordMainTurn(s, assistant(usage(900, 1, 0, 0)));
	recordMainCompaction(s, { tokensBefore: 880, usage: undefined }, "threshold");
	assert.equal(s.compactions, 1);
	assert.equal(s.lastCompaction?.tokensBefore, 880);
	assert.equal(s.lastCompaction?.reason, "threshold");
	assert.equal(s.turnsSinceCompaction, 0);
	assert.equal(s.peakPromptSinceCompaction, null);
	recordMainTurn(s, assistant(usage(300, 1, 0, 0)));
	assert.equal(s.turns, 3);
	assert.equal(s.turnsSinceCompaction, 1);
	assert.equal(s.peakPrompt, 900);
	assert.equal(s.peakPromptSinceCompaction, 300);
});

test("branch rebuild after reload or resume matches live replay and never retains message text", () => {
	const entries = [
		{ type: "message", message: { role: "user", content: "hello" } },
		{ type: "message", message: assistant(usage(100, 10, 0, 0, 0.1)) },
		{ type: "usage", kind: "cache_warm", usage: usage(0, 0, 500, 0, 0.015) },
		{ type: "compaction", tokensBefore: 5000, usage: usage(50, 5, 0, 0, 0.02) },
		{ type: "message", message: assistant(usage(400, 20, 0, 0, 0.3)) },
	];
	const rebuilt = mainStateFromBranch(entries);
	const live = emptyMainState();
	recordMainTurn(live, assistant(usage(100, 10, 0, 0, 0.1)));
	recordMainTurn(live, assistant(usage(400, 20, 0, 0, 0.3)));
	assert.equal(rebuilt.turns, 2);
	assert.equal(rebuilt.turnsSinceCompaction, 1);
	assert.equal(rebuilt.compactions, 1);
	assert.equal(rebuilt.lastCompaction?.tokensBefore, 5000);
	assert.equal(rebuilt.totals.cost, live.totals.cost);
	assert.equal(rebuilt.peakPrompt, 400);
	assert.doesNotMatch(JSON.stringify(rebuilt), /PRIVATE|hello/);
	const aux = auxiliaryUsage(entries);
	assert.equal(aux.entries, 2);
	assert.ok(Math.abs(aux.cost - 0.035) < 1e-12);
	assert.equal(aux.unpriced, 0);
});

test("branch summary usage is auxiliary cost too; entries without usage add nothing", () => {
	const entries = [{ type: "branch_summary", usage: usage(0, 0, 0, 0, 0.5) }, { type: "branch_summary" }, { type: "compaction", tokensBefore: 10 }];
	assert.deepEqual(auxiliaryUsage(entries), { entries: 1, cost: 0.5, unpriced: 0 });
});

test("session reset (new, resume, fork, startup) starts from an empty state", () => {
	const fresh = mainStateFromBranch([]);
	assert.equal(fresh.turns, 0);
	assert.equal(fresh.compactions, 0);
	assert.equal(fresh.turnsSinceCompaction, 0);
	assert.equal(fresh.last, undefined);
	assert.deepEqual(auxiliaryUsage([]), { entries: 0, cost: 0, unpriced: 0 });
});

test("formatMain labels unavailable context honestly and uses the supplied main window", () => {
	const s = mainStateFromBranch([{ type: "message", message: assistant(usage(40000, 500, 10000, 0, 0.05)) }]);
	const none = formatMain(s, auxiliaryUsage([]), { tokens: null, window: 200000 });
	assert.match(none, /Context now: unavailable/);
	assert.match(none, /since session start/);
	assert.match(none, /since last compaction/);
	const known = formatMain(s, auxiliaryUsage([]), { tokens: 50000, window: 200000 });
	assert.match(known, /Context now: 50,000 of 200,000 tokens \(25\.0%, runtime estimate\)/);
	const noWindow = formatMain(s, auxiliaryUsage([]), { tokens: 50000, window: undefined });
	assert.match(noWindow, /window unavailable/);
	const empty = formatMain(emptyMainState(), auxiliaryUsage([]), { tokens: null, window: undefined });
	assert.match(empty, /No main-session turns recorded/);
});
