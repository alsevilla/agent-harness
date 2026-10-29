// Phase 1 control surface through the real extension default export: planner consultation metadata, advice, /subagent usage views and native main-session events.
// Node-only (registerHooks, native TS). The canonical runner discovers this *.node.ts file and runs it directly.
import assert from "node:assert/strict";
import * as fs from "node:fs";
import { registerHooks } from "node:module";
import * as os from "node:os";
import * as path from "node:path";
import test, { after, before, beforeEach } from "node:test";
import { fileURLToPath } from "node:url";

const indexUrl = new URL("../index.ts", import.meta.url).href;
const doublesUrl = new URL("./fixtures/runtime-doubles.mjs", import.meta.url).href;
const monitorUrl = new URL("./fixtures/usage-monitor-double.mjs", import.meta.url).href;
const indexDependencies = new Set(["node:child_process", "@earendil-works/pi-ai", "typebox", "./code-integrations.ts", "./build-env.ts"]);
const entryStubUrl = `data:text/javascript,${encodeURIComponent(
	"export default function providerCooldownEntry() {}\nexport function registerProviderCooldown() {}\nexport async function runProviderCooldownCommand() { return { message: '', type: 'info' }; }\nexport async function providerLaunchState() { return { state: 'launch' }; }\nexport async function guardRefusalReplayable() { return false; }\nexport function providerCooldownGuard() {}\n",
)}`;

registerHooks({
	resolve(specifier, context, nextResolve) {
		if (specifier === "@earendil-works/pi-coding-agent") return { url: doublesUrl, shortCircuit: true };
		if (context.parentURL === indexUrl && specifier === "./provider-cooldown-entry.ts") return { url: entryStubUrl, shortCircuit: true };
		if (context.parentURL === indexUrl && specifier === "./monitor.ts") return { url: monitorUrl, shortCircuit: true };
		if (context.parentURL === indexUrl && indexDependencies.has(specifier)) return { url: doublesUrl, shortCircuit: true };
		return nextResolve(specifier, context);
	},
	load(url, context, nextLoad) {
		if (url === indexUrl) {
			const source = fs.readFileSync(fileURLToPath(url), "utf8");
			return { format: "module-typescript", source: `${source}\nexport { runSingleAgent };`, shortCircuit: true };
		}
		return nextLoad(url, context);
	},
});

type Event = Record<string, unknown>;
interface SpawnPlan { events?: Event[]; exitCode?: number }
let attempts: string[] = [];
let spawnPlan: (model: string) => SpawnPlan = () => ({ events: [], exitCode: 0 });
(globalThis as { __piSubagentFakeSpawn?: (args: string[]) => SpawnPlan }).__piSubagentFakeSpawn = (args) => {
	const model = args[args.indexOf("--model") + 1];
	attempts.push(model);
	return spawnPlan(model);
};
(globalThis as { __piProviderLaunch?: unknown }).__piProviderLaunch = { state: "launch" };
(globalThis as { __piGuardRefusal?: unknown }).__piGuardRefusal = () => false;

const PRIMARY = "openai-codex/gpt-6.1-sol";
const usageOf = (input: number, output: number, cost: number) => ({ input, output, cacheRead: 0, cacheWrite: 0, totalTokens: input + output, cost: { total: cost } });
const assistantEvent = (input: number, output: number, cost: number): Event => ({
	type: "message_end",
	message: { role: "assistant", provider: "openai-codex", model: "gpt-6.1-sol", content: [{ type: "text", text: "advice body" }], stopReason: "stop", usage: usageOf(input, output, cost) },
});

let tools: Record<string, any> = {};
let commands: Record<string, any> = {};
let handlers: Record<string, ((...args: any[]) => any)[]> = {};
let monitorDouble: { control?: (args: string, ctx: any) => Promise<void> };
let notes: { text: string; level: string }[] = [];
let branch: unknown[] = [];
const created: string[] = [];
const originalAgentDir = process.env.PI_CODING_AGENT_DIR;

before(async () => {
	const { instances } = await import(monitorUrl);
	const indexModule = await import(indexUrl);
	const host = {
		on: (name: string, fn: (...args: any[]) => any) => { (handlers[name] ??= []).push(fn); return () => {}; },
		registerTool: (tool: any) => { tools[tool.name] = tool; },
		registerCommand: (name: string, command: any) => { commands[name] = command; },
		registerShortcut() {}, registerFlag() {}, registerProvider() {}, registerMcpServer() {},
		getCommands: () => [{ name: "engineering-harness", source: "extension" }, { name: "agent-creation", source: "extension" }],
		getActiveTools: () => [], setActiveTools() {}, sendMessage() {}, sendUserMessage() {}, appendEntry() {},
		events: { on() {}, emit() {} },
	};
	indexModule.default(host);
	monitorDouble = instances[0];
});
beforeEach(() => {
	attempts = [];
	notes = [];
	spawnPlan = () => ({ events: [assistantEvent(10, 5, 0.25)], exitCode: 0 });
});
after(() => {
	if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
	for (const dir of created) fs.rmSync(dir, { recursive: true, force: true });
});

function setupRoots() {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "subagent-control-"));
	created.push(root);
	const userDir = path.join(root, "user");
	const nested = path.join(root, "project", "nested");
	fs.mkdirSync(path.join(userDir, "agents"), { recursive: true });
	fs.mkdirSync(nested, { recursive: true });
	process.env.PI_CODING_AGENT_DIR = userDir;
	return { userAgents: path.join(userDir, "agents"), nested };
}
function writeRole(dir: string, name: string, fields: Record<string, string>) {
	const lines = Object.entries({ name, description: "test role", ...fields }).map(([key, value]) => `${key}: ${value}`);
	fs.writeFileSync(path.join(dir, `${name}.md`), `---\n${lines.join("\n")}\n---\n`);
}
function ctxFor(cwd: string): any {
	return {
		cwd, hasUI: false, mode: "print", thinkingLevel: "medium",
		model: { provider: "openai-codex", id: "gpt-6.1-sol", contextWindow: 200000 },
		isProjectTrusted: () => true, isIdle: () => true,
		getContextUsage: () => ({ tokens: 50000, contextWindow: 200000, percent: 25 }),
		sessionManager: { getBranch: () => branch },
		modelRegistry: { find: () => undefined },
		ui: { notify: (text: string, level: string) => notes.push({ text, level }), confirm: async () => false },
	};
}
const lastNote = () => notes[notes.length - 1];

test("a foreground planner consultation is noted at launch, linked on settle, and its advice shows in the planner view", async () => {
	const fx = setupRoots();
	writeRole(fx.userAgents, "planner", { model: PRIMARY });
	const result = await tools.subagent.execute("c-fg", { agent: "planner", task: "advise", background: false, consultation: { trigger: "t3", taskId: "phase-1" } }, undefined, undefined, ctxFor(fx.nested));
	assert.notEqual(result.isError, true, result.content[0].text);
	const id = /Consultation (cons-\d+) recorded/.exec(result.content[0].text)?.[1];
	assert.ok(id, "launch text names the consultation");
	assert.deepEqual(attempts, [PRIMARY]);
	const advised = await tools.subagent_control.execute("c-advice", { action: "advice", target: id, advice: "accepted" });
	assert.notEqual(advised.isError, true, advised.content[0].text);
	assert.match(advised.content[0].text, new RegExp(`${id} advice recorded: accepted`));
	await monitorDouble.control!("usage --planner", ctxFor(fx.nested));
	assert.equal(lastNote().level, "info");
	assert.match(lastNote().text, new RegExp(`${id} · trigger t3 · task phase-1 · advice accepted · settled · 15 tokens · \\$0\\.2500`));
});

test("invalid consultation metadata refuses before any launch; advice on an unknown ID is refused", async () => {
	const fx = setupRoots();
	writeRole(fx.userAgents, "planner", { model: PRIMARY });
	writeRole(fx.userAgents, "backend-worker", { model: PRIMARY });
	const cases: [Record<string, unknown>, RegExp][] = [
		[{ agent: "backend-worker", task: "t", background: false, consultation: { trigger: "t3" } }, /only a single planner launch/],
		[{ tasks: [{ agent: "planner", task: "t" }], background: false, consultation: { trigger: "t3" } }, /only a single planner launch/],
		[{ agent: "planner", task: "t", background: false, consultation: { trigger: "bad trigger" } }, /consultation\.trigger/],
		[{ agent: "planner", task: "t", background: false, consultation: { trigger: "t3", weight: 2 } }, /unknown consultation key "weight"/],
		[{ agent: "planner", task: "t", background: false, consultation: null }, /null is not a consultation/],
	];
	for (const [params, pattern] of cases) {
		const result = await tools.subagent.execute("c-bad", params, undefined, undefined, ctxFor(fx.nested));
		assert.equal(result.isError, true, JSON.stringify(params));
		assert.match(result.content[0].text, pattern);
		assert.match(result.content[0].text, /nothing was launched/);
	}
	assert.deepEqual(attempts, [], "no child was launched by any refused request");
	const unknown = await tools.subagent_control.execute("c-unknown", { action: "advice", target: "cons-999999", advice: "rejected" });
	assert.equal(unknown.isError, true);
	assert.match(unknown.content[0].text, /Unknown consultation cons-999999/);
	const missing = await tools.subagent_control.execute("c-missing", { action: "advice", target: "cons-999999" });
	assert.equal(missing.isError, true);
});

test("a background planner consultation is acknowledged at launch and settles to its job scope", async () => {
	const fx = setupRoots();
	writeRole(fx.userAgents, "planner", { model: PRIMARY });
	const ctx = ctxFor(fx.nested);
	const launched = await tools.subagent.execute("c-bg", { agent: "planner", task: "advise", consultation: { trigger: "debugger-unresolved" } }, undefined, undefined, ctx);
	assert.notEqual(launched.isError, true, launched.content[0].text);
	const id = /Consultation (cons-\d+) recorded/.exec(launched.content[0].text)?.[1];
	assert.ok(id, "acknowledgement names the consultation");
	assert.match(launched.content[0].text, /Started background job bg-\d+/);
	for (let i = 0; i < 100; i++) {
		await monitorDouble.control!("usage --planner", ctx);
		if (lastNote().text.split("\n").some((line) => line.startsWith(`${id} `) && line.includes("· settled"))) break;
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
	assert.match(lastNote().text, new RegExp(`${id} · trigger debugger-unresolved · task unassigned · advice unknown · settled`));
	assert.match(lastNote().text, /; pending 0\)\./, "the header counts no pending consultation after settle");
});

test("usage views validate their options with useful errors; plain usage keeps the summary notice", async () => {
	setupRoots();
	const ctx = ctxFor(process.cwd());
	for (const [args, pattern] of [["usage --top 0", /--top needs a positive whole number/], ["usage --top", /--top needs a positive whole number/], ["usage --by-role --main", /one usage view/], ["usage --bogus", /Unknown usage option "--bogus"/]] as const) {
		await monitorDouble.control!(args, ctx);
		assert.equal(lastNote().level, "error", args);
		assert.match(lastNote().text, pattern, args);
	}
	await monitorDouble.control!("usage", ctx);
	assert.equal(lastNote().level, "info");
	assert.match(lastNote().text, /^Subagent usage: this .* run only \(in memory/);
	await monitorDouble.control!("usage --by-role", ctx);
	assert.match(lastNote().text, /Subagent usage by role/);
	await monitorDouble.control!("usage --top 2", ctx);
	assert.match(lastNote().text, /No settled agent tasks yet this run\.|Top /);
});

test("main telemetry follows the native events: branch rebuild on session start, turns, compaction, shutdown reset", async () => {
	setupRoots();
	const ctx = ctxFor(process.cwd());
	branch = [{ type: "message", message: { role: "assistant", content: [], usage: usageOf(40000, 500, 0.05) } }];
	for (const handler of handlers.session_start ?? []) handler({ type: "session_start", reason: "resume" }, ctx);
	await monitorDouble.control!("usage --main", ctx);
	assert.match(lastNote().text, /Turns: 1 since session start; 1 since last compaction; 0 compaction\(s\), no compaction\./);
	assert.match(lastNote().text, /Context now: 50,000 of 200,000 tokens \(25\.0%, runtime estimate\)/);
	for (const handler of handlers.turn_end ?? []) handler({ type: "turn_end", message: { role: "assistant", content: [], usage: usageOf(90000, 700, 0.1) } }, ctx);
	for (const handler of handlers.turn_end ?? []) handler({ type: "turn_end", message: { role: "user", content: "private text" } }, ctx);
	for (const handler of handlers.session_compact ?? []) handler({ type: "session_compact", reason: "threshold", compactionEntry: { tokensBefore: 90000 } }, ctx);
	await monitorDouble.control!("usage --main", ctx);
	assert.match(lastNote().text, /Turns: 2 since session start; 0 since last compaction; 1 compaction\(s\), last at 90,000 tokens before \(threshold\)\./);
	assert.match(lastNote().text, /Peak prompt: 90,000 since session start; unreported since last compaction\./);
	assert.doesNotMatch(lastNote().text, /private text/);
	for (const handler of handlers.session_shutdown ?? []) handler({ type: "session_shutdown", reason: "quit" }, ctx);
	await monitorDouble.control!("usage --main", ctx);
	assert.match(lastNote().text, /No main-session turns recorded yet/);
	branch = [];
});
