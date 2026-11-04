// Optional role.budget schema: closed-key validation, discovery mapping (fail closed), the roles editor's one-line preservation on both save paths,
// and proof that the shipped roles.json defines no budget. Fixtures live in an owned temp root; the real profile is never written.
import assert from "node:assert/strict";
import * as fs from "node:fs";
import { registerHooks } from "node:module";
import * as os from "node:os";
import * as path from "node:path";
import test, { after } from "node:test";
import { pathToFileURL } from "node:url";
import { hostModules as resolveHostModules } from "./host-modules.ts";

const hostModules = resolveHostModules();
const installedUrl = (rel: string) => pathToFileURL(path.resolve(hostModules, "@earendil-works", rel)).href;
registerHooks({
	resolve(specifier: string, context: object, nextResolve: (s: string, c: object) => { url: string }) {
		if (specifier === "@earendil-works/pi-coding-agent") return { url: installedUrl("pi-coding-agent/dist/index.js"), shortCircuit: true };
		if (specifier === "@earendil-works/pi-ai") return { url: installedUrl("pi-ai/dist/index.js"), shortCircuit: true };
		if (specifier === "@earendil-works/pi-tui") return { url: installedUrl("pi-tui/dist/index.js"), shortCircuit: true };
		return nextResolve(specifier, context);
	},
} as never);
const agents: any = await import(new URL("../agents.ts", import.meta.url).href);
const editor: any = await import(new URL("../roles-editor.ts", import.meta.url).href);

const created: string[] = [];
const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
after(() => {
	if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
	for (const dir of created) fs.rmSync(dir, { recursive: true, force: true });
});

const TIER = { name: "alpha", defaultModelTier: "capable", modelTiers: { capable: { model: "openai-codex/gpt-6.1-sol", fallbackModel: "", thinking: "high" } }, tools: "read" };
const LEGACY = { name: "alpha", provider: "openai-codex", model: "gpt-6.1-sol", fallbackModel: "", thinking: "high", tools: "read" };
const BUDGET = { maxTurns: 12, contextBudget: 90000 };

function fixture(entries: unknown[]) {
	const dir = fs.mkdtempSync(path.join(process.env.TEMP ?? os.tmpdir(), "role-budget-schema-"));
	created.push(dir);
	fs.mkdirSync(path.join(dir, "agents"), { recursive: true });
	fs.writeFileSync(path.join(dir, "roles.json"), JSON.stringify(entries, null, 2) + "\n");
	fs.writeFileSync(path.join(dir, "agents", "alpha.md"), "---\nname: alpha\ndescription: alpha test role\ntools: read\n---\nBody for alpha.\n");
	process.env.PI_CODING_AGENT_DIR = dir;
	return dir;
}
const catalog = { models: () => [], find: () => undefined, configured: () => false };

test("closed role keys accept a valid budget on every entry format and reject every invalid one", () => {
	for (const entry of [LEGACY, TIER, { name: "alpha" }]) {
		assert.equal(agents.roleRegistryViolation([{ ...entry, budget: BUDGET }]), null, JSON.stringify(entry));
		assert.equal(agents.roleRegistryViolation([{ ...entry, budget: { maxTurns: 3 } }]), null);
	}
	for (const budget of [{}, { maxTurns: 0 }, { maxTurns: -1 }, { maxTurns: 1.5 }, { contextBudget: "9" }, { maxTurns: 2, tokens: 5 }, null, [], 7, "x"]) {
		for (const entry of [LEGACY, TIER, { name: "alpha" }]) assert.match(agents.roleRegistryViolation([{ ...entry, budget }]) ?? "", /budget/, JSON.stringify(budget));
	}
	// The live-profile mode skips legacy entries, but a present budget key is still validated (never silently ignored).
	assert.match(agents.roleRegistryViolation([{ ...LEGACY, budget: { maxTurns: 0 } }], false, true) ?? "", /budget/);
	assert.equal(agents.roleRegistryViolation([LEGACY], false, true), null);
});

test("discovery maps a valid user role budget onto the role and omits the key everywhere else", () => {
	fixture([{ name: "alpha", budget: BUDGET }]);
	const result = agents.discoverAgents(process.env.PI_CODING_AGENT_DIR, "user");
	assert.equal(result.error, undefined);
	assert.deepEqual(result.agents.find((a: any) => a.name === "alpha").budget, BUDGET);
	for (const other of result.agents.filter((a: any) => a.name !== "alpha")) assert.equal("budget" in other, false, other.name);
});

test("an invalid user role budget fails discovery closed instead of running uncapped", () => {
	fixture([{ name: "alpha", budget: { maxTurns: 0 } }]);
	const result = agents.discoverAgents(process.env.PI_CODING_AGENT_DIR, "user");
	assert.match(result.error ?? "", /budget/);
	assert.deepEqual(result.agents, []);
});

function savedEntries(dir: string, thinking: string) {
	const snap = editor.readRoleSnapshot(dir, "alpha", null);
	const plan = editor.planRoleChange(snap, { primary: snap.current.primary, fallbacks: snap.current.fallbacks, thinking }, catalog);
	return JSON.parse(plan.registryText) as Array<Record<string, unknown>>;
}

test("roles editor tier-format save preserves the budget and nothing else changes", () => {
	const dir = fixture([{ ...TIER, budget: BUDGET }]);
	const [row] = savedEntries(dir, "medium");
	assert.deepEqual(row.budget, BUDGET);
	assert.deepEqual(row, { ...TIER, modelTiers: { capable: { ...TIER.modelTiers.capable, thinking: "medium" } }, budget: BUDGET });
});

test("roles editor legacy-format save preserves the budget", () => {
	const dir = fixture([{ ...LEGACY, budget: BUDGET }]);
	const [row] = savedEntries(dir, "medium");
	assert.deepEqual(row.budget, BUDGET);
	assert.equal(row.thinking, "medium");
});

test("roles editor still writes no budget key for roles that never had one", () => {
	for (const entry of [TIER, LEGACY]) {
		const dir = fixture([entry]);
		assert.equal("budget" in savedEntries(dir, "medium")[0], false);
	}
});

test("roles editor refuses to save over an invalid budget", () => {
	const dir = fixture([{ ...TIER, budget: { maxTurns: -2 } }]);
	assert.throws(() => editor.readRoleSnapshot(dir, "alpha", null), /budget/);
});

// Manual scanner parity (scripts/scan-harness-config.mjs keeps its own shape mirror): it must accept exactly the budgets the native reader accepts.
const scanner: any = await (async () => {
	const previous = process.env.NATIVE_PROBE_HOST_MODULES;
	process.env.NATIVE_PROBE_HOST_MODULES = hostModules; // the scanner resolves the house parser at import
	try { return await import(new URL("../../../../scripts/scan-harness-config.mjs", import.meta.url).href); } finally { if (previous === undefined) delete process.env.NATIVE_PROBE_HOST_MODULES; else process.env.NATIVE_PROBE_HOST_MODULES = previous; }
})();
const scannerAccepts = (entry: unknown) => scanner.declaredDefaults([entry]).has("alpha");

test("manual scanner accepts every valid budget on tier and legacy entries", () => {
	for (const entry of [LEGACY, TIER]) {
		assert.equal(scannerAccepts(entry), true, "base entry");
		for (const budget of [BUDGET, { maxTurns: 3 }, { contextBudget: 1 }]) assert.equal(scannerAccepts({ ...entry, budget }), true, JSON.stringify(budget));
	}
});

test("manual scanner rejects every invalid budget exactly like the native reader", () => {
	for (const budget of [{}, { maxTurns: 0 }, { maxTurns: -1 }, { maxTurns: 1.5 }, { maxTurns: Number.MAX_SAFE_INTEGER + 1 }, { contextBudget: "9" }, { maxTurns: 2, tokens: 5 }, null, [], 7, "x"]) {
		for (const entry of [LEGACY, TIER]) {
			assert.equal(scannerAccepts({ ...entry, budget }), false, JSON.stringify(budget));
			assert.match(agents.roleRegistryViolation([{ ...entry, budget }]) ?? "", /budget/, "native reader agrees");
		}
	}
});

test("the shipped roles.json defines no budget: the feature stays opt-in", () => {
	const shipped = JSON.parse(fs.readFileSync(new URL("../../../roles.json", import.meta.url), "utf8")) as Array<Record<string, unknown>>;
	assert.ok(shipped.length > 0);
	assert.equal(shipped.some((entry) => "budget" in entry), false);
});
