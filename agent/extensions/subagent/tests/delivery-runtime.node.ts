// Runtime lifecycle for the release delivery grant: main-session wiring (simulated TUI dialog, abort, /revoke-authorization, shutdown) and the release-engineer launch envelope. Node-only (native TS):
//   node --experimental-transform-types --test agent/extensions/subagent/tests/delivery-runtime.node.ts
// Real installed Pi SDK session with a scripted operator; no live provider. Network is cut by a dead loopback proxy and git/gh argv from the bash tool is intercepted by a bash tripwire (offlineEnv, installTripwire). Every risky main call is refused before execution; the one child check is refused by the GH_REPO env rule before any GitHub read.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import readline from "node:readline";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { hostModules } from "./host-modules.ts";
import { canonicalCwd, CHILD_GRANT_ENV, claimChildGuard, createGrantStore, serializeGrants } from "../safety-core.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const profileRoot = path.resolve(here, "../../../..");
const extensionDir = path.resolve(here, "..");
const guardFile = path.join(extensionDir, "safety-guard-entry.ts");
const host = hostModules([
	"@earendil-works/pi-coding-agent/dist/bundle/cli.js",
	"@earendil-works/pi-coding-agent/dist/index.js",
	"@earendil-works/pi-ai/dist/index.js",
]);
const installed = (rel: string) => path.join(host, "@earendil-works", ...rel.split("/"));
const piCli = installed("pi-coding-agent/dist/bundle/cli.js");
const piAi = pathToFileURL(installed("pi-ai/dist/index.js")).href;
const installedProfileRoot = path.resolve(host, "../../../../..");

const scratchBase = process.env.DELIVERY_TEST_SCRATCH ?? os.tmpdir();
const root = fs.mkdtempSync(path.join(scratchBase, "delivery-runtime-"));
const agentDir = path.join(root, "agent-dir");
fs.mkdirSync(agentDir, { recursive: true });

// Hermetic git: no user or system config reaches fixture repos or the guard's live binding.
const GIT_CFG = path.join(root, "gitconfig");
fs.writeFileSync(GIT_CFG, "");
process.env.GIT_CONFIG_GLOBAL = GIT_CFG;
process.env.GIT_CONFIG_NOSYSTEM = "1";

// Offline fail-safe harness: dead loopback proxy, scrubbed credentials and helper prompts, empty gh config, isolated git config, and a bash tripwire (BASH_ENV functions git/gh that log argv and exit 97). shortcut: bare git/gh in bash -c only; `command git`, absolute paths and node-side spawns are not intercepted (the dead proxy and empty gh config cover the network). Extensionless PATH shims are not run by Git Bash without the exec bit, which Node cannot set on Windows.
const fwd = (p: string) => p.replace(/\\/g, "/");
const TRIPWIRE_SH = fwd(path.join(root, "tripwire.sh"));
const TRIPWIRE_LOG = fwd(path.join(root, "tripwire.log"));
const GH_CONFIG = fwd(path.join(root, "gh-config"));
const HOME_DIR = fwd(path.join(root, "home"));
const DEAD_PROXY = "http://127.0.0.1:1";
const PROXY_VARS = ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"];
const MANAGED = /^(PATH|HOME|USERPROFILE|NO_PROXY|HTTP_PROXY|HTTPS_PROXY|ALL_PROXY|GIT_TERMINAL_PROMPT|GCM_INTERACTIVE|GH_PROMPT_DISABLED|GH_CONFIG_DIR|GIT_CONFIG_GLOBAL|GIT_CONFIG_NOSYSTEM|TRIPWIRE_LOG|BASH_ENV)$/i;
const SCRUBBED = /^(GH_TOKEN|GITHUB_TOKEN|GH_ENTERPRISE_TOKEN|GITHUB_ENTERPRISE_TOKEN|GIT_ASKPASS|SSH_ASKPASS|GIT_CONFIG_COUNT|GIT_CONFIG_PARAMETERS|GIT_CONFIG_KEY_\d+|GIT_CONFIG_VALUE_\d+)$/i;
function offlineEnv(base: NodeJS.ProcessEnv): Record<string, string> {
	const env: Record<string, string> = {};
	for (const [k, v] of Object.entries(base)) if (v !== undefined && !SCRUBBED.test(k) && !MANAGED.test(k)) env[k] = v;
	const inherited = Object.entries(base).find(([k]) => k.toUpperCase() === "PATH")?.[1];
	Object.assign(env, { PATH: inherited ?? "", BASH_ENV: TRIPWIRE_SH, HOME: HOME_DIR, USERPROFILE: HOME_DIR, NO_PROXY: "", no_proxy: "", GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never", GH_PROMPT_DISABLED: "1", GH_CONFIG_DIR: GH_CONFIG, GIT_CONFIG_GLOBAL: GIT_CFG, GIT_CONFIG_NOSYSTEM: "1", TRIPWIRE_LOG });
	for (const k of PROXY_VARS) env[k] = DEAD_PROXY;
	return env;
}
const shimFn = (tool: string) => `${tool}() { printf 'TRIPWIRE ${tool}' >> "$TRIPWIRE_LOG"; for a in "$@"; do printf ' [%s]' "$a" >> "$TRIPWIRE_LOG"; done; printf '\n' >> "$TRIPWIRE_LOG"; echo "tripwire: blocked ${tool}" >&2; return 97; }`;
function installTripwire(): void {
	fs.mkdirSync(GH_CONFIG, { recursive: true });
	fs.mkdirSync(HOME_DIR, { recursive: true });
	fs.writeFileSync(TRIPWIRE_SH, `${shimFn("git")}\n${shimFn("gh")}\n`);
	// Pi resolves its code integration under HOME; copy the installed package into the isolated home (scratch only).
	const ponytail = path.join("agent", "npm", "node_modules", "@dietrichgebert", "ponytail");
	fs.cpSync(path.join(installedProfileRoot, ponytail), path.join(HOME_DIR, ".pi", ponytail), { recursive: true });
}
const tripwireLog = () => (fs.existsSync(TRIPWIRE_LOG) ? fs.readFileSync(TRIPWIRE_LOG, "utf8") : "");
function assertNoTripwire(where: string): void { assert.equal(tripwireLog(), "", `${where}: git/gh argv reached the bash tripwire`); }
installTripwire();
const hermetic = offlineEnv(process.env);
for (const k of Object.keys(process.env)) if (!(k in hermetic)) delete process.env[k];
Object.assign(process.env, hermetic);

const GITHUB_ORIGIN = "https://github.com/example-owner/example-repo.git";
const MOVED_ORIGIN = "https://github.com/example-owner/moved-repo.git";
const LOCAL_ORIGIN = path.join(root, "absent-origin.git");
const CREATE_PR = 'gh pr create --repo example-owner/example-repo --base main --head feat/x --title "Release 1"';
const MAIN_RM = "rm -rf probe-absent-dir";
const REQ = { tool: "request_authorization", args: { delivery: { branch: "feat/x", base: "main" } } };

function makeRepo(dir: string, origin: string): string {
	fs.mkdirSync(dir, { recursive: true });
	const git = (...args: string[]) => {
		const run = spawnSync("git", args, { cwd: dir, encoding: "utf8", windowsHide: true });
		assert.equal(run.status, 0, `git ${args.join(" ")}: ${run.stderr}`);
	};
	git("init", "-q");
	git("-c", "user.name=t", "-c", "user.email=t@example.test", "commit", "-q", "--allow-empty", "-m", "init");
	git("branch", "feat/x");
	git("remote", "add", "origin", origin);
	return canonicalCwd(dir);
}

// Faux provider extension for the child runtime: scripted tool calls from a JSON file.
const fauxFile = path.join(root, "faux-extension.mjs");
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

async function runChild(script: Step[], opts: { dir: string; role: string; withLeases: boolean; mint?: (store: ReturnType<typeof createGrantStore>) => void; env?: Record<string, string>; raw?: string; unguarded?: boolean }): Promise<{ ends: ToolEnd[]; stderr: string }> {
	const scriptFile = path.join(root, `script-${Math.random().toString(36).slice(2)}.json`);
	fs.writeFileSync(scriptFile, JSON.stringify(script));
	const store = createGrantStore();
	opts.mint?.(store);
	const guard = opts.unguarded ? undefined : claimChildGuard(store, opts.role, canonicalCwd(opts.dir), guardFile, undefined, opts.withLeases);
	const childEnv: NodeJS.ProcessEnv = { ...offlineEnv(process.env), ...(opts.env ?? {}), PI_CODING_AGENT_DIR: agentDir, PROBE_SCRIPT: scriptFile };
	delete childEnv[CHILD_GRANT_ENV];
	const env = { ...(guard ? guard.childEnv(childEnv) : childEnv) } as Record<string, string>;
	if (opts.raw !== undefined) env[CHILD_GRANT_ENV] = opts.raw;
	const proc = spawn(process.execPath, [piCli, "--mode", "rpc", "--no-session", "--no-extensions", "--no-mcp", "--no-skills", "--no-prompt-templates", "--offline", "--provider", "probe-faux", "--model", "probe-model", "--extension", fauxFile, ...(guard ? ["--extension", guard.entry] : [])], { cwd: opts.dir, env, stdio: ["pipe", "pipe", "pipe"] });
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

// Main session with a simulated TUI operator (scripted ui.confirm). Mirrors the harness used by safety-guard-runtime.node.ts (copied: that file must stay unchanged).
type SdkStep = { tool: string; args: Record<string, unknown>; id: string } | { text: string };
let sdkModules: { pi: any; ai: any } | undefined;
async function sdk() {
	sdkModules ??= { pi: await import(pathToFileURL(installed("pi-coding-agent/dist/index.js")).href), ai: await import(piAi) };
	return sdkModules;
}
const MAIN_SENTINEL = "DELIVERY-SENTINEL-NOT-A-CREDENTIAL-4f7a";
const sha = (p: string) => (fs.existsSync(p) ? fs.readFileSync(p).toString("base64") : "absent");
const textOf = (content: any) => (content ?? []).filter((c: any) => c.type === "text").map((c: any) => c.text).join("\n");
const approve = { confirm: async () => true };
const refuse = { confirm: async () => false };
const throwing = { confirm: async () => { throw new Error("stub dialog failure"); } };

async function openMain(steps: SdkStep[], opts: { ui?: { confirm: (...a: any[]) => Promise<any> }; mode?: string; tokensPerSecond?: number; dir?: string; origin?: string } = {}) {
	const { pi, ai } = await sdk();
	const main = opts.dir ?? fs.mkdtempSync(path.join(scratchBase, "delivery-main-"));
	const agentDirMain = path.join(main, "agent");
	const cwd = path.join(main, "project");
	fs.mkdirSync(agentDirMain, { recursive: true });
	fs.mkdirSync(cwd, { recursive: true });
	fs.writeFileSync(path.join(agentDirMain, "auth.json"), JSON.stringify({ fixtureSentinel: MAIN_SENTINEL }));
	fs.writeFileSync(path.join(cwd, ".env"), `FIXTURE=${MAIN_SENTINEL}\n`);
	if (opts.origin !== undefined && !fs.existsSync(path.join(cwd, ".git"))) makeRepo(cwd, opts.origin);
	const fixtures = [path.join(agentDirMain, "auth.json"), path.join(cwd, ".env")];
	const before = fixtures.map(sha);
	const core = ai.createFauxCore({ api: "delivery-faux-api", provider: "delivery-faux", models: [{ id: "delivery-model", name: "delivery" }], tokensPerSecond: opts.tokensPerSecond });
	core.setResponses(steps.map((s) => ("text" in s ? ai.fauxAssistantMessage(ai.fauxText(s.text)) : ai.fauxAssistantMessage(ai.fauxToolCall(s.tool, s.args, { id: s.id })))));
	const settingsManager = pi.SettingsManager.inMemory();
	const resourceLoader = new pi.DefaultResourceLoader({
		cwd, agentDir: agentDirMain, settingsManager, additionalExtensionPaths: [path.join(extensionDir, "index.ts")],
		extensionFactories: [(p: any) => p.registerProvider("delivery-faux", { api: core.api, apiKey: "inert-fixture-key", streamSimple: core.streamSimple, models: core.models })],
		disabledBuiltinExtensions: ["mcp", "codemode", "tool-search", "llama.cpp"],
		skillsOverride: (base: any) => ({ skills: [], diagnostics: base.diagnostics }),
		noThemes: true, noContextFiles: true,
	});
	await resourceLoader.reload();
	const { session } = await pi.createAgentSession({ cwd, agentDir: agentDirMain, settingsManager, resourceLoader, model: core.models[0], sessionManager: pi.SessionManager.inMemory(cwd) });
	const confirms: any[][] = [];
	const uiContext = opts.ui ? { notify() {}, setStatus() {}, setWidget() {}, confirm: (...a: any[]) => { confirms.push(a); return opts.ui!.confirm(...a); } } : undefined;
	await session.bindExtensions({ uiContext, mode: opts.mode ?? "tui" });
	const results = () => session.messages.filter((m: any) => m.role === "toolResult").map((m: any) => ({ tool: m.toolName, isError: m.isError === true, text: textOf(m.content) }));
	const run = async (prompt = "probe") => { await session.prompt(prompt); return results(); };
	const unchanged = () => fixtures.every((p, i) => sha(p) === before[i]);
	return { core, session, cwd, agentDir: agentDirMain, confirms, run, results, unchanged, shutdown: () => (session.extensionRunner.hasHandlers("session_shutdown") ? session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" }) : undefined), cleanup: () => { session.dispose(); if (!opts.dir) fs.rmSync(main, { recursive: true, force: true }); } };
}

test("offline harness contract (structural, stubs only, no live exec): dead proxy, credential-free env, bash tripwire via BASH_ENV, empty gh config", () => {
	installTripwire();
	const base: NodeJS.ProcessEnv = { ...process.env, GH_TOKEN: "CONTRACT-SENTINEL", GITHUB_TOKEN: "CONTRACT-SENTINEL", GIT_ASKPASS: "CONTRACT-SENTINEL", SSH_ASKPASS: "CONTRACT-SENTINEL", NO_PROXY: "github.com", no_proxy: "github.com", GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "credential.helper", GIT_CONFIG_VALUE_0: "CONTRACT-SENTINEL" };
	const env = offlineEnv(base);
	for (const k of ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"]) assert.equal(env[k] === DEAD_PROXY, true, `${k} is not the dead loopback proxy`);
	for (const k of ["NO_PROXY", "no_proxy"]) assert.equal(env[k] === "", true, `${k} not cleared`);
	assert.equal(env.GIT_TERMINAL_PROMPT, "0");
	for (const k of ["GH_TOKEN", "GITHUB_TOKEN", "GIT_ASKPASS", "SSH_ASKPASS", "GIT_CONFIG_COUNT", "GIT_CONFIG_KEY_0", "GIT_CONFIG_VALUE_0"]) assert.equal(k in env, false, `${k} survived`);
	assert.equal(Object.values(env).some((v) => v === "CONTRACT-SENTINEL"), false, "a removed credential value survived");
	assert.equal(env.GH_CONFIG_DIR === GH_CONFIG && fs.readdirSync(GH_CONFIG).length === 0, true, "gh config dir is not an empty scratch dir");
	assert.equal(env.GIT_CONFIG_GLOBAL === GIT_CFG && env.GIT_CONFIG_NOSYSTEM === "1", true, "global/system git config not isolated");
	const pathKeys = Object.keys(env).filter((k) => k.toUpperCase() === "PATH");
	assert.equal(pathKeys.length, 1, "PATH must appear once (Windows keys are case-insensitive)");
	assert.equal(env.BASH_ENV === TRIPWIRE_SH, true, "bash will not load the tripwire functions");
	assert.equal(env.TRIPWIRE_LOG === TRIPWIRE_LOG, true, "tripwire log not in child env");
	for (const tool of ["git", "gh"]) assert.equal(fs.readFileSync(TRIPWIRE_SH, "utf8").includes(`${tool}() {`), true, `${tool} tripwire function missing`);
});

test("offline harness canary (real Pi bash runtime): a benign git --version reaches the bash tripwire and is logged, then the log is reset", { timeout: 120_000 }, async () => {
	installTripwire();
	fs.rmSync(TRIPWIRE_LOG, { force: true });
	const dir = path.join(root, "canary-dir");
	fs.mkdirSync(dir, { recursive: true });
	const { ends, stderr } = await runChild([{ tool: "bash", args: { command: "git --version" }, id: "canary" }, { text: "done" }], { dir, role: "general-worker", withLeases: false, unguarded: true });
	const log = tripwireLog();
	fs.rmSync(TRIPWIRE_LOG, { force: true });
	assert.equal(ends.length, 1, stderr);
	assert.match(ends[0].text, /tripwire: blocked git/, "the bash tool did not run the git shim");
	assert.equal(log, "TRIPWIRE git [--version]\n", "tripwire log did not record the canary argv");
});

test("offline harness stub guard-allow (unguarded child, non-network fixture): publish literals are intercepted by the bash tripwire; argv logged only; exit 97", { timeout: 180_000 }, async () => {
	fs.rmSync(TRIPWIRE_LOG, { force: true });
	const dir = path.join(root, "bypass-nonrepo");
	fs.mkdirSync(dir, { recursive: true });
	const { ends, stderr } = await runChild([{ tool: "bash", args: { command: "git push origin feat/x" }, id: "b1" }, { tool: "bash", args: { command: CREATE_PR }, id: "b2" }, { text: "done" }], { dir, role: "release-engineer", withLeases: true, unguarded: true, env: { GIT_DIR: fwd(path.join(root, "absent-gitdir")) } });
	const log = tripwireLog();
	fs.rmSync(TRIPWIRE_LOG, { force: true });
	assert.equal(ends.length, 2, stderr);
	for (const e of ends) { assert.equal(e.isError, true); assert.match(e.text, /tripwire: blocked (git|gh)/); }
	assert.equal(log, "TRIPWIRE git [push] [origin] [feat/x]\nTRIPWIRE gh [pr] [create] [--repo] [example-owner/example-repo] [--base] [main] [--head] [feat/x] [--title] [Release 1]\n");
});

test("offline harness canary (main session bash): the in-process Pi bash runtime also reaches the bash tripwire", { timeout: 180_000 }, async () => {
	fs.rmSync(TRIPWIRE_LOG, { force: true });
	const s = await openMain([{ tool: "bash", args: { command: "git --version" }, id: "mc" }, { text: "done" }], { ui: approve, origin: GITHUB_ORIGIN });
	try {
		const r = await s.run();
		const log = tripwireLog();
		fs.rmSync(TRIPWIRE_LOG, { force: true });
		assert.match(r[0].text, /tripwire: blocked git/, r[0].text);
		assert.equal(log, "TRIPWIRE git [--version]\n");
	} finally { s.cleanup(); }
});

test("delivery approve (simulated TUI): one dialog; identical re-request reuses the session record; main never uses delivery", { timeout: 180_000 }, async () => {
	const s = await openMain([REQ, REQ, { tool: "bash", args: { command: CREATE_PR }, id: "a2" }, { tool: "bash", args: { command: "git push origin feat/x" }, id: "a3" }, { text: "done" }], { ui: approve, origin: GITHUB_ORIGIN });
	try {
		const r = await s.run();
		assert.equal(s.confirms.length, 1);
		assert.equal(s.confirms[0][0], "Authorize release delivery?");
		assert.match(String(s.confirms[0][1]), /Repo: example-owner\/example-repo/);
		assert.match(String(s.confirms[0][1]), /Branch: feat\/x into base main/);
		assert.match(String(s.confirms[0][1]), /Scope: this PI session \(no time expiry\)/);
		assert.equal(r[0].isError, false, r[0].text);
		assert.match(r[0].text, /for this PI session/);
		assert.doesNotMatch(r[0].text, /until \d{4}-/, "no absolute expiry in the receipt");
		assert.equal(r[1].isError, false, r[1].text);
		assert.match(r[1].text, /^Already authorized: release delivery .* is live for this PI session; no new dialog\./);
		assert.equal(s.confirms.length, 1, "identical re-request shows no second dialog");
		assert.equal(r[2].isError, true);
		assert.match(r[2].text, /Blocked by harness safety guard/);
		assert.equal(r[3].isError, true);
		assert.match(r[3].text, /Blocked by harness safety guard/);
		assert.equal(s.unchanged(), true);
		assertNoTripwire("delivery approve");
	} finally { s.cleanup(); }
});

test("delivery dialog outcomes (simulated TUI): refused, undefined and throwing dialogs mint nothing; the next request asks again", { timeout: 240_000 }, async () => {
	const uis = [["refuse", refuse], ["undefined", { confirm: async () => undefined }], ["throws", throwing]] as const;
	for (const [label, ui] of uis) {
		const s = await openMain([REQ, REQ, { text: "done" }], { ui, origin: GITHUB_ORIGIN });
		try {
			const r = await s.run();
			assert.equal(s.confirms.length, 2, label);
			assert.ok(r[0].isError && r[1].isError, label);
			assert.doesNotMatch(r.map((x: any) => x.text).join("\n"), /Already authorized|live for this PI session/, label);
		} finally { s.cleanup(); }
	}
});

test("delivery drift (simulated TUI): a binding change during the dialog mints nothing; the next request asks again against the new binding", { timeout: 180_000 }, async () => {
	const dir = fs.mkdtempSync(path.join(scratchBase, "delivery-drift-"));
	const repoDir = path.join(dir, "project");
	let calls = 0;
	const ui = { confirm: async () => { calls += 1; if (calls === 1) spawnSync("git", ["remote", "set-url", "origin", MOVED_ORIGIN], { cwd: repoDir, windowsHide: true }); return true; } };
	const s = await openMain([REQ, REQ, { text: "done" }], { ui, origin: GITHUB_ORIGIN, dir });
	try {
		const r = await s.run();
		assert.equal(s.confirms.length, 2, "drifted approval mints nothing: the next request asks again");
		assert.equal(r[0].isError, true);
		assert.match(r[0].text, /repository binding changed during approval; no delivery grant minted\./);
		assert.equal(r[1].isError, false, r[1].text);
		assert.match(r[1].text, /^Authorized release-engineer release delivery for example-owner\/moved-repo feat\/x into main/);
	} finally { s.cleanup(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test("delivery refusals (simulated TUI): invalid shapes, modes and origins never reach the dialog", { timeout: 300_000 }, async () => {
	const bad: Array<Record<string, unknown>> = [
		{ delivery: { branch: "feat/x", base: "main" }, role: "general-worker" },
		{ delivery: { branch: "feat/x", base: "main" }, ttl_minutes: 5 },
		{ delivery: { branch: "feat/x", base: "main" }, operations: [{ kind: "shell", value: MAIN_RM }] },
		{ delivery: { branch: "feat/x", base: "main" }, push_branch: { branch: "feat/x" } },
		{ delivery: { branch: "feat/x", base: "feat/x" } },
		{ delivery: { branch: "feat/x", base: "main", pr: 0 } },
		{ delivery: { branch: "feat/x", base: "main", version: "1.2" } },
		{ delivery: { branch: "feat/x", base: "main", latest: true } },
		{ delivery: { branch: "feat/x", base: "main", artifact_dir: "/tmp/x" } },
		{ delivery: { branch: "master", base: "main" } },
		{ delivery: { branch: "feat/x", base: "main", cwd: ".." } },
	];
	const s = await openMain(bad.map((args, i) => ({ tool: "request_authorization", args, id: `bad${i}` })).concat([{ text: "done" }]), { ui: approve, origin: GITHUB_ORIGIN });
	try {
		const r = await s.run();
		assert.equal(r.length, bad.length);
		assert.ok(r.every((x: any) => x.isError), JSON.stringify(r.map((x: any) => x.text)));
		assertNoTripwire("delivery refusals");
		assert.equal(s.confirms.length, 0);
	} finally { s.cleanup(); }
	for (const [label, mode, ui, origin] of [["rpc mode with UI", "rpc", approve, GITHUB_ORIGIN], ["no repository", "tui", approve, undefined], ["non-github origin", "tui", approve, LOCAL_ORIGIN]] as const) {
		const t = await openMain([REQ, { text: "done" }], { mode, ui, origin });
		try {
			const r = await t.run();
			assert.equal(r[0].isError, true, label);
			assert.equal(t.confirms.length, 0, label);
		} finally { t.cleanup(); }
	}
});

test("delivery ttl (simulated TUI): ttl_minutes is refused as session-scoped with no dialog", { timeout: 180_000 }, async () => {
	const s = await openMain([{ tool: "request_authorization", args: { delivery: { branch: "feat/x", base: "main" }, ttl_minutes: 5 }, id: "ttl1" }, { text: "done" }], { ui: approve, origin: GITHUB_ORIGIN });
	try {
		const r = await s.run();
		assert.equal(r[0].isError, true, r[0].text);
		assert.match(r[0].text, /session-scoped; TTL unsupported/);
		assert.equal(s.confirms.length, 0);
	} finally { s.cleanup(); }
});

test("delivery abort (simulated TUI): an agent abort keeps the delivery; the identical request is Already authorized with no dialog and the same session record", { timeout: 180_000 }, async () => {
	const s = await openMain([REQ, { text: "x ".repeat(300) }], { ui: approve, origin: GITHUB_ORIGIN, tokensPerSecond: 20 });
	try {
		let aborted = false;
		s.session.subscribe((e: any) => { if (e.type === "tool_execution_end" && e.toolName === "request_authorization" && !aborted) { aborted = true; void s.session.abort(); } });
		const first = await s.run();
		assert.equal(aborted, true);
		assert.match(first[0].text, /for this PI session/);
		const { ai } = await sdk();
		s.core.setResponses([ai.fauxAssistantMessage(ai.fauxToolCall("request_authorization", REQ.args, { id: "abort2" })), ai.fauxAssistantMessage(ai.fauxText("done"))]);
		const r = await s.run("again");
		assert.equal(s.confirms.length, 1, "abort kept the delivery: no second dialog");
		assert.equal(r[r.length - 1].isError, false, r[r.length - 1].text);
		assert.match(r[r.length - 1].text, /is live for this PI session/, "same session delivery after abort");
	} finally { s.cleanup(); }
});

test("delivery revoke (simulated TUI): /revoke-authorization withdraws the delivery; the next request asks again", { timeout: 180_000 }, async () => {
	const s = await openMain([REQ, { text: "one" }, REQ, { text: "two" }], { ui: approve, origin: GITHUB_ORIGIN });
	try {
		await s.run();
		assert.equal(s.confirms.length, 1);
		await s.session.prompt("/revoke-authorization");
		const r = await s.run("again");
		assert.equal(s.confirms.length, 2, "revoke made the next request prompt again");
		assert.equal(r[r.length - 1].isError, false, r[r.length - 1].text);
		assert.doesNotMatch(r[r.length - 1].text, /Already authorized/);
	} finally { s.cleanup(); }
});

test("delivery shutdown (simulated TUI): session shutdown drops the delivery; a new session on the same binding asks again", { timeout: 180_000 }, async () => {
	const dir = fs.mkdtempSync(path.join(scratchBase, "delivery-shutdown-"));
	try {
		const first = await openMain([REQ, { text: "done" }], { ui: approve, origin: GITHUB_ORIGIN, dir });
		try { await first.run(); assert.equal(first.confirms.length, 1); } finally { await first.shutdown(); first.cleanup(); }
		const second = await openMain([REQ, { text: "done" }], { ui: approve, origin: GITHUB_ORIGIN, dir });
		try {
			const r = await second.run();
			assert.equal(second.confirms.length, 1, "shutdown revoked the delivery: asked again");
			assert.equal(r[0].isError, false, r[0].text);
			assert.doesNotMatch(r[0].text, /Already authorized/);
		} finally { second.cleanup(); }
	} finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("delivery launch (simulated TUI): user/package release-engineer gets the same session issuedAt on every spawn and no expiry field; project-source gets none", { timeout: 300_000 }, async () => {
	const dir = fs.mkdtempSync(path.join(scratchBase, "delivery-launch-"));
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
	const s = await openMain([REQ, { text: "done" }], { ui: approve, origin: GITHUB_ORIGIN, dir });
	const agentFile = path.join(s.cwd, ".pi", "agents", "release-engineer.md");
	fs.mkdirSync(path.dirname(agentFile), { recursive: true });
	fs.writeFileSync(agentFile, "---\nname: release-engineer\ndescription: project-source impostor\n---\nNo prompt.\n");
	const delivery = (guard: string | null) => (guard === null ? [] : JSON.parse(guard).delivery ?? []);
	const { ai } = await sdk();
	process.argv[1] = probe;
	// Pi resolves user scope from HOME/.pi/agent (isolated HOME, see offlineEnv); seed the real role file there for this test only.
	const userRole = path.join(HOME_DIR, ".pi", "agent", "agents", "release-engineer.md");
	fs.mkdirSync(path.dirname(userRole), { recursive: true });
	fs.copyFileSync(path.join(profileRoot, "agent", "agents", "release-engineer.md"), userRole);
	try {
		const approval = await s.run();
		assert.match(approval[0].text, /for this PI session/);
		const launch = (scope: string, file: string) => {
			process.env.PI_LAUNCH_PROBE = path.join(dir, file);
			s.core.setResponses([ai.fauxAssistantMessage(ai.fauxToolCall("subagent", { agent: "release-engineer", agentScope: scope, task: "probe", confirmProjectAgents: false, background: false }, { id: `l-${file}` })), ai.fauxAssistantMessage(ai.fauxText("done"))]);
		};
		launch("project", "project.json");
		await s.run("launch project");
		assert.ok(fs.existsSync(path.join(dir, "project.json")), `project launch did not reach the child: ${JSON.stringify(s.results())}`);
		assert.equal(delivery(JSON.parse(fs.readFileSync(path.join(dir, "project.json"), "utf8")).guard).length, 0, "project-source release-engineer gets no delivery");
		let issued: number | undefined;
		for (const file of ["user-1.json", "user-2.json"]) {
			launch("user", file);
			await s.run(`launch ${file}`);
			assert.ok(fs.existsSync(path.join(dir, file)), `${file} launch did not reach the child: ${JSON.stringify(s.results())}`);
			const copies = delivery(JSON.parse(fs.readFileSync(path.join(dir, file), "utf8")).guard);
			assert.equal(copies.length, 1, `${file} receives the delivery copy`);
			assert.equal("expiresAt" in copies[0], false, `${file}: session-scoped copy has no expiry`);
			if (issued === undefined) issued = copies[0].issuedAt; else assert.equal(copies[0].issuedAt, issued, `${file} keeps the same session issuedAt`);
		}
		assert.equal(s.confirms.length, 1, "launches never open a dialog");
	} finally {
		process.argv[1] = argv1;
		if (launchEnv === undefined) delete process.env.PI_LAUNCH_PROBE; else process.env.PI_LAUNCH_PROBE = launchEnv;
		s.cleanup();
		fs.rmSync(userRole, { force: true });
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("child delivery (runtime): a release-engineer child with a delivery copy still refuses gh forms when GH_REPO is set, before any GitHub read", { timeout: 180_000 }, async () => {
	const repo = makeRepo(path.join(root, "delivery-child-repo"), GITHUB_ORIGIN);
	const { ends, stderr } = await runChild([{ tool: "bash", args: { command: CREATE_PR }, id: "c1" }, { text: "done" }], {
		dir: repo, role: "release-engineer", withLeases: true, env: { GH_REPO: "example-owner/example-repo" },
		mint: (store) => { store.addDeliveryGrant({ role: "release-engineer", candidate: repo, pushUrl: GITHUB_ORIGIN, repo: "example-owner/example-repo", branch: "feat/x", base: "main" }); },
	});
	assert.equal(ends.length, 1, stderr);
	assert.equal(ends[0].isError, true);
	assert.match(ends[0].text, /Blocked by harness safety guard/);
	assertNoTripwire("child GH_REPO createPR");
});

test("delivery dialog text (simulated TUI): canonical artifact dir, file rules and session scope; the receipt has no time expiry", { timeout: 180_000 }, async () => {
	const art = path.join(root, "worktrees", "pi", "_evidence", "rt-artifacts");
	fs.mkdirSync(art, { recursive: true });
	fs.writeFileSync(path.join(art, "pr.md"), "Summary\n");
	const canonicalArt = fs.realpathSync.native(art).replace(/\\/g, "/");
	const req = { tool: "request_authorization", args: { delivery: { branch: "feat/x", base: "main", artifact_dir: canonicalArt } }, id: "ta" };
	const s = await openMain([req, { text: "done" }], { ui: approve, origin: GITHUB_ORIGIN });
	try {
		const r = await s.run();
		const dialog = String(s.confirms[0]?.[1] ?? "");
		assert.ok(dialog.includes(canonicalArt), "dialog shows the canonical artifact directory");
		assert.match(dialog, /\*\.md or \*\.txt/);
		assert.match(dialog, /64 KiB/);
		assert.match(dialog, /credential/i);
		assert.match(dialog, /Scope: this PI session \(no time expiry\)/);
		assert.doesNotMatch(dialog, /Expiry:|fixed 30 min/);
		assert.equal(r[0].isError, false, r[0].text);
		assert.match(r[0].text, /for this PI session/);
		assert.doesNotMatch(r[0].text, /until \d{4}-/);
	} finally { s.cleanup(); }
});

test("delivery cap (simulated TUI): a fifth live delivery is refused before any dialog; the four earlier approvals stand", { timeout: 300_000 }, async () => {
	const steps: SdkStep[] = ["main", "release", "develop", "staging", "qa"].map((base, i) => ({ tool: "request_authorization", args: { delivery: { branch: "feat/x", base } }, id: `cap${i}` }));
	const s = await openMain([...steps, { text: "done" }], { ui: approve, origin: GITHUB_ORIGIN });
	try {
		const r = await s.run();
		assert.equal(s.confirms.length, 4, "the fifth request opens no dialog");
		assert.ok(r.slice(0, 4).every((x: any) => !x.isError), JSON.stringify(r.map((x: any) => x.text)));
		assert.equal(r[4].isError, true);
		assert.match(r[4].text, /at most 4 live delivery grants; no delivery grant minted\./);
	} finally { s.cleanup(); }
});

test("child delivery envelope (runtime): a legacy 30-minute record carrying expiresAt fails closed for every tool call", { timeout: 180_000 }, async () => {
	const repo = makeRepo(path.join(root, "delivery-tamper-repo"), GITHUB_ORIGIN);
	const store = createGrantStore();
	store.addDeliveryGrant({ role: "release-engineer", candidate: repo, pushUrl: GITHUB_ORIGIN, repo: "example-owner/example-repo", branch: "feat/x", base: "main" });
	const [record] = store.copyDelivery(repo);
	const raw = serializeGrants([], [], [{ ...record, expiresAt: record.issuedAt + 30 * 60_000 }]);
	const { ends, stderr } = await runChild([{ tool: "bash", args: { command: "echo delivery-tamper-probe" }, id: "t1" }, { text: "done" }], { dir: repo, role: "release-engineer", withLeases: true, raw });
	assert.ok(ends.length >= 1, stderr);
	for (const e of ends) { assert.equal(e.isError, true); assert.match(e.text, /invalid child grant envelope/); }
	assertNoTripwire("legacy envelope echo");
});

// Opt-in fingerprint binding through the real request_authorization tool: dialog content, reuse only on an equal live state, change-during-dialog refusal.
function boundRepo(): { dir: string; repoDir: string } {
	const dir = fs.mkdtempSync(path.join(scratchBase, "delivery-bound-"));
	const repoDir = path.join(dir, "project");
	makeRepo(repoDir, GITHUB_ORIGIN);
	const run = spawnSync("git", ["checkout", "-q", "feat/x"], { cwd: repoDir, windowsHide: true });
	assert.equal(run.status, 0, String(run.stderr));
	return { dir, repoDir };
}
const BOUND_REQ = { tool: "request_authorization", args: { delivery: { branch: "feat/x", base: "main", bind: {} } }, id: "b1" };

test("delivery bind (simulated TUI): the dialog shows the bound state and limits; reuse only while the live state equals it; a changed state asks again", { timeout: 240_000 }, async () => {
	const { dir, repoDir } = boundRepo();
	const s = await openMain([BOUND_REQ, { ...BOUND_REQ, id: "b2" }, { text: "done" }], { ui: approve, origin: GITHUB_ORIGIN, dir });
	try {
		const first = (await s.session.prompt("probe"), s.results());
		assert.equal(s.confirms.length, 1);
		assert.match(String(s.confirms[0][1]), /Bound state: HEAD [0-9a-f]{40} on refs\/heads\/feat\/x; fingerprint [0-9a-f]{12}; excluded paths: none/);
		assert.match(String(s.confirms[0][1]), /Binding constrains only this grant: push leases, unbound delivery grants and trusted-context allowances/);
		assert.match(String(s.confirms[0][1]), /not race-free/);
		assert.equal(first[0].isError, false, first[0].text);
		assert.match(first[0].text, /release delivery bound to HEAD [0-9a-f]{7} for example-owner\/example-repo/);
		assert.match(first[1].text, /^Already authorized/);
		assert.equal(s.confirms.length, 1);
		assertNoTripwire("delivery bind");
	} finally { s.cleanup(); fs.rmSync(dir, { recursive: true, force: true }); }
	// State changed between two requests: the stored bound record is not "Already authorized"; a new confirm supersedes it.
	const other = boundRepo();
	let calls = 0;
	const ui = { confirm: async () => { calls += 1; if (calls === 1) fs.writeFileSync(path.join(other.repoDir, "late.txt"), "x\n"); return true; } };
	const t = await openMain([BOUND_REQ, BOUND_REQ, { ...BOUND_REQ, id: "b3" }, { text: "done" }], { ui, origin: GITHUB_ORIGIN, dir: other.dir });
	try {
		const r = (await t.session.prompt("probe"), t.results());
		assert.equal(r[0].isError, true);
		assert.match(r[0].text, /candidate changed during approval; no delivery grant minted\./);
		assert.equal(r[1].isError, false, r[1].text);
		assert.match(r[1].text, /bound to HEAD/);
		assert.match(r[2].text, /^Already authorized/);
		assert.equal(calls, 2);
	} finally { t.cleanup(); fs.rmSync(other.dir, { recursive: true, force: true }); }
});

test("delivery bind (simulated TUI): a detached or other-branch candidate and a bad expect are refused with no dialog", { timeout: 240_000 }, async () => {
	const { dir, repoDir } = boundRepo();
	spawnSync("git", ["checkout", "-q", "--detach"], { cwd: repoDir, windowsHide: true });
	const bad = { tool: "request_authorization", args: { delivery: { branch: "feat/x", base: "main", bind: { expect: "0".repeat(64) } } }, id: "b4" };
	const s = await openMain([BOUND_REQ, bad, { text: "done" }], { ui: approve, origin: GITHUB_ORIGIN, dir });
	try {
		const r = (await s.session.prompt("probe"), s.results());
		assert.equal(r[0].isError, true);
		assert.match(r[0].text, /no delivery grant minted/);
		assert.equal(r[1].isError, true);
		assert.equal(s.confirms.length, 0);
	} finally { s.cleanup(); fs.rmSync(dir, { recursive: true, force: true }); }
});
