// Phase 1 usage telemetry: task ledger aggregation, percentiles, view parsing, planner consultations and LogicalUsage settlement.
import assert from "node:assert/strict";
import test from "node:test";
import { LogicalUsage, newUsageScope } from "../background.ts";
import {
	applyAdvice,
	formatByRole,
	formatPlanner,
	formatTop,
	openConsultation,
	parseConsultationMeta,
	parseUsageArgs,
	percentile,
	plannerReport,
	summarizeByRole,
	topTasks,
	type TaskUsageRecord,
} from "../usage-telemetry.ts";

function task(over: Partial<TaskUsageRecord> & { id: string; role: string }): TaskUsageRecord {
	return {
		background: false,
		status: "completed",
		attempts: 1,
		turns: 1,
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		cost: 0,
		unpricedTurns: 0,
		firstTurnPromptTokens: null,
		peakPromptTokens: null,
		...over,
	};
}

test("percentile uses nearest-rank over finite values; empty input has no value", () => {
	assert.equal(percentile([], 50), undefined);
	assert.equal(percentile([7], 50), 7);
	assert.equal(percentile([7], 95), 7);
	const twenty = Array.from({ length: 20 }, (_, i) => 20 - i); // unsorted 20..1
	assert.equal(percentile(twenty, 50), 10);
	assert.equal(percentile(twenty, 95), 19);
	assert.equal(percentile([Number.NaN, 3, Number.POSITIVE_INFINITY], 50), 3);
	assert.equal(percentile([Number.NaN], 50), undefined);
	assert.throws(() => percentile([1], 0), /percentile/);
	assert.throws(() => percentile([1], 101), /percentile/);
});

test("parseUsageArgs: one view per call, strict N, useful errors", () => {
	assert.deepEqual(parseUsageArgs(""), { kind: "summary" });
	assert.deepEqual(parseUsageArgs("  "), { kind: "summary" });
	assert.deepEqual(parseUsageArgs("--by-role"), { kind: "by-role" });
	assert.deepEqual(parseUsageArgs("--main"), { kind: "main" });
	assert.deepEqual(parseUsageArgs("--planner"), { kind: "planner" });
	assert.deepEqual(parseUsageArgs("--top 5"), { kind: "top", n: 5 });
	assert.throws(() => parseUsageArgs("--top"), /--top needs a positive whole number/);
	for (const bad of ["0", "-2", "1.5", "abc", "3x"]) assert.throws(() => parseUsageArgs(`--top ${bad}`), /--top needs a positive whole number/, bad);
	assert.throws(() => parseUsageArgs("--top 2 extra"), /one usage view/);
	assert.throws(() => parseUsageArgs("--by-role --main"), /one usage view/);
	assert.throws(() => parseUsageArgs("--top 3 --main"), /one usage view/);
	assert.throws(() => parseUsageArgs("--bogus"), /Unknown usage option "--bogus"/);
});

test("empty ledgers render an explicit empty notice and never invent rows", () => {
	assert.deepEqual(summarizeByRole([]), []);
	assert.match(formatByRole([]), /No settled agent tasks yet this run/);
	assert.match(formatTop([], 3), /No settled agent tasks yet this run/);
	assert.match(formatPlanner({ tasks: [], consultations: [] }), /No planner consultations recorded this run/);
});

test("by-role totals, averages and p50/p95 include zero-turn tasks and exclude missing peaks", () => {
	const tasks = [
		task({ id: "t-1", role: "backend-worker", turns: 1, output: 10, cost: 0.1, peakPromptTokens: null }),
		task({ id: "t-2", role: "backend-worker", turns: 2, output: 20, cost: 0.2, peakPromptTokens: 50 }),
		task({ id: "t-3", role: "backend-worker", turns: 10, output: 30, cost: 0.3, peakPromptTokens: 70, status: "failed" }),
		task({ id: "t-4", role: "frontend-worker", turns: 0, status: "aborted" }),
	];
	const rows = summarizeByRole(tasks);
	assert.deepEqual(rows.map((r) => r.role), ["backend-worker", "frontend-worker"]);
	const be = rows[0];
	assert.equal(be.settled, 3);
	assert.deepEqual([be.completed, be.failed, be.aborted], [2, 1, 0]);
	assert.equal(be.turns, 13);
	assert.equal(be.turnsP50, 2);
	assert.equal(be.turnsP95, 10);
	assert.equal(be.peakP50, 50);
	assert.equal(be.peakP95, 70);
	assert.equal(be.peakCount, 2);
	assert.equal(be.outputPerTurn, 60 / 13);
	assert.ok(Math.abs((be.avgCost ?? 0) - 0.2) < 1e-12);
	const fe = rows[1];
	assert.equal(fe.turnsP50, 0);
	assert.equal(fe.peakP50, undefined, "no peak values is n/a, not zero");
	assert.equal(fe.avgCost, undefined, "no priced task is n/a");
	const text = formatByRole(tasks);
	assert.match(text, /backend-worker: 3 settled \(2 completed, 1 failed, 0 aborted\)/);
	assert.match(text, /peak prompt p50 50 p95 70 \(2 with usage\)/);
	assert.match(text, /frontend-worker: 1 settled .*peak prompt n\/a/);
});

test("top N ranks by cost with unknown cost last, ties by sequence, and keeps stable IDs", () => {
	const tasks = [
		task({ id: "t-1", role: "a", cost: 0.5 }),
		task({ id: "t-2", role: "b", cost: 0, turns: 0 }),
		task({ id: "t-3", role: "c", cost: 0.9 }),
		task({ id: "t-4", role: "d", cost: 0.5 }),
		task({ id: "t-5", role: "e", cost: 0.2, unpricedTurns: 1 }),
	];
	assert.deepEqual(topTasks(tasks, 3).map((t) => t.id), ["t-3", "t-1", "t-4"]);
	assert.deepEqual(topTasks(tasks, 99).map((t) => t.id), ["t-3", "t-1", "t-4", "t-2", "t-5"], "unknown-cost tasks keep sequence order after every priced task");
	assert.equal(tasks[0].id, "t-1", "input array is not reordered");
	const text = formatTop(tasks, 2);
	const rows = text.split("\n").filter((l) => /^\d+\. t-\d+/.exec(l));
	assert.equal(rows.length, 2);
	assert.match(text, /^1\. t-3 /m);
	assert.match(text, /completed/);
});

test("planner report: consultations group by explicit task only; unassigned is not a task; advice outcomes", () => {
	const scope = newUsageScope();
	const first = openConsultation(scope, { trigger: "t3", taskId: "phase-1" });
	const second = openConsultation(scope, { trigger: "debugger-unresolved" });
	const third = openConsultation(scope, { trigger: "t4", taskId: "phase-1" });
	assert.match(first, /^cons-\d+$/);
	assert.notEqual(first, second);
	assert.equal(scope.consultations.length, 3);
	applyAdvice(scope.consultations, first, "accepted");
	applyAdvice(scope.consultations, third, "rejected");
	applyAdvice(scope.consultations, third, "accepted"); // last write wins
	assert.throws(() => applyAdvice(scope.consultations, "cons-999999", "accepted"), /Unknown consultation cons-999999/);
	assert.throws(() => applyAdvice(scope.consultations, first, "maybe" as never), /advice must be accepted or rejected/);
	scope.tasks.push(task({ id: "t-9", role: "planner", turns: 2, input: 100, output: 20, cacheRead: 5, cacheWrite: 0, cost: 0.04, consultationId: first }));
	const report = plannerReport(scope);
	assert.equal(report.total, 3);
	assert.equal(report.unassigned, 1, "no taskId means unassigned, never a fake top-level task");
	assert.deepEqual(report.tasks.map((t) => [t.taskId, t.count]), [["phase-1", 2]]);
	assert.equal(report.accepted, 2);
	assert.equal(report.rejected, 0);
	assert.equal(report.unknown, 1);
	assert.equal(report.pending, 2, "consultations without a settled planner task are pending, not failed");
	const text = formatPlanner(scope);
	assert.match(text, /phase-1: 2 consultations/);
	assert.match(text, /unassigned: 1/);
	assert.match(text, new RegExp(`${first} · trigger t3 · task phase-1 · advice accepted · settled · 125 tokens · \\$0\\.0400`));
});

test("LogicalUsage settles once and aggregates every attempt; first-turn and peak prompt exclude output", () => {
	const scope = newUsageScope();
	const u = new LogicalUsage(scope, false, { role: "backend-worker", tier: "capable" });
	u.attempt(); u.attempt();
	u.turn({ input: 2, output: 99, cacheRead: 1, cacheWrite: 0, cost: { total: 0.1 } }); // first turn prompt 3, output 99 excluded
	u.turn({ input: 4, output: 5, cacheRead: 0, cacheWrite: 0, cost: { total: 0.2 } }); // prompt 4
	u.turn({ input: 1, output: 1, cacheRead: 10, cacheWrite: 2, cost: { total: 0.3 } }); // prompt 13
	u.settle("completed", { requestedModel: "p/primary", model: "p/served", modelSource: "observed", attempts: [{ requestedModel: "p/primary", observed: [] }, { requestedModel: "p/luna", observed: [] }] });
	u.settle("failed"); // second settle is ignored
	assert.equal(scope.foreground.completed, 1);
	assert.equal(scope.foreground.failed, 0);
	assert.equal(scope.tasks.length, 1);
	const record = scope.tasks[0];
	assert.equal(record.role, "backend-worker");
	assert.equal(record.tier, "capable");
	assert.equal(record.attempts, 2);
	assert.equal(record.turns, 3);
	assert.equal(record.input, 7);
	assert.equal(record.output, 105);
	assert.equal(record.firstTurnPromptTokens, 3);
	assert.equal(record.peakPromptTokens, 13);
	assert.equal(record.configuredModel, "p/primary");
	assert.equal(record.observedModel, "p/served");
	assert.equal(record.status, "completed");
	assert.ok(Math.abs(record.cost - 0.6) < 1e-12);
	assert.equal(scope.foreground.turns, 3, "slice totals unchanged by the ledger");
});

test("LogicalUsage: malformed or missing usage is unreported, never invented; observed model only when observed", () => {
	const scope = newUsageScope();
	const u = new LogicalUsage(scope, true, { role: "x" });
	u.turn(undefined); // no usage: first turn unreported
	u.turn({ input: "abc", output: Number.NaN, cacheRead: 3, cacheWrite: 0, cost: { total: Number.NaN } });
	u.settle("aborted", { requestedModel: "p/a", model: "p/a", modelSource: "requested", attempts: [] });
	const record = scope.tasks[0];
	assert.equal(record.firstTurnPromptTokens, null);
	assert.equal(record.peakPromptTokens, null, "a turn whose input count is not a number has no reported prompt");
	assert.equal(record.unpricedTurns, 2);
	assert.equal(record.cost, 0);
	assert.equal(record.observedModel, undefined);
	assert.equal(record.configuredModel, "p/a");
	assert.equal(record.background, true);
	assert.equal(scope.background.aborted, 1);
});

test("settled task IDs are unique and increase across scopes; a task charges only its launch scope", () => {
	const first = newUsageScope();
	const second = newUsageScope();
	const a = new LogicalUsage(first, false, { role: "a" });
	const b = new LogicalUsage(second, false, { role: "b" });
	a.settle("completed");
	b.settle("completed");
	const n = (id: string) => Number(id.slice(2));
	assert.match(first.tasks[0].id, /^t-\d+$/);
	assert.ok(n(second.tasks[0].id) > n(first.tasks[0].id));
	assert.equal(first.tasks.length, 1);
	assert.equal(second.tasks.length, 1);
});

test("consultation metadata is explicit, strict and optional: trigger required, taskId optional, nothing inferred", () => {
	assert.deepEqual(parseConsultationMeta({ trigger: "t3" }), { trigger: "t3" });
	assert.deepEqual(parseConsultationMeta({ trigger: "debugger-unresolved", taskId: "phase-1" }), { trigger: "debugger-unresolved", taskId: "phase-1" });
	assert.throws(() => parseConsultationMeta(null), /consultation must be an object/);
	assert.throws(() => parseConsultationMeta({}), /consultation\.trigger is required/);
	assert.throws(() => parseConsultationMeta({ trigger: "" }), /consultation\.trigger/);
	assert.throws(() => parseConsultationMeta({ trigger: "has space" }), /consultation\.trigger/);
	assert.throws(() => parseConsultationMeta({ trigger: "x".repeat(65) }), /consultation\.trigger/);
	assert.throws(() => parseConsultationMeta({ trigger: "t3", taskId: 7 }), /consultation\.taskId/);
	assert.throws(() => parseConsultationMeta({ trigger: "t3", extra: true }), /unknown consultation key "extra"/);
});
