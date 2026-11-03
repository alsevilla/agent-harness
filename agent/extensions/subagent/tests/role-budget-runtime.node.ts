// Parent runtime for optional role budgets (Node-only: registerHooks + native TS; *.node.ts runtime suite).
// Real index.ts/background.ts/agents.ts with the pi/child_process doubles: a scripted fake child stands in for Pi, so no SDK session, provider or model ever runs.
import assert from "node:assert/strict";
import * as fs from "node:fs";
import { registerHooks } from "node:module";
import * as os from "node:os";
import * as path from "node:path";
import test, { after, before, beforeEach } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { BUDGET_ENV } from "../role-budget.ts";
import { hostModules } from "./host-modules.ts";

const indexUrl = new URL("../index.ts", import.meta.url).href;
const backgroundUrl = new URL("../background.ts", import.meta.url).href;
const doublesUrl = new URL("./fixtures/runtime-doubles.mjs", import.meta.url).href;
const stubMonitorUrl = "data:text/javascript," + encodeURIComponent("export class WorkerMonitor { constructor() { this.store = { begin() { return undefined; }, started() {}, event() {}, finish() {}, records: new Map(), changed() {} }; } }");
const entryStubUrl = "data:text/javascript," + encodeURIComponent("export default function providerCooldownEntry() {}\nexport function registerProviderCooldown() {}\nexport async function runProviderCooldownCommand() { return { message: '', type: 'info' }; }\nexport async function providerLaunchState() { return { state: 'launch' }; }\nexport async function guardRefusalReplayable() { return false; }");
const indexDependencies = new Set(["node:child_process", "@earendil-works/pi-ai", "./code-integrations.ts", "./build-env.ts"]);
// Real installed TypeBox builds the real tool schema; pi-ai's public validateToolArguments (pure argument validation, no session, provider or model) checks it.
const INSTALL_MODULES = hostModules(["@earendil-works/pi-ai", "typebox"]);
const typeboxUrl = pathToFileURL(`${INSTALL_MODULES}/typebox/build/index.mjs`).href;
const piAiUrl = pathToFileURL(`${INSTALL_MODULES}/@earendil-works/pi-ai/dist/index.js`).href;

registerHooks({
	resolve(specifier, context, nextResolve) {
		if (specifier === "@earendil-works/pi-coding-agent") return { url: doublesUrl, shortCircuit: true };
		if (context.parentURL === indexUrl) {
			if (specifier === "typebox") return { url: typeboxUrl, shortCircuit: true };
			if (specifier === "./provider-cooldown-entry.ts") return { url: entryStubUrl, shortCircuit: true };
			if (specifier === "./monitor.ts") return { url: stubMonitorUrl, shortCircuit: true };
			if (indexDependencies.has(specifier)) return { url: doublesUrl, shortCircuit: true };
		}
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
interface Plan { events?: Event[]; exitCode?: number; stderr?: string; hang?: boolean; epipe?: boolean; ignoreTerm?: boolean; afterSpawn?: () => void; onKill?: (signal: string) => void }

let spawns: Array<{ args: string[]; env: Record<string, string | undefined> }> = [];
let plans: Plan[] = [];
(globalThis as any).__piSubagentFakeSpawn = (args: string[], _task: string, options?: { env?: Record<string, string | undefined> }) => {
	spawns.push({ args, env: options?.env ?? {} });
	return plans[Math.min(spawns.length - 1, plans.length - 1)] ?? { events: [], exitCode: 0 };
};

const PRIMARY = "openai-codex/gpt-6.1-sol";
const LUNA = "openai-codex/gpt-6-luna";
const usage = (total: number) => ({ input: total, output: 0, totalTokens: total, cacheRead: 0, cacheWrite: 0, cost: { total: 0.1 } });
const assistant = (stopReason: string, text = "", errorMessage?: string, total = 10): Event => ({ type: "message_end", message: { role: "assistant", content: text ? [{ type: "text", text }] : [], stopReason, errorMessage, usage: usage(total) } });
const marker = (data: Record<string, unknown>, customType = "role-budget"): Event => ({ type: "entry_appended", entry: { type: "custom", customType, data: { v: 1, ...data } } });
const context = (tokens: number | null, turns = 1) => marker({ event: "context", tokens, turns }); // the child's current context observation (null = unknown)
const exhausted = (reason = "turns", turns = 2, contextTokens: number | null = null) => marker({ event: "exhausted", reason, turns, contextTokens, warn80: "not_delivered" });
const warn80 = marker({ event: "warn80", status: "sent", turns: 1 });
const success = (): Plan => ({ events: [assistant("stop", "done")], exitCode: 0 });
const unavailable = (): Plan => ({ events: [assistant("error", "", "503 provider unavailable")], exitCode: 1 });

let bg: any;
let runSingleAgent: (...args: unknown[]) => Promise<any>;
let indexModule: { default: (pi: unknown) => void };
const created: string[] = [];
const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
const tmpBase = () => process.env.TEMP ?? os.tmpdir();

before(async () => {
	bg = await import(backgroundUrl);
	const index: any = await import(indexUrl);
	runSingleAgent = index.runSingleAgent;
	indexModule = index;
});
beforeEach(() => { spawns = []; plans = [success()]; });
after(() => {
	if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
	for (const dir of created) fs.rmSync(dir, { recursive: true, force: true });
});

// A fresh workspace per run: a stuck run (RED) must not hold the write lease that later runs queue behind.
const freshCwd = () => { const dir = fs.mkdtempSync(path.join(tmpBase(), "role-budget-cwd-")); created.push(dir); return dir; };
const agent = (extra: Record<string, unknown> = {}) => ({ name: "worker", description: "d", systemPrompt: "", source: "user", filePath: "worker.md", model: PRIMARY, fallbackModel: [LUNA], tools: ["read"], ...extra });
function run(options: { agents?: unknown[]; budget?: unknown; scope?: unknown; signal?: AbortSignal } = {}) {
	return runSingleAgent(freshCwd(), { usageScope: options.scope, budget: options.budget }, options.agents ?? [agent()], "worker", "task", undefined, undefined, options.signal, undefined, (results: unknown[]) => ({ results }));
}
const budgetArgs = (args: string[]) => args.filter((arg, i) => args[i - 1] === "--extension" && /role-budget-entry\.ts$/.test(arg));
const budgetEnv = (env: Record<string, string | undefined>) => Object.fromEntries(Object.entries(env).filter(([key]) => key.startsWith("PI_SUBAGENT_ROLE_")));

test("no budget: no extra extension and no capability env (launch identical to today)", async () => {
	const scope = bg.newUsageScope();
	await run({ scope });
	await run();
	assert.equal(spawns.length, 2);
	for (const spawn of spawns) {
		assert.deepEqual(budgetArgs(spawn.args), []);
		assert.equal(spawn.args.some((arg) => /role-budget-entry/.test(arg)), false);
		assert.deepEqual(budgetEnv(spawn.env), {});
	}
	assert.deepEqual(scope.budget, { eligible: 0, measurable: 0, unknown: 0, exhausted: 0 });
	assert.equal(bg.formatUsageSummary(scope).includes("Role budgets"), false);
});

test("an effective budget adds exactly one child entry and numeric env, replacing stale inherited values", async () => {
	process.env[BUDGET_ENV.contextBudget] = "1";
	try { await run({ budget: { maxTurns: 4 } }); } finally { delete process.env[BUDGET_ENV.contextBudget]; }
	const [spawn] = spawns;
	const entries = budgetArgs(spawn.args);
	assert.equal(entries.length, 1);
	assert.ok(fs.existsSync(entries[0]), "the child entry file exists");
	assert.deepEqual(budgetEnv(spawn.env), { [BUDGET_ENV.maxTurns]: "4", [BUDGET_ENV.turnsBefore]: "0", [BUDGET_ENV.warned]: "0" });
	spawns = [];
	await run({ budget: { maxTurns: 4, contextBudget: 900 } });
	assert.equal(spawns[0].env[BUDGET_ENV.contextBudget], "900");
});

test("a stop marker yields a typed non-success result with partial output and never falls back", async () => {
	plans = [{ events: [assistant("toolUse", "partial work"), exhausted("turns", 1), assistant("aborted", ""), { type: "agent_settled", aborted: true }], exitCode: 0 }, success()];
	const result = await run({ budget: { maxTurns: 1 } });
	assert.equal(spawns.length, 1);
	assert.equal(result.stopReason, "aborted");
	assert.equal(result.errorMessage, "budget_exhausted:turns");
	assert.equal(result.budget.state, "exhausted");
	assert.equal(result.budget.reason, "turns");
	assert.equal(result.messages.length, 2); // completed partial messages are kept
	assert.match(JSON.stringify(result.messages), /partial work/);
});

test("a child crash after the marker is still budget_exhausted and a provider-looking error never replays", async () => {
	plans = [{ events: [assistant("stop", "early"), exhausted("context", 1, 950), assistant("error", "", "503 provider unavailable")], exitCode: 1 }, success()];
	const result = await run({ budget: { contextBudget: 900 } });
	assert.equal(spawns.length, 1);
	assert.equal(result.errorMessage, "budget_exhausted:context");
	assert.equal(result.budget.contextTokens, 950);
	assert.notEqual(result.stopReason, "stop");
});

test("a child that does not settle after the marker is stopped by the existing parent termination path", { timeout: 15000 }, async () => {
	const kills: string[] = [];
	plans = [{ events: [exhausted()], hang: true, onKill: (signal) => kills.push(signal) }];
	const result = await run({ budget: { maxTurns: 1 } });
	assert.deepEqual(kills, ["SIGTERM"]);
	assert.equal(result.errorMessage, "budget_exhausted:turns");
	assert.equal(spawns.length, 1);
});

test("marker to SIGKILL is ONE grace window: SIGTERM at once, SIGKILL after the existing 5 s, no extra wait before SIGTERM", { timeout: 15000 }, async () => {
	const kills: Array<[string, number]> = [];
	let markerAt = Date.now(); // the marker is replayed within a few ms of the launch
	plans = [{ events: [exhausted()], hang: true, ignoreTerm: true, onKill: (signal) => kills.push([signal, Date.now() - markerAt]) }];
	markerAt = Date.now();
	const result = await run({ budget: { maxTurns: 1 } });
	assert.deepEqual(kills.map(([signal]) => signal), ["SIGTERM", "SIGKILL"]);
	assert.ok(kills[0][1] < 1500, `SIGTERM came ${kills[0][1]} ms after the marker`);
	assert.ok(kills[1][1] >= 4500 && kills[1][1] < 7000, `SIGKILL came ${kills[1][1]} ms after the marker`); // scheduling tolerance, not a real-time guarantee
	assert.equal(result.errorMessage, "budget_exhausted:turns");
});

test("user cancel before the child is terminal wins over the budget marker", { timeout: 15000 }, async () => {
	const controller = new AbortController();
	const scope = bg.newUsageScope();
	plans = [{ events: [exhausted()], hang: true, afterSpawn: () => controller.abort() }];
	await assert.rejects(run({ budget: { maxTurns: 1 }, scope, signal: controller.signal }), /aborted/);
	assert.deepEqual(scope.budget, { eligible: 1, measurable: 0, unknown: 1, exhausted: 0 });
});

test("a child that fails to load the budget entry exits before any model output: a failed, uncapped-never result with no replay", async () => {
	plans = [{ events: [], exitCode: 1, stderr: "Failed to load extension role-budget-entry.ts: role budget requested but no limit is configured\n" }, success()];
	const scope = bg.newUsageScope();
	const result = await run({ budget: { maxTurns: 3 }, scope });
	assert.equal(spawns.length, 1); // never replayed, never retried without the budget
	assert.equal(result.exitCode, 1);
	assert.equal(result.messages.length, 0);
	assert.equal(result.budget.state, "not_exhausted");
	assert.match(result.stderr, /Failed to load extension/);
	assert.deepEqual(scope.budget, { eligible: 1, measurable: 0, unknown: 1, exhausted: 0 });
});

test("a child that exits before reading the prompt (early extension load failure, prompt write EPIPE) is a bounded failed result with no fallback replay", { timeout: 10000 }, async () => {
	plans = [{ epipe: true, exitCode: 1, stderr: "Failed to load extension role-budget-entry.ts: malformed budget\n" }, success()];
	const scope = bg.newUsageScope();
	const result = await run({ budget: { maxTurns: 3 }, scope });
	assert.equal(spawns.length, 1); // neither a fallback model nor an uncapped retry
	assert.equal(result.exitCode, 1);
	assert.equal(result.stopReason, "error");
	assert.match(result.errorMessage, /EPIPE/);
	assert.equal(result.messages.length, 0);
	assert.equal(result.budget.state, "not_exhausted");
	assert.match(result.stderr, /Failed to load extension/);
	assert.deepEqual(scope.budget, { eligible: 1, measurable: 0, unknown: 1, exhausted: 0 });
});

test("forged or malformed markers, and any marker from an unbudgeted child, are ignored", async () => {
	plans = [{ events: [exhausted(), assistant("stop", "fine")], exitCode: 0 }];
	const plain = await run();
	assert.equal(plain.stopReason, "stop");
	assert.equal(plain.budget, undefined);
	plans = [{ events: [marker({ event: "exhausted", reason: "turns", turns: -1, contextTokens: null, warn80: "sent" }), marker({ event: "exhausted", reason: "bad", turns: 1, contextTokens: null, warn80: "sent" }), marker({ event: "exhausted", reason: "turns", turns: 1, contextTokens: null, warn80: "sent" }, "other"), assistant("stop", "fine")], exitCode: 0 }];
	const budgeted = await run({ budget: { maxTurns: 9 } });
	assert.equal(budgeted.stopReason, "stop");
	assert.equal(budgeted.budget.state, "not_exhausted");
});

test("fallback keeps the logical turn count and the warning-sent state", async () => {
	plans = [{ events: [assistant("stop", "partial"), warn80, assistant("error", "", "503 provider unavailable")], exitCode: 1 }, success()];
	const result = await run({ budget: { maxTurns: 10 }, scope: bg.newUsageScope() });
	assert.equal(spawns.length, 2);
	assert.equal(result.exitCode, 0);
	assert.equal(spawns[0].env[BUDGET_ENV.turnsBefore], "0");
	assert.equal(spawns[0].env[BUDGET_ENV.warned], "0");
	assert.equal(spawns[1].env[BUDGET_ENV.turnsBefore], "2");
	assert.equal(spawns[1].env[BUDGET_ENV.warned], "1");
});

test("no new attempt starts once the job's turn budget is already spent", async () => {
	const scope = bg.newUsageScope();
	plans = [{ events: [assistant("stop", "partial"), assistant("error", "", "503 provider unavailable")], exitCode: 1 }, success()];
	const result = await run({ budget: { maxTurns: 2 }, scope });
	assert.equal(spawns.length, 1);
	assert.equal(result.budget.state, "exhausted");
	assert.equal(result.budget.noNewAttempt, true);
	assert.equal(result.stopReason, "error");
	assert.equal(scope.budget.exhausted, 1);
});

test("session counts: eligible, measurable, unknown and exhausted stay separate; unknown is never a known non-exhaustion", async () => {
	const scope = bg.newUsageScope();
	plans = [success()];
	await run({ budget: { maxTurns: 5 }, scope }); // measurable (turn cap is always observable)
	plans = [{ events: [assistant("stop", "done", undefined, 0)], exitCode: 0 }];
	await run({ budget: { contextBudget: 900 }, scope }); // context cap never observed: unknown
	plans = [{ events: [assistant("stop", "done"), context(500)], exitCode: 0 }];
	await run({ budget: { contextBudget: 900 }, scope }); // the child observed an available anchored estimate: measurable
	plans = [{ events: [exhausted("turns", 1), assistant("aborted")], exitCode: 0 }];
	await run({ budget: { maxTurns: 1, contextBudget: 900 }, scope }); // turn-caused exhaustion stays known with context unknown
	plans = [{ events: [assistant("error", "", "boom")], exitCode: 1 }];
	await run({ budget: { maxTurns: 5 }, agents: [agent({ fallbackModel: [] })], scope }); // failed without exhaustion: unknown
	assert.deepEqual(scope.budget, { eligible: 5, measurable: 3, unknown: 2, exhausted: 1 });
	const summary = bg.formatUsageSummary(scope);
	assert.match(summary, /5 eligible, 3 measurable, 2 unknown, 1 exhausted/);
	assert.match(summary, /33\.3% of measurable \(1\/3\); above the 5% informational flag/);
	assert.match(summary, /no sample-size or confidence claim/);
	assert.match(summary, /latest observation of the completing attempt/);
	assert.match(summary, /not full historical coverage/);
});

test("an anchored first attempt that fails over to an unanchored fallback is unknown, not a known non-exhaustion", async () => {
	for (const fallbackEvents of [[assistant("stop", "done", undefined, 0)], [assistant("stop", "done", undefined, 0), context(null, 2)]]) {
		const scope = bg.newUsageScope();
		spawns = [];
		plans = [{ events: [assistant("stop", "partial"), context(500), assistant("error", "", "503 provider unavailable")], exitCode: 1 }, { events: fallbackEvents, exitCode: 0 }];
		const result = await run({ budget: { contextBudget: 900 }, scope });
		assert.equal(spawns.length, 2);
		assert.equal(result.stopReason, "stop");
		assert.deepEqual(scope.budget, { eligible: 1, measurable: 0, unknown: 1, exhausted: 0 });
	}
});

test("a fallback attempt that itself observes an available estimate is measurable (each attempt is observed afresh)", async () => {
	const scope = bg.newUsageScope();
	plans = [{ events: [assistant("stop", "partial"), context(null), assistant("error", "", "503 provider unavailable")], exitCode: 1 }, { events: [assistant("stop", "done"), context(700, 2)], exitCode: 0 }];
	await run({ budget: { contextBudget: 900 }, scope });
	assert.equal(spawns.length, 2);
	assert.deepEqual(scope.budget, { eligible: 1, measurable: 1, unknown: 0, exhausted: 0 });
});

test("positive usage with an unavailable SDK estimate, and forged or malformed observations, are unknown", async () => {
	const scope = bg.newUsageScope();
	plans = [{ events: [assistant("stop", "done", undefined, 50), context(null)], exitCode: 0 }];
	await run({ budget: { contextBudget: 900 }, scope });
	plans = [{ events: [assistant("stop", "done", undefined, 50), marker({ event: "context", tokens: "500", turns: 1 }), marker({ event: "context", tokens: -5, turns: 1 }), marker({ event: "context", tokens: 500, turns: 1 }, "other")], exitCode: 0 }];
	await run({ budget: { contextBudget: 900 }, scope });
	plans = [{ events: [assistant("stop", "done", undefined, 50), context(500)], exitCode: 0 }];
	await run({ scope }); // no budget: an observation from an unbudgeted child is ignored and never counted
	assert.deepEqual(scope.budget, { eligible: 2, measurable: 0, unknown: 2, exhausted: 0 });
});

test("compaction to unknown is unknown at settlement and a later re-anchored observation is measurable again", async () => {
	const scope = bg.newUsageScope();
	plans = [{ events: [assistant("toolUse", "a"), context(500), context(null), assistant("stop", "done")], exitCode: 0 }];
	await run({ budget: { contextBudget: 900 }, scope });
	plans = [{ events: [assistant("toolUse", "a"), context(500), context(null), assistant("toolUse", "b"), context(300, 2), assistant("stop", "done")], exitCode: 0 }];
	await run({ budget: { contextBudget: 900 }, scope });
	assert.deepEqual(scope.budget, { eligible: 2, measurable: 1, unknown: 1, exhausted: 0 });
});

test("known turn-caused exhaustion with unknown context counts as measurable and exhausted once, across fallback", async () => {
	const scope = bg.newUsageScope();
	plans = [{ events: [assistant("stop", "a"), context(500), assistant("error", "", "503 provider unavailable")], exitCode: 1 }, { events: [context(null, 2), exhausted("turns", 3), assistant("aborted")], exitCode: 0 }];
	const result = await run({ budget: { maxTurns: 3, contextBudget: 900 }, scope });
	assert.equal(spawns.length, 2);
	assert.equal(result.errorMessage, "budget_exhausted:turns");
	assert.deepEqual(scope.budget, { eligible: 1, measurable: 1, unknown: 0, exhausted: 1 });
});

// ---- tool execute: validation and unsupported modes (every refusal happens before any spawn) ----
let tool: { execute: (...args: unknown[]) => Promise<any> } | undefined;
function setupRoles() {
	const root = fs.mkdtempSync(path.join(tmpBase(), "role-budget-tool-"));
	created.push(root);
	const userDir = path.join(root, "user");
	fs.mkdirSync(path.join(userDir, "agents"), { recursive: true });
	for (const name of ["capped", "plain"]) fs.writeFileSync(path.join(userDir, "agents", `${name}.md`), `---\nname: ${name}\ndescription: test role ${name}\nmodel: ${PRIMARY}\n---\nYou are ${name}.\n`);
	fs.writeFileSync(path.join(userDir, "roles.json"), JSON.stringify([{ name: "capped", budget: { maxTurns: 2 } }]));
	process.env.PI_CODING_AGENT_DIR = userDir;
	const pi = new Proxy({}, { get: (_t, prop) => (prop === "registerTool" ? (def: { name: string; execute: any }) => { if (def.name === "subagent") tool = def; } : prop === "sendMessage" ? () => Promise.resolve() : () => undefined) });
	indexModule.default(pi);
	return root;
}
const ctxFor = (root: string) => ({ cwd: root, model: undefined, thinkingLevel: undefined, hasUI: false, isProjectTrusted: () => true, modelRegistry: undefined });
const text = (result: any) => String(result?.content?.[0]?.text ?? "");

test("invalid task budgets reject before any spawn, in foreground and background", async () => {
	const root = setupRoles();
	for (const budget of [{ maxTurns: 0 }, { maxTurns: 1.5 }, { contextBudget: -3 }, { unknown: 1 }, {}, null, "x", [1]]) {
		for (const background of [false, undefined]) {
			const result = await tool!.execute("x", { agent: "plain", task: "t", budget, background }, undefined, undefined, ctxFor(root));
			assert.equal(result.isError, true, JSON.stringify(budget));
			assert.match(text(result), /Invalid budget/);
		}
	}
	assert.equal(spawns.length, 0);
});

test("single mode applies the role budget and a task budget overrides it per field", async () => {
	const root = setupRoles();
	plans = [success()];
	await tool!.execute("x", { agent: "capped", task: "t", background: false }, undefined, undefined, ctxFor(root));
	assert.equal(spawns[0].env[BUDGET_ENV.maxTurns], "2");
	spawns = [];
	await tool!.execute("x", { agent: "capped", task: "t", background: false, budget: { maxTurns: 5, contextBudget: 700 } }, undefined, undefined, ctxFor(root));
	assert.equal(spawns[0].env[BUDGET_ENV.maxTurns], "5");
	assert.equal(spawns[0].env[BUDGET_ENV.contextBudget], "700");
	spawns = [];
	await tool!.execute("x", { agent: "plain", task: "t", background: false }, undefined, undefined, ctxFor(root));
	assert.deepEqual(budgetEnv(spawns[0].env), {});
});

test("a background single launch carries the validated budget into the job's child", async () => {
	const root = setupRoles();
	const started = await tool!.execute("x", { agent: "plain", task: "t", budget: { maxTurns: 3 } }, undefined, undefined, ctxFor(root));
	assert.match(text(started), /Started background job/);
	for (let i = 0; i < 60 && spawns.length === 0; i++) await new Promise((resolve) => setTimeout(resolve, 50));
	assert.equal(spawns.length, 1);
	assert.equal(spawns[0].env[BUDGET_ENV.maxTurns], "3");
});

test("parallel, chain and dag reject a top-level budget, an entry budget and an inherited role budget before any spawn", async () => {
	const root = setupRoles();
	const modes = (agentName: string, extra: Record<string, unknown> = {}) => [
		{ tasks: [{ agent: agentName, task: "a", ...extra }] },
		{ chain: [{ agent: agentName, task: "a", ...extra }] },
		{ dag: [{ id: "n1", agent: agentName, task: "a", ...extra }] },
	];
	const cases: Array<[string, Record<string, unknown>]> = [];
	for (const mode of modes("plain")) cases.push(["top-level", { ...mode, budget: { maxTurns: 3 } }]);
	for (const mode of modes("capped")) cases.push(["inherited", mode]);
	for (const mode of modes("plain", { budget: { maxTurns: 3 } })) cases.push(["entry", mode]);
	for (const [label, params] of cases) {
		for (const background of [false, undefined]) {
			const result = await tool!.execute("x", { ...params, background }, undefined, undefined, ctxFor(root));
			assert.equal(result.isError, true, `${label} ${Object.keys(params)}`);
			assert.match(text(result), /budget/i, `${label} ${Object.keys(params)}`);
		}
	}
	assert.equal(spawns.length, 0);
});

// Validation must use the entries of the mode that actually dispatches; an empty inactive array may never shadow them.
test("empty inactive mode arrays cannot shadow the active mode's budget validation (inherited, entry and top-level; foreground and background)", async () => {
	const root = setupRoles();
	const entry = (name: string, extra: Record<string, unknown> = {}) => ({ agent: name, task: "a", ...extra });
	const active: Array<[string, (e: Record<string, unknown>) => Record<string, unknown>, Record<string, unknown>]> = [
		["tasks", (e) => ({ tasks: [e] }), { chain: [] }],
		["tasks", (e) => ({ tasks: [e] }), {}],
		["chain", (e) => ({ chain: [e] }), { tasks: [] }],
		["dag", (e) => ({ dag: [{ id: "n1", ...e }] }), { chain: [], tasks: [] }],
		["dag", (e) => ({ dag: [{ id: "n1", ...e }] }), { chain: [] }],
		["dag", (e) => ({ dag: [{ id: "n1", ...e }] }), { tasks: [] }],
	];
	let count = 0;
	for (const [mode, shape, inactive] of active) {
		const cases: Array<[string, Record<string, unknown>]> = [
			["inherited", { ...shape(entry("capped")), ...inactive }],
			["entry", { ...shape(entry("plain", { budget: { maxTurns: 3 } })), ...inactive }],
			["top-level", { ...shape(entry("plain")), ...inactive, budget: { maxTurns: 3 } }],
			["top-level null", { ...shape(entry("plain")), ...inactive, budget: null }],
		];
		for (const [label, params] of cases) for (const background of [false, undefined]) {
			const result = await tool!.execute("x", { ...params, background }, undefined, undefined, ctxFor(root));
			assert.equal(result.isError, true, `${mode} ${label} ${Object.keys(inactive)} bg=${background}`);
			assert.match(text(result), /budget/i, `${mode} ${label} ${Object.keys(inactive)}`);
			count++;
		}
	}
	assert.equal(count, 48);
	assert.equal(spawns.length, 0, "nothing is spawned, queued or admitted for any combination");
});

test("empty arrays beside a budget-free or single-mode call stay compatible and uncapped (no blanket rejection)", async () => {
	const root = setupRoles();
	plans = [success()];
	for (const params of [{ tasks: [{ agent: "plain", task: "a" }], chain: [] }, { chain: [{ agent: "plain", task: "a" }], tasks: [] }]) {
		spawns = [];
		const result = await tool!.execute("x", { ...params, background: false }, undefined, undefined, ctxFor(root));
		assert.notEqual(result.isError, true, Object.keys(params).join());
		assert.equal(spawns.length, 1);
		assert.deepEqual(budgetEnv(spawns[0].env), {});
	}
	spawns = [];
	await tool!.execute("x", { agent: "capped", task: "t", chain: [], tasks: [], background: false, budget: { contextBudget: 700 } }, undefined, undefined, ctxFor(root));
	assert.equal(spawns.length, 1); // single mode still applies the role and task budgets beside empty inactive arrays
	assert.equal(spawns[0].env[BUDGET_ENV.maxTurns], "2");
	assert.equal(spawns[0].env[BUDGET_ENV.contextBudget], "700");
});

// ---- actual public argument validation (pi-ai validateToolArguments) over the actual exported tool schema ----
const toolCall = (args: unknown) => ({ type: "toolCall" as const, id: "schema", name: "subagent", arguments: args });
const RAW_REJECTED: Array<[string, unknown]> = [
	["numeric string", { maxTurns: "4" }], ["numeric string context", { contextBudget: "900" }], ["fraction", { maxTurns: 1.5 }], ["fraction beside a valid cap", { maxTurns: 4, contextBudget: 2.5 }],
	["nested null beside a valid cap", { maxTurns: 4, contextBudget: null }], ["nested null only", { maxTurns: null }], ["boolean", { maxTurns: true }],
	["zero", { maxTurns: 0 }], ["negative", { contextBudget: -3 }], ["unsafe integer", { maxTurns: Number.MAX_SAFE_INTEGER + 2 }], ["empty object", {}], ["unknown key", { unknown: 1 }], ["unknown key beside a valid cap", { maxTurns: 4, tokens: 5 }],
	["outer null", null], ["outer string", "x"], ["outer number", 5], ["outer array", [1]], ["outer boolean", true],
];

test("the public validator preserves raw invalid budgets so the strict runtime contract refuses them before any spawn", async () => {
	const root = setupRoles();
	const sdk = await import(piAiUrl);
	const params = (tool as any).parameters;
	assert.ok(params, "the registered tool exposes its real schema");
	let preserved = 0;
	for (const [label, budget] of RAW_REJECTED) for (const background of [false, true]) {
		let validated: any;
		try { validated = sdk.validateToolArguments({ name: "subagent", parameters: params }, toolCall({ agent: "plain", task: "t", budget, background })); } catch (error) {
			assert.match(String((error as Error).message), /Validation failed/, label); // a schema-level refusal is also before any spawn
			continue;
		}
		assert.deepEqual(validated.budget, budget, `${label}: the public validator must not rewrite the raw budget`);
		preserved++;
		const result = await tool!.execute("x", validated, undefined, undefined, ctxFor(root));
		assert.equal(result.isError, true, label);
		assert.match(text(result), /Invalid budget/, label);
	}
	assert.ok(preserved >= 24, `only ${preserved} raw budgets reached the runtime contract`);
	assert.equal(spawns.length, 0);
});

test("a valid budget passes the public validator unchanged and reaches the child as numeric env", async () => {
	const root = setupRoles();
	const sdk = await import(piAiUrl);
	const validated = sdk.validateToolArguments({ name: "subagent", parameters: (tool as any).parameters }, toolCall({ agent: "plain", task: "t", background: false, budget: { maxTurns: 4, contextBudget: 900 } }));
	assert.deepEqual(validated.budget, { maxTurns: 4, contextBudget: 900 });
	plans = [success()];
	await tool!.execute("x", validated, undefined, undefined, ctxFor(root));
	assert.equal(spawns[0].env[BUDGET_ENV.maxTurns], "4");
	assert.equal(spawns[0].env[BUDGET_ENV.contextBudget], "900");
	const unset = sdk.validateToolArguments({ name: "subagent", parameters: (tool as any).parameters }, toolCall({ agent: "plain", task: "t" }));
	assert.equal(unset.budget, undefined); // an omitted budget stays omitted
});

test("uncapped parallel launches are unchanged", async () => {
	const root = setupRoles();
	plans = [success()];
	const result = await tool!.execute("x", { tasks: [{ agent: "plain", task: "a" }], background: false }, undefined, undefined, ctxFor(root));
	assert.notEqual(result.isError, true);
	assert.equal(spawns.length, 1);
	assert.deepEqual(budgetEnv(spawns[0].env), {});
});
