// Production dispatch chain of the narrow post-merge checkout cleanup (Node-only: registerHooks + native TS; *.node.ts runtime suite):
//   node --experimental-transform-types --test agent/extensions/subagent/tests/cleanup-dispatch-runtime.node.ts
// The REAL registered subagent / request_authorization / subagent_control tools of index.ts run with the real background runtime, owner tracker, grant store and child guard claim. Only the host package, typebox/pi-ai stubs,
// the provider-cooldown entry and the child process factory are doubled; the child is an offline fake that records its env, cwd and signals, so nothing reaches a provider, GitHub or a real removal. gh is answered in-process (MERGED/OPEN, fake).
import assert from "node:assert/strict";
import cpDefault, { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import { registerHooks, syncBuiltinESMExports } from "node:module";
import * as os from "node:os";
import * as path from "node:path";
import test, { after, before } from "node:test";
import { pathToFileURL } from "node:url";
import { hostModules } from "./host-modules.ts";
import { bindDelivery, canonicalCwd, CHILD_GRANT_ENV } from "../safety-core.ts";

const indexUrl = new URL("../index.ts", import.meta.url).href;
const doublesUrl = new URL("./fixtures/runtime-doubles.mjs", import.meta.url).href;
const monitorModuleUrl = new URL("../monitor.ts", import.meta.url).href;
const dataUrl = (source: string) => "data:text/javascript," + encodeURIComponent(source);
const childUrl = dataUrl(`import { EventEmitter } from "node:events";
export function spawn(_command, args, options) {
	const child = new EventEmitter();
	child.args = args; child.cwd = options.cwd; child.env = options.env; child.signals = []; child.exited = false; child.received = [];
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
	globalThis.__piCleanupChildren.push(child);
	return child;
}`);
const entryStubUrl = dataUrl("export default function providerCooldownEntry() {}\nexport function registerProviderCooldown() {}\nexport async function runProviderCooldownCommand() { return { message: '', type: 'info' }; }\nexport async function providerLaunchState() { return { state: 'launch' }; }\nexport async function guardRefusalReplayable() { return false; }");
const indexDependencies = new Set(["@earendil-works/pi-ai", "./code-integrations.ts", "./build-env.ts"]);
const INSTALL_MODULES = hostModules(["@earendil-works/pi-ai", "typebox"]);
const typeboxUrl = pathToFileURL(`${INSTALL_MODULES}/typebox/build/index.mjs`).href;

registerHooks({
	resolve(specifier, context, nextResolve) {
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
});

interface Child { args: string[]; env?: Record<string, string | undefined>; cwd: string; signals: string[]; exited: boolean; emitLine(event: Record<string, unknown>): void; exit(code: number | null): void }
(globalThis as { __piCleanupChildren?: Child[] }).__piCleanupChildren = [];
const children = (): Child[] => (globalThis as { __piCleanupChildren: Child[] }).__piCleanupChildren;

const scratchBase = process.env.DELIVERY_TEST_SCRATCH ?? os.tmpdir();
const root = fs.realpathSync.native(fs.mkdtempSync(path.join(scratchBase, "cleanup-dispatch-")));
const GIT_CFG = path.join(root, "gitconfig");
fs.writeFileSync(GIT_CFG, "");
process.env.GIT_CONFIG_GLOBAL = GIT_CFG;
process.env.GIT_CONFIG_NOSYSTEM = "1";
const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
const userDir = path.join(root, "user");
process.env.PI_CODING_AGENT_DIR = userDir;
fs.mkdirSync(path.join(userDir, "agents"), { recursive: true });
for (const name of ["release-engineer", "general-worker"]) fs.writeFileSync(path.join(userDir, "agents", `${name}.md`), `---\nname: ${name}\ndescription: ${name}\n---\n`);

const fwd = (p: string) => p.replace(/\\/g, "/");
const GITHUB_ORIGIN = "https://github.com/example-owner/example-repo.git";
const MERGE_C = "fedcba9876543210fedcba9876543210fedcba98";
const PROJ = fwd(path.join(root, "proj"));
const PRIMARY = `${PROJ}/pi`;
const WT = `${PROJ}/worktrees/pi`;
const git = (dir: string, ...args: string[]) => {
	const run = spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.test", ...args], { cwd: dir, encoding: "utf8", windowsHide: true });
	assert.equal(run.status, 0, `git ${args.join(" ")}: ${run.stderr}`);
	return run.stdout.trim();
};
fs.mkdirSync(PRIMARY, { recursive: true });
git(PRIMARY, "init", "-q", "-b", "main");
fs.writeFileSync(`${PRIMARY}/a.txt`, "a\n");
git(PRIMARY, "add", "-A");
git(PRIMARY, "commit", "-q", "-m", "init");
git(PRIMARY, "remote", "add", "origin", GITHUB_ORIGIN);
fs.mkdirSync(WT, { recursive: true });
let taskNo = 0;
function makeTask() {
	const name = `dtask-${++taskNo}`;
	const dir = `${WT}/${name}`;
	const branch = `feat/${name}`;
	git(PRIMARY, "worktree", "add", "-q", "-b", branch, dir);
	const real = fwd(canonicalCwd(dir));
	return { dir: real, branch, head: git(real, "rev-parse", "HEAD") };
}

// gh is answered in-process, controlled per test. Everything else (git) is real.
const GH = { branch: "", head: "", merged: false };
{
	const cp = cpDefault as any;
	const originalExec = cp.execFileSync;
	const originalSpawn = cp.spawnSync;
	cp.execFileSync = (file: string, args: string[], opts: unknown) => {
		if (file !== "gh") return originalExec(file, args, opts);
		if (args[0] === "pr" && args[1] === "view") return JSON.stringify({ number: Number(args[2]), state: GH.merged ? "MERGED" : "OPEN", baseRefName: "main", headRefName: GH.branch, headRefOid: GH.head, isCrossRepository: false, mergeCommit: { oid: MERGE_C } });
		return JSON.stringify([]);
	};
	cp.spawnSync = (file: string, args: string[], opts: unknown) => (file === "git" && args[0] === "ls-remote" ? { status: 2, signal: null, error: undefined, stdout: "", stderr: "" } : originalSpawn(file, args, opts));
	syncBuiltinESMExports();
}

let subagentExtension: any;
before(async () => { subagentExtension = (await import(indexUrl)).default; });
after(() => {
	if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
});

function fakeHost() {
	const tools = new Map<string, { execute: (...args: unknown[]) => Promise<any> }>();
	const commands = new Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>();
	const handlers = new Map<string, Array<(...args: unknown[]) => unknown>>();
	const sent: Array<{ content: string; customType?: string }> = [];
	return { tools, sent, commands, handlers, getCommands: () => [], on(name: string, fn: (...args: unknown[]) => unknown) { handlers.set(name, [...(handlers.get(name) ?? []), fn]); }, registerCommand(name: string, spec: { handler: (args: string, ctx: unknown) => Promise<void> }) { commands.set(name, spec); }, registerTool(tool: { name: string }) { tools.set(tool.name, tool as never); }, registerShortcut() {}, sendMessage(message: { content: string }) { sent.push(message); return Promise.resolve(); } };
}
const ctx = { cwd: PROJ, hasUI: true, mode: "tui", ui: { confirm: async () => true, notify() {} }, isProjectTrusted: () => true, model: undefined, thinkingLevel: undefined };
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(predicate: () => boolean, message: string) {
	for (let i = 0; i < 500 && !predicate(); i++) await sleep(4);
	assert.ok(predicate(), message);
}
const text = (r: any) => (r?.content ?? []).map((c: any) => c.text ?? "").join("\n");
const usage = { input: 1, output: 1, totalTokens: 2, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } };
const finish = (child: Child, code = 0) => { child.emitLine({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "done" }], stopReason: "stop", usage } }); child.exit(code); };

// Session with a merged-PR delivery grant minted through the real request_authorization tool and a terminal tracked release-engineer owner (a real foreground delivery child that has closed).
async function readySession() {
	const host = fakeHost();
	subagentExtension(host);
	const t = makeTask();
	GH.branch = t.branch; GH.head = t.head; GH.merged = false;
	const state = bindDelivery(t.dir, t.branch, {});
	const granted = await host.tools.get("request_authorization")!.execute("auth", { delivery: { action: "merge", branch: t.branch, base: "main", pr: 12, sha: state.head, cwd: t.dir, bind: { expect: state.fingerprint } } }, undefined, undefined, ctx);
	assert.notEqual(granted.isError, true, text(granted));
	const before = children().length;
	const delivery = host.tools.get("subagent")!.execute("own", { agent: "release-engineer", task: "deliver", cwd: t.dir, background: false }, undefined, undefined, ctx);
	await waitFor(() => children().length === before + 1, "delivery owner child spawns");
	finish(children()[before]);
	await delivery;
	GH.merged = true;
	const list = text(await host.tools.get("subagent_control")!.execute("list", { action: "list" }));
	const line = list.split("\n").find((l) => l.startsWith("{") && l.includes('"READY"') && l.includes(t.dir));
	assert.ok(line, `READY pending entry expected: ${list}`);
	const entry = JSON.parse(line!);
	return { host, t, entry, request: { ...entry.request, quiescent: true }, launch: (extra: Record<string, unknown> = {}) => host.tools.get("subagent")!.execute("clean", { agent: "release-engineer", task: "cleanup", cwd: entry.launchCwd, cleanup: { ...entry.request, quiescent: true }, ...extra }, undefined, undefined, ctx) };
}
const writerInTarget = (host: ReturnType<typeof fakeHost>, dir: string) => host.tools.get("subagent")!.execute("w", { agent: "general-worker", task: "write", cwd: dir, background: false }, undefined, undefined, ctx).then((r: any) => ({ refused: r.isError === true || /cleanup is pending/.test(text(r)), text: text(r) }), (error: Error) => ({ refused: /cleanup is pending/.test(error.message), text: error.message }));

test("F4 production chain: real tracked delivery owner, live MERGED pending READY, outside-target default-background cleanup launch carries exactly the claimed scope (cleanupId forwarded); replay, other roles and lifecycle", { timeout: 60_000 }, async () => {
	const s = await readySession();
	const base = children().length;
	const other = await s.host.tools.get("subagent")!.execute("x", { agent: "general-worker", task: "cleanup", cwd: s.entry.launchCwd, cleanup: s.request }, undefined, undefined, ctx);
	assert.equal(other.isError, true);
	assert.match(text(other), /trusted release-engineer/);
	assert.equal(children().length, base, "an untrusted role launches nothing");
	const started = await s.launch();
	assert.match(text(started), /Started background job/, text(started));
	await waitFor(() => children().length === base + 1, "cleanup child spawns");
	const child = children()[base];
	assert.equal(fwd(child.cwd), PRIMARY, "launched in the primary, outside the target");
	const envelope = JSON.parse(String(child.env?.[CHILD_GRANT_ENV]));
	assert.equal(envelope.cleanupActions?.length, 1, "exactly one claimed cleanup scope reaches the child (a missing cleanupId forward would leave none)");
	const scope = envelope.cleanupActions[0];
	assert.deepEqual({ candidate: scope.candidate, branch: scope.branch, base: scope.base, pr: scope.pr, headSha: scope.headSha, mergeCommit: scope.mergeCommit, role: scope.role }, { candidate: s.t.dir, branch: s.t.branch, base: "main", pr: 12, headSha: s.t.head, mergeCommit: MERGE_C, role: "release-engineer" });
	assert.equal(envelope.deliveryActions, undefined, "a cleanup launch never carries delivery grants");
	assert.ok(child.args.some((a) => a.endsWith("safety-guard-entry.ts")), "the child guard entry is loaded");
	// replay: while the claimed child lives, no second scope for the same checkout and no writer in it.
	const again = await s.launch();
	assert.equal(again.isError, true, text(again));
	assert.match(text(again), /already pending/);
	assert.equal((await writerInTarget(s.host, s.t.dir)).refused, true, "the reservation refuses an overlapping writer while the claimed child lives");
	assert.equal(children().length, base + 1);
	finish(child);
	await sleep(30);
	const writer = writerInTarget(s.host, s.t.dir);
	await waitFor(() => children().length === base + 2, "a clean confirmed child close releases the reservation: the writer is admitted");
	finish(children()[base + 1]);
	assert.equal((await writer).refused, false);
});

test("F3 post-claim abort: the live cleanup job is cancelled, the claimed reservation is NOT cleared, no overlapping writer is admitted, and an aborted close keeps the folder reserved until TTL", { timeout: 60_000 }, async () => {
	const s = await readySession();
	const base = children().length;
	await s.launch();
	await waitFor(() => children().length === base + 1, "cleanup child spawns and claims");
	const child = children()[base];
	assert.equal(JSON.parse(String(child.env?.[CHILD_GRANT_ENV])).cleanupActions.length, 1);
	for (const fn of s.host.handlers.get("agent_settled") ?? []) await fn({ aborted: true });
	await waitFor(() => child.signals.includes("SIGTERM"), "the existing job cancellation reaches the live child (SIGTERM)");
	assert.equal((await writerInTarget(s.host, s.t.dir)).refused, true, "the claimed reservation survives the aborted settle while the child is not confirmed closed");
	assert.equal(children().length, base + 1, "no writer was spawned");
	child.exit(null);
	await sleep(30);
	assert.equal((await writerInTarget(s.host, s.t.dir)).refused, true, "an aborted close retains the reservation until TTL: shell/grandchild state is unknown");
	assert.equal(children().length, base + 1);
	assert.ok(fs.existsSync(s.t.dir), "nothing was removed");
});

test("F3 unclaimed abort: scope revoked and reservation released; nothing launched", { timeout: 60_000 }, async () => {
	const s = await readySession();
	const base = children().length;
	const abort = new AbortController();
	abort.abort();
	await s.host.tools.get("subagent")!.execute("clean", { agent: "release-engineer", task: "cleanup", cwd: s.entry.launchCwd, background: false, cleanup: s.request }, abort.signal, undefined, ctx).catch(() => undefined);
	assert.equal(children().length, base, "an abort before the spawn launches nothing");
	assert.equal((await writerInTarget(s.host, s.t.dir)).refused, true, "an unclaimed scope still reserves its folder until the abort is observed");
	let status = "";
	await s.host.commands.get("authorization")!.handler("", { ui: { notify: (m: string) => { status = m; } } });
	assert.match(status, /cleanup scopes: 1/);
	for (const fn of s.host.handlers.get("agent_settled") ?? []) await fn({ aborted: true });
	await s.host.commands.get("authorization")!.handler("", { ui: { notify: (m: string) => { status = m; } } });
	assert.doesNotMatch(status, /cleanup scopes/, "revoked");
	const writer = writerInTarget(s.host, s.t.dir);
	await waitFor(() => children().length === base + 1, "the folder is free again");
	finish(children()[base]);
	assert.equal((await writer).refused, false);
});
