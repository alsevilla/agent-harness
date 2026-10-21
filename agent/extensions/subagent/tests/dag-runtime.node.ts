// D3a workspace-admission runtime regression (Node-only: registerHooks + native TS; named *.node.ts so Bun skips it).
// Real index.ts runSingleAgent and real background.ts BackgroundWorkers run every launch path; only the pi package, typebox/pi-ai,
// the provider-cooldown entry, the monitor and child_process are doubled. The child double is offline and test-controlled:
// nothing spawns a real Pi process or reaches a provider.
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import { registerHooks } from "node:module";
import * as os from "node:os";
import * as path from "node:path";
import test, { after, afterEach, before, beforeEach } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { AgentConfig } from "../agents.ts";
import { hostModules } from "./host-modules.ts";
import { BackgroundWorkers } from "../background.ts";

const indexUrl = new URL("../index.ts", import.meta.url).href;
const doublesUrl = new URL("./fixtures/runtime-doubles.mjs", import.meta.url).href;
const dataUrl = (source: string) => "data:text/javascript," + encodeURIComponent(source);
// Offline RPC/JSON child: records every spawn; RPC prompts are acknowledged; exit and kill are driven by the test.
const childUrl = dataUrl(`import { EventEmitter } from "node:events";
export function spawn(_command, args, options) {
	const child = new EventEmitter();
	child.args = args; child.cwd = options.cwd; child.env = options.env; child.signals = []; child.exited = false; child.received = [];
	child.model = args.includes("--model") ? args[args.indexOf("--model") + 1] : "inherited";
	child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
	child.exitCode = null; child.signalCode = null;
	child.emitLine = (event) => child.stdout.emit("data", JSON.stringify(event) + "\\n");
	child.exit = (code) => { if (child.exited) return; child.exited = true; child.exitCode = code; child.emit("close", code); };
	child.kill = (signal = "SIGTERM") => { child.signals.push(signal); child.signalCode = signal; };
	child.stdin = options.stdio[0] === "pipe" ? { writable: true, on() {}, end() {}, write(chunk, callback) {
		const message = JSON.parse(String(chunk)); child.received.push(message);
		if (message.type === "prompt") child.emitLine({ type: "response", id: message.id, success: true });
		callback?.(null); return true;
	} } : null;
	queueMicrotask(() => child.emit("spawn"));
	globalThis.__piDagChildren.push(child);
	return child;
}`);
// Launch-state stub for the provider cooldown entry: every declared model launches; this suite does not test cooldown.
const entryStubUrl = dataUrl("export default function providerCooldownEntry() {}\nexport function registerProviderCooldown() {}\nexport async function runProviderCooldownCommand() { return { message: '', type: 'info' }; }\nexport async function providerLaunchState() { return { state: 'launch' }; }\nexport async function guardRefusalReplayable() { return false; }");
const indexDependencies = new Set(["@earendil-works/pi-ai", "./code-integrations.ts", "./build-env.ts"]);
// Real installed SDK pieces for the tool-boundary check: index.ts builds its real TypeBox schema; validateToolArguments comes from the installed pi-ai.
const INSTALL_MODULES = hostModules(["@earendil-works/pi-ai", "typebox"]);
const typeboxUrl = pathToFileURL(`${INSTALL_MODULES}/typebox/build/index.mjs`).href;
const piAiUrl = pathToFileURL(`${INSTALL_MODULES}/@earendil-works/pi-ai/dist/index.js`).href;

const monitorModuleUrl = new URL("../monitor.ts", import.meta.url).href;

registerHooks({
	resolve(specifier, context, nextResolve) {
		// The real monitor.ts registers /subagent and routes its control verbs; it loads the installed Pi TUI and SDK builds, as monitor-scrollbar.test.ts does.
		if (context.parentURL === monitorModuleUrl && specifier === "@earendil-works/pi-tui") return { url: pathToFileURL(`${INSTALL_MODULES}/@earendil-works/pi-tui/dist/index.js`).href, shortCircuit: true };
		if (context.parentURL === monitorModuleUrl && specifier === "@earendil-works/pi-coding-agent") return { url: pathToFileURL(`${INSTALL_MODULES}/@earendil-works/pi-coding-agent/dist/index.js`).href, shortCircuit: true };
		if (specifier === "@earendil-works/pi-coding-agent") return { url: doublesUrl, shortCircuit: true };
		if (context.parentURL === indexUrl && specifier === "typebox") return { url: typeboxUrl, shortCircuit: true };
		if (context.parentURL === indexUrl) {
			if (specifier === "node:child_process") return { url: childUrl, shortCircuit: true };
			if (specifier === "./provider-cooldown-entry.ts") return { url: entryStubUrl, shortCircuit: true };
			if (indexDependencies.has(specifier)) return { url: doublesUrl, shortCircuit: true };
		}
		return nextResolve(specifier, context);
	},
	load(url, context, nextLoad) {
		if (url === indexUrl) {
			// index.ts keeps runSingleAgent private; expose it to this test only.
			const source = fs.readFileSync(fileURLToPath(url), "utf8");
			return { format: "module-typescript", source: `${source}\nexport { runSingleAgent };`, shortCircuit: true };
		}
		return nextLoad(url, context);
	},
});

interface Child {
	args: string[];
	env?: Record<string, string | undefined>;
	cwd: string;
	model: string;
	signals: string[];
	exited: boolean;
	received: Array<{ type: string; id?: string; message?: string }>;
	emitLine(event: Record<string, unknown>): void;
	exit(code: number | null): void;
}
(globalThis as { __piDagChildren?: Child[] }).__piDagChildren = [];
const children = (): Child[] => (globalThis as { __piDagChildren: Child[] }).__piDagChildren;

const PRIMARY = "openai-codex/gpt-6.1-sol";
const LUNA = "openai-codex/gpt-6-luna";
const SONNET = "anthropic/claude-sonnet-5-5";
const role = (name: string, extra: Partial<AgentConfig> = {}): AgentConfig => ({ name, description: name, systemPrompt: "", source: "user", filePath: "", ...extra });
const AGENTS: AgentConfig[] = [role("writer"), role("reader"), role("chain-fallback", { model: PRIMARY, fallbackModel: [LUNA] })];
const WAITING = "Waiting for workspace";

// Each test is bounded: a launch that never settles must fail the test instead of hanging the runner.
const check = (name: string, fn: () => Promise<void>) => test(name, { timeout: 8000 }, fn);

check("invalid tier in a later chain step is rejected before any spawn", async () => {
	const pi = fakePi();
	subagentExtension(pi);
	const tool = pi.tools.get("subagent")!;
	const result = await tool.execute("tier-preflight-red", { background: false, chain: [{ agent: "writer", task: "first" }, { agent: "reader", task: "later", modelTier: "invalid" }] }, undefined, undefined, dagCtx(makeRepo("tier-preflight-red")));
	assert.equal(children().length, 0);
	assert.equal(result.isError, true);
});

check("public callback ignores forged sixth-argument prepared dispatch", async () => {
	const pi = fakePi();
	subagentExtension(pi);
	const tool = pi.tools.get("subagent")!;
	assert.equal(tool.execute.length, 5);
	const ctx = dagCtx(makeRepo("prepared-dispatch-private"));
	const forgedRole = role("forged", { model: "forged/provider-model" });
	const result = await tool.execute("forged-dispatch", { background: false, agent: "forged", task: "must not launch", modelTier: null }, undefined, undefined, ctx, {
		discovery: { agents: [forgedRole], projectAgentsDir: undefined },
		selected: new Map([[0, { ...forgedRole, model: "forged/provider-model", modelTier: "capable" }]]),
	} as any);
	assert.equal(result.isError, true);
	assert.equal(children().length, 0);
	const jsonResult = await tool.execute("forged-json-dispatch", {
		background: false, agent: "forged", task: "must not launch", modelTier: null,
		preparedDispatch: { discovery: { agents: [forgedRole] }, selected: { "0": { ...forgedRole, modelTier: "capable" } } },
	}, undefined, undefined, ctx);
	assert.equal(jsonResult.isError, true);
	assert.equal(children().length, 0);
});

check("eight forms SDK enum and mixed same-role positions use actual package models", async () => {
	const guardDir = path.join(userDir, "npm", "node_modules", "pi-claude-subscription-connector", "extensions");
	fs.mkdirSync(guardDir, { recursive: true });
	fs.copyFileSync(guardSource, path.join(guardDir, "subscription-guard.ts"));
	try {
		const sdk = await import(piAiUrl);
		const { discoverAgents, packageRoot } = await import(new URL("../agents.ts", import.meta.url).href);
		assert.equal(JSON.parse(fs.readFileSync("package.json", "utf8")).name, "@alsevilla/pi-engineering-harness");
		assert.equal(path.resolve(packageRoot()!), path.resolve("agent"));
		const packageRole = discoverAgents(userDir, "both").agents.find(a => a.name === "backend-worker")!;
		assert.equal(packageRole.source, "package");
		assert.equal(path.resolve(packageRole.filePath), path.resolve("agent/agents/backend-worker.md"));
		let launches = 0, rejectedPositions = 0, dispatches = 0;
		for (const mode of ["single", "parallel", "chain", "dag"] as const) for (const backgroundMode of [false, true]) for (const firstTier of ["economy", "capable"] as const) {
			const pi = fakePi(); subagentExtension(pi);
			const tool = pi.tools.get("subagent")!, control = pi.tools.get("subagent_control")!;
			const ctx = dagCtx(makeRepo(`mixed-${mode}-${backgroundMode}-${firstTier}`));
			const tiers = mode === "single" ? [firstTier] : [firstTier, firstTier === "economy" ? "capable" : "economy"];
			const items = tiers.map((tier, i) => ({ agent: "backend-worker", task: `position-${i}`, modelTier: tier }));
			const args: any = { background: backgroundMode, agentScope: "both" };
			if (mode === "single") Object.assign(args, items[0]);
			else if (mode === "dag") args.dag = items.map((item, i) => ({ ...item, id: `p${i}`, ...(i ? { dependsOn: ["p0"] } : {}) }));
			else args[mode === "parallel" ? "tasks" : "chain"] = items;
			const call = (arguments_: any) => ({ type: "toolCall" as const, id: "mixed", name: "subagent", arguments: arguments_ });
			for (let i = 0; i < tiers.length; i++) {
				const invalid = structuredClone(args);
				if (mode === "single") invalid.modelTier = "anthropic/claude-sonnet-5-5";
				else invalid[mode === "dag" ? "dag" : mode === "parallel" ? "tasks" : "chain"][i].modelTier = "anthropic/claude-sonnet-5-5";
				assert.throws(() => sdk.validateToolArguments(tool, call(invalid)), /Validation failed/);
				const count = children().length;
				const rejected = await tool.execute("bad position", invalid, undefined, undefined, ctx);
				assert.equal(rejected.isError, true); assert.equal(children().length, count); assert.equal(pi.sent.length, 0);
				rejectedPositions++;
			}
			const valid = sdk.validateToolArguments(tool, call(args));
			const offset = children().length;
			const launch = tool.execute("mixed", valid, undefined, undefined, ctx);
			const acknowledgement = backgroundMode ? await launch : undefined;
			if (backgroundMode) { assert.notEqual(acknowledgement!.isError, true); assert.ok(acknowledgement!.details.jobId); }
			for (let i = 0; i < tiers.length; i++) {
				await waitFor(() => children().length === offset + i + 1, `${mode} ${backgroundMode} position-${i} spawn`);
				const child = children()[offset + i];
				await waitFor(() => child.received.some(m => m.type === "prompt"), `position-${i} prompt`);
				assert.equal(child.model, tiers[i] === "economy" ? LUNA : SONNET);
				assert.ok(child.args.includes("--append-system-prompt"));
				if (tiers[i] === "capable") assert.ok(child.args.includes(path.join(guardDir, "subscription-guard.ts")));
				finish(child, `position-${i} tier result`); launches++;
			}
			let result: any;
			if (backgroundMode) {
				const jobId = acknowledgement!.details.jobId;
				await waitFor(() => pi.sent.some((m: any) => m.details?.jobId === jobId && m.details.state === "completed"), "completed receipt");
				assert.equal(pi.sent.length, 1);
				result = await control.execute("result", { action: "result", target: jobId }, undefined, undefined, ctx);
			} else result = await launch;
			assert.notEqual(result.isError, true);
			assert.equal(result.details.results.length, tiers.length);
			for (let i = 0; i < tiers.length; i++) {
				const row = result.details.results[i];
				assert.equal(row.agent, "backend-worker"); assert.equal(row.agentSource, "package"); assert.equal(row.model, tiers[i] === "economy" ? LUNA : SONNET); assert.equal(row.modelTier, tiers[i]); assert.equal(row.exitCode, 0);
				assert.match(finalText(row), new RegExp(`position-${i} tier result`));
			}
			dispatches++;
		}
		assert.equal(dispatches, 16); assert.equal(launches, 28); assert.equal(rejectedPositions, 28);
	} finally { fs.rmSync(path.join(userDir, "npm"), { recursive: true, force: true }); }
});

// Explicit native modelSlot: "fallback" on a package role with an explicit tier starts on that tier's first usable fallback.
check("modelSlot fallback runs in single, parallel, chain and dag, foreground and background, with per-entry provenance", async () => {
	const sdk = await import(piAiUrl);
	const call = (arguments_: any) => ({ type: "toolCall" as const, id: "slot", name: "subagent", arguments: arguments_ });
	let dispatches = 0;
	for (const mode of ["single", "parallel", "chain", "dag"] as const) for (const backgroundMode of [false, true]) {
		const pi = fakePi(); subagentExtension(pi);
		const tool = pi.tools.get("subagent")!, control = pi.tools.get("subagent_control")!;
		const ctx = dagCtx(makeRepo(`slot-${mode}-${backgroundMode}`));
		const items: any[] = [{ agent: "backend-worker", task: "slot-0", modelTier: "capable", modelSlot: "fallback" }, { agent: "backend-worker", task: "plain-1", modelTier: "economy" }];
		const expected = [PRIMARY, LUNA]; // capable fallback (not the capable primary) and an ordinary economy primary
		const used = mode === "single" ? items.slice(0, 1) : items;
		const args: any = { background: backgroundMode, agentScope: "both" };
		if (mode === "single") Object.assign(args, used[0]);
		else if (mode === "dag") args.dag = used.map((item, i) => ({ ...item, id: `p${i}`, ...(i ? { dependsOn: ["p0"] } : {}) }));
		else args[mode === "parallel" ? "tasks" : "chain"] = used;
		const valid = sdk.validateToolArguments(tool, call(args));
		const offset = children().length;
		const launch = tool.execute("slot", valid, undefined, undefined, ctx);
		const acknowledgement = backgroundMode ? await launch : undefined;
		if (backgroundMode) { assert.notEqual(acknowledgement!.isError, true); assert.ok(acknowledgement!.details.jobId); }
		for (let i = 0; i < used.length; i++) {
			await waitFor(() => children().length === offset + i + 1, `${mode} ${backgroundMode} slot position-${i} spawn`);
			const child = children()[offset + i];
			await waitFor(() => child.received.some(m => m.type === "prompt"), `slot position-${i} prompt`);
			assert.equal(child.model, expected[i], `${mode} ${backgroundMode} position-${i} model`);
			finish(child, `slot-${i} result`);
		}
		assert.equal(children().length, offset + used.length, "one child per entry: no primary launch for the slotted entry");
		let result: any;
		if (backgroundMode) {
			const jobId = acknowledgement!.details.jobId;
			await waitFor(() => pi.sent.some((m: any) => m.details?.jobId === jobId && m.details.state === "completed"), "slot completed receipt");
			result = await control.execute("result", { action: "result", target: jobId }, undefined, undefined, ctx);
		} else result = await launch;
		assert.notEqual(result.isError, true);
		const rows = result.details.results;
		assert.equal(rows.length, used.length);
		assert.equal(rows[0].model, PRIMARY); assert.equal(rows[0].modelTier, "capable"); assert.equal(rows[0].modelSlot, "fallback");
		assert.doesNotMatch(rows[0].stderr, /retried|skipped/);
		if (used.length > 1) { assert.equal(rows[1].model, LUNA); assert.equal(rows[1].modelTier, "economy"); assert.equal(Object.hasOwn(rows[1], "modelSlot"), false); }
		dispatches++;
	}
	assert.equal(dispatches, 8);
});

check("modelSlot refusals happen before any spawn: schema, runtime, root batch, non-package, tierless and no-fallback", async () => {
	const sdk = await import(piAiUrl);
	const pi = fakePi(); subagentExtension(pi);
	const tool = pi.tools.get("subagent")!;
	const call = (arguments_: any) => ({ type: "toolCall" as const, id: "slot", name: "subagent", arguments: arguments_ });
	const slotted = (extra: Record<string, unknown> = {}) => ({ agent: "backend-worker", task: "t", modelTier: "capable", modelSlot: "fallback", ...extra });
	for (const bad of ["primary", "Fallback", "anthropic/claude-sonnet-5-5", 1, true, ["fallback"]]) {
		assert.throws(() => sdk.validateToolArguments(tool, call({ background: false, ...slotted({ modelSlot: bad }) })), /Validation failed/, `schema ${JSON.stringify(bad)}`);
		assert.throws(() => sdk.validateToolArguments(tool, call({ background: false, dag: [{ id: "a", ...slotted({ modelSlot: bad }) }] })), /Validation failed/, `dag schema ${JSON.stringify(bad)}`);
	}
	const ctx = dagCtx(makeRepo("slot-refusals"));
	const refused: Array<[string, any]> = [
		["slot without tier", { agent: "backend-worker", task: "t", modelSlot: "fallback" }],
		["null slot", slotted({ modelSlot: null })],
		["unsupported slot", slotted({ modelSlot: "primary" })],
		["user role", { agent: "writer", task: "t", modelTier: "capable", modelSlot: "fallback" }],
		["no usable fallback (oracle)", { agent: "oracle", task: "t", modelTier: "capable", modelSlot: "fallback" }],
		["unconfigured tier (scout capable)", { agent: "scout", task: "t", modelTier: "capable", modelSlot: "fallback" }],
		["root slot on tasks", { tasks: [{ agent: "backend-worker", task: "t" }], modelSlot: "fallback" }],
		["root slot on chain", { chain: [{ agent: "backend-worker", task: "t", modelTier: "capable" }], modelSlot: "fallback" }],
		["root slot on dag", { dag: [{ id: "a", agent: "backend-worker", task: "t", modelTier: "capable" }], modelSlot: "fallback" }],
		["tasks entry without tier", { tasks: [{ agent: "backend-worker", task: "t", modelSlot: "fallback" }] }],
		["chain later entry null", { chain: [{ agent: "backend-worker", task: "t" }, slotted({ modelSlot: null })] }],
		["dag entry no fallback", { dag: [{ id: "a", agent: "oracle", task: "t", modelTier: "capable", modelSlot: "fallback" }] }],
	];
	for (const backgroundMode of [false, true]) for (const [label, args] of refused) {
		const result = await tool.execute("slot-refusal", { background: backgroundMode, agentScope: "both", ...args }, undefined, undefined, ctx);
		assert.equal(result.isError, true, `${label} background=${backgroundMode}`);
		assert.equal(children().length, 0, `${label} spawned a child`);
		assert.equal(pi.sent.length, 0, `${label} started a job`);
	}
});

check("inactive empty arrays cannot bypass single or parallel tier preflight", async () => {
	for (const background of [false, true]) for (const args of [
		{ background, agent: "writer", task: "bounded", modelTier: "economy", chain: [] },
		{ background, agent: "writer", task: "bounded", modelTier: null, tasks: [] },
		{ background, agent: "writer", task: "bounded", modelTier: "unsupported", chain: [] },
		{ background, chain: [], tasks: [{ agent: "writer", task: "first" }, { agent: "reader", task: "later", modelTier: null }] },
	]) {
		const pi = fakePi();
		subagentExtension(pi);
		const tool = pi.tools.get("subagent")!;
		const launch = tool.execute("inactive-tier-array", args, undefined, undefined, dagCtx(makeRepo("inactive-tier-array")));
		const spawned = [...children()];
		for (const child of spawned) finish(child, "offline cleanup");
		const result = await launch;
		assert.equal(result.isError, true, JSON.stringify(args));
		assert.equal(spawned.length, 0, JSON.stringify(args));
	}
});

check("batch root tiers and unsupported custom-role tiers fail before all launches", async () => {
	const pi = fakePi();
	subagentExtension(pi);
	const tool = pi.tools.get("subagent")!;
	const ctx = dagCtx(makeRepo("tier-batch-invalid"));
	for (const args of [
		{ background: false, modelTier: "economy", chain: [{ agent: "writer", task: "first" }] },
		{ background: false, chain: [{ agent: "writer", task: "first", modelTier: "economy" }] },
	]) {
		const result = await tool.execute("tier-batch-invalid", args, undefined, undefined, ctx);
		assert.equal(result.isError, true);
		assert.equal(children().length, 0);
	}
});

check("accepted package role configuration survives a later user-registry change", async () => {
	const { discoverAgents } = await import(new URL("../agents.ts", import.meta.url).href);
	const baseline = discoverAgents(userDir, "both").agents.find(a => a.name === "backend-worker")!;
	assert.equal(baseline.source, "package");
	const guardDir = path.join(userDir, "npm", "node_modules", "pi-claude-subscription-connector", "extensions");
	fs.mkdirSync(guardDir, { recursive: true });
	fs.copyFileSync(guardSource, path.join(guardDir, "subscription-guard.ts"));
	const registry = path.join(userDir, "roles.json");
	const previous = fs.existsSync(registry) ? fs.readFileSync(registry, "utf8") : undefined;
	const pi = fakePi(); subagentExtension(pi);
	const tool = pi.tools.get("subagent")!;
	try {
		const acknowledgement = await tool.execute("snapshot", { background: true, agentScope: "both", chain: [
			{ agent: "backend-worker", task: "tiered", modelTier: "economy" },
			{ agent: "backend-worker", task: "legacy" },
		] }, undefined, undefined, dagCtx(makeRepo("snapshot")));
		assert.ok(acknowledgement.details.jobId);
		await waitFor(() => children().length === 1, "accepted first chain child");
		fs.writeFileSync(registry, JSON.stringify([{ name: "backend-worker", provider: "openai-codex", model: "gpt-6-luna", fallbackModel: "anthropic/claude-haiku-5-5", modelTiers: { economy: { provider: "openai-codex", model: "gpt-6.1-sol", fallbackModel: "anthropic/claude-opus-5-5" }, capable: { provider: "anthropic", model: "claude-opus-5-5", fallbackModel: "openai-codex/gpt-6-luna" } }, thinking: "low", tools: "read" }]));
		assert.equal(children()[0].model, baseline.modelTiers!.economy.model);
		assert.equal(children()[0].args[children()[0].args.indexOf("--thinking") + 1], baseline.thinking);
		children()[0].emitLine({ type: "message_end", message: { role: "assistant", content: [], stopReason: "error", errorMessage: "503 provider unavailable", usage } });
		children()[0].exit(1);
		await waitFor(() => children().length === 2, "frozen economy fallback child");
		assert.equal(children()[1].model, baseline.modelTiers!.economy.fallbackModel[0]);
		finish(children()[1], "frozen fallback result");
		await waitFor(() => children().length === 3, "later chain child");
		assert.equal(children()[2].model, baseline.model);
		assert.equal(children()[2].args[children()[2].args.indexOf("--thinking") + 1], baseline.thinking);
		finish(children()[2], "second snapshot result");
		await waitFor(() => pi.sent.some((message: any) => message.details?.jobId === acknowledgement.details.jobId && message.details.state === "completed"), "background completion receipt");
		const result = await pi.tools.get("subagent_control")!.execute("snapshot result", { action: "result", target: acknowledgement.details.jobId }, undefined, undefined, dagCtx(makeRepo("snapshot-result")));
		assert.notEqual(result.isError, true);
	} finally {
		if (previous === undefined) fs.rmSync(registry, { force: true }); else fs.writeFileSync(registry, previous);
		fs.rmSync(path.join(userDir, "npm"), { recursive: true, force: true });
	}
});

check("package backend-worker tier failures never upgrade to capable", async () => {
	const { discoverAgents } = await import(new URL("../agents.ts", import.meta.url).href);
	const baseline = discoverAgents(userDir, "both").agents.find(a => a.name === "backend-worker")!;
	assert.equal(baseline.source, "package");
	assert.ok(baseline.modelTiers?.capable, "the package role has a configured capable tier");
	for (const scenario of ["ordinary failure", "availability after tool activity", "abort"] as const) {
		const pi = fakePi(); subagentExtension(pi);
		const tool = pi.tools.get("subagent")!;
		const controller = new AbortController();
		const offset = children().length;
		const launch = tool.execute(`tier-economy-${scenario}`, { agent: "backend-worker", task: scenario, modelTier: "economy", background: false, agentScope: "both" }, controller.signal, undefined, dagCtx(makeRepo(`tier-economy-${scenario}`)));
		let settled = false;
		const outcome = Promise.allSettled([launch]).then(result => { settled = true; return result; });
		await waitFor(() => children().length === offset + 1, `${scenario} primary spawn`);
		const primary = children()[offset];
		assert.equal(primary.model, baseline.modelTiers!.economy.model, `${scenario} uses only the selected economy primary`);
		await waitFor(() => primary.received.some(message => message.type === "prompt"), `${scenario} primary prompt`);
		if (scenario === "abort") {
			controller.abort();
			await waitFor(() => primary.signals.length > 0, "abort terminates the primary");
			primary.exit(null);
		} else {
			if (scenario === "availability after tool activity") primary.emitLine({ type: "tool_execution_start" });
			primary.emitLine({ type: "message_end", message: { role: "assistant", content: [], stopReason: "error", errorMessage: scenario === "ordinary failure" ? "implementation failed" : "503 provider unavailable", usage } });
			primary.exit(1);
		}
		await waitFor(() => settled, `${scenario} foreground execute settles`);
		const [result] = await outcome;
		assert.equal(result.status, scenario === "abort" ? "rejected" : "fulfilled");
		assert.equal(children().length, offset + 1, `${scenario} cannot launch a fallback or automatically upgrade to capable`);
	}
});

check("omitted tiers keep package defaults in legacy and mixed chain positions", async () => {
	const { discoverAgents } = await import(new URL("../agents.ts", import.meta.url).href);
	const baseline = discoverAgents(userDir, "both").agents.find(a => a.name === "backend-worker")!;
	assert.equal(baseline.source, "package");
	const guardDir = path.join(userDir, "npm", "node_modules", "pi-claude-subscription-connector", "extensions");
	fs.mkdirSync(guardDir, { recursive: true });
	fs.copyFileSync(guardSource, path.join(guardDir, "subscription-guard.ts"));
	const pi = fakePi(); subagentExtension(pi);
	const tool = pi.tools.get("subagent")!;
	const single = tool.execute("omitted-tier-single", { background: false, agentScope: "both", agent: "backend-worker", task: "legacy single" }, undefined, undefined, dagCtx(makeRepo("omitted-tier-single")));
	await waitFor(() => children().length === 1, "legacy single child");
	assert.equal(children()[0].model, baseline.model);
	finish(children()[0], "legacy single result");
	const singleResult = await single;
	assert.notEqual(singleResult.isError, true);
	assert.equal(singleResult.details.results[0].modelTier, "economy"); // omitted new-format role labels its resolved default tier (economy after the approved preset update)
	const batch = tool.execute("omitted-tier-batch", { background: false, agentScope: "both", tasks: [
		{ agent: "backend-worker", task: "batch one", cwd: makeRepo("omitted-tier-batch-one") },
		{ agent: "backend-worker", task: "batch two", cwd: makeRepo("omitted-tier-batch-two") },
	] }, undefined, undefined, dagCtx(makeRepo("omitted-tier-batch")));
	await waitFor(() => children().length === 3, "legacy batch children");
	assert.equal(children()[1].model, baseline.model);
	assert.equal(children()[2].model, baseline.model);
	finish(children()[1], "batch one result"); finish(children()[2], "batch two result");
	const batchResult = await batch;
	assert.notEqual(batchResult.isError, true);
	assert.deepEqual(batchResult.details.results.map((row: any) => row.modelTier), ["economy", "economy"]);
	children().length = 0;
	const launch = tool.execute("omitted-tier", { background: false, agentScope: "both", chain: [
		{ agent: "backend-worker", task: "legacy omitted" },
		{ agent: "backend-worker", task: "explicit", modelTier: "capable" },
		{ agent: "backend-worker", task: "legacy again" },
	] }, undefined, undefined, dagCtx(makeRepo("omitted-tier")));
	for (const expected of [baseline.model, baseline.modelTiers!.capable.model, baseline.model]) {
		await waitFor(() => children().length > 0 && !children().at(-1)!.exited, "chain child");
		const child = children().at(-1)!;
		assert.equal(child.model, expected);
		finish(child, "tier regression result");
		if (expected === baseline.model && children().length < 2) await waitFor(() => children().length >= 2, "next chain position");
	}
	assert.notEqual((await launch).isError, true);
	fs.rmSync(path.join(userDir, "npm"), { recursive: true, force: true });
});

// Config-driven eligibility: a tier dispatches only when the discovered package role carries that tier in the overlaid roles.json.
for (const { roleName, tier } of [
	{ roleName: "scout", tier: "capable" },
	{ roleName: "api-specialist", tier: "economy" },
	{ roleName: "api-specialist", tier: "capable" },
] as const) check(`configured ${roleName} ${tier} tier dispatches with the validated package model`, async () => {
	const { discoverAgents } = await import(new URL("../agents.ts", import.meta.url).href);
	const registry = path.join(userDir, "roles.json");
	const previous = fs.existsSync(registry) ? fs.readFileSync(registry, "utf8") : undefined;
	const expected = `configured/${roleName}-${tier}`;
	try {
		fs.writeFileSync(registry, JSON.stringify([{ name: roleName, modelTiers: {
			economy: { provider: "openai-codex", model: `configured/${roleName}-economy`, fallbackModel: `anthropic/configured-${roleName}-economy-fallback` },
			capable: { provider: "openai-codex", model: `configured/${roleName}-capable`, fallbackModel: `anthropic/configured-${roleName}-capable-fallback` },
		} }]));
		const found = discoverAgents(userDir, "both").agents.find(agent => agent.name === roleName)!;
		assert.equal(found.source, "package");
		assert.equal(found.modelTiers?.[tier]?.model, expected);
		const pi = fakePi(); subagentExtension(pi);
		const tool = pi.tools.get("subagent")!;
		const sdk = await import(piAiUrl);
		const call = { type: "toolCall" as const, id: `${roleName}-${tier}`, name: "subagent", arguments: { background: false, agentScope: "both", agent: roleName, task: "configured dispatch", modelTier: tier } };
		const valid = sdk.validateToolArguments(tool, call);
		const launch = tool.execute(`${roleName}-${tier}`, valid, undefined, undefined, dagCtx(makeRepo(`${roleName}-${tier}`)));
		await waitFor(() => children().length === 1, `configured ${roleName} role launches`);
		assert.equal(children()[0].args[children()[0].args.indexOf("--model") + 1], expected);
		finish(children()[0], "ok");
		const result = await launch;
		assert.equal(result.isError, undefined);
		assert.equal(result.details.results[0].modelTier, tier);
	} finally {
		if (previous === undefined) fs.rmSync(registry, { force: true }); else fs.writeFileSync(registry, previous);
	}
});

// The approved api-specialist preset configures both Anthropic tiers: the shipped or neutral overlay launches each configured tier with its own model and thinking
// (the Claude subscription guard is installed for these launches), and an empty modelTiers overlay fails discovery for every tier.
const API_TIERS = { economy: "anthropic/claude-haiku-5-5", capable: "anthropic/claude-sonnet-5-5" } as const;
check("api-specialist tiers follow shipped and overlaid roles.json: both configured tiers launch and an empty modelTiers overlay refuses every tier before any child spawns", async () => {
	const guardDir = path.join(userDir, "npm", "node_modules", "pi-claude-subscription-connector", "extensions");
	fs.mkdirSync(guardDir, { recursive: true });
	fs.copyFileSync(guardSource, path.join(guardDir, "subscription-guard.ts"));
	const cases: Array<[unknown, "economy" | "capable", RegExp | "launch"]> = [
		[undefined, "economy", "launch"],
		[undefined, "capable", "launch"],
		[[{ name: "api-specialist" }], "economy", "launch"],
		[[{ name: "api-specialist" }], "capable", "launch"],
		[[{ name: "api-specialist", modelTiers: {} }], "economy", /Subagent roles unavailable/],
		[[{ name: "api-specialist", modelTiers: {} }], "capable", /Subagent roles unavailable/],
	];
	try {
	for (const [overlay, tier, expected] of cases) await withUserRoles(overlay, async () => {
		const pi = fakePi(); subagentExtension(pi);
		const base = children().length;
		const launch = pi.tools.get("subagent")!.execute(`specialist-${tier}`, { background: false, agentScope: "both", agent: "api-specialist", task: "tier probe", modelTier: tier }, undefined, undefined, dagCtx(makeRepo(`specialist-${tier}`)));
		if (expected === "launch") {
			await waitFor(() => children().length === base + 1, `${JSON.stringify(overlay)} ${tier} launches`);
			assert.equal(flagValue(children()[base], "--model"), API_TIERS[tier]);
			assert.equal(flagValue(children()[base], "--thinking"), "high");
			finish(children()[base], "ok");
			assert.notEqual((await launch).isError, true);
		} else {
			const result = await launch;
			assert.equal(result.isError, true, `${JSON.stringify(overlay)} ${tier}`);
			assert.match(result.content[0].text, expected);
			assert.equal(children().length, base, `${JSON.stringify(overlay)} ${tier} spawned a child`);
			assert.equal(pi.sent.length, 0);
		}
	});
	} finally {
		fs.rmSync(path.join(userDir, "npm"), { recursive: true, force: true });
	}
});

check("explicit package role tier selects configured model without changing role", async () => {
	const pi = fakePi();
	subagentExtension(pi);
	const tool = pi.tools.get("subagent")!;
	const launch = tool.execute("tier-package", { background: false, agentScope: "both", agent: "backend-worker", task: "tier probe", modelTier: "economy" }, undefined, undefined, dagCtx(makeRepo("tier-package")));
	await waitFor(() => children().length === 1, "canonical package role launches");
	assert.equal(children()[0].args[children()[0].args.indexOf("--model") + 1], "openai-codex/gpt-6-luna");
	finish(children()[0], "ok");
	const result = await launch;
	assert.equal(result.isError, undefined);
});

// Fixture overlay with distinct per-tier thinking on a non-Anthropic pair (no subscription guard): omitted and explicit launches must differ from flat effort.
const LAUNCH_CAPABLE = { model: "openai-codex/gpt-6.1-sol", thinking: "high" }, LAUNCH_ECONOMY = { model: "openai-codex/gpt-6-luna", thinking: "low" };
const fixtureTiers = [{ name: "backend-worker", defaultModelTier: "capable", modelTiers: {
	economy: { model: LAUNCH_ECONOMY.model, fallbackModel: "github-copilot/gpt-6-luna", thinking: LAUNCH_ECONOMY.thinking },
	capable: { model: LAUNCH_CAPABLE.model, fallbackModel: "github-copilot/gpt-6.1-sol", thinking: LAUNCH_CAPABLE.thinking },
} }];
const flagValue = (child: Child, flag: string) => child.args[child.args.indexOf(flag) + 1];
async function withUserRoles(overlay: unknown, body: () => Promise<void>) {
	const registry = path.join(userDir, "roles.json");
	const previous = fs.existsSync(registry) ? fs.readFileSync(registry, "utf8") : undefined;
	try {
		if (overlay === undefined) fs.rmSync(registry, { force: true }); else fs.writeFileSync(registry, JSON.stringify(overlay));
		await body();
	} finally {
		if (previous === undefined) fs.rmSync(registry, { force: true }); else fs.writeFileSync(registry, previous);
	}
}
// Finishes each child in spawn order as it appears, so FG and BG launches settle without busy polling.
async function settleInOrder(launch: Promise<any>, expected: number, base: number) {
	for (let i = 0; i < expected; i++) {
		await waitFor(() => children().length > base + i, `child ${i + 1} of ${expected} spawns`);
		finish(children()[base + i], "ok");
	}
	return launch;
}

check("omitted and explicit tiers launch their own model and thinking across single, parallel, chain and DAG in foreground and background", async () => {
	await withUserRoles(fixtureTiers, async () => {
		for (const background of [false, true]) for (const shape of ["single", "parallel", "chain", "dag"] as const) {
			const positions: Array<"economy" | undefined> = shape === "single" ? [undefined] : [undefined, "economy"];
			const tag = `${shape}-${background ? "bg" : "fg"}`;
			const pi = fakePi(); subagentExtension(pi);
			const tierOf = (tier: "economy" | undefined) => (tier === undefined ? {} : { modelTier: tier });
			const params = shape === "single" ? { background, agent: "backend-worker", task: tag, ...tierOf(positions[0]) }
				: shape === "parallel" ? { background, tasks: positions.map((tier, i) => ({ agent: "backend-worker", task: `${tag} ${i}`, ...tierOf(tier) })) }
				: shape === "chain" ? { background, chain: positions.map((tier, i) => ({ agent: "backend-worker", task: `${tag} ${i}`, ...tierOf(tier) })) }
				: { background, dag: positions.map((tier, i) => node(`n${i}`, "backend-worker", `${tag} ${i}`, { ...tierOf(tier), ...(i ? { dependsOn: ["n0"] } : {}) })) };
			const base = children().length;
			const launch = pi.tools.get("subagent")!.execute(tag, params, undefined, undefined, dagCtx(makeRepo(tag)));
			await settleInOrder(launch, positions.length, base);
			const settled = await launch;
			assert.notEqual(settled.isError, true, tag);
			if (!background) assert.deepEqual((settled.details?.results ?? []).map((row: { modelTier?: string }) => row.modelTier), positions.map((tier) => tier ?? "capable"), `${tag} resolved labels`);
			for (const [i, tier] of positions.entries()) {
				const expected = tier === "economy" ? LAUNCH_ECONOMY : LAUNCH_CAPABLE;
				assert.equal(flagValue(children()[base + i], "--model"), expected.model, `${tag} position ${i} model`);
				assert.equal(flagValue(children()[base + i], "--thinking"), expected.thinking, `${tag} position ${i} thinking`);
			}
		}
	});
});

check("invalid tier at any position refuses the whole batch with no child, job or prompt, even after a valid omitted position", async () => {
	await withUserRoles(fixtureTiers, async () => {
		const valid = { agent: "backend-worker", task: "valid omitted" };
		for (const background of [false, true]) for (const bad of [{ agent: "backend-worker", task: "null", modelTier: null }, { agent: "backend-worker", task: "empty", modelTier: "" }, { agent: "backend-worker", task: "unknown", modelTier: "default" }, { agent: "writer", task: "source", modelTier: "economy" }]) for (const shape of ["chain", "tasks"] as const) {
			const pi = fakePi(); subagentExtension(pi);
			const tool = pi.tools.get("subagent")!;
			const params = shape === "chain" ? { background, chain: [valid, bad] } : { background, tasks: [valid, bad] };
			const result = await tool.execute(`invalid-${shape}-${bad.task}`, params, undefined, undefined, dagCtx(makeRepo(`invalid-${bad.task}`)));
			assert.equal(result.isError, true, `${shape} ${bad.task} ${background}`);
			assert.equal(children().length, 0, `${shape} ${bad.task} spawned a child`);
			assert.equal(pi.sent.length, 0);
			assert.equal(result.details?.jobId, undefined);
		}
	});
});

check("omitted tier with a default missing from roles.json refuses discovery before any child spawns", async () => {
	await withUserRoles([{ name: "backend-worker", defaultModelTier: "capable", modelTiers: { economy: { model: LAUNCH_ECONOMY.model, fallbackModel: "github-copilot/gpt-6-luna", thinking: "low" } } }], async () => {
		const pi = fakePi(); subagentExtension(pi);
		const result = await pi.tools.get("subagent")!.execute("default-missing", { background: false, chain: [{ agent: "backend-worker", task: "omitted" }] }, undefined, undefined, dagCtx(makeRepo("default-missing")));
		assert.equal(result.isError, true);
		assert.match(result.content[0].text, /Subagent roles unavailable/);
		assert.equal(children().length, 0);
		assert.equal(pi.sent.length, 0);
	});
});

check("background chain freezes admitted tiers: step edits and roles.json changes after admission never change a later launch", async () => {
	await withUserRoles(fixtureTiers, async () => {
		const pi = fakePi(); subagentExtension(pi);
		const params = { background: true, chain: [{ agent: "backend-worker", task: "first", modelTier: "economy" }, { agent: "backend-worker", task: "second" }] };
		const acknowledgement = await pi.tools.get("subagent")!.execute("snapshot-chain", params, undefined, undefined, dagCtx(makeRepo("snapshot-chain")));
		assert.equal(acknowledgement.isError, undefined);
		await waitFor(() => children().length === 1, "first chain step launches");
		assert.equal(flagValue(children()[0], "--model"), LAUNCH_ECONOMY.model);
		params.chain[1] = { agent: "backend-worker", task: "second", modelTier: "economy" };
		fs.writeFileSync(path.join(userDir, "roles.json"), JSON.stringify([{ name: "backend-worker", defaultModelTier: "capable", modelTiers: { economy: { model: LAUNCH_ECONOMY.model, fallbackModel: "github-copilot/gpt-6-luna", thinking: "low" }, capable: { model: "openai-codex/gpt-5-after-admission", fallbackModel: "github-copilot/gpt-5-after-admission", thinking: "minimal" } } }]));
		finish(children()[0], "ok");
		await waitFor(() => children().length === 2, "second chain step launches");
		assert.equal(flagValue(children()[1], "--model"), LAUNCH_CAPABLE.model);
		assert.equal(flagValue(children()[1], "--thinking"), LAUNCH_CAPABLE.thinking);
		finish(children()[1], "ok");
	});
});

let runSingleAgent: any;
let subagentExtension: any;
const created: string[] = [];
const aliases: Array<{ dir: string; link: string }> = [];
const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
const guardSource = path.join(originalAgentDir ?? path.join(os.homedir(), '.pi', 'agent'), 'npm', 'node_modules', 'pi-claude-subscription-connector', 'extensions', 'subscription-guard.ts');
const userDir = fs.mkdtempSync(path.join(os.tmpdir(), "dag-admission-user-"));

before(async () => {
	const mod = await import(indexUrl);
	runSingleAgent = mod.runSingleAgent;
	subagentExtension = mod.default;
	process.env.PI_CODING_AGENT_DIR = userDir;
	fs.mkdirSync(path.join(userDir, "agents"), { recursive: true });
	for (const name of ["writer", "reader"]) fs.writeFileSync(path.join(userDir, "agents", `${name}.md`), `---\nname: ${name}\ndescription: ${name}\n---\n`);
});

after(() => {
	if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
	for (const alias of aliases) removeAlias(alias);
	for (const dir of [...created, userDir]) fs.rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => {
	children().length = 0;
});

// Release every live child so no claim outlives its test.
afterEach(async () => {
	for (const child of children()) if (!child.exited) child.exit(0);
	await settle(10);
	fs.rmSync(path.join(userDir, "npm"), { recursive: true, force: true }); // guard fixture; a failed assertion skips a test's own cleanup
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const settle = (ms = 30) => sleep(ms);
async function waitFor(predicate: () => boolean, message: string) {
	for (let i = 0; i < 500 && !predicate(); i++) await sleep(4);
	assert.ok(predicate(), message);
}
// Exits every live child until the given launches settle; a claim releases only after its child's actual exit.
async function drain(launches: Array<Promise<unknown>>) {
	let settled = false;
	const all = Promise.allSettled(launches).then(() => (settled = true));
	for (let i = 0; i < 500 && !settled; i++) {
		for (const child of children()) if (!child.exited) child.exit(0);
		await sleep(5);
	}
	await all;
}

function makeRepo(label: string): string {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), `dag-admission-${label}-`));
	created.push(root);
	fs.mkdirSync(path.join(root, ".git")); // a .git directory marks the checkout root
	fs.mkdirSync(path.join(root, "sub"));
	return root;
}
// The junction lives outside the repo; cleanup removes only the link, never its target.
function makeAlias(target: string): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dag-admission-alias-"));
	const link = path.join(dir, "link");
	fs.symlinkSync(target, link, "junction");
	aliases.push({ dir, link });
	return link;
}
function removeAlias({ dir, link }: { dir: string; link: string }) {
	try { fs.rmdirSync(link); } catch { /* already gone */ }
	if (fs.existsSync(link)) return; // link still present: leave the directory untouched
	fs.rmSync(dir, { recursive: true, force: true });
}

function fakePi() {
	const tools = new Map<string, { execute: (...args: unknown[]) => Promise<any> }>();
	const commands = new Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>();
	const handlers = new Map<string, Array<(...args: unknown[]) => unknown>>();
	const sent: Array<{ content: string }> = [];
	return { tools, sent, commands, handlers, getCommands: () => [], on(name: string, fn: (...args: unknown[]) => unknown) { handlers.set(name, [...(handlers.get(name) ?? []), fn]); }, registerCommand(name: string, spec: { handler: (args: string, ctx: unknown) => Promise<void> }) { commands.set(name, spec); }, registerTool(tool: { name: string }) { tools.set(tool.name, tool as never); }, registerShortcut() {}, sendMessage(message: { content: string }) { sent.push(message); return Promise.resolve(); } };
}
const makeRuntime = () => new BackgroundWorkers(fakePi() as never, { store: { records: new Map(), changed() {} } } as never);
const makeDetails = (results: unknown[]) => ({ results });

// Foreground launch through the shared runSingleAgent boundary (legacy single/parallel/chain path).
function foreground(cwd: string, name: string, options: { task?: string; access?: "read" | "write"; signal?: AbortSignal; onUpdate?: (partial: any) => void; runtime?: BackgroundWorkers } = {}): Promise<any> {
	return runSingleAgent(cwd, { runtime: options.runtime }, AGENTS, name, options.task ?? name, undefined, undefined, options.signal, options.onUpdate, makeDetails, options.access);
}
// Background job launch: the same boundary, with the job's id and abort signal.
function background(runtime: BackgroundWorkers, cwd: string, name: string, task: string, access?: "read" | "write") {
	return runtime.start((signal, jobId) => runSingleAgent(cwd, { runtime, jobId }, AGENTS, name, task, undefined, undefined, signal, undefined, makeDetails, access));
}

check("writers on one checkout are exclusive: the second foreground writer waits for the first child to exit", async () => {
	const repo = makeRepo("writer-exclusion");
	const launches = [foreground(repo, "writer", { task: "first" }), foreground(repo, "writer", { task: "second" })];
	await waitFor(() => children().length === 1, "first child spawns");
	await settle();
	assert.equal(children().length, 1, "second writer must not spawn while the first owns the checkout");
	children()[0].exit(0);
	await waitFor(() => children().length === 2, "second writer spawns after the first child exits");
	await drain(launches);
});

check("subdirectory and junction aliases share one writer queue; a separate worktree stays independent", async () => {
	const repo = makeRepo("alias");
	const worktree = makeRepo("worktree");
	const launches = [
		foreground(repo, "writer", { task: "root" }),
		foreground(path.join(repo, "sub"), "writer", { task: "sub" }),
		foreground(makeAlias(repo), "writer", { task: "junction" }),
		foreground(worktree, "writer", { task: "worktree" }),
	];
	await waitFor(() => children().length === 2, "root and separate worktree spawn");
	await settle();
	assert.deepEqual(children().map((c) => c.cwd), [repo, worktree]);
	children()[0].exit(0);
	await waitFor(() => children().length === 3, "subdirectory writer runs after the root writer");
	assert.equal(children()[2].cwd, path.join(repo, "sub"));
	children()[2].exit(0);
	await waitFor(() => children().length === 4, "junction writer runs after the subdirectory writer");
	await drain(launches);
});

check("read-only declarations overlap on one checkout; a queued writer waits and a later reader cannot jump it", async () => {
	const repo = makeRepo("readers");
	const launches = [foreground(repo, "reader", { access: "read", task: "r1" }), foreground(repo, "reader", { access: "read", task: "r2" })];
	await waitFor(() => children().length === 2, "read-only launches overlap");
	launches.push(foreground(repo, "writer", { task: "w" }));
	launches.push(foreground(repo, "reader", { access: "read", task: "r3" }));
	await settle();
	assert.equal(children().length, 2, "writer waits for active readers; later reader queues behind it");
	children()[0].exit(0);
	await settle();
	assert.equal(children().length, 2, "writer still waits for the second reader");
	children()[1].exit(0);
	await waitFor(() => children().length === 3, "queued writer runs next");
	assert.equal(children()[2].cwd, repo);
	children()[2].exit(0);
	await waitFor(() => children().length === 4, "the later reader runs after the writer");
	await drain(launches);
});

check("separate checkouts run in parallel; the shared cap counts only running children, not queued claims", async () => {
	const runtime = makeRuntime();
	const holder = makeRepo("cap-holder");
	const launches = [foreground(holder, "writer", { runtime, task: "A" }), foreground(holder, "writer", { runtime, task: "B" })];
	for (const label of ["cap-2", "cap-3", "cap-4"]) launches.push(foreground(makeRepo(label), "writer", { runtime }));
	launches.push(foreground(makeRepo("cap-5"), "writer", { runtime }));
	await waitFor(() => children().length === 4, "four distinct checkouts fill the shared cap");
	await settle();
	assert.equal(children().length, 4, "the fifth launch waits for capacity; queued B on the held checkout holds no slot");
	assert.equal(children()[0].cwd, holder);
	children()[0].exit(0);
	await waitFor(() => children().length === 5, "capacity freed by the holder admits the next launch");
	await drain(launches);
});

check("queued workspace abort spawns nothing; the next claim proceeds without the aborted launch", async () => {
	const repo = makeRepo("queued-abort");
	const controller = new AbortController();
	const holder = foreground(repo, "writer", { task: "A" }); // registers first: holds the claim
	const aborted = foreground(repo, "writer", { task: "B", signal: controller.signal }); // queued behind the holder
	const launches = [holder, aborted, foreground(repo, "writer", { task: "C" })];
	await waitFor(() => children().length === 1, "holder spawns");
	controller.abort();
	await assert.rejects(aborted, /Subagent was aborted/);
	children()[0].exit(0);
	await waitFor(() => children().length === 2, "the claim passes to C, not to the aborted B");
	assert.equal(children()[1].cwd, repo);
	await drain(launches);
	assert.equal(children().length, 2, "the aborted launch never spawned");
});

check("queued background job cancel removes its claim with zero spawns", async () => {
	const runtime = makeRuntime();
	const repo = makeRepo("queued-bg-cancel");
	const holder = foreground(repo, "writer", { runtime, task: "A" });
	await waitFor(() => children().length === 1, "holder spawns");
	const job = background(runtime, repo, "writer", "queued job");
	const next = foreground(repo, "writer", { runtime, task: "C" });
	await settle();
	runtime.cancel(job.id);
	await waitFor(() => runtime.jobs.get(job.id)?.state === "aborted", "queued job settles as aborted");
	children()[0].exit(0);
	await waitFor(() => children().length === 2, "the next claim proceeds after the cancelled job");
	await drain([holder, next]);
	assert.equal(children().length, 2, "the cancelled background job never spawned");
});

check("paused job keeps its workspace claim before spawn; resume starts exactly one child", async () => {
	const runtime = makeRuntime();
	const repo = makeRepo("pause");
	const job = background(runtime, repo, "writer", "paused job");
	runtime.pause(job.id);
	const queued = foreground(repo, "writer", { runtime, task: "queued" });
	await sleep(150);
	assert.equal(children().length, 0, "a paused job must not spawn");
	runtime.pause(job.id, false);
	await waitFor(() => children().length === 1, "resume starts the one child");
	await sleep(150);
	assert.equal(children().length, 1, "the queued writer keeps waiting behind the resumed child");
	children()[0].exit(0);
	await waitFor(() => children().length === 2, "the queued writer runs after the job's child exits");
	await drain([queued]);
	await waitFor(() => runtime.jobs.get(job.id)?.state !== "running", "the paused job settles");
	assert.equal(children().length, 2);
});

check("a job paused after its capacity grant releases the slot; an unrelated queued job takes it and the paused job waits", async () => {
	const runtime = makeRuntime();
	const pausedRepo = makeRepo("cap-paused");
	const unrelatedRepo = makeRepo("cap-unrelated");
	try {
		for (let i = 0; i < 4; i++) background(runtime, makeRepo("cap-holder-" + i), "writer", "h" + i);
		await waitFor(() => children().length === 4, "four holders occupy the shared cap");
		const paused = background(runtime, pausedRepo, "writer", "queued then paused");
		await settle();
		runtime.pause(paused.id);
		background(runtime, unrelatedRepo, "writer", "unrelated");
		await settle();
		children()[0].exit(0); // the freed slot is granted to the paused job first; it must hand it on
		await waitFor(() => children().length === 5, "the unrelated job takes the released capacity");
		assert.equal(children()[4].cwd, unrelatedRepo);
		await sleep(100);
		assert.equal(children().length, 5, "the paused job stays unspawned");
		runtime.pause(paused.id, false);
		children()[1].exit(0); // resume still needs a free slot: the paused job queues behind the held capacity
		await waitFor(() => children().some((child) => child.cwd === pausedRepo), "resume launches the paused job");
		assert.equal(children().filter((child) => child.cwd === pausedRepo).length, 1, "exactly one child for the paused job");
	} finally {
		// Release every paused loop and live child so no timer keeps the runner alive.
		for (const job of runtime.jobs.values()) if (job.paused) runtime.pause(job.id, false);
		for (let i = 0; i < 300 && [...runtime.jobs.values()].some((job) => job.state === "running"); i++) {
			for (const child of children()) if (!child.exited) child.exit(0);
			await sleep(10);
		}
	}
});

check("cancelling a running job waits for the child's actual exit before the claim is released", async () => {
	const runtime = makeRuntime();
	const repo = makeRepo("run-abort");
	const job = background(runtime, repo, "writer", "running job");
	await waitFor(() => children().length === 1, "job child spawns");
	const queued = foreground(repo, "writer", { task: "next" });
	runtime.cancel(job.id);
	await waitFor(() => children()[0].signals.includes("SIGTERM"), "cancel terminates the running child");
	await settle();
	assert.equal(children().length, 1, "the next writer waits until the aborted child actually exits");
	children()[0].exit(null);
	await waitFor(() => children().length === 2, "the next writer runs after the aborted child exits");
	await drain([queued]);
});

check("declared fallback attempts keep the workspace claim until the last attempt settles", async () => {
	const repo = makeRepo("fallback");
	const launches = [foreground(repo, "chain-fallback", { task: "primary" })];
	await waitFor(() => children().length === 1, "primary spawns");
	launches.push(foreground(repo, "writer", { task: "after" }));
	children()[0].emitLine({ type: "message_end", message: { role: "assistant", content: [], stopReason: "error", errorMessage: "503 provider unavailable", usage: { input: 1, output: 1, totalTokens: 2, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } } } });
	children()[0].exit(1);
	await waitFor(() => children().length === 2, "fallback spawns while the primary's claim is still held");
	assert.equal(children()[1].model, LUNA);
	await settle();
	assert.equal(children().length, 2, "the queued writer must not run between primary and fallback");
	children()[1].exit(0);
	await waitFor(() => children().length === 3, "queued writer runs after the last fallback attempt settles");
	await drain(launches);
});

check("queued claims expose the literal waiting state to foreground updates and background control metadata", async () => {
	const runtime = makeRuntime();
	const repo = makeRepo("waiting");
	const launches = [foreground(repo, "writer", { runtime, task: "holder" })];
	await waitFor(() => children().length === 1, "holder spawns");
	const updates: string[] = [];
	launches.push(foreground(repo, "writer", { runtime, task: "queued", onUpdate: (partial) => updates.push(partial.content?.[0]?.text) }));
	const job = background(runtime, repo, "writer", "queued job");
	await settle();
	assert.ok(updates.includes(WAITING), `foreground update shows ${WAITING}: ${updates.join(" | ")}`);
	assert.equal(runtime.list().find((j: { jobId: string }) => j.jobId === job.id)?.waiting, WAITING);
	children()[0].exit(0);
	await waitFor(() => children().length === 2, "foreground queued writer runs");
	assert.equal(runtime.list().find((j: { jobId: string }) => j.jobId === job.id)?.waiting, WAITING, "job still waits behind the granted writer");
	children()[1].exit(0);
	await waitFor(() => children().length === 3, "queued job runs");
	assert.equal(runtime.list().find((j: { jobId: string }) => j.jobId === job.id)?.waiting, undefined, "waiting clears once granted");
	await drain(launches);
});

check("unresolvable checkout is a non-launch failure: no spawn and a failed result", async () => {
	const repo = makeRepo("missing");
	const result = await foreground(path.join(repo, "does-not-exist"), "writer");
	assert.equal(result.exitCode, 1);
	assert.match(result.stderr, /workspace cwd is not an existing directory/);
	assert.equal(children().length, 0);
});

check("parallel entries: default writers serialize; per-entry readOnly readers overlap", async () => {
	const pi = fakePi();
	subagentExtension(pi);
	const tool = pi.tools.get("subagent")!;
	const readRepo = makeRepo("parallel-readers");
	const writeRepo = makeRepo("parallel-writers");
	const readCtx = { cwd: readRepo, hasUI: false, isProjectTrusted: () => true, model: undefined, thinkingLevel: undefined };
	const readers = tool.execute("id", { background: false, tasks: [{ agent: "reader", task: "a", readOnly: true }, { agent: "reader", task: "b", readOnly: true }] }, undefined, undefined, readCtx);
	await waitFor(() => children().length === 2, "per-entry read-only tasks overlap");
	const writers = tool.execute("id", { background: false, tasks: [{ agent: "writer", task: "a" }, { agent: "writer", task: "b" }] }, undefined, undefined, { ...readCtx, cwd: writeRepo });
	await waitFor(() => children().length === 3, "first default writer spawns");
	await settle();
	assert.equal(children().length, 3, "second default writer waits on the same checkout");
	await drain([readers, writers]);
});

check("single and chain declarations carry readOnly: a read-only chain step overlaps a read-only single and blocks a writer", async () => {
	const pi = fakePi();
	subagentExtension(pi);
	const tool = pi.tools.get("subagent")!;
	const repo = makeRepo("chain-single");
	const ctx = { cwd: repo, hasUI: false, isProjectTrusted: () => true, model: undefined, thinkingLevel: undefined };
	const chain = tool.execute("id", { background: false, chain: [{ agent: "reader", task: "step", readOnly: true }] }, undefined, undefined, ctx);
	await waitFor(() => children().length === 1, "chain step spawns");
	const single = tool.execute("id", { background: false, agent: "reader", task: "single", readOnly: true }, undefined, undefined, ctx);
	await waitFor(() => children().length === 2, "read-only single overlaps the chain step");
	const writer = tool.execute("id", { background: false, agent: "writer", task: "w" }, undefined, undefined, ctx);
	await settle();
	assert.equal(children().length, 2, "a writer waits behind the read-only holders");
	await drain([chain, single, writer]);
});

// D3b DAG mode: the real subagent tool (dag branch) drives the real runtime; each child is finished by the test.
const dagCtx = (cwd: string) => ({ cwd, hasUI: false, isProjectTrusted: () => true, model: undefined, thinkingLevel: undefined });
const usage = { input: 1, output: 1, totalTokens: 2, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } };
const node = (id: string, agent: string, task: string, extra: Record<string, unknown> = {}) => ({ id, agent, task, ...extra });
// Launch-time task text is the child's stdin "Task: " prompt (RPC); a parent report is appended to it.
const promptOf = (child: Child) => child.received.find((message) => message.type === "prompt")?.message ?? "";
const taskOf = (child: Child, prefix: string) => (promptOf(child).startsWith("Task: " + prefix) ? promptOf(child) : "");
function finish(child: Child, text: string, stopReason = "stop", code = 0) {
	child.emitLine({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text }], stopReason, usage } });
	child.exit(code);
}
async function listedWaiting(control: { execute: (...args: unknown[]) => Promise<any> }, jobId: string) {
	const jobs = JSON.parse((await control.execute("list", { action: "list" }, undefined, undefined, dagCtx(""))).content[0].text);
	return jobs.find((job: { jobId: string }) => job.jobId === jobId)?.waiting;
}

check("dag diamond: fan-in waits for every accepted parent; repeated agents keep distinct node and worker identities", async () => {
	const pi = fakePi();
	subagentExtension(pi);
	const tool = pi.tools.get("subagent")!;
	const repo = makeRepo("dag-diamond");
	const launch = tool.execute("dag-diamond", { background: false, dag: [node("a", "writer", "root"), node("b", "reader", "left", { dependsOn: ["a"], readOnly: true }), node("c", "reader", "right", { dependsOn: ["a"], readOnly: true }), node("d", "writer", "join", { dependsOn: ["b", "c"] })] }, undefined, undefined, dagCtx(repo));
	await waitFor(() => children().length === 1, "root spawns alone");
	await settle();
	assert.equal(children().length, 1, "dependents wait for the root");
	finish(children()[0], "A-REPORT");
	await waitFor(() => children().length === 3, "left and right spawn after the root is accepted");
	await waitFor(() => promptOf(children()[1]) !== "", "left prompt arrives");
	assert.ok(taskOf(children()[1], "left").includes("A-REPORT"), "left receives the root report");
	finish(children()[1], "LEFT-REPORT");
	await settle();
	assert.equal(children().length, 3, "the join does not start after only one parent");
	finish(children()[2], "RIGHT-REPORT");
	await waitFor(() => children().length === 4, "join spawns after both parents");
	await waitFor(() => promptOf(children()[3]) !== "", "join prompt arrives");
	assert.ok(taskOf(children()[3], "join").includes("LEFT-REPORT") && taskOf(children()[3], "join").includes("RIGHT-REPORT"), "join receives both reports");
	finish(children()[3], "JOIN-REPORT");
	const result = await launch;
	assert.notEqual(result.isError, true);
	assert.equal(result.details.mode, "dag");
	assert.deepEqual(result.details.results.map((r: any) => r.nodeId), ["a", "b", "c", "d"]);
	assert.deepEqual(result.details.results.map((r: any) => r.dag.status), ["accepted", "accepted", "accepted", "accepted"]);
	assert.deepEqual(result.details.results.map((r: any) => r.nodeId), ["a", "b", "c", "d"]);
	assert.equal(new Set(children()).size, 4, "each node is its own child process, even when agents repeat");
});

check("foreground RPC: a large task travels as one stdin prompt with exact bytes, never as argv", async () => {
	const repo = makeRepo("fg-rpc");
	const task = "Head \u2028 $& $$ ${previous} `tick` \u00e9\u2713 " + "A".repeat(200000) + "\n   trailing whitespace \t  ";
	const launch = foreground(repo, "writer", { task });
	await waitFor(() => children().length === 1, "foreground child spawns");
	const child = children()[0];
	await waitFor(() => child.received.some((message: { type: string }) => message.type === "prompt"), "the prompt reaches stdin");
	const prompt = child.received.find((message: { type: string }) => message.type === "prompt");
	assert.equal(prompt.message, "Task: " + task, "the stdin prompt keeps the task bytes exactly");
	assert.ok(child.args.join(" ").length < 8000 && !child.args.some((arg: string) => arg.includes("AAAA")), "no task text in argv");
	finish(child, "done");
	const result = await launch;
	assert.equal(result.exitCode, 0);
});

// Real pipes emit Buffer chunks; a boundary after the second byte of a 4-byte emoji is the split a per-chunk toString() corrupts.
const pipes = (child: Child) => child as unknown as { stdout: EventEmitter; stderr: EventEmitter };
function emitSplitInEmoji(stream: EventEmitter, bytes: Buffer, every = 1) {
	const emoji = Buffer.from("😀");
	let from = 0;
	let seen = 0;
	for (let at = bytes.indexOf(emoji); at !== -1; at = bytes.indexOf(emoji, at + emoji.length)) {
		if (seen++ % every !== 0) continue;
		stream.emit("data", bytes.subarray(from, at + 2));
		from = at + 2;
	}
	stream.emit("data", bytes.subarray(from));
}
const messageBytes = (text: string) => Buffer.from(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text }], stopReason: "stop", usage } }) + "\n");
const finalText = (result: any): string => result.messages[result.messages.length - 1].content[0].text;

check("foreground RPC: Buffer chunks split inside a 4-byte emoji keep the final text and stderr byte-exact", async () => {
	const launch = foreground(makeRepo("fg-utf8"), "writer", { task: "utf8" });
	await waitFor(() => children().length === 1, "foreground child spawns");
	const child = children()[0];
	await waitFor(() => child.received.some((message) => message.type === "prompt"), "the prompt reaches stdin");
	emitSplitInEmoji(pipes(child).stderr, Buffer.from("warn 😀 ✓ 😀\n"));
	emitSplitInEmoji(pipes(child).stdout, messageBytes("report 😀 ✓ é 😀 done"));
	child.exit(0);
	const result = await launch;
	assert.deepEqual({ final: finalText(result), stderr: result.stderr }, { final: "report 😀 ✓ é 😀 done", stderr: "warn 😀 ✓ 😀\n" }, "final text and stderr keep every emoji");
});

check("foreground RPC: a 200000-character multibyte final text survives chunks split inside its emoji", async () => {
	const text = "€é✓😀".repeat(40_000);
	const launch = foreground(makeRepo("fg-utf8-large"), "writer", { task: "large" });
	await waitFor(() => children().length === 1, "foreground child spawns");
	const child = children()[0];
	await waitFor(() => child.received.some((message) => message.type === "prompt"), "the prompt reaches stdin");
	emitSplitInEmoji(pipes(child).stdout, messageBytes(text), 500);
	child.exit(0);
	const final = finalText(await launch);
	assert.equal(text.length, 200_000);
	assert.ok(final === text, `final text differs: ${final.length} chars, ${final.split("\uFFFD").length - 1} U+FFFD`);
});

check("dag parent report split inside an emoji reaches the child task byte-exact", async () => {
	const pi = fakePi();
	subagentExtension(pi);
	const tool = pi.tools.get("subagent")!;
	const report = "A-REPORT 😀 ✓ é 😀 end";
	const launch = tool.execute("dag-utf8", { background: false, dag: [node("a", "writer", "root"), node("b", "writer", "use", { dependsOn: ["a"] })] }, undefined, undefined, dagCtx(makeRepo("dag-utf8")));
	await waitFor(() => children().length === 1, "root spawns");
	await waitFor(() => promptOf(children()[0]) !== "", "root prompt arrives");
	emitSplitInEmoji(pipes(children()[0]).stdout, messageBytes(report));
	children()[0].exit(0);
	await waitFor(() => children().length === 2, "dependent spawns");
	await waitFor(() => promptOf(children()[1]) !== "", "dependent prompt arrives");
	assert.equal(promptOf(children()[1]), `Task: use\n\n--- Report from parent node "a" (agent: writer) ---\n${report}`, "the child prompt keeps the parent report byte-exact");
	finish(children()[1], "done");
	assert.notEqual((await launch).isError, true);
});

check("close flushes decoder state before the trailing line parses; a truncated stderr tail keeps native U+FFFD", async () => {
	const launch = foreground(makeRepo("fg-utf8-tail"), "writer", { task: "tail" });
	await waitFor(() => children().length === 1, "foreground child spawns");
	const child = children()[0];
	await waitFor(() => child.received.some((message) => message.type === "prompt"), "the prompt reaches stdin");
	// The last JSON line has no newline: it is parsed only from the close-time trailing buffer.
	emitSplitInEmoji(pipes(child).stdout, messageBytes("tail 😀 ok").subarray(0, -1));
	pipes(child).stderr.emit("data", Buffer.from("warn é"));
	pipes(child).stderr.emit("data", Buffer.from("😀").subarray(0, 3));
	child.exit(0);
	const result = await launch;
	assert.equal(finalText(result), "tail 😀 ok", "the trailing line keeps its emoji");
	assert.equal(result.stderr, "warn é\uFFFD", "the truncated stderr tail is flushed with native replacement, not dropped");
});

check("dag started marker: a node cancelled while queued for its checkout never spawns and reports started false", async () => {
	const pi = fakePi();
	subagentExtension(pi);
	const tool = pi.tools.get("subagent")!;
	const repo = makeRepo("dag-started");
	const controller = new AbortController();
	const launch = tool.execute("dag-started", { background: false, dag: [node("holder", "writer", "hold"), node("queued", "writer", "wait")] }, controller.signal, undefined, dagCtx(repo));
	await waitFor(() => children().length === 1, "holder spawns and the second writer queues on the checkout");
	await settle();
	controller.abort();
	await drain([launch]);
	const result = await launch;
	assert.equal(children().length, 1, "queued node never spawned");
	assert.deepEqual(result.details.results.map((r: any) => [r.nodeId, r.dag.started]), [["holder", true], ["queued", false]]);
});

check("dag failure: a failed node blocks only its descendants; an independent branch still completes; the graph is isError", async () => {
	const pi = fakePi();
	subagentExtension(pi);
	const tool = pi.tools.get("subagent")!;
	const repoA = makeRepo("dag-fail-a");
	const repoB = makeRepo("dag-fail-b");
	const launch = tool.execute("dag-fail", { background: false, dag: [node("bad", "writer", "bad", { cwd: repoA }), node("good", "writer", "good", { cwd: repoB }), node("after-bad", "writer", "after", { cwd: repoA, dependsOn: ["bad"] }), node("after-good", "writer", "after2", { cwd: repoB, dependsOn: ["good"] })] }, undefined, undefined, dagCtx(repoA));
	await waitFor(() => children().length === 2, "independent roots spawn in parallel");
	finish(children()[0], "boom", "error", 1);
	await settle();
	finish(children()[1], "good report");
	await waitFor(() => children().length === 3, "the independent dependent runs; the blocked one never spawns");
	assert.equal(children()[2].cwd, repoB);
	finish(children()[2], "after report");
	const result = await launch;
	assert.equal(result.isError, true);
	assert.deepEqual(result.details.results.map((r: any) => r.dag.status), ["failed", "accepted", "blocked", "accepted"]);
	assert.deepEqual(result.details.results[2].dag.blockedBy, ["bad"]);
	assert.equal(children().length, 3, "blocked node never spawned");
});

check("dag acceptance: exit 0 with stopReason length is not accepted and blocks its dependents", async () => {
	const pi = fakePi();
	subagentExtension(pi);
	const tool = pi.tools.get("subagent")!;
	const launch = tool.execute("dag-length", { background: false, dag: [node("cut", "writer", "cut"), node("next", "writer", "next", { dependsOn: ["cut"] })] }, undefined, undefined, dagCtx(makeRepo("dag-length")));
	await waitFor(() => children().length === 1, "root spawns");
	finish(children()[0], "partial", "length", 0);
	const result = await launch;
	assert.equal(result.isError, true);
	assert.deepEqual(result.details.results.map((r: any) => r.dag.status), ["failed", "blocked"]);
	assert.equal(children().length, 1, "dependent never launches from an INCOMPLETE parent");
});

const PRINTED_MARKUP = '<invoke name="bash">\n<parameter name="command">echo hi</parameter>\n</invoke>';
check("dag acceptance: printed invoke markup (exit 0, stop) is not accepted and blocks its dependents", async () => {
	const pi = fakePi();
	subagentExtension(pi);
	const tool = pi.tools.get("subagent")!;
	const launch = tool.execute("dag-markup", { background: false, dag: [node("a", "writer", "a"), node("b", "writer", "b", { dependsOn: ["a"] })] }, undefined, undefined, dagCtx(makeRepo("dag-markup")));
	await waitFor(() => children().length === 1, "root spawns");
	finish(children()[0], PRINTED_MARKUP, "stop", 0);
	await settle(300);
	assert.equal(children().length, 1, "dependent never launches from printed markup");
	const result = await launch;
	assert.equal(result.isError, true);
	assert.deepEqual(result.details.results.map((r: any) => r.dag.status), ["failed", "blocked"]);
	assert.deepEqual(result.details.results[1].dag.blockedBy, ["a"]);
	assert.match(result.content[0].text, /### node "a" \(writer\) \u00b7 model: unknown \(requested-only; partial report unknown message UNVERIFIED\) \u2014 INCOMPLETE\/UNVERIFIED \(tool-call markup as text\)/);
});

check("dag acceptance: two-space indented invoke markup (exit 0, stop) is not accepted and blocks its dependents", async () => {
	const pi = fakePi();
	subagentExtension(pi);
	const tool = pi.tools.get("subagent")!;
	const indented = PRINTED_MARKUP.split("\n").map((line) => "  " + line).join("\n");
	const launch = tool.execute("dag-markup-indented", { background: false, dag: [node("a", "writer", "a"), node("b", "writer", "b", { dependsOn: ["a"] })] }, undefined, undefined, dagCtx(makeRepo("dag-markup-indented")));
	await waitFor(() => children().length === 1, "root spawns");
	finish(children()[0], indented, "stop", 0);
	await settle(300);
	assert.equal(children().length, 1, "dependent never launches from two-space indented printed markup");
	const result = await launch;
	assert.equal(result.isError, true);
	assert.deepEqual(result.details.results.map((r: any) => r.dag.status), ["failed", "blocked"]);
	assert.deepEqual(result.details.results[1].dag.blockedBy, ["a"]);
});

check("dag acceptance: four-space indented invoke markup is a code block, so the parent is accepted and its dependent launches", async () => {
	const pi = fakePi();
	subagentExtension(pi);
	const tool = pi.tools.get("subagent")!;
	const quoted = PRINTED_MARKUP.split("\n").map((line) => "    " + line).join("\n");
	const launch = tool.execute("dag-markup-code-block", { background: false, dag: [node("a", "writer", "a"), node("b", "writer", "b", { dependsOn: ["a"] })] }, undefined, undefined, dagCtx(makeRepo("dag-markup-code-block")));
	await waitFor(() => children().length === 1, "root spawns");
	finish(children()[0], "STATUS: PASS\n" + quoted + "\nCHECKS: NOT RUN");
	await waitFor(() => children().length === 2, "dependent spawns");
	finish(children()[1], "done");
	const result = await launch;
	assert.notEqual(result.isError, true);
	assert.deepEqual(result.details.results.map((r: any) => r.dag.status), ["accepted", "accepted"]);
});

check("dag acceptance: a real tool call followed by a final printed markup reply is not accepted", async () => {
	const pi = fakePi();
	subagentExtension(pi);
	const tool = pi.tools.get("subagent")!;
	const launch = tool.execute("dag-markup-tool", { background: false, dag: [node("a", "writer", "a"), node("b", "writer", "b", { dependsOn: ["a"] })] }, undefined, undefined, dagCtx(makeRepo("dag-markup-tool")));
	await waitFor(() => children().length === 1, "root spawns");
	children()[0].emitLine({ type: "message_end", message: { role: "assistant", content: [{ type: "toolCall", id: "call-1", name: "bash", arguments: { command: "ls" } }], stopReason: "toolUse", usage } });
	finish(children()[0], PRINTED_MARKUP, "stop", 0);
	await settle(300);
	assert.equal(children().length, 1, "dependent never launches from printed markup after a real tool call");
	const result = await launch;
	assert.equal(result.isError, true);
	assert.deepEqual(result.details.results.map((r: any) => r.dag.status), ["failed", "blocked"]);
});

check("dag acceptance: a parent report that quotes invoke markup in a fence is accepted and its dependent launches", async () => {
	const pi = fakePi();
	subagentExtension(pi);
	const tool = pi.tools.get("subagent")!;
	const launch = tool.execute("dag-markup-fenced", { background: false, dag: [node("a", "writer", "a"), node("b", "writer", "b", { dependsOn: ["a"] })] }, undefined, undefined, dagCtx(makeRepo("dag-markup-fenced")));
	await waitFor(() => children().length === 1, "root spawns");
	const report = "STATUS: PASS\n```xml\n" + PRINTED_MARKUP + "\n```\nCHECKS: NOT RUN";
	finish(children()[0], report);
	await waitFor(() => children().length === 2, "dependent spawns");
	await waitFor(() => promptOf(children()[1]) !== "", "dependent prompt arrives");
	assert.ok(taskOf(children()[1], "b").includes(report), "dependent receives the fenced report literally");
	finish(children()[1], "done");
	const result = await launch;
	assert.notEqual(result.isError, true);
	assert.deepEqual(result.details.results.map((r: any) => r.dag.status), ["accepted", "accepted"]);
});

check("dag parent reports reach the child literally: dollar and brace patterns, a 50KB report and stderr keep every byte", async () => {
	const pi = fakePi();
	subagentExtension(pi);
	const tool = pi.tools.get("subagent")!;
	const big = "R".repeat(50_000) + " $& $$ $' {previous}";
	const launch = tool.execute("dag-literal", { background: false, dag: [node("a", "writer", "root"), node("b", "writer", "use", { dependsOn: ["a"] })] }, undefined, undefined, dagCtx(makeRepo("dag-literal")));
	await waitFor(() => children().length === 1, "root spawns");
	(children()[0] as unknown as { stderr: EventEmitter }).stderr.emit("data", Buffer.from("warn-XYZ\n"));
	children()[0].emitLine({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: big }, { type: "text", text: "tail $& {previous}" }], stopReason: "stop", usage } });
	children()[0].exit(0);
	await waitFor(() => children().length === 2, "dependent spawns");
	await waitFor(() => promptOf(children()[1]) !== "", "dependent prompt arrives");
	const task = taskOf(children()[1], "use");
	assert.ok(task.includes(big + "\ntail $& {previous}"), "every character of the parent text is forwarded literally");
	assert.ok(task.includes("STDERR: warn-XYZ"), "the parent's stderr is forwarded");
	finish(children()[1], "done");
	assert.notEqual((await launch).isError, true);
});

check("dag mode validation: every invalid graph, ambiguous mode or missing mode is isError with zero spawns and no job", async () => {
	const pi = fakePi();
	subagentExtension(pi);
	const tool = pi.tools.get("subagent")!;
	const ctx = dagCtx(makeRepo("dag-validation"));
	const nine = Array.from({ length: 9 }, (_, i) => node("n" + i, "writer", "t"));
	const invalid: Array<[string, Record<string, unknown>]> = [
		["empty graph", { dag: [] }],
		["over the 8-node limit", { dag: nine }],
		["cycle", { dag: [node("a", "writer", "t", { dependsOn: ["b"] }), node("b", "writer", "t", { dependsOn: ["a"] })] }],
		["self dependency", { dag: [node("a", "writer", "t", { dependsOn: ["a"] })] }],
		["missing parent", { dag: [node("a", "writer", "t", { dependsOn: ["zz"] })] }],
		["duplicate parent", { dag: [node("a", "writer", "t"), node("b", "writer", "t", { dependsOn: ["a", "a"] })] }],
		["duplicate id", { dag: [node("a", "writer", "t"), node("a", "reader", "t")] }],
		["bad id", { dag: [node("1a", "writer", "t")] }],
		["unknown agent", { dag: [node("a", "nobody", "t")] }],
		["non-boolean readOnly", { dag: [node("a", "writer", "t", { readOnly: "yes" })] }],
		["dag with single", { dag: [node("a", "writer", "t")], agent: "writer", task: "t" }],
		["dag with tasks", { dag: [node("a", "writer", "t")], tasks: [{ agent: "writer", task: "t" }] }],
		["dag with chain", { dag: [node("a", "writer", "t")], chain: [{ agent: "writer", task: "t" }] }],
		["missing mode", {}],
	];
	for (const background of [false, true]) {
		for (const [label, params] of invalid) {
			const result = await tool.execute("bad", { ...params, background }, undefined, undefined, ctx);
			assert.equal(result.isError, true, `${label} (background ${background})`);
			assert.equal(result.details?.jobId, undefined, `${label} starts no job`);
		}
	}
	assert.equal(children().length, 0, "no child is spawned by any invalid graph");
	assert.equal(pi.sent.length, 0);
});

check("dag tool boundary: installed SDK validation refuses malformed nodes with zero spawns; explicit nulls reach runtime and are refused", async () => {
	const pi = fakePi();
	subagentExtension(pi);
	const tool = pi.tools.get("subagent")!;
	const ctx = dagCtx(makeRepo("dag-sdk-boundary"));
	const sdk = await import(piAiUrl);
	const call = (args: Record<string, unknown>) => ({ type: "toolCall" as const, id: "sdk", name: "subagent", arguments: args });
	const refused: Array<[string, Record<string, unknown>]> = [
		["unknown node key", { dag: [node("a", "writer", "t", { dependson: [] })], background: false }],
		["bad id", { dag: [node("1a", "writer", "t")], background: false }],
		["nine nodes", { dag: Array.from({ length: 9 }, (_, i) => node("n" + i, "writer", "t")), background: false }],
		["empty graph", { dag: [], background: false }],
	];
	for (const [label, args] of refused) assert.throws(() => sdk.validateToolArguments(tool, call(args)), /Validation failed/, label);
	assert.throws(() => sdk.validateToolArguments(tool, call({ dag: [node("a", "writer", "t", { modelTier: "openai/model" })], background: false })), /Validation failed/, "raw model IDs are outside the schema enum");
	const nulls: Array<[string, Record<string, unknown>]> = [
		["null dependsOn", node("a", "writer", "t", { dependsOn: null })],
		["null cwd", node("a", "writer", "t", { cwd: null })],
		["null readOnly", node("a", "writer", "t", { readOnly: null })],
		["null modelTier", node("a", "writer", "t", { modelTier: null })],
	];
	for (const [label, dagNode] of nulls) {
		const validated = sdk.validateToolArguments(tool, call({ dag: [dagNode], background: false }));
		const result = await tool.execute("sdk-null", validated, undefined, undefined, ctx);
		assert.equal(result.isError, true, label);
	}
	assert.doesNotThrow(() => sdk.validateToolArguments(tool, call({ dag: [node("a", "writer", "t")], background: false })), "omitted optionals pass");
	// The installed SDK accepts an unknown root key; the runtime must refuse it before any launch.
	const rootValidated = sdk.validateToolArguments(tool, call({ dag: [node("a", "writer", "t")], bogus: 1, background: false }));
	assert.equal((await tool.execute("sdk-root", rootValidated, undefined, undefined, ctx)).isError, true, "unknown root key refused after SDK validation");
	assert.equal(children().length, 0, "no child is spawned by any malformed or null graph");
	assert.equal(pi.sent.length, 0);
});

check("dag mode refuses unknown top-level keys with zero spawns; the schema's own root keys stay accepted; legacy single mode is unchanged", async () => {
	const pi = fakePi();
	subagentExtension(pi);
	const tool = pi.tools.get("subagent")!;
	const ctx = dagCtx(makeRepo("dag-root-keys"));
	const dag = [node("a", "writer", "t")];
	for (const extra of [{ bogus: 1 }, { agnet: "writer" }]) {
		// Refusal is immediate; the race turns a launch that would otherwise run into a failed assertion rather than a hang.
		const bg = await Promise.race([tool.execute("root-bg", { dag, background: true, ...extra }, undefined, undefined, ctx), sleep(500).then(() => undefined)]);
		assert.ok(bg, `${JSON.stringify(extra)} (background) is refused without waiting for a launch`);
		assert.equal(bg.isError, true, `${JSON.stringify(extra)} (background)`);
		assert.match(bg.content[0].text, /unknown top-level key/);
		assert.equal(bg.details?.jobId, undefined, "no job is started");
		const fg = await Promise.race([tool.execute("root-fg", { dag, background: false, ...extra }, undefined, undefined, ctx), sleep(500).then(() => undefined)]);
		assert.ok(fg, `${JSON.stringify(extra)} (foreground) is refused without waiting for a launch`);
		assert.equal(fg.isError, true, `${JSON.stringify(extra)} (foreground)`);
		assert.match(fg.content[0].text, /unknown top-level key/);
	}
	assert.equal(children().length, 0, "an unknown root key spawns nothing");
	assert.equal(pi.sent.length, 0);

	const known = tool.execute("root-known", { dag, background: false, agentScope: "user", confirmProjectAgents: false, readOnly: false }, undefined, undefined, ctx);
	await waitFor(() => children().length === 1, "known root keys are accepted: the node spawns");
	finish(children()[0], "done");
	assert.notEqual((await known).isError, true, "known root keys do not refuse the graph");

	const legacy = tool.execute("legacy-single", { agent: "writer", task: "t", bogus: 1, background: false }, undefined, undefined, ctx);
	await waitFor(() => children().length === 2, "legacy single mode still accepts unknown root keys");
	finish(children()[1], "done");
	assert.notEqual((await legacy).isError, true, "legacy single mode is unchanged");
});

check("background dag: completion is bounded to 4000 chars and subagent_control result recovers every node's full output", async () => {
	const pi = fakePi();
	subagentExtension(pi);
	const tool = pi.tools.get("subagent")!;
	const control = pi.tools.get("subagent_control")!;
	const ctx = dagCtx(makeRepo("dag-bg-bounded"));
	const started = await tool.execute("dag-bg", { background: true, dag: [node("a", "writer", "root"), node("b", "reader", "use", { dependsOn: ["a"], readOnly: true })] }, undefined, undefined, ctx);
	const jobId = started.details.jobId;
	await waitFor(() => children().length === 1, "root spawns");
	finish(children()[0], "A".repeat(3000) + "\nSTATUS: PASS");
	await waitFor(() => children().length === 2, "dependent spawns");
	finish(children()[1], "B".repeat(3000) + "\nSTATUS: PASS");
	await waitFor(() => pi.sent.length === 1, "completion delivered");
	assert.ok(pi.sent[0].content.length <= 4000, "automatic completion is bounded");
	assert.match(pi.sent[0].content, /INCOMPLETE HANDOFF/);
	const recovered = await control.execute("recover", { action: "result", target: jobId }, undefined, undefined, ctx);
	const text = recovered.content[0].text;
	assert.ok(text.includes("A".repeat(3000)) && text.includes("B".repeat(3000)), "every node's full output is recovered");
	assert.ok(text.includes('node "a"') && text.includes('node "b"'), "each node is headed by its node id");
});

check("background dag of four nodes sends exactly one completion for its job, with no late per-node duplicate", async () => {
	const pi = fakePi();
	subagentExtension(pi);
	const tool = pi.tools.get("subagent")!;
	const ctx = dagCtx(makeRepo("dag-once-per-job"));
	const started = await tool.execute("dag-once", { background: true, dag: [node("a", "writer", "root"), node("b", "reader", "left", { dependsOn: ["a"], readOnly: true }), node("c", "reader", "right", { dependsOn: ["a"], readOnly: true }), node("d", "reader", "join", { dependsOn: ["b", "c"], readOnly: true })] }, undefined, undefined, ctx);
	const jobId = started.details.jobId;
	await waitFor(() => children().length === 1, "root spawns");
	finish(children()[0], "A report\nSTATUS: PASS");
	await waitFor(() => children().length === 3, "b and c spawn");
	finish(children()[1], "B report\nSTATUS: PASS");
	finish(children()[2], "C report\nSTATUS: PASS");
	await waitFor(() => children().length === 4, "d spawns");
	finish(children()[3], "D report\nSTATUS: PASS");
	await waitFor(() => pi.sent.length === 1, "job completion delivered");
	await settle(450);
	assert.equal(pi.sent.length, 1, "no late duplicate completion for the same job");
	assert.equal(pi.sent[0].details.jobId, jobId, "the single completion names this job");
});

check("parallel background entries: the job keeps waiting while any queued claim on the checkout remains", async () => {
	const pi = fakePi();
	subagentExtension(pi);
	const tool = pi.tools.get("subagent")!;
	const control = pi.tools.get("subagent_control")!;
	const ctx = dagCtx(makeRepo("parallel-waiting"));
	const started = await tool.execute("parallel-waiting", { background: true, tasks: [{ agent: "writer", task: "a" }, { agent: "writer", task: "b" }, { agent: "writer", task: "c" }] }, undefined, undefined, ctx);
	const jobId = started.details.jobId;
	await waitFor(() => children().length === 1, "first writer spawns");
	let waiting: unknown;
	for (let i = 0; i < 200 && waiting !== WAITING; i++) {
		await settle(5);
		waiting = await listedWaiting(control, jobId);
	}
	assert.equal(waiting, WAITING, "the two queued writers show waiting");
	finish(children()[0], "a report");
	await waitFor(() => children().length === 2, "the second writer takes the released checkout");
	await settle();
	assert.equal(await listedWaiting(control, jobId), WAITING, "the third writer still waits, so the job still shows waiting");
	finish(children()[1], "b report");
	await waitFor(() => children().length === 3, "the third writer finally spawns");
	finish(children()[2], "c report");
	await settle(50);
});

check("dag background list: each worker reports the DAG node that launched it, distinct from worker IDs", async () => {
	const pi = fakePi();
	subagentExtension(pi);
	const tool = pi.tools.get("subagent")!;
	const control = pi.tools.get("subagent_control")!;
	const ctx = dagCtx(makeRepo("dag-list-node"));
	const started = await tool.execute("dag-list-node", { background: true, dag: [node("alpha", "writer", "one", { readOnly: true }), node("beta", "writer", "two", { readOnly: true })] }, undefined, undefined, ctx);
	const jobId = started.details.jobId;
	await waitFor(() => children().length === 2, "both readers spawn");
	const job = JSON.parse((await control.execute("list", { action: "list" }, undefined, undefined, ctx)).content[0].text).find((entry: { jobId: string }) => entry.jobId === jobId);
	const workers = job.workers.map((worker: { id: string; node?: string }) => ({ id: worker.id, node: worker.node }));
	assert.deepEqual(workers.map((worker: { node?: string }) => worker.node).sort(), ["alpha", "beta"]);
	assert.equal(new Set(workers.map((worker: { id: string }) => worker.id)).size, 2, "worker IDs stay distinct");
	assert.ok(workers.every((worker: { id: string; node?: string }) => worker.id !== worker.node), "node IDs are not worker IDs");
	finish(children()[0], "alpha report");
	finish(children()[1], "beta report");
	await settle(50);
});

check("dag cancel: in-flight children are killed and drained before the job settles; queued nodes never launch and show waiting", async () => {
	const pi = fakePi();
	subagentExtension(pi);
	const tool = pi.tools.get("subagent")!;
	const control = pi.tools.get("subagent_control")!;
	const ctx = dagCtx(makeRepo("dag-cancel"));
	const started = await tool.execute("dag-cancel", { background: true, dag: [node("a", "writer", "first"), node("b", "writer", "second")] }, undefined, undefined, ctx);
	const jobId = started.details.jobId;
	await waitFor(() => children().length === 1, "first writer spawns");
	let waiting: unknown;
	for (let i = 0; i < 200 && waiting !== WAITING; i++) {
		await settle(5);
		waiting = await listedWaiting(control, jobId);
	}
	assert.equal(waiting, WAITING, "queued node shows waiting");
	await control.execute("cancel", { action: "cancel", target: jobId }, undefined, undefined, ctx);
	await settle();
	assert.ok(children()[0].signals.length > 0, "in-flight child receives a kill signal");
	assert.equal(pi.sent.length, 0, "the job does not settle while its child is alive");
	children()[0].exit(1);
	await waitFor(() => pi.sent.length === 1, "job settles after the child exits");
	assert.equal(children().length, 1, "queued node never spawned");
	assert.match(pi.sent[0].content, /aborted/);
});

check("dag pause: a dependent launch waits for resume", async () => {
	const pi = fakePi();
	subagentExtension(pi);
	const tool = pi.tools.get("subagent")!;
	const control = pi.tools.get("subagent_control")!;
	const ctx = dagCtx(makeRepo("dag-pause"));
	const started = await tool.execute("dag-pause", { background: true, dag: [node("a", "writer", "root"), node("b", "reader", "use", { dependsOn: ["a"], readOnly: true })] }, undefined, undefined, ctx);
	const jobId = started.details.jobId;
	await waitFor(() => children().length === 1, "root spawns");
	await control.execute("pause", { action: "pause", target: jobId }, undefined, undefined, ctx);
	finish(children()[0], "A-OUT");
	await settle(60);
	assert.equal(children().length, 1, "the held job does not launch the dependent");
	await control.execute("resume", { action: "resume", target: jobId }, undefined, undefined, ctx);
	await waitFor(() => children().length === 2, "dependent launches after resume");
	finish(children()[1], "B-OUT");
	await waitFor(() => pi.sent.length === 1, "job completes");
});

check("dag background node holds the checkout across jobs: a legacy foreground writer waits for the graph child to exit", async () => {
	const pi = fakePi();
	subagentExtension(pi);
	const tool = pi.tools.get("subagent")!;
	const ctx = dagCtx(makeRepo("dag-cross"));
	await tool.execute("dag-cross-bg", { background: true, dag: [node("a", "writer", "graph")] }, undefined, undefined, ctx);
	await waitFor(() => children().length === 1, "graph node spawns");
	const legacy = tool.execute("legacy", { background: false, agent: "writer", task: "legacy" }, undefined, undefined, ctx);
	await settle();
	assert.equal(children().length, 1, "the legacy writer waits behind the graph node's claim");
	finish(children()[0], "graph done");
	await waitFor(() => children().length === 2, "legacy writer runs after the graph node exits");
	finish(children()[1], "legacy done");
	assert.notEqual((await legacy).isError, true);
});

// ---- All-job usage (/subagent usage): real execute and command paths for every mode; command output is numeric aggregates only ----
const priced = { input: 2, output: 3, totalTokens: 5, cacheRead: 0, cacheWrite: 0, cost: { total: 0.25 } };
// One finalized priced assistant turn; exit=false keeps the child alive so a cancel or reset can land mid-flight.
function emitPriced(child: Child, exit = true) {
	child.emitLine({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "ok" }], stopReason: "stop", usage: priced } });
	if (exit) child.exit(0);
}
function usageHarness() {
	const pi = fakePi();
	subagentExtension(pi);
	const notes: Array<{ message: string; type?: string }> = [];
	const ctx = { hasUI: true, mode: "tui", cwd: os.tmpdir(), ui: { notify: (message: string, type?: string) => notes.push({ message, type }) } };
	const command = async (args: string) => { notes.length = 0; await pi.commands.get("subagent")!.handler(args, ctx); return notes.slice(); };
	const usageText = async () => { const out = await command("usage"); assert.equal(out.length, 1, "usage prints exactly one notify"); assert.equal(out[0].type, "info"); return out[0].message; };
	const sessionStart = async () => { for (const fn of pi.handlers.get("session_start") ?? []) await fn({}, { cwd: os.tmpdir() }); };
	const launch = (id: string, params: Record<string, unknown>, cwd: string, signal?: AbortSignal) => pi.tools.get("subagent")!.execute(id, params, signal, undefined, dagCtx(cwd));
	return { pi, command, usageText, sessionStart, launch };
}

check("usage command: no jobs prints the empty state; one foreground single job settles with its priced turn", async () => {
	const h = usageHarness();
	assert.match(await h.usageText(), /No delegated agent tasks yet this run\./);
	assert.equal(h.pi.commands.get("subagent")!.description, "Open live subagent inspector", "the /subagent handler comes from the real monitor.ts registration");
	const launch = h.launch("u-single", { agent: "writer", task: "one", background: false }, makeRepo("usage-single"));
	await waitFor(() => children().length === 1, "single child spawns");
	emitPriced(children()[0]);
	assert.notEqual((await launch).isError, true);
	const text = await h.usageText();
	assert.match(text, /Foreground: 1 settled agent task \(1 completed, 0 failed, 0 aborted\); 1 attempt; 1 turn/);
	assert.match(text, /input 2 \| output 3 \| cacheRead 0 \| cacheWrite 0/);
	assert.match(text, /cost: \$0\.2500 SDK-estimated/);
	assert.match(text, /Background: none settled/);
});

check("usage command: foreground chain, parallel and DAG each settle one job per request, with no double count", async () => {
	const h = usageHarness();
	const repo = makeRepo("usage-fg");
	const chain = h.launch("u-chain", { background: false, chain: [{ agent: "writer", task: "one" }, { agent: "writer", task: "two" }] }, repo);
	await waitFor(() => children().length === 1, "chain step one spawns");
	emitPriced(children()[0]);
	await waitFor(() => children().length === 2, "chain step two spawns");
	emitPriced(children()[1]);
	assert.notEqual((await chain).isError, true);
	const parallel = h.launch("u-par", { background: false, tasks: [{ agent: "reader", task: "p1", cwd: makeRepo("usage-par-a") }, { agent: "reader", task: "p2", cwd: makeRepo("usage-par-b") }] }, repo);
	await waitFor(() => children().length === 4, "both parallel readers spawn");
	for (const child of children().slice(2)) emitPriced(child);
	assert.notEqual((await parallel).isError, true);
	const dag = h.launch("u-dag", { background: false, dag: [node("d1", "writer", "t1", { cwd: makeRepo("usage-dag-a") }), node("d2", "reader", "t2", { cwd: makeRepo("usage-dag-b") })] }, repo);
	await waitFor(() => children().length === 6, "both DAG nodes spawn");
	for (const child of children().slice(4)) emitPriced(child);
	assert.notEqual((await dag).isError, true);
	const text = await h.usageText();
	assert.match(text, /Foreground: 6 settled agent tasks \(6 completed, 0 failed, 0 aborted\); 6 attempts; 6 turns/);
	assert.match(text, /input 12 \| output 18 \| cacheRead 0 \| cacheWrite 0/);
	assert.match(text, /cost: \$1\.5000 SDK-estimated/);
	assert.match(text, /Background: none settled/);
});

check("usage command: background single, chain, parallel and DAG settle in their own slice; running jobs are excluded; reads never charge", async () => {
	const h = usageHarness();
	let emitted = 0;
	// Emits a priced turn for every child spawned so far, waiting until the expected total has spawned.
	const finishThrough = async (total: number) => { await waitFor(() => children().length === total, `${total} children spawn`); for (const child of children().slice(emitted, total)) emitPriced(child); emitted = total; };
	const started = await h.launch("u-bg", { agent: "writer", task: "bg" }, makeRepo("usage-bg"));
	const jobId = started.details.jobId as string;
	await waitFor(() => children().length === 1, "background single child spawns");
	const mid = await h.usageText();
	assert.match(mid, /Pending: 1 agent task incl\. queued, excluded until settled/);
	assert.match(mid, /Background: none settled/);
	await finishThrough(1);
	await waitFor(() => h.pi.sent.length === 1, "single background completion delivered");
	const done = await h.usageText();
	assert.match(done, /Background: 1 settled agent task \(1 completed, 0 failed, 0 aborted\); 1 attempt; 1 turn/);
	assert.match(done, /Foreground: none settled/);
	assert.doesNotMatch(done, /Pending:/);
	await h.command(`result ${jobId}`);
	await h.command("list");
	assert.equal(await h.usageText(), done, "result rereads and list never charge");
	assert.equal(h.pi.sent.length, 1, "usage and reads send no automatic message");
	// Background chain (two logical steps), parallel (two) and DAG (two) each run as one background job.
	await h.launch("u-bg-chain", { chain: [{ agent: "writer", task: "c1" }, { agent: "writer", task: "c2" }] }, makeRepo("usage-bg-chain"));
	await finishThrough(2);
	await finishThrough(3);
	await h.launch("u-bg-par", { tasks: [{ agent: "reader", task: "p1", cwd: makeRepo("usage-bg-par-a") }, { agent: "reader", task: "p2", cwd: makeRepo("usage-bg-par-b") }] }, makeRepo("usage-bg-par"));
	await finishThrough(5);
	await h.launch("u-bg-dag", { dag: [node("d1", "writer", "t1", { cwd: makeRepo("usage-bg-dag-a") }), node("d2", "reader", "t2", { cwd: makeRepo("usage-bg-dag-b") })] }, makeRepo("usage-bg-dag"));
	await finishThrough(7);
	await waitFor(() => h.pi.sent.length === 4, "all four background jobs report completion");
	const all = await h.usageText();
	assert.match(all, /Background: 7 settled agent tasks \(7 completed, 0 failed, 0 aborted\); 7 attempts; 7 turns/);
	assert.match(all, /input 14 \| output 21 \| cacheRead 0 \| cacheWrite 0/);
	assert.match(all, /cost: \$1\.7500 SDK-estimated/);
	assert.match(all, /Foreground: none settled/);
});

check("usage command: a cancelled background job keeps its finalized turn and settles as aborted", async () => {
	const h = usageHarness();
	const started = await h.launch("u-cancel", { agent: "writer", task: "c" }, makeRepo("usage-cancel"));
	await waitFor(() => children().length === 1, "background child spawns");
	emitPriced(children()[0], false);
	await h.command(`cancel ${started.details.jobId}`);
	children()[0].exit(1); // the test double records SIGTERM but does not close the child itself
	await waitFor(() => h.pi.sent.length === 1, "cancelled job completion delivered");
	const text = await h.usageText();
	assert.match(text, /Background: 1 settled agent task \(0 completed, 0 failed, 1 aborted\); 1 attempt; 1 turn/);
	assert.match(text, /input 2 \| output 3 \| cacheRead 0 \| cacheWrite 0/);
	assert.match(text, /cost: \$0\.2500 SDK-estimated/);
});

check("usage command: a session change starts a fresh scope; a job from before it charges only its old scope", async () => {
	const h = usageHarness();
	await h.launch("u-old", { agent: "writer", task: "old" }, makeRepo("usage-old"));
	await waitFor(() => children().length === 1, "old job spawns");
	emitPriced(children()[0], false);
	await h.sessionStart(); // reset aborts the old job; its child then closes
	children()[0].exit(1);
	await settle(50);
	assert.match(await h.usageText(), /No delegated agent tasks yet this run\./, "the old job must not charge the new scope");
	await h.launch("u-new", { agent: "writer", task: "new" }, makeRepo("usage-new"));
	await waitFor(() => children().length === 2, "new job spawns");
	emitPriced(children()[1]);
	await waitFor(() => h.pi.sent.length === 1, "new job completion delivered");
	const text = await h.usageText();
	assert.match(text, /Background: 1 settled agent task \(1 completed, 0 failed, 0 aborted\); 1 attempt; 1 turn/);
	assert.equal(h.pi.sent.length, 1, "the pre-reset job sends no completion");
});

// Finalized turn with an error stop: a failed logical task that still charges its priced turn.
function failWith(child: Child) {
	child.emitLine({ type: "message_end", message: { role: "assistant", content: [], stopReason: "error", errorMessage: "400 bad request", usage: priced } });
	child.exit(1);
}

check("usage command: foreground parallel mixes completion, failure and partial abort; each task settles once with its own status", async () => {
	const h = usageHarness();
	const controller = new AbortController();
	const mixed = h.launch("u-mix-par", { background: false, tasks: [
		{ agent: "reader", task: "ok", cwd: makeRepo("usage-mix-par-a") },
		{ agent: "reader", task: "fail", cwd: makeRepo("usage-mix-par-b") },
		{ agent: "reader", task: "cut", cwd: makeRepo("usage-mix-par-c") },
	] }, makeRepo("usage-mix-par"), controller.signal);
	await waitFor(() => children().length === 3, "three parallel readers spawn");
	emitPriced(children()[0]);
	children()[2].emitLine({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "partial" }], stopReason: "stop", usage: priced } });
	failWith(children()[1]);
	await settle(); // the completed and failed tasks settle before the abort, so only the cut task is aborted
	controller.abort(); // after the partial turn is finalized, so the cut task keeps it
	children()[2].exit(1); // the test double records SIGTERM but does not close the child itself
	await assert.rejects(mixed, /Subagent was aborted/, "a parallel abort rejects the call, as before");
	const text = await h.usageText();
	assert.match(text, /Foreground: 3 settled agent tasks \(1 completed, 1 failed, 1 aborted\); 3 attempts; 3 turns/);
	assert.match(text, /input 6 \| output 9 \| cacheRead 0 \| cacheWrite 0/);
	assert.match(text, /cost: \$0\.7500 SDK-estimated/);
	assert.match(text, /Background: none settled/);
});

check("usage command: a foreground chain stops at its failed step and a DAG blocks dependents of a failed node; only launched tasks count", async () => {
	const h = usageHarness();
	const repo = makeRepo("usage-mix-fg");
	const chain = h.launch("u-mix-chain", { background: false, chain: [{ agent: "writer", task: "s1" }, { agent: "writer", task: "s2" }, { agent: "writer", task: "s3" }] }, repo);
	await waitFor(() => children().length === 1, "chain step one spawns");
	emitPriced(children()[0]);
	await waitFor(() => children().length === 2, "chain step two spawns");
	failWith(children()[1]);
	await chain;
	await settle();
	assert.equal(children().length, 2, "the chain stops after its failed step; step three never launches");
	const dag = h.launch("u-mix-dag", { background: false, dag: [node("ok", "reader", "d1", { cwd: makeRepo("usage-mix-dag-a") }), node("bad", "writer", "d2", { cwd: makeRepo("usage-mix-dag-b") }), node("after", "reader", "d3", { cwd: makeRepo("usage-mix-dag-c"), dependsOn: ["bad"] })] }, repo);
	await waitFor(() => children().length === 4, "dag ok and bad nodes spawn");
	emitPriced(children()[2]);
	failWith(children()[3]);
	await dag;
	await settle();
	assert.equal(children().length, 4, "the dependent of a failed node never launches");
	const text = await h.usageText();
	assert.match(text, /Foreground: 4 settled agent tasks \(2 completed, 2 failed, 0 aborted\); 4 attempts; 4 turns/);
	assert.match(text, /input 8 \| output 12 \| cacheRead 0 \| cacheWrite 0/);
	assert.match(text, /cost: \$1\.0000 SDK-estimated/);
});

check("usage command: a background DAG node with a declared fallback counts both physical attempts on its one logical task", async () => {
	const h = usageHarness();
	// The DAG path discovers roles from the user dir, which the suite seeds with writer/reader only; this role declares the fallback.
	fs.writeFileSync(path.join(userDir, "agents", "chain-fallback.md"), `---\nname: chain-fallback\ndescription: chain-fallback\nmodel: ${PRIMARY}\nfallbackModel: "${LUNA}"\n---\n`);
	await h.launch("u-bg-dag-fb", { background: true, dag: [node("f", "chain-fallback", "primary")] }, makeRepo("usage-bg-dag-fb"));
	await waitFor(() => children().length === 1, "primary attempt spawns");
	assert.equal(children()[0].model, PRIMARY);
	children()[0].emitLine({ type: "message_end", message: { role: "assistant", content: [], stopReason: "error", errorMessage: "503 provider unavailable", usage: priced } });
	children()[0].exit(1);
	await waitFor(() => children().length === 2, "fallback attempt spawns");
	assert.equal(children()[1].model, LUNA);
	emitPriced(children()[1]);
	await waitFor(() => h.pi.sent.length === 1, "background DAG completion delivered");
	const text = await h.usageText();
	assert.match(text, /Background: 1 settled agent task \(1 completed, 0 failed, 0 aborted\); 2 attempts; 2 turns/);
	assert.match(text, /input 4 \| output 6 \| cacheRead 0 \| cacheWrite 0/);
	assert.match(text, /cost: \$0\.5000 SDK-estimated/);
	assert.match(text, /Foreground: none settled/);
});

check("dag concurrency is the shared cap: five independent nodes run at most four at a time", async () => {
	const pi = fakePi();
	subagentExtension(pi);
	const tool = pi.tools.get("subagent")!;
	const launch = tool.execute("dag-cap", { background: false, dag: Array.from({ length: 5 }, (_, i) => node("n" + i, "writer", "t" + i, { cwd: makeRepo("dag-cap-" + i) })) }, undefined, undefined, dagCtx(makeRepo("dag-cap-root")));
	await waitFor(() => children().length === 4, "four nodes fill the cap");
	await settle();
	assert.equal(children().length, 4, "the fifth node waits for capacity");
	finish(children()[0], "ok");
	await waitFor(() => children().length === 5, "fifth node starts when capacity frees");
	for (const child of children().slice(1)) finish(child, "ok");
	assert.notEqual((await launch).isError, true);
});

// Parallel launch failure: a throwing task (missing Claude subscription guard, fail closed) is one failed task beside its sibling, never a rejected call.
const BOOM_AGENT = "---\nname: boom\ndescription: boom\nmodel: anthropic/x\n---\n";
check("parallel: a throwing launch is one failed task; the sibling output is kept and the call resolves isError", async () => {
	fs.writeFileSync(path.join(userDir, "agents", "boom.md"), BOOM_AGENT);
	const pi = fakePi();
	subagentExtension(pi);
	const tool = pi.tools.get("subagent")!;
	const call = tool.execute("parallel-boom", { background: false, tasks: [{ agent: "reader", task: "good", cwd: makeRepo("parallel-boom-ok") }, { agent: "boom", task: "bad", cwd: makeRepo("parallel-boom-bad") }] }, undefined, undefined, dagCtx(makeRepo("parallel-boom")));
	await waitFor(() => children().length === 1, "the sibling reader spawns");
	finish(children()[0], "GOOD-RESULT");
	const result = await call;
	const text = result.content[0].text;
	assert.equal(result.isError, true);
	assert.match(text, /Parallel: 1\/2 succeeded/);
	assert.match(text, /GOOD-RESULT/);
	assert.match(text, /### \[boom\] failed/);
	assert.match(text, /Claude subscription guard missing/);
	assert.equal(children().length, 1, "the guard-missing task never spawns");
});

check("parallel background: a throwing launch ends the job failed and keeps the sibling output", async () => {
	fs.writeFileSync(path.join(userDir, "agents", "boom.md"), BOOM_AGENT);
	const pi = fakePi();
	subagentExtension(pi);
	const tool = pi.tools.get("subagent")!;
	const control = pi.tools.get("subagent_control")!;
	const ctx = dagCtx(makeRepo("parallel-boom-bg"));
	const started = await tool.execute("parallel-boom-bg", { background: true, tasks: [{ agent: "reader", task: "good", cwd: makeRepo("parallel-boom-bg-ok") }, { agent: "boom", task: "bad", cwd: makeRepo("parallel-boom-bg-bad") }] }, undefined, undefined, ctx);
	await waitFor(() => children().length === 1, "the sibling reader spawns");
	finish(children()[0], "GOOD-RESULT");
	await waitFor(() => pi.sent.length === 1, "completion delivered");
	await settle(450);
	assert.equal(pi.sent.length, 1, "one completion for the failed job, with no late duplicate");
	assert.equal(pi.sent[0].details.jobId, started.details.jobId, "the completion names this job");
	assert.equal(pi.sent[0].details.state, "failed", pi.sent[0].content);
	const recovered = await control.execute("recover", { action: "result", target: started.details.jobId }, undefined, undefined, ctx);
	const text = recovered.content[0].text;
	assert.match(text, /GOOD-RESULT/);
	assert.match(text, /Claude subscription guard missing/);
});

// Optional trusted PR base (prBase): per-entry in single/tasks/chain/dag, carried to every trusted release-engineer spawn as a bound push target.
// The child double records the PI_SAFETY_GRANTS envelope it was launched with; nothing real spawns and no gh/network is touched.
import { spawnSync } from "node:child_process";
const PRB_ORIGIN = "https://github.com/acme/widgets.git";
function makeFeatureRepo(label: string): string {
	const cfg = path.join(userDir, "prbase-gitconfig");
	fs.writeFileSync(cfg, "");
	process.env.GIT_CONFIG_GLOBAL = cfg; process.env.GIT_CONFIG_NOSYSTEM = "1";
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), `prbase-${label}-`));
	created.push(dir);
	const git = (...args: string[]) => assert.equal(spawnSync("git", args, { cwd: dir, windowsHide: true }).status, 0, `git ${args.join(" ")}`);
	git("init", "-q"); git("-c", "user.name=t", "-c", "user.email=t@example.test", "commit", "-q", "--allow-empty", "-m", "init");
	git("checkout", "-q", "-b", "feat/x"); git("remote", "add", "origin", PRB_ORIGIN);
	return fs.realpathSync.native(dir);
}
const envelopeOfChild = (child: Child) => child.env?.PI_SAFETY_GRANTS as string;
const parsedEnvelope = (child: Child) => JSON.parse(envelopeOfChild(child));
const bases = ["main", "release/1.x", undefined] as const;
const shapeArgs = (mode: string, items: any[], backgroundMode: boolean) => {
	const args: any = { background: backgroundMode, agentScope: "both" };
	if (mode === "single") Object.assign(args, items[0]);
	else if (mode === "dag") args.dag = items.map((item, i) => ({ ...item, id: `p${i}`, ...(i ? { dependsOn: [`p${i - 1}`] } : {}) }));
	else args[mode === "parallel" ? "tasks" : "chain"] = items;
	return args;
};

test("prBase reaches each trusted release-engineer spawn per entry in single, parallel, chain and dag (foreground and background); omitted stays the legacy envelope", { timeout: 120_000 }, async () => {
	const sdk = await import(piAiUrl);
	const core = await import(new URL("../safety-core.ts", import.meta.url).href);
	for (const mode of ["single", "parallel", "chain", "dag"] as const) for (const backgroundMode of [false, true]) {
		const host = fakePi(); subagentExtension(host);
		const tool = host.tools.get("subagent")!, control = host.tools.get("subagent_control")!;
		const ctx = dagCtx(makeFeatureRepo(`${mode}-${backgroundMode}`));
		const used = mode === "single" ? [bases[0]] : [...bases];
		const items = used.map((prBase, i) => ({ agent: "release-engineer", task: `entry-${i}`, ...(prBase !== undefined ? { prBase } : {}) }));
		const valid = sdk.validateToolArguments(tool, { type: "toolCall", id: "prb", name: "subagent", arguments: shapeArgs(mode, items, backgroundMode) });
		const offset = children().length;
		const launch = tool.execute("prb", valid, undefined, undefined, ctx);
		const acknowledgement = backgroundMode ? await launch : undefined;
		if (backgroundMode) assert.notEqual(acknowledgement!.isError, true);
		for (let i = 0; i < used.length; i++) {
			await waitFor(() => children().length === offset + i + 1, `${mode} ${backgroundMode} entry-${i} spawn`);
			const child = children()[offset + i];
			const env = parsedEnvelope(child);
			if (used[i] === undefined) {
				assert.equal("pushTargetBound" in env, false, `${mode} omitted base stays legacy`);
				assert.equal(env.pushTarget.branch, "feat/x");
			} else {
				assert.equal("pushTarget" in env, false);
				assert.equal(core.loadChildPushTarget(envelopeOfChild(child)).base, used[i], `${mode} ${backgroundMode} entry-${i}`);
			}
			finish(child, `entry-${i} done`);
		}
		if (backgroundMode) {
			const jobId = acknowledgement!.details.jobId;
			await waitFor(() => host.sent.some((m: any) => m.details?.jobId === jobId && m.details.state === "completed"), "completed");
			assert.notEqual((await control.execute("result", { action: "result", target: jobId }, undefined, undefined, ctx)).isError, true);
		} else assert.notEqual((await launch).isError, true);
	}
});

check("prBase is refused before any launch: batch root, malformed, null, same-feature, untrusted role and project-source impostor", async () => {
	const sdk = await import(piAiUrl);
	for (const mode of ["single", "parallel", "chain", "dag"] as const) {
		const host = fakePi(); subagentExtension(host);
		const tool = host.tools.get("subagent")!;
		const repo = makeFeatureRepo(`reject-${mode}`);
		const ctx = dagCtx(repo);
		const before = children().length;
		const refuse = async (args: any, why: string) => {
			const result = await tool.execute("prb-bad", args, undefined, undefined, ctx);
			assert.equal(result.isError, true, `${mode}: ${why}`);
			assert.equal(children().length, before, `${mode}: ${why}: nothing launched`);
			return result;
		};
		const good = (extra: Record<string, unknown> = {}) => ({ agent: "release-engineer", task: "t", ...extra });
		const at = (entries: any[]) => shapeArgs(mode, entries, false);
		if (mode !== "single") {
			const root = at([good(), good()]); root.prBase = "main";
			await refuse(root, "root prBase in batch mode");
			const rootNull = at([good(), good()]); rootNull.prBase = null;
			await refuse(rootNull, "root null prBase in batch mode");
			await refuse(at([good({ prBase: "main" }), { agent: "backend-worker", task: "t", prBase: "main" }]), "untrusted role in a later entry (no earlier spawn)");
		}
		for (const bad of ["", " main", "a..b", "-x", "feat/x", "x".repeat(101), 5, null, {}, ["main"]]) await refuse(at([good({ prBase: bad })]), `prBase ${JSON.stringify(bad)}`);
		await refuse(at([{ agent: "backend-worker", task: "t", prBase: "main" }]), "non-release-engineer role");
		await refuse(at([{ agent: "ghost-role", task: "t", prBase: "main" }]), "unknown role");
		// A project-source role named release-engineer is never the trusted context.
		const dir = path.join(repo, ".pi", "agents"); fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(path.join(dir, "release-engineer.md"), "---\nname: release-engineer\ndescription: impostor\n---\nNo prompt.\n");
		const impostor = at([good({ prBase: "main" })]); impostor.agentScope = "project"; impostor.confirmProjectAgents = false;
		await refuse(impostor, "project-source impostor");
		// The SDK schema keeps the field (and null) so the runtime, not a silent drop, decides.
		const kept = sdk.validateToolArguments(tool, { type: "toolCall", id: "prb", name: "subagent", arguments: at([good({ prBase: null })]) });
		const first: any = mode === "single" ? kept : (kept.dag ?? kept.chain ?? kept.tasks)[0];
		assert.equal(first.prBase, null, `${mode}: SDK validation keeps null for runtime refusal`);
		assert.throws(() => sdk.validateToolArguments(tool, { type: "toolCall", id: "prb", name: "subagent", arguments: at([good({ prBase: { x: 1 } })]) }), /Validation failed/);
	}
});

check("fallback attempts of one job keep the same bound base; a later job is bound independently", async () => {
	const repo = makeFeatureRepo("fallback-base");
	const agents = [role("release-engineer", { model: PRIMARY, fallbackModel: [LUNA] })];
	const core = await import(new URL("../safety-core.ts", import.meta.url).href);
	const run = (prBase: string | undefined, task: string) => (runSingleAgent as any)(repo, { prBase }, agents, "release-engineer", task, undefined, undefined, undefined, undefined, makeDetails);
	const offset = children().length;
	const first = run("main", "primary");
	await waitFor(() => children().length === offset + 1, "primary spawns");
	children()[offset].emitLine({ type: "message_end", message: { role: "assistant", content: [], stopReason: "error", errorMessage: "503 provider unavailable", usage: { input: 1, output: 1, totalTokens: 2, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } } } });
	children()[offset].exit(1);
	await waitFor(() => children().length === offset + 2, "fallback spawns");
	assert.equal(children()[offset + 1].model, LUNA);
	for (const child of [children()[offset], children()[offset + 1]]) assert.equal(core.loadChildPushTarget(envelopeOfChild(child)).base, "main");
	finish(children()[offset + 1], "done");
	await first;
	const later = run("release/1.x", "later");
	await waitFor(() => children().length === offset + 3, "later job spawns");
	assert.equal(core.loadChildPushTarget(envelopeOfChild(children()[offset + 2])).base, "release/1.x");
	finish(children()[offset + 2], "done");
	await later;
});

// Named structured-handoff regression: canonical packet (known base) -> dispatch entry.prBase -> real SDK tool -> release-engineer child envelope -> guard.
// Proves the structured handoff and guard only; it cannot prove an arbitrary parent never omits the field, and no task text is parsed.
const packetToEntry = (packet: { task: string; destination: { repo: string; head: string; base?: string } }) =>
	({ agent: "release-engineer", task: packet.task, ...(packet.destination.base !== undefined ? { prBase: packet.destination.base } : {}) });
check("known-base packet binds dispatch prBase; the child's bound target allows the matching PR create and rejects another base", async () => {
	const sdk = await import(piAiUrl);
	const core: any = await import(new URL("../safety-core.ts", import.meta.url).href);
	const packet = { task: "open the PR", destination: { repo: "acme/widgets", head: "feat/x", base: "release/1.x" } };
	const prCreate = (base: string) => `${["gh", "pr", "cre" + "ate"].join(" ")} --repo acme/widgets --base ${base} --head feat/x --title "T" --body "b"`;
	for (const mode of ["single", "parallel", "chain", "dag"] as const) {
		const host = fakePi(); subagentExtension(host);
		const tool = host.tools.get("subagent")!;
		const repo = makeFeatureRepo(`handoff-${mode}`);
		const valid = sdk.validateToolArguments(tool, { type: "toolCall", id: "kb", name: "subagent", arguments: shapeArgs(mode, [packetToEntry(packet)], false) });
		const offset = children().length;
		const launch = tool.execute("kb", valid, undefined, undefined, dagCtx(repo));
		await waitFor(() => children().length === offset + 1, `${mode} spawn`);
		const child = children()[offset];
		const target = core.loadChildPushTarget(envelopeOfChild(child));
		assert.equal(target.base, "release/1.x", `${mode}: bound target carries the exact packet base`);
		const guard = { scope: "child", store: core.createGrantStore(), agentDir: path.join(userDir, "agent"), pushTarget: target, gateCommits: true,
			live: { env: () => ({}), pushUrl: () => PRB_ORIGIN, tagStatus: () => 2, ghJson: () => ({}) } };
		const run = (command: string) => core.guardToolCall(guard, "bash", { command }, repo);
		assert.equal(run(prCreate("release/1.x")), undefined, `${mode}: matching base allowed`);
		assert.equal(run(prCreate("main"))?.block, true, `${mode}: different base rejected`);
		finish(child, "done");
		assert.notEqual((await launch).isError, true);
	}
});
