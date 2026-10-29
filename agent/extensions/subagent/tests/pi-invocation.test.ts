// Child launch resolution: the Pi CLI comes from the installed package metadata, never from an arbitrary argv[1].
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { registerHooks } from "node:module";
import { hostModules } from "./host-modules.ts";

// The real index.ts loads with the Pi package doubled (decision-relay.test.ts pattern); getPackageDir reads the fake installed package.
const doublesUrl = new URL("./fixtures/runtime-doubles.mjs", import.meta.url).href;
const dataModule = (source: string) => "data:text/javascript," + encodeURIComponent(source);
const piCodingAgentUrl = dataModule(`export * from ${JSON.stringify(doublesUrl)}; export function getPackageDir() { return globalThis.__piTestPackageDir; }`);
const indexUrl = new URL("../index.ts", import.meta.url).href;
const entryUrl = new URL("../provider-cooldown-entry.ts", import.meta.url).href;
const cooldownStubUrl = dataModule("export const anthropicMessagesApi = () => ({ streamSimple: () => { throw new Error(\"offline stub\"); } }); export const openAICodexResponsesApi = anthropicMessagesApi; export function createAssistantMessageEventStream() { throw new Error(\"offline stub\"); }");
const monitorUrl = dataModule("export class WorkerMonitor { constructor() { this.store = undefined; this.control = undefined; } }");
registerHooks({
	resolve(specifier: string, context: { parentURL?: string }, nextResolve: (s: string, c: object) => { url: string }) {
		if (specifier === "@earendil-works/pi-ai/compat" || (specifier === "@earendil-works/pi-ai" && context.parentURL === entryUrl)) return { url: cooldownStubUrl, shortCircuit: true };
		if (specifier === "@earendil-works/pi-coding-agent") return { url: piCodingAgentUrl, shortCircuit: true };
		if (specifier === "@earendil-works/pi-ai" || specifier === "typebox") return { url: doublesUrl, shortCircuit: true };
		if (specifier === "./monitor.ts" && context.parentURL === indexUrl) return { url: monitorUrl, shortCircuit: true };
		return nextResolve(specifier, context);
	},
} as never);
const { getPiInvocation } = await import(indexUrl);
const resolvePiInvocation = getPiInvocation as (args: string[], host: { argv1?: string; execPath: string; packageDir: string }) => { command: string; args: string[] };
// The installed-CLI path for a package: the launch of a plain Node host with no argv[1].
const piCliEntry = (packageDir: string) => resolvePiInvocation([], { execPath: NODE, packageDir }).args[0];

const NODE = process.execPath; // the running Node host (a node.exe/node executable)

// A fake installed Pi package: package.json bin.pi points at dist/bundle/cli.js, as the installed 1.4.0 package declares.
// null omits the bin key (a default parameter would swallow undefined).
function fakePackage(bin: string | null = "dist/bundle/cli.js", writeEntry = true) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-invocation-"));
	fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "@earendil-works/pi-coding-agent", ...(bin === null ? {} : { bin: { pi: bin } }) }));
	if (writeEntry && bin) {
		fs.mkdirSync(path.dirname(path.join(dir, bin)), { recursive: true });
		fs.writeFileSync(path.join(dir, bin), "// pi cli\n");
	}
	return dir;
}

// A non-Pi script that happens to be the host's argv[1] (for example the benchmark CLI in an SDK run).
function otherScript(name = "cli.mjs") {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "other-script-"));
	const file = path.join(dir, name);
	fs.writeFileSync(file, "// not pi\n");
	return file;
}

test("a non-Pi argv[1] that exists is never reused as the Pi CLI", () => {
	const pkg = fakePackage();
	const cli = path.join(pkg, "dist", "bundle", "cli.js");
	const argv1 = otherScript();
	const got = resolvePiInvocation(["--mode", "rpc"], { argv1, execPath: NODE, packageDir: pkg });
	assert.equal(got.command, NODE);
	assert.deepEqual(got.args, [cli, "--mode", "rpc"]);
	assert.ok(!got.args.includes(argv1), "the host script is not the child entry");
});

test("a same-named cli.js from a different package is not mistaken for the installed Pi CLI", () => {
	const pkg = fakePackage();
	const impostor = otherScript("cli.js");
	const got = resolvePiInvocation(["--mode", "rpc"], { argv1: impostor, execPath: NODE, packageDir: pkg });
	assert.deepEqual(got.args, [path.join(pkg, "dist", "bundle", "cli.js"), "--mode", "rpc"]);
});

test("the normal Pi host (argv[1] is the installed Pi CLI) keeps the same launch shape", () => {
	const pkg = fakePackage();
	const cli = path.join(pkg, "dist", "bundle", "cli.js");
	const got = resolvePiInvocation(["--mode", "rpc", "--no-session"], { argv1: cli, execPath: NODE, packageDir: pkg });
	assert.deepEqual(got, { command: NODE, args: [cli, "--mode", "rpc", "--no-session"] });
});

test("a compiled Pi executable hosts itself: execPath runs the child with the given args only", () => {
	const pkg = fakePackage();
	const exe = path.join("C:", "pi", "pi.exe");
	assert.deepEqual(resolvePiInvocation(["--mode", "rpc"], { argv1: "/$bunfs/root/pi", execPath: exe, packageDir: pkg }), { command: exe, args: ["--mode", "rpc"] });
});

// Compiled-Pi identity: Bun's virtual root in argv[1] (Pi's dist/config.js isBunBinary marker), verified by a bun --compile probe (B:/~BUN/root/<exe>).
test("a Bun-compiled Pi executable (~BUN virtual entry) hosts itself", () => {
	const pkg = fakePackage();
	const exe = path.join("C:", "pi", "pi.exe");
	assert.deepEqual(resolvePiInvocation(["--mode", "rpc"], { argv1: "B:/~BUN/root/pi.exe", execPath: exe, packageDir: pkg }), { command: exe, args: ["--mode", "rpc"] });
});

// Ordinary script paths and near-miss virtual roots that contain a marker fragment are not the compiled virtual entry (RED before the anchored predicate).
test("ordinary paths containing a marker fragment, and root/suffix near-misses, run the installed Pi CLI", () => {
	const pkg = fakePackage();
	const cli = path.join(pkg, "dist", "bundle", "cli.js");
	const hosts = [
		"C:\\work\\~BUN\\benchmark.mjs",
		"C:\\work\\$bunfs\\run.mjs",
		"C:/work/%7EBUN/benchmark.mjs",
		"/home/u/~BUN/benchmark.mjs",
		"/home/u/$bunfs/run.mjs",
		"C:/~BUN/root/pi.exe",
		"C:/~BUN/root/cli.mjs",
		"B:/x/~BUN/root/pi.exe",
		"B:/~BUN/root/sub/cli.mjs",
		"B:/~BUN/rootx/pi.exe",
		"B:/~BUN/root/",
		"B:/~BUN/root",
		"/home/u/$bunfs/root/pi",
		"/$bunfs/root/sub/cli.mjs",
	];
	for (const argv1 of hosts) {
		assert.deepEqual(resolvePiInvocation(["--mode", "rpc"], { argv1, execPath: NODE, packageDir: pkg }), { command: NODE, args: [cli, "--mode", "rpc"] }, argv1);
	}
});

// Non-compiled Bun or other non-Node hosts are not Pi itself: they run the installed package's declared CLI (RED before the fix).
test("a non-compiled Bun host runs the installed Pi CLI, not the Bun executable alone", () => {
	const pkg = fakePackage();
	const bun = path.join("C:", "bun", "bun.exe");
	assert.deepEqual(resolvePiInvocation(["--mode", "rpc"], { argv1: otherScript(), execPath: bun, packageDir: pkg }), { command: bun, args: [path.join(pkg, "dist", "bundle", "cli.js"), "--mode", "rpc"] });
});

test("a generic nodejs host with no argv[1] runs the installed Pi CLI", () => {
	const pkg = fakePackage();
	const runtime = path.join("C:", "tools", "nodejs", "nodejs.exe");
	assert.deepEqual(resolvePiInvocation(["x"], { argv1: undefined, execPath: runtime, packageDir: pkg }), { command: runtime, args: [path.join(pkg, "dist", "bundle", "cli.js"), "x"] });
});

// A basename alone is not proof: a pi.exe without the compiled virtual entry is not self-executed.
test("an executable named pi.exe without the compiled marker is not assumed to host itself", () => {
	const pkg = fakePackage();
	const exe = path.join("C:", "pi", "pi.exe");
	assert.deepEqual(resolvePiInvocation(["--mode", "rpc"], { argv1: otherScript(), execPath: exe, packageDir: pkg }), { command: exe, args: [path.join(pkg, "dist", "bundle", "cli.js"), "--mode", "rpc"] });
});

test("a Node host with no argv[1] resolves the installed Pi CLI", () => {
	const pkg = fakePackage();
	assert.deepEqual(resolvePiInvocation(["x"], { argv1: undefined, execPath: NODE, packageDir: pkg }).args, [path.join(pkg, "dist", "bundle", "cli.js"), "x"]);
});

test("a missing Pi CLI entry fails clearly; no PATH command is substituted", () => {
	const pkg = fakePackage("dist/bundle/cli.js", false);
	assert.throws(() => resolvePiInvocation(["--mode", "rpc"], { argv1: otherScript(), execPath: NODE, packageDir: pkg }), /Pi CLI entry missing.*reinstall/);
});

test("package metadata without a pi bin, or unreadable metadata, fails clearly", () => {
	assert.throws(() => piCliEntry(fakePackage(null)), /declares no pi bin/);
	const broken = fs.mkdtempSync(path.join(os.tmpdir(), "pi-invocation-bad-"));
	fs.writeFileSync(path.join(broken, "package.json"), "{not json");
	assert.throws(() => piCliEntry(broken), /metadata unreadable/);
	assert.throws(() => piCliEntry(path.join(broken, "absent")), /metadata unreadable/);
});

test("the installed Pi 1.4.0 package resolves to its declared bin entry on disk", () => {
	const modules = hostModules(["@earendil-works/pi-coding-agent"]);
	const pkg = path.join(modules, "@earendil-works", "pi-coding-agent");
	const entry = piCliEntry(pkg);
	assert.equal(path.relative(pkg, entry).split(path.sep).join("/"), "dist/bundle/cli.js");
	assert.ok(fs.existsSync(entry));
});
