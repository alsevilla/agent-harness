// Stage 1 RED: manual read-only scanner (scripts/scan-harness-config.mjs). Fixtures live in a temp dir created here; spy fs proves no writes and no auth/settings reads.
import assert from "node:assert/strict";
import * as fs from "node:fs";
import { spawnSync } from "node:child_process";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
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

test("annotated Pi declarations are authoritative and validated fieldwise", () => {
	const base = "name: general-worker\ndescription: test\nmodel: anthropic/m\nfallbackModel: \"\"\nthinking: medium\ntools: read, grep, find, ls, bash, edit\n";
	const annotated = (entries: string, legacy = base) => `---\n${legacy}metadata:\n  ${entries.replaceAll("\n", "\n  ")}\n---\nbody\n`;
	const good = "pi.model: anthropic/m\npi.fallbackModel: \"\"\npi.thinking: medium\npi.tools: read, grep, find, ls, bash, edit";
	const cases: Array<{ label: string; text: string; field?: string; invalid?: boolean }> = [
		{ label: "valid complete annotations", text: annotated(good) },
		{ label: "partial annotation", text: annotated("pi.model: anthropic/m") },
		{ label: "explicit empty fallback overrides legacy", text: annotated("pi.fallbackModel: \"\"", base.replace('fallbackModel: ""', "fallbackModel: anthropic/legacy")) },
		...(["model", "fallbackModel", "thinking", "tools"] as const).map((field) => {
			const expected = field === "model" ? "anthropic/m" : field === "fallbackModel" ? '\"\"' : field === "thinking" ? "medium" : "read, grep, find, ls, bash, edit";
			const wrong = field === "model" ? "anthropic/other" : field === "fallbackModel" ? "anthropic/other-fallback" : field === "thinking" ? "high" : "read, grep, find, ls, bash";
			const entries = good.replace(`pi.${field}: ${field === "fallbackModel" ? '\"\"' : expected}`, `pi.${field}: ${wrong}`);
			return { label: `wrong annotated ${field} with competing correct legacy`, text: annotated(entries), field };
		}),
		...(["null", "42", "[]", "{}", ""] as const).flatMap((value) => (["model", "fallbackModel", "thinking", "tools"] as const).map((field) => ({
			label: `${field} annotation ${value || "missing"}`, field, invalid: true,
			text: annotated(`pi.${field}: ${value}${value ? "" : ""}`, base),
		}))),
		{ label: "empty model", text: annotated('pi.model: ""'), field: "model", invalid: true },
		{ label: "empty thinking", text: annotated('pi.thinking: ""'), field: "thinking", invalid: true },
		{ label: "whitespace thinking", text: annotated('pi.thinking: "  "'), field: "thinking", invalid: true },
		{ label: "empty tools token", text: annotated('pi.tools: "read,, grep"'), field: "tools", invalid: true },
		{ label: "wildcard tool", text: annotated('pi.tools: "read, *"'), field: "tools", invalid: true },
		{ label: "path tool", text: annotated('pi.tools: "read, ../secret"'), field: "tools", invalid: true },
	];
	for (const { label, text, field, invalid } of cases) {
		const f = fixture({ agents: { "general-worker": text } });
		try {
			const report = scanHarnessConfig({ root: f.root });
			const errors = report.findings.filter((x: any) => x.level === "ERROR");
			if (!field) assert.equal(errors.length, 0, `${label}: ${JSON.stringify(report.findings)}`);
			else {
				assert.equal(errors.length, 1, `${label}: ${JSON.stringify(report.findings)}`);
				assert.equal(errors[0].rule, "PARITY_MISMATCH", label);
				assert.match(errors[0].message, new RegExp(`pi\\.${field}`), label);
				assert.match(errors[0].message, invalid ? /invalid/ : /differs from roles\.json/);
			}
			assert.ok(!JSON.stringify(report).includes(SENTINEL), `${label}: credential redaction`);
			assert.ok(!JSON.stringify(report).includes("SENTINEL"), `${label}: value redaction`);
		} finally { f.cleanup(); }
	}
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

// Stage 2 RED (tier-only registry): the declared default tier is the only Pi source; annotations must match it field by field.
const TIER_TOOLS = "read, grep, find, ls, bash, edit";
const tierRole = (modelTiers: unknown, extra: Record<string, unknown> = {}) => ({ name: "general-worker", defaultModelTier: "capable", modelTiers, tools: TIER_TOOLS, ...extra });
const tierAgent = (meta: Record<string, string>) => `---\nname: general-worker\ndescription: test\nmetadata:\n${Object.entries(meta).map(([k, v]) => `  pi.${k}: ${v}`).join("\n")}\n---\nbody\n`;
const CAPABLE_TUPLE = { model: "anthropic/m", fallbackModel: "", thinking: "medium" };
const CAPABLE_META = { model: '"anthropic/m"', fallbackModel: '""', thinking: '"medium"', tools: `"${TIER_TOOLS}"` };
function scanFixture(options: Parameters<typeof fixture>[0]) {
	const f = fixture(options);
	try {
		return scanHarnessConfig({ root: f.root }) as { errors: number; findings: Array<{ level: string; rule: string; file: string; message: string }> };
	} finally { f.cleanup(); }
}
const parityFields = (findings: Array<{ rule: string; message: string }>) => findings.filter((x) => x.rule === "PARITY_MISMATCH").map((x) => x.message.match(/pi\.(\w+)/)?.[1]);

test("tier-only shipped shape: declared default tier matches annotations and scans clean", () => {
	const report = scanFixture({ roles: [tierRole({ capable: CAPABLE_TUPLE })], agents: { "general-worker": tierAgent(CAPABLE_META) } });
	assert.equal(report.errors, 0, JSON.stringify(report.findings));
});

test("tier-only parity compares the declared default slot, including per-tier thinking and model", () => {
	const economy = { model: "anthropic/haiku", fallbackModel: "openai/luna", thinking: "low" };
	const capable = { model: "openai/sol", fallbackModel: "anthropic/sonnet", thinking: "high" };
	const economyMeta = { model: '"anthropic/haiku"', fallbackModel: '"openai/luna"', thinking: '"low"', tools: `"${TIER_TOOLS}"` };
	const capableMeta = { model: '"openai/sol"', fallbackModel: '"anthropic/sonnet"', thinking: '"high"', tools: `"${TIER_TOOLS}"` };
	const cases: Array<{ label: string; defaultTier: string; meta: Record<string, string>; fields: string[] }> = [
		{ label: "economy default, economy annotations", defaultTier: "economy", meta: economyMeta, fields: [] },
		{ label: "economy default, capable thinking annotated", defaultTier: "economy", meta: { ...economyMeta, thinking: '"high"' }, fields: ["thinking"] },
		{ label: "capable default, economy annotations", defaultTier: "capable", meta: economyMeta, fields: ["model", "fallbackModel", "thinking"] },
		{ label: "capable default, capable annotations", defaultTier: "capable", meta: capableMeta, fields: [] },
	];
	for (const c of cases) {
		const report = scanFixture({ roles: [tierRole({ economy, capable }, { defaultModelTier: c.defaultTier })], agents: { "general-worker": tierAgent(c.meta) } });
		assert.deepEqual(parityFields(report.findings), c.fields, `${c.label}: ${JSON.stringify(report.findings)}`);
		assert.equal(report.errors, c.fields.length, `${c.label}: ${JSON.stringify(report.findings)}`);
	}
});

test("single tier with empty fallback (Oracle shape): empty annotation is valid, a non-empty annotation is a field mismatch", () => {
	const oracle = { capable: { model: "anthropic/opus", fallbackModel: "", thinking: "high" } };
	const meta = (fallback: string) => ({ model: '"anthropic/opus"', fallbackModel: fallback, thinking: '"high"', tools: `"${TIER_TOOLS}"` });
	const clean = scanFixture({ roles: [tierRole(oracle)], agents: { "general-worker": tierAgent(meta('""')) } });
	assert.equal(clean.errors, 0, JSON.stringify(clean.findings));
	const drift = scanFixture({ roles: [tierRole(oracle)], agents: { "general-worker": tierAgent(meta('"anthropic/sonnet"')) } });
	assert.deepEqual(parityFields(drift.findings), ["fallbackModel"], JSON.stringify(drift.findings));
});

// Fail closed: every invalid new-format shape is a field-named ROLE_SHAPE; competing correct annotations/root scalars are never used as a fallback.
test("tier-only invalid shapes fail closed with field-named ROLE_SHAPE and no annotation or root-scalar fallback", () => {
	const good = { model: "anthropic/m", fallbackModel: "", thinking: "medium" };
	const tier = (patch: Record<string, unknown>) => ({ capable: { ...good, ...patch } });
	const rows: Array<[string, Record<string, unknown>, RegExp]> = [
		["defaultModelTier missing", { defaultModelTier: undefined }, /defaultModelTier/],
		["defaultModelTier null", { defaultModelTier: null }, /defaultModelTier/],
		["defaultModelTier unknown", { defaultModelTier: "premium" }, /defaultModelTier/],
		["defaultModelTier not configured", { defaultModelTier: "economy" }, /defaultModelTier.*not configured/],
		["modelTiers missing", { modelTiers: undefined }, /modelTiers/],
		["modelTiers null", { modelTiers: null }, /modelTiers/],
		["modelTiers array", { modelTiers: [good] }, /modelTiers/],
		["modelTiers empty", { modelTiers: {} }, /not configured/],
		["unknown tier name", { modelTiers: { capable: good, premium: good } }, /unknown tier/],
		["tier definition null", { modelTiers: { capable: null } }, /modelTiers\.capable/],
		["tier thinking missing", { modelTiers: tier({ thinking: undefined }) }, /modelTiers\.capable\.thinking/],
		["tier thinking outside vocabulary", { modelTiers: tier({ thinking: "ultra" }) }, /modelTiers\.capable\.thinking/],
		["tier thinking null", { modelTiers: tier({ thinking: null }) }, /modelTiers\.capable\.thinking/],
		["tier thinking secret-bearing", { modelTiers: tier({ thinking: SENTINEL }) }, /modelTiers\.capable\.thinking/],
		["tier model unqualified", { modelTiers: tier({ model: "claude-sonnet" }) }, /modelTiers\.capable\.model/],
		["tier model surrounding whitespace", { modelTiers: tier({ model: " anthropic/m" }) }, /modelTiers\.capable\.model/],
		["tier model secret-bearing", { modelTiers: tier({ model: SENTINEL }) }, /modelTiers\.capable\.model/],
		["tier fallbackModel null", { modelTiers: tier({ fallbackModel: null }) }, /modelTiers\.capable\.fallbackModel/],
		["tier fallbackModel array", { modelTiers: tier({ fallbackModel: ["anthropic/x"] }) }, /modelTiers\.capable\.fallbackModel/],
		["tier fallbackModel trailing delimiter", { modelTiers: tier({ fallbackModel: "anthropic/x||" }) }, /modelTiers\.capable\.fallbackModel/],
		["tier fallbackModel unqualified", { modelTiers: tier({ fallbackModel: "gpt" }) }, /modelTiers\.capable\.fallbackModel/],
		["tier fallbackModel missing", { modelTiers: tier({ fallbackModel: undefined }) }, /modelTiers\.capable\.fallbackModel/],
		["per-tier provider beside thinking", { modelTiers: { capable: { ...good, provider: "anthropic" } } }, /mixes/],
		["root provider beside new format", { provider: "anthropic" }, /mixes/],
		["root model beside new format", { model: "anthropic/m" }, /mixes/],
		["unknown root key", { extra: "x" }, /unknown/],
	];
	for (const [label, patch, field] of rows) {
		const report = scanFixture({ roles: [tierRole(tier(good), patch)], agents: { "general-worker": tierAgent(CAPABLE_META) } });
		const shape = report.findings.filter((x) => x.level === "ERROR" && x.rule === "ROLE_SHAPE");
		assert.ok(shape.length >= 1, `${label}: ${JSON.stringify(report.findings)}`);
		assert.ok(shape.some((x) => field.test(x.message)), `${label}: ${JSON.stringify(shape)}`);
		assert.deepEqual(parityFields(report.findings), [], `${label}: annotation fallback`);
		assert.ok(!JSON.stringify(report).includes(SENTINEL), `${label}: secret redaction`);
	}
});

// Bounded legacy: external flat and per-tier-provider entries keep their root-scalar parity and reader-level shape checks.
test("legacy flat and per-tier-provider entries stay bounded-compatible with root-scalar parity", () => {
	const legacy = (tiers?: unknown) => ({ name: "general-worker", provider: "anthropic", model: "m", fallbackModel: "", thinking: "medium", tools: TIER_TOOLS, ...(tiers ? { modelTiers: tiers } : {}) });
	const legacyMeta = { model: '"anthropic/m"', fallbackModel: '""', thinking: '"medium"', tools: `"${TIER_TOOLS}"` };
	const perTier = { capable: { provider: "openai-codex", model: "gpt", fallbackModel: "anthropic/x" } };
	const clean = scanFixture({ roles: [legacy(perTier)], agents: { "general-worker": tierAgent(legacyMeta) } });
	assert.equal(clean.errors, 0, JSON.stringify(clean.findings));
	const drift = scanFixture({ roles: [legacy()], agents: { "general-worker": tierAgent({ ...legacyMeta, model: '"anthropic/other"' }) } });
	assert.deepEqual(parityFields(drift.findings), ["model"], JSON.stringify(drift.findings));
	const emptyTierFallback = scanFixture({ roles: [legacy({ capable: { provider: "openai-codex", model: "gpt", fallbackModel: "" } })], agents: { "general-worker": tierAgent(legacyMeta) } });
	assert.ok(emptyTierFallback.findings.some((x) => x.rule === "ROLE_SHAPE" && /modelTiers\.capable/.test(x.message)), JSON.stringify(emptyTierFallback.findings));
});

// Golden: the declared default of every shipped role equals the independent pre-migration normal tuple (no approved delta touches a default).
test("candidate declared defaults equal the independent pre-migration golden for all 20 roles", () => {
	const golden = JSON.parse(fs.readFileSync(new URL("./fixtures/tier-only-baseline.json", import.meta.url), "utf8")) as { roles: Array<{ name: string; normal: { model: string; fallbackModel: string[]; thinking: string; tools: string[] } }> };
	const registry = JSON.parse(fs.readFileSync(path.join(repo, "agent", "roles.json"), "utf8"));
	const declared = (scanner as any).declaredDefaults(registry) as Map<string, { model: string; fallbackModel: string[]; thinking: string; tools: string }>;
	assert.equal(golden.roles.length, 20);
	assert.equal(declared.size, 20);
	for (const role of golden.roles) {
		const d = declared.get(role.name);
		assert.ok(d, role.name);
		// The approved write grant is the only tool delta: release-engineer = golden tools + write (mirrors role-registry APPROVED_TOOL_DELTAS).
		const tools = role.name === "release-engineer" ? [...role.normal.tools, "write"] : role.normal.tools;
		assert.deepEqual({ model: d.model, fallbackModel: d.fallbackModel, thinking: d.thinking, tools: d.tools.split(",").map((t) => t.trim()) }, { ...role.normal, tools }, role.name);
	}
});

// Candidate CLI: the migrated shipped registry scans clean (exit 0) and an error fixture exits 1 without echoing secrets.
test("CLI exits 0 on the candidate and 1 on an error fixture, without echoing secrets", () => {
	const script = fileURLToPath(new URL("../../../../scripts/scan-harness-config.mjs", import.meta.url));
	const ok = spawnSync(process.execPath, [script], { cwd: repo, env: process.env, encoding: "utf8" });
	assert.equal(ok.status, 0, `${ok.stderr}\n${String(ok.stdout).slice(0, 400)}`);
	assert.equal(JSON.parse(ok.stdout).errors, 0);
	const f = fixture({ roles: [tierRole({ capable: { ...CAPABLE_TUPLE, model: SENTINEL } })] });
	try {
		const bad = spawnSync(process.execPath, [script, "--root", f.root], { cwd: repo, env: process.env, encoding: "utf8" });
		assert.equal(bad.status, 1, String(bad.stderr));
		assert.ok(!String(bad.stdout).includes(SENTINEL), "CLI output must not echo secret-bearing values");
	} finally { f.cleanup(); }
});

// Retention guard for a preserved requirement: the latest NUMERIC installed release is the house parser source (not lexical, not hardcoded).
test("SDK host selection picks the latest numeric installed release when no explicit override is set", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "stage1-host-"));
	try {
		fs.mkdirSync(path.join(root, "scripts"), { recursive: true });
		fs.copyFileSync(fileURLToPath(new URL("../../../../scripts/scan-harness-config.mjs", import.meta.url)), path.join(root, "scripts", "scan-harness-config.mjs"));
		for (const v of ["1.2.0", "1.10.0"]) {
			const dir = path.join(root, "agent", "install", "releases", v, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "utils");
			fs.mkdirSync(dir, { recursive: true });
			fs.writeFileSync(path.join(dir, "frontmatter.js"), `exports.parseFrontmatter = (text) => ({ frontmatter: { name: ${JSON.stringify(v)} }, body: text });\n`);
		}
		fs.mkdirSync(path.join(root, "agent", "agents"), { recursive: true });
		fs.writeFileSync(path.join(root, "agent", "agents", "1.10.0.md"), "---\nname: 1.10.0\n---\nbody\n");
		const env = { ...process.env };
		delete env.NATIVE_PROBE_HOST_MODULES;
		const url = pathToFileURL(path.join(root, "scripts", "scan-harness-config.mjs")).href;
		const child = spawnSync(process.execPath, ["--input-type=module", "-e", `import(${JSON.stringify(url)}).then((m) => process.stdout.write(JSON.stringify(m.scanHarnessConfig({ root: ${JSON.stringify(root)} }).findings)));`], { encoding: "utf8", env });
		assert.equal(child.status, 0, String(child.stderr));
		const findings = JSON.parse(child.stdout) as Array<{ rule: string }>;
		assert.ok(!findings.some((x) => x.rule === "FRONTMATTER_NAME_MISMATCH" || x.rule === "FRONTMATTER_INVALID"), JSON.stringify(findings));
	} finally { fs.rmSync(root, { recursive: true, force: true }); }
});
