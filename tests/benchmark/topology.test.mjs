// Agent topology preflight: the REAL native discoverAgents and resolveModelTier (loaded from the candidate's own extension directory with the INSTALLED
// SDK) decide whether every canonical package role is really a package role. Fixtures live in temp trees; no session, provider, credential or profile write.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { createPiSdkAdapter } from "./lib/sdk-adapter.mjs";
import { checkAgentTopology, TOPOLOGY_METHOD } from "./lib/topology.mjs";
import { resourceShadowing } from "./lib/runtime.mjs";
import { CANDIDATE, PI_ROOT, mkTmp, write, copyDir, packageFixture, withAgentDir } from "./fixtures/topology-fixture.mjs";

const kinds = (r) => [...new Set(r.problems.map((p) => p.kind))].sort();
// Each check runs through the real adapter path with an isolated ambient agent directory.
async function topo(fx, { agentDir, cwd, root = PI_ROOT } = {}) {
	const ad = createPiSdkAdapter({ piPackageRoot: root });
	return withAgentDir(agentDir, () => ad.agentTopology({ runtime: fx.runtime, cwd: cwd ?? mkTmp("cwd") }));
}

test("the installed SDK root exists (a missing root is a loud failure, never a skip)", () => {
	assert.ok(fs.existsSync(path.join(PI_ROOT, "dist", "index.js")), `installed Pi SDK not found at ${PI_ROOT}`);
});

test("RED shape: byte-identical separate copies in the agent dir are USER overrides, while the content-hash shadowing check still says []", async () => {
	const base = mkTmp("copies"); const fx = packageFixture(base); const agentDir = path.join(base, "profile");
	copyDir(fx.agents, path.join(agentDir, "agents"));
	assert.deepEqual(resourceShadowing({ candidateRoot: fx.root, agentDir }).shadowed, [], "the old check is blind to physical identity");
	const r = await topo(fx, { agentDir });
	assert.equal(r.ok, false);
	assert.deepEqual(kinds(r), ["agent_source_shadowed"]);
	assert.equal(r.problems.filter((p) => p.scope === "user").length, fx.names.length);
	assert.ok(r.problems.every((p) => p.source === "user" && typeof p.role === "string"));
	assert.equal(r.method, TOPOLOGY_METHOD);
});

test("GREEN: hard links created between two files INSIDE the test temp tree are the same physical definition", async () => {
	const base = mkTmp("links"); const fx = packageFixture(base); const agentDir = path.join(base, "profile");
	fs.mkdirSync(path.join(agentDir, "agents"), { recursive: true });
	for (const n of fx.names) fs.linkSync(path.join(fx.agents, `${n}.md`), path.join(agentDir, "agents", `${n}.md`));
	const r = await topo(fx, { agentDir });
	assert.equal(r.ok, true, JSON.stringify(r.problems));
});

test("GREEN: an empty agents directory, an absent one, and the package agents directory itself", async () => {
	const base = mkTmp("empty"); const fx = packageFixture(base);
	const empty = path.join(base, "empty-profile"); fs.mkdirSync(path.join(empty, "agents"), { recursive: true });
	assert.equal((await topo(fx, { agentDir: empty })).ok, true);
	assert.equal((await topo(fx, { agentDir: path.join(base, "absent-profile") })).ok, true);
	const same = await topo(fx, { agentDir: path.join(fx.root, "agent") });
	assert.equal(same.ok, true, JSON.stringify(same.problems));
});

test("the proof records every configured tier and the default for every canonical role, resolved to the configured model and thinking", async () => {
	const base = mkTmp("tiers"); const fx = packageFixture(base);
	const r = await topo(fx, { agentDir: path.join(base, "absent") });
	assert.equal(r.ok, true);
	const configured = JSON.parse(fs.readFileSync(path.join(CANDIDATE, "agent", "roles.json"), "utf8"));
	assert.deepEqual(r.canonical.map((c) => c.name).sort(), configured.map((c) => c.name).sort(), "canonical names come from the candidate's configured roles, not a magic count");
	for (const c of r.canonical) assert.deepEqual(c.tiers, ["default", ...Object.keys(configured.find((x) => x.name === c.name).modelTiers)]);
	for (const scope of r.scopes) assert.ok(r.agents[scope].every((a) => a.source === "package" && a.file === `agent/agents/${a.name}.md`));
	assert.match(r.fingerprint, /^[0-9a-f]{64}$/);
});

const roleDef = (fx, name) => fs.readFileSync(path.join(fx.agents, `${name}.md`), "utf8");

test("a canonical project override in the replay's nearest project agents directory is blocked in scope both, not in scope user", async () => {
	const base = mkTmp("proj"); const fx = packageFixture(base);
	const cwd = path.join(base, "replay", "deep"); fs.mkdirSync(cwd, { recursive: true });
	write(path.join(base, "replay", ".pi", "agents", "general-worker.md"), roleDef(fx, "general-worker"));
	const r = await topo(fx, { agentDir: path.join(base, "absent"), cwd });
	assert.equal(r.ok, false);
	assert.deepEqual(r.problems.map((p) => [p.kind, p.scope, p.role, p.source]), [["agent_source_project_override", "both", "general-worker", "project"]]);
	assert.equal(path.resolve(r.projectAgentDir), path.resolve(base, "replay", ".pi", "agents"));
	assert.equal((await topo(fx, { agentDir: path.join(base, "absent") })).ok, true, "no project agents directory: green");
});

test("a DIFFERENT user definition of a canonical role is blocked; a non-canonical user role is harmlessly ignored", async () => {
	const base = mkTmp("user"); const fx = packageFixture(base); const agentDir = path.join(base, "profile");
	write(path.join(agentDir, "agents", "my-custom-helper.md"), "---\nname: my-custom-helper\ndescription: harmless extra\ntools: read\n---\nhelp\n");
	const harmless = await topo(fx, { agentDir });
	assert.equal(harmless.ok, true, JSON.stringify(harmless.problems));
	write(path.join(agentDir, "agents", "scout.md"), roleDef(fx, "scout").replace(/\n$/, "") + "\nlocally edited\n");
	const r = await topo(fx, { agentDir });
	assert.deepEqual(r.problems.map((p) => [p.kind, p.scope, p.role, p.source]), [["agent_source_shadowed", "user", "scout", "user"], ["agent_source_shadowed", "both", "scout", "user"]]);
});

test("a discovery error and a missing canonical role are structured problems without raw error text", async () => {
	const base = mkTmp("missing"); const fx = packageFixture(base);
	fs.rmSync(path.join(fx.agents, "scout.md"));
	const r = await topo(fx, { agentDir: path.join(base, "absent") });
	assert.equal(r.ok, false);
	assert.ok(kinds(r).every((k) => ["discovery_error", "agent_missing"].includes(k)), kinds(r).join());
	assert.ok(r.problems.every((p) => !("error" in p) && !("message" in p)), "allowlisted fields only");
});

// Pure helper boundary: discovery and tier resolution are injected, so tier failures can be shaped without touching the native code.
const configured = JSON.parse(fs.readFileSync(path.join(CANDIDATE, "agent", "roles.json"), "utf8"));
const pureAgents = (over = {}) => configured.map((c) => ({ name: c.name, source: "package", filePath: path.join(CANDIDATE, "agent", "agents", `${c.name}.md`), ...over }));
const exact = (agent, tier) => { const d = configured.find((c) => c.name === agent.name); const t = tier ?? d.defaultModelTier; return { model: d.modelTiers[t].model, thinking: d.modelTiers[t].thinking, modelTier: t }; };
const pure = (over = {}) => checkAgentTopology({ candidateRoot: CANDIDATE, extensionEntry: path.join(CANDIDATE, "agent/extensions/subagent/index.ts"), cwd: "C:/x", discover: () => ({ agents: pureAgents(), projectAgentsDir: null }), resolveTier: exact, scopes: ["user", "both"], ...over });

test("pure helper: all configured tiers and defaults resolving to the configured model and thinking is ok", () => {
	const r = pure();
	assert.equal(r.ok, true, JSON.stringify(r.problems));
	assert.equal(r.canonical.length, configured.length);
});

test("pure helper: a configured tier that does not resolve, or resolves to another model or thinking, is tier_unresolved", () => {
	const thrown = pure({ resolveTier: (a, t) => { if (a.name === "debugger" && t === "capable") throw new Error("SECRET-RAW-ERROR"); return exact(a, t); } });
	assert.deepEqual([...new Set(thrown.problems.map((p) => [p.kind, p.role, p.tier].join()))], ["tier_unresolved,debugger,capable"]);
	assert.ok(!JSON.stringify(thrown).includes("SECRET-RAW-ERROR"), "raw error text is never recorded");
	const wrongModel = pure({ resolveTier: (a, t) => ({ ...exact(a, t), model: "other/model" }) });
	assert.ok(wrongModel.problems.length > 0 && wrongModel.problems.every((p) => p.kind === "tier_unresolved"));
	const wrongThinking = pure({ resolveTier: (a, t) => ({ ...exact(a, t), thinking: "off" }) });
	assert.equal(wrongThinking.ok, false);
});

test("pure helper: package agents outside the candidate's agent/agents, missing agents, and discovery errors are blocked", () => {
	assert.deepEqual(kinds(pure({ discover: () => ({ agents: pureAgents({ filePath: "C:/elsewhere/x.md" }), projectAgentsDir: null }) })), ["agent_source_shadowed"]);
	assert.deepEqual(kinds(pure({ discover: () => ({ agents: pureAgents().slice(1), projectAgentsDir: null }) })), ["agent_missing"]);
	assert.deepEqual(kinds(pure({ discover: () => ({ agents: [], projectAgentsDir: null, error: "SECRET-PATH-ERROR" }) })), ["discovery_error"]);
	assert.deepEqual(kinds(pure({ discover: () => { throw new Error("boom"); } })), ["discovery_error"]);
});

test("pure helper: only environment override PRESENCE is recorded, never its value; the fingerprint ignores cwd and agent directory spelling", () => {
	const a = pure({ env: { PI_CODING_AGENT_DIR: "C:/secret-looking/dir" }, agentDir: "C:/one", cwd: "C:/one-cwd" });
	assert.deepEqual(a.envOverride, { present: true, names: ["PI_CODING_AGENT_DIR"] });
	assert.ok(!JSON.stringify(a).includes("secret-looking"));
	const b = pure({ env: {}, agentDir: "D:/two", cwd: "D:/two-cwd" });
	assert.deepEqual(b.envOverride, { present: false, names: [] });
	assert.equal(a.fingerprint, b.fingerprint, "path spellings are not proof identity");
	assert.notEqual(pure({ discover: () => ({ agents: pureAgents().slice(1), projectAgentsDir: null }) }).fingerprint, a.fingerprint);
});

test("the SDK root must be explicit and real: a missing root fails LOUDLY (no assumed skip, no mock-only pass)", async () => {
	const base = mkTmp("noroot"); const fx = packageFixture(base);
	await assert.rejects(createPiSdkAdapter({}).agentTopology({ runtime: fx.runtime, cwd: base }), /piPackageRoot/);
	await assert.rejects(createPiSdkAdapter({ piPackageRoot: path.join(base, "no-such-sdk") }).agentTopology({ runtime: fx.runtime, cwd: base }), /dist.index\.js/);
	await assert.rejects(createPiSdkAdapter({ loadPi: async () => ({ getAgentDir: () => "x" }) }).agentTopology({ runtime: fx.runtime, cwd: base }), /piPackageRoot/, "a fake loader alone never supplies a real proof");
});

test("the check does not move the ambient agent directory or touch the environment", async () => {
	const base = mkTmp("env"); const fx = packageFixture(base);
	const before = JSON.stringify(Object.entries(process.env).sort());
	await topo(fx, { agentDir: path.join(base, "absent") });
	assert.equal(JSON.stringify(Object.entries(process.env).sort()), before);
});
