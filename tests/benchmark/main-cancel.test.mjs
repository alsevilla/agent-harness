// H9 label: a SUCCESSFUL main-issued cancel of its own started job is not infrastructure/launch_failed (offline fake adapter, no Pi, no provider).
// The label correction never makes such a run valid: the writer never ran, so the task is methodinvalid and the run still stops.
import assert from "node:assert/strict";
import test from "node:test";
import { pathToFileURL } from "node:url";
import path from "node:path";
import { runBenchmark } from "./lib/runner.mjs";
import { normalise } from "./lib/sdk-adapter.mjs";
import { assistant, u, task, manifest, root, fakeWorkspace, gate, fakeAdapter, fixtureConfig, writerLaunch } from "./fixtures/fake-runtime.mjs";
import fs from "node:fs";

// The ACTUAL native serializer and the ACTUAL adapter normaliser sit between the child result and the runner (no hand-built runner events).
const base = pathToFileURL(path.resolve(import.meta.dirname, "../..") + "/").href;
const { completionResults } = await import(base + "agent/extensions/subagent/background.ts");
const ROLES = new Set(["security-specialist", "general-worker", "debugger"]);
const CTX = { session: "sess-A", roles: ROLES };

const usage = { input: 16, output: 4464, cacheRead: 95390, cacheWrite: 36741, cost: 0.00778, turns: 6, contextTokens: 4 };
// A native SingleResult of an abort-killed child: the legacy diagnostic is ALWAYS non-empty (never proof of an error); abort is the producer's attestation.
const abortedChild = (over = {}) => ({ agent: "security-specialist", exitCode: 1, stopReason: "aborted", errorMessage: "Subagent was stopped", usage: { ...usage }, abort: { running: true, priorFailure: false }, ...over });
const failedChild = (over = {}) => abortedChild({ abort: { running: true, priorFailure: true }, ...over });
const receipt = (jobId = "bg-1") => ({ type: "subagent", toolCallId: `c-${jobId}`, isError: false, text: `Started background job ${jobId}.`, details: { mode: "single", results: [], jobId, background: true } });
const cancel = (target = "bg-1", over = {}) => ({ type: "tool", name: "subagent_control", isError: false, control: { action: "cancel", target }, ...over });
const done = (results, state = "aborted", jobId = "bg-1") => normalise({ type: "message_end", message: { role: "custom", customType: "subagent-completion", content: "x", details: { jobId, state, results: completionResults({ details: { results } }) } } }, CTX);
const go = (events) => runBenchmark({ manifest: manifest([task("H1")]), mode: "fresh", adapter: fakeAdapter({ mainScript: () => ({ events: [...events, assistant(u(1, 1))], text: "Confirmed stopped." }) }), workspace: fakeWorkspace(root()), acceptance: gate, config: fixtureConfig() });

test("H9 shape: main cancels its own started job -> methodinvalid missing_delegation, not launch_failed; usage stays unknown, run still stops", async () => {
	const r = await go([receipt(), cancel(), done([abortedChild()])]);
	const t = r.tasks[0];
	assert.equal(t.status, "method_invalid");
	assert.equal(t.invalid.kind, "missing_delegation");
	assert.deepEqual(t.delegation.launches.map((l) => [l.agent, l.status]), [["security-specialist", "cancelled-by-main"]]);
	assert.equal(t.delegation.writerLaunches, 0);
	assert.equal(t.worker.cost.total, null, "an aborted stream's in-flight usage is unknown, never zero");
	assert.equal(t.worker.cost.knownPricedSubtotal, 0.00778);
	assert.ok(t.worker.cost.unresolved.some((x) => x.reason === "aborted_in_flight_usage_unknown"));
	assert.equal(r.status, "invalid");
	assert.equal(r.invalid.kind, "missing_delegation");
	assert.equal(t.accepted, false);
});

test("a cancelled expected writer is never counted as a measured writer launch", async () => {
	const r = await go([receipt(), cancel(), done([abortedChild({ agent: "general-worker" })])]);
	assert.equal(r.tasks[0].invalid.kind, "missing_delegation");
	assert.equal(r.tasks[0].delegation.writerLaunches, 0);
});

const stillLaunchFailed = [
	["an abort with no main cancel (runner or deadline abort)", () => [receipt(), done([abortedChild()])]],
	["a cancel issued AFTER the aborted completion", () => [receipt(), done([abortedChild()]), cancel()]],
	["a cancel call that errored", () => [receipt(), cancel("bg-1", { isError: true }), done([abortedChild()])]],
	["a cancel of a different job", () => [receipt(), cancel("bg-2"), done([abortedChild()])]],
	["a cancel with no safe target", () => [receipt(), { type: "tool", name: "subagent_control", isError: false, control: { action: "cancel" } }, done([abortedChild()])]],
	["a steer (not a cancel) of that job", () => [receipt(), { type: "tool", name: "subagent_control", isError: false, control: { action: "steer", target: "bg-1" } }, done([abortedChild()])]],
	["a cancel with no receipt for the job", () => [cancel(), done([abortedChild()])]],
	["a genuinely failed job state after a cancel", () => [receipt(), cancel(), done([abortedChild()], "failed")]],
	["a cancel issued BEFORE the job's receipt", () => [cancel(), receipt(), done([abortedChild()])]],
	["an errored child (stop reason error) after a cancel", () => [receipt(), cancel(), done([abortedChild({ stopReason: "error" })])]],
	["an abort whose child failed BEFORE the kill (priorFailure true, error text)", () => [receipt(), cancel(), done([failedChild({ errorMessage: "TEST_ONLY_GENUINE_FAILURE", isError: true })])]],
	["an abort whose child was not running at the kill (running false)", () => [receipt(), cancel(), done([abortedChild({ abort: { running: false, priorFailure: false } })])]],
	["a legacy child with NO abort provenance after a successful cancel", () => [receipt(), cancel(), done([abortedChild({ abort: undefined })])]],
	["abort with one flag missing", () => [receipt(), cancel(), done([abortedChild({ abort: { running: true } })])]],
	["abort with string flags", () => [receipt(), cancel(), done([abortedChild({ abort: { running: "true", priorFailure: "false" } })])]],
	["abort with numeric flags", () => [receipt(), cancel(), done([abortedChild({ abort: { running: 1, priorFailure: 0 } })])]],
	["abort as an array / string / true", () => [receipt(), cancel(), done([abortedChild({ abort: [true, false] }), abortedChild({ abort: "clean" }), abortedChild({ abort: true })])]],
	["a non-abort exit code after a cancel", () => [receipt(), cancel(), done([abortedChild({ exitCode: 2 })])]],
	["a child that never started (zero turns) after a cancel", () => [receipt(), cancel(), done([abortedChild({ usage: { ...usage, turns: 0 } })])]],
];
for (const [name, events] of stillLaunchFailed) {
	test(`control: ${name} stays infrastructure/launch_failed`, async () => {
		const r = await go(events());
		assert.equal(r.tasks[0].status, "infrastructure");
		assert.equal(r.tasks[0].invalid.kind, "launch_failed");
	});
}

test("control: another job's cancel does not exempt this job, even when a second job was cancelled successfully", async () => {
	const r = await go([receipt("bg-1"), receipt("bg-2"), cancel("bg-2"), done([abortedChild()], "aborted", "bg-1"), done([abortedChild({ agent: "debugger" })], "aborted", "bg-2")]);
	assert.equal(r.tasks[0].status, "infrastructure");
	assert.equal(r.tasks[0].invalid.kind, "launch_failed");
	assert.equal(r.tasks[0].invalid.agent, "security-specialist");
});

// A scripted multi-round main: round i runs scripts[i]; a writer round that leaves the gate red triggers a rework prompt.
const goRounds = (scripts) => runBenchmark({ manifest: manifest([task("H1")]), mode: "fresh", adapter: fakeAdapter({ mainScript: (s) => ({ events: [...(typeof scripts[Math.min(s.calls - 1, scripts.length - 1)] === "function" ? scripts[Math.min(s.calls - 1, scripts.length - 1)](s) : scripts[Math.min(s.calls - 1, scripts.length - 1)]), assistant(u(1, 1))], text: "ok" }) }), workspace: fakeWorkspace(root()), acceptance: gate, config: fixtureConfig() });

test("an EARLIER completed writer never rescues a later failure that happened before the cancel (same round and earlier round)", async () => {
	const bad = [receipt(), cancel(), done([failedChild({ errorMessage: "TEST_ONLY_GENUINE_FAILURE" })])];
	const same = await goRounds([[writerLaunch(), ...bad]]);
	assert.equal(same.tasks[0].status, "infrastructure");
	assert.equal(same.tasks[0].invalid.kind, "launch_failed");
	const earlier = await goRounds([[writerLaunch()], bad]);
	assert.equal(earlier.tasks[0].status, "infrastructure");
	assert.equal(earlier.tasks[0].invalid.kind, "launch_failed");
	const legacy = await goRounds([[writerLaunch(), receipt(), cancel(), done([abortedChild({ abort: undefined })])]]);
	assert.equal(legacy.tasks[0].invalid.kind, "launch_failed");
});

test("a producer-attested clean cancel of a helper keeps the cumulative writer proof (not a failure)", async () => {
	const r = await goRounds([[writerLaunch()], (s) => { fs.writeFileSync(path.join(s.cwd, "agent/work.txt"), "fixed"); return [receipt(), cancel(), done([abortedChild({ agent: "debugger" })])]; }]);
	assert.equal(r.tasks[0].status, "completed");
	assert.equal(r.tasks[0].accepted, true);
	assert.deepEqual(r.tasks[0].delegation.launches.map((l) => l.status), ["measured", "cancelled-by-main"]);
});

test("only the two strict booleans cross the serializers: extra keys and error bodies are never carried (completion, audit, control result, foreground)", () => {
	const MARK = "TEST_ONLY_RAW_ERROR_BODY";
	const child = abortedChild({ abort: { running: true, priorFailure: false, rawError: MARK, body: { x: MARK } }, errorMessage: MARK, isError: true });
	const wire = completionResults({ details: { results: [child] } });
	assert.deepEqual(wire[0].abort, { running: true, priorFailure: false });
	assert.equal(JSON.stringify(wire).includes(MARK), false);
	const c = done([child]);
	const audit = normalise({ type: "entry_appended", entry: { type: "custom", customType: "subagent-terminal-audit", data: { v: 1, jobId: "bg-1", ownerSession: "sess-A", state: "aborted", results: wire } } }, CTX);
	const ctl = normalise({ type: "tool_execution_end", toolName: "subagent_control", isError: false, result: { details: { control: { action: "result", target: "bg-1" }, results: [child, ...wire] } } }, CTX);
	const fg = normalise({ type: "tool_execution_end", toolName: "subagent", isError: false, result: { details: { mode: "single", results: [child] } } }, CTX);
	for (const [name, list] of [["completion", c.results], ["audit", audit.results], ["control", ctl.controlResults], ["foreground", fg.details.results]]) {
		assert.deepEqual(list[0].abort, { running: true, priorFailure: false }, name);
	}
	for (const x of [c, audit, ctl]) assert.equal(JSON.stringify(x).includes(MARK), false);
	for (const bad of [undefined, null, [true, false], "x", true, { running: true }, { priorFailure: false }, { running: "true", priorFailure: "false" }, { running: 1, priorFailure: 0 }]) {
		assert.equal(completionResults({ details: { results: [abortedChild({ abort: bad })] } })[0].abort, undefined);
		assert.equal(done([abortedChild({ abort: bad })]).results[0].abort, undefined);
	}
	// A pre-serialized hostile wire value is also reduced to the two booleans (or dropped), never passed through.
	const hostile = normalise({ type: "message_end", message: { role: "custom", customType: "subagent-completion", content: "x", details: { jobId: "bg-1", state: "aborted", results: [{ agent: "debugger", usage: { turns: 1 }, abort: { running: true, priorFailure: false, rawError: MARK } }, { agent: "debugger", abort: Object.create({ running: true, priorFailure: false }) }, { agent: "debugger", abort: { running: true, priorFailure: false, __proto__: { x: 1 } } }] } } }, CTX);
	assert.deepEqual(hostile.results[0].abort, { running: true, priorFailure: false });
	assert.equal(hostile.results[1].abort, undefined);
	assert.equal(JSON.stringify(hostile).includes(MARK), false);
});

// Cancel ACK boundary: the ACTUAL normaliser sees the raw source outcome. Only a source isError of exactly false attests success; true stays a failure; anything else is unknown.
const rawCancel = (ack, target = "bg-1") => normalise({ type: "tool_execution_end", toolName: "subagent_control", toolCallId: "k1", ...(ack === "missing" ? {} : { isError: ack }), result: { content: [{ type: "text", text: "ok" }], details: { control: { action: "cancel", target } } } }, CTX);
const rawReceipt = (jobId = "bg-1") => normalise({ type: "tool_execution_end", toolName: "subagent", toolCallId: `c-${jobId}`, isError: false, result: { content: [{ type: "text", text: `Started background job ${jobId}.` }], details: { mode: "single", results: [], jobId, background: true } } }, CTX);
const withEarlierWriter = (tail) => goRounds([[writerLaunch()], (s) => { fs.writeFileSync(path.join(s.cwd, "agent/work.txt"), "fixed"); return tail(); }]);
const MARKER = "TEST_ONLY_MALFORMED_ACK";
const UNKNOWN_ACKS = ["missing", null, "false", "true", "", 0, 1, NaN, {}, [], [false], { toString: () => "false" }, new Boolean(false), new Boolean(true), { [MARKER]: true }, MARKER];

test("cancel ACK: explicit source false stays success; explicit true stays failure", async () => {
	assert.equal(rawCancel(false).isError, false);
	assert.equal(rawCancel(true).isError, true);
	const ok = await withEarlierWriter(() => [rawReceipt(), rawCancel(false), done([abortedChild({ agent: "debugger" })])]);
	assert.equal(ok.tasks[0].status, "completed");
	assert.equal(ok.tasks[0].accepted, true);
	const none = await go([rawReceipt(), rawCancel(false), done([abortedChild()])]);
	assert.equal(none.tasks[0].invalid.kind, "missing_delegation");
	assert.equal(none.tasks[0].worker.cost.total, null);
	for (const run of [await withEarlierWriter(() => [rawReceipt(), rawCancel(true), done([abortedChild({ agent: "debugger" })])]), await go([rawReceipt(), rawCancel(true), done([abortedChild()])])]) {
		assert.equal(run.tasks[0].status, "infrastructure");
		assert.equal(run.tasks[0].invalid.kind, "launch_failed");
		assert.equal(run.tasks[0].accepted, false);
	}
});

test("cancel ACK: missing/malformed source outcomes normalise to unknown (null), never false, never carry the raw value, and fail closed through the runner", async () => {
	for (const ack of UNKNOWN_ACKS) {
		const ev = rawCancel(ack);
		assert.equal(ev.isError, null, `normalised outcome of ${String(typeof ack === "object" ? JSON.stringify(ack) : ack)}`);
		assert.equal(ev.errorText, null);
		assert.equal(JSON.stringify(ev).includes(MARKER), false);
		for (const run of [await withEarlierWriter(() => [rawReceipt(), rawCancel(ack), done([abortedChild({ agent: "debugger" })])]), await go([rawReceipt(), rawCancel(ack), done([abortedChild()])])]) {
			const t = run.tasks[0];
			assert.equal(t.status, "infrastructure");
			assert.equal(t.invalid.kind, "launch_failed");
			assert.equal(t.accepted, false);
			assert.equal(JSON.stringify(run).includes(MARKER), false);
		}
	}
});

test("cancel ACK: explicit false still needs the receipt before the cancel and the cancel before the completion", async () => {
	for (const events of [[rawCancel(false), rawReceipt(), done([abortedChild()])], [rawReceipt(), done([abortedChild()]), rawCancel(false)]]) {
		const r = await go(events);
		assert.equal(r.tasks[0].invalid.kind, "launch_failed");
	}
});
