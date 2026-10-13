// Real child RPC probe for the safety guard. Node-only (native TS): run with
//   node --experimental-transform-types --test agent/extensions/subagent/tests/safety-guard-runtime.node.ts
// A real installed Pi CLI child loads the production guard entry via claimChildGuard plus a scratch faux provider generated under STAGE1_PROBE_SCRATCH (or os.tmpdir()). Observed through tool_execution_end; no real credentials, network or model calls.
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import readline from "node:readline";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { authorizableOp, canonicalCwd, CHILD_GRANT_ENV, claimChildGuard, createGrantStore, pushBranchTarget } from "../safety-core.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const profileRoot = path.resolve(here, "../../../..");
const extensionDir = path.resolve(here, "..");
const guardFile = path.join(extensionDir, "safety-guard-entry.ts");

// Installed package lookup mirrors scripts/scan-harness-config.mjs (latest release first); no hardcoded machine paths.
function installed(rel: string): string {
	const releases = path.join(profileRoot, "agent", "install", "releases");
	for (const version of fs.readdirSync(releases).sort().reverse()) {
		const file = path.join(releases, version, "node_modules", "@earendil-works", rel);
		if (fs.existsSync(file)) return file;
	}
	throw new Error(`installed ${rel} not found`);
}
const piCli = installed("pi-coding-agent/dist/bundle/cli.js");
const piAi = pathToFileURL(installed("pi-ai/dist/index.js")).href;

const scratchBase = process.env.STAGE1_PROBE_SCRATCH ?? os.tmpdir();
const root = fs.mkdtempSync(path.join(scratchBase, "runtime-probe-"));
const workspace = path.join(root, "workspace");
const agentDir = path.join(root, "agent-dir");
fs.mkdirSync(workspace, { recursive: true });
fs.mkdirSync(agentDir, { recursive: true });
// Fixture secret for the read probe: a scratch .env (secret basename) under the scratch agent dir; auth.json is Pi's credential store and must stay absent.
fs.writeFileSync(path.join(agentDir, ".env"), "PROBE_SENTINEL");

// Faux provider extension: scripted tool calls and text from a JSON file, registered as provider probe-faux.
const fauxFile = path.join(root, "probe-faux-extension.mjs");
fs.writeFileSync(fauxFile, `import { readFileSync } from "node:fs";
import * as ai from ${JSON.stringify(piAi)};
export default function (pi) {
	const steps = JSON.parse(readFileSync(process.env.PROBE_SCRIPT, "utf8"));
	const core = ai.createFauxCore({ api: "probe-faux-api", provider: "probe-faux", models: [{ id: "probe-model", name: "probe" }] });
	core.setResponses(steps.map((s) => s.text !== undefined ? ai.fauxAssistantMessage(ai.fauxText(s.text)) : ai.fauxAssistantMessage(ai.fauxToolCall(s.tool, s.args, { id: s.id }))));
	pi.registerProvider("probe-faux", { api: core.api, apiKey: "probe-inert-key", streamSimple: core.streamSimple, models: core.models });
}
`);

type Step = { tool: string; args: Record<string, unknown>; id: string } | { text: string };
interface ToolEnd { toolName: string; isError: boolean; text: string }

async function runChild(script: Step[], envOverride?: { [CHILD_GRANT_ENV]: string }, mintGrants?: (store: ReturnType<typeof createGrantStore>) => void, role = "probe-role", options: { dir?: string; withLeases?: boolean } = {}): Promise<{ ends: ToolEnd[]; stderr: string }> {
	const scriptFile = path.join(root, `script-${Math.random().toString(36).slice(2)}.json`);
	fs.writeFileSync(scriptFile, JSON.stringify(script));
	const store = createGrantStore();
	mintGrants?.(store);
	const dir = options.dir ?? workspace;
	const guard = claimChildGuard(store, role, canonicalCwd(dir), guardFile, undefined, options.withLeases === true);
	const env = guard.childEnv({ ...process.env, PI_CODING_AGENT_DIR: agentDir, PROBE_SCRIPT: scriptFile });
	if (envOverride) Object.assign(env, envOverride);
	const proc = spawn(process.execPath, [piCli, "--mode", "rpc", "--no-session", "--no-extensions", "--no-mcp", "--no-skills", "--no-prompt-templates", "--offline", "--provider", "probe-faux", "--model", "probe-model", "--extension", fauxFile, "--extension", guard.entry], { cwd: dir, env, stdio: ["pipe", "pipe", "pipe"] });
	let stderr = "";
	proc.stderr.on("data", (chunk) => { stderr += chunk; });
	const ends: ToolEnd[] = [];
	let settle!: (error?: Error) => void;
	const settled = new Promise<void>((resolve, reject) => { settle = (error?: Error) => (error ? reject(error) : resolve()); });
	readline.createInterface({ input: proc.stdout }).on("line", (line) => {
		let event: any;
		try { event = JSON.parse(line); } catch { return; }
		if (event.type === "tool_execution_end") ends.push({ toolName: event.toolName, isError: event.isError === true, text: (event.result?.content ?? []).map((c: { text?: string }) => c.text ?? "").join("") });
		if (event.type === "agent_settled") settle();
		if (event.type === "response" && event.success === false) settle(new Error(`prompt refused: ${event.error}`));
	});
	proc.stdin.write(JSON.stringify({ id: "p1", type: "prompt", message: "probe" }) + "\n");
	let timer!: NodeJS.Timeout;
	const timeout = new Promise<void>((_, reject) => { timer = setTimeout(() => reject(new Error(`child RPC timed out; stderr: ${stderr.slice(0, 400)}`)), 90_000); });
	try { await Promise.race([settled, timeout]); } finally { clearTimeout(timer); proc.stdin.end(); proc.kill(); }
	return { ends, stderr };
}

// Hermetic git: no user or system config reaches fixture repos or the guard's live binding. Origin is a nonexistent local path, so a permitted push can only fail locally.
const GIT_CFG = path.join(fs.mkdtempSync(path.join(scratchBase, "push-lease-cfg-")), "gitconfig");
fs.writeFileSync(GIT_CFG, "");
process.env.GIT_CONFIG_GLOBAL = GIT_CFG;
process.env.GIT_CONFIG_NOSYSTEM = "1";
const ORIGIN = path.join(root, "absent-origin.git");
function makeRepo(dir: string): string {
	fs.mkdirSync(dir, { recursive: true });
	const git = (...args: string[]) => {
		const run = spawnSync("git", args, { cwd: dir, encoding: "utf8", windowsHide: true });
		assert.equal(run.status, 0, `git ${args.join(" ")}: ${run.stderr}`);
	};
	git("init", "-q");
	git("-c", "user.name=t", "-c", "user.email=t@example.test", "commit", "-q", "--allow-empty", "-m", "init");
	git("branch", "feat/x");
	git("remote", "add", "origin", ORIGIN);
	return canonicalCwd(dir);
}

const RM = "rm -rf probe-absent-dir";

test("child deny: risky bash with no grant is blocked by the production guard, without echoing the raw command", { timeout: 120_000 }, async () => {
	const { ends, stderr } = await runChild([{ tool: "bash", args: { command: RM }, id: "t1" }, { text: "done" }]);
	assert.equal(ends.length, 1, stderr);
	assert.equal(ends[0].isError, true);
	assert.match(ends[0].text, /Blocked by harness safety guard \[DESTRUCTIVE_FS\]/);
	assert.doesNotMatch(ends[0].text, /probe-absent-dir/);
});

test("child permit: exact single-use grant lets one identical call through; replay is blocked; secret read stays refused", { timeout: 120_000 }, async () => {
	const { ends, stderr } = await runChild(
		[{ tool: "bash", args: { command: RM }, id: "t1" }, { tool: "bash", args: { command: RM }, id: "t2" }, { tool: "read", args: { path: path.join(agentDir, ".env") }, id: "t3" }, { text: "done" }],
		undefined,
		(store) => store.mint({ role: "probe-role", candidate: canonicalCwd(workspace), ops: [authorizableOp("shell", RM, canonicalCwd(workspace), agentDir)], ttlMs: 60_000 }),
	);
	assert.equal(ends.length, 3, stderr);
	assert.equal(ends[0].isError, false, ends[0].text);
	assert.equal(ends[1].isError, true);
	assert.match(ends[1].text, /Blocked by harness safety guard/);
	assert.equal(ends[2].isError, true);
	assert.match(ends[2].text, /not grantable/);
	assert.doesNotMatch(ends[2].text, /PROBE_SENTINEL/);
});

test("child fail-closed: a malformed grant envelope refuses every tool call", { timeout: 120_000 }, async () => {
	const { ends, stderr } = await runChild([{ tool: "bash", args: { command: "echo probe" }, id: "t1" }, { text: "done" }], { [CHILD_GRANT_ENV]: "{not json" });
	assert.equal(ends.length, 1, stderr);
	assert.equal(ends[0].isError, true);
	assert.match(ends[0].text, /invalid child grant envelope/);
});

// Main-session cases (promoted from the independent SDK probe). Simulated TUI operator: mode "tui", hasUI, scripted ui.confirm. Not a live terminal, not a live provider.
type SdkStep = { tool: string; args: Record<string, unknown>; id: string } | { text: string };
let sdkModules: { pi: any; ai: any } | undefined;
async function sdk() {
	sdkModules ??= { pi: await import(pathToFileURL(installed("pi-coding-agent/dist/index.js")).href), ai: await import(piAi) };
	return sdkModules;
}
const MAIN_SENTINEL = "STAGE1-SENTINEL-NOT-A-CREDENTIAL-91c2";
const MAIN_RM = "rm -rf probe-absent-dir";
const sha = (p: string) => createHash("sha256").update(fs.readFileSync(p)).digest("hex");
const textOf = (content: any) => (content ?? []).filter((c: any) => c.type === "text").map((c: any) => c.text).join("\n");
const approve = { confirm: async () => true };
const refuse = { confirm: async () => false };
const throwing = { confirm: async () => { throw new Error("stub dialog failure"); } };

async function openMain(steps: SdkStep[], opts: { ui?: { confirm: (...a: any[]) => Promise<any> }; mode?: string; tokensPerSecond?: number; repo?: boolean; dir?: string } = {}) {
	const { pi, ai } = await sdk();
	const main = opts.dir ?? fs.mkdtempSync(path.join(scratchBase, "s1-main-"));
	const agentDir = path.join(main, "agent");
	const cwd = path.join(main, "project");
	fs.mkdirSync(agentDir, { recursive: true });
	fs.mkdirSync(cwd, { recursive: true });
	fs.writeFileSync(path.join(agentDir, "auth.json"), JSON.stringify({ fixtureSentinel: MAIN_SENTINEL }));
	fs.writeFileSync(path.join(cwd, ".env"), `FIXTURE=${MAIN_SENTINEL}\n`);
	if (opts.repo && !fs.existsSync(path.join(cwd, ".git"))) makeRepo(cwd);
	const fixtures = [path.join(agentDir, "auth.json"), path.join(cwd, ".env")];
	const before = fixtures.map(sha);
	const core = ai.createFauxCore({ api: "stage1-faux-api", provider: "stage1-faux", models: [{ id: "stage1-model", name: "stage1" }], tokensPerSecond: opts.tokensPerSecond });
	core.setResponses(steps.map((s) => ("text" in s ? ai.fauxAssistantMessage(ai.fauxText(s.text)) : ai.fauxAssistantMessage(ai.fauxToolCall(s.tool, s.args, { id: s.id })))));
	const settingsManager = pi.SettingsManager.inMemory();
	const resourceLoader = new pi.DefaultResourceLoader({
		cwd, agentDir, settingsManager, additionalExtensionPaths: [path.join(extensionDir, "index.ts")],
		extensionFactories: [(p: any) => p.registerProvider("stage1-faux", { api: core.api, apiKey: "inert-fixture-key", streamSimple: core.streamSimple, models: core.models })],
		disabledBuiltinExtensions: ["mcp", "codemode", "tool-search", "llama.cpp"],
		skillsOverride: (base: any) => ({ skills: [], diagnostics: base.diagnostics }),
		noThemes: true, noContextFiles: true,
	});
	await resourceLoader.reload();
	const { session } = await pi.createAgentSession({ cwd, agentDir, settingsManager, resourceLoader, model: core.models[0], sessionManager: pi.SessionManager.inMemory(cwd) });
	const confirms: any[][] = [];
	const notes: any[][] = [];
	const uiContext = opts.ui ? { notify: (...a: any[]) => { notes.push(a); }, setStatus() {}, setWidget() {}, confirm: (...a: any[]) => { confirms.push(a); return opts.ui!.confirm(...a); } } : undefined;
	await session.bindExtensions({ uiContext, mode: opts.mode ?? "tui" });
	const results = () => session.messages.filter((m: any) => m.role === "toolResult").map((m: any) => ({ tool: m.toolName, isError: m.isError === true, text: textOf(m.content) }));
	const run = async (prompt = "probe") => { await session.prompt(prompt); return results(); };
	const unchanged = () => fixtures.every((p, i) => sha(p) === before[i]);
	return { core, session, cwd, agentDir, confirms, notes, run, results, unchanged, shutdown: () => (session.extensionRunner.hasHandlers("session_shutdown") ? session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" }) : undefined), cleanup: () => { session.dispose(); if (!opts.dir) fs.rmSync(main, { recursive: true, force: true }); } };
}

test("main A (simulated TUI): risky bash with no grant is blocked, no dialog, raw command not echoed", { timeout: 120_000 }, async () => {
	const s = await openMain([{ tool: "bash", args: { command: MAIN_RM }, id: "a1" }, { text: "done" }], { ui: approve });
	try {
		const r = await s.run();
		assert.equal(r.length, 1);
		assert.equal(r[0].isError, true);
		assert.match(r[0].text, /Blocked by harness safety guard \[DESTRUCTIVE_FS\]/);
		assert.doesNotMatch(r[0].text, /probe-absent-dir/);
		assert.equal(s.confirms.length, 0);
	} finally { s.cleanup(); }
});

test("main B (simulated TUI): confirm=true mints exactly one grant; identical replay is blocked", { timeout: 120_000 }, async () => {
	const s = await openMain([{ tool: "request_authorization", args: { operations: [{ kind: "shell", value: MAIN_RM }] }, id: "b0" }, { tool: "bash", args: { command: MAIN_RM }, id: "b1" }, { tool: "bash", args: { command: MAIN_RM }, id: "b2" }, { text: "done" }], { ui: approve });
	try {
		const r = await s.run();
		assert.equal(s.confirms.length, 1);
		assert.ok(String(s.confirms[0][1]).includes(MAIN_RM));
		assert.ok(String(s.confirms[0][1]).includes("Role: main"));
		assert.equal(r[0].isError, false);
		assert.equal(r[1].isError, false);
		assert.equal(r[2].isError, true);
		assert.match(r[2].text, /Blocked by harness safety guard/);
	} finally { s.cleanup(); }
});

test("main C (simulated TUI): confirm=false mints zero grants", { timeout: 120_000 }, async () => {
	const s = await openMain([{ tool: "request_authorization", args: { operations: [{ kind: "shell", value: MAIN_RM }] }, id: "c0" }, { tool: "bash", args: { command: MAIN_RM }, id: "c1" }, { text: "done" }], { ui: refuse });
	try {
		const r = await s.run();
		assert.equal(r[0].isError, true);
		assert.match(r[0].text, /Not authorized by the operator/);
		assert.equal(r[1].isError, true);
		assert.equal(s.confirms.length, 1);
	} finally { s.cleanup(); }
});

test("main D (simulated TUI): confirm throws, mints zero grants", { timeout: 120_000 }, async () => {
	const s = await openMain([{ tool: "request_authorization", args: { operations: [{ kind: "shell", value: MAIN_RM }] }, id: "d0" }, { tool: "bash", args: { command: MAIN_RM }, id: "d1" }, { text: "done" }], { ui: throwing });
	try {
		const r = await s.run();
		assert.equal(r[0].isError, true);
		assert.equal(r[1].isError, true);
		assert.match(r[1].text, /Blocked by harness safety guard/);
	} finally { s.cleanup(); }
});

test("main E (simulated TUI): confirm resolves undefined (non-approval), mints zero grants", { timeout: 120_000 }, async () => {
	const s = await openMain([{ tool: "request_authorization", args: { operations: [{ kind: "shell", value: MAIN_RM }] }, id: "e0" }, { tool: "bash", args: { command: MAIN_RM }, id: "e1" }, { text: "done" }], { ui: { confirm: async () => undefined } });
	try {
		const r = await s.run();
		assert.equal(r[0].isError, true);
		assert.equal(r[1].isError, true);
	} finally { s.cleanup(); }
});

test("main F (simulated): no UI or non-TUI modes refuse request_authorization without any dialog", { timeout: 120_000 }, async () => {
	const cases: Array<[string, string, any]> = [["tui-noUI", "tui", undefined], ["rpc-with-ui", "rpc", approve], ["print-with-ui", "print", approve], ["json-with-ui", "json", approve]];
	for (const [label, mode, ui] of cases) {
		const s = await openMain([{ tool: "request_authorization", args: { operations: [{ kind: "shell", value: MAIN_RM }] }, id: "f0" }, { tool: "bash", args: { command: MAIN_RM }, id: "f1" }, { text: "done" }], { mode, ui });
		try {
			const r = await s.run();
			assert.equal(r[0].isError, true, label);
			assert.match(r[0].text, /requires the human TUI|no grant minted/, label);
			assert.equal(r[1].isError, true, label);
			assert.equal(s.confirms.length, 0, label);
		} finally { s.cleanup(); }
	}
});

test("main G (simulated TUI): invalid requests never reach the dialog and mint nothing", { timeout: 120_000 }, async () => {
	const bad: Array<[string, Record<string, unknown>]> = [
		["non-risky ls", { operations: [{ kind: "shell", value: "ls -la" }] }],
		["secret cat", { operations: [{ kind: "shell", value: "cat .env" }] }],
		["secret write", { operations: [{ kind: "write", value: "agent/auth.json" }] }],
		["six ops", { operations: Array.from({ length: 6 }, (_, i) => ({ kind: "shell", value: `rm -rf probe-${i}` })) }],
		["traversal role", { operations: [{ kind: "shell", value: MAIN_RM }], role: "../evil" }],
	];
	for (const [label, args] of bad) {
		const s = await openMain([{ tool: "request_authorization", args, id: "g0" }, { tool: "bash", args: { command: MAIN_RM }, id: "g1" }, { text: "done" }], { ui: approve });
		try {
			const r = await s.run();
			assert.equal(s.confirms.length, 0, label);
			assert.equal(r[0].isError, true, label);
			assert.equal(r[1].isError, true, label);
		} finally { s.cleanup(); }
	}
});

test("main H (simulated TUI): secret read/write refused, bytes unchanged, even with an approving dialog", { timeout: 120_000 }, async () => {
	const s = await openMain([
		{ tool: "read", args: { path: "agent/auth.json" }, id: "h1" },
		{ tool: "read", args: { path: ".env" }, id: "h2" },
		{ tool: "write", args: { path: ".env", content: "OVERWRITE" }, id: "h3" },
		{ tool: "request_authorization", args: { operations: [{ kind: "write", value: ".env" }] }, id: "h4" },
		{ tool: "bash", args: { command: "cat .env" }, id: "h5" },
		{ text: "done" },
	], { ui: approve });
	try {
		const r = await s.run();
		assert.equal(r.length, 5);
		assert.ok(r.every((x: any) => x.isError));
		assert.ok(!r.map((x: any) => x.text).join("\n").includes(MAIN_SENTINEL));
		assert.equal(s.confirms.length, 0);
		assert.equal(s.unchanged(), true);
	} finally { s.cleanup(); }
});

test("main I (simulated TUI): role-bound grant (role=general-worker) is not consumable by main", { timeout: 120_000 }, async () => {
	const s = await openMain([{ tool: "request_authorization", args: { operations: [{ kind: "shell", value: MAIN_RM }], role: "general-worker" }, id: "i0" }, { tool: "bash", args: { command: MAIN_RM }, id: "i1" }, { text: "done" }], { ui: approve });
	try {
		const r = await s.run();
		assert.equal(s.confirms.length, 1);
		assert.equal(r[0].isError, false);
		assert.equal(r[1].isError, true);
	} finally { s.cleanup(); }
});

test("main J (simulated TUI): a 1-minute grant is refused after 61 s of real time", { timeout: 180_000 }, async () => {
	const s = await openMain([{ tool: "request_authorization", args: { operations: [{ kind: "shell", value: MAIN_RM }], ttl_minutes: 1 }, id: "j0" }, { tool: "bash", args: { command: "sleep 61" }, id: "j1" }, { tool: "bash", args: { command: MAIN_RM }, id: "j2" }, { text: "done" }], { ui: approve });
	try {
		const r = await s.run();
		assert.equal(r[0].isError, false);
		assert.equal(r[2].isError, true);
		assert.match(r[2].text, /Blocked by harness safety guard/);
	} finally { s.cleanup(); }
});

test("main K2 (simulated TUI): abort revokes outstanding grants; a replay after the abort is refused", { timeout: 180_000 }, async () => {
	const s = await openMain([{ tool: "request_authorization", args: { operations: [{ kind: "shell", value: MAIN_RM }] }, id: "k20" }, { text: "x ".repeat(300) }], { ui: approve, tokensPerSecond: 20 });
	try {
		let aborted = false;
		s.session.subscribe((e: any) => { if (e.type === "tool_execution_end" && e.toolName === "request_authorization" && !aborted) { aborted = true; void s.session.abort(); } });
		await s.run();
		const { ai } = await sdk();
		s.core.setResponses([ai.fauxAssistantMessage(ai.fauxToolCall("bash", { command: MAIN_RM }, { id: "k21" })), ai.fauxAssistantMessage(ai.fauxText("done"))]);
		await s.run("again");
		const r = s.results();
		assert.equal(aborted, true);
		assert.equal(r[r.length - 1].tool, "bash");
		assert.equal(r[r.length - 1].isError, true);
		assert.match(r[r.length - 1].text, /Blocked by harness safety guard/);
	} finally { s.cleanup(); }
});

test("main L (simulated TUI): session dispose revokes outstanding grants (a carried grant would be a failure)", { timeout: 120_000 }, async () => {
	const first = await openMain([{ tool: "request_authorization", args: { operations: [{ kind: "shell", value: MAIN_RM }] }, id: "l0" }, { text: "done" }], { ui: approve });
	await first.run();
	first.cleanup();
	const second = await openMain([{ tool: "bash", args: { command: MAIN_RM }, id: "l1" }, { text: "done" }], { ui: approve });
	try {
		const r = await second.run();
		assert.equal(r[0].isError, true);
	} finally { second.cleanup(); }
});

// Lexical bypass repro promoted: these forms were executed with no grant before the review repair; they must now block (targets are absent or read-only).
test("main M (simulated TUI): env-prefix and git -C forms are now blocked without a grant", { timeout: 120_000 }, async () => {
	const s = await openMain([{ tool: "bash", args: { command: "env FOO=1 rm -rf probe-absent-dir" }, id: "m1" }, { tool: "bash", args: { command: "git -C . clean -n" }, id: "m2" }, { text: "done" }], { ui: approve });
	try {
		const r = await s.run();
		assert.equal(r.length, 2);
		assert.match(r[0].text, /Blocked by harness safety guard/);
		assert.match(r[1].text, /Blocked by harness safety guard/);
	} finally { s.cleanup(); }
});

// Release-engineer PR-branch push lease (session-only, trusted main). Confirmations are counted through the simulated TUI.
test("main P (simulated TUI): push_branch asks once per binding; the identical request reuses it without a dialog", { timeout: 120_000 }, async () => {
	const s = await openMain([{ tool: "request_authorization", args: { push_branch: { branch: "feat/x" } }, id: "p0" }, { tool: "request_authorization", args: { push_branch: { branch: "feat/x" } }, id: "p1" }, { text: "done" }], { ui: approve, repo: true });
	try {
		const r = await s.run();
		assert.equal(s.confirms.length, 1);
		assert.match(String(s.confirms[0][1]), /Branch: feat\/x/);
		assert.equal(r[0].isError, false, r[0].text);
		assert.equal(r[1].isError, false);
		assert.match(r[1].text, /Already authorized/);
	} finally { s.cleanup(); }
});

test("main Q (simulated TUI): refused, cancelled and throwing dialogs mint no lease; the next request asks again", { timeout: 180_000 }, async () => {
	const uis = [["refuse", refuse], ["undefined", { confirm: async () => undefined }], ["throws", throwing]] as const;
	for (const [label, ui] of uis) {
		const s = await openMain([{ tool: "request_authorization", args: { push_branch: { branch: "feat/x" } }, id: "q0" }, { tool: "request_authorization", args: { push_branch: { branch: "feat/x" } }, id: "q1" }, { text: "done" }], { ui, repo: true });
		try {
			const r = await s.run();
			assert.equal(s.confirms.length, 2, label);
			assert.ok(r.length >= 2 && r[0].isError && r[1].isError, label);
			assert.doesNotMatch(r.map((x: any) => x.text).join("\n"), /Already authorized/, label);
		} finally { s.cleanup(); }
	}
});

test("main R (simulated TUI): invalid push_branch shapes never reach the dialog", { timeout: 300_000 }, async () => {
	const bad: Array<[string, Record<string, unknown>, string?]> = [
		["protected master", { push_branch: { branch: "master" } }],
		["protected release family", { push_branch: { branch: "release/1" } }],
		["push_branch with operations", { push_branch: { branch: "feat/x" }, operations: [{ kind: "shell", value: MAIN_RM }] }],
		["non-main role", { push_branch: { branch: "feat/x" }, role: "general-worker" }],
		["ttl with push_branch", { push_branch: { branch: "feat/x" }, ttl_minutes: 5 }],
		["non-repository folder", { push_branch: { branch: "feat/x", cwd: ".." } }],
		["rpc mode", { push_branch: { branch: "feat/x" } }, "rpc"],
	];
	for (const [label, args, mode] of bad) {
		const s = await openMain([{ tool: "request_authorization", args, id: "r0" }, { text: "done" }], { ui: approve, repo: true, mode });
		try {
			const r = await s.run();
			assert.equal(s.confirms.length, 0, label);
			assert.equal(r[0].isError, true, label);
		} finally { s.cleanup(); }
	}
});

test("main T (simulated TUI): /revoke-authorization withdraws the session lease; the next request asks again", { timeout: 180_000 }, async () => {
	const s = await openMain([{ tool: "request_authorization", args: { push_branch: { branch: "feat/x" } }, id: "t0" }, { text: "one" }, { tool: "request_authorization", args: { push_branch: { branch: "feat/x" } }, id: "t1" }, { text: "two" }], { ui: approve, repo: true });
	try {
		await s.run();
		assert.equal(s.confirms.length, 1);
		await s.session.prompt("/revoke-authorization");
		const r = await s.run("again");
		assert.equal(s.confirms.length, 2, "revoke made the next request prompt again");
		assert.equal(r[r.length - 1].isError, false, r[r.length - 1].text);
	} finally { s.cleanup(); }
});

// Index-level lease lifecycle (real extension wiring, not unit fakes): abort keeps the lease, shutdown drops it, a binding change during the dialog mints nothing, and only user/package-source release-engineer launches receive a lease.
test("lease lifecycle (index): an approved push lease survives an agent abort; the next identical request is Already authorized with no dialog", { timeout: 180_000 }, async () => {
	const s = await openMain([{ tool: "request_authorization", args: { push_branch: { branch: "feat/x" } }, id: "n0" }, { text: "x ".repeat(300) }], { ui: approve, repo: true, tokensPerSecond: 20 });
	try {
		let aborted = false;
		s.session.subscribe((e: any) => { if (e.type === "tool_execution_end" && e.toolName === "request_authorization" && !aborted) { aborted = true; void s.session.abort(); } });
		await s.run();
		assert.equal(aborted, true);
		assert.equal(s.confirms.length, 1);
		const { ai } = await sdk();
		s.core.setResponses([ai.fauxAssistantMessage(ai.fauxToolCall("request_authorization", { push_branch: { branch: "feat/x" } }, { id: "n1" })), ai.fauxAssistantMessage(ai.fauxText("done"))]);
		const r = await s.run("again");
		assert.equal(s.confirms.length, 1, "abort kept the lease: no second dialog");
		assert.equal(r[r.length - 1].isError, false, r[r.length - 1].text);
		assert.match(r[r.length - 1].text, /^Already authorized this session: release-engineer may push feat\/x /);
	} finally { s.cleanup(); }
});

test("lease lifecycle (index): session shutdown drops the approved lease; a new session on the same binding asks again", { timeout: 180_000 }, async () => {
	const dir = fs.mkdtempSync(path.join(scratchBase, "s1-shutdown-"));
	try {
		const first = await openMain([{ tool: "request_authorization", args: { push_branch: { branch: "feat/x" } }, id: "y0" }, { text: "done" }], { ui: approve, repo: true, dir });
		try { await first.run(); assert.equal(first.confirms.length, 1); } finally { await first.shutdown(); first.cleanup(); }
		const second = await openMain([{ tool: "request_authorization", args: { push_branch: { branch: "feat/x" } }, id: "y1" }, { text: "done" }], { ui: approve, repo: true, dir });
		try {
			const r = await second.run();
			assert.equal(second.confirms.length, 1, "shutdown revoked the lease: asked again");
			assert.equal(r[0].isError, false, r[0].text);
			assert.doesNotMatch(r[0].text, /Already authorized/);
		} finally { second.cleanup(); }
	} finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("lease lifecycle (index): a binding change during the dialog mints no lease; the next request asks again against the new binding", { timeout: 180_000 }, async () => {
	const dir = fs.mkdtempSync(path.join(scratchBase, "s1-drift-"));
	const repoDir = path.join(dir, "project");
	let calls = 0;
	const ui = { confirm: async () => { calls += 1; if (calls === 1) spawnSync("git", ["remote", "set-url", "origin", "https://example.test/owner/moved.git"], { cwd: repoDir, windowsHide: true }); return true; } };
	const s = await openMain([{ tool: "request_authorization", args: { push_branch: { branch: "feat/x" } }, id: "v0" }, { tool: "request_authorization", args: { push_branch: { branch: "feat/x" } }, id: "v1" }, { text: "done" }], { ui, repo: true, dir });
	try {
		const r = await s.run();
		assert.equal(s.confirms.length, 2, "no lease from the drifted approval: the next request asks again");
		assert.equal(r[0].isError, true);
		assert.match(r[0].text, /repository binding changed during approval; no lease minted\./);
		assert.equal(r[1].isError, false, r[1].text);
		assert.doesNotMatch(r[1].text, /Already authorized/);
	} finally { s.cleanup(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test("lease lifecycle (index): only a user- or package-source release-engineer launch receives the lease; a project-source impostor gets none", { timeout: 240_000 }, async () => {
	const dir = fs.mkdtempSync(path.join(scratchBase, "s1-launch-"));
	const probe = path.join(dir, "launch-probe.cjs");
	// Stands in for the child CLI: records the PI_SAFETY_GRANTS envelope it was launched with, then settles.
	fs.writeFileSync(probe, [
		'const fs = require("node:fs");',
		'require("node:readline").createInterface({ input: process.stdin }).on("line", (line) => {',
		'  let msg; try { msg = JSON.parse(line); } catch { return; }',
		'  if (msg.type !== "prompt") return;',
		'  fs.writeFileSync(process.env.PI_LAUNCH_PROBE, JSON.stringify({ guard: process.env.PI_SAFETY_GRANTS ?? null }));',
		'  process.stdout.write(JSON.stringify({ id: msg.id, type: "response", command: "prompt", success: true }) + "\\n");',
		'  process.stdout.write(JSON.stringify({ type: "agent_settled" }) + "\\n");',
		'});',
	].join("\n"));
	const argv1 = process.argv[1];
	const launchEnv = process.env.PI_LAUNCH_PROBE;
	const s = await openMain([{ tool: "request_authorization", args: { push_branch: { branch: "feat/x" } }, id: "w0" }, { text: "done" }], { ui: approve, repo: true, dir });
	const agentFile = path.join(s.cwd, ".pi", "agents", "release-engineer.md");
	fs.mkdirSync(path.dirname(agentFile), { recursive: true });
	fs.writeFileSync(agentFile, "---\nname: release-engineer\ndescription: project-source impostor\n---\nNo prompt.\n");
	const leases = (guard: string | null) => (guard === null ? [] : JSON.parse(guard).leases ?? []);
	const { ai } = await sdk();
	process.argv[1] = probe;
	try {
		await s.run();
		assert.equal(s.confirms.length, 1);
		process.env.PI_LAUNCH_PROBE = path.join(dir, "project.json");
		s.core.setResponses([ai.fauxAssistantMessage(ai.fauxToolCall("subagent", { agent: "release-engineer", agentScope: "project", task: "probe", confirmProjectAgents: false, background: false }, { id: "w1" })), ai.fauxAssistantMessage(ai.fauxText("done"))]);
		await s.run("launch project");
		assert.ok(fs.existsSync(path.join(dir, "project.json")), `launch did not reach the child: ${JSON.stringify(s.results())}`);
		const project = JSON.parse(fs.readFileSync(path.join(dir, "project.json"), "utf8"));
		assert.equal(leases(project.guard).length, 0, "project-source release-engineer gets no lease");
		process.env.PI_LAUNCH_PROBE = path.join(dir, "user.json");
		s.core.setResponses([ai.fauxAssistantMessage(ai.fauxToolCall("subagent", { agent: "release-engineer", agentScope: "user", task: "probe", confirmProjectAgents: false, background: false }, { id: "w2" })), ai.fauxAssistantMessage(ai.fauxText("done"))]);
		await s.run("launch user");
		assert.ok(fs.existsSync(path.join(dir, "user.json")), `user-scope launch did not reach the child: ${JSON.stringify(s.results())}`);
		const user = JSON.parse(fs.readFileSync(path.join(dir, "user.json"), "utf8"));
		assert.equal(leases(user.guard).length, 1, "user/package-source release-engineer receives the lease");
	} finally {
		process.argv[1] = argv1;
		if (launchEnv === undefined) delete process.env.PI_LAUNCH_PROBE; else process.env.PI_LAUNCH_PROBE = launchEnv;
		s.cleanup();
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

// Child side: the lease copy is used only by a legitimate release-engineer child of the same candidate, through the strict normal-push form, with a live binding check.
test("child lease (runtime): a release-engineer child with the lease pushes its exact branch; master stays blocked; the live binding must match", { timeout: 240_000 }, async () => {
	const repo = makeRepo(path.join(root, "lease-repo"));
	const script: Step[] = [{ tool: "bash", args: { command: "git push origin feat/x" }, id: "x1" }, { tool: "bash", args: { command: "git push -u origin feat/x" }, id: "x2" }, { tool: "bash", args: { command: "git push origin master" }, id: "x3" }, { text: "done" }];
	const { ends, stderr } = await runChild(script, undefined, (store) => { store.mintLease({ candidate: repo, pushUrl: ORIGIN, branch: "feat/x" }); }, "release-engineer", { dir: repo, withLeases: true });
	assert.equal(ends.length, 3, stderr);
	assert.doesNotMatch(ends[0].text, /Blocked by harness safety guard/);
	assert.doesNotMatch(ends[1].text, /Blocked by harness safety guard/);
	assert.match(ends[2].text, /Blocked by harness safety guard \[GIT_PUBLISH\]/);
	const drift = makeRepo(path.join(root, "lease-drift-repo"));
	const driftRun = await runChild([{ tool: "bash", args: { command: "git push origin feat/x" }, id: "y1" }, { text: "done" }], undefined, (store) => { store.mintLease({ candidate: drift, pushUrl: ORIGIN, branch: "feat/x" }); spawnSync("git", ["config", "push.followTags", "true"], { cwd: drift }); }, "release-engineer", { dir: drift, withLeases: true });
	assert.equal(driftRun.ends.length, 1, driftRun.stderr);
	assert.match(driftRun.ends[0].text, /Blocked by harness safety guard/, "followTags refuses the live binding");
});

test("child lease (runtime): project-source agents and other roles get no lease copy; the same push stays blocked", { timeout: 240_000 }, async () => {
	const repo = makeRepo(path.join(root, "lease-scope-repo"));
	const script: Step[] = [{ tool: "bash", args: { command: "git push origin feat/x" }, id: "z1" }, { text: "done" }];
	const mint = (store: ReturnType<typeof createGrantStore>) => { store.mintLease({ candidate: repo, pushUrl: ORIGIN, branch: "feat/x" }); };
	const project = await runChild(script, undefined, mint, "release-engineer", { dir: repo, withLeases: false });
	assert.equal(project.ends.length, 1, project.stderr);
	assert.match(project.ends[0].text, /Blocked by harness safety guard/, "project-source agent");
	const other = await runChild(script, undefined, mint, "general-worker", { dir: repo, withLeases: true });
	assert.equal(other.ends.length, 1, other.stderr);
	assert.match(other.ends[0].text, /Blocked by harness safety guard/, "other role");
});

// Commit-lease runtime cases: simulated TUI for the re-prompt ladder and refusals, real child for the commit gate.
function artifactDirFor(): string {
	const dir = path.join(os.tmpdir(), "worktrees", `pi-auth-${randomBytes(4).toString("hex")}`, "_scratch", "task");
	fs.mkdirSync(dir, { recursive: true });
	return fs.realpathSync.native(dir).replace(/\\/g, "/");
}
const COMMIT_TEXT = "feat x: add y";

test("main U (simulated TUI): push-only then commit re-prompts once; the commit lease covers push-only with no dialog; the identical commit request is covered", { timeout: 180_000 }, async () => {
	const s = await openMain([{ tool: "request_authorization", args: { push_branch: { branch: "feat/x" } }, id: "u0" }, { tool: "request_authorization", args: { push_branch: { branch: "feat/x", commits: true } }, id: "u1" }, { tool: "request_authorization", args: { push_branch: { branch: "feat/x", commits: true } }, id: "u2" }, { tool: "request_authorization", args: { push_branch: { branch: "feat/x" } }, id: "u3" }, { text: "done" }], { ui: approve, repo: true });
	try {
		const r = await s.run();
		assert.equal(s.confirms.length, 2, "push-only, then the commit upgrade");
		assert.match(String(s.confirms[1][1]), /normal commits/);
		assert.equal(r[0].isError, false, r[0].text);
		assert.equal(r[1].isError, false, r[1].text);
		assert.match(r[1].text, /push and commit/);
		assert.match(r[2].text, /Already authorized this session.*push and commit/);
		assert.match(r[3].text, /Already authorized/);
	} finally { s.cleanup(); }
});

test("main V (simulated TUI): commit-only request shapes that are invalid never reach the dialog", { timeout: 240_000 }, async () => {
	const art = artifactDirFor();
	const bad: Array<[string, Record<string, unknown>]> = [
		["artifact_dir without commits", { push_branch: { branch: "feat/x", artifact_dir: art } }],
		["commits not boolean", { push_branch: { branch: "feat/x", commits: "yes" } }],
		["relative artifact_dir", { push_branch: { branch: "feat/x", commits: true, artifact_dir: "relative/dir" } }],
		["artifact_dir outside placement", { push_branch: { branch: "feat/x", commits: true, artifact_dir: fs.realpathSync.native(os.tmpdir()).replace(/\\/g, "/") } }],
	];
	for (const [label, args] of bad) {
		const s = await openMain([{ tool: "request_authorization", args, id: "v0" }, { text: "done" }], { ui: approve, repo: true });
		try {
			const r = await s.run();
			assert.equal(s.confirms.length, 0, label);
			assert.equal(r[0].isError, true, label);
		} finally { s.cleanup(); }
	}
});

test("main W (simulated TUI): a commit lease binds its artifact directory; the same directory is covered and a different one re-prompts", { timeout: 180_000 }, async () => {
	const art = artifactDirFor();
	const other = artifactDirFor();
	const s = await openMain([{ tool: "request_authorization", args: { push_branch: { branch: "feat/x", commits: true, artifact_dir: art } }, id: "w0" }, { tool: "request_authorization", args: { push_branch: { branch: "feat/x", commits: true, artifact_dir: art } }, id: "w1" }, { tool: "request_authorization", args: { push_branch: { branch: "feat/x", commits: true, artifact_dir: other } }, id: "w2" }, { text: "done" }], { ui: approve, repo: true });
	try {
		const r = await s.run();
		assert.equal(s.confirms.length, 2, "a different artifact directory is a new binding");
		assert.ok(String(s.confirms[0][1]).includes(art), "dialog names the bound artifact directory");
		assert.equal(r[0].isError, false, r[0].text);
		assert.match(r[1].text, /Already authorized/);
		assert.equal(r[2].isError, false, r[2].text);
	} finally { s.cleanup(); }
});

test("child commit gate: a trusted release-engineer child refuses a normal commit without a commit lease, allows it with one, and only the trusted role is gated", { timeout: 240_000 }, async () => {
	const work = fs.mkdtempSync(path.join(scratchBase, "gate-"));
	const repo = makeRepo(path.join(work, "repo"));
	assert.equal(spawnSync("git", ["checkout", "-q", "feat/x"], { cwd: repo, windowsHide: true }).status, 0);
	const commit = [{ tool: "bash", args: { command: `git commit -m "${COMMIT_TEXT}"` }, id: "g1" }, { text: "done" }];
	const noLease = await runChild(commit, undefined, undefined, "release-engineer", { dir: repo, withLeases: true });
	assert.equal(noLease.ends.length, 1, noLease.stderr);
	assert.match(noLease.ends[0].text, /Blocked by harness safety guard \[GIT_COMMIT\]/);
	const withLease = await runChild(commit, undefined, (store) => store.mintLease({ ...pushBranchTarget(repo, "feat/x")!, commits: true }), "release-engineer", { dir: repo, withLeases: true });
	assert.equal(withLease.ends.length, 1, withLease.stderr);
	assert.doesNotMatch(withLease.ends[0].text, /Blocked by harness safety guard/);
	const other = await runChild(commit, undefined, undefined, "general-worker", { dir: repo, withLeases: true });
	assert.doesNotMatch(other.ends[0].text, /Blocked by harness safety guard/, "policy-only for other roles");
});

test("main X (simulated TUI): /authorization is read-only and secret-free: it names the push+commit lease and opens no dialog", { timeout: 120_000 }, async () => {
	const s = await openMain([{ tool: "request_authorization", args: { push_branch: { branch: "feat/x", commits: true } }, id: "x0" }, { text: "done" }], { ui: approve, repo: true });
	try {
		await s.run();
		const before = s.confirms.length;
		await s.run("/authorization");
		assert.equal(s.confirms.length, before, "status opens no dialog");
		const note = String(s.notes.at(-1)?.[0] ?? "");
		assert.match(note, /push leases: 1/, note);
		assert.match(note, /- push\+commit: repo .*branch feat\/x/, note);
		assert.match(note, /valid/, note);
		assert.doesNotMatch(note, /https?:\/\/|token|Bearer|request_authorization|git commit/i);
		assert.ok(!note.includes(ORIGIN), "no push URL in the status");
	} finally { s.cleanup(); }
});
