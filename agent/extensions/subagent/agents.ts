/**
 * Agent discovery and configuration
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { CONFIG_DIR_NAME, getAgentDir, parseFrontmatter } from "@earendil-works/pi-coding-agent";
import { parseFallbackModels } from "./model-routing.ts";

export type AgentScope = "user" | "project" | "both";
export type ModelTier = "economy" | "capable";
export interface TierModelConfig { model: string; fallbackModel: string[]; }

export interface AgentConfig {
	name: string;
	description: string;
	tools?: string[];
	model?: string;
	fallbackModel?: string[];
	thinking?: string;
	systemPrompt: string;
	source: "user" | "project" | "package";
	filePath: string;
	modelTiers?: Partial<Record<ModelTier, TierModelConfig>>;
}

export interface AgentDiscoveryResult {
	agents: AgentConfig[];
	projectAgentsDir: string | null;
	/** Package-mode failure: the baseline or user registry cannot be trusted, so no agents are offered. */
	error?: string;
}

/**
 * Raw agent frontmatter. Values are `unknown` because `parseFrontmatter` runs a
 * real YAML parser, so any scalar or collection can appear here.
 *
 * A type alias rather than an interface: `parseFrontmatter` constrains its
 * parameter to `Record<string, unknown>`, and only an alias picks up the
 * implicit index signature that satisfies it.
 */
type AgentFrontmatter = {
	name?: unknown;
	description?: unknown;
	tools?: unknown;
	model?: unknown;
	fallbackModel?: unknown;
	thinking?: unknown;
	metadata?: unknown;
};

/**
 * Normalize a frontmatter `tools` value to a list of tool names.
 *
 * Both spellings are valid YAML and both are in use:
 *
 *     tools: read, bash        # string
 *     tools: [read, bash]      # array
 *
 * so accept either. Anything else (a number, a map, a nested list) yields no
 * tools rather than throwing: this runs inside agent discovery, where a single
 * bad file must not take down every other agent in the same directory.
 */
function parseToolList(value: unknown): string[] | undefined {
	const raw = Array.isArray(value) ? value : typeof value === "string" ? value.split(",") : [];
	const tools = raw
		.filter((t): t is string => typeof t === "string")
		.map((t) => t.trim())
		.filter(Boolean);
	return tools.length > 0 ? tools : undefined;
}

/** Fields roles.json defines for a user role; an omitted field keeps the definition file's frontmatter value. */
interface RoleOverride {
	model?: string;
	fallbackModel?: string[];
	modelTiers?: Partial<Record<ModelTier, TierModelConfig>>;
	thinking?: string;
	tools?: string[];
}

const ROLE_KEYS = ["name", "provider", "model", "fallbackModel", "modelTiers", "thinking", "tools"];
const ROLE_TEXT_KEYS = ["provider", "model", "fallbackModel", "thinking"];
const TIER_KEYS = ["economy", "capable"];
const TIER_MODEL_KEYS = ["provider", "model", "fallbackModel"];

/**
 * Shared roles.json contract for package defaults, package user overrides and the roles editor.
 * Returns the first violation (without a file label) or null. `complete` also requires the four text fields, which the editor writes.
 */
export function roleRegistryViolation(registry: unknown, complete = false): string | null {
	if (!Array.isArray(registry)) return "must be a JSON list of roles";
	const names = new Set<string>();
	for (const [index, role] of registry.entries()) {
		if (typeof role !== "object" || role === null || Array.isArray(role)) return `entry ${index} is not an object`;
		const entry = role as Record<string, unknown>;
		const unknown = Object.keys(entry).filter((key) => !ROLE_KEYS.includes(key));
		if (unknown.length > 0) return `entry ${index} has unknown key ${unknown.join(", ")}`;
		if (typeof entry.name !== "string" || entry.name.trim() === "") return `entry ${index} needs a non-empty string name`;
		for (const key of ROLE_TEXT_KEYS) {
			if (entry[key] === undefined && !complete) continue;
			if (typeof entry[key] !== "string") return `entry ${index} has a ${complete ? "missing or " : ""}non-string ${key}`;
		}
		if (entry.modelTiers !== undefined) {
			if (typeof entry.modelTiers !== "object" || entry.modelTiers === null || Array.isArray(entry.modelTiers)) return `entry ${index} has invalid modelTiers`;
			for (const [tier, definition] of Object.entries(entry.modelTiers as Record<string, unknown>)) {
				if (!TIER_KEYS.includes(tier)) return `entry ${index} has unknown modelTiers key ${tier}`;
				if (typeof definition !== "object" || definition === null || Array.isArray(definition)) return `entry ${index} has invalid modelTiers.${tier}`;
				const model = definition as Record<string, unknown>;
				const unknownModelKeys = Object.keys(model).filter((key) => !TIER_MODEL_KEYS.includes(key));
				if (unknownModelKeys.length) return `entry ${index} modelTiers.${tier} has unknown key ${unknownModelKeys.join(", ")}`;
				if (typeof model.provider !== "string" || !model.provider.trim() || typeof model.model !== "string" || !model.model.trim() || typeof model.fallbackModel !== "string" || !parseFallbackModels(model.fallbackModel).length) return `entry ${index} has invalid modelTiers.${tier} provider, model or fallbackModel`;
			}
		}
		const tools = entry.tools;
		if (tools !== undefined && typeof tools !== "string" && !(Array.isArray(tools) && tools.every((t) => typeof t === "string"))) return `entry ${index} has invalid tools (a string or a list of strings)`;
		if (names.has(entry.name)) return `duplicate role name: ${entry.name}`;
		names.add(entry.name);
	}
	return null;
}

/**
 * roles.json is the canonical registry for user roles: provider + model are joined into one catalog ID.
 * With a label (package mode) a missing-when-required, unreadable, non-list or invalid registry is an error; without one (live layout) it stays silent.
 */
function loadRoleRegistry(file: string, label?: string, missingOk = false): { roles: Map<string, RoleOverride>; error?: string } {
	const roles = new Map<string, RoleOverride>();
	let registry: unknown;
	try {
		registry = JSON.parse(fs.readFileSync(file, "utf-8"));
	} catch (error) {
		if (!label) return { roles };
		const missing = (error as { code?: unknown }).code === "ENOENT";
		if (missing && missingOk) return { roles };
		return { roles, error: `${label} is ${missing ? "missing" : "unreadable or not valid JSON"}: ${file}` };
	}
	if (label) {
		const violation = roleRegistryViolation(registry);
		if (violation) return { roles, error: `${label} ${violation}: ${file}` };
	}
	if (!Array.isArray(registry)) return { roles };
	for (const role of registry) {
		if (typeof role !== "object" || role === null) continue;
		const entry = role as { name?: unknown; provider?: unknown; model?: unknown; fallbackModel?: unknown; modelTiers?: unknown; thinking?: unknown; tools?: unknown };
		if (typeof entry.name !== "string") continue;
		const model = typeof entry.model === "string" ? entry.model.trim() : "";
		const modelTiers: Partial<Record<ModelTier, TierModelConfig>> = {};
		if (entry.modelTiers && typeof entry.modelTiers === "object" && !Array.isArray(entry.modelTiers)) {
			for (const [tier, definition] of Object.entries(entry.modelTiers as Record<string, { provider?: unknown; model?: unknown; fallbackModel?: unknown }>)) {
				if (!TIER_KEYS.includes(tier) || typeof definition !== "object" || definition === null || Array.isArray(definition) || typeof definition.provider !== "string" || typeof definition.model !== "string" || typeof definition.fallbackModel !== "string") continue;
				const tierModel = definition.model.trim();
				modelTiers[tier as ModelTier] = {
					model: tierModel && !tierModel.includes("/") ? `${definition.provider}/${tierModel}` : tierModel,
					fallbackModel: parseFallbackModels(definition.fallbackModel),
				};
			}
		}
		roles.set(entry.name, {
			model: model && typeof entry.provider === "string" && !model.includes("/") ? `${entry.provider}/${model}` : model || undefined,
			fallbackModel: typeof entry.fallbackModel === "string" ? parseFallbackModels(entry.fallbackModel) : undefined,
			modelTiers: entry.modelTiers !== undefined ? modelTiers : undefined,
			thinking: typeof entry.thinking === "string" ? entry.thinking : undefined,
			tools: parseToolList(entry.tools),
		});
	}
	return { roles };
}

function loadAgentsFromDir(
	dir: string,
	source: "user" | "project" | "package",
	roles: ReadonlyMap<string, RoleOverride> = new Map(),
): AgentConfig[] {
	const agents: AgentConfig[] = [];

	if (!fs.existsSync(dir)) {
		return agents;
	}

	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return agents;
	}

	for (const entry of entries) {
		if (!entry.name.endsWith(".md")) continue;
		if (!entry.isFile() && !entry.isSymbolicLink()) continue;

		const filePath = path.join(dir, entry.name);
		let content: string;
		try {
			content = fs.readFileSync(filePath, "utf-8");
		} catch {
			continue;
		}

		const { frontmatter, body } = parseFrontmatter<AgentFrontmatter>(content);

		if (typeof frontmatter.name !== "string" || typeof frontmatter.description !== "string") {
			continue;
		}

		const role = roles.get(frontmatter.name);
		const metadata = typeof frontmatter.metadata === "object" && frontmatter.metadata !== null && !Array.isArray(frontmatter.metadata)
			? frontmatter.metadata as Record<string, unknown>
			: {};
		const annotation = (key: string) => metadata[`pi.${key}`];
		const invalidAnnotation = ["tools", "model", "fallbackModel", "thinking"].find((key) => {
			if (!("pi." + key in metadata)) return false;
			const value = annotation(key);
			if (typeof value !== "string" || (key !== "fallbackModel" && value.trim() === "")) return true;
			if (key === "tools" && parseToolList(value) === undefined) return true;
			return key === "thinking" && !["off", "minimal", "low", "medium", "high", "xhigh"].includes(value);
		});
		if (invalidAnnotation) {
			console.error(`Skipping agent ${frontmatter.name}: invalid metadata pi.${invalidAnnotation}`);
			continue;
		}
		const annotationText = (key: string) => annotation(key) as string | undefined;
		const fallbackAnnotation = annotationText("fallbackModel");
		agents.push({
			name: frontmatter.name,
			description: frontmatter.description,
			tools: role?.tools ?? parseToolList(annotationText("tools") ?? frontmatter.tools),
			model: role?.model ?? annotationText("model") ?? (typeof frontmatter.model === "string" ? frontmatter.model : undefined),
			fallbackModel:
				role?.fallbackModel ??
				(fallbackAnnotation !== undefined ? parseFallbackModels(fallbackAnnotation) :
					(typeof frontmatter.fallbackModel === "string" ? parseFallbackModels(frontmatter.fallbackModel) : undefined)),
			modelTiers: role?.modelTiers,
			thinking: role?.thinking ?? annotationText("thinking") ?? (typeof frontmatter.thinking === "string" ? frontmatter.thinking : undefined),
			systemPrompt: body,
			source,
			filePath,
		});
	}

	return agents;
}

function isDirectory(p: string): boolean {
	try {
		return fs.statSync(p).isDirectory();
	} catch {
		return false;
	}
}

function findNearestProjectAgentsDir(cwd: string): string | null {
	let currentDir = cwd;
	while (true) {
		const candidate = path.join(currentDir, CONFIG_DIR_NAME, "agents");
		if (isDirectory(candidate)) return candidate;

		const parentDir = path.dirname(currentDir);
		if (parentDir === currentDir) return null;
		currentDir = parentDir;
	}
}

const PACKAGE_NAME = "@alsevilla/pi-engineering-harness";

/**
 * Native package mode is decided by the root package.json beside agent/ (this file's resource root). Only the exact package name is protected:
 * a renamed manifest is inert (null). No manifest is the live profile (agent/ with no package above it) and stays silent.
 * An unreadable manifest fails closed.
 */
function packageLayout(): { root: string | null; error?: string } {
	const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
	const manifest = path.join(root, "..", "package.json");
	let parsed: { name?: unknown } | null;
	try {
		parsed = JSON.parse(fs.readFileSync(manifest, "utf-8"));
	} catch (error) {
		if ((error as { code?: unknown }).code === "ENOENT") return { root: null };
		return { root: null, error: `package manifest is unreadable or not valid JSON: ${manifest}` };
	}
	return { root: parsed?.name === PACKAGE_NAME ? root : null };
}

/** Native package resource root (agent/), verified by the root manifest name; null in the live profile, so live discovery is unchanged. */
export function packageRoot(): string | null {
	return packageLayout().root;
}

export function discoverAgents(cwd: string, scope: AgentScope): AgentDiscoveryResult {
	const userDir = path.join(getAgentDir(), "agents");
	const projectAgentsDir = findNearestProjectAgentsDir(cwd);
	const layout = packageLayout();
	const pkgRoot = layout.root;
	const userRegistry = loadRoleRegistry(path.join(getAgentDir(), "roles.json"), pkgRoot || layout.error ? "user roles.json" : undefined, true);
	const roles = userRegistry.roles;
	let error = layout.error ?? userRegistry.error;
	// Package tier: the bundled roles.json is the base; user roles.json fields override it field-wise.
	const packageRoles = new Map<string, RoleOverride>();
	let shipped: AgentConfig[] = [];
	if (pkgRoot) {
		const base = loadRoleRegistry(path.join(pkgRoot, "roles.json"), "package roles.json");
		error = error ?? base.error;
		if (!isDirectory(path.join(pkgRoot, "agents"))) error = error ?? `package agents directory is missing: ${pkgRoot}`;
		for (const [name, baseRole] of base.roles) {
			const user = roles.get(name);
			packageRoles.set(name, {
				model: user?.model ?? baseRole.model,
				fallbackModel: user?.fallbackModel ?? baseRole.fallbackModel,
				modelTiers: user?.modelTiers ?? baseRole.modelTiers,
				thinking: user?.thinking ?? baseRole.thinking,
				tools: user?.tools ?? baseRole.tools,
			});
		}
		shipped = loadAgentsFromDir(path.join(pkgRoot, "agents"), "package", packageRoles);
		// Every declared role needs exactly one parsed definition, and no parsed definition may be undeclared (an empty set is never valid).
		const declared = [...base.roles.keys()].sort();
		const defined = shipped.map((a) => a.name).sort();
		if (!error && (declared.length === 0 || JSON.stringify(declared) !== JSON.stringify(defined))) error = `package roles.json and agents disagree on role names: ${pkgRoot}`;
	}

	const packageAgents = scope === "project" ? [] : shipped;
	const userAgents = scope === "project" ? [] : loadAgentsFromDir(userDir, "user", roles);
	const projectAgents = scope === "user" || !projectAgentsDir ? [] : loadAgentsFromDir(projectAgentsDir, "project");

	const agentMap = new Map<string, AgentConfig>();

	// Lowest tier first: a later tier with the same name replaces the earlier one (package defaults < user < project).
	if (scope === "both") {
		for (const agent of [...packageAgents, ...userAgents, ...projectAgents]) agentMap.set(agent.name, agent);
	} else if (scope === "user") {
		for (const agent of [...packageAgents, ...userAgents]) agentMap.set(agent.name, agent);
	} else {
		for (const agent of projectAgents) agentMap.set(agent.name, agent);
	}

	// Project scope never reads the package or user registries, so their failures are not reported there.
	if (error && scope !== "project") return { agents: [], projectAgentsDir, error };
	return { agents: Array.from(agentMap.values()), projectAgentsDir };
}

export function formatAgentList(agents: AgentConfig[], maxItems: number): { text: string; remaining: number } {
	if (agents.length === 0) return { text: "none", remaining: 0 };
	const listed = agents.slice(0, maxItems);
	const remaining = agents.length - listed.length;
	return {
		text: listed.map((a) => `${a.name} (${a.source}): ${a.description}`).join("; "),
		remaining,
	};
}
