// Parity: the topology check PREDICTS the native subagent tool's tier refusal. The ACTUAL candidate subagent tool.execute runs with process-throwing doubles
// (every spawn and execFile throws and is counted, the provider stack is a double), so no child process or model call can occur. Own test file: it registers
// process-wide module hooks (removed in the final hook) and sets the SDK's agent directory variable only inside the helper.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after, test } from "node:test";
import { registerHooks } from "node:module";
import { pathToFileURL } from "node:url";
import { createPiSdkAdapter } from "./lib/sdk-adapter.mjs";
import { candidateRuntime } from "./lib/runtime.mjs";
import { CANDIDATE, PI_ROOT, mkTmp, copyDir, withAgentDir } from "./fixtures/topology-fixture.mjs";

const R = pathToFileURL(CANDIDATE + path.sep).href;
const url = (rel) => R + rel;
const data = (s) => "data:text/javascript," + encodeURIComponent(s);
const SDK = pathToFileURL(path.join(PI_ROOT, "dist", "index.js")).href;
const index = url("agent/extensions/subagent/index.ts"); const agentsTs = url("agent/extensions/subagent/agents.ts"); const entry = url("agent/extensions/subagent/provider-cooldown-entry.ts");
const doubles = url("agent/extensions/subagent/tests/fixtures/runtime-doubles.mjs");
globalThis.__benchSpawnAttempts = [];
const child = data('export function spawn(c){globalThis.__benchSpawnAttempts.push(String(c));throw Error("NO PROCESS ALLOWED");} export function execFileSync(){throw Error("NO PROCESS ALLOWED");} export function spawnSync(){throw Error("NO PROCESS ALLOWED");}');
const monitor = data("export class WorkerMonitor {constructor(){this.store={records:new Map(),changed(){},begin(){return {id:'w'}},finish(){},started(){}};}}");
const cool = data('export const anthropicMessagesApi=()=>({streamSimple:()=>{throw Error("offline");}});export const openAICodexResponsesApi=anthropicMessagesApi;export function createAssistantMessageEventStream(){throw Error("offline");}');
const hooks = registerHooks({ resolve(s, c, next) {
	const p = String(c.parentURL);
	if ((s === "@earendil-works/pi-ai/compat" && p.startsWith(R)) || (s === "@earendil-works/pi-ai" && c.parentURL === entry)) return { url: cool, shortCircuit: true };
	if (s === "@earendil-works/pi-coding-agent" && c.parentURL === agentsTs) return { url: SDK, shortCircuit: true };
	if (["@earendil-works/pi-coding-agent", "@earendil-works/pi-ai", "typebox"].includes(s) && p.startsWith(R)) return { url: doubles, shortCircuit: true };
	if (s === "node:child_process" && p.includes("/agent/extensions/")) return { url: child, shortCircuit: true };
	if (s === "./monitor.ts" && c.parentURL === index) return { url: monitor, shortCircuit: true };
	return next(s, c);
} });
after(() => hooks.deregister());

const { default: extension } = await import(index);
const tools = new Map();
extension({ tools, on() {}, registerTool: (t) => tools.set(t.name, t), registerProvider() {}, registerCommand() {}, getCommands: () => [], appendEntry() {}, sendMessage() {} });
const REFUSAL = /modelTier is only supported for canonical package roles/;
async function native(cwd, agent, tier) {
	const before = globalThis.__benchSpawnAttempts.length;
	let text;
	try { const r = await tools.get("subagent").execute("p", { agent, task: "noop", background: false, agentScope: "user", confirmProjectAgents: false, modelTier: tier }, undefined, undefined, { cwd, hasUI: false, isProjectTrusted: () => true }); text = String(r.content?.[0]?.text ?? ""); } catch (e) { text = String(e.message); }
	return { text, spawns: globalThis.__benchSpawnAttempts.length - before };
}
const predict = (agentDir, cwd) => withAgentDir(agentDir, () => createPiSdkAdapter({ piPackageRoot: PI_ROOT }).agentTopology({ runtime: candidateRuntime({ candidateRoot: CANDIDATE }), cwd }));

test("separate byte-identical copies: predicted shadowing equals the native capable/economy refusal, with zero process spawns", async () => {
	const base = mkTmp("native-copies"); const agentDir = path.join(base, "profile"); const cwd = path.join(base, "cwd"); fs.mkdirSync(cwd, { recursive: true });
	copyDir(path.join(CANDIDATE, "agent", "agents"), path.join(agentDir, "agents"), (f) => f.endsWith(".md"));
	const proof = await predict(agentDir, cwd);
	assert.equal(proof.ok, false);
	assert.ok(proof.problems.some((p) => p.role === "general-worker" && p.kind === "agent_source_shadowed"));
	await withAgentDir(agentDir, async () => {
		for (const [agent, tier] of [["general-worker", "capable"], ["general-worker", "economy"], ["security-specialist", "capable"]]) {
			const r = await native(cwd, agent, tier);
			assert.match(r.text, REFUSAL, `${agent}/${tier}: ${r.text.slice(0, 120)}`);
			assert.equal(r.spawns, 0);
		}
	});
});

test("an empty agent directory: predicted ok equals the native tier gate being passed (the later call path is stopped by the spawn double, never a real process)", async () => {
	const base = mkTmp("native-empty"); const agentDir = path.join(base, "profile"); const cwd = path.join(base, "cwd"); fs.mkdirSync(path.join(agentDir, "agents"), { recursive: true }); fs.mkdirSync(cwd, { recursive: true });
	const proof = await predict(agentDir, cwd);
	assert.equal(proof.ok, true, JSON.stringify(proof.problems));
	await withAgentDir(agentDir, async () => {
		for (const tier of ["capable", "economy"]) {
			const r = await native(cwd, "general-worker", tier);
			assert.doesNotMatch(r.text, REFUSAL, `${tier}: the tier gate must pass`);
			assert.doesNotMatch(r.text, /Invalid modelTier/);
		}
	});
});
