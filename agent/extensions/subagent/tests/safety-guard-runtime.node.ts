// Real child RPC probe for the safety guard. Node-only (native TS): run with
//   node --experimental-transform-types --test agent/extensions/subagent/tests/safety-guard-runtime.node.ts
// A real installed Pi CLI child loads the production guard entry via claimChildGuard plus a scratch faux provider generated under STAGE1_PROBE_SCRATCH (or os.tmpdir()). Observed through tool_execution_end; no real credentials, network or model calls.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import readline from "node:readline";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { authorizableOp, canonicalCwd, CHILD_GRANT_ENV, claimChildGuard, createGrantStore } from "../safety-core.ts";

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

async function runChild(script: Step[], envOverride?: { [CHILD_GRANT_ENV]: string }, mintGrants?: (store: ReturnType<typeof createGrantStore>) => void, role = "probe-role"): Promise<{ ends: ToolEnd[]; stderr: string }> {
	const scriptFile = path.join(root, `script-${Math.random().toString(36).slice(2)}.json`);
	fs.writeFileSync(scriptFile, JSON.stringify(script));
	const store = createGrantStore();
	mintGrants?.(store);
	const guard = claimChildGuard(store, role, canonicalCwd(workspace), guardFile);
	const env = guard.childEnv({ ...process.env, PI_CODING_AGENT_DIR: agentDir, PROBE_SCRIPT: scriptFile });
	if (envOverride) Object.assign(env, envOverride);
	const proc = spawn(process.execPath, [piCli, "--mode", "rpc", "--no-session", "--no-extensions", "--no-mcp", "--no-skills", "--no-prompt-templates", "--offline", "--provider", "probe-faux", "--model", "probe-model", "--extension", fauxFile, "--extension", guard.entry], { cwd: workspace, env, stdio: ["pipe", "pipe", "pipe"] });
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

async function openMain(steps: SdkStep[], opts: { ui?: { confirm: (...a: any[]) => Promise<any> }; mode?: string; tokensPerSecond?: number } = {}) {
	const { pi, ai } = await sdk();
	const main = fs.mkdtempSync(path.join(scratchBase, "s1-main-"));
	const agentDir = path.join(main, "agent");
	const cwd = path.join(main, "project");
	fs.mkdirSync(agentDir, { recursive: true });
	fs.mkdirSync(cwd, { recursive: true });
	fs.writeFileSync(path.join(agentDir, "auth.json"), JSON.stringify({ fixtureSentinel: MAIN_SENTINEL }));
	fs.writeFileSync(path.join(cwd, ".env"), `FIXTURE=${MAIN_SENTINEL}\n`);
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
	const uiContext = opts.ui ? { notify() {}, setStatus() {}, setWidget() {}, confirm: (...a: any[]) => { confirms.push(a); return opts.ui!.confirm(...a); } } : undefined;
	await session.bindExtensions({ uiContext, mode: opts.mode ?? "tui" });
	const results = () => session.messages.filter((m: any) => m.role === "toolResult").map((m: any) => ({ tool: m.toolName, isError: m.isError === true, text: textOf(m.content) }));
	const run = async (prompt = "probe") => { await session.prompt(prompt); return results(); };
	const unchanged = () => fixtures.every((p, i) => sha(p) === before[i]);
	return { core, session, cwd, agentDir, confirms, run, results, unchanged, cleanup: () => { session.dispose(); fs.rmSync(main, { recursive: true, force: true }); } };
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
