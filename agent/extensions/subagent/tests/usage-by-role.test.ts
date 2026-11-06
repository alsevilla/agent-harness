import assert from "node:assert/strict";
import test from "node:test";
import { formatUsageSummary, LogicalUsage, mainContextTokens, newUsageScope, type UsageScope } from "../background.ts";

type Status = "completed" | "failed" | "aborted";

// One logical job with one attempt and one priced turn, settled once (producer-shaped usage: finalized turn fields).
function run(scope: UsageScope, role: string | undefined, background: boolean, input: number, output: number, cost: number, status: Status = "completed") {
	const job = new LogicalUsage(scope, background, role);
	job.attempt();
	job.turn({ input, output, cacheRead: 0, cacheWrite: 0, cost: { total: cost } });
	job.settle(status);
}

test("named roles aggregate foreground and background; each job settles once per role", () => {
	const scope = newUsageScope();
	run(scope, "backend", false, 100, 20, 0.5);
	run(scope, "backend", true, 50, 10, 0.25, "failed");
	run(scope, "reviewer", false, 30, 5, 0.1);
	const roles = scope.roles ?? {};
	assert.deepEqual(Object.keys(roles).sort(), ["backend", "reviewer"]);
	assert.equal(roles.backend.input, 150);
	assert.equal(roles.backend.completed, 1);
	assert.equal(roles.backend.failed, 1);
	assert.equal(roles.reviewer.output, 5);
	for (const key of ["attempts", "turns", "input", "output"] as const) {
		const roleSum = Object.values(roles).reduce((sum, slice) => sum + slice[key], 0);
		assert.equal(roleSum, scope.foreground[key] + scope.background[key], key);
	}
	// A job settles once: a second settle on the same job adds nothing (one new job = +1 completed).
	const again = new LogicalUsage(scope, false, "backend");
	again.settle("completed");
	again.settle("completed");
	assert.equal(scope.roles?.backend.completed, 2);
});

test("role summary lists tokens-descending roles and leaves unnamed jobs out of roles", () => {
	const scope = newUsageScope();
	run(scope, "reviewer", false, 10, 1, 0.01);
	run(scope, "backend", false, 500, 50, 0.5);
	run(scope, undefined, false, 7, 7, 0.07);
	assert.equal(Object.keys(scope.roles ?? {}).length, 2);
	assert.equal(scope.foreground.input, 517);
	const text = formatUsageSummary(scope);
	assert.ok(text.indexOf("  backend:") > 0 && text.indexOf("  backend:") < text.indexOf("  reviewer:"));
	assert.match(text, /By role \(foreground \+ background, most tokens first\):/);
	assert.ok(text.includes("  backend: 1 task, 1 attempt, 1 turn; input 500 | output 50 | cacheRead 0 | cacheWrite 0; cost $0.5000 SDK-estimated"));
});

test("cache tokens and unpriced turns aggregate per role; aborted jobs count", () => {
	const scope = newUsageScope();
	const job = new LogicalUsage(scope, false, "tuner");
	job.attempt();
	job.turn({ input: 10, output: 2, cacheRead: 40, cacheWrite: 8, cost: undefined });
	job.settle("aborted");
	const slice = scope.roles?.tuner;
	assert.equal(slice?.cacheRead, 40);
	assert.equal(slice?.cacheWrite, 8);
	assert.equal(slice?.unpricedTurns, 1);
	assert.equal(slice?.aborted, 1);
	assert.ok(formatUsageSummary(scope).includes("  tuner: 1 task, 1 attempt, 1 turn; input 10 | output 2 | cacheRead 40 | cacheWrite 8; cost not reported (no turn priced)"));
});

test("equal token totals tie-break by name; an empty role name is not listed", () => {
	const scope = newUsageScope();
	run(scope, "zeta", false, 5, 5, 0.1);
	run(scope, "alpha", false, 5, 5, 0.1);
	run(scope, "", false, 9, 9, 0.1);
	assert.deepEqual(Object.keys(scope.roles ?? {}).sort(), ["alpha", "zeta"]);
	const text = formatUsageSummary(scope);
	assert.ok(text.indexOf("  alpha:") < text.indexOf("  zeta:"));
	assert.equal(scope.foreground.input, 19);
});

test("reserved role names stay own data and never write a prototype", () => {
	const scope = newUsageScope();
	run(scope, "__proto__", false, 1, 1, 0);
	run(scope, "constructor", false, 2, 2, 0);
	assert.equal(Object.getPrototypeOf(scope.roles), Object.prototype);
	assert.equal(({} as Record<string, unknown>).input, undefined);
	assert.equal(scope.roles?.["__proto__"]?.input, 1);
	assert.equal(scope.roles?.constructor.input, 2);
	assert.ok(formatUsageSummary(scope).includes("  __proto__: 1 task"));
});

test("a job settles into its launch scope after reset and charges no other scope", () => {
	const launch = newUsageScope();
	const job = new LogicalUsage(launch, false, "reviewer");
	job.attempt();
	job.turn({ input: 3, output: 1, cacheRead: 0, cacheWrite: 0, cost: { total: 0.01 } });
	const afterReset = newUsageScope();
	job.settle("completed");
	assert.equal(launch.roles?.reviewer.completed, 1);
	assert.equal(afterReset.roles && Object.keys(afterReset.roles).length, 0);
});

test("a scope without named roles shows no By role section", () => {
	assert.equal(formatUsageSummary(newUsageScope()).includes("By role"), false);
});

test("main context line: the SDK estimate is shown when available, unknown otherwise, and never invented as 0", () => {
	assert.equal(mainContextTokens({ getContextUsage: () => ({ tokens: 48210.4 }) }), 48210);
	for (const ctx of [{}, { getContextUsage: () => undefined }, { getContextUsage: () => ({ tokens: null }) }, { getContextUsage: () => ({ tokens: "500" }) }, { getContextUsage: () => ({ tokens: -1 }) }, { getContextUsage: () => { throw new Error("no session"); } }]) {
		assert.equal(mainContextTokens(ctx as never), null);
	}
	const scope = newUsageScope();
	assert.ok(formatUsageSummary(scope, 48210).endsWith("\nMain context: ~48,210 tokens (SDK estimate)"));
	assert.ok(formatUsageSummary(scope, null).endsWith("\nMain context: unknown"));
	run(scope, "backend", false, 100, 20, 0.5);
	assert.ok(formatUsageSummary(scope, 900).endsWith("\nMain context: ~900 tokens (SDK estimate)"), "shown after the role breakdown");
	assert.equal(formatUsageSummary(scope).includes("Main context"), false, "callers without a reading keep the old text");
});

test("cost per completed task counts failed and aborted cost against completed tasks only", () => {
	const scope = newUsageScope();
	run(scope, "backend", false, 100, 10, 0.3);
	run(scope, "backend", false, 100, 10, 0.1, "failed");
	run(scope, "debugger", false, 100, 10, 0.2, "aborted");
	const text = formatUsageSummary(scope);
	assert.match(text, /backend: 2 tasks[^\n]*\$0\.4000 SDK-estimated; \$0\.4000 per completed task/, "0.3 + 0.1 over 1 completed");
	assert.doesNotMatch(text.split("\n").find((l) => l.includes("debugger:")) ?? "", /per completed task/, "no completed task: no ratio");
	assert.match(text, /Foreground:[\s\S]*cost: \$0\.6000 SDK-estimated; \$0\.6000 per completed task/);
});

// The footer was removed (the owner reads /subagent usage); its "consider /new" hint moved to the Main context line.
test("usage: the Main context line suggests /new from 100k; below it, no hint", () => {
	assert.match(formatUsageSummary(newUsageScope(), 99_999), /Main context: ~99,999 tokens \(SDK estimate\)$/);
	assert.match(formatUsageSummary(newUsageScope(), 131_957), /Main context: ~131,957 tokens \(SDK estimate\); consider \/new once nothing is running \(\/reload keeps this history\)$/);
	assert.match(formatUsageSummary(newUsageScope(), null), /Main context: unknown$/);
});

// Measuring worker masking: the providers' own per-request input (input + cacheRead + cacheWrite), peak and count over 100k, per role.
test("usage: each role shows its peak request and how many requests were over 100k; slices are unchanged", () => {
	const scope = newUsageScope();
	const job = new LogicalUsage(scope, true, "debugger");
	job.attempt();
	job.turn({ input: 10, output: 5, cacheRead: 60_000, cacheWrite: 1_000, cost: { total: 0.01 } });
	job.turn({ input: 10, output: 5, cacheRead: 104_000, cacheWrite: 3_000, cost: { total: 0.05 } });
	job.turn({ input: 10, output: 5, cacheRead: 110_000, cacheWrite: 500, cost: { total: 0.05 } });
	job.settle("completed");
	const other = new LogicalUsage(scope, true, "scout");
	other.attempt(); other.turn({ input: 5, output: 1, cacheRead: 9_000, cacheWrite: 100, cost: { total: 0.001 } }); other.settle("completed");
	const text = formatUsageSummary(scope);
	assert.match(text, /debugger: [^\n]*per completed task; cache hit 98%; peak request 110,510 tok, 2 requests over 100,000/);
	assert.match(text, /scout: [^\n]*per completed task; cache hit \d+%; peak request 9,105 tok$/m, "no over-100k note when none was");
	assert.equal("peakRequest" in scope.background, false, "slices keep their shape");
});
