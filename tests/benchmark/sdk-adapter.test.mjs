// Pi SDK adapter against a fake SDK module (no Pi runtime load, no provider): options passed, event normalisation, compaction, reviewer tools.
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createPiSdkAdapter } from "./lib/sdk-adapter.mjs";

// catalog: qualified ids that exist; withAuth: providers with usable credentials; settings: profile defaults.
function fakeSdk(calls, { catalog = ["anthropic/claude-main", "anthropic/claude-haiku-5-5", "openai-codex/gpt-6-luna"], withAuth = ["anthropic", "openai-codex"], settings = { provider: "anthropic", model: "claude-main", thinking: "high" }, dropSubagent = false } = {}) {
	const session = {
		listeners: [],
		subscribe(l) { this.listeners.push(l); return () => {}; },
		async prompt() {
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
		getActiveToolNames() { return this.active; },
		messages: [],
		dispose() { calls.disposed++; },
	};
	return {
		SessionManager: { inMemory: (cwd) => ({ kind: "memory", cwd }) },
		SettingsManager: {
			inMemory: (s) => ({ kind: "settings", settings: s }),
			create: (cwd, agentDir) => { calls.settingsCreate.push({ cwd, agentDir }); return { getDefaultProvider: () => settings.provider, getDefaultModel: () => settings.model, getDefaultThinkingLevel: () => settings.thinking }; },
		},
		ModelRuntime: { create: async () => ({ getModel: (p, id) => (catalog.includes(`${p}/${id}`) ? { provider: p, id } : undefined), hasConfiguredAuth: (p) => withAuth.includes(p) }) },
		DefaultResourceLoader: class { constructor(o) { calls.loader.push(o); this.o = o; } async reload() { calls.reloaded++; } getAppendSystemPrompt() { return this.o.appendSystemPrompt ?? []; } },
		getAgentDir: () => "/agent-dir",
		async createAgentSession(opts) { calls.create.push(opts); const active = (opts.tools ?? ["read", "bash"]).filter((t) => !(dropSubagent && t === "subagent")); return { session: Object.assign(session, { model: opts.model, thinkingLevel: opts.thinkingLevel ?? "medium", active }) }; },
	};
}

const calls = () => ({ create: [], loader: [], compact: 0, disposed: 0, reloaded: 0, settingsCreate: [] });
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
	const s = await ad.openSession({ cwd: ws, role: "main", compactionEnabled: false, taskId: "H1", runtime: RUNTIME, roleSpec: MAIN });
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
	const s = await ad.openSession({ cwd: workspace(), role: "main", compactionEnabled: false, taskId: "H1", runtime: RUNTIME, roleSpec: MAIN });
	assert.deepEqual(c.create[0].tools, [...READ_ONLY, "subagent"]);
	assert.deepEqual((await ad.startContext(s)).activeTools, [...READ_ONLY, "subagent"]);
	await ad.closeSession(s);
	const d = calls();
	const ad2 = createPiSdkAdapter({ loadPi: async () => fakeSdk(d, { dropSubagent: true }), piPackageRoot: "/pi" });
	await assert.rejects(ad2.openSession({ cwd: workspace(), role: "main", compactionEnabled: false, taskId: "H1", runtime: RUNTIME, roleSpec: MAIN }), (e) => /subagent/.test(e.message) && e.infrastructure === true);
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
	const s = await ad.openSession({ cwd: workspace(), role: "main", compactionEnabled: false, taskId: "H1", runtime: RUNTIME, roleSpec: MAIN });
	assert.deepEqual(await ad.startContext(s), { contextTokens: 5, contextWindow: 1000, systemPromptChars: 3, activeTools: ["read", "grep", "find", "ls", "subagent"], messageCount: 0 });
	const k = await ad.compact(s);
	assert.equal(c.compact, 1);
	assert.equal(k.tokensBefore, 123);
	assert.equal(k.usage.cost.total, 0.01);
});

test("without a Pi package root the adapter refuses to open any session (fail closed)", async () => {
	const ad = createPiSdkAdapter({});
	await assert.rejects(ad.openSession({ cwd: workspace(), role: "main", compactionEnabled: false, taskId: "H1", runtime: RUNTIME, roleSpec: MAIN }), /piPackageRoot is required/);
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
	const s = await ad.openSession({ cwd: workspace(), role: "main", compactionEnabled: false, taskId: "H1", runtime: RUNTIME, roleSpec: MAIN });
	const r = await ad.prompt(s, "do it");
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
