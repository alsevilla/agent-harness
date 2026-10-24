// Real Pi SDK regression: with the real package extension loaded and an offline scripted provider, two identical skill reads both reach the provider in full.
// The package adds no pointer or suppression of repeated reads.
import test from "node:test";
import { expect } from "../../../../tests/support/expect.ts";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { hostModules } from "./host-modules.ts";

const TESTS_DIR = path.dirname(fileURLToPath(import.meta.url));
const EXTENSION = path.resolve(TESTS_DIR, "..", "index.ts");
const HOST_MODULES = hostModules();
const HOST_VERSION = JSON.parse(fs.readFileSync(path.join(HOST_MODULES, "@earendil-works", "pi-coding-agent", "package.json"), "utf8")).version;
const NAME = "repeat-read-sdk-capture";
const MODEL = { id: "capture-model", name: "Offline capture model", api: NAME, provider: NAME, baseUrl: "http://offline.invalid/v1", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 8192, maxTokens: 1024 };
const ZERO = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const BODY = "skill instruction line\n".repeat(200); // 4400 chars, above the 2000 char floor
const textOf = (content: any) => (typeof content === "string" ? content : (content ?? []).filter((p: any) => p.type === "text").map((p: any) => p.text).join(""));

type Step = { read?: boolean; before?: () => void } | { text: string };

async function open(pi: any, ai: any, opts: { script: Step[]; extra?: (host: any) => void; compaction?: boolean }) {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "repeat-read-sdk-"));
	const agentDir = path.join(root, "agent");
	const cwd = path.join(root, "project");
	const skillDir = path.join(root, "skills", "demo-skill");
	fs.mkdirSync(agentDir, { recursive: true });
	fs.mkdirSync(cwd, { recursive: true });
	fs.mkdirSync(skillDir, { recursive: true });
	const skillFile = path.join(skillDir, "SKILL.md");
	fs.writeFileSync(skillFile, `---\nname: demo-skill\ndescription: Demo skill.\n---\n${BODY}`);
	const requests: Array<{ results: string[]; messages: any[] }> = [];
	let call = 0;
	let step = 0;
	const provider = (host: any) => {
		host.registerProvider(NAME, {
			api: NAME, apiKey: "offline-test-key", baseUrl: MODEL.baseUrl,
			models: [{ id: MODEL.id, name: MODEL.name, reasoning: false, input: ["text"], cost: MODEL.cost, contextWindow: MODEL.contextWindow, maxTokens: MODEL.maxTokens }],
			streamSimple: (model: any, context: any) => {
				const stream = ai.createAssistantMessageEventStream();
				const base = { role: "assistant", api: NAME, provider: NAME, model: model.id, usage: ZERO, timestamp: Date.now() };
				let message: any;
				if (!context.messages[0]?.toolsAdded?.length) message = { ...base, content: [{ type: "text", text: "summary" }], stopReason: "stop" }; // compaction summary request
				else {
					requests.push({ results: (context.messages ?? []).filter((m: any) => m.role === "toolResult").map((m: any) => textOf(m.content)), messages: context.messages });
					const next: any = opts.script[step++] ?? { text: "done" };
					next.before?.();
					message = "text" in next || !next.read
						? { ...base, content: [{ type: "text", text: "text" in next ? next.text : "ok" }], stopReason: "stop" }
						: { ...base, content: [{ type: "toolCall", id: `read-${++call}`, name: "read", arguments: { path: skillFile } }], stopReason: "toolUse" };
				}
				void (async () => { stream.push({ type: "start", partial: { ...message, content: [] } }); stream.push({ type: "done", reason: message.stopReason, message }); stream.end(); })();
				return stream;
			},
		});
	};
	const settingsManager = pi.SettingsManager.inMemory(opts.compaction ? { compaction: { enabled: false, keepRecentTokens: 1 } } : {});
	const resourceLoader = new pi.DefaultResourceLoader({
		cwd, agentDir, settingsManager,
		additionalExtensionPaths: [EXTENSION],
		additionalSkillPaths: [path.join(root, "skills")],
		extensionFactories: [provider, ...(opts.extra ? [opts.extra] : [])],
		disabledBuiltinExtensions: ["mcp", "codemode", "tool-search", "llama.cpp"],
		noThemes: true,
	});
	await resourceLoader.reload();
	const { session } = await pi.createAgentSession({ cwd, agentDir, settingsManager, resourceLoader, model: MODEL, sessionManager: pi.SessionManager.inMemory(cwd) });
	await session.bindExtensions({});
	return { session, requests, skillFile, cleanup: () => { session.dispose(); fs.rmSync(root, { recursive: true, force: true }); } };
}

{
	const piRoot = path.join(HOST_MODULES, "@earendil-works");
	const pi: any = await import(pathToFileURL(path.join(piRoot, "pi-coding-agent", "dist", "index.js")).href);
	const ai: any = await import(pathToFileURL(path.join(piRoot, "pi-ai", "dist", "index.js")).href);
	test(`[${HOST_VERSION}] two identical skill reads both reach the provider in full with no pointer`, { timeout: 60_000 }, async () => {
		const s = await open(pi, ai, { script: [{ read: true }, { read: true }, { text: "end" }] });
		try {
			await s.session.prompt("go");
			const results = s.requests[s.requests.length - 1].results;
			expect(results.length).toBe(2);
			expect(results[0]).toContain(BODY);
			expect(results[1]).toBe(results[0]);
			expect(results.join("")).not.toContain("[skill-read-cache]");
		} finally { s.cleanup(); }
	});
}
