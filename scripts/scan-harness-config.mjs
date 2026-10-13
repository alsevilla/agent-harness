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
const TOOLS_KEYS = ["provider", "model", "thinking", "tools"];
const TOOL_NAME = /^[a-z][a-z0-9_]*$/;
const ROLE_NAME = /^[A-Za-z0-9_-]{1,64}$/;
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
	const checkParity = (role, fm, file) => {
		const normTools = (v) => (typeof v === "string" ? v.split(",").map((s) => s.trim()).filter(Boolean).join(", ") : "");
		const fields = [
			["model", `${role.provider}/${role.model}`, fm.model],
			["fallbackModel", role.fallbackModel ?? "", fm.fallbackModel ?? ""],
			["thinking", role.thinking ?? "", fm.thinking ?? ""],
			["tools", normTools(role.tools), normTools(fm.tools)],
		];
		for (const [label, expected, actual] of fields) if (String(expected) !== String(actual)) add("ERROR", "PARITY_MISMATCH", file, `frontmatter field ${label} differs from roles.json`);
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
	const roleByName = new Map();
	if (Array.isArray(roles)) {
		for (const [i, r] of roles.entries()) {
			if (!r || typeof r !== "object" || typeof r.name !== "string" || !r.name) {
				add("ERROR", "ROLE_SHAPE", "agent/roles.json", `entry ${i} has no name`);
				continue;
			}
			if (!ROLE_NAME.test(r.name)) add("ERROR", "UNSAFE_PATH", "agent/roles.json", `entry ${i} has an unsafe role name`);
			if (roleNames.has(r.name)) add("ERROR", "ROLE_DUPLICATE", "agent/roles.json", `duplicate role ${r.name}`);
			roleNames.add(r.name);
			if (!roleByName.has(r.name)) roleByName.set(r.name, r);
			for (const key of TOOLS_KEYS) {
				if (typeof r[key] !== "string" || !r[key].trim()) add("ERROR", "ROLE_SHAPE", "agent/roles.json", `${r.name}.${key} must be a non-empty string`);
			}
			if (typeof r.fallbackModel !== "string") add("ERROR", "ROLE_SHAPE", "agent/roles.json", `${r.name}.fallbackModel must be a string (may be empty)`);
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
			const role = roleByName.get(base);
			if (role) checkParity(role, fm, rel);
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
