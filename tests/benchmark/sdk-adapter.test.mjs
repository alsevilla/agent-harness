// Pi SDK adapter against a fake SDK module (no Pi runtime load, no provider): options passed, event normalisation, compaction, reviewer tools.
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createPiSdkAdapter } from "./lib/sdk-adapter.mjs";
import { fixtureLimits, FakeAgentSessionRuntime } from "./fixtures/fake-runtime.mjs";

// catalog: qualified ids that exist; withAuth: providers with usable credentials; settings: profile defaults.
function fakeSdk(calls, { catalog = ["anthropic/claude-main", "anthropic/claude-haiku-5-5", "openai-codex/gpt-6-luna"], withAuth = ["anthropic", "openai-codex"], settings = { provider: "anthropic", model: "claude-main", thinking: "high" }, dropSubagent = false, dropControl = false, loaded = { agentsFiles: [], skills: [] }, agentDir = "/agent-dir", basePrompt = "BASE PROMPT", systemFile, promptOverride } = {}) {
	const session = {
		listeners: [],
		subscribe(l) { this.listeners.push(l); return () => {}; },
		emit(ev) { for (const l of this.listeners) l(ev); },
		async prompt() {
			if (calls.script) return calls.script(this);
			for (const l of this.listeners) {
				l({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "PRIVATE" } });
				l({ type: "message_end", message: { role: "user", content: "PRIVATE" } });
				l({ type: "message_end", message: { role: "assistant", usage: { input: 4, output: 2, cacheRead: 1, cacheWrite: 0, totalTokens: 7, cost: { input: 0.1, output: 0.1, cacheRead: 0, cacheWrite: 0, total: 0.2 } }, provider: "p", model: "m" } });
				l({ type: "tool_execution_end", toolName: "subagent", toolCallId: "1", isError: false, result: { details: { results: [{ agent: "debugger", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0.05, turns: 1, contextTokens: 2 } }] } } });
				l({ type: "tool_execution_end", toolName: "read", toolCallId: "2", isError: false, result: { details: {} } });
			}
		},
		getLastAssistantText: () => "FINDING high: x",
		async compact() { calls.compact++; return { summary: "S", tokensBefore: 123, usage: { input: 9, output: 9, cacheRead: 0, cacheWrite: 0, totalTokens: 18, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.01 } } }; },
		getContextUsage: () => ({ tokens: 5, contextWindow: 1000, percent: 0.5 }),
		systemPrompt: "abc",
		async bindExtensions(b) { calls.bound.push(b); },
		async waitForIdle() { calls.idle++; if (calls.idleHook) await calls.idleHook(); },
		async abort() { calls.aborted++; if (calls.abortHook) await calls.abortHook(); },
		async emitShutdown() { calls.order.push("session_shutdown"); if (calls.shutdownHook) await calls.shutdownHook(); },
		getActiveToolNames() { return this.active; },
		messages: [],
		dispose() { calls.order.push("dispose"); calls.disposed++; },
	};
	return {
		SessionManager: { inMemory: (cwd) => ({ kind: "memory", cwd }) },
		SettingsManager: {
			inMemory: (s) => ({ kind: "settings", settings: s }),
			create: (cwd, agentDir) => { calls.settingsCreate.push({ cwd, agentDir }); return { getDefaultProvider: () => settings.provider, getDefaultModel: () => settings.model, getDefaultThinkingLevel: () => settings.thinking }; },
		},
		ModelRuntime: { create: async () => ({ getModel: (p, id) => (catalog.includes(`${p}/${id}`) ? { provider: p, id } : undefined), hasConfiguredAuth: (p) => withAuth.includes(p) }) },
		DefaultResourceLoader: class { constructor(o) { calls.loader.push(o); this.o = o; } async reload() { calls.reloaded++; } getAppendSystemPrompt() { return this.o.appendSystemPrompt ?? []; } getAgentsFiles() { return { agentsFiles: loaded.agentsFiles }; } getSkills() { return { skills: loaded.skills, diagnostics: [] }; } getSystemPrompt() { return systemFile?.content; } getSystemPromptSource() { return systemFile ? { path: systemFile.path } : undefined; } getAppendSystemPromptSources() { return []; } },
		getAgentDir: () => agentDir,
		AgentSessionRuntime: class extends FakeAgentSessionRuntime { async dispose() { calls.order.push("shutdown"); await super.dispose(); } },
		async createAgentSession(opts) { calls.create.push(opts); const active = (opts.tools ?? ["read", "bash"]).filter((t) => !(dropSubagent && t === "subagent") && !(dropControl && t === "subagent_control")); return { session: Object.assign(session, { systemPrompt: promptOverride ?? `${typeof basePrompt === "function" ? basePrompt() : basePrompt}\n<cwd>\n${opts.cwd.replace(/\\/g, "/")}\n</cwd>`, model: opts.model, thinkingLevel: opts.thinkingLevel ?? "medium", active }) }; },
	};
}

const calls = () => ({ create: [], loader: [], compact: 0, disposed: 0, reloaded: 0, settingsCreate: [], bound: [], idle: 0, aborted: 0, order: [] });
const workspace = () => fs.mkdtempSync(path.join(os.tmpdir(), "bench-sdk-"));
const CAND = path.join(os.tmpdir(), "bench-sdk-candidate");
const RUNTIME = { root: CAND, extensions: [path.join(CAND, "agent/extensions/subagent/index.ts")], fingerprint: "fixture-runtime-1" };
const MAIN = { model: "anthropic/claude-main", fallbacks: [], thinking: "high", source: "profile default" };
const REVIEWER = { role: "reviewer", tier: "economy", model: "openai-codex/gpt-6-luna", fallbacks: ["anthropic/claude-haiku-5-5"], thinking: "high", tools: ["read", "grep", "find", "ls", "bash", "powershell"], source: "package roles.json role reviewer tier economy" };
const READ_ONLY = ["read", "grep", "find", "ls"];
// The candidate reviewer contract fixture (agent/agents/reviewer.md): frontmatter, then the body that must reach the session.
const CONTRACT_BODY = "You are the fixture reviewer contract.\n\nFinish with exactly one verdict.";
const CONTRACT_FILE = path.join(CAND, "agent", "agents", "reviewer.md");
fs.mkdirSync(path.dirname(CONTRACT_FILE), { recursive: true });
fs.writeFileSync(CONTRACT_FILE, `---\nname: reviewer\ndescription: fixture\ntools: read, search, execute\n---\n\n${CONTRACT_BODY}\n`);
const sha = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");

test("the main session uses the configured profile model and thinking, the candidate runtime and a replay cwd for tools", async () => {
	const c = calls();
	const ws = workspace();
	const ad = createPiSdkAdapter({ loadPi: async () => fakeSdk(c), piPackageRoot: "/pi" });
	const s = await ad.openSession({ cwd: ws, role: "main", compactionEnabled: false, taskId: "H1", runtime: RUNTIME, roleSpec: MAIN, limits: fixtureLimits() });
	const opts = c.create[0];
	assert.equal(opts.cwd, ws);
	assert.deepEqual(opts.sessionManager, { kind: "memory", cwd: ws });
	assert.deepEqual(opts.settingsManager.settings, { compaction: { enabled: false } });
	assert.equal(c.loader[0].noExtensions, true);
	assert.equal(c.loader[0].cwd, CAND, "discovery root is the candidate, never the replay");
	assert.deepEqual(c.loader[0].additionalExtensionPaths, RUNTIME.extensions);
	assert.deepEqual(opts.model, { provider: "anthropic", id: "claude-main" });
	assert.equal(opts.thinkingLevel, "high");
	assert.equal(s.identity.configured.model, "anthropic/claude-main");
	assert.equal(s.identity.selected.model, "anthropic/claude-main");
	assert.equal(s.identity.attempts.length, 1);
	assert.equal(c.reloaded, 1);
	await ad.closeSession(s);
	assert.equal(c.disposed, 1);
});

// C6: the main session is read-only plus native subagent dispatch (no edit or write); it refuses to open without active dispatch.
test("the main session is read-only plus native subagent dispatch; without an active subagent tool it refuses to open (infrastructure)", async () => {
	const c = calls();
	const ad = createPiSdkAdapter({ loadPi: async () => fakeSdk(c), piPackageRoot: "/pi" });
	const s = await ad.openSession({ cwd: workspace(), role: "main", compactionEnabled: false, taskId: "H1", runtime: RUNTIME, roleSpec: MAIN, limits: fixtureLimits() });
	assert.deepEqual(c.create[0].tools, [...READ_ONLY, "subagent", "subagent_control"]);
	assert.deepEqual((await ad.startContext(s)).activeTools, [...READ_ONLY, "subagent", "subagent_control"]);
	await ad.closeSession(s);
	const d = calls();
	const ad2 = createPiSdkAdapter({ loadPi: async () => fakeSdk(d, { dropSubagent: true }), piPackageRoot: "/pi" });
	await assert.rejects(ad2.openSession({ cwd: workspace(), role: "main", compactionEnabled: false, taskId: "H1", runtime: RUNTIME, roleSpec: MAIN, limits: fixtureLimits() }), (e) => /subagent/.test(e.message) && e.infrastructure === true);
	assert.equal(d.disposed, 1, "the session is disposed when dispatch is not active");
});

test("a reviewer session is read-only and loads no extensions; its prompt returns normalised events and the last assistant text", async () => {
	const c = calls();
	const ad = createPiSdkAdapter({ loadPi: async () => fakeSdk(c), piPackageRoot: "/pi" });
	const s = await ad.openSession({ cwd: workspace(), role: "review", compactionEnabled: false, taskId: "H1", runtime: RUNTIME, roleSpec: REVIEWER });
	assert.deepEqual(c.create[0].tools, ["read", "grep", "find", "ls"]);
	assert.deepEqual(c.loader[0].additionalExtensionPaths, []);
	const r = await ad.prompt(s, "review it");
	assert.equal(r.text, "FINDING high: x");
	assert.deepEqual(r.events.map((e) => e.kind ?? e.type), ["assistant", "subagent", "tool"]);
	assert.deepEqual(r.events.at(-1), { type: "tool", name: "read", isError: false, errorText: null });
	assert.equal(r.events[0].message.usage.cost.total, 0.2);
	assert.equal(r.events[1].details.results[0].agent, "debugger");
	assert.ok(!JSON.stringify(r.events).includes("PRIVATE"), "no message text leaves the adapter");
});

test("start context and manual compaction come from the SDK's public session members; a missing compaction usage stays null", async () => {
	const c = calls();
	const ad = createPiSdkAdapter({ loadPi: async () => fakeSdk(c), piPackageRoot: "/pi" });
	const s = await ad.openSession({ cwd: workspace(), role: "main", compactionEnabled: false, taskId: "H1", runtime: RUNTIME, roleSpec: MAIN, limits: fixtureLimits() });
	assert.deepEqual(await ad.startContext(s), { contextTokens: 5, contextWindow: 1000, systemPromptChars: s.session.systemPrompt.length, activeTools: ["read", "grep", "find", "ls", "subagent", "subagent_control"], messageCount: 0 });
	const k = await ad.compact(s);
	assert.equal(c.compact, 1);
	assert.equal(k.tokensBefore, 123);
	assert.equal(k.usage.cost.total, 0.01);
});

test("without a Pi package root the adapter refuses to open any session (fail closed)", async () => {
	const ad = createPiSdkAdapter({});
	await assert.rejects(ad.openSession({ cwd: workspace(), role: "main", compactionEnabled: false, taskId: "H1", runtime: RUNTIME, roleSpec: MAIN, limits: fixtureLimits() }), /piPackageRoot is required/);
});

test("the adapter describes itself as a live SDK adapter and does not load Pi at import or construction time", () => {
	let loaded = false;
	const ad = createPiSdkAdapter({ loadPi: async () => { loaded = true; return fakeSdk(calls()); }, piPackageRoot: "/pi" });
	assert.equal(loaded, false);
	assert.equal(ad.describe().name, "pi-sdk");
	assert.equal(ad.describe().synthetic, false);
});

test("the reviewer session uses the reviewer role's model and thinking, read-only tools and no extensions; never the main model", async () => {
	const c = calls();
	const ad = createPiSdkAdapter({ loadPi: async () => fakeSdk(c), piPackageRoot: "/pi" });
	const s = await ad.openSession({ cwd: workspace(), role: "review", compactionEnabled: false, taskId: "H1", runtime: RUNTIME, roleSpec: REVIEWER });
	const opts = c.create[0];
	assert.deepEqual(opts.model, { provider: "openai-codex", id: "gpt-6-luna" });
	assert.equal(opts.thinkingLevel, "high");
	assert.deepEqual(opts.tools, READ_ONLY, "the role's bash and powershell are excluded: reviewer is read-only");
	assert.equal(c.loader[0].noExtensions, true);
	assert.deepEqual(c.loader[0].additionalExtensionPaths, []);
	assert.equal(c.loader[0].noContextFiles, true, "the reviewer never reads replay context files");
	assert.match(c.loader[0].appendSystemPrompt[0], /reviewer/);
	assert.equal(s.identity.selected.model, "openai-codex/gpt-6-luna");
	assert.equal(s.identity.configured.thinking, "high");
	assert.equal(s.identity.observed.thinking, "high");
	await ad.closeSession(s);
});

test("reviewer fallback: an unavailable primary falls through to the next configured model, and the attempts are recorded", async () => {
	const c = calls();
	const ad = createPiSdkAdapter({ loadPi: async () => fakeSdk(c, { catalog: ["anthropic/claude-haiku-5-5"], withAuth: ["anthropic"] }), piPackageRoot: "/pi" });
	const s = await ad.openSession({ cwd: workspace(), role: "review", compactionEnabled: false, taskId: "H1", runtime: RUNTIME, roleSpec: REVIEWER });
	assert.deepEqual(c.create[0].model, { provider: "anthropic", id: "claude-haiku-5-5" });
	assert.deepEqual(s.identity.attempts, [
		{ model: "openai-codex/gpt-6-luna", status: "not in catalog" },
		{ model: "anthropic/claude-haiku-5-5", status: "selected" },
	]);
	assert.equal(s.identity.selected.model, "anthropic/claude-haiku-5-5");
	await ad.closeSession(s);
});

test("no usable model in the chain is an honest refusal: no session is created and no model is chosen silently", async () => {
	const c = calls();
	const ad = createPiSdkAdapter({ loadPi: async () => fakeSdk(c, { withAuth: [] }), piPackageRoot: "/pi" });
	await assert.rejects(ad.openSession({ cwd: workspace(), role: "review", compactionEnabled: false, taskId: "H1", runtime: RUNTIME, roleSpec: REVIEWER }), /no usable model.*openai-codex\/gpt-6-luna/s);
	assert.equal(c.create.length, 0);
});

test("the configured main is resolved from the profile default registry; a missing default is refused, not replaced", async () => {
	const c = calls();
	const ad = createPiSdkAdapter({ loadPi: async () => fakeSdk(c), piPackageRoot: "/pi" });
	const main = await ad.resolveMainSpec({ candidateRoot: CAND });
	assert.equal(main.model, "anthropic/claude-main");
	assert.deepEqual(main.fallbacks, []);
	assert.equal(main.thinking, "high");
	assert.match(main.source, /profile default/);
	assert.deepEqual(c.settingsCreate[0], { cwd: CAND, agentDir: "/agent-dir" });
	const none = createPiSdkAdapter({ loadPi: async () => fakeSdk(calls(), { settings: { provider: undefined, model: undefined, thinking: undefined } }), piPackageRoot: "/pi" });
	await assert.rejects(none.resolveMainSpec({ candidateRoot: CAND }), /no default model/);
});

test("observed identity: the served model and provider come from assistant message events; served thinking is unknown", async () => {
	const c = calls();
	const ad = createPiSdkAdapter({ loadPi: async () => fakeSdk(c), piPackageRoot: "/pi" });
	const s = await ad.openSession({ cwd: workspace(), role: "main", compactionEnabled: false, taskId: "H1", runtime: RUNTIME, roleSpec: MAIN, limits: fixtureLimits() });
	const r = await ad.prompt(s, "do it", { settle: { timeoutMs: 1000 } });
	assert.deepEqual(r.events.filter((e) => e.type === "assistant").map((e) => [e.message.provider, e.message.model]), [["p", "m"]]);
	assert.equal(s.identity.observed.thinking, "high", "session thinking as reported by the SDK");
	assert.equal(s.identity.servedThinking, "unknown", "served thinking is not certified");
});

test("the reviewer session appends the full candidate reviewer contract verbatim and records its digests and the explicit execution method", async () => {
	const c = calls();
	const ad = createPiSdkAdapter({ loadPi: async () => fakeSdk(c), piPackageRoot: "/pi" });
	const s = await ad.openSession({ cwd: workspace(), role: "review", compactionEnabled: false, taskId: "H1", runtime: RUNTIME, roleSpec: REVIEWER });
	assert.ok(c.loader[0].appendSystemPrompt.includes(CONTRACT_BODY), "the contract body is appended verbatim, not replaced by an identity line");
	const contract = s.identity.contract;
	assert.equal(contract.file, CONTRACT_FILE);
	assert.equal(contract.sha256, sha(fs.readFileSync(CONTRACT_FILE)), "digest of the whole contract file");
	assert.equal(contract.bodySha256, sha(CONTRACT_BODY), "digest of the body that reaches the session");
	assert.equal(contract.appendLoaded, true, "the loader's effective append list carries the body");
	assert.equal(contract.execution, "sdk-isolated-session-role-contract");
	assert.equal(contract.nativeDispatch, false, "never claims native named dispatch");
	await ad.closeSession(s);
});

test("reviewer tools are the declared registry tools restricted to read-only; bash and powershell are recorded as excluded", async () => {
	const c = calls();
	const ad = createPiSdkAdapter({ loadPi: async () => fakeSdk(c), piPackageRoot: "/pi" });
	const s = await ad.openSession({ cwd: workspace(), role: "review", compactionEnabled: false, taskId: "H1", runtime: RUNTIME, roleSpec: REVIEWER });
	assert.deepEqual(c.create[0].tools, READ_ONLY);
	assert.deepEqual(s.identity.contract.tools, { declared: ["read", "grep", "find", "ls", "bash", "powershell"], session: READ_ONLY, excluded: ["bash", "powershell"] });
	await ad.closeSession(s);
});

test("the reviewer prompt references the installed review guidance by absolute path and records whether it is present", async () => {
	const c = calls();
	const ad = createPiSdkAdapter({ loadPi: async () => fakeSdk(c), piPackageRoot: "/pi" });
	const s = await ad.openSession({ cwd: workspace(), role: "review", compactionEnabled: false, taskId: "H1", runtime: RUNTIME, roleSpec: REVIEWER });
	const ref = s.identity.contract.moduleReference;
	assert.equal(ref.path, path.join("/agent-dir", "skills", "engineering-harness", "review", "index.md"));
	assert.equal(ref.present, false, "absent fixture guidance is recorded as absent, not guessed");
	assert.ok(c.loader[0].appendSystemPrompt.some((line) => line.includes(ref.path)));
	await ad.closeSession(s);
});

test("a reviewer without its candidate contract is refused before any session is created", async () => {
	const c = calls();
	const ad = createPiSdkAdapter({ loadPi: async () => fakeSdk(c), piPackageRoot: "/pi" });
	const runtime = { ...RUNTIME, root: path.join(os.tmpdir(), "bench-sdk-no-contract") };
	await assert.rejects(ad.openSession({ cwd: workspace(), role: "review", compactionEnabled: false, taskId: "H1", runtime, roleSpec: REVIEWER }), /reviewer contract is missing/);
	assert.equal(c.create.length, 0);
});

// --- Oracle R4/R5/R6: lifecycle binding, event-driven settlement, shutdown confirmation, control tools, resource shadowing ---
const mkAdapter = (c, sdk) => createPiSdkAdapter({ loadPi: async () => fakeSdk(c, sdk), piPackageRoot: "/pi" });
const open = (ad, over = {}) => ad.openSession({ cwd: workspace(), role: "main", compactionEnabled: false, taskId: "H1", runtime: RUNTIME, roleSpec: MAIN, limits: fixtureLimits(), ...over });
const receipt = (jobId) => ({ type: "tool_execution_end", toolName: "subagent", toolCallId: `call-${jobId}`, isError: false, result: { content: [{ type: "text", text: `Started background job ${jobId}.` }], details: { mode: "single", results: [], jobId, background: true } } });
const completionMsg = (jobId, state = "completed", results = [{ agent: "general-worker", exitCode: 0, usage: { turns: 1, input: 3, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0.02 } }]) => ({ type: "message_end", message: { role: "custom", customType: "subagent-completion", content: `Subagent job ${jobId} ${state}.`, display: false, details: { jobId, state, results } } });

test("the session lifecycle is bound through the runtime: bindExtensions once at open, and close emits session_shutdown before the session is disposed", async () => {
	const c = calls();
	const ad = mkAdapter(c);
	const s = await open(ad);
	assert.equal(c.bound.length, 1, "session_start is only emitted by bindExtensions");
	assert.equal(c.disposed, 0);
	const closed = await ad.closeSession(s);
	assert.deepEqual(c.order, ["shutdown", "session_shutdown", "dispose"]);
	assert.equal(closed.confirmed, true);
});

test("without an AgentSessionRuntime export the main session is refused (shutdown could not be confirmed)", async () => {
	const c = calls();
	const sdk = fakeSdk(c);
	delete sdk.AgentSessionRuntime;
	await assert.rejects(open(createPiSdkAdapter({ loadPi: async () => sdk, piPackageRoot: "/pi" })), (e) => /AgentSessionRuntime/.test(e.message) && e.infrastructure === true && e.kind === "lifecycle_unavailable");
	assert.equal(c.disposed, 1);
});

test("both native controls must be active in the main session; a missing subagent_control refuses to open and shuts the session down", async () => {
	const c = calls();
	await assert.rejects(open(mkAdapter(c, { dropControl: true })), (e) => /subagent_control/.test(e.message) && e.infrastructure === true);
	assert.deepEqual(c.order, ["shutdown", "session_shutdown", "dispose"]);
	assert.ok(![...c.create[0].tools].some((t) => t === "edit" || t === "write"), "no edit or write tool for the main");
});

test("a subagent call keeps isError, its text and the background/jobId/mode marks; a completion notice yields per-worker metadata and no notice text", async () => {
	const c = calls();
	const ad = mkAdapter(c);
	const s = await open(ad);
	c.script = async (sess) => {
		sess.emit({ type: "tool_execution_end", toolName: "subagent", toolCallId: "r1", isError: true, result: { content: [{ type: "text", text: "Invalid modelTier: nothing was launched." }], details: { mode: "single", results: [] } } });
		sess.emit(receipt("bg-1"));
		sess.emit(completionMsg("bg-1"));
	};
	const r = await ad.prompt(s, "go", { settle: { timeoutMs: 1000 } });
	const [refusal, rcpt, done] = r.events;
	assert.deepEqual([refusal.type, refusal.isError, refusal.text, refusal.details.results], ["subagent", true, "Invalid modelTier: nothing was launched.", []]);
	assert.deepEqual([rcpt.isError, rcpt.details.background, rcpt.details.jobId, rcpt.details.mode, rcpt.text], [false, true, "bg-1", "single", "Started background job bg-1."]);
	assert.deepEqual([done.type, done.jobId, done.state, done.results[0].usage.cost], ["completion", "bg-1", "completed", 0.02]);
	assert.ok(!JSON.stringify(done).includes("Subagent job bg-1 completed"), "the model-visible notice content is never copied");
	assert.equal(r.settlement.settled, true);
});

test("a late completion after the prompt and a second job it launches are both counted and waited for (event driven, no snapshot until quiescent)", async () => {
	const c = calls();
	const ad = mkAdapter(c);
	const s = await open(ad);
	c.script = async (sess) => {
		sess.emit(receipt("bg-1"));
		// After prompt() returns: bg-1 completes, its completion turn launches bg-2, which completes later.
		setTimeout(() => { sess.emit(completionMsg("bg-1")); sess.emit(receipt("bg-2")); }, 15);
		setTimeout(() => sess.emit(completionMsg("bg-2")), 45);
	};
	const t0 = Date.now();
	const r = await ad.prompt(s, "go", { settle: { timeoutMs: 5000 } });
	assert.ok(Date.now() - t0 >= 40, "waited for the second job, not only the first");
	assert.deepEqual(r.events.filter((e) => e.type === "completion").map((e) => e.jobId), ["bg-1", "bg-2"]);
	assert.deepEqual(r.settlement, { settled: true, timedOut: false, pendingJobs: [], waitedMs: r.settlement.waitedMs });
	assert.equal(c.aborted, 0);
});

test("a receipt that never completes times out at the configured limit: the run is aborted, the pending job is reported, and close cancels through shutdown", async () => {
	const c = calls();
	const ad = mkAdapter(c);
	const s = await open(ad);
	c.script = async (sess) => { sess.emit(receipt("bg-1")); };
	const r = await ad.prompt(s, "go", { settle: { timeoutMs: 30 } });
	assert.equal(r.settlement.timedOut, true);
	assert.equal(r.settlement.settled, false);
	assert.deepEqual(r.settlement.pendingJobs, ["bg-1"]);
	assert.equal(c.aborted, 1, "the main run is stopped");
	const closed = await ad.closeSession(s);
	assert.deepEqual(closed.pendingJobs, ["bg-1"]);
	assert.equal(closed.confirmed, true);
	assert.deepEqual(c.order.slice(-2), ["session_shutdown", "dispose"]);
});

test("settlement needs an explicit timeout: there is no literal default", async () => {
	const ad = mkAdapter(calls());
	const s = await open(ad);
	await assert.rejects(ad.prompt(s, "go"), /explicit timeout/);
});

test("a shutdown that does not finish within the configured grace is not confirmed", async () => {
	const c = calls();
	const ad = mkAdapter(c);
	const s = await open(ad, { limits: { roundSettleTimeoutMs: { value: 1000, source: "t" }, shutdownGraceMs: { value: 20, source: "t" } } });
	c.shutdownHook = () => new Promise((resolve) => setTimeout(resolve, 200));
	const closed = await ad.closeSession(s);
	assert.equal(closed.confirmed, false);
});

test("a main session without a configured shutdown grace is refused (no literal grace)", async () => {
	await assert.rejects(open(mkAdapter(calls()), { limits: { roundSettleTimeoutMs: { value: 1000, source: "t" } } }), /limits\.shutdownGraceMs/);
});

test("resources the session really loaded are recorded; a candidate AGENTS.md or skill that a profile copy shadows refuses to open (infrastructure)", async () => {
	const cand = fs.mkdtempSync(path.join(os.tmpdir(), "bench-res-"));
	fs.mkdirSync(path.join(cand, "agent", "skills", "alpha"), { recursive: true });
	fs.writeFileSync(path.join(cand, "agent", "AGENTS.md"), "candidate policy");
	fs.writeFileSync(path.join(cand, "agent", "skills", "alpha", "SKILL.md"), "candidate skill");
	const profileSkill = path.join(workspace(), "alpha", "SKILL.md");
	fs.mkdirSync(path.dirname(profileSkill), { recursive: true });
	fs.writeFileSync(profileSkill, "candidate skill");
	const runtime = { ...RUNTIME, root: cand };
	const good = { agentsFiles: [{ path: "/agent-dir/AGENTS.md", content: "candidate policy" }], skills: [{ name: "alpha", filePath: profileSkill }] };
	const s = await open(mkAdapter(calls(), { loaded: good }), { runtime });
	assert.deepEqual(s.identity.resources.agentsFiles, [{ path: "/agent-dir/AGENTS.md", sha256: sha("candidate policy") }]);
	assert.deepEqual(s.identity.resources.skills, [{ name: "alpha", filePath: profileSkill }]);
	const c = calls();
	await assert.rejects(open(mkAdapter(c, { loaded: { ...good, agentsFiles: [{ path: "/agent-dir/AGENTS.md", content: "profile policy" }] } }), { runtime }), (e) => /shadow/.test(e.message) && e.infrastructure === true && e.kind === "resource_shadowing");
	assert.equal(c.create.length, 0, "no session is created from shadowed resources");
	fs.writeFileSync(profileSkill, "different profile skill");
	await assert.rejects(open(mkAdapter(calls(), { loaded: good }), { runtime }), /agent\/skills\/alpha\/SKILL\.md/);
});

// --- Oracle F1: the foreground run is aborted and awaited to idle (its children closed) before shutdown is confirmed ---
test("close aborts the main session and awaits its idle before the extension shutdown handlers and disposal run", async () => {
	const c = calls();
	const ad = mkAdapter(c);
	const s = await open(ad);
	let abortDone = false;
	c.abortHook = async () => { await new Promise((r) => setTimeout(r, 40)); abortDone = true; };
	c.shutdownHook = () => { c.order.push(abortDone ? "after-abort" : "before-abort"); };
	const closed = await ad.closeSession(s);
	assert.equal(closed.confirmed, true);
	assert.deepEqual(c.order, ["shutdown", "session_shutdown", "after-abort", "dispose"], "abort settled before the shutdown handlers");
});

test("a foreground abort that never reaches idle within the grace is an unconfirmed shutdown", async () => {
	const c = calls();
	const ad = mkAdapter(c);
	const s = await open(ad, { limits: { roundSettleTimeoutMs: { value: 1000, source: "t" }, shutdownGraceMs: { value: 20, source: "t" } } });
	c.abortHook = () => new Promise((r) => setTimeout(r, 300));
	assert.equal((await ad.closeSession(s)).confirmed, false);
});

// --- Oracle F3: the fixed reviewer's effective prompt and resource identity ---
function reviewerFixture() {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bench-rev-"));
	const guide = path.join(dir, "skills", "engineering-harness", "review");
	fs.mkdirSync(path.join(guide, "references"), { recursive: true });
	fs.writeFileSync(path.join(guide, "index.md"), "review guidance v1");
	fs.writeFileSync(path.join(guide, "references", "extended.md"), "extended v1");
	const skillFile = path.join(dir, "skills", "alpha", "SKILL.md");
	fs.mkdirSync(path.dirname(skillFile), { recursive: true });
	fs.writeFileSync(skillFile, "skill v1");
	const system = { path: path.join(dir, "SYSTEM.md"), content: "profile system v1" };
	return { dir, guide, skillFile, system };
}
const resourcesOf = async (c, f, sdk) => { const ad = mkAdapter(c, { agentDir: f.dir, systemFile: f.system, loaded: { agentsFiles: [], skills: [{ name: "alpha", description: "d", filePath: f.skillFile }] }, ...sdk }); const s = await ad.openSession({ cwd: workspace(), role: "review", compactionEnabled: false, taskId: "H1", runtime: RUNTIME, roleSpec: REVIEWER }); await ad.closeSession(s); return s.identity.contract.resources; };

test("the reviewer resource identity hashes the effective prompt and every loaded resource; cwd alone never changes the semantic hashes and no prompt text is stored", async () => {
	const f = reviewerFixture();
	const a = await resourcesOf(calls(), f), b = await resourcesOf(calls(), f);
	assert.match(a.effectivePromptSha256, /^[0-9a-f]{64}$/);
	assert.match(a.resourcesSha256, /^[0-9a-f]{64}$/);
	assert.equal(a.effectivePromptSha256, b.effectivePromptSha256, "a different replay cwd does not change the semantic prompt hash");
	assert.equal(a.resourcesSha256, b.resourcesSha256);
	assert.notEqual(a.promptSha256, b.promptSha256, "the raw prompt digest keeps the cwd for audit");
	assert.equal(a.stable, true);
	assert.doesNotMatch(JSON.stringify(a), /BASE PROMPT|profile system v1|review guidance v1/);
});

test("changed review guidance (index or referenced file), profile SYSTEM.md, skill content or base prompt each change the reviewer identity", async () => {
	const f = reviewerFixture();
	const base = await resourcesOf(calls(), f);
	fs.writeFileSync(path.join(f.guide, "index.md"), "review guidance v2");
	assert.notEqual((await resourcesOf(calls(), f)).resourcesSha256, base.resourcesSha256, "guidance index");
	fs.writeFileSync(path.join(f.guide, "index.md"), "review guidance v1");
	fs.writeFileSync(path.join(f.guide, "references", "extended.md"), "extended v2");
	assert.notEqual((await resourcesOf(calls(), f)).resourcesSha256, base.resourcesSha256, "referenced guidance");
	fs.writeFileSync(path.join(f.guide, "references", "extended.md"), "extended v1");
	fs.writeFileSync(f.skillFile, "skill v2");
	assert.notEqual((await resourcesOf(calls(), f)).resourcesSha256, base.resourcesSha256, "skill content");
	fs.writeFileSync(f.skillFile, "skill v1");
	assert.notEqual((await resourcesOf(calls(), f, { systemFile: { ...f.system, content: "profile system v2" } })).resourcesSha256, base.resourcesSha256, "SYSTEM.md");
	assert.notEqual((await resourcesOf(calls(), f, { basePrompt: "OTHER BASE PROMPT" })).effectivePromptSha256, base.effectivePromptSha256, "base prompt");
});

test("a resource edited between open and close is recorded as unstable; a prompt without the known cwd section has no semantic hash", async () => {
	const f = reviewerFixture();
	const ad = mkAdapter(calls(), { agentDir: f.dir, systemFile: f.system });
	const s = await ad.openSession({ cwd: workspace(), role: "review", compactionEnabled: false, taskId: "H1", runtime: RUNTIME, roleSpec: REVIEWER });
	fs.writeFileSync(path.join(f.guide, "index.md"), "edited during the review");
	await ad.closeSession(s);
	assert.equal(s.identity.contract.resources.stable, false);
	assert.notEqual(s.identity.contract.resources.endResourcesSha256, s.identity.contract.resources.resourcesSha256);
	const odd = await resourcesOf(calls(), reviewerFixture(), { promptOverride: "a prompt with no known cwd section" });
	assert.equal(odd.effectivePromptSha256, null, "no arbitrary text is stripped: an unknown prompt shape is unidentified");
});
