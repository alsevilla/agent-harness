// Cache health in /subagent usage. v1.15.0 rewrote every worker's whole history to the prompt cache on each request (a backend-worker read
// 0.75M and wrote 2.07M, $5.59 for one task) and the report gave no sign of it; the hit share and warning make that visible on the first task.
import assert from "node:assert/strict";
import test from "node:test";
import { cacheNote, formatUsageSummary, mainCacheTotals, newUsageScope } from "../background.ts";

test("cache note: hit share on every role that uses the cache; a warning when it writes more than it reads over 5+ turns", () => {
	const broken = cacheNote({ turns: 40, input: 156, cacheRead: 749_540, cacheWrite: 2_072_802 });
	assert.match(broken, /^; cache hit 27% - WARNING: wrote more to the cache than it read/);
	assert.equal(cacheNote({ turns: 40, input: 200, cacheRead: 1_800_000, cacheWrite: 130_000 }), "; cache hit 93%");
	assert.equal(cacheNote({ turns: 2, input: 0, cacheRead: 1_000, cacheWrite: 20_000 }), "; cache hit 5%", "a short run writes before it can read: no warning");
	assert.equal(cacheNote({ turns: 25, input: 226_687, cacheRead: 0, cacheWrite: 0 }), "", "a provider that reports no cache use gets no note");
});

test("the usage report shows the hit share per role and main's own cache line", () => {
	const scope = newUsageScope();
	scope.foreground = { ...scope.foreground, completed: 1, attempts: 1, turns: 40, input: 156, output: 33_476, cacheRead: 749_540, cacheWrite: 2_072_802, cost: 5.592 };
	scope.roles = { "backend-worker": { ...scope.foreground } };
	const main = mainCacheTotals({ sessionManager: { getBranch: () => [
		{ type: "message", message: { role: "user", content: "hi" } },
		{ type: "message", message: { role: "assistant", usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 20_000 } } },
		{ type: "message", message: { role: "assistant", usage: { input: 12, output: 5, cacheRead: 20_000, cacheWrite: 1_500 } } },
		{ type: "custom", data: {} },
	] } });
	assert.deepEqual(main, { turns: 2, input: 22, cacheRead: 20_000, cacheWrite: 21_500 });
	const text = formatUsageSummary(scope, 41_000, main);
	assert.match(text, /backend-worker: .*; cache hit 27% - WARNING: wrote more to the cache than it read/);
	assert.match(text, /\nMain cache: 2 requests on this branch; input 22 \| cacheRead 20,000 \| cacheWrite 21,500; cache hit 48%$/, "two requests: no warning yet");
	assert.equal(mainCacheTotals({}), null, "no session: no line");
	assert.doesNotMatch(formatUsageSummary(scope, 41_000, null), /Main cache/);
});
