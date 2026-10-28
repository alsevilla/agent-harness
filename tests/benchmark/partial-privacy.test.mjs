// Fix round 2: interrupted-round telemetry is an allowlist projection; no child/native free-form text is persisted. Real sdk-adapter over a fake SDK (SDK 1.4 event shapes).
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createPiSdkAdapter } from "./lib/sdk-adapter.mjs";
import { runBenchmark } from "./lib/runner.mjs";
import { createWorkspace } from "./lib/workspace.mjs";
import * as fx from "./fixtures/fake-runtime.mjs";
import { okTopology } from "./fixtures/topology-fixture.mjs";

const S = "PRIVATE_FIX2_SENTINEL";
const cand = fs.mkdtempSync(path.join(os.tmpdir(), "pp-cand-"));
fs.mkdirSync(path.join(cand, "agent", "agents"), { recursive: true });
for (const n of ["general-worker", "debugger"]) fs.writeFileSync(path.join(cand, "agent", "agents", n + ".md"), `---\nname: ${n}\ndescription: f\n---\n`);
const RUNTIME = { root: cand, extensions: [path.join(cand, "agent/extensions/subagent/index.ts")], fingerprint: "fx" };

function fakeSdk(calls) {
	const session = {
		listeners: [], subscribe(l) { this.listeners.push(l); return () => {}; }, emit(ev) { for (const l of this.listeners) l(ev); },
		async prompt() { return calls.script(this); },
		getLastAssistantText: () => "", abortCompaction() {}, async compact() {}, getContextUsage: () => ({ tokens: 5, contextWindow: 1000, percent: 0.5 }),
		systemPrompt: "abc", async bindExtensions() {}, async waitForIdle() {}, async abort() {}, async emitShutdown() {},
		getActiveToolNames() { return this.active; }, messages: [], sessionManager: { getSessionId: () => "sess-1", getEntries: () => [] }, dispose() {},
	};
	return {
		SessionManager: { inMemory: (cwd) => ({ cwd }) },
		SettingsManager: { inMemory: (s) => ({ s }), create: () => ({ getDefaultProvider: () => "anthropic", getDefaultModel: () => "claude-main", getDefaultThinkingLevel: () => "high" }) },
		ModelRuntime: { create: async () => ({ getModel: (p, id) => ({ provider: p, id }), hasConfiguredAuth: () => true }) },
		DefaultResourceLoader: class { constructor(o) { this.o = o; } async reload() {} getAppendSystemPrompt() { return []; } getAgentsFiles() { return { agentsFiles: [] }; } getSkills() { return { skills: [], diagnostics: [] }; } getSystemPrompt() { return undefined; } getSystemPromptSource() { return undefined; } getAppendSystemPromptSources() { return []; } },
		getAgentDir: () => "/agent-dir",
		AgentSessionRuntime: class extends fx.FakeAgentSessionRuntime {},
		async createAgentSession(opts) { return { session: Object.assign(session, { systemPrompt: "x\n<cwd>\n" + opts.cwd + "\n</cwd>", model: opts.model, thinkingLevel: "high", active: opts.tools }) }; },
	};
}
const start = (id, args) => ({ type: "tool_execution_start", toolName: "subagent", toolCallId: id, args });
const end = (id, details, isError) => ({ type: "tool_execution_end", toolName: "subagent", toolCallId: id, ...(isError === undefined ? {} : { isError }), result: { content: [{ type: "text", text: "ok" }], details } });
const child = (over = {}) => ({ agent: "general-worker", task: S, exitCode: 1, messages: [], stderr: "diag " + S, errorMessage: "resp " + S, stopReason: "error", model: "m", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0.1, turns: 1, contextTokens: 2 }, ...over });
const hang = () => new Promise(() => {});

async function run(script) {
	const calls = { script };
	const base = fs.mkdtempSync(path.join(os.tmpdir(), "pp-run-"));
	const ws = fx.fakeWorkspace(base);
	const real = createWorkspace({ repo: base, scratchRoot: base });
	Object.assign(ws, { artifactPolicy: real.artifactPolicy, artifactsFor(mode, t) { return real.artifactsFor.call({ dirFor: ws.dirFor }, mode, t); }, prepareArtifacts: real.prepareArtifacts });
	const cfg = fx.fixtureConfig({ runtime: RUNTIME, limits: { roundSettleTimeoutMs: { value: 600000, source: "t" }, shutdownGraceMs: { value: 100, source: "t" }, taskTimeoutMs: { value: 400, source: "t" } } });
	const adapter = createPiSdkAdapter({ loadPi: async () => fakeSdk(calls), piPackageRoot: "/pi", topology: okTopology });
	const r = await runBenchmark({ manifest: fx.manifest([fx.task("H1")]), mode: "fresh", adapter, workspace: ws, acceptance: fx.gate, config: cfg });
	return r.tasks[0];
}
const noLeak = (t) => { assert.doesNotMatch(JSON.stringify(t.mainDiagnostics.rounds), new RegExp(S)); assert.doesNotMatch(JSON.stringify(t.delegation), new RegExp(S)); };

test("foreground child error/stderr text never reaches interrupted telemetry; structured failure survives", async () => {
	const t = await run(async (s) => {
		s.emit(start("fg1", { agent: "general-worker", task: S, background: false }));
		s.emit(end("fg1", { mode: "single", roles: ["general-worker"], rolesInvalid: 0, results: [child()] }, true));
		s.emit(start("fg2", { agent: "general-worker", task: S, background: false }));
		await hang();
	});
	assert.equal(t.status, "budget_exhausted");
	assert.equal(t.mainDiagnostics.rounds[0].coverage.requestedUnacked, 1);
	const l = t.delegation.launches[0];
	assert.deepEqual([l.partial, l.agent, l.status, l.exitCode, l.stopReason], [true, "general-worker", "terminal-failure", 1, "error"]);
	assert.equal(t.delegation.writerLaunches, 0); assert.equal(t.accepted, false);
	noLeak(t);
});

test("provider-owned free-form fields (stopReason, model, tier, slot, job id, mode) are controlled values or dropped", async () => {
	const t = await run(async (s) => {
		s.emit(start("bg1", { agent: "general-worker", task: S }));
		s.emit(end("bg1", { mode: S, roles: ["general-worker"], results: [], background: true, jobId: "bg-1" }, false));
		s.emit(start("bg2", { agent: "general-worker", task: S }));
		s.emit(end("bg2", { mode: "single", roles: ["general-worker"], results: [], background: true, jobId: "job-" + S }, false));
		s.emit(start("fg", { agent: "general-worker", task: S, background: false }));
		s.emit(end("fg", { mode: "single", roles: ["general-worker"], results: [child({ exitCode: 0, stopReason: "sk-" + S, model: S, modelTier: S, modelSlot: S })] }, false));
		s.emit(start("fg2", { agent: "general-worker", task: S, background: false }));
		await hang();
	});
	const l = t.delegation.launches[0];
	assert.equal(l.status, "measured"); assert.equal(l.exitCode, 0);
	assert.equal(t.delegation.receipts[0].jobId, "bg-1"); assert.equal(t.delegation.receipts[0].mode, null);
	assert.equal(t.delegation.receipts[1].jobId, null);
	noLeak(t);
});

test("a refused call's text and an unknown-role refusal are not persisted; the refusal is still counted", async () => {
	const t = await run(async (s) => {
		s.emit(start("r1", { agent: S, task: S }));
		s.emit({ type: "tool_execution_end", toolName: "subagent", toolCallId: "r1", isError: true, result: { content: [{ type: "text", text: "refused " + S }], isError: true, details: { roles: [S], rolesInvalid: 0 } } });
		s.emit(start("fg2", { agent: "general-worker", task: S, background: false }));
		await hang();
	});
	assert.equal(t.mainDiagnostics.rounds[0].known.refusals, 1);
	assert.equal(t.delegation.refusals.length, 1);
	noLeak(t);
});

test("a rejected SDK tool name is never a key or value in interrupted telemetry; known names and counts survive", async () => {
	const t = await run(async (s) => {
		for (const [id, name] of [["k", "read"], ["bad1", S], ["bad2", S + "-2"], ["bad3", null]]) {
			s.emit({ type: "tool_execution_start", toolName: name, toolCallId: id, args: { x: S } });
			s.emit({ type: "tool_execution_end", toolName: name, toolCallId: id, isError: name !== "read", result: { content: [{ type: "text", text: "Tool " + S + " not found" }], details: {} } });
		}
		s.emit(start("pending", { agent: "general-worker", task: S, background: false }));
		await hang();
	});
	assert.equal(t.status, "budget_exhausted"); assert.equal(t.accepted, false);
	assert.doesNotMatch(JSON.stringify(t.mainDiagnostics), new RegExp(S)); assert.doesNotMatch(JSON.stringify(t.delegation), new RegExp(S));
	assert.deepEqual(t.mainDiagnostics.rounds[0].known.tools, { read: { calls: 1, errors: 0 }, unknown_tool: { calls: 3, errors: 3 } });
	assert.deepEqual(t.mainDiagnostics.tools, t.mainDiagnostics.rounds[0].known.tools);
	assert.equal(t.mainDiagnostics.rounds[0].known.toolCalls, 4);
});

// Counter integrity: model-chosen tool names are data, never property lookups. Runs only in this synthetic test process; the globals are checked, never changed.
const GLOBALS = () => [Object.prototype, Object, Object.prototype.toString, Object.prototype.hasOwnProperty, Function.prototype];
const snap = () => GLOBALS().map((o) => Reflect.ownKeys(o).map((k) => { const d = Object.getOwnPropertyDescriptor(o, k); return String(k) + ":" + (d.get ? "accessor" : typeof d.value === "function" ? "fn" : typeof d.value === "object" ? JSON.stringify(d.value) : String(d.value)) + (d.writable ? "w" : "") + (d.enumerable ? "e" : ""); }).join(","));
// Test-process-only cleanup so a failing (polluting) implementation cannot cascade into later tests.
const scrub = () => { for (const o of GLOBALS()) for (const k of ["calls", "errors", "firstError"]) if (Object.hasOwn(o, k)) delete o[k]; };
const PROTO_NAMES = ["__proto__", "constructor", "toString", "hasOwnProperty"];
const toolEvents = (s, list) => { let i = 0; for (const [name, isError] of list) { const id = "t" + i++; s.emit({ type: "tool_execution_start", toolName: name, toolCallId: id, args: {} }); s.emit({ type: "tool_execution_end", toolName: name, toolCallId: id, isError, result: { content: [{ type: "text", text: "x" }], details: {} } }); } };
const calls11 = () => [["read", false], ["read", false], ["grep", false], ["__proto__", true], ["constructor", true], ["constructor", true], ["toString", true], ["toString", true], ["hasOwnProperty", true], ["hasOwnProperty", true], ["zzz", true], ["zzz", true], ["zzz", true], ["zzz", true]];

test("prototype-like model tool names are counted as unknown_tool (11 of 11) and no inherited object is touched", async () => {
	const before = snap();
	let t;
	try {
		t = await run(async (s) => { toolEvents(s, calls11()); s.emit(start("pending", { agent: "general-worker", task: S, background: false })); await hang(); });
		const known = t.mainDiagnostics.rounds[0].known;
		assert.deepEqual(known.tools, { read: { calls: 2, errors: 0 }, grep: { calls: 1, errors: 0 }, unknown_tool: { calls: 11, errors: 11 } });
		assert.equal(known.toolCalls, 14);
		assert.deepEqual(t.mainDiagnostics.tools, known.tools);
		for (const n of PROTO_NAMES) assert.doesNotMatch(JSON.stringify(t.mainDiagnostics), new RegExp(n));
	} finally {
		const after = snap(); const leaked = GLOBALS().some((o) => Object.hasOwn(o, "calls") || Object.hasOwn(o, "errors")); scrub();
		assert.deepEqual(after, before, "Object.prototype, Object, toString, hasOwnProperty and Function.prototype are unchanged");
		assert.equal(leaked, false, "no calls/errors leaked onto a global");
		assert.equal(Object.getPrototypeOf({}), Object.prototype);
	}
});

test("a completed round keeps prototype-like names as own records (honest counts) without touching globals; a second task starts clean", async () => {
	const before = snap();
	try {
		for (let i = 0; i < 2; i++) {
			const t = await run(async (s) => { toolEvents(s, calls11()); s.emit({ type: "assistant", message: { role: "assistant" } }); });
			const tools = t.mainDiagnostics.tools;
			for (const n of PROTO_NAMES) { assert.ok(Object.hasOwn(tools, n), n + " is an own record"); assert.equal(Object.getPrototypeOf(tools), Object.prototype); }
			assert.deepEqual([tools.constructor.calls, tools.toString.calls, tools.hasOwnProperty.calls, tools.zzz.calls, tools.read.calls], [2, 2, 2, 4, 2]);
			assert.equal(Object.getOwnPropertyDescriptor(tools, "__proto__").value.calls, 1);
			assert.equal(Object.values(tools).reduce((a, r) => a + r.calls, 0), 14);
			assert.equal(t.mainDiagnostics.rounds[0].toolCalls, 14);
		}
	} finally { const after = snap(); scrub(); assert.deepEqual(after, before); }
});
