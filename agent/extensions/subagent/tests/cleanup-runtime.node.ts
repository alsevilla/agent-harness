// Runtime seams of the narrow post-merge checkout cleanup: the real child guard entry applying a claimed cleanup envelope (real Pi child, fake gh, bash tripwire: the guard decides, nothing is removed) and the real main session (subagent cleanup refusals, runtime CLEANUP_PENDING in subagent_control list). Infrastructure copied from delivery-runtime.node.ts. Node-only (native TS):
//   node --experimental-transform-types --test agent/extensions/subagent/tests/cleanup-runtime.node.ts
// Real installed Pi SDK session with a scripted operator; no live provider. Network is cut by a dead loopback proxy and git/gh argv from the bash tool is intercepted by a bash tripwire (offlineEnv, installTripwire). Every risky main call is refused before execution; the one child check is refused by the GH_REPO env rule before any GitHub read.
import assert from "node:assert/strict";
import cpDefault, { spawn, spawnSync } from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import readline from "node:readline";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { hostModules } from "./host-modules.ts";
import { bindDelivery, canonicalCwd, CHILD_GRANT_ENV, claimChildGuard, createGrantStore, livePushUrl, prepareCleanup } from "../safety-core.ts";
import { OwnerTracker } from "../cleanup-state.ts";

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

// Mint-time live verification runs in the main process; answer gh and git ls-remote in-process (no network). Children are separate processes and unaffected.
const RELEASE_SHA = "fedcba9876543210fedcba9876543210fedcba98";
const STUB = { head: "0".repeat(40) };
{
	const cp = cpDefault as any;
	const originalExec = cp.execFileSync;
	const originalSpawn = cp.spawnSync;
	cp.execFileSync = (file: string, args: string[], opts: unknown) => {
		if (file !== "gh") return originalExec(file, args, opts);
		if (args[0] === "pr" && args[1] === "view" && args.some((a) => a.includes("mergeCommit"))) return JSON.stringify({ number: Number(args[2]), state: "MERGED", mergeCommit: { oid: RELEASE_SHA }, isCrossRepository: false, headRefName: "feat/x", baseRefName: "main" });
		if (args[0] === "pr" && args[1] === "view") return JSON.stringify({ state: "OPEN", baseRefName: "main", headRefName: "feat/x", headRefOid: STUB.head, isCrossRepository: false });
		return JSON.stringify([{ number: 12, mergeCommit: { oid: RELEASE_SHA }, isCrossRepository: false, headRefName: "feat/x", baseRefName: args[args.indexOf("--base") + 1] }]);
	};
	cp.spawnSync = (file: string, args: string[], opts: unknown) => (file === "git" && args[0] === "ls-remote" ? { status: 2, signal: null, error: undefined, stdout: "", stderr: "" } : originalSpawn(file, args, opts));
	syncBuiltinESMExports();
}
const GITHUB_ORIGIN = "https://github.com/example-owner/example-repo.git";
const MOVED_ORIGIN = "https://github.com/example-owner/moved-repo.git";
const LOCAL_ORIGIN = path.join(root, "absent-origin.git");
const CREATE_PR = 'gh pr create --repo example-owner/example-repo --base main --head feat/x --title "Release 1"';
const MAIN_RM = "rm -rf probe-absent-dir";
const REL = { action: "release", branch: "feat/x", base: "main", pr: 12, sha: RELEASE_SHA, version: "v1.2.3" };
const REQ = { tool: "request_authorization", args: { delivery: REL } };
const MERGE_OP = ["gh", "pr", "mer" + "ge", `12 --repo example-owner/example-repo --squash --match-head-commit ${RELEASE_SHA}`].join(" ");
const RELEASE_OP = ["gh", "rele" + "ase", "cre" + "ate", "v1.2.3 --repo example-owner/example-repo"].join(" ");

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


// Mandatory fingerprint binding of a merge approval through the real request_authorization tool: dialog content, reuse only on an equal live state, change-during-dialog refusal.
function boundRepo(): { dir: string; repoDir: string } {
	const dir = fs.mkdtempSync(path.join(scratchBase, "delivery-bound-"));
	const repoDir = path.join(dir, "project");
	makeRepo(repoDir, GITHUB_ORIGIN);
	const run = spawnSync("git", ["checkout", "-q", "feat/x"], { cwd: repoDir, windowsHide: true });
	assert.equal(run.status, 0, String(run.stderr));
	// openMain writes this same untracked file into the project; create it first so the reviewed fingerprint already includes it.
	fs.writeFileSync(path.join(repoDir, ".env"), `FIXTURE=${MAIN_SENTINEL}
`);
	return { dir, repoDir };
}
// Merge request for the repo's current state (expect = the fingerprint the operator reviewed).
function mergeReq(repoDir: string, id: string, over: Record<string, unknown> = {}) {
	const state = bindDelivery(repoDir, "feat/x", {});
	STUB.head = state.head;
	return { tool: "request_authorization", args: { delivery: { action: "merge", branch: "feat/x", base: "main", pr: 12, sha: state.head, bind: { expect: state.fingerprint }, ...over } }, id };
}

// ---- cleanup fixtures: a disposable primary with real linked worktrees; gh in the child is a renamed node binary answering from FAKE_GH_VIEW ----
const CPROJ = fwd(path.join(root, "cproj"));
const CPRIMARY = fwd(makeRepo(`${CPROJ}/pi`, GITHUB_ORIGIN));
const CWT = `${CPROJ}/worktrees/pi`;
fs.mkdirSync(CWT, { recursive: true });
let taskNo = 0;
function cleanupTask() {
	const name = `ctask-${++taskNo}`;
	const dir = `${CWT}/${name}`;
	const branch = `feat/${name}`;
	const add = spawnSync("git", ["worktree", "add", "-q", "-b", branch, dir], { cwd: CPRIMARY, encoding: "utf8", windowsHide: true });
	assert.equal(add.status, 0, add.stderr);
	const real = fwd(canonicalCwd(dir));
	const head = spawnSync("git", ["rev-parse", "HEAD"], { cwd: real, encoding: "utf8", windowsHide: true }).stdout.trim();
	return { dir: real, branch, head, evidence: `${CWT}/_evidence/${name}` };
}
const MERGE_C = "fedcba9876543210fedcba9876543210fedcba98";
const viewOf = (t: { branch: string; head: string }, over: Record<string, unknown> = {}) => JSON.stringify({ number: 12, state: "MERGED", baseRefName: "main", headRefName: t.branch, headRefOid: t.head, isCrossRepository: false, mergeCommit: { oid: MERGE_C }, ...over });
const FAKE_BIN = path.join(root, "fakebin");
const FAKE_STUB = fwd(path.join(root, "fake-gh.cjs"));
fs.mkdirSync(FAKE_BIN, { recursive: true });
fs.writeFileSync(FAKE_STUB, `const b = require("node:path").basename(process.execPath).toLowerCase().replace(/\\.exe$/, "");\nif (b === "gh") { process.stdout.write(process.env.FAKE_GH_VIEW || "{}"); process.exit(0); }\n`);
const FAKE_GH = path.join(FAKE_BIN, process.platform === "win32" ? "gh.exe" : "gh");
try { fs.linkSync(process.execPath, FAKE_GH); } catch { fs.copyFileSync(process.execPath, FAKE_GH); }

function mintGrant(t: { dir: string; branch: string; head: string }) {
	const owners = new OwnerTracker();
	owners.begin({ workerId: "w1", role: "release-engineer", cwd: t.dir, jobId: "bg-1" });
	owners.end("w1");
	const live = { env: () => ({}), pushUrl: (c: string, b: string) => livePushUrl(c, b), ghJson: () => JSON.parse(viewOf(t)), tagStatus: () => 2 };
	const store = createGrantStore();
	const res = prepareCleanup({ checkout: t.dir, branch: t.branch, base: "main", pr: 12, headSha: t.head, mergeCommit: MERGE_C, quiescent: true }, { store, owners, live, primary: CPRIMARY, mainCwd: CPROJ, jobRunning: () => false });
	assert.equal(res.ok, true, JSON.stringify(res));
	return { store, grant: (res as any).grant };
}

async function runCleanupChild(script: Step[], opts: { grant?: any; view: string }): Promise<{ ends: ToolEnd[]; stderr: string }> {
	const scriptFile = path.join(root, `cscript-${Math.random().toString(36).slice(2)}.json`);
	fs.writeFileSync(scriptFile, JSON.stringify(script));
	const store = createGrantStore();
	if (opts.grant) store.addCleanupGrant(opts.grant);
	const guard = claimChildGuard(store, "release-engineer", canonicalCwd(CPRIMARY), guardFile, undefined, true, undefined, opts.grant?.id);
	const base = offlineEnv(process.env);
	const pathKey = Object.keys(base).find((k) => k.toUpperCase() === "PATH") ?? "PATH";
	const childEnv: NodeJS.ProcessEnv = { ...base, [pathKey]: `${FAKE_BIN}${path.delimiter}${base[pathKey] ?? ""}`, NODE_OPTIONS: `--require=${FAKE_STUB}`, FAKE_GH_VIEW: opts.view, PI_CODING_AGENT_DIR: agentDir, PROBE_SCRIPT: scriptFile };
	delete childEnv[CHILD_GRANT_ENV];
	const env = guard.childEnv(childEnv) as Record<string, string>;
	const proc = spawn(process.execPath, [piCli, "--mode", "rpc", "--no-session", "--no-extensions", "--no-mcp", "--no-skills", "--no-prompt-templates", "--offline", "--provider", "probe-faux", "--model", "probe-model", "--extension", fauxFile, "--extension", guard.entry], { cwd: CPRIMARY, env, stdio: ["pipe", "pipe", "pipe"] });
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
const GUARD_TEXT = /Blocked by harness safety guard/;
const REMOVE_CMD = (p: string) => `git worktree remove "${p}"`;

test("real child guard entry: the exact cleanup form reaches the shell once (decided by the guard, nothing removed); flags, other targets, artifact deletion and replay are blocked", { timeout: 240_000 }, async () => {
	installTripwire();
	fs.rmSync(TRIPWIRE_LOG, { force: true });
	const t = cleanupTask();
	const other = cleanupTask();
	fs.mkdirSync(t.evidence, { recursive: true });
	fs.writeFileSync(`${t.evidence}/keep.md`, "evidence\n");
	const { grant } = mintGrant(t);
	const script: Step[] = [
		{ tool: "bash", args: { command: `git worktree remove --force "${t.dir}"` }, id: "c1" },
		{ tool: "bash", args: { command: REMOVE_CMD(other.dir) }, id: "c2" },
		{ tool: "bash", args: { command: `rm -r "${t.evidence}"` }, id: "c3" },
		{ tool: "bash", args: { command: REMOVE_CMD(t.dir) }, id: "c4" },
		{ tool: "bash", args: { command: REMOVE_CMD(t.dir) }, id: "c5" },
		{ text: "done" },
	];
	const { ends, stderr } = await runCleanupChild(script, { grant, view: viewOf(t) });
	const log = tripwireLog();
	fs.rmSync(TRIPWIRE_LOG, { force: true });
	assert.equal(ends.length, 5, stderr);
	for (const i of [0, 1, 2, 4]) { assert.equal(ends[i].isError, true); assert.match(ends[i].text, GUARD_TEXT, `step ${i}`); }
	assert.doesNotMatch(ends[3].text, GUARD_TEXT, "the exact form passed the guard");
	assert.match(ends[3].text, /tripwire: blocked git/, "and reached the (tripwired) shell");
	assert.equal(log, `TRIPWIRE git [worktree] [remove] [${t.dir}]\n`, "exactly one shell execution: the exact form");
	assert.ok(fs.existsSync(t.dir) && fs.existsSync(other.dir) && fs.existsSync(`${t.evidence}/keep.md`), "no folder was touched");
});

test("real child guard entry: no cleanup record, or a merge that cannot be proven live, blocks even the exact form", { timeout: 240_000 }, async () => {
	installTripwire();
	fs.rmSync(TRIPWIRE_LOG, { force: true });
	const t = cleanupTask();
	const script = (id: string): Step[] => [{ tool: "bash", args: { command: REMOVE_CMD(t.dir) }, id }, { text: "done" }];
	const none = await runCleanupChild(script("n1"), { view: viewOf(t) });
	const open = await runCleanupChild(script("n2"), { grant: mintGrant(t).grant, view: viewOf(t, { state: "OPEN" }) });
	const unreadable = await runCleanupChild(script("n3"), { grant: mintGrant(t).grant, view: "{}" });
	const log = tripwireLog();
	fs.rmSync(TRIPWIRE_LOG, { force: true });
	for (const r of [none, open, unreadable]) { assert.equal(r.ends.length, 1, r.stderr); assert.match(r.ends[0].text, GUARD_TEXT); }
	assert.equal(log, "", "nothing reached the shell");
	assert.ok(fs.existsSync(t.dir));
});

test("real main session: cleanup refusals fail closed before any launch and a merged-PR delivery grant surfaces runtime CLEANUP_PENDING through subagent_control list", { timeout: 300_000 }, async () => {
	installTripwire();
	fs.rmSync(TRIPWIRE_LOG, { force: true });
	const t = cleanupTask();
	const { dir, repoDir } = boundRepo();
	const req = mergeReq(repoDir, "q1");
	const ask = (agent: string, extra: Record<string, unknown>, id: string): SdkStep => ({ tool: "subagent", id, args: { agent, task: "cleanup", background: false, cwd: CPRIMARY, cleanup: { checkout: t.dir, branch: t.branch, base: "main", pr: 12, headSha: t.head, mergeCommit: MERGE_C, quiescent: true }, ...extra } });
	const s = await openMain([
		req,
		{ tool: "subagent_control", args: { action: "list" }, id: "q2" },
		{ tool: "subagent", id: "q3", args: { chain: [{ agent: "release-engineer", task: "x", cwd: CPRIMARY }], background: false, cleanup: { checkout: t.dir, branch: t.branch, base: "main", pr: 12, headSha: t.head, mergeCommit: MERGE_C, quiescent: true } } },
		ask("general-worker", {}, "q4"),
		ask("release-engineer", {}, "q5"),
		ask("release-engineer", { cwd: t.dir }, "q6"),
		ask("release-engineer", { cleanup: { checkout: t.dir, quiescent: true } }, "q7"),
		{ text: "done" },
	], { ui: approve, origin: GITHUB_ORIGIN, dir });
	try {
		const r = await s.run();
		assert.equal(r[0].isError, false, r[0].text);
		assert.match(r[1].text, /^\[\]/, "the job list stays a JSON array first");
		assert.match(r[1].text, /CLEANUP_PENDING \(runtime-verified/);
		assert.match(r[1].text, /"state":"RETAINED"/);
		assert.match(r[1].text, /no known owner/, "a merged PR alone is not enough: unknown ownership retains");
		assert.doesNotMatch(r[1].text, /"state":"READY"/);
		assert.match(r[1].text, /never deleted automatically/, "artifact folders are reported RETAINED");
		for (const [i, why] of [[2, /single-mode launch of the trusted release-engineer/], [3, /single-mode launch of the trusted release-engineer/], [4, /no known owner/], [5, /cwd|primary|worktrees/]] as const) {
			assert.equal(r[i].isError, true, `q${i + 1}: ${r[i].text}`);
			assert.match(r[i].text, /^Invalid cleanup:/, `q${i + 1}`);
			assert.match(r[i].text, why, `q${i + 1}`);
			assert.match(r[i].text, /nothing was launched/);
		}
		assert.equal(r[6].isError, true);
		assert.match(r[6].text, /Validation failed[\s\S]*cleanup/, "a malformed request never reaches the mint: the strict schema refuses it");
		assert.equal(s.unchanged(), true);
		assert.equal(tripwireLog(), "");
		assert.ok(fs.existsSync(t.dir));
	} finally { s.cleanup(); fs.rmSync(dir, { recursive: true, force: true }); }
});
