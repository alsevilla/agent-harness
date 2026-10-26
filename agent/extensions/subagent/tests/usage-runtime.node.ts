// Phase 1 usage ledger through the production runSingleAgent path (fake child spawn; real discovery and background module).
// Node-only (registerHooks, native TS). The canonical runner discovers this *.node.ts file and runs it directly.
import assert from "node:assert/strict";
import * as fs from "node:fs";
import { registerHooks } from "node:module";
import * as os from "node:os";
import * as path from "node:path";
import test, { after, before, beforeEach } from "node:test";
import { fileURLToPath } from "node:url";
import type { AgentConfig } from "../agents.ts";

const agentsUrl = new URL("../agents.ts", import.meta.url).href;
const indexUrl = new URL("../index.ts", import.meta.url).href;
const backgroundUrl = new URL("../background.ts", import.meta.url).href;
const usageUrl = new URL("../usage-telemetry.ts", import.meta.url).href;
const doublesUrl = new URL("./fixtures/runtime-doubles.mjs", import.meta.url).href;
const indexDependencies = new Set(["node:child_process", "@earendil-works/pi-ai", "typebox", "./monitor.ts", "./code-integrations.ts", "./build-env.ts"]);
const entryStubUrl = `data:text/javascript,${encodeURIComponent(
	"export default function providerCooldownEntry() {}\nexport function registerProviderCooldown() {}\nexport async function runProviderCooldownCommand() { return { message: '', type: 'info' }; }\nexport async function providerLaunchState() { return { state: 'launch' }; }\nexport async function guardRefusalReplayable() { return false; }\nexport function providerCooldownGuard() {}\n",
)}`;

registerHooks({
	resolve(specifier, context, nextResolve) {
		if (specifier === "@earendil-works/pi-coding-agent") return { url: doublesUrl, shortCircuit: true };
		if (context.parentURL === indexUrl && specifier === "./provider-cooldown-entry.ts") return { url: entryStubUrl, shortCircuit: true };
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
interface SpawnPlan { events?: Event[]; exitCode?: number; hang?: boolean }
interface Usage { input: number; output: number; totalTokens: number; cacheRead: number; cacheWrite: number; cost: { total: number } }

let runSingleAgent: (...args: unknown[]) => Promise<any>;
let bg: any;
let usageTelemetry: any;
let discoverAgents: typeof import("../agents.ts").discoverAgents;
let spawnPlan: (model: string) => SpawnPlan = () => success();
let attempts: string[] = [];
(globalThis as { __piSubagentFakeSpawn?: (args: string[]) => SpawnPlan }).__piSubagentFakeSpawn = (args) => {
	const model = args[args.indexOf("--model") + 1];
	attempts.push(model);
	return spawnPlan(model);
};
(globalThis as { __piProviderLaunch?: (model: string) => unknown }).__piProviderLaunch = () => ({ state: "launch" });
(globalThis as { __piGuardRefusal?: (model: string, message?: string) => boolean }).__piGuardRefusal = () => false;

const PRIMARY = "openai-codex/gpt-6.1-sol";
const LUNA = "openai-codex/gpt-6-luna";

function usage(input: number, output: number, totalTokens: number, cost: number, cacheRead = 0, cacheWrite = 0): Usage {
	return { input, output, totalTokens, cacheRead, cacheWrite, cost: { total: cost } };
}
// provider/model on the message lets the production provenance observe the served identity.
function assistant(stopReason: string, text: string, tokens: Usage, provider: string, model: string, errorMessage?: string): Event {
	return { type: "message_end", message: { role: "assistant", provider, model, content: text ? [{ type: "text", text }] : [], stopReason, errorMessage, usage: tokens } };
}
const success = (tokens: Usage, provider: string, model: string): SpawnPlan => ({ events: [assistant("stop", "done", tokens, provider, model)], exitCode: 0 });
const unavailable = (tokens: Usage, provider: string, model: string): SpawnPlan => ({ events: [assistant("error", "", tokens, provider, model, "503 provider unavailable")], exitCode: 1 });

const created: string[] = [];
const originalAgentDir = process.env.PI_CODING_AGENT_DIR;

before(async () => {
	({ discoverAgents } = await import(agentsUrl));
	({ runSingleAgent } = await import(indexUrl));
	bg = await import(backgroundUrl);
	usageTelemetry = await import(usageUrl);
});
beforeEach(() => {
	attempts = [];
	spawnPlan = () => success(usage(1, 1, 2, 0.01), "openai-codex", "gpt-6-luna");
});
after(() => {
	if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
	for (const dir of created) fs.rmSync(dir, { recursive: true, force: true });
});

function setupRoots() {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "subagent-usage-"));
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
const discover = (cwd: string): AgentConfig[] => discoverAgents(cwd, "user").agents;
const scoped = (cwd: string, agents: AgentConfig[], name: string, dispatch: Record<string, unknown>) =>
	runSingleAgent(cwd, dispatch, agents, name, "task", undefined, undefined, undefined, undefined, (results: unknown[]) => ({ results }));

test("fallback retry settles one ledger record: configured primary, observed served model, every turn and attempt summed once", async () => {
	const fx = setupRoots();
	writeRole(fx.userAgents, "ledger-retry", { model: PRIMARY, fallbackModel: `"${LUNA}"` });
	spawnPlan = (model) => (model === PRIMARY ? unavailable(usage(10, 4, 14, 0.5, 20, 5), "openai-codex", "gpt-6.1-sol") : success(usage(7, 2, 9, 0.25, 30, 1), "openai-codex", "gpt-6-luna"));
	const scope = bg.newUsageScope();
	const result = await scoped(fx.nested, discover(fx.nested), "ledger-retry", { usageScope: scope });
	assert.equal(result.exitCode, 0);
	assert.deepEqual(attempts, [PRIMARY, LUNA]);
	assert.equal(scope.foreground.completed, 1);
	assert.equal(scope.tasks.length, 1, "settled once, not once per attempt");
	const record = scope.tasks[0];
	assert.equal(record.role, "ledger-retry");
	assert.equal(record.status, "completed");
	assert.equal(record.attempts, 2);
	assert.equal(record.turns, 2);
	assert.equal(record.firstTurnPromptTokens, 35, "first turn is the primary attempt: 10 + 20 + 5");
	assert.equal(record.peakPromptTokens, 38, "peak is the fallback turn: 7 + 30 + 1, output excluded");
	assert.equal(record.output, 6);
	assert.ok(Math.abs(record.cost - 0.75) < 1e-12);
	assert.equal(record.configuredModel, PRIMARY);
	assert.equal(record.observedModel, LUNA);
});

test("a failed settle is recorded as failed with one attempt and with its reported identity", async () => {
	const fx = setupRoots();
	writeRole(fx.userAgents, "ledger-fail", { model: PRIMARY });
	spawnPlan = () => unavailable(usage(3, 1, 4, 0.1), "openai-codex", "gpt-6.1-sol");
	const scope = bg.newUsageScope();
	await scoped(fx.nested, discover(fx.nested), "ledger-fail", { usageScope: scope });
	assert.equal(scope.foreground.failed, 1);
	assert.equal(scope.tasks[0].status, "failed");
	assert.equal(scope.tasks[0].attempts, 1);
	assert.equal(scope.tasks[0].observedModel, "openai-codex/gpt-6.1-sol", "a completed identity from the failed attempt is observed");
});


test("a background settle carries its planner consultation link; advice is recorded on the same run scope", async () => {
	const fx = setupRoots();
	writeRole(fx.userAgents, "planner", { model: PRIMARY });
	const scope = bg.newUsageScope();
	const consultationId = usageTelemetry.openConsultation(scope, { trigger: "t3", taskId: "phase-1" });
	await scoped(fx.nested, discover(fx.nested), "planner", { usageScope: scope, jobId: "bg-1", consultationId });
	assert.equal(scope.background.completed, 1);
	assert.equal(scope.tasks[0].consultationId, consultationId);
	usageTelemetry.applyAdvice(scope.consultations, consultationId, "rejected");
	const report = usageTelemetry.plannerReport(scope);
	assert.equal(report.rejected, 1);
	assert.equal(report.pending, 0);
	assert.equal(report.tasks[0].settled, 1);
});
