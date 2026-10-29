// Benchmark role resolution from the authoritative registry: the candidate's package agent/roles.json overlaid by the user's
// roles.json in the agent directory (same role name: fields replace, modelTiers replace atomically). Unsupported shapes fail
// closed; nothing falls back to a literal value. Mirrors the tier contract in agent/extensions/subagent/agents.ts for the
// fields the benchmark reads (no import: that module loads Pi at import time).
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const TIERS = ["economy", "capable"];
const THINKING = ["off", "minimal", "low", "medium", "high", "xhigh"];
const QUALIFIED = /^[^\s/]+\/\S+$/;
const isObject = (v) => typeof v === "object" && v !== null && !Array.isArray(v);

function readRegistry(file) {
	if (!fs.existsSync(file)) return null;
	const bytes = fs.readFileSync(file);
	let parsed;
	try { parsed = JSON.parse(bytes.toString("utf8")); } catch (e) { throw new Error(`${file} is not valid JSON: ${e.message}`); }
	if (!Array.isArray(parsed)) throw new Error(`${file} must be a JSON list of roles`);
	return { file, sha256: crypto.createHash("sha256").update(bytes).digest("hex"), entries: parsed };
}

// The effective view: a role's package entry overlaid by the user entry; origin(key) says which file supplied a field.
export function loadEffectiveRoles({ candidateRoot, agentDir }) {
	const pkg = readRegistry(path.join(candidateRoot, "agent", "roles.json"));
	if (!pkg) throw new Error(`candidate package roles.json is missing: ${path.join(candidateRoot, "agent", "roles.json")}`);
	const user = agentDir ? readRegistry(path.join(agentDir, "roles.json")) : null;
	const find = (list, name) => list.find((e) => isObject(e) && e.name === name);
	const role = (name) => {
		const base = find(pkg.entries, name);
		const over = user ? find(user.entries, name) : undefined;
		if (!base && !over) return null;
		const origin = (key) => (over && key in over ? "user" : "package");
		return { name, entry: { ...(base ?? {}), ...(over ?? {}) }, origin };
	};
	return { files: { package: { path: pkg.file, sha256: pkg.sha256 }, user: user ? { path: user.file, sha256: user.sha256 } : null }, role };
}

function tierModel(name, entry, origin) {
	if ("provider" in entry || "model" in entry || "fallbackModel" in entry || "thinking" in entry) throw new Error(`role "${name}" uses the legacy provider/model shape, which the benchmark does not resolve (unsupported)`);
	const tier = entry.defaultModelTier;
	if (!TIERS.includes(tier)) throw new Error(`role "${name}" defaultModelTier must be economy or capable, got ${JSON.stringify(tier)}`);
	const def = isObject(entry.modelTiers) ? entry.modelTiers[tier] : undefined;
	if (!isObject(def)) throw new Error(`role "${name}" defaultModelTier "${tier}" is not configured in modelTiers`);
	if (typeof def.model !== "string" || !QUALIFIED.test(def.model)) throw new Error(`role "${name}" tier "${tier}" model must be provider/id`);
	if (typeof def.fallbackModel !== "string") throw new Error(`role "${name}" tier "${tier}" fallbackModel must be a string`);
	const fallbacks = [...new Set(def.fallbackModel.split("||").map((m) => m.trim()).filter(Boolean))];
	if (fallbacks.some((m) => !QUALIFIED.test(m))) throw new Error(`role "${name}" tier "${tier}" fallbackModel entries must be provider/id`);
	if (!THINKING.includes(def.thinking)) throw new Error(`role "${name}" tier "${tier}" thinking must be one of ${THINKING.join(", ")}`);
	const model = def.model.trim();
	const tierOrigin = origin("defaultModelTier") === "user" || origin("modelTiers") === "user" ? "user" : "package";
	return { tier, model, fallbacks: fallbacks.filter((m) => m !== model), thinking: def.thinking, tierOrigin };
}

// Reviewer: the role's own default tier (no benchmark-side override). Returns the configured spec with its source.
export function resolveReviewerSpec(effective) {
	const r = effective.role("reviewer");
	if (!r) throw new Error(`role "reviewer" is not in roles.json`);
	const t = tierModel("reviewer", r.entry, r.origin);
	const tools = typeof r.entry.tools === "string" ? r.entry.tools.split(",").map((s) => s.trim()).filter(Boolean) : [];
	if (tools.length === 0) throw new Error(`role "reviewer" tools must be a comma-separated list in roles.json`);
	return { role: "reviewer", tier: t.tier, model: t.model, fallbacks: t.fallbacks, thinking: t.thinking, tools, source: `${t.tierOrigin} roles.json role reviewer tier ${t.tier}` };
}

// Rework cap default: the general-worker role's maxReworkRounds (the writer that performs rework), validated, never literal.
export function writerReworkDefault(effective, role = "general-worker") {
	const r = effective.role(role);
	if (!r) throw new Error(`role "${role}" is not in roles.json`);
	const v = r.entry.maxReworkRounds;
	if (!Number.isInteger(v) || v < 0) throw new Error(`role "${role}" maxReworkRounds must be a whole number >= 0 in roles.json, got ${JSON.stringify(v ?? null)}`);
	return { value: v, source: `${r.origin("maxReworkRounds")} roles.json role ${role}` };
}

const checkCap = (cap, label, key) => {
	if (!isObject(cap) || !Number.isInteger(cap.value) || cap.value < 0) throw new Error(`${label} ${key} must be {value: whole number >= 0, source}`);
	if (typeof cap.source !== "string" || cap.source.trim() === "") throw new Error(`${label} ${key} source is required`);
	return cap;
};

// Diagnostic text cap default: the general-worker role's diagnosticChars (config only), validated, never a literal.
export function writerDiagnosticDefault(effective, role = "general-worker") {
	const r = effective.role(role);
	if (!r) throw new Error(`role "${role}" is not in roles.json`);
	const v = r.entry.diagnosticChars;
	if (!Number.isInteger(v) || v < 0) throw new Error(`role "${role}" diagnosticChars must be a whole number >= 0 in roles.json, got ${JSON.stringify(v ?? null)}`);
	return { value: v, source: `${r.origin("diagnosticChars")} roles.json role ${role}` };
}

// Time limits (whole milliseconds > 0) for the writer-role benchmark policy: round settlement timeout and shutdown grace. Config only; never a literal.
export function writerLimitDefault(effective, key, role = "general-worker") {
	const r = effective.role(role);
	if (!r) throw new Error(`role "${role}" is not in roles.json`);
	const v = r.entry[key];
	if (!Number.isInteger(v) || v < 1) throw new Error(`role "${role}" ${key} must be a whole number of milliseconds > 0 in roles.json, got ${JSON.stringify(v ?? null)}`);
	return { value: v, source: `${r.origin(key)} roles.json role ${role}` };
}

// Precedence (most specific wins) for any benchmark cap: manifest task override > run flag > roles.json default. The winning source is returned.
export function resolveCap(key, { taskOverride, runFlag, roleDefault } = {}) {
	if (roleDefault === undefined) throw new Error(`roleDefault is required: the ${key} cap has no literal default`);
	if (taskOverride !== undefined) return checkCap(taskOverride, "task", key);
	if (runFlag !== undefined) return checkCap(runFlag, "run", key);
	return checkCap(roleDefault, "roles.json", key);
}
export const resolveReworkCap = (args = {}) => resolveCap("maxReworkRounds", args);
export const resolveDiagnosticChars = (args = {}) => resolveCap("diagnosticChars", args);

// The configured identities for one benchmark run. main is supplied by the adapter (profile default registry).
export function resolveBenchmarkRoles({ candidateRoot, agentDir, main }) {
	const effective = loadEffectiveRoles({ candidateRoot, agentDir });
	if (!isObject(main) || typeof main.model !== "string" || !QUALIFIED.test(main.model)) throw new Error("main model must be a provider/id model from the profile default");
	return {
		main,
		reviewer: resolveReviewerSpec(effective),
		writer: { role: "general-worker", ...writerReworkDefault(effective), diagnosticChars: writerDiagnosticDefault(effective), roundSettleTimeoutMs: writerLimitDefault(effective, "roundSettleTimeoutMs"), shutdownGraceMs: writerLimitDefault(effective, "shutdownGraceMs"), taskTimeoutMs: writerLimitDefault(effective, "taskTimeoutMs") },
		files: effective.files,
	};
}
