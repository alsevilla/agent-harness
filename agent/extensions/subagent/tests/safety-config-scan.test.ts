// Stage 1 RED: manual read-only scanner (scripts/scan-harness-config.mjs). Fixtures live in a temp dir created here; spy fs proves no writes and no auth/settings reads.
import assert from "node:assert/strict";
import * as fs from "node:fs";
import { spawnSync } from "node:child_process";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import * as scanner from "../../../../scripts/scan-harness-config.mjs";

const scanHarnessConfig = (options: Record<string, unknown>) => (scanner as any).scanHarnessConfig(options);

const repo = fileURLToPath(new URL("../../../../", import.meta.url));
const SENTINEL = "SENTINEL-CREDENTIAL-7f3a";

function fixture(options: { roles?: unknown; integrations?: unknown; agents?: Record<string, string>; rawRoles?: string; auth?: string; indexSource?: string; omitGuard?: boolean } = {}) {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "stage1-scan-"));
	const agent = path.join(root, "agent");
	fs.mkdirSync(path.join(agent, "agents"), { recursive: true });
	fs.mkdirSync(path.join(root, "pi-package"), { recursive: true });
	const roles = options.roles ?? [{ name: "general-worker", provider: "anthropic", model: "m", fallbackModel: "", thinking: "medium", tools: "read, grep, find, ls, bash, edit" }];
	fs.writeFileSync(path.join(agent, "roles.json"), options.rawRoles ?? JSON.stringify(roles));
	const integrations = options.integrations ?? { roles: ["general-worker"], readOnlyTools: ["read"], workerTools: ["read", "bash"] };
	fs.mkdirSync(path.join(agent, "extensions", "subagent"), { recursive: true });
	fs.writeFileSync(path.join(agent, "extensions", "subagent", "integrations.json"), JSON.stringify(integrations));
	const ext = path.join(agent, "extensions", "subagent");
	fs.writeFileSync(path.join(ext, "index.ts"), options.indexSource ?? "claimChildGuard(store, role, cwd, path.join(extensionDir, \"safety-guard-entry.ts\"));\n");
	if (!options.omitGuard) fs.writeFileSync(path.join(ext, "safety-guard-entry.ts"), "export default function () {}\n");
	const agents = options.agents ?? { "general-worker": "---\nname: general-worker\ndescription: test\nmodel: anthropic/m\nfallbackModel: \"\"\nthinking: medium\ntools: read, grep, find, ls, bash, edit\n---\nbody\n" };
	for (const [name, body] of Object.entries(agents)) fs.writeFileSync(path.join(agent, "agents", `${name}.md`), body);
	fs.writeFileSync(path.join(root, "pi-package", "package.json"), JSON.stringify({ pi: { extensions: ["./extensions/subagent/index.ts"] } }));
	fs.writeFileSync(path.join(agent, "auth.json"), options.auth ?? JSON.stringify({ token: SENTINEL }));
	return { root, agent, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

function spyFs() {
	const calls: Array<{ method: string; path: string }> = [];
	const wrapped: Record<string, unknown> = {};
	for (const method of ["readFileSync", "readdirSync", "lstatSync", "existsSync", "statSync", "writeFileSync", "appendFileSync", "mkdirSync", "rmSync", "unlinkSync", "renameSync", "copyFileSync", "openSync"]) {
		const original = (fs as unknown as Record<string, (...args: unknown[]) => unknown>)[method];
		wrapped[method] = (...args: unknown[]) => { calls.push({ method, path: String(args[0]) }); return original(...args); };
	}
	return { fs: wrapped as typeof fs, calls };
}

test("invalid explicit host modules fails instead of falling back to installed SDK", () => {
	const invalidModules = path.join(os.tmpdir(), `missing-host-modules-${Date.now()}`);
	const result = spawnSync(process.execPath, ["--input-type=module", "-e", `import(${JSON.stringify(new URL("../../../../scripts/scan-harness-config.mjs", import.meta.url).href)})`], { cwd: repo, env: { ...process.env, NATIVE_PROBE_HOST_MODULES: invalidModules } });
	assert.equal(result.error, undefined, result.error?.message);
	assert.equal(result.signal, null);
	assert.equal(typeof result.status, "number");
	assert.notEqual(result.status, 0);
	assert.match(String(result.stderr), /NATIVE_PROBE_HOST_MODULES selected/);
});

test("clean fixture passes with no ERROR findings", () => {
	const f = fixture();
	try {
		const report = scanHarnessConfig({ root: f.root });
		assert.equal(report.errors, 0, JSON.stringify(report.findings));
	} finally { f.cleanup(); }
});

test("invalid shape, duplicates, parity, wildcard grants and unsafe paths are reported by rule id", () => {
	const cases: Array<[string, Parameters<typeof fixture>[0], string]> = [
		["duplicate role", { roles: [{ name: "general-worker", tools: "read" }, { name: "general-worker", tools: "read" }] }, "ROLE_DUPLICATE"],
		["name mismatch", { agents: { "general-worker": "---\nname: other\n---\nb" } }, "FRONTMATTER_NAME_MISMATCH"],
		["role without file", { roles: [{ name: "general-worker", tools: "read" }, { name: "ghost", tools: "read" }] }, "ROLE_WITHOUT_AGENT_FILE"],
		["file without role", { agents: { "general-worker": "---\nname: general-worker\n---\nb", extra: "---\nname: extra\n---\nb" } }, "AGENT_WITHOUT_ROLE"],
		["wildcard grant", { integrations: { roles: ["general-worker"], readOnlyTools: ["read"], workerTools: ["*"] } }, "GRANT_WILDCARD"],
		["malformed roles JSON", { rawRoles: "[{\"name\": " }, "JSON_INVALID"],
		["traversal in tool grant", { roles: [{ name: "general-worker", provider: "anthropic", model: "m", fallbackModel: "", thinking: "low", tools: "read, ../../../../etc/shadow" }] }, "UNSAFE_PATH"],
		["traversal role name", { roles: [{ name: "../evil", provider: "anthropic", model: "m", fallbackModel: "", thinking: "low", tools: "read" }] }, "UNSAFE_PATH"],
		["grant with spaces", { integrations: { roles: ["general-worker"], readOnlyTools: ["read"], workerTools: ["read bash"] } }, "GRANT_SHAPE"],
	];
	for (const [label, options, rule] of cases) {
		const f = fixture(options);
		try {
			const report = scanHarnessConfig({ root: f.root });
			assert.ok(report.findings.some((x: { rule: string; level: string }) => x.rule === rule && x.level === "ERROR"), `${label}: ${JSON.stringify(report.findings)}`);
			assert.ok(!JSON.stringify(report).includes(SENTINEL), `${label}: redaction`);
		} finally { f.cleanup(); }
	}
});

test("auth and settings are lstat-only; scanner never reads contents or writes", () => {
	const f = fixture();
	fs.writeFileSync(path.join(f.agent, "settings.json"), JSON.stringify({ apiKey: SENTINEL }));
	try {
		const spy = spyFs();
		const report = scanHarnessConfig({ root: f.root, fs: spy.fs });
		const reads = spy.calls.filter((c) => c.method === "readFileSync").map((c) => path.basename(c.path));
		assert.equal(reads.includes("auth.json") || reads.includes("settings.json"), false, reads.join(","));
		const writes = spy.calls.filter((c) => /write|append|mkdir|rm|unlink|rename|copy|open/.test(c.method));
		assert.deepEqual(writes, []);
		assert.equal(report.errors, 0);
		assert.ok(!JSON.stringify(report).includes(SENTINEL));
	} finally { f.cleanup(); }
});

// pi-package/ is intentionally absent from a source-only checkout; when present it is validated strictly (see the absence test below).
const PKG_PRESENT = fs.existsSync(path.join(repo, "pi-package"));
test("candidate profile scans clean (current Oracle configuration preserved and valid)", () => {
	const report = scanHarnessConfig({ root: repo });
	assert.equal(report.errors, 0, JSON.stringify(report.findings));
	if (PKG_PRESENT) {
		// Regenerated pi-package ships the guard: both guard files must be present and no legacy INFO may be reported for the candidate.
		for (const req of ["safety-core.ts", "safety-guard-entry.ts"]) assert.ok(fs.existsSync(path.join(repo, "pi-package", "extensions", "subagent", req)), `${req} present in pi-package`);
		assert.ok(!report.findings.some((x: any) => x.rule === "PACKAGE_LEGACY_NO_GUARD"), JSON.stringify(report.findings));
	} else {
		// Source-only checkout: the absent package is an INFO state; no guard file or legacy finding is claimed.
		assert.ok(report.findings.some((x: any) => x.rule === "PACKAGE_ABSENT" && x.level === "INFO"), JSON.stringify(report.findings));
		assert.ok(!report.findings.some((x: any) => x.rule === "PACKAGE_LEGACY_NO_GUARD"), JSON.stringify(report.findings));
	}
});

// Absent pi-package/ is INFO only; a present pi-package/ stays strict (missing or malformed manifest is an ERROR, never skipped).
test("pi-package absence is INFO; a present pi-package directory still validates its manifest strictly", () => {
	const f = fixture();
	const pkgDir = path.join(f.root, "pi-package");
	try {
		fs.rmSync(pkgDir, { recursive: true, force: true });
		const absent = scanHarnessConfig({ root: f.root });
		assert.equal(absent.errors, 0, JSON.stringify(absent.findings));
		assert.ok(absent.findings.some((x: any) => x.rule === "PACKAGE_ABSENT" && x.level === "INFO"), JSON.stringify(absent.findings));
		assert.ok(!absent.findings.some((x: any) => x.rule === "PACKAGE_LEGACY_NO_GUARD"), JSON.stringify(absent.findings));
		fs.mkdirSync(pkgDir);
		const missing = scanHarnessConfig({ root: f.root });
		assert.ok(missing.findings.some((x: any) => x.rule === "FILE_MISSING" && x.level === "ERROR"), JSON.stringify(missing.findings));
		fs.writeFileSync(path.join(pkgDir, "package.json"), "{ not json");
		const malformed = scanHarnessConfig({ root: f.root });
		assert.ok(malformed.findings.some((x: any) => x.rule === "JSON_INVALID" && x.level === "ERROR"), JSON.stringify(malformed.findings));
	} finally { f.cleanup(); }
});

// Review repair RED (M3): guard injection, package reachability and frontmatter parity.
test("review M3: guard module removed or not injected by index.ts is an ERROR", () => {
	const f = fixture();
	try {
		fs.rmSync(path.join(f.agent, "extensions", "subagent", "safety-guard-entry.ts"));
		const report = scanHarnessConfig({ root: f.root });
		assert.ok(report.findings.some((x: any) => x.rule === "GUARD_MISSING" && x.level === "ERROR"), JSON.stringify(report.findings));
	} finally { f.cleanup(); }
	const g = fixture({ indexSource: "export default function () {}\n" });
	try {
		const report = scanHarnessConfig({ root: g.root });
		assert.ok(report.findings.some((x: any) => x.rule === "GUARD_NOT_INJECTED" && x.level === "ERROR"), JSON.stringify(report.findings));
	} finally { g.cleanup(); }
});

test("review M3: explicit new package missing the guard is an ERROR; frozen legacy package is INFORMATIONAL only", () => {
	const f = fixture();
	const pkg = path.join(f.root, "pkg-new");
	fs.mkdirSync(path.join(pkg, "extensions", "subagent"), { recursive: true });
	fs.writeFileSync(path.join(pkg, "package.json"), JSON.stringify({ pi: { extensions: ["./extensions/subagent/index.ts"] } }));
	fs.writeFileSync(path.join(pkg, "extensions", "subagent", "index.ts"), "export default function () {}\n");
	try {
		const missing = scanHarnessConfig({ root: f.root, packageRoot: pkg });
		assert.ok(missing.findings.some((x: any) => x.rule === "PACKAGE_REACHABILITY" && x.level === "ERROR"), JSON.stringify(missing.findings));
		fs.writeFileSync(path.join(pkg, "extensions", "subagent", "safety-guard-entry.ts"), "export default function () {}\n");
		fs.writeFileSync(path.join(pkg, "extensions", "subagent", "safety-core.ts"), "export {};\n");
		const present = scanHarnessConfig({ root: f.root, packageRoot: pkg });
		assert.equal(present.errors, 0, JSON.stringify(present.findings));
		fs.rmSync(path.join(pkg, "extensions", "subagent", "index.ts"));
		const broken = scanHarnessConfig({ root: f.root, packageRoot: pkg });
		assert.ok(broken.findings.some((x: any) => x.rule === "PACKAGE_REACHABILITY" && x.level === "ERROR"), "manifest entry missing");
		const legacy = scanHarnessConfig({ root: f.root });
		assert.ok(legacy.findings.some((x: any) => x.rule === "PACKAGE_LEGACY_NO_GUARD" && x.level === "INFO"), JSON.stringify(legacy.findings));
		assert.equal(legacy.errors, 0);
	} finally { f.cleanup(); }
});

test("review M3: frontmatter must match roles.json field by field (names the field, never the value)", () => {
	const f = fixture({ agents: { "general-worker": "---\nname: general-worker\ndescription: t\nmodel: anthropic/other-model\nfallbackModel: \"\"\nthinking: medium\ntools: read, grep, find, ls, bash, edit\n---\nb" } });
	try {
		const report = scanHarnessConfig({ root: f.root });
		const hits = report.findings.filter((x: any) => x.rule === "PARITY_MISMATCH" && x.level === "ERROR");
		assert.equal(hits.length, 1, JSON.stringify(report.findings));
		assert.match(hits[0].message, /model/);
		assert.ok(!JSON.stringify(report).includes("other-model"), "values are not reported");
	} finally { f.cleanup(); }
});
