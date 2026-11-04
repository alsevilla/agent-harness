// Production dispatch chain of the opt-in delivery lifecycle (Node-only, *.node.ts runtime suite):
//   node --experimental-transform-types --test agent/extensions/subagent/tests/lifecycle-dispatch-runtime.node.ts
// The REAL registered request_authorization / subagent tools of index.ts run with the real background runtime, owner tracker, grant store and claim; the parent's after-child-close callback (finishLifecycle) runs for real.
// Only the host package, typebox/pi-ai stubs, the provider-cooldown entry and the child process factory are doubled (same seams as cleanup-dispatch-runtime.node.ts): the child is an offline fake, gh and git ls-remote are answered in-process. No SDK session, provider, helper or network.
import assert from "node:assert/strict";
import cpDefault, { spawnSync } from "node:child_process";
import * as nodeCrypto from "node:crypto";
import * as fs from "node:fs";
import { registerHooks, syncBuiltinESMExports } from "node:module";
import * as os from "node:os";
import * as path from "node:path";
import test, { after, before } from "node:test";
import { pathToFileURL } from "node:url";
import { hostModules } from "./host-modules.ts";
import { bindDelivery, canonicalCwd } from "../safety-core.ts";

const indexUrl = new URL("../index.ts", import.meta.url).href;
const doublesUrl = new URL("./fixtures/runtime-doubles.mjs", import.meta.url).href;
const monitorModuleUrl = new URL("../monitor.ts", import.meta.url).href;
const dataUrl = (source: string) => "data:text/javascript," + encodeURIComponent(source);
const childUrl = dataUrl(`import { EventEmitter } from "node:events";
export function spawn(_command, args, options) {
	const child = new EventEmitter();
	child.args = args; child.cwd = options.cwd; child.env = options.env; child.signals = []; child.exited = false;
	child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
	child.exitCode = null; child.signalCode = null;
	child.emitLine = (event) => child.stdout.emit("data", JSON.stringify(event) + "\\n");
	child.exit = (code) => { if (child.exited) return; child.exited = true; child.exitCode = code; child.emit("close", code); };
	child.kill = (signal = "SIGTERM") => { child.signals.push(signal); child.signalCode = signal; };
	child.stdin = options.stdio[0] === "pipe" ? { writable: true, on() {}, end() {}, write(chunk, callback) {
		const message = JSON.parse(String(chunk));
		if (message.type === "prompt") child.emitLine({ type: "response", id: message.id, success: true });
		callback?.(null); return true;
	} } : null;
	queueMicrotask(() => child.emit("spawn"));
	globalThis.__piLifeChildren.push(child);
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
(globalThis as { __piLifeChildren?: Child[] }).__piLifeChildren = [];
const children = (): Child[] => (globalThis as { __piLifeChildren: Child[] }).__piLifeChildren;

const scratchBase = process.env.DELIVERY_TEST_SCRATCH ?? os.tmpdir();
const root = fs.realpathSync.native(fs.mkdtempSync(path.join(scratchBase, "lifecycle-dispatch-")));
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
fs.writeFileSync(`${PRIMARY}/.gitignore`, "docs/knowledge/local/\n");
git(PRIMARY, "add", "-A");
git(PRIMARY, "commit", "-q", "-m", "init");
git(PRIMARY, "remote", "add", "origin", GITHUB_ORIGIN);
const LEARN_DIR = `${PRIMARY}/docs/knowledge/local/harness`;
fs.mkdirSync(LEARN_DIR, { recursive: true });
fs.mkdirSync(WT, { recursive: true });
let taskNo = 0;
function makeTask() {
	const name = `ltask-${++taskNo}`;
	const dir = `${WT}/${name}`;
	const branch = `feat/${name}`;
	git(PRIMARY, "worktree", "add", "-q", "-b", branch, dir);
	const evidence = `${WT}/_evidence/${name}`;
	const scratch = `${WT}/_scratch/${name}`;
	for (const d of [evidence, scratch]) fs.mkdirSync(d, { recursive: true });
	fs.writeFileSync(`${evidence}/REPORT.md`, "report\n");
	fs.writeFileSync(`${scratch}/log.txt`, "log\n");
	const real = fwd(canonicalCwd(dir));
	return { name, dir: real, branch, head: git(real, "rev-parse", "HEAD"), evidence, scratch };
}
type Task = ReturnType<typeof makeTask>;
let lessons = 0;
function learn() {
	const n = ++lessons;
	const record = `${LEARN_DIR}/lesson-${n}.md`;
	const index = `${LEARN_DIR}/README.md`;
	fs.writeFileSync(record, `# Lesson ${n}\n`);
	fs.writeFileSync(index, `- [lesson](lesson-${n}.md)\n`);
	const sha = (f: string) => nodeCrypto.createHash("sha256").update(fs.readFileSync(f)).digest("hex");
	return { state: "SAVED", record, index, recordSha256: sha(record), indexSha256: sha(index) };
}

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
	try { if (root.startsWith(fs.realpathSync.native(scratchBase)) && path.basename(root).startsWith("lifecycle-dispatch-")) fs.rmSync(root, { recursive: true, force: true }); } catch { /* retained */ }
});

function fakeHost() {
	const tools = new Map<string, { execute: (...args: unknown[]) => Promise<any> }>();
	const commands = new Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>();
	const handlers = new Map<string, Array<(...args: unknown[]) => unknown>>();
	const sent: Array<{ content: string; customType?: string }> = [];
	return { tools, sent, commands, handlers, getCommands: () => [], on(name: string, fn: (...args: unknown[]) => unknown) { handlers.set(name, [...(handlers.get(name) ?? []), fn]); }, registerCommand(name: string, spec: { handler: (args: string, ctx: unknown) => Promise<void> }) { commands.set(name, spec); }, registerTool(tool: { name: string }) { tools.set(tool.name, tool as never); }, registerShortcut() {}, sendMessage(message: { content: string }) { sent.push(message); return Promise.resolve(); } };
}
const dialogs: Array<{ title: string; message: string }> = [];
const answer = { value: true };
const ctx = { cwd: PROJ, hasUI: true, mode: "tui", ui: { confirm: async (title: string, message: string) => { dialogs.push({ title, message }); return answer.value; }, notify() {}, setWidget() {}, setStatus() {} }, isProjectTrusted: () => true, model: undefined, thinkingLevel: undefined };
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(predicate: () => boolean, message: string) {
	for (let i = 0; i < 500 && !predicate(); i++) await sleep(4);
	assert.ok(predicate(), message);
}
const text = (r: any) => (r?.content ?? []).map((c: any) => c.text ?? "").join("\n");
const usage = { input: 1, output: 1, totalTokens: 2, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } };
const finish = (child: Child, code = 0) => { child.emitLine({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "done" }], stopReason: "stop", usage } }); child.exit(code); };
const exists = (p: string) => fs.existsSync(p);
const lifecycleMessages = (host: ReturnType<typeof fakeHost>) => host.sent.filter((m) => m.customType === "subagent-lifecycle");

// Session with a (scoped or unscoped) merge approval minted through the real dialog path and a terminal release-engineer delivery owner.
async function session(scoped: boolean) {
	const host = fakeHost();
	subagentExtension(host);
	const t = makeTask();
	GH.branch = t.branch; GH.head = t.head; GH.merged = false;
	const state = bindDelivery(t.dir, t.branch, {});
	const delivery = { action: "merge", branch: t.branch, base: "main", pr: 12, sha: state.head, cwd: t.dir, bind: { expect: state.fingerprint }, ...(scoped ? { disposal: { checkout: t.dir, evidence: t.evidence, scratch: t.scratch } } : {}) };
	dialogs.length = 0;
	answer.value = true;
	const granted = await host.tools.get("request_authorization")!.execute("auth", { delivery }, undefined, undefined, ctx);
	const before = children().length;
	const owner = host.tools.get("subagent")!.execute("own", { agent: "release-engineer", task: "deliver", cwd: t.dir, background: false }, undefined, undefined, ctx);
	await waitFor(() => children().length === before + 1, "delivery owner child spawns");
	finish(children()[before]);
	await owner;
	GH.merged = true;
	const request = (lifecycle?: unknown) => ({ checkout: t.dir, branch: t.branch, base: "main", pr: 12, headSha: t.head, mergeCommit: MERGE_C, quiescent: true, ...(lifecycle === undefined ? {} : { lifecycle }) });
	const launch = (lifecycle: unknown = { action: "merge", learn: learn() }, extra: Record<string, unknown> = {}, signal?: AbortSignal) => host.tools.get("subagent")!.execute("clean", { agent: "release-engineer", task: "cleanup", cwd: PRIMARY, cleanup: request(lifecycle), ...extra }, signal, undefined, ctx);
	const writer = (cwd: string) => host.tools.get("subagent")!.execute("w", { agent: "general-worker", task: "write", cwd, background: false }, undefined, undefined, ctx).then((r: any) => /cleanup is pending|already pending|lifecycle for this task/.test(text(r)) || r.isError === true, (error: Error) => /cleanup is pending|already pending/.test(error.message));
	return { host, t, granted, launch, writer };
}
const receipts = (t: Task) => (exists(`${WT}/_receipts/${t.name}`) ? fs.readdirSync(`${WT}/_receipts/${t.name}`) : []);
const settle = async (host: ReturnType<typeof fakeHost>, event: Record<string, unknown>) => { for (const fn of host.handlers.get(event.type === "start" ? "session_start" : "agent_settled") ?? []) await fn(event.type === "start" ? {} : event, ctx); };

test("public dialog: the disposal approval shows the exact three paths in the same dialog; cancel and an unscoped approval are not authority", { timeout: 60_000 }, async () => {
	const s = await session(true);
	assert.notEqual(s.granted.isError, true, text(s.granted));
	assert.equal(dialogs.length, 1, "one dialog");
	const m = dialogs[0].message;
	assert.match(m, /DISPOSAL \(explicit opt-in, this dialog only\)/);
	for (const p of [s.t.dir, s.t.scratch, s.t.evidence]) assert.ok(m.includes(`${p}\n`) || m.includes(`${p} `), `dialog lists ${p}`);
	assert.match(m, /RETAINED|uncertain/);
	// Operator cancels the disposal dialog: no grant, so the lifecycle mint is refused and nothing is removed.
	const host = fakeHost();
	subagentExtension(host);
	const t = makeTask();
	GH.branch = t.branch; GH.head = t.head; GH.merged = false;
	const state = bindDelivery(t.dir, t.branch, {});
	answer.value = false;
	const denied = await host.tools.get("request_authorization")!.execute("auth", { delivery: { action: "merge", branch: t.branch, base: "main", pr: 12, sha: state.head, cwd: t.dir, bind: { expect: state.fingerprint }, disposal: { checkout: t.dir, evidence: t.evidence, scratch: t.scratch } } }, undefined, undefined, ctx);
	answer.value = true;
	assert.equal(denied.isError, true);
	assert.match(text(denied), /Not authorized/);
	GH.merged = true;
	const before = children().length;
	const refused = await host.tools.get("subagent")!.execute("clean", { agent: "release-engineer", task: "cleanup", cwd: PRIMARY, cleanup: { checkout: t.dir, branch: t.branch, base: "main", pr: 12, headSha: t.head, mergeCommit: MERGE_C, quiescent: true, lifecycle: { action: "merge", learn: learn() } } }, undefined, undefined, ctx);
	assert.equal(refused.isError, true);
	assert.equal(children().length, before, "nothing launched");
	assert.ok(exists(t.dir) && exists(t.evidence) && exists(t.scratch));
	assert.deepEqual(receipts(t), []);
	// An unscoped approval (no disposal block) is also no consent.
	const u = await session(false);
	assert.doesNotMatch(dialogs[0].message, /DISPOSAL \(/);
	const r = await u.launch();
	assert.equal(r.isError, true);
	assert.match(text(r), /no explicit disposal approval/);
	assert.deepEqual(receipts(u.t), []);
});

test("clean close: intent receipt precedes the child, the artifacts survive until the confirmed close, then the real after-close callback removes scratch and evidence and reports once; consent is single-use", { timeout: 60_000 }, async () => {
	const s = await session(true);
	const base = children().length;
	const started = await s.launch();
	assert.match(text(started), /Started background job/, text(started));
	await waitFor(() => children().length === base + 1, "cleanup child spawns");
	const child = children()[base];
	assert.deepEqual(receipts(s.t).map((f) => f.replace(/-[0-9a-f-]+\.json$/, "")), ["intent"], "intent receipt written before the child runs; no final receipt");
	assert.ok(exists(s.t.scratch) && exists(s.t.evidence), "nothing removed while the child lives");
	assert.equal(await s.writer(s.t.evidence), true, "the artifact folder is reserved while the claimed child lives");
	assert.equal(lifecycleMessages(s.host).length, 0);
	git(PRIMARY, "worktree", "remove", s.t.dir); // stands in for the child's own permitted checkout removal
	finish(child, 0);
	await waitFor(() => lifecycleMessages(s.host).length === 1, "the runtime reports the lifecycle outcome after the confirmed close");
	assert.match(lifecycleMessages(s.host)[0].content, /LIFECYCLE COMPLETE/);
	assert.ok(!exists(s.t.scratch) && !exists(s.t.evidence) && !exists(s.t.dir));
	assert.deepEqual(receipts(s.t).map((f) => f.replace(/-[0-9a-f-]+\.json$/, "")).sort(), ["final", "intent"]);
	assert.ok(git(PRIMARY, "branch", "--list", s.t.branch).includes(s.t.branch), "branch kept");
	const again = await s.launch();
	assert.equal(again.isError, true, "the consent was consumed by the first mint");
	assert.equal(lifecycleMessages(s.host).length, 1, "no second report");
});

test("unclean child exit: the runtime retains every target (no deletion) and says so", { timeout: 60_000 }, async () => {
	const s = await session(true);
	const base = children().length;
	await s.launch();
	await waitFor(() => children().length === base + 1, "cleanup child spawns");
	git(PRIMARY, "worktree", "remove", s.t.dir);
	children()[base].exit(1);
	await waitFor(() => lifecycleMessages(s.host).length === 1, "retained outcome reported");
	assert.match(lifecycleMessages(s.host)[0].content, /LIFECYCLE RETAINED/);
	assert.ok(exists(s.t.scratch) && exists(s.t.evidence), "artifacts untouched");
	assert.ok(!receipts(s.t).some((f) => f.startsWith("final-") && /COMPLETE/.test(fs.readFileSync(`${WT}/_receipts/${s.t.name}/${f}`, "utf8"))));
});

for (const stopReason of ["length", "error", "aborted"]) {
	test(`exit 0 with stopReason ${stopReason} after the checkout is gone: artifacts are retained, never reported COMPLETE, and the gone checkout is not claimed retained`, { timeout: 60_000 }, async () => {
		const s = await session(true);
		const base = children().length;
		await s.launch();
		await waitFor(() => children().length === base + 1, "cleanup child spawns");
		git(PRIMARY, "worktree", "remove", s.t.dir);
		children()[base].emitLine({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "partial" }], stopReason, usage } });
		children()[base].exit(0);
		await waitFor(() => lifecycleMessages(s.host).length === 1, "retained outcome reported");
		const report = lifecycleMessages(s.host)[0].content;
		assert.match(report, /LIFECYCLE RETAINED/);
		assert.match(report, /checkout: REMOVED \(already gone/, "a removed checkout is reported as removed");
		assert.match(report, /scratch: RETAINED[^;]*did not close successfully/);
		assert.ok(exists(s.t.scratch) && exists(s.t.evidence), "artifacts untouched");
		assert.ok(!exists(s.t.dir));
		const finals = receipts(s.t).filter((f) => f.startsWith("final-"));
		assert.equal(finals.length, 1);
		assert.doesNotMatch(fs.readFileSync(`${WT}/_receipts/${s.t.name}/${finals[0]}`, "utf8"), /COMPLETE/);
	});
}

test("abort before the claim, and a session restart while the child lives, lose the plan: everything is retained, nothing is removed, no outcome is reported", { timeout: 60_000 }, async () => {
	const a = await session(true);
	const base = children().length;
	const abort = new AbortController();
	abort.abort();
	await a.launch(undefined, { background: false }, abort.signal).catch(() => undefined);
	assert.equal(children().length, base, "an abort before the spawn launches nothing");
	await settle(a.host, { aborted: true });
	assert.ok(exists(a.t.dir) && exists(a.t.scratch) && exists(a.t.evidence));
	assert.equal(lifecycleMessages(a.host).length, 0);
	assert.equal((await a.launch()).isError, true, "the consent was consumed with the dropped plan: no silent retry");
	// restart while the claimed child lives
	const b = await session(true);
	const base2 = children().length;
	await b.launch();
	await waitFor(() => children().length === base2 + 1, "cleanup child spawns");
	await settle(b.host, { type: "start" });
	git(PRIMARY, "worktree", "remove", b.t.dir);
	children()[base2].exit(0);
	await sleep(80);
	assert.equal(lifecycleMessages(b.host).length, 0, "the dropped plan reports nothing");
	assert.ok(exists(b.t.scratch) && exists(b.t.evidence), "artifacts retained");
	assert.ok(!receipts(b.t).some((f) => f.startsWith("final-")));
});
