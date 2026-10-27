// Candidate runtime identity: the measured extensions come from the candidate package, never from the replayed parent.
// Sentinel extensions are declared by each task's replayed package.json; they must never load, in any mode.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { candidateRuntime } from "./lib/runtime.mjs";
import { createPiSdkAdapter as realCreatePiSdkAdapter } from "./lib/sdk-adapter.mjs";
import { okTopology, fixtureTopology } from "./fixtures/topology-fixture.mjs";
// These suites drive a FAKE SDK, so the agent topology proof is injected at the adapter boundary (the real check needs the installed SDK; topology*.test.mjs run it for real).
const createPiSdkAdapter = (o = {}) => realCreatePiSdkAdapter({ topology: okTopology, ...o });
import { runBenchmark } from "./lib/runner.mjs";
import { task, manifest, root, fakeWorkspace, gate, fixtureLimits, FakeAgentSessionRuntime } from "./fixtures/fake-runtime.mjs";

const tmp = (name) => fs.mkdtempSync(path.join(os.tmpdir(), `bench-rt-${name}-`));
const EXT = ["./agent/extensions/subagent/index.ts", "./agent/extensions/ask-user/index.ts"];

function candidate() {
	const dir = tmp("cand");
	fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ pi: { extensions: EXT } }, null, 2));
	for (const rel of EXT) fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }), fs.writeFileSync(path.join(dir, rel), `// ${rel}\n`);
	fs.mkdirSync(path.join(dir, "agent", "agents"), { recursive: true });
	fs.writeFileSync(path.join(dir, "agent", "agents", "reviewer.md"), "---\nname: reviewer\ndescription: fixture\n---\n\nFixture reviewer contract.\n");
	fs.writeFileSync(path.join(dir, "agent", "agents", "general-worker.md"), "---\nname: general-worker\ndescription: fixture\n---\n\nFixture writer.\n"); // the registered writer role the fake foreground result names
	return dir;
}

// Fake SDK: records every loader, session and prompt; a prompt writes the fixed work file into the session cwd like a worker would.
function fakeSdk(rec) {
	const catalog = new Set(["anthropic/claude-main", "openai-codex/gpt-6-luna"]);
	return {
		ModelRuntime: { create: async () => ({ getModel: (p, id) => (catalog.has(`${p}/${id}`) ? { provider: p, id } : undefined), hasConfiguredAuth: () => true }) },
		SettingsManager: {
			create: () => ({ getDefaultProvider: () => "anthropic", getDefaultModel: () => "claude-main", getDefaultThinkingLevel: () => "high" }),
			inMemory: (settings) => ({ settings }),
		},
		SessionManager: { inMemory: (cwd) => ({ cwd }) },
		DefaultResourceLoader: class { constructor(o) { rec.loaders.push(o); this.o = o; } async reload() {} getAppendSystemPrompt() { return this.o.appendSystemPrompt ?? []; } },
		getAgentDir: () => "/agent-dir",
		AgentSessionRuntime: FakeAgentSessionRuntime,
		async createAgentSession(opts) {
			rec.sessions.push(opts);
			const listeners = [];
			let last = "";
			const session = {
				model: opts.model, thinkingLevel: opts.thinkingLevel ?? "medium", systemPrompt: "sys", messages: [],
				subscribe(l) { listeners.push(l); return () => {}; },
				async bindExtensions() {},
				async waitForIdle() {},
				getActiveToolNames: () => opts.tools ?? ["read", "bash", "edit", "write"],
				getContextUsage: () => ({ tokens: 1, contextWindow: 10 }),
				async prompt(text) {
					const isReview = text.startsWith("REVIEW");
					const pkg = JSON.parse(fs.readFileSync(path.join(opts.cwd, "package.json"), "utf8"));
					rec.prompts.push({ cwd: opts.cwd, role: isReview ? "review" : "main", text: text.slice(0, 12), declared: pkg.pi?.extensions ?? [] });
					if (!isReview) fs.mkdirSync(path.join(opts.cwd, "agent"), { recursive: true }), fs.writeFileSync(path.join(opts.cwd, "agent", "work.txt"), "fixed");
					last = isReview ? "NO FINDINGS" : "done";
					// The main session delegates implementation to the writer role (native subagent event), as the method requires.
					if (!isReview) for (const l of listeners) l({ type: "tool_execution_end", toolName: "subagent", toolCallId: "w", isError: false, result: { details: { mode: "single", results: [{ agent: "general-worker", exitCode: 0, usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 1, contextTokens: 1 } }] } } });
					for (const l of listeners) l({ type: "message_end", message: { role: "assistant", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { total: 0.01, cacheRead: 0, cacheWrite: 0 } }, provider: opts.model.provider, model: opts.model.id } });
				},
				getLastAssistantText: () => last,
				async compact() { return { tokensBefore: 5, usage: null }; },
				dispose() {},
			};
			return { session };
		},
	};
}

const roles = {
	main: { model: "anthropic/claude-main", fallbacks: [], thinking: "high", source: "fixture profile default" },
	reviewer: { role: "reviewer", tier: "economy", model: "openai-codex/gpt-6-luna", fallbacks: ["anthropic/claude-haiku-5-5"], thinking: "high", tools: ["read", "grep", "find", "ls", "bash", "powershell"], source: "fixture reviewer" },
};

// Sentinel workspace: each task's replayed package.json declares a different extension that must never be loaded.
function sentinelWorkspace(base) {
	const inner = fakeWorkspace(base);
	return { ...inner, async prepare(t, dir) { await inner.prepare(t, dir); fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ pi: { extensions: [`./sentinel-${t.id}.ts`] } })); } };
}

for (const mode of ["fresh", "long-fixed", "long-compacted"]) {
	test(`${mode}: the measured runtime is the candidate package for every session; replay sentinels never load; candidate unchanged`, async () => {
		const cand = candidate();
		const runtime = candidateRuntime({ candidateRoot: cand });
		const rec = { loaders: [], sessions: [], prompts: [] };
		const scratch = root();
		const result = await runBenchmark({
			manifest: manifest([task("H1"), task("H2")]), mode, adapter: createPiSdkAdapter({ loadPi: async () => fakeSdk(rec), piPackageRoot: "/pi" }),
			workspace: sentinelWorkspace(scratch), acceptance: gate,
			config: { limits: fixtureLimits(), maxReworkRounds: { value: 0, source: "fixture" }, diagnosticChars: { value: 300, source: "fixture" }, roles, runtime, topology: fixtureTopology(), recheckRuntime: () => candidateRuntime({ candidateRoot: cand }).fingerprint },
		});
		assert.equal(result.status, "complete", result.error);
		const absExt = EXT.map((e) => path.join(cand, e));
		// Main loaders carry the candidate extensions; reviewer loaders carry none. Fresh opens one main session per task, long modes one.
		const mains = rec.loaders.filter((l) => l.additionalExtensionPaths.length > 0);
		assert.equal(mains.length, mode === "fresh" ? 2 : 1);
		for (const l of mains) {
			assert.equal(l.cwd, cand, "loader discovery root is the candidate, not the replay");
			assert.deepEqual(l.additionalExtensionPaths, absExt);
		}
		assert.ok(rec.loaders.every((l) => !JSON.stringify(l).includes("sentinel")), "no replay sentinel extension is ever loaded");
		// Tools and writes target the task replay: fresh per task, the shared directory in the long modes.
		const shared = mode !== "fresh";
		for (const p of rec.prompts.filter((p) => p.role === "main")) assert.ok(shared ? p.cwd.endsWith(path.join(mode, "shared")) : /H[12]$/.test(p.cwd), `tool cwd ${p.cwd}`);
		// Each task's first prompt sees its own replayed declaration (current files, even in the long modes).
		const firstByTask = rec.prompts.filter((p) => p.role === "main" && p.text.startsWith("Harness task"));
		assert.deepEqual(firstByTask.map((p) => p.declared), [["./sentinel-H1.ts"], ["./sentinel-H2.ts"]]);
		// Identical measured runtime identity across tasks and modes, unchanged after the run.
		assert.equal(result.config.runtime.fingerprint, runtime.fingerprint);
		assert.equal(result.config.runtime.endFingerprint, runtime.fingerprint);
		assert.deepEqual(result.config.runtime.extensions, EXT);
	});
}

test("the candidate runtime fingerprint covers the extension sources and changes when they change", () => {
	const cand = candidate();
	const a = candidateRuntime({ candidateRoot: cand });
	assert.match(a.fingerprint, /^[0-9a-f]{64}$/);
	assert.equal(candidateRuntime({ candidateRoot: cand }).fingerprint, a.fingerprint);
	fs.writeFileSync(path.join(cand, EXT[0]), "// changed\n");
	assert.notEqual(candidateRuntime({ candidateRoot: cand }).fingerprint, a.fingerprint);
});

test("an extension path that escapes the candidate root is refused", () => {
	const cand = candidate();
	fs.writeFileSync(path.join(cand, "package.json"), JSON.stringify({ pi: { extensions: ["../outside.ts"] } }));
	assert.throws(() => candidateRuntime({ candidateRoot: cand }), /outside the candidate/);
});

// Oracle R7: prompt resources the profile can shadow are compared byte for byte; a difference is reported, nothing is copied or written.
import { resourceShadowing, verifyLoadedResources } from "./lib/runtime.mjs";
const put = (file, text) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };

test("resourceShadowing reports a profile AGENTS.md, skill or role prompt that differs; a missing profile skill is shadowed, a missing role prompt is not", () => {
	const cand = tmp("sh-cand");
	const prof = tmp("sh-prof");
	put(path.join(cand, "agent", "AGENTS.md"), "A");
	put(path.join(cand, "agent", "skills", "alpha", "SKILL.md"), "S");
	put(path.join(cand, "agent", "skills", "alpha", "scripts", "tool.mjs"), "not a prompt resource");
	put(path.join(cand, "agent", "agents", "worker.md"), "W");
	for (const [f, t] of [["AGENTS.md", "A"], ["skills/alpha/SKILL.md", "S"]]) put(path.join(prof, f), t);
	const same = resourceShadowing({ candidateRoot: cand, agentDir: prof });
	assert.deepEqual(same.shadowed, [], "identical copies and a missing role prompt do not shadow");
	assert.equal(same.files, 3, "AGENTS.md, one skill file and one role prompt; scripts are not prompt resources");
	put(path.join(prof, "AGENTS.md"), "A changed in the profile");
	fs.rmSync(path.join(prof, "skills", "alpha", "SKILL.md"));
	put(path.join(prof, "agents", "worker.md"), "W profile override");
	const r = resourceShadowing({ candidateRoot: cand, agentDir: prof });
	assert.deepEqual(r.shadowed.map((f) => [f.path, f.state]), [["agent/AGENTS.md", "differs"], ["agent/agents/worker.md", "differs"], ["agent/skills/alpha/SKILL.md", "profile-missing"]]);
	assert.notEqual(r.fingerprint, same.fingerprint);
	assert.equal(fs.existsSync(path.join(cand, "agent", "AGENTS.md")), true);
});

test("verifyLoadedResources proves candidate AGENTS.md and skills are what the loader carries, byte for byte", () => {
	const cand = tmp("vl-cand");
	const prof = tmp("vl-prof");
	put(path.join(cand, "agent", "AGENTS.md"), "A");
	put(path.join(cand, "agent", "skills", "alpha", "SKILL.md"), "S");
	put(path.join(prof, "skills", "alpha", "SKILL.md"), "S");
	const loaded = { agentsFiles: [{ path: path.join(prof, "AGENTS.md"), content: "A" }], skills: [{ name: "alpha", filePath: path.join(prof, "skills", "alpha", "SKILL.md") }] };
	assert.deepEqual(verifyLoadedResources({ candidateRoot: cand, loaded }), []);
	assert.equal(verifyLoadedResources({ candidateRoot: cand, loaded: { ...loaded, agentsFiles: [] } }).length, 1);
	assert.equal(verifyLoadedResources({ candidateRoot: cand, loaded: { ...loaded, skills: [] } }).length, 1);
});
