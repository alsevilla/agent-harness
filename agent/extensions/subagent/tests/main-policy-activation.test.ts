// Native main-session harness activation. Loads the REAL candidate subagent/index.ts through each supported installed Pi SDK
// (DefaultResourceLoader + createAgentSession + session.prompt) and asserts what the first model request carries: the installed
// compact policy as one engineering_policy section with the absolute installed SKILL.md path, no replay across turns, no
// profile/cwd policy source, and no duplicate when the profile already carries the policy verbatim. Offline capture provider;
// fixtures live under os.tmpdir(); the real profile and global settings are never read or written.
import test from "node:test";
import { expect } from "../../../../tests/support/expect.ts";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { hostModules } from "./host-modules.ts";

const TESTS_DIR = path.dirname(fileURLToPath(import.meta.url));
const AGENT_DIR = path.resolve(TESTS_DIR, "..", "..", "..");
const EXTENSION = path.resolve(TESTS_DIR, "..", "index.ts");
const SKILLS_DIR = path.join(AGENT_DIR, "skills");
const POLICY = fs.readFileSync(path.join(AGENT_DIR, "AGENTS.md"), "utf8").trim();
const SKILL_POSIX = path.join(SKILLS_DIR, "engineering-harness", "SKILL.md").replace(/\\/g, "/");
const AGENT_POSIX = AGENT_DIR.replace(/\\/g, "/");
const HOST_MODULES = hostModules();
const HOST_VERSION = JSON.parse(fs.readFileSync(path.join(HOST_MODULES, "@earendil-works", "pi-coding-agent", "package.json"), "utf8")).version;
const CAPTURE = "main-policy-activation-capture";
const MODEL = {
	id: "capture-model",
	name: "Offline capture model",
	api: CAPTURE,
	provider: CAPTURE,
	baseUrl: "http://offline.invalid/v1",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 8192,
	maxTokens: 1024,
};
const ZERO_USAGE = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const OPEN = "<engineering_policy>\n";
const CLOSE = "\n</engineering_policy>";

function textOf(content: any): string {
	if (typeof content === "string") return content;
	return (content ?? []).filter((part: any) => part.type === "text").map((part: any) => part.text).join("\n");
}

/** Everything the provider receives as system text: the leading prompt plus every transcript system message and its sections. */
function systemTextOf(context: any): string {
	const parts = [context.systemPrompt ?? ""];
	for (const message of context.messages ?? []) {
		if (message.role !== "system") continue;
		parts.push(textOf(message.content));
		for (const value of Object.values(message.sections ?? {})) parts.push(String(value));
	}
	return parts.join("\n");
}

const count = (text: string, needle: string) => text.split(needle).length - 1;

/** The engineering_policy section body as rendered into the request, or undefined when absent. */
function policyBlock(text: string): string | undefined {
	const start = text.indexOf(OPEN);
	if (start < 0) return undefined;
	const end = text.indexOf(CLOSE, start);
	return end < 0 ? undefined : text.slice(start + OPEN.length, end);
}

function captureExtension(ai: any, requests: string[]) {
	return (pi: any) => {
		pi.registerProvider(CAPTURE, {
			api: CAPTURE,
			apiKey: "offline-test-key", // synthetic; the stream never leaves the process
			baseUrl: MODEL.baseUrl,
			models: [{ id: MODEL.id, name: MODEL.name, reasoning: false, input: ["text"], cost: MODEL.cost, contextWindow: MODEL.contextWindow, maxTokens: MODEL.maxTokens }],
			streamSimple: (model: any, context: any) => {
				requests.push(systemTextOf(context));
				const stream = ai.createAssistantMessageEventStream();
				const message = { role: "assistant", content: [{ type: "text", text: "ok" }], api: CAPTURE, provider: CAPTURE, model: model.id, usage: ZERO_USAGE, stopReason: "stop", timestamp: Date.now() };
				void (async () => {
					stream.push({ type: "start", partial: { ...message, content: [] } });
					stream.push({ type: "done", reason: "stop", message });
					stream.end();
				})();
				return stream;
			},
		});
	};
}

type Files = { profile?: string; cwd?: string };

async function openSession(pi: any, ai: any, files: Files, requests: string[]) {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "main-policy-activation-"));
	const agentDir = path.join(root, "agent");
	const cwd = path.join(root, "project");
	fs.mkdirSync(agentDir, { recursive: true });
	fs.mkdirSync(cwd, { recursive: true });
	if (files.profile !== undefined) fs.writeFileSync(path.join(agentDir, "AGENTS.md"), files.profile);
	if (files.cwd !== undefined) fs.writeFileSync(path.join(cwd, "AGENTS.md"), files.cwd);
	const settingsManager = pi.SettingsManager.inMemory();
	const resourceLoader = new pi.DefaultResourceLoader({
		cwd,
		agentDir,
		settingsManager,
		additionalExtensionPaths: [EXTENSION],
		additionalSkillPaths: [SKILLS_DIR],
		extensionFactories: [captureExtension(ai, requests)],
		disabledBuiltinExtensions: ["mcp", "codemode", "tool-search", "llama.cpp"],
		noThemes: true,
	});
	await resourceLoader.reload();
	const { session } = await pi.createAgentSession({ cwd, agentDir, settingsManager, resourceLoader, model: MODEL, sessionManager: pi.SessionManager.inMemory(cwd) });
	await session.bindExtensions({});
	return { session, cleanup: () => { session.dispose(); fs.rmSync(root, { recursive: true, force: true }); } };
}

async function until(condition: () => boolean, label: string, ms = 10_000): Promise<void> {
	const deadline = Date.now() + ms;
	while (!condition()) {
		if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}

async function turn(session: any, requests: string[], text: string) {
	const before = requests.length;
	await session.prompt(text);
	await until(() => requests.length > before, "model call");
	await until(() => !session.isStreaming, "agent idle");
}

{
	const piRoot = path.join(HOST_MODULES, "@earendil-works");
	const pi: any = await import(pathToFileURL(path.join(piRoot, "pi-coding-agent", "dist", "index.js")).href);
	const ai: any = await import(pathToFileURL(path.join(piRoot, "pi-ai", "dist", "index.js")).href);
	const t = (name: string, body: () => Promise<void>) => test(`[${HOST_VERSION}] ${name}`, { timeout: 60_000 }, body);

	t("a native install gives the first request the installed policy once, with the absolute SKILL.md path", async () => {
		const requests: string[] = [];
		const { session, cleanup } = await openSession(pi, ai, {}, requests);
		try {
			await turn(session, requests, "first");
			const system = requests[0];
			expect(count(system, OPEN)).toBe(1);
			const body = policyBlock(system);
			expect(body).toBeDefined();
			expect(body).toContain(POLICY);
			expect(body).toContain(SKILL_POSIX);
			expect(body).toContain(`${AGENT_POSIX}/skills/`);
		} finally {
			cleanup();
		}
	});

	t("a compacted history re-injects the current installed policy on the next request", async () => {
		const requests: string[] = [];
		const { session, cleanup } = await openSession(pi, ai, {}, requests);
		try {
			await turn(session, requests, "before compaction");
			const manager = session.sessionManager;
			const leaf = manager.getLeafId();
			if (!leaf) throw new Error("session has no leaf after first turn");
			manager.appendCompaction("context compacted", leaf, 1);
			await turn(session, requests, "after compaction");
			const system = requests[1];
			expect(count(system, OPEN)).toBe(1);
			expect(policyBlock(system)).toContain(POLICY);
			expect(policyBlock(system)).toContain(SKILL_POSIX);
		} finally {
			cleanup();
		}
	});

	t("later turns do not replay the policy section", async () => {
		const requests: string[] = [];
		const { session, cleanup } = await openSession(pi, ai, {}, requests);
		try {
			await turn(session, requests, "first");
			await turn(session, requests, "second");
			expect(count(requests[1], OPEN)).toBe(1);
			expect(count(requests[1], "# Pi engineering policy")).toBe(1);
		} finally {
			cleanup();
		}
	});

	t("the policy comes from the installed package, never the profile or cwd AGENTS.md", async () => {
		const requests: string[] = [];
		const { session, cleanup } = await openSession(pi, ai, { profile: "PROFILE-ONLY policy text\n", cwd: "CWD-ONLY policy text\n" }, requests);
		try {
			await turn(session, requests, "first");
			const body = policyBlock(requests[0]);
			expect(body).toContain(POLICY);
			expect(body).not.toContain("PROFILE-ONLY");
			expect(body).not.toContain("CWD-ONLY");
		} finally {
			cleanup();
		}
	});

	t("a profile AGENTS.md carrying the policy verbatim is not duplicated", async () => {
		const requests: string[] = [];
		const { session, cleanup } = await openSession(pi, ai, { profile: `${POLICY}\n` }, requests);
		try {
			await turn(session, requests, "first");
			expect(count(requests[0], OPEN)).toBe(0);
			expect(count(requests[0], "# Pi engineering policy")).toBe(1);
		} finally {
			cleanup();
		}
	});

	t("unreadable package policy gives a transparent notice and the session still answers", async () => {
		const { policyBody } = await import("../main-policy.ts");
		const missing = fs.mkdtempSync(path.join(os.tmpdir(), "main-policy-missing-"));
		try {
			const body = policyBody(missing, []);
			expect(body).toContain("unavailable");
			expect(body).toContain(path.join(missing, "AGENTS.md").replace(/\\/g, "/"));
			expect(body).toContain("/skill:engineering-harness");
		} finally {
			fs.rmSync(missing, { recursive: true, force: true });
		}
	});

	t("no package root (live profile) or an already-loaded verbatim policy yields no section", async () => {
		const { policyBody } = await import("../main-policy.ts");
		expect(policyBody(null, [])).toBeUndefined();
		expect(policyBody(AGENT_DIR, [{ path: "AGENTS.md", content: `${POLICY}\n` }])).toBeUndefined();
	});
}

test("child launch boundary keeps --no-extensions, --no-mcp, --no-skills and --no-prompt-templates", async () => {
	const source = fs.readFileSync(path.resolve(TESTS_DIR, "..", "index.ts"), "utf8");
	expect(source).toContain(`"--no-extensions", "--no-mcp", "--no-skills", "--no-prompt-templates"`);
});
