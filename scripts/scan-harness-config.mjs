// Stage 1 manual scanner: read-only, standalone, never reads auth/settings contents and never writes.
// Usage: node scripts/scan-harness-config.mjs [--root <profile dir>] [--package <package dir>]   (exit 1 when any ERROR finding)
// Guard/package checks are static file-content audits, not a runtime guarantee. The frozen 0.1.0 package is reported as INFO only.
import * as realFs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PACKAGE = "@earendil-works/pi-coding-agent";
const numericDescending = (a, b) => b.localeCompare(a, undefined, { numeric: true });
const here = path.dirname(fileURLToPath(import.meta.url));
const defaultRoot = path.resolve(here, "..");
const SENSITIVE = ["auth.json", "settings.json"];
const TOOL_NAME = /^[a-z][a-z0-9_]*$/;
const ROLE_NAME = /^[A-Za-z0-9_-]{1,64}$/;
// Shape constants mirror the house reader (agents.ts): new-format keys, legacy flat keys, tier names, effort vocabulary and qualified IDs.
const ROLE_KEYS = ["name", "defaultModelTier", "provider", "model", "fallbackModel", "modelTiers", "thinking", "tools"];
const LEGACY_ROLE_KEYS = ["provider", "model", "fallbackModel", "thinking"];
const TIER_NAMES = ["economy", "capable"];
const TIER_KEYS = ["model", "fallbackModel", "thinking"];
const LEGACY_TIER_KEYS = ["provider", "model", "fallbackModel"];
const EFFORTS = ["off", "minimal", "low", "medium", "high", "xhigh"];
const QUALIFIED_MODEL = /^[^\s/]+\/\S+$/;
const parseFrontmatter = loadParser();

// House parser: the installed pi package's parseFrontmatter (same code agents.ts uses). Found relative to this profile, then by normal resolution.
function loadParser() {
	const candidates = [];
	const hostModules = process.env.NATIVE_PROBE_HOST_MODULES;
	if (hostModules) {
		const dir = path.join(hostModules, ...PACKAGE.split("/"));
		const file = path.join(dir, "dist", "utils", "frontmatter.js");
		if (!realFs.existsSync(file)) throw new Error(`NATIVE_PROBE_HOST_MODULES selected ${hostModules}, but house parseFrontmatter was not found at ${file}`);
		return createRequire(import.meta.url)(file).parseFrontmatter;
	}
	const releases = path.join(defaultRoot, "agent", "install", "releases");
	try {
		for (const v of realFs.readdirSync(releases).filter((name) => /^\d+\.\d+\.\d+$/.test(name)).sort(numericDescending)) candidates.push(path.join(releases, v, "node_modules", ...PACKAGE.split("/")));
	} catch {}
	try {
		candidates.push(path.dirname(createRequire(import.meta.url).resolve(`${PACKAGE}/package.json`)));
	} catch {}
	const req = createRequire(import.meta.url);
	for (const dir of candidates) {
		const file = path.join(dir, "dist", "utils", "frontmatter.js");
		if (realFs.existsSync(file)) return req(file).parseFrontmatter;
	}
	throw new Error(`house parseFrontmatter unavailable: install ${PACKAGE} for this profile`);
}

const isPlainObject = (value) => typeof value === "object" && value !== null && !Array.isArray(value);
// Same grammar as agents.ts parseQualifiedFallbacks: "" means no fallback; otherwise ||-separated tokens (a blank token is invalid).
const parseFallbacks = (text) => (text === "" ? [] : text.split("||").map((token) => token.trim()));
const fallbackKey = (text) => [...new Set(parseFallbacks(String(text ?? "")))].join("||");

// agents.ts entryFormat: "tier" (defaultModelTier or tier-only definitions), "legacy" (flat or per-tier provider), "mixed" or "neutral".
function entryFormat(entry) {
	const values = isPlainObject(entry.modelTiers) ? Object.values(entry.modelTiers) : [];
	const legacy = LEGACY_ROLE_KEYS.some((key) => key in entry) || values.some((value) => isPlainObject(value) && "provider" in value);
	const tier = "defaultModelTier" in entry || values.some((value) => !isPlainObject(value) || !("provider" in value) || "thinking" in value);
	if (legacy && tier) return "mixed";
	return tier ? "tier" : legacy ? "legacy" : "neutral";
}

// Field-name-only problems for one tier definition; no value is ever echoed.
function tierProblems(at, def) {
	if (!isPlainObject(def)) return [`${at} must be an object`];
	const found = [];
	const unknown = Object.keys(def).filter((key) => !TIER_KEYS.includes(key)).length;
	if (unknown) found.push(`${at} has ${unknown} unknown key(s)`);
	if (typeof def.model !== "string" || !QUALIFIED_MODEL.test(def.model)) found.push(`${at}.model must be a provider/id model`);
	if (typeof def.fallbackModel !== "string" || !parseFallbacks(def.fallbackModel).every((token) => QUALIFIED_MODEL.test(token))) found.push(`${at}.fallbackModel must be "" or provider/id models separated by ||`);
	if (!EFFORTS.includes(def.thinking)) found.push(`${at}.thinking must be one of ${EFFORTS.join(", ")}`);
	return found;
}

// New format: the declared slot is modelTiers[defaultModelTier]; every configured tier is validated, and a defective default yields no slot.
function tierSlot(r, problems) {
	const name = r.name;
	if (!("defaultModelTier" in r)) problems.push(`${name}.defaultModelTier is required for the new format`);
	else if (!TIER_NAMES.includes(r.defaultModelTier)) problems.push(`${name}.defaultModelTier must be economy or capable`);
	if (!isPlainObject(r.modelTiers)) {
		problems.push(`${name}.modelTiers must be an object`);
		return null;
	}
	const defective = new Set();
	for (const [tier, def] of Object.entries(r.modelTiers)) {
		if (!TIER_NAMES.includes(tier)) {
			problems.push(`${name}.modelTiers has an unknown tier name`);
			continue;
		}
		const found = tierProblems(`${name}.modelTiers.${tier}`, def);
		if (found.length) defective.add(tier);
		problems.push(...found);
	}
	const dflt = r.defaultModelTier;
	if (!TIER_NAMES.includes(dflt)) return null;
	if (!Object.hasOwn(r.modelTiers, dflt)) {
		problems.push(`${name}.defaultModelTier is not configured in modelTiers`);
		return null;
	}
	if (defective.has(dflt)) return null;
	const tier = r.modelTiers[dflt];
	return { model: tier.model, fallbackModel: [...new Set(parseFallbacks(tier.fallbackModel))], thinking: tier.thinking, tools: r.tools };
}

// Bounded legacy (flat scalars or per-tier provider) and neutral entries: the slot is the flat provider/model; per-tier rows are checked like agents.ts.
function legacySlot(r, problems) {
	const name = r.name;
	for (const key of ["provider", "model", "thinking"]) if (typeof r[key] !== "string" || !r[key].trim()) problems.push(`${name}.${key} must be a non-empty string`);
	if (typeof r.fallbackModel !== "string") problems.push(`${name}.fallbackModel must be a string (may be empty)`);
	if (r.modelTiers !== undefined && !isPlainObject(r.modelTiers)) problems.push(`${name}.modelTiers must be an object`);
	for (const [tier, def] of Object.entries(isPlainObject(r.modelTiers) ? r.modelTiers : {})) {
		if (!TIER_NAMES.includes(tier)) {
			problems.push(`${name}.modelTiers has an unknown tier name`);
			continue;
		}
		const unknown = isPlainObject(def) ? Object.keys(def).filter((key) => !LEGACY_TIER_KEYS.includes(key)).length : 0;
		if (!isPlainObject(def) || unknown || typeof def.provider !== "string" || !def.provider.trim() || typeof def.model !== "string" || !def.model.trim() || typeof def.fallbackModel !== "string" || !parseFallbacks(def.fallbackModel).some(Boolean)) problems.push(`${name}.modelTiers.${tier} has invalid provider, model or fallbackModel`);
	}
	if (problems.length) return null;
	const model = r.model.trim();
	return { model: model.includes("/") ? model : `${r.provider}/${model}`, fallbackModel: [...new Set(parseFallbacks(r.fallbackModel))], thinking: r.thinking, tools: r.tools };
}

// One roles.json entry: every problem is field-named; the slot is returned only when the entry has none, so no annotation or legacy field can stand in for a broken default.
function checkRole(r) {
	const format = entryFormat(r);
	const problems = [];
	let slot = null;
	if (format === "mixed") problems.push(`${r.name} mixes defaultModelTier or tier thinking with legacy provider, model, fallbackModel or thinking fields`);
	else {
		const unknown = Object.keys(r).filter((key) => !ROLE_KEYS.includes(key)).length;
		if (unknown) problems.push(`${r.name} has ${unknown} unknown key(s)`);
		if (typeof r.tools !== "string" || !r.tools.trim()) problems.push(`${r.name}.tools must be a non-empty string`);
		slot = format === "tier" ? tierSlot(r, problems) : legacySlot(r, problems);
	}
	return { problems, slot: problems.length ? null : slot };
}

// Declared default per shipped role (name -> {model, fallbackModel[], thinking, tools}); entries with any shape problem are omitted.
export function declaredDefaults(registry) {
	const slots = new Map();
	for (const r of Array.isArray(registry) ? registry : []) {
		if (!isPlainObject(r) || typeof r.name !== "string" || slots.has(r.name)) continue;
		const { slot } = checkRole(r);
		if (slot) slots.set(r.name, slot);
	}
	return slots;
}

export function scanHarnessConfig({ root = defaultRoot, fs: fsImpl = realFs, packageRoot } = {}) {
	const findings = [];
	const add = (level, rule, file, message) => findings.push({ level, rule, file, message });
	const exists = (abs) => fsImpl.existsSync(abs);
	const readText = (abs) => {
		try {
			return fsImpl.readFileSync(abs, "utf8");
		} catch {
			return undefined;
		}
	};
	// A path-like token is UNSAFE_PATH; any other token that is not a single tool name is GRANT_SHAPE. Wildcards keep their GRANT_WILDCARD rule.
	const checkGrants = (values, file, label) => {
		for (const raw of values) {
			const token = String(raw).trim();
			if (!token || token.includes("*")) continue;
			if (/[\\/:]|\.\./.test(token)) add("ERROR", "UNSAFE_PATH", file, `${label} contains a path-like token`);
			else if (!TOOL_NAME.test(token)) add("ERROR", "GRANT_SHAPE", file, `${label} contains a token that is not a single tool name`);
		}
	};
	// Names only: the parity message never repeats a value.
	const checkParity = (slot, fm, file) => {
		const normTools = (v) => (typeof v === "string" ? v.split(",").map((s) => s.trim()).filter(Boolean).join(", ") : "");
		const metadata = fm.metadata && typeof fm.metadata === "object" && !Array.isArray(fm.metadata) ? fm.metadata : {};
		const fields = [
			["model", slot.model, "model"],
			["fallbackModel", slot.fallbackModel.join("||"), "fallbackModel"],
			["thinking", slot.thinking, "thinking"],
			["tools", normTools(slot.tools), "tools"],
		];
		for (const [label, expected, key] of fields) {
			const annotation = `pi.${key}`;
			const annotated = Object.hasOwn(metadata, annotation);
			const actual = annotated ? metadata[annotation] : fm[key];
			const validString = typeof actual === "string" && (key === "fallbackModel" || !!actual.trim());
			const validThinking = key !== "thinking" || ["off", "minimal", "low", "medium", "high", "xhigh"].includes(actual);
			const validTools = key !== "tools" || (typeof actual === "string" && actual.split(",").every((token) => TOOL_NAME.test(token.trim())));
			if ((annotated && (!validString || !validThinking || !validTools)) || (!annotated && actual !== undefined && (typeof actual !== "string" || (key !== "fallbackModel" && !actual.trim()) || !validThinking || !validTools))) {
				add("ERROR", "PARITY_MISMATCH", file, `frontmatter field ${annotation} is invalid`);
				continue;
			}
			const normalized = key === "tools" ? normTools(actual) : key === "fallbackModel" ? fallbackKey(actual) : actual;
			if (String(expected) !== String(normalized ?? "")) add("ERROR", "PARITY_MISMATCH", file, `frontmatter field ${annotation} differs from roles.json`);
		}
	};
	const agentDir = path.join(root, "agent");
	const readJson = (rel) => {
		try {
			return JSON.parse(fsImpl.readFileSync(path.join(root, rel), "utf8"));
		} catch (error) {
			if (error?.code === "ENOENT") add("ERROR", "FILE_MISSING", rel, "required file missing");
			else add("ERROR", "JSON_INVALID", rel, "not valid JSON (parser detail omitted)");
			return undefined;
		}
	};

	for (const name of SENSITIVE) {
		try {
			const st = fsImpl.lstatSync(path.join(agentDir, name));
			add("INFO", "SENSITIVE_PRESENT", `agent/${name}`, `present (${st.isSymbolicLink() ? "symlink" : "file"}); contents not read`);
		} catch {}
	}

	const roles = readJson("agent/roles.json");
	const roleNames = new Set();
	const slotByName = new Map();
	if (Array.isArray(roles)) {
		for (const [i, r] of roles.entries()) {
			if (!r || typeof r !== "object" || typeof r.name !== "string" || !r.name) {
				add("ERROR", "ROLE_SHAPE", "agent/roles.json", `entry ${i} has no name`);
				continue;
			}
			if (!ROLE_NAME.test(r.name)) add("ERROR", "UNSAFE_PATH", "agent/roles.json", `entry ${i} has an unsafe role name`);
			if (roleNames.has(r.name)) add("ERROR", "ROLE_DUPLICATE", "agent/roles.json", `duplicate role ${r.name}`);
			roleNames.add(r.name);
			const { problems, slot } = checkRole(r);
			for (const message of problems) add("ERROR", "ROLE_SHAPE", "agent/roles.json", message);
			if (slot && !slotByName.has(r.name)) slotByName.set(r.name, slot);
			if (typeof r.tools === "string" && r.tools.includes("*")) add("ERROR", "GRANT_WILDCARD", "agent/roles.json", `${r.name}.tools contains a wildcard`);
			if (typeof r.tools === "string") checkGrants(r.tools.split(","), "agent/roles.json", `${r.name}.tools`);
		}
	} else if (roles !== undefined) add("ERROR", "ROLE_SHAPE", "agent/roles.json", "top-level value must be an array");

	const agentsDir = path.join(agentDir, "agents");
	const fileNames = new Set();
	try {
		for (const f of fsImpl.readdirSync(agentsDir).filter((x) => x.endsWith(".md")).sort()) {
			const base = f.slice(0, -3);
			fileNames.add(base);
			const rel = `agent/agents/${f}`;
			let fm;
			try {
				fm = parseFrontmatter(fsImpl.readFileSync(path.join(agentsDir, f), "utf8")).frontmatter ?? {};
			} catch {
				add("ERROR", "FRONTMATTER_INVALID", rel, "frontmatter could not be parsed");
				continue;
			}
			if (fm.name !== base) add("ERROR", "FRONTMATTER_NAME_MISMATCH", rel, `frontmatter name ${fm.name === undefined ? "missing" : "differs from file name"}`);
			const slot = slotByName.get(base);
			if (slot) checkParity(slot, fm, rel);
		}
	} catch {
		add("ERROR", "FILE_MISSING", "agent/agents", "agents directory missing");
	}
	for (const n of roleNames) if (!fileNames.has(n)) add("ERROR", "ROLE_WITHOUT_AGENT_FILE", "agent/roles.json", `role ${n} has no agents/${n}.md`);
	for (const n of fileNames) if (!roleNames.has(n)) add("ERROR", "AGENT_WITHOUT_ROLE", `agent/agents/${n}.md`, `no role entry for ${n}`);

	const integrations = readJson("agent/extensions/subagent/integrations.json");
	if (integrations && typeof integrations === "object") {
		for (const [key, list] of Object.entries(integrations)) {
			if (!Array.isArray(list)) continue;
			if (key !== "roles") checkGrants(list, "agent/extensions/subagent/integrations.json", key);
			for (const entry of list) {
				if (typeof entry === "string" && entry.includes("*")) add("ERROR", "GRANT_WILDCARD", "agent/extensions/subagent/integrations.json", `${key} contains a wildcard`);
			}
		}
		for (const entry of Array.isArray(integrations.roles) ? integrations.roles : []) {
			if (!roleNames.has(entry)) add("ERROR", "ROLE_UNKNOWN_IN_INTEGRATIONS", "agent/extensions/subagent/integrations.json", `${entry} is not a role`);
		}
	}

	// Absent pi-package/ is the intentional source-only checkout (INFO). Any present entry is validated strictly: a missing or invalid manifest is an ERROR.
	const profilePackagePresent = (() => {
		try {
			fsImpl.lstatSync(path.join(root, "pi-package"));
			return true;
		} catch (error) {
			return error?.code !== "ENOENT";
		}
	})();
	if (profilePackagePresent) readJson("pi-package/package.json");
	else add("INFO", "PACKAGE_ABSENT", "pi-package", "not present: intentional source-only checkout; package checks not applicable");

	const subagentDir = path.join(agentDir, "extensions", "subagent");
	const indexSource = readText(path.join(subagentDir, "index.ts"));
	if (indexSource === undefined || !indexSource.includes("safety-guard-entry.ts") || !indexSource.includes("claimChildGuard")) add("ERROR", "GUARD_NOT_INJECTED", "agent/extensions/subagent/index.ts", "child spawn does not inject the safety guard entry (static source check)");
	if (!exists(path.join(subagentDir, "safety-guard-entry.ts"))) add("ERROR", "GUARD_MISSING", "agent/extensions/subagent/safety-guard-entry.ts", "guard entry module is missing");

	if (packageRoot === undefined) {
		if (profilePackagePresent && !exists(path.join(root, "pi-package", "extensions", "subagent", "safety-guard-entry.ts"))) add("INFO", "PACKAGE_LEGACY_NO_GUARD", "pi-package", "frozen package predates the safety guard; not claimed to contain it; no activation implied");
	} else {
		const pkgDir = path.resolve(root, packageRoot);
		const pkgFile = path.relative(root, pkgDir) || ".";
		let manifest;
		try {
			manifest = JSON.parse(fsImpl.readFileSync(path.join(pkgDir, "package.json"), "utf8"));
		} catch {
			add("ERROR", "PACKAGE_REACHABILITY", pkgFile, "package manifest missing or invalid JSON");
		}
		const entries = Array.isArray(manifest?.pi?.extensions) ? manifest.pi.extensions : [];
		for (const entry of entries) {
			const abs = path.resolve(pkgDir, String(entry));
			if (!abs.startsWith(pkgDir + path.sep)) add("ERROR", "PACKAGE_REACHABILITY", pkgFile, "extension entry escapes the package root");
			else if (!exists(abs)) add("ERROR", "PACKAGE_REACHABILITY", pkgFile, "extension entry missing from package");
		}
		for (const req of ["extensions/subagent/safety-guard-entry.ts", "extensions/subagent/safety-core.ts"]) if (!exists(path.join(pkgDir, req))) add("ERROR", "PACKAGE_REACHABILITY", pkgFile, `${req} missing from package`);
	}

	const errors = findings.filter((f) => f.level === "ERROR").length;
	return { root, errors, findings };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const at = process.argv.indexOf("--root");
	const pk = process.argv.indexOf("--package");
	const report = scanHarnessConfig({ root: at > 0 ? path.resolve(process.argv[at + 1]) : defaultRoot, packageRoot: pk > 0 ? process.argv[pk + 1] : undefined });
	process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
	process.exitCode = report.errors ? 1 : 0;
}
