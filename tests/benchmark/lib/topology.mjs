// Agent topology: do the canonical package roles really resolve as PACKAGE roles for the exact runtime a session would load? Pure: the native discoverAgents and
// resolveModelTier are injected (the adapter supplies the real ones), so this module holds no routing or tier policy of its own and imports no Pi code.
// The old content-hash shadowing check misses physically separate byte-identical copies, which native discovery treats as user overrides (and then refuses
// every explicit modelTier). The result is an allowlist: names, kinds, scopes and paths only; never a prompt, an argument, a raw error or an env value.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { loadEffectiveRoles } from "./roles.mjs";

export const TOPOLOGY_METHOD = "agent-topology/1";
// The ONLY reasons a check that cannot run may state: a fixed enum with fixed text. A thrown error is trusted only when it carries one of these codes (set by this
// package's own loader); any other error, whatever its message, is reported as topology_check_failed with no text, cause or stack copied.
export const TOPOLOGY_REASONS = {
	no_sdk_root: "the agent topology check needs an explicit piPackageRoot (the installed Pi SDK)",
	sdk_missing: "the agent topology check needs the installed Pi SDK, which was not found at the given root",
	extension_files_missing: "the extension directory lacks agents.ts or model-routing.ts",
	no_register_hooks: "the agent topology check is blocked: this Node has no module.registerHooks",
	native_import_failed: "the candidate's native agent helpers failed to import",
};
export const topologyError = (reason) => Object.assign(new Error(TOPOLOGY_REASONS[reason]), { topologyReason: reason });
export const safeTopologyReason = (e) => (typeof e?.topologyReason === "string" && Object.hasOwn(TOPOLOGY_REASONS, e.topologyReason) ? e.topologyReason : null);
// The native default agentScope is "user"; "both" adds the nearest project agents directory above the cwd.
export const TOPOLOGY_SCOPES = ["user", "both"];
const sha256 = (text) => crypto.createHash("sha256").update(text).digest("hex");
const same = (a, b) => (process.platform === "win32" ? path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase() : path.resolve(a) === path.resolve(b));

// The canonical roles and their configured tiers come from the candidate's roles.json (overlaid by the profile's, as the native registry does).
function canonicalRoles(candidateRoot, agentDir) {
	const effective = loadEffectiveRoles({ candidateRoot, agentDir });
	const names = JSON.parse(fs.readFileSync(effective.files.package.path, "utf8")).map((e) => e?.name).filter((n) => typeof n === "string");
	return names.map((name) => {
		const entry = effective.role(name).entry;
		const tiers = Object.fromEntries(Object.entries(entry.modelTiers ?? {}).map(([t, d]) => [t, { model: String(d?.model ?? "").trim(), thinking: d?.thinking }]));
		return { name, defaultTier: entry.defaultModelTier, tiers };
	});
}

export function checkAgentTopology({ candidateRoot, extensionEntry, discover, resolveTier, cwd, agentDir = null, scopes = TOPOLOGY_SCOPES, env = process.env }) {
	const names = Object.keys(env).filter((k) => /_CODING_AGENT_DIR$/.test(k) && env[k]);
	const result = { method: TOPOLOGY_METHOD, ok: false, scopes: scopes.slice(), effectiveAgentDir: agentDir ? path.resolve(agentDir) : null, envOverride: { present: names.length > 0, names }, cwd: cwd ?? null, projectAgentDir: null, extensionEntry: extensionEntry ?? null, canonical: [], agents: {}, problems: [], fingerprint: null };
	const problems = result.problems;
	try {
		const agentsDir = path.join(path.resolve(candidateRoot), "agent", "agents");
		const roles = canonicalRoles(candidateRoot, agentDir);
		result.canonical = roles.map((r) => ({ name: r.name, tiers: ["default", ...Object.keys(r.tiers)] }));
		const rel = (file) => { const r = path.relative(agentsDir, file); return r && !r.startsWith("..") && !path.isAbsolute(r) ? `agent/agents/${r.split(path.sep).join("/")}` : String(file); };
		for (const scope of scopes) {
			result.agents[scope] = [];
			let found;
			try { found = discover(cwd, scope); } catch { found = { error: true }; }
			if (found.error) { problems.push({ kind: "discovery_error", scope }); continue; }
			result.projectAgentDir = found.projectAgentsDir ?? result.projectAgentDir;
			for (const role of roles) {
				const agent = found.agents.find((a) => a.name === role.name);
				if (!agent) { problems.push({ kind: "agent_missing", scope, role: role.name }); continue; }
				const where = { scope, role: role.name, source: agent.source, file: rel(agent.filePath) };
				result.agents[scope].push({ name: role.name, source: agent.source, file: where.file });
				if (agent.source === "project") { problems.push({ kind: "agent_source_project_override", ...where }); continue; }
				if (agent.source !== "package" || !same(path.dirname(agent.filePath), agentsDir) || path.basename(agent.filePath) !== `${role.name}.md`) { problems.push({ kind: "agent_source_shadowed", ...where }); continue; }
				for (const tier of ["default", ...Object.keys(role.tiers)]) {
					const want = role.tiers[tier === "default" ? role.defaultTier : tier];
					let got = null;
					try { got = resolveTier(agent, tier === "default" ? undefined : tier); } catch { /* the reason is never recorded */ }
					if (!want || !got || got.model !== want.model || got.thinking !== want.thinking) problems.push({ kind: "tier_unresolved", scope, role: role.name, tier });
				}
			}
		}
	} catch {
		problems.push({ kind: "topology_check_failed" });
	}
	result.ok = problems.length === 0 && result.canonical.length > 0;
	result.fingerprint = sha256(JSON.stringify({ method: result.method, scopes: result.scopes, canonical: result.canonical, agents: result.agents, ok: result.ok }));
	return result;
}

// One line per distinct problem for an error message (kinds, scopes and role names only), bounded.
export function describeProblems(topology, max = 6) {
	const lines = [...new Set((topology?.problems ?? []).map((p) => [p.kind, p.scope, p.role, p.tier].filter(Boolean).join(":")))];
	return lines.slice(0, max).join(", ") + (lines.length > max ? `, +${lines.length - max} more` : "");
}
