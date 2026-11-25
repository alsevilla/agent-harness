// Field report (High): direct access to .env was refused, but a worker's broad search over *.env* exposed the local reader health key
// in the session. Reproduction from the ticket, on a disposable checkout with a fake sentinel in a protected .env, through the real
// child guard entry: direct access is denied; a native or shell search whose glob can match a protected name is refused; and a broad
// search the guard cannot see through (`grep -r KEY .`) returns its matches with every protected value redacted, before the ledger,
// the output cap's log on disk or the session see it. Searches of unprotected files are unchanged.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

(globalThis as any).__piTestAgentDir = () => tmpdir();
registerHooks({
	resolve(specifier: string, context: object, nextResolve: (s: string, c: object) => { url: string }) {
		if (specifier === "@earendil-works/pi-coding-agent") return { url: "data:text/javascript," + encodeURIComponent("export const getAgentDir = () => globalThis.__piTestAgentDir();"), shortCircuit: true };
		return nextResolve(specifier, context);
	},
} as never);
const { default: safetyGuardEntry } = await import("../safety-guard-entry.ts");
const { REDACTED, secretValues } = await import("../secret-redact.ts");

const SENTINEL = "SENTINEL-reader-health-7f3a9c2e1b5d";
const root = fs.mkdtempSync(join(tmpdir(), "secret-search-"));
after(() => fs.rmSync(root, { recursive: true, force: true }));
fs.mkdirSync(join(root, "src"));
fs.writeFileSync(join(root, ".env"), `# local reader\nREADER_HEALTH_KEY=${SENTINEL}\nREADER_PORT=7000\n`);
fs.writeFileSync(join(root, "src", "health.ts"), "export const key = process.env.READER_HEALTH_KEY;\n");

type Handler = (event: any, ctx: any) => any;
const handlers: Record<string, Handler[]> = {};
safetyGuardEntry({ on: (name: string, fn: Handler) => (handlers[name] ??= []).push(fn), getActiveTools: () => ["read", "grep", "find", "bash"] } as never);
const ctx = { cwd: root, ui: { notify() {} } };
const call = (toolName: string, input: Record<string, unknown>) => handlers.tool_call.reduce<any>((v, h) => v ?? h({ toolName, input }, ctx), undefined);
/** Pi's runner: every tool_result handler in order, each seeing the previous one's content. */
async function result(toolName: string, input: Record<string, unknown>, text: string) {
	let event: any = { toolName, input, content: [{ type: "text", text }], isError: false, details: {} };
	for (const h of handlers.tool_result) { const r = await h(event, ctx); if (r?.content) event = { ...event, content: r.content }; }
	return event.content.map((p: { text: string }) => p.text).join("\n");
}
const grepShell = (...args: string[]) => { try { return execFileSync("grep", args, { cwd: root, encoding: "utf8" }); } catch (e: any) { return String(e.stdout ?? ""); } };

test("direct access and searches whose glob can match a protected name are refused, natively and in the shell", () => {
	assert.match(call("read", { path: ".env" })?.reason ?? "", /\[SECRET\]/);
	assert.match(call("grep", { pattern: "KEY", path: ".", glob: "*.env*" })?.reason ?? "", /\[SECRET\]/);
	assert.match(call("find", { pattern: "*.env*", path: "." })?.reason ?? "", /\[SECRET\]/);
	for (const command of ["grep -rn KEY --include='*.env*' .", "rg -n KEY -g '*.env*'", "find . -name '*.env*' -exec cat {} +", "Get-ChildItem -Recurse -Filter *.env* | Get-Content", "cat .e*"]) {
		assert.match(call("bash", { command })?.reason ?? "", /\[SECRET\]/, command);
	}
	for (const [tool, input] of [["grep", { pattern: "KEY", path: "src", glob: "*.ts" }], ["bash", { command: "grep -rn KEY src" }], ["bash", { command: "rg -n KEY -g '*.json'" }], ["bash", { command: "find . -name '*.env.example'" }]] as const) {
		assert.equal(call(tool, input as never), undefined, `${tool} ${JSON.stringify(input)}: unprotected search allowed`);
	}
});

test("a broad search the guard cannot see through returns its matches with the protected value redacted", async () => {
	assert.equal(call("bash", { command: "grep -rn READER_HEALTH_KEY ." }), undefined, "premise: a plain recursive search names no protected file");
	const raw = grepShell("-rn", "READER_HEALTH_KEY", ".");
	assert.ok(raw.includes(SENTINEL), "premise: the real search reads .env");
	const shown = await result("bash", { command: "grep -rn READER_HEALTH_KEY ." }, raw);
	assert.ok(!shown.includes(SENTINEL), "the sentinel never reaches the session");
	assert.match(shown, new RegExp(`READER_HEALTH_KEY=${REDACTED.replace(/[[\]]/g, "\\$&")}`));
	assert.match(shown, /src\/health\.ts:1:export const key = process\.env\.READER_HEALTH_KEY;/, "unprotected matches are kept");
	// Pi's native grep (rg --hidden) returns the same match lines.
	const native = await result("grep", { pattern: "READER", path: "." }, `.env:2: READER_HEALTH_KEY=${SENTINEL}\nsrc/health.ts:1: export const key = process.env.READER_HEALTH_KEY;`);
	assert.ok(!native.includes(SENTINEL));
});

test("a long output is redacted before the output cap writes its log to disk", async () => {
	const long = Array.from({ length: 4_000 }, (_, i) => `line ${i} ${i === 1_234 ? SENTINEL : "ok"}`).join("\n");
	const shown = await result("bash", { command: "grep -rn . ." }, long);
	assert.ok(!shown.includes(SENTINEL));
	const log = /the full output is in (\S+\.log)/.exec(shown)?.[1];
	assert.ok(log, "premise: the output cap saved the full output");
	assert.ok(!fs.readFileSync(log!, "utf8").includes(SENTINEL), "the saved log holds the redacted text");
	assert.ok(fs.readFileSync(log!, "utf8").includes(REDACTED));
});

test("results with no protected value are unchanged", async () => {
	const text = grepShell("-rn", "export", "src");
	assert.equal(await result("bash", { command: "grep -rn export src" }, text), text);
});

test("protected-file values: dotenv, .npmrc, JSON and key material; key names and registries stay readable", () => {
	assert.deepEqual(secretValues("# c\nREADER_PORT=7000\nTOKEN=\"abc123def456\"\nexport DB_URL=postgres://u:p4ssw0rd@db/app\n").sort(), ["abc123def456", "postgres://u:p4ssw0rd@db/app"]);
	assert.deepEqual(secretValues("//registry.npmjs.org/:_authToken=npm_0123456789abcdefABCDEF0123\n"), ["npm_0123456789abcdefABCDEF0123"], "the registry is not redacted");
	assert.deepEqual(secretValues('{\n  "password": "hunter2xyz",\n  "client_secret": "s3cr3tValue-xyz-0123456789",\n  "n": "x"\n}').sort(), ["hunter2xyz", "s3cr3tValue-xyz-0123456789"]);
	assert.deepEqual(secretValues("-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQ==\n-----END OPENSSH PRIVATE KEY-----\n"), ["b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQ=="], "a base64 line ending in == is key material, not an assignment");
});
