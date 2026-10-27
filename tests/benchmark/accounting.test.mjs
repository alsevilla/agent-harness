// Group 1 repair (review cycle 1): run-level execution ownership, per-child reconciliation, price completeness through the real LogicalUsage chain, and
// privacy of metadata identities. Offline only: fake adapters and plain data, no Pi session and no provider.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import { registerHooks } from "node:module";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { runBenchmark } from "./lib/runner.mjs";
import { normalise, createPiSdkAdapter as realCreatePiSdkAdapter } from "./lib/sdk-adapter.mjs";
import { okTopology } from "./fixtures/topology-fixture.mjs";
// These suites drive a FAKE SDK, so the agent topology proof is injected at the adapter boundary (the real check needs the installed SDK; topology*.test.mjs run it for real).
const createPiSdkAdapter = (o = {}) => realCreatePiSdkAdapter({ topology: okTopology, ...o });
import { emptyLedger, ledgerTotals, newJob, observeJob, addJobUsage, addAuditUsage, addWorkerUsage } from "./lib/usage.mjs";
import { fixtureRoles, fixtureLimits, fakeAdapter, fakeWorkspace, root, task, manifest, fixtureConfig, gate, assistant, u, writerLaunch } from "./fixtures/fake-runtime.mjs";

const base = pathToFileURL(path.resolve(import.meta.dirname, "../..") + "/").href;
const { LogicalUsage, newUsageScope, completionResults, phase1Of, BackgroundWorkers } = await import(base + "agent/extensions/subagent/background.ts");

const child = (cost, position = 0, extra = {}) => ({ agent: "general-worker", position, exitCode: 0, usage: { input: 2, output: 1, turns: 1, cost }, ...extra });
const completion = (jobId, results, over = {}) => ({ type: "completion", jobId, jobKey: `sess-A/${jobId}`, session: "sess-A", state: "completed", results, ...over });
const audit = (jobId, results, over = {}) => ({ type: "audit", jobId, jobKey: `sess-A/${jobId}`, ownerSession: "sess-A", state: "completed", results, ...over });
const receipt = (jobId) => ({ type: "subagent", session: "sess-A", toolCallId: `call-${jobId}`, details: { mode: "single", results: [], jobId, background: true } });
const run = (ad, tasks = [task("H1")], mode = "fresh", config = fixtureConfig()) => runBenchmark({ manifest: manifest(tasks), mode, adapter: ad, workspace: fakeWorkspace(root()), acceptance: gate, config });
const fix = (s, events) => { fs.writeFileSync(path.join(s.cwd, "agent/work.txt"), "fixed"); return { events: [...events, assistant(u(1, 1))], text: "done" }; };
const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} !== ${b}`);

// --- F1: per-child reconciliation of one job ---
test("F1 a partial completion (one child missing) then the final audit with both children is known 0.3, not 0.1 and not 0.4", () => {
	const job = newJob("sess-A/bg-1");
	observeJob(job, { state: "completed", results: [child(0.1), { agent: "debugger", position: 1, exitCode: 0 }] });
	let t = ledgerTotals(addJobUsage(emptyLedger("worker"), job));
	assert.equal(t.cost.total, null, "the missing child leaves the total unknown");
	near(t.cost.knownPricedSubtotal, 0.1);
	observeJob(job, { state: "completed", results: [child(0.1), child(0.2, 1)] });
	t = ledgerTotals(addJobUsage(emptyLedger("worker"), job));
	assert.equal(t.status, "measured");
	near(t.cost.total, 0.3);
});

test("F1 the same cumulative snapshot observed twice, or by a completion and its audit, is counted once", () => {
	const job = newJob("k");
	observeJob(job, { state: "completed", results: [child(0.1)] });
	observeJob(job, { state: "completed", results: [child(0.1)] });
	near(ledgerTotals(addJobUsage(emptyLedger("worker"), job)).cost.total, 0.1);
});

test("F1 duplicate roles at different positions of one job are distinct children; a conflicting second report of one child stays unknown with no guessed charge", () => {
	const job = newJob("k");
	observeJob(job, { state: "completed", results: [child(0.1, 0), child(0.1, 1)] });
	near(ledgerTotals(addJobUsage(emptyLedger("worker"), job)).cost.total, 0.2);
	observeJob(job, { state: "completed", results: [child(0.1, 0), child(0.7, 1)] });
	const t = ledgerTotals(addJobUsage(emptyLedger("worker"), job));
	assert.equal(t.cost.total, null);
	near(t.cost.knownPricedSubtotal, 0.1, "only the agreed child is counted");
	assert.deepEqual(t.cost.unresolved.map((x) => [x.id, x.reason]), [["k#1", "conflicting_usage"]]);
});

test("F1 an aborted job keeps its children's usage known but its in-flight usage unknown, once however often it is observed", () => {
	const job = newJob("k");
	observeJob(job, { state: "aborted", results: [child(0.1)] });
	observeJob(job, { state: "aborted", results: [child(0.1)] });
	const t = ledgerTotals(addJobUsage(emptyLedger("worker"), job));
	assert.equal(t.cost.total, null);
	near(t.cost.knownPricedSubtotal, 0.1);
	assert.deepEqual(t.cost.unresolved.map((x) => x.reason), ["aborted_in_flight_usage_unknown"]);
});

// --- F1 through the real runner ---
test("F1 a completion in task 1 and its audit in task 2 (long mode) cost 0.1 in total, charged to task 1 only", async () => {
	const ad = fakeAdapter({ mainScript: (s) => fix(s, s.calls === 1 ? [completion("bg-1", [child(0.1)])] : [writerLaunch(0), audit("bg-1", [child(0.1)])]) });
	const r = await run(ad, [task("H1"), task("H2")], "long-fixed");
	near(r.totals.worker.cost.total, 0.1);
	near(r.tasks[0].worker.cost.total, 0.1);
	assert.equal(r.tasks[1].worker.cost.total, 0, "task 2 owns no usage of task 1's job");
	assert.equal(r.tasks[1].delegation.writerLaunches, 1, "only its own foreground writer, never task 1's completion");
});

test("F1 a late richer terminal record for task 1 that arrives while task 2 runs fills task 1 (partial 0.1 + missing child -> known 0.3) and adds nothing to task 2", async () => {
	const ad = fakeAdapter({ mainScript: (s) => fix(s, s.calls === 1 ? [completion("bg-1", [child(0.1), { agent: "debugger", position: 1, exitCode: 0, usage: { input: 2, output: 1, turns: 1 } }]), writerLaunch(0)] : [writerLaunch(0), audit("bg-1", [child(0.1), child(0.2, 1)])]) });
	const r = await run(ad, [task("H1"), task("H2")], "long-fixed");
	near(r.tasks[0].worker.cost.total, 0.3);
	assert.equal(r.tasks[1].worker.cost.total, 0);
	near(r.totals.worker.cost.total, 0.3);
});

test("F1 a shared session closed by task 2 does not hand task 1's audits to task 2; an audit no task can be proven to own stays explicitly unknown", async () => {
	const ad = fakeAdapter({ mainScript: (s) => (s.calls === 1 ? fix(s, [writerLaunch(0), completion("bg-1", [child(0.1)])]) : { events: [assistant(u(1, 1))], text: "no delegation" }) });
	ad.closeSession = async (s) => (s.role === "main" ? { confirmed: true, audits: [audit("bg-1", [child(0.1)]), audit("bg-2", [child(0.3)])] } : { confirmed: true });
	const r = await run(ad, [task("H1"), task("H2")], "long-fixed");
	assert.equal(r.tasks[1].status, "method_invalid");
	assert.equal(r.tasks[1].worker.launches, 0, "task 2 owns neither job");
	near(r.tasks[0].worker.cost.total, 0.1);
	assert.equal(r.totals.worker.cost.total, null, "the unattributed audit makes the run total unknown");
	near(r.totals.worker.cost.knownPricedSubtotal, 0.4); // 0.1 (task 1) + the unattributed 0.3, which is kept as known money of the run, never any task's
	near(r.tasks[1].worker.cost.knownPricedSubtotal ?? r.tasks[1].worker.cost.total ?? 0, 0);
	assert.ok(r.totals.worker.cost.unresolved.some((x) => x.reason === "owner_unattributed"));
});

test("F1 an audit stamped with its originating task id is routed to that task even when the runner never saw the job", async () => {
	const ad = fakeAdapter({ mainScript: (s) => (s.calls === 1 ? fix(s, [writerLaunch(0)]) : { events: [assistant(u(1, 1))], text: "no delegation" }) });
	ad.closeSession = async (s) => (s.role === "main" ? { confirmed: true, audits: [audit("bg-7", [child(0.3)], { taskId: "H1" })] } : { confirmed: true });
	const r = await run(ad, [task("H1"), task("H2")], "long-fixed");
	near(r.tasks[0].worker.cost.total, 0.3);
	assert.equal(r.tasks[1].worker.launches, 0);
});

test("F1 two same-role children of one parallel job are two charges; the identical audit adds nothing", async () => {
	const ad = fakeAdapter({ mainScript: (s) => fix(s, [writerLaunch(0), completion("bg-1", [child(0.1, 0), child(0.1, 1)]), audit("bg-1", [child(0.1, 0), child(0.1, 1)])]) });
	const r = await run(ad);
	near(r.tasks[0].worker.cost.total, 0.2);
	assert.equal(r.tasks[0].worker.launches, 3, "the foreground writer plus the two children");
});

test("F1 completion in round 0 and its audit in the rework round are one charge", async () => {
	const ad = fakeAdapter({ mainScript: (s) => (s.calls === 1 ? { events: [writerLaunch(0), completion("bg-1", [child(0.1)]), assistant(u(1, 1))], text: "not yet" } : fix(s, [writerLaunch(0), audit("bg-1", [child(0.1)])])) });
	const r = await run(ad);
	assert.equal(r.tasks[0].reworkRounds, 1);
	near(r.tasks[0].worker.cost.total, 0.1);
});

test("F1 a receipt with no completion or audit is an unknown job; a later close audit of the same job resolves it", async () => {
	const ad = fakeAdapter({ mainScript: (s) => fix(s, [writerLaunch(0), receipt("bg-1")]) });
	ad.closeSession = async (s) => (s.role === "main" ? { confirmed: true, pendingKeys: ["sess-A/bg-1"], pendingJobs: ["bg-1"], audits: [audit("bg-1", [child(0.1)], { state: "aborted" })] } : { confirmed: true });
	const r = await run(ad);
	assert.equal(r.tasks[0].status, "infrastructure");
	assert.equal(r.tasks[0].worker.cost.total, null);
	near(r.tasks[0].worker.cost.knownPricedSubtotal, 0.1);
	assert.deepEqual(r.tasks[0].worker.cost.unresolved.map((x) => x.reason), ["aborted_in_flight_usage_unknown"], "no stale completion_not_received once the job reported");
});

// --- F2: price completeness through the real LogicalUsage -> completionResults -> ledger chain ---
const nativeResult = (turns) => {
	const logical = new LogicalUsage(newUsageScope(), true, { role: "general-worker" });
	const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 };
	for (const t of turns) { logical.turn(t); usage.turns++; usage.input += t?.input ?? 0; usage.output += t?.output ?? 0; usage.cost += t?.cost?.total || 0; }
	const record = logical.settle("completed");
	return { agent: "general-worker", exitCode: 0, usage, phase1: phase1Of(record) };
};
const chain = (native) => { const results = completionResults({ details: { results: [native] } }); const l = emptyLedger("worker"); addAuditUsage(l, { jobKey: "sess-A/bg-1", state: "completed", results }); return ledgerTotals(l); };

test("F2 a completed worker whose turn had tokens but no price is not a measured zero: total unknown, known subtotal 0", () => {
	const t = chain(nativeResult([{ input: 2, output: 1 }]));
	assert.equal(t.status, "partial");
	assert.equal(t.cost.total, null);
	assert.equal(t.cost.knownPricedSubtotal, 0);
	assert.equal(t.unpricedTurns, 1);
	assert.deepEqual(t.cost.unresolved.map((x) => x.reason), ["unpriced"]);
});

test("F2 mixed priced and unpriced turns keep the priced subtotal and an unknown total", () => {
	const t = chain(nativeResult([{ input: 2, output: 1, cost: { total: 0.25 } }, { input: 2, output: 1 }]));
	assert.equal(t.cost.total, null);
	near(t.cost.knownPricedSubtotal, 0.25);
});

test("F2 an SDK-reported zero price with complete pricing stays a measured zero", () => {
	const t = chain(nativeResult([{ input: 2, output: 1, cost: { total: 0 } }]));
	assert.equal(t.status, "measured");
	assert.equal(t.cost.total, 0);
});

test("F2 a result with no flag (an older plain usage summary) is priced as before", () => {
	const l = addWorkerUsage(emptyLedger("worker"), { results: [child(0.1)] });
	near(ledgerTotals(l).cost.total, 0.1);
});

test("F2 the flag survives the adapter's own normaliser, a foreground result and the runner's ledger", async () => {
	const native = nativeResult([{ input: 2, output: 1 }]);
	const done = normalise({ type: "message_end", message: { role: "custom", customType: "subagent-completion", content: "x", details: { jobId: "bg-1", state: "completed", results: completionResults({ details: { results: [native] } }) } } }, { session: "sess-A" });
	const ad = fakeAdapter({ mainScript: (s) => fix(s, [writerLaunch(0), done]) });
	const r = await run(ad);
	assert.equal(r.tasks[0].worker.cost.total, null);
	assert.equal(r.tasks[0].worker.cost.knownPricedSubtotal, 0);
	const fg = { type: "subagent", toolCallId: "c1", details: { mode: "single", results: [native] } };
	const r2 = await run(fakeAdapter({ mainScript: (s) => fix(s, [fg]) }));
	assert.equal(r2.tasks[0].worker.cost.total, null);
});

// --- F4: privacy of metadata identities ---
const SECRET = "sk-reviewsynthetic0123456789";
const ctx = { roles: new Set(["general-worker", "debugger"]) };

test("F4 an unknown or secret-shaped control target, role, job id and worker id never survive normalisation", () => {
	const ctl = normalise({ type: "tool_execution_end", toolName: "subagent_control", result: { details: { control: { action: "result", target: SECRET } } } }, ctx);
	assert.deepEqual(ctl.control, { action: "result" });
	const ok = normalise({ type: "tool_execution_end", toolName: "subagent_control", result: { details: { control: { action: "result", target: "bg-12" } } } }, ctx);
	assert.deepEqual(ok.control, { action: "result", target: "bg-12" });
	const sub = normalise({ type: "tool_execution_end", toolName: "subagent", toolCallId: "c", result: { details: { roles: ["general-worker", SECRET, "debugger"], rolesInvalid: 1, results: [] } } }, ctx);
	assert.deepEqual(sub.roles, ["general-worker", "debugger"]);
	assert.equal(sub.rolesInvalid, 1);
	const dec = normalise({ type: "message_end", message: { role: "custom", customType: "subagent-decision", content: "", details: { state: "open", requestId: SECRET, jobId: SECRET } } }, ctx);
	assert.deepEqual([dec.requestId, dec.jobId], [null, null]);
	const entry = normalise({ type: "entry_appended", entry: { type: "custom", id: "e", customType: "subagent-terminal-audit", data: { v: 1, ownerSession: "sess-A", jobId: "bg-1", state: "completed", results: [{ position: 0, agent: SECRET, workerId: SECRET, nodeId: SECRET, usage: { turns: 1, input: 1, output: 1, cost: 0.1 } }] } } }, { ...ctx, session: "sess-A" });
	assert.equal(JSON.stringify([ctl, sub, dec, entry]).includes("sk-"), false);
	assert.equal(entry.results[0].usage.cost, 0.1, "the numbers stay");
});

test("F4 without a registered role set no role name is recorded at all", () => {
	const sub = normalise({ type: "tool_execution_end", toolName: "subagent", toolCallId: "c", result: { details: { roles: ["general-worker"], results: [] } } }, {});
	assert.deepEqual(sub.roles, []);
});

// --- F3: the installed Pi's void sendMessage semantics (its own sendCustomMessage and bindCore error wrapper, on plain data: no session, SDK factory or provider) ---
const PI_ROOT = process.env.PI_PACKAGE_ROOT ?? path.join(process.env.USERPROFILE ?? process.env.HOME ?? "", ".pi", "agent", "install", "releases", "1.4.0", "node_modules", "@earendil-works", "pi-coding-agent");
test("F3 with the installed Pi, a rejecting _startRun reaches only the runner error channel: the audit says submitted, never delivered, and no failure is invented", { skip: !fs.existsSync(path.join(PI_ROOT, "dist", "core", "agent-session.js")) }, async () => {
	const { AgentSession } = await import(pathToFileURL(path.join(PI_ROOT, "dist", "core", "agent-session.js")).href);
	const runnerErrors = []; const entries = []; const handlers = new Map();
	const fakeSession = { isStreaming: false, _startRun: async () => { throw Error("synthetic delivery failure"); } };
	const sent = [];
	// agent-session.js runner.bindCore: the runtime's promise is dropped by the loader and a failure becomes runner.emitError.
	const pi = { on: (n, h) => handlers.set(n, h), appendEntry: (customType, data) => entries.push({ customType, data }), sendMessage: (msg, opts) => { sent.push(msg); AgentSession.prototype.sendCustomMessage.call(fakeSession, msg, opts).catch((e) => runnerErrors.push(e.message)); } };
	assert.equal(pi.sendMessage({ customType: "x", content: "", display: false }, { triggerTurn: true }), undefined, "the API returns void: there is nothing to await");
	await new Promise((resolve) => setImmediate(resolve)); // let the probe call's own async failure surface before counting
	sent.length = 0; runnerErrors.length = 0;
	const bg = new BackgroundWorkers(pi, { store: { records: new Map(), changed() {} } });
	handlers.get("session_start")({}, { sessionManager: { getSessionId: () => "sess-A" } });
	const job = bg.start(async () => ({ content: [{ type: "text", text: "done" }], details: { results: [child(0.1)] } }));
	await job.done; await new Promise((resolve) => setImmediate(resolve));
	assert.equal(runnerErrors.length, 1, "the async failure surfaced only on the runner's error channel");
	const audit = entries.find((e) => e.customType === "subagent-terminal-audit").data;
	assert.equal(audit.completion, "submitted");
	assert.equal("completionDelivered" in audit, false);
	assert.equal(entries.some((e) => e.customType === "subagent-delivery-diagnostic"), false, "an uncorrelatable async failure is never attributed to the job");
	assert.equal(job.delivery, undefined);
});

test("F3 an audit that says submitted is not a delivery: completionObserved is true only once the consumer's completion for that job was observed", async () => {
	const a = (observed) => fakeAdapter({ mainScript: (s) => fix(s, [writerLaunch(0), ...(observed ? [completion("bg-1", [child(0.1)])] : []), audit("bg-1", [child(0.1)], { completion: "submitted", completionSuppressed: false })]) });
	assert.equal((await run(a(true))).tasks[0].delegation.audits[0].completionObserved, true);
	const r = await run(a(false));
	assert.deepEqual([r.tasks[0].delegation.audits[0].completion, r.tasks[0].delegation.audits[0].completionObserved], ["submitted", false]);
});

// --- Review cycle 2 boundary corrections (REAL sdk adapter over an in-memory SDK double: no Pi factory, provider or process) ---
const wr = (cost, position = 0, extra = {}) => ({ agent: "general-worker", position, exitCode: 0, usage: { input: 2, output: 1, cacheRead: 0, cacheWrite: 0, turns: 1, cost }, ...extra });
const nDone = (results, id = "bg-1") => ({ type: "message_end", message: { role: "custom", customType: "subagent-completion", content: "UNCHANGED", details: { jobId: id, state: "completed", results } } });
const nAudit = (results, id = "bg-1") => ({ type: "custom", id: "audit-" + id, customType: "subagent-terminal-audit", data: { v: 1, jobId: id, ownerSession: "sess-A", state: "completed", completion: "submitted", results } });
const nReceipt = (id = "bg-1") => ({ type: "tool_execution_end", toolName: "subagent", toolCallId: "call-" + id, isError: false, result: { details: { roles: ["general-worker"], mode: "single", results: [], background: true, jobId: id }, content: [{ type: "text", text: "receipt" }] } });
const nAssistant = () => ({ type: "message_end", message: { role: "assistant", provider: "fake", model: "model", usage: u(1, 1) } });
const nFg = (results = [wr(0)]) => ({ type: "tool_execution_end", toolName: "subagent", toolCallId: "fg", isError: false, result: { details: { roles: ["general-worker"], mode: "single", results }, content: [] } });
function sdkHarness(script, shutdown = () => {}, extra = {}) {
	const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "acct-sdk-")); const agentDir = path.join(fixture, "profile");
	fs.mkdirSync(path.join(fixture, "agent", "agents"), { recursive: true }); fs.mkdirSync(agentDir, { recursive: true });
	for (const n of ["general-worker", "reviewer"]) fs.writeFileSync(path.join(fixture, "agent", "agents", n + ".md"), `---\nname: ${n}\n---\nrole`);
	const hooks = {}; const sessions = []; // hooks.create(index, opts): awaited inside createAgentSession, so a test can make the factory late or move a scripted clock
	const sdk = { getAgentDir: () => agentDir, SessionManager: { inMemory: () => ({}) }, SettingsManager: { inMemory: () => ({}) }, ModelRuntime: { create: async () => ({ getModel: (provider, id) => ({ provider, id }), hasConfiguredAuth: () => true }) },
		DefaultResourceLoader: class { constructor(o) { this.o = o; } async reload() {} getAgentsFiles() { return { agentsFiles: [] }; } getSkills() { return { skills: [] }; } getAppendSystemPrompt() { return this.o.appendSystemPrompt ?? []; } getAppendSystemPromptSources() { return []; } },
		AgentSessionRuntime: class { constructor(session) { this.s = session; } async dispose() { this.s.disposes++; await shutdown(this.s); } },
		async createAgentSession(opts) {
			await hooks.create?.(sessions.length, opts);
			const s = { cwd: opts.cwd, main: opts.tools.includes("subagent"), calls: 0, entries: [], listeners: new Set(), disposes: 0, dispose() { return hooks.sessionDispose?.(s); }, systemPrompt: "BASE\n<cwd>\n" + opts.cwd.split("\\").join("/") + "\n</cwd>", model: opts.model, messages: [], getActiveToolNames: () => opts.tools, sessionManager: { getSessionId: () => "sess-A", getEntries: () => s.entries }, bindExtensions: async (o) => { s.bound = o; }, subscribe(fn) { s.listeners.add(fn); return () => s.listeners.delete(fn); }, emit(e) { for (const fn of s.listeners) fn(e); }, async prompt() { s.calls++; if (s.main) await script(s); else s.emit(nAssistant()); }, getLastAssistantText: () => (s.main ? "done" : "NO FINDINGS"), waitForIdle: async () => { await hooks.idle?.(s); }, abort: async () => {}, getContextUsage: () => ({ tokens: 1, contextWindow: 1000 }), compact: async () => ({ tokensBefore: 1, usage: u(1, 1) }) };
			sessions.push(s);
			return { session: s };
		} };
	const config = fixtureConfig({ runtime: { root: fixture, extensions: [], fingerprint: "offline-fixture" }, roles: { ...fixtureRoles(), reviewer: { ...fixtureRoles().reviewer, tools: ["read", "grep", "find", "ls"] } }, ...extra });
	return { ad: createPiSdkAdapter({ loadPi: async () => sdk }), config, hooks, sessions, sdk, fixture };
}
const writeFix = (s) => fs.writeFileSync(path.join(s.cwd, "agent/work.txt"), "fixed");

test("F1/c2 an unowned audit that appears while task 2 runs is an unattributed run-level unknown: task 2 is not charged, the known 0.4 is kept", async () => {
	const h = sdkHarness(async (s) => { writeFix(s); s.emit(nFg()); if (s.calls === 2) { const e = nAudit([wr(0.4)], "bg-88"); s.entries.push(e); s.emit({ type: "entry_appended", entry: e }); } s.emit(nAssistant()); });
	const r = await run(h.ad, [task("H1"), task("H2")], "long-fixed", h.config);
	near(r.tasks[1].worker.cost.total, 0);
	assert.equal(r.totals.worker.cost.total, null);
	near(r.totals.worker.cost.knownPricedSubtotal, 0.4);
	assert.ok(r.totals.worker.cost.unresolved.some((x) => x.reason === "owner_unattributed"));
});

test("F1/c2 a first-seen completion without a receipt cannot prove task 2 launched its writer (no current-task fallback)", async () => {
	const h = sdkHarness(async (s) => { writeFix(s); if (s.calls === 1) s.emit(nFg()); else s.emit(nDone([wr(0.4)], "bg-88")); s.emit(nAssistant()); });
	const r = await run(h.ad, [task("H1"), task("H2")], "long-fixed", h.config);
	assert.equal(r.tasks[1].delegation.writerLaunches, 0);
	assert.equal(r.tasks[1].status, "method_invalid");
	assert.equal(r.totals.worker.cost.total, null);
});

test("F1/c2 a legitimate receipt still owns its job: the later completion is its writer and its audit enriches the same task", async () => {
	const h = sdkHarness(async (s) => { writeFix(s); s.emit(nReceipt()); s.emit(nDone([wr(0.1)])); s.emit(nAssistant()); }, async (s) => { if (s.main) s.entries.push(nAudit([wr(0.1), wr(0.2, 1)])); });
	const r = await run(h.ad, [task("H1")], "fresh", h.config);
	near(r.tasks[0].worker.cost.total, 0.3);
	assert.equal(r.tasks[0].delegation.writerLaunches, 1);
});

test("F2/c2 the result of an actual BackgroundWorkers.result control call keeps its children's known 0.1+0.2 (retrieval is not a launch), total stays unknown, duplicates count once", async () => {
	const handlers = new Map();
	const bg = new BackgroundWorkers({ on: (k, v) => handlers.set(k, v), appendEntry: () => { throw Error("unavailable audit"); }, sendMessage: () => {} }, { store: { records: new Map(), changed() {} } });
	handlers.get("session_start")({}, { sessionManager: { getSessionId: () => "sess-A" } });
	const j = bg.start(async () => ({ content: [{ type: "text", text: "PRIVATE-BODY" }], details: { results: [wr(0.1), wr(0.2, 1)] } }));
	await j.done;
	const native = bg.result(j.id); native.details.control = { action: "result", target: j.id };
	const ctl = { type: "tool_execution_end", toolName: "subagent_control", toolCallId: "ctl", isError: false, result: native };
	const h = sdkHarness(async (s) => { writeFix(s); s.emit(nReceipt(j.id)); s.emit(nFg()); s.emit(ctl); s.emit({ ...ctl, toolCallId: "ctl2" }); s.emit(nAssistant()); }, () => {}, { limits: { ...fixtureLimits(), roundSettleTimeoutMs: { value: 15, source: "offline-test" } } });
	const r = await run(h.ad, [task("H1")], "fresh", h.config);
	assert.equal(r.tasks[0].worker.cost.total, null);
	near(r.tasks[0].worker.cost.knownPricedSubtotal, 0.3);
	assert.equal(r.tasks[0].delegation.launches.filter((l) => l.jobId === j.id).length, 0, "retrieval adds no launch");
});

test("F2/c2 a control result for a job nobody owns stays unattributed (known money kept at run level, never a task's)", async () => {
	const ctl = { type: "tool_execution_end", toolName: "subagent_control", toolCallId: "ctl", isError: false, result: { content: [], details: { control: { action: "result", target: "bg-77" }, results: [wr(0.1), wr(0.2, 1)] } } };
	const h = sdkHarness(async (s) => { writeFix(s); s.emit(nFg()); if (s.calls === 2) s.emit(ctl); s.emit(nAssistant()); });
	const r = await run(h.ad, [task("H1"), task("H2")], "long-fixed", h.config);
	near(r.tasks[1].worker.cost.total, 0);
	assert.equal(r.totals.worker.cost.total, null);
	near(r.totals.worker.cost.knownPricedSubtotal, 0.3);
});

test("F3/c2 foreground results go through the registry: a registered role is kept, an unknown name is omitted and scrubbed, numeric usage/error stay", () => {
	const SECRET = "sk-reviewsynthetic0123456789";
	const ev = (results) => ({ type: "tool_execution_end", toolName: "subagent", toolCallId: "fg", isError: true, result: { content: [{ type: "text", text: "model-visible failure" }], details: { mode: "single", results } } });
	const n = normalise(ev([{ agent: "general-worker", exitCode: 0, usage: { input: 2, output: 1, turns: 1, cost: 0.2 } }, { agent: SECRET, task: "PRIVATE", exitCode: 1, stderr: `Unknown agent: "${SECRET}"`, errorMessage: `bad ${SECRET}`, usage: { input: 0, output: 0, turns: 0, cost: 0 } }]), { session: "sess-A", roles: new Set(["general-worker"]) });
	assert.equal(n.text, "model-visible failure");
	assert.equal(n.details.results[0].agent, "general-worker");
	assert.equal(n.details.results[0].usage.cost, 0.2);
	assert.equal(n.details.results[1].agent, undefined);
	assert.equal(n.details.results[1].exitCode, 1);
	assert.equal(n.details.results[1].usage.turns, 0);
	assert.equal(JSON.stringify(n).includes(SECRET), false);
	assert.equal(JSON.stringify(n).includes("PRIVATE"), false);
});

test("F3/c2 the ACTUAL native subagent tool with an unknown role (background false and true) launches no process and no raw role reaches the final result", async () => {
	const SECRET = "sk-reviewsynthetic0123456789";
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "acct-native-")); const profile = path.join(dir, "agent"); fs.mkdirSync(path.join(profile, "agents"), { recursive: true }); process.env.PI_CODING_AGENT_DIR = profile;
	const R = pathToFileURL(path.resolve(import.meta.dirname, "../..") + "/").href;
	const data = (s) => "data:text/javascript," + encodeURIComponent(s);
	const doubles = R + "agent/extensions/subagent/tests/fixtures/runtime-doubles.mjs"; const index = R + "agent/extensions/subagent/index.ts"; const entry = R + "agent/extensions/subagent/provider-cooldown-entry.ts";
	const child = data('export function spawn(){throw Error("NO PROCESS ALLOWED");} export function execFileSync(){throw Error("NO PROCESS ALLOWED");} export function spawnSync(){throw Error("NO PROCESS ALLOWED");}');
	const monitor = data("export class WorkerMonitor {constructor(){this.store={records:new Map(),changed(){}};}}");
	const cool = data('export const anthropicMessagesApi=()=>({streamSimple:()=>{throw Error("offline");}});export const openAICodexResponsesApi=anthropicMessagesApi;export function createAssistantMessageEventStream(){throw Error("offline");}');
	registerHooks({ resolve(s, c, next) {
		if (s === "@earendil-works/pi-ai/compat" || (s === "@earendil-works/pi-ai" && c.parentURL === entry)) return { url: cool, shortCircuit: true };
		if (["@earendil-works/pi-coding-agent", "@earendil-works/pi-ai", "typebox"].includes(s)) return { url: doubles, shortCircuit: true };
		if (s === "node:child_process" && c.parentURL?.includes("/agent/extensions/")) return { url: child, shortCircuit: true };
		if (s === "./monitor.ts" && c.parentURL === index) return { url: monitor, shortCircuit: true };
		return next(s, c);
	} });
	const { default: extension } = await import(index);
	const tools = new Map(); const hs = new Map();
	extension({ tools, on: (k, fn) => hs.set(k, [...(hs.get(k) ?? []), fn]), registerTool: (t) => tools.set(t.name, t), registerProvider() {}, registerCommand() {}, getCommands: () => [], appendEntry() {}, sendMessage() {} });
	try {
		for (const background of [false, true]) {
			const result = await tools.get("subagent").execute("bad-role", { agent: SECRET, task: "PRIVATE packet body", background }, undefined, undefined, { cwd: dir, hasUI: false });
			const event = normalise({ type: "tool_execution_end", toolName: "subagent", toolCallId: "bad-role", isError: result.isError === true, result }, { session: "sess-A", roles: new Set(["general-worker"]) });
			const ad = fakeAdapter({ mainScript: (s) => fix(s, [writerLaunch(0), event]) });
			const r = await run(ad);
			assert.equal(JSON.stringify(r).includes(SECRET), false, `background ${background}`);
		}
	} finally { for (const fn of hs.get("session_shutdown") ?? []) await fn(); }
});

test("F4/c2 the adapter's async send_message error count survives the runner close boundary as ONE uncorrelated error (no text, no job guess); a repeated adapter close is cumulative 1", async () => {
	const h = sdkHarness(async (s) => { writeFix(s); s.emit(nFg()); s.bound.onError({ event: "send_message", error: "PRIVATE-ERROR" }); s.emit(nAssistant()); });
	const r = await run(h.ad, [task("H1")], "fresh", h.config);
	assert.equal(r.tasks[0].delegation.uncorrelatedSendErrors, 1);
	assert.equal(JSON.stringify(r).includes("PRIVATE-ERROR"), false);
	const st = { pending: new Map(), session: { abort: async () => {} }, runtime: { dispose: async () => {} }, hidden: [], seenEntries: new Set(), ctx: () => ({}), extensionErrors: [{ event: "send_message", error: "x" }], jobTasks: new Map() };
	const ad = createPiSdkAdapter();
	assert.equal((await ad.closeSession(st, { budgetMs: 50 })).sendMessageErrors, 1);
	assert.equal((await ad.closeSession(st, { budgetMs: 50 })).sendMessageErrors, 1);
});

test("F5/c2 a close with neither a configured grace nor a budget fails closed (unconfirmed, no unbounded await, no invented default); an explicit budget stays bounded", async () => {
	let release; const wait = new Promise((res) => { release = res; });
	const mk = () => ({ pending: new Map(), session: { abort: async () => {} }, runtime: { dispose: async () => wait }, hidden: [], seenEntries: new Set(), ctx: () => ({}), extensionErrors: [], jobTasks: new Map() });
	const ad = createPiSdkAdapter();
	const guard = (p) => Promise.race([p, new Promise((res) => setTimeout(() => res("STILL_WAITING"), 2000))]);
	const none = await guard(ad.closeSession(mk()));
	assert.notEqual(none, "STILL_WAITING");
	assert.equal(none.confirmed, false);
	const bounded = await guard(ad.closeSession(mk(), { budgetMs: 10 }));
	assert.equal(bounded.confirmed, false);
	release();
});

test("F5/c2 late reviewer-open cleanup gets the ORIGINAL remaining budget; an unconfirmed late close is unconfirmed shutdown, the task/replay is not reused", async () => {
	let releaseOpen; const gateOpen = new Promise((res) => { releaseOpen = res; });
	const lateBudgets = []; const opens = [];
	const ad = fakeAdapter({ mainScript: (s) => fix(s, [writerLaunch(0)]) });
	const baseOpen = ad.openSession.bind(ad);
	ad.openSession = async (o) => { const s = await baseOpen(o); opens.push(o.role); if (o.role === "review") await gateOpen; return s; };
	ad.closeSession = async (s, o) => { if (s.role === "review") { lateBudgets.push(o?.budgetMs); return { confirmed: false }; } return { confirmed: true }; };
	const limits = { taskTimeoutMs: { value: 600, source: "test" }, shutdownGraceMs: { value: 300, source: "test" }, roundSettleTimeoutMs: { value: 1000, source: "test" } };
	setTimeout(releaseOpen, 450); // after the 300 ms work cutoff, inside the 300 ms grace the owner drains
	const r = await Promise.race([run(ad, [task("H1"), task("H2")], "fresh", fixtureConfig({ limits })), new Promise((_, rej) => setTimeout(() => rej(new Error("test guard")), 8000))]);
	releaseOpen();
	assert.equal(r.status, "unfinished");
	assert.equal(r.tasks[0].status, "budget_exhausted");
	assert.equal(lateBudgets.length, 1, "the late review session is closed once, by its owner");
	assert.ok(Number.isFinite(lateBudgets[0]) && lateBudgets[0] >= 0 && lateBudgets[0] <= 300, `original remaining budget, got ${lateBudgets[0]}`);
	assert.equal(r.tasks[0].shutdown.confirmed, false, "an unconfirmed late close is never a confirmed shutdown");
	assert.ok(r.tasks[0].shutdown.pendingOperations.includes("review_open"));
	assert.deepEqual(r.notRun, ["H2"], "no next task reuses the workspace while shutdown is unconfirmed");
	assert.equal(opens.filter((x) => x === "main").length, 1);
});

test("F4 a refusal that named an unregistered role keeps only the invalid count, never the quoted name", async () => {
	const refusal = { type: "subagent", toolCallId: "c0", isError: true, text: "Unknown agents: my-private-role-name", roles: [], rolesInvalid: 1, details: { mode: "single", results: [] } };
	const r = await run(fakeAdapter({ mainScript: (s) => fix(s, [refusal, writerLaunch(0)]) }));
	assert.equal(JSON.stringify(r).includes("my-private-role-name"), false);
	assert.deepEqual(r.tasks[0].delegation.refusals.map(({ text, rolesInvalid, reason }) => [text, rolesInvalid, reason]), [[null, 1, "unknown_role"]]);
});

test("F4 the runner timeline never falls back to the raw details.roles of a native event", async () => {
	const ev = { type: "subagent", toolCallId: "c1", session: "sess-A", details: { mode: "single", roles: [SECRET], results: [], jobId: "bg-1", background: true } };
	const ad = fakeAdapter({ mainScript: (s) => fix(s, [writerLaunch(0), ev, completion("bg-1", [child(0.1)])]) });
	const r = await run(ad);
	assert.equal(JSON.stringify(r).includes(SECRET), false);
});

// --- Final corrections: extension-error privacy, late-open dispose failure, fractional remaining budget (REAL runner + REAL sdk adapter over an in-memory SDK double) ---
const delay = (ms) => new Promise((res) => setTimeout(res, ms));
const lim = (taskTimeoutMs, shutdownGraceMs, roundSettleTimeoutMs) => ({ taskTimeoutMs: { value: taskTimeoutMs, source: "test" }, shutdownGraceMs: { value: shutdownGraceMs, source: "test" }, roundSettleTimeoutMs: { value: roundSettleTimeoutMs, source: "test" } });
const openArgs = (h) => ({ cwd: h.fixture, role: "main", compactionEnabled: false, taskId: "H1", runtime: { root: h.fixture, extensions: [] }, roleSpec: h.config.roles.main, limits: h.config.limits, timeline: { startedAt: 0 } });

test("P4b a non-send extension error never stores its text: the credential is absent from identity and the persisted JSON, the allowlisted type and the send_message counter stay", async () => {
	const h = sdkHarness(async (s) => { writeFix(s); s.emit(nFg()); s.bound.onError({ event: "tool_call", extensionPath: "x", error: "failed with token " + SECRET }); s.bound.onError({ event: "send_message", error: "PRIVATE-" + SECRET }); s.bound.onError({ event: SECRET, error: "x" }); s.emit(nAssistant()); });
	const r = await run(h.ad, [task("H1")], "fresh", h.config);
	const j = JSON.stringify(r);
	assert.equal(j.includes(SECRET), false);
	assert.equal(j.includes("PRIVATE-"), false);
	const errs = r.tasks[0].models.main.opened.resources.extensionErrors;
	assert.deepEqual(errs.map((e) => e.event), ["tool_call", "send_message", null], "counts and allowlisted types stay; an arbitrary event string is not stored");
	assert.ok(errs.every((e) => e.error === null));
	assert.equal(r.tasks[0].delegation.uncorrelatedSendErrors, 1);
});

for (const [mode, how] of [["reject", async () => { throw new Error("dispose boom"); }], ["throw", () => { throw new Error("dispose boom"); }]]) {
	test(`V2 abort inside createAgentSession and the lifecycle dispose ${mode}s: shutdown is unconfirmed, the next task does not start, no raw error text`, async () => {
		const h = sdkHarness(async (s) => { writeFix(s); s.emit(nFg()); s.emit(nAssistant()); }, how);
		h.hooks.create = async (i) => { if (i === 0) await delay(650); };
		const r = await run(h.ad, [task("H1"), task("H2")], "fresh", { ...h.config, limits: lim(800, 300, 200) });
		assert.equal(r.tasks[0].shutdown.confirmed, false, JSON.stringify(r.tasks[0].shutdown));
		assert.ok(r.tasks[0].shutdown.pendingOperations.includes("session_open"));
		assert.deepEqual(r.notRun, ["H2"]);
		assert.equal(h.sessions.length, 1, "no second session and no replay");
		assert.equal(h.sessions[0].disposes, 1);
		assert.equal(JSON.stringify(r).includes("dispose boom"), false);
	});
}

test("V1/V3 controls: a late open whose dispose resolves is confirmed and H2 runs; one that hangs stays bounded, unconfirmed and pending", async () => {
	const a = sdkHarness(async (s) => { writeFix(s); s.emit(nFg()); s.emit(nAssistant()); });
	a.hooks.create = async (i) => { if (i === 0) await delay(650); };
	const ra = await run(a.ad, [task("H1"), task("H2")], "fresh", { ...a.config, limits: lim(800, 300, 200) });
	assert.equal(ra.tasks[0].shutdown.confirmed, true);
	assert.deepEqual(ra.notRun, []);
	const b = sdkHarness(async (s) => { writeFix(s); s.emit(nFg()); s.emit(nAssistant()); }, () => new Promise(() => {}));
	b.hooks.create = async (i) => { if (i === 0) await delay(650); };
	const rb = await run(b.ad, [task("H1"), task("H2")], "fresh", { ...b.config, limits: lim(800, 300, 200) });
	assert.equal(rb.tasks[0].shutdown.confirmed, false);
	assert.ok(rb.tasks[0].shutdown.pendingOperations.includes("session_open"));
	assert.deepEqual(rb.notRun, ["H2"]);
});

for (const [mode, how] of [["throws synchronously", () => { throw new Error("sync boom"); }], ["rejects", async () => { throw new Error("sync boom"); }]]) {
	test(`a session.dispose that ${mode} in the no-AgentSessionRuntime branch rejects openSession with unconfirmed:true and no raw text; a clean dispose stays plain infrastructure`, async () => {
		const h = sdkHarness(async () => {});
		delete h.sdk.AgentSessionRuntime;
		h.hooks.sessionDispose = how;
		const e = await h.ad.openSession(openArgs(h)).then(() => null, (x) => x);
		assert.equal(e.kind, "lifecycle_unavailable");
		assert.equal(e.unconfirmed, true);
		assert.equal(String(e.message).includes("sync boom") || e.cause !== undefined, false);
		const c = sdkHarness(async () => {}); delete c.sdk.AgentSessionRuntime;
		const ok = await c.ad.openSession(openArgs(c)).then(() => null, (x) => x);
		assert.equal(ok.kind, "lifecycle_unavailable");
		assert.notEqual(ok.unconfirmed, true);
	});
}

// Production limits with the REAL default performance.now clock: the remaining budget is fractional and must reach the integer-only settle round as whole ms.
const PROD = lim(1200000, 60000, 1200000);
const scriptedClock = () => { const T = { v: 0 }; return { T, clock: () => 1000.37 + T.v }; };
const captured = (h) => { const seen = []; const real = h.ad.prompt.bind(h.ad); h.ad.prompt = async (st, text, o) => { seen.push({ role: st.role, budgetMs: o.budgetMs, settle: o.settle?.timeoutMs }); return real(st, text, o); }; return seen; };
const pendingScript = async (s) => { writeFix(s); s.emit(nFg()); s.emit(nReceipt("bg-1")); s.emit(nAssistant()); };
const deliverOnIdle = async (s) => { await Promise.resolve(); if (s.main && !s.delivered) { s.delivered = true; s.emit(nDone([wr(0.01)], "bg-1")); } };
const settled = (r, h, seen) => {
	assert.equal(r.tasks[0].status, "completed", r.tasks[0].error ?? "");
	const m = seen.find((x) => x.role === "main");
	assert.ok(Number.isInteger(m.budgetMs) && Number.isInteger(m.settle), JSON.stringify(m));
	assert.equal(h.sessions[0].delivered, true, "the pending job completed through waitForIdle");
};

for (const mode of ["long-fixed", "long-compacted"]) {
	test(`real adapter: the last task is INVALID (no assistant turn) and sees the same job's audit again (${mode}): total 0.1 not 0.2, origin H1, H2 charged nothing`, async () => {
		const h = sdkHarness(async (s) => {
			writeFix(s);
			if (s.calls === 1) { s.emit(nFg()); s.emit(nReceipt("bg-1")); s.emit(nDone([wr(0.1)], "bg-1")); s.emit(nAssistant()); }
			else { const e = nAudit([wr(0.1)], "bg-1"); s.entries.push(e); s.emit({ type: "entry_appended", entry: e }); }
		});
		const r = await run(h.ad, [task("H1"), task("H2")], mode, h.config);
		near(r.tasks[0].worker.cost.total, 0.1);
		assert.equal(r.tasks[1].worker.cost.total ?? 0, 0);
		assert.equal(r.tasks[1].delegation.writerLaunches, 0);
		near(r.totals.worker.cost.total, 0.1);
	});
}

test("S1 configured production limits and the real default clock: the main prompt settles (whole-ms budget), it does not error", async () => {
	const h = sdkHarness(pendingScript); h.hooks.idle = deliverOnIdle;
	const seen = captured(h);
	const r = await run(h.ad, [task("H1")], "fresh", { ...h.config, limits: PROD });
	settled(r, h, seen);
});

test("S2 a scripted fractional clock near the cutoff leaves less than a smaller configured settle: whole-ms settle, completes", async () => {
	const h = sdkHarness(pendingScript); h.hooks.idle = deliverOnIdle;
	const { T, clock } = scriptedClock(); h.hooks.create = async (i) => { if (i === 0) T.v += 700000.37; };
	const seen = captured(h);
	const r = await run(h.ad, [task("H1")], "fresh", { ...h.config, limits: lim(1200000, 60000, 600000), clock });
	settled(r, h, seen);
	assert.ok(seen[0].settle < 600000);
});

test("S3 a long main prompt (scripted Date.now, no wait) leaves a fractional remainder below the settle timeout: the adapter settles with whole ms", async () => {
	const h = sdkHarness(async (s) => { await pendingScript(s); });
	h.hooks.idle = deliverOnIdle;
	const realNow = Date.now; let skew = 0; Date.now = () => realNow() + skew;
	const seen = captured(h);
	const prompt = h.sdk.createAgentSession;
	h.sdk.createAgentSession = async (o) => { const x = await prompt(o); const p = x.session.prompt; x.session.prompt = async () => { await p(); skew += 700000; }; return x; };
	try {
		const r = await run(h.ad, [task("H1")], "fresh", { ...h.config, limits: lim(1200000, 60000, 600000) });
		settled(r, h, seen);
	} finally { Date.now = realNow; }
});

test("S4 under one whole millisecond left at main_prompt is budget exhaustion: no prompt, no settle, no new 1 ms grant", async () => {
	const h = sdkHarness(pendingScript); h.hooks.idle = deliverOnIdle;
	const { T, clock } = scriptedClock(); h.hooks.create = async (i) => { if (i === 0) T.v += 1139999.6; };
	const seen = captured(h);
	const r = await run(h.ad, [task("H1")], "fresh", { ...h.config, limits: lim(1200000, 60000, 600000), clock });
	assert.equal(r.tasks[0].status, "budget_exhausted", r.tasks[0].error ?? "");
	assert.equal(r.tasks[0].budget.stage, "main_prompt");
	assert.equal(seen.filter((x) => x.role === "main").length, 0);
	assert.equal(h.sessions[0].calls, 0);
	assert.ok(!h.sessions[0].delivered);
});

test("S5 the adapter itself: fractional remaining budget under one ms returns the unsettled budget-exhausted settlement, and a fractional explicit settle stays rejected", async () => {
	const h = sdkHarness(async (s) => { writeFix(s); s.emit(nAssistant()); });
	const st = await h.ad.openSession(openArgs(h));
	let idle = 0; st.session.waitForIdle = async () => { idle++; };
	const realNow = Date.now; let skew = 0; Date.now = () => realNow() + skew;
	st.session.prompt = async () => { skew += 5; }; // the whole 5 ms budget is spent inside the prompt
	try {
		const o = await h.ad.prompt(st, "p", { settle: { timeoutMs: 600000 }, budgetMs: 5 });
		assert.deepEqual([o.settlement.settled, o.settlement.timedOut, o.settlement.budgetExhausted], [false, true, true]);
		assert.equal(idle, 0, "no new 1 ms settle grant");
	} finally { Date.now = realNow; }
	await assert.rejects(h.ad.prompt(st, "p", { settle: { timeoutMs: 1.5 } }), /explicit timeout/);
});
