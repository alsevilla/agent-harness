// Wiring of the agent topology guard: runBenchmark (library callers cannot bypass it), the SDK adapter's main open at the REPLAY cwd, compare, and the CLI.
// Offline: fake adapters and spies only; the real-SDK CLI cases use the installed SDK's pure discovery and stop before any workspace, session or provider.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { main, checkTopology } from "./cli.mjs";
import { compareResults } from "./lib/compare.mjs";
import { runBenchmark } from "./lib/runner.mjs";
import { createPiSdkAdapter } from "./lib/sdk-adapter.mjs";
import { TOPOLOGY_METHOD } from "./lib/topology.mjs";
import { fixtureLimits, fixtureConfig, fixMain, fakeAdapter, fakeWorkspace, gate, manifest, root, task } from "./fixtures/fake-runtime.mjs";
import { PI_ROOT, fixtureTopology, mkTmp, packageFixture, copyDir, write, withAgentDir } from "./fixtures/topology-fixture.mjs";

const quiet = async (fn) => { const log = console.log; console.log = () => {}; try { return await fn(); } finally { console.log = log; } };
// A workspace and adapter that record every touch: a blocked topology must leave both untouched.
function spies(over = {}) {
	const touched = [];
	const ws = fakeWorkspace(root()); const prepare = ws.prepare;
	const workspace = { ...ws, async prepare(...a) { touched.push("prepare"); return prepare.apply(this, a); } };
	const adapter = fakeAdapter({ mainScript: fixMain, synthetic: false, ...over });
	return { touched, workspace, adapter };
}
const go = ({ workspace, adapter }, config) => runBenchmark({ manifest: manifest([task("H1")]), mode: "fresh", adapter, workspace, acceptance: gate, config });
const bad = (over = {}) => fixtureTopology({ ok: false, problems: [{ kind: "agent_source_shadowed", scope: "user", role: "general-worker", source: "user", file: "C:/p/general-worker.md" }], ...over });

test("a measured run without a topology proof is methodinvalid BEFORE any workspace prepare, session, provider or prompt", async () => {
	for (const topology of [undefined, null, {}, { ...fixtureTopology(), method: "other/1" }]) {
		const s = spies();
		const r = await go(s, fixtureConfig({ topology }));
		assert.equal(r.status, "invalid");
		assert.deepEqual(r.invalid, { task: null, class: "methodinvalid", kind: "agent_topology_missing" });
		assert.deepEqual(s.touched, []);
		assert.deepEqual(s.adapter.log, [], "no session of any role was opened");
		assert.deepEqual(r.tasks, []);
		assert.deepEqual(r.notRun, ["H1"]);
	}
});

test("a blocked topology stops a measured run as infrastructure before any task, recording the structured problems and no shutdown claim", async () => {
	const s = spies();
	const r = await go(s, fixtureConfig({ topology: bad() }));
	assert.equal(r.status, "invalid");
	assert.deepEqual(r.invalid, { task: null, class: "infrastructure", kind: "agent_topology_blocked" });
	assert.match(r.error, /agent_source_shadowed:user:general-worker/);
	assert.deepEqual(s.touched, []);
	assert.deepEqual(s.adapter.log, []);
	assert.equal(r.config.topology.ok, false);
	assert.deepEqual(r.config.topology.problems[0].kind, "agent_source_shadowed");
	assert.ok(!r.tasks.length && r.tasks.every((t) => !t.shutdown));
});

test("a passing proof is recorded in the result config and the run proceeds; a synthetic run records none and is not blocked", async () => {
	const ok = spies();
	const r = await go(ok, fixtureConfig());
	assert.equal(r.status, "complete");
	assert.equal(r.config.topology.method, TOPOLOGY_METHOD);
	const syn = spies({ synthetic: true });
	const rs = await go(syn, fixtureConfig({ topology: undefined }));
	assert.equal(rs.status, "complete");
	assert.equal(rs.config.topology, null);
});

test("compare: a missing proof (an older run) or another proof method is INCONCLUSIVE; per-run cwd, ids and the fingerprint are not compared", async () => {
	const run = async (topology) => go(spies(), fixtureConfig({ topology, maxReworkRounds: { value: 0, source: "fixture" } }));
	const a = await run(fixtureTopology()); const b = await run(fixtureTopology({ cwd: "elsewhere", fingerprint: "another", effectiveAgentDir: "other-dir" }));
	const same = compareResults(a, b);
	assert.ok(!same.inconclusive.some((x) => /topology/.test(x)), same.inconclusive.join("; "));
	const old = JSON.parse(JSON.stringify(a)); delete old.config.topology;
	assert.ok(compareResults(old, b).inconclusive.some((x) => /baseline lacks a passing agent topology proof/.test(x)));
	const other = JSON.parse(JSON.stringify(b)); other.config.topology.method = "agent-topology/0";
	const diff = compareResults(a, other);
	assert.equal(diff.verdict, "INCONCLUSIVE");
	assert.ok(diff.inconclusive.some((x) => /candidate lacks a passing agent topology proof/.test(x)));
});

// SDK adapter: the proof is taken for the REPLAY cwd before any ModelRuntime, loader, factory or prompt exists.
function spySdk(log) {
	return { getAgentDir: () => "fixture-agent-dir", ModelRuntime: { create: async () => { log.push("ModelRuntime.create"); throw new Error("stop"); } }, DefaultResourceLoader: class { constructor() { log.push("loader"); } }, createAgentSession: async () => { log.push("createAgentSession"); }, SessionManager: {}, SettingsManager: { inMemory: () => ({}) } };
}
const RUNTIME = { root: "C:/candidate-fixture", extensions: ["./agent/extensions/subagent/index.ts"], fingerprint: "fixture" };
const open = (ad, cwd, role = "main") => ad.openSession({ cwd, role, compactionEnabled: false, taskId: "H1", runtime: RUNTIME, roleSpec: { model: "a/b", fallbacks: [], thinking: "high" }, limits: fixtureLimits() });

test("openSession proves the topology at the actual replay cwd BEFORE ModelRuntime, loader, factory or prompt; a replay project override blocks with zero factory calls", async () => {
	const log = [];
	const topology = async ({ runtime, cwd }) => { log.push(`topology:${cwd}`); return cwd.includes("project-override") ? bad({ problems: [{ kind: "agent_source_project_override", scope: "both", role: "general-worker", source: "project" }] }) : fixtureTopology(); };
	const ad = createPiSdkAdapter({ loadPi: async () => spySdk(log), piPackageRoot: "/sdk", topology });
	await assert.rejects(open(ad, "C:/replay/project-override/H1"), (e) => e.infrastructure === true && e.kind === "agent_topology" && /agent_source_project_override:both:general-worker/.test(e.message) && e.topology.ok === false);
	assert.deepEqual(log, ["topology:C:/replay/project-override/H1"], "nothing past the proof ran");
	log.length = 0;
	await assert.rejects(open(ad, "C:/replay/clean/H2"), /stop/);
	assert.deepEqual(log, ["topology:C:/replay/clean/H2", "ModelRuntime.create"], "the proof precedes the runtime constructor");
	log.length = 0;
	await assert.rejects(open(ad, "C:/replay/project-override/H1", "review"), /stop/);
	assert.ok(!log.some((l) => l.startsWith("topology")), "the reviewer loads no extension and needs no topology proof");
});

test("a proof that cannot be produced blocks the open (kind agent_topology); the real default has no skip and a fake loader alone never passes", async () => {
	const log = [];
	const throwing = createPiSdkAdapter({ loadPi: async () => spySdk(log), piPackageRoot: "/sdk", topology: async () => { throw new Error("cannot"); } });
	await assert.rejects(open(throwing, "C:/replay/H1"), (e) => e.infrastructure === true && e.kind === "agent_topology");
	const realDefault = createPiSdkAdapter({ loadPi: async () => spySdk(log) });
	await assert.rejects(open(realDefault, "C:/replay/H1"), (e) => e.kind === "agent_topology" && /piPackageRoot/.test(e.message));
	assert.deepEqual(log, [], "no runtime, loader or factory call without a proof");
});

// CLI: the real installed-SDK discovery against a fixture package whose profile holds byte-identical physical copies.
const git = (cwd, ...a) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.invalid", ...a], { cwd, stdio: "ignore" });
function cliFixture(name) {
	const base = mkTmp(name); const fx = packageFixture(base);
	git(fx.root, "init", "-q"); git(fx.root, "add", "."); git(fx.root, "commit", "-q", "-m", "fixture");
	const agentDir = path.join(base, "profile");
	copyDir(fx.agents, path.join(agentDir, "agents"));
	write(path.join(agentDir, "settings.json"), JSON.stringify({ defaultProvider: "anthropic", defaultModel: "claude-sonnet-5-5", defaultThinkingLevel: "high" }));
	return { base, fx, agentDir, scratch: path.join(base, "scratch"), out: path.join(base, "out.json") };
}
const RUN = (c, root, extra = []) => ["run", "--mode", "fresh", "--adapter", "pi-sdk", "--confirm-live", "--pi-package-root", root, "--repo", c.fx.root, "--scratch", c.scratch, "--out", c.out, ...extra];

test("CLI run: a shadowed topology writes a structured blocker result and exits 1 before any scratch, workspace, session or provider", async () => {
	const c = cliFixture("cli-run");
	const code = await withAgentDir(c.agentDir, () => quiet(() => main(RUN(c, PI_ROOT))));
	assert.equal(code, 1);
	const out = JSON.parse(fs.readFileSync(c.out, "utf8"));
	assert.equal(out.status, "blocked");
	assert.equal(out.blocker.kind, "agent_topology");
	assert.ok(out.blocker.problems.length > 0 && out.blocker.problems.every((p) => p.kind === "agent_source_shadowed"));
	assert.equal(out.tasksRun, 0);
	assert.ok(!("shutdown" in out) && !("tasks" in out), "no shutdown claim and no task record");
	assert.equal(fs.existsSync(c.scratch), false, "no scratch work directory was created");
});

test("CLI run: an unprovable topology (no installed SDK at the given root) is a structured blocker too, never an assumed pass", async () => {
	const c = cliFixture("cli-unproven");
	const code = await quiet(() => main(RUN(c, path.join(c.base, "no-sdk"))));
	assert.equal(code, 1);
	assert.deepEqual(JSON.parse(fs.readFileSync(c.out, "utf8")).blocker.problems.map((p) => p.kind), ["topology_unproven"]);
});

test("CLI preflight: a shadowed topology is a blocker with the diagnostic persisted, no session opened and no shutdown claimed", async () => {
	const c = cliFixture("cli-preflight");
	const code = await withAgentDir(c.agentDir, () => quiet(() => main(["preflight", "--confirm-no-prompt-preflight", "--pi-package-root", PI_ROOT, "--repo", c.fx.root, "--scratch", c.scratch, "--out", c.out])));
	assert.equal(code, 1);
	const report = JSON.parse(fs.readFileSync(c.out, "utf8"));
	assert.match(report.blocker, /agent_topology: agent_source_shadowed/);
	assert.equal(report.topology.ok, false);
	assert.equal(report.check, null, "no session was opened, so no shutdown is claimed");
	assert.equal(fs.existsSync(path.join(c.scratch, "preflight-main")), false);
});

// Privacy: a foreign import error body (a native helper or dependency failing at import) never reaches a diagnostic, an error message or the persisted record.
const MARKER = "TEST_ONLY_RAW_NATIVE_IMPORT_ERROR_BODY";
function brokenImportFixture(name) {
	const base = mkTmp(name); const fx = packageFixture(base);
	write(path.join(fx.root, "agent", "extensions", "subagent", "agents.ts"), `export function discoverAgents() { return { agents: [] }; }\nthrow new Error(${JSON.stringify(MARKER)});\n`);
	return { base, fx };
}

test("direct main open with a package whose agents.ts FAILS at import emits only a fixed topology kind/reason, never the foreign error body (real adapter, pure guard, no factory)", async () => {
	const { fx } = brokenImportFixture("open-import");
	const log = [];
	const ad = createPiSdkAdapter({ loadPi: async () => spySdk(log), piPackageRoot: PI_ROOT });
	const open1 = ad.openSession({ cwd: "C:/replay/H1", role: "main", compactionEnabled: false, taskId: "H1", runtime: fx.runtime, roleSpec: { model: "a/b", fallbacks: [], thinking: "high" }, limits: fixtureLimits() });
	await assert.rejects(open1, (e) => {
		assert.equal(e.infrastructure, true); assert.equal(e.kind, "agent_topology");
		assert.match(e.message, /topology_check_failed/);
		assert.equal(JSON.stringify({ m: e.message, s: e.stack?.split("\n")[0], k: e.kind, t: e.topology ?? null, c: e.cause ? "cause" : null }).includes(MARKER), false);
		assert.equal(e.cause, undefined);
		return true;
	});
	assert.deepEqual(log, [], "the pure guard failed before ModelRuntime, loader or session factory");
});

test("a run whose real adapter hits the failed native import persists a record with NO foreign marker", async () => {
	const { fx } = brokenImportFixture("run-import");
	const log = [];
	const adapter = createPiSdkAdapter({ loadPi: async () => spySdk(log), piPackageRoot: PI_ROOT });
	const r = await runBenchmark({ manifest: manifest([task("H1")]), mode: "fresh", adapter, workspace: fakeWorkspace(root()), acceptance: gate, config: fixtureConfig({ runtime: fx.runtime }) });
	assert.equal(JSON.stringify(r).includes(MARKER), false);
	assert.match(JSON.stringify(r), /topology_check_failed/);
	assert.deepEqual(log, []);
});

test("CLI checkTopology keeps only an allowlisted reason code for a failed native import and for an unprovable SDK root, never any foreign text", async () => {
	const { fx } = brokenImportFixture("cli-import");
	const adapter = createPiSdkAdapter({ loadPi: async () => spySdk([]), piPackageRoot: PI_ROOT });
	const t = await checkTopology({ adapter, repo: fx.root, cwd: "C:/replay/H1" });
	assert.equal(t.ok, false);
	assert.deepEqual(t.problems.map((p) => p.kind), ["topology_unproven"]);
	assert.equal(JSON.stringify(t).includes(MARKER), false);
	assert.equal(t.problems[0].reason, "native_import_failed");
	const none = await checkTopology({ adapter: createPiSdkAdapter({ loadPi: async () => spySdk([]) }), repo: fx.root, cwd: "C:/replay/H1" });
	assert.equal(none.problems[0].reason, "no_sdk_root");
	const forged = await checkTopology({ adapter: { agentTopology: async () => { throw new Error(`the agent topology check ${MARKER}`); } }, repo: fx.root, cwd: "x" });
	assert.deepEqual(forged.problems, [{ kind: "topology_unproven" }], "a foreign message that merely imitates our prefix is not trusted");
});
