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
export type TierThinking = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
/** Canonical tier: qualified model, normalized fallback chain ([] for "") and an explicit thinking level. */
export interface TierModelConfig { model: string; fallbackModel: string[]; thinking: TierThinking; }
/** Bounded legacy external per-tier view: no effort of its own, so it inherits the flat role thinking. */
export interface LegacyTierModelConfig { model: string; fallbackModel: string[]; }

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
	defaultModelTier?: ModelTier;
	modelTiers?: Partial<Record<ModelTier, TierModelConfig | LegacyTierModelConfig>>;
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

/** Fields roles.json defines for a role; an omitted field keeps the lower-precedence value. */
interface RoleOverride {
	model?: string;
	fallbackModel?: string[];
	defaultModelTier?: ModelTier;
	modelTiers?: Partial<Record<ModelTier, TierModelConfig | LegacyTierModelConfig>>;
	thinking?: string;
	tools?: string[];
	/** Legacy scalar or per-tier provider entry: keeps the flat omission projection and no default tier. */
	legacy?: boolean;
}

const ROLE_KEYS = ["name", "defaultModelTier", "provider", "model", "fallbackModel", "modelTiers", "thinking", "tools", "maxReworkRounds", "diagnosticChars", "roundSettleTimeoutMs", "shutdownGraceMs", "taskTimeoutMs"];
const ROLE_TEXT_KEYS = ["provider", "model", "fallbackModel", "thinking"];
const LEGACY_ROLE_KEYS = ["provider", "model", "fallbackModel", "thinking"];
const TIER_KEYS = ["economy", "capable"];
const TIER_MODEL_KEYS = ["provider", "model", "fallbackModel"];
const TIER_CANONICAL_KEYS = ["model", "fallbackModel", "thinking"];
const TIER_THINKING: readonly TierThinking[] = ["off", "minimal", "low", "medium", "high", "xhigh"];
/** Exact provider/id: nonempty provider, nonempty id, no whitespace; ids may contain further slashes. */
const QUALIFIED_MODEL = /^[^\s/]+\/\S+$/;

/**
 * Shared roles.json contract for package defaults, package user overrides and the roles editor.
 * Returns the first violation (without a file label) or null. `complete` also requires the four text fields, which the editor writes.
 */
function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Canonical tier entries carry no provider. Legacy scalar or per-tier provider fields belong to the bounded compatibility path.
 * Mixing both in one entry is an error, never a fallthrough to the other shape or to Markdown annotations.
 */
export function entryFormat(entry: Record<string, unknown>): "legacy" | "tier" | "neutral" | "mixed" {
	const values = isPlainObject(entry.modelTiers) ? Object.values(entry.modelTiers) : [];
	const legacy = LEGACY_ROLE_KEYS.some((key) => key in entry) || values.some((value) => isPlainObject(value) && "provider" in value);
	const tier = "defaultModelTier" in entry || values.some((value) => !isPlainObject(value) || !("provider" in value) || "thinking" in value);
	if (legacy && tier) return "mixed";
	return tier ? "tier" : legacy ? "legacy" : "neutral";
}

// Shortcut: fallbackModel is "" (no chain) or ||-separated provider/id tokens with no blank tokens; upgrade if tokens may hold spaces.
function parseQualifiedFallbacks(value: string): string[] | undefined {
	if (value === "") return [];
	const tokens = value.split("||").map((token) => token.trim());
	return tokens.every((token) => QUALIFIED_MODEL.test(token)) ? [...new Set(tokens)] : undefined;
}

function tierViolation(index: number, tier: string, definition: unknown): string | null {
	const at = `entry ${index} modelTiers.${tier}`;
	if (!isPlainObject(definition)) return `${at} must be an object`;
	const unknown = Object.keys(definition).filter((key) => !TIER_CANONICAL_KEYS.includes(key));
	if (unknown.length) return `${at} has unknown key ${unknown.join(", ")}`;
	if (typeof definition.model !== "string" || !QUALIFIED_MODEL.test(definition.model)) return `${at}.model must be a provider/id model`;
	if (typeof definition.fallbackModel !== "string" || parseQualifiedFallbacks(definition.fallbackModel) === undefined) return `${at}.fallbackModel must be "" or provider/id models separated by ||`;
	if (typeof definition.thinking !== "string" || !TIER_THINKING.includes(definition.thinking as TierThinking)) return `${at}.thinking must be one of ${TIER_THINKING.join(", ")}`;
	return null;
}

function tierEntryViolation(index: number, entry: Record<string, unknown>, complete: boolean): string | null {
	if (complete && !("defaultModelTier" in entry)) return `entry ${index} needs defaultModelTier`;
	if ("defaultModelTier" in entry && !TIER_KEYS.includes(entry.defaultModelTier as string)) return `entry ${index} defaultModelTier must be economy or capable`;
	if (!("modelTiers" in entry)) return null;
	if (!isPlainObject(entry.modelTiers)) return `entry ${index} has invalid modelTiers`;
	for (const [tier, definition] of Object.entries(entry.modelTiers)) {
		if (!TIER_KEYS.includes(tier)) return `entry ${index} has unknown modelTiers key ${tier}`;
		const violation = tierViolation(index, tier, definition);
		if (violation) return violation;
	}
	return null;
}

function legacyEntryViolation(index: number, entry: Record<string, unknown>, complete: boolean): string | null {
	for (const key of ROLE_TEXT_KEYS) {
		if (entry[key] === undefined && !complete) continue;
		if (typeof entry[key] !== "string") return `entry ${index} has a ${complete ? "missing or " : ""}non-string ${key}`;
	}
	if (entry.modelTiers !== undefined) {
		if (!isPlainObject(entry.modelTiers)) return `entry ${index} has invalid modelTiers`;
		for (const [tier, definition] of Object.entries(entry.modelTiers)) {
			if (!TIER_KEYS.includes(tier)) return `entry ${index} has unknown modelTiers key ${tier}`;
			if (!isPlainObject(definition)) return `entry ${index} has invalid modelTiers.${tier}`;
			const unknownModelKeys = Object.keys(definition).filter((key) => !TIER_MODEL_KEYS.includes(key));
			if (unknownModelKeys.length) return `entry ${index} modelTiers.${tier} has unknown key ${unknownModelKeys.join(", ")}`;
			if (typeof definition.provider !== "string" || !definition.provider.trim() || typeof definition.model !== "string" || !definition.model.trim() || typeof definition.fallbackModel !== "string" || !parseFallbackModels(definition.fallbackModel).length) return `entry ${index} has invalid modelTiers.${tier} provider, model or fallbackModel`;
		}
	}
	return null;
}

/**
 * Shared roles.json contract for package defaults, package user overrides and the roles editor.
 * Returns the first violation (without a file label) or null. `complete` also requires the four text fields, which the editor writes.
 * `newFormatOnly` checks only canonical tier entries and mixed shapes (live profile: legacy entries stay silent, as before).
 */
export function roleRegistryViolation(registry: unknown, complete = false, newFormatOnly = false): string | null {
	if (!Array.isArray(registry)) return newFormatOnly ? null : "must be a JSON list of roles";
	const names = new Set<string>();
	for (const [index, role] of registry.entries()) {
		if (!isPlainObject(role)) {
			if (newFormatOnly) continue;
			return `entry ${index} is not an object`;
		}
		const format = entryFormat(role);
		if (format === "mixed") return `entry ${index} mixes defaultModelTier or tier thinking with legacy provider, model, fallbackModel or thinking fields`;
		if (newFormatOnly && format !== "tier") continue;
		const unknown = Object.keys(role).filter((key) => !ROLE_KEYS.includes(key));
		if (unknown.length > 0) return `entry ${index} has unknown key ${unknown.join(", ")}`;
		if (typeof role.name !== "string" || role.name.trim() === "") return `entry ${index} needs a non-empty string name`;
		const violation = format === "tier" ? tierEntryViolation(index, role, complete) : legacyEntryViolation(index, role, complete);
		if (violation) return violation;
		const tools = role.tools;
		if (tools !== undefined && typeof tools !== "string" && !(Array.isArray(tools) && tools.every((t) => typeof t === "string"))) return `entry ${index} has invalid tools (a string or a list of strings)`;
		// Optional benchmark policy value (rework cap default for the writer role); validated here, read only by the benchmark.
		if (role.maxReworkRounds !== undefined && !(Number.isInteger(role.maxReworkRounds) && (role.maxReworkRounds as number) >= 0)) return `entry ${index} maxReworkRounds must be a whole number >= 0`;
		// Benchmark policy value (diagnostic text cap for the writer role); validated here, read only by the benchmark.
		if (role.diagnosticChars !== undefined && !(Number.isInteger(role.diagnosticChars) && (role.diagnosticChars as number) >= 0)) return `entry ${index} diagnosticChars must be a whole number >= 0`;
		// Benchmark policy values (round settlement timeout and shutdown grace, whole milliseconds); validated here, read only by the benchmark.
		for (const key of ["roundSettleTimeoutMs", "shutdownGraceMs", "taskTimeoutMs"] as const) if (role[key] !== undefined && !(Number.isInteger(role[key]) && (role[key] as number) >= 1)) return `entry ${index} ${key} must be a whole number of milliseconds >= 1`;
		if (names.has(role.name)) return `duplicate role name: ${role.name}`;
		names.add(role.name);
	}
	return null;
}

/**
 * roles.json is the canonical registry for user roles: provider + model are joined into one catalog ID.
 * With a label (package mode) a missing-when-required, unreadable, non-list or invalid registry is an error; without one (live layout) only malformed new-format entries are errors.
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
	const violation = roleRegistryViolation(registry, false, label === undefined);
	if (violation) return { roles, error: `${label ?? "user roles.json"} ${violation}: ${file}` };
	if (!Array.isArray(registry)) return { roles };
	for (const role of registry) {
		if (!isPlainObject(role) || typeof role.name !== "string") continue;
		roles.set(role.name, normalizeRoleEntry(role));
	}
	return { roles };
}

/** Raw roles.json entry to override shape: tier-format keeps its default and canonical tiers; legacy and neutral keep the flat projection. */
function normalizeRoleEntry(entry: Record<string, unknown>): RoleOverride {
	const format = entryFormat(entry);
	if (format === "tier") {
		return {
			defaultModelTier: entry.defaultModelTier as ModelTier | undefined,
			modelTiers: entry.modelTiers === undefined ? undefined : canonicalTiers(entry.modelTiers),
			tools: parseToolList(entry.tools),
			legacy: false,
		};
	}
	const model = typeof entry.model === "string" ? entry.model.trim() : "";
	const modelTiers: Partial<Record<ModelTier, LegacyTierModelConfig>> = {};
	if (isPlainObject(entry.modelTiers)) {
		for (const [tier, definition] of Object.entries(entry.modelTiers)) {
			if (!TIER_KEYS.includes(tier) || !isPlainObject(definition) || typeof definition.provider !== "string" || typeof definition.model !== "string" || typeof definition.fallbackModel !== "string") continue;
			const tierModel = definition.model.trim();
			modelTiers[tier as ModelTier] = {
				model: tierModel && !tierModel.includes("/") ? `${definition.provider}/${tierModel}` : tierModel,
				fallbackModel: parseFallbackModels(definition.fallbackModel),
			};
		}
	}
	return {
		model: model && typeof entry.provider === "string" && !model.includes("/") ? `${entry.provider}/${model}` : model || undefined,
		fallbackModel: typeof entry.fallbackModel === "string" ? parseFallbackModels(entry.fallbackModel) : undefined,
		modelTiers: entry.modelTiers !== undefined ? modelTiers : undefined,
		thinking: typeof entry.thinking === "string" ? entry.thinking : undefined,
		tools: parseToolList(entry.tools),
		legacy: format === "legacy" ? true : undefined,
	};
}

/** Validated canonical tiers only (roleRegistryViolation runs first): fallback "" becomes [] and no partner is invented. */
function canonicalTiers(value: unknown): Partial<Record<ModelTier, TierModelConfig>> {
	const tiers: Partial<Record<ModelTier, TierModelConfig>> = {};
	if (!isPlainObject(value)) return tiers;
	for (const [tier, definition] of Object.entries(value)) {
		if (!TIER_KEYS.includes(tier) || !isPlainObject(definition)) continue;
		tiers[tier as ModelTier] = {
			model: String(definition.model),
			fallbackModel: parseQualifiedFallbacks(String(definition.fallbackModel)) ?? [],
			thinking: definition.thinking as TierThinking,
		};
	}
	return tiers;
}

/**
 * Effective role: overlay fields replace base fields, and modelTiers replace atomically (explicit {} stays empty, nothing refills).
 * Tier roles derive model, fallbackModel and thinking from the default tier, which must be a configured slot; errors fail closed before annotations.
 */
function resolveRole(name: string, base: RoleOverride | undefined, overlay: RoleOverride = {}): { role: RoleOverride; error?: string } {
	const legacy = (overlay.legacy ?? base?.legacy) === true;
	const defaultModelTier = legacy ? undefined : overlay.defaultModelTier ?? base?.defaultModelTier;
	const modelTiers = overlay.modelTiers ?? base?.modelTiers;
	const tools = overlay.tools ?? base?.tools;
	if (!legacy && (defaultModelTier !== undefined || Object.keys(modelTiers ?? {}).length > 0)) {
		if (defaultModelTier === undefined) return { role: {}, error: `role "${name}" needs defaultModelTier` };
		const tier = modelTiers?.[defaultModelTier];
		if (!tier) return { role: {}, error: `role "${name}" defaultModelTier "${defaultModelTier}" is not configured in modelTiers` };
		return {
			role: {
				defaultModelTier,
				modelTiers,
				model: tier.model,
				fallbackModel: tier.fallbackModel,
				thinking: (tier as Partial<TierModelConfig>).thinking ?? overlay.thinking ?? base?.thinking,
				tools,
				legacy: false,
			},
		};
	}
	return {
		role: {
			model: overlay.model ?? base?.model,
			fallbackModel: overlay.fallbackModel ?? base?.fallbackModel,
			modelTiers,
			thinking: overlay.thinking ?? base?.thinking,
			tools,
			legacy,
		},
	};
}

function loadAgentsFromDir(
	dir: string,
	source: "user" | "project" | "package",
	roles: ReadonlyMap<string, RoleOverride> = new Map(),
	excludeIdentities?: ReadonlySet<string>,
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
		// A physical package definition is package-only whatever its name or location; an unprovable identity is refused, never admitted as a legacy role.
		if (excludeIdentities) {
			const id = fileIdentity(filePath);
			if (id === null || excludeIdentities.has(id)) continue;
		}
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
		if (source === "package") {
			// Single source: a canonical package definition contributes identity, body and native Copilot tools only.
			// Every Pi setting comes from the validated roles.json role; no header model, metadata or native tools can fill a gap.
			// An undeclared definition is still emitted (settings undefined) so the declared-vs-defined coverage check reports it; discovery then returns no agents.
			agents.push({
				name: frontmatter.name,
				description: frontmatter.description,
				tools: role?.tools,
				model: role?.model,
				fallbackModel: role?.fallbackModel,
				defaultModelTier: role?.defaultModelTier,
				modelTiers: role?.modelTiers,
				thinking: role?.thinking,
				systemPrompt: body,
				source,
				filePath,
			});
			continue;
		}
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
			defaultModelTier: role?.defaultModelTier,
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

/**
 * Physical file identity: dev:ino when the filesystem reports a nonzero inode (catches hardlinks, junctions and symlinks), otherwise the resolved path
 * (junctions/symlinks only; hardlinks are invisible without an inode, so a multi-link file with no inode is unprovable). Null when it cannot be proven.
 */
function fileIdentity(p: string): string | null {
	try {
		const stat = fs.statSync(p, { bigint: true });
		if (stat.ino !== 0n) return `${stat.dev}:${stat.ino}`;
		return stat.nlink > 1n ? null : fs.realpathSync(p);
	} catch {
		return null;
	}
}

/** Identities of every *.md in the package agents directory, independent of roles.json validity, role names and discovery scope. */
function packageDefinitionIdentities(dir: string): { ids: Set<string>; unprovable: string[]; listError?: string } {
	const ids = new Set<string>();
	const unprovable: string[] = [];
	let entries: fs.Dirent[] = [];
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch (error) {
		// A failed listing is not a proven-empty set: report it (project scope drops the package coverage errors).
		return { ids, unprovable, listError: `package agents directory cannot be listed (${(error as { code?: unknown }).code ?? "unknown"}): ${dir}` };
	}
	for (const entry of entries) {
		if (!entry.name.endsWith(".md") || (!entry.isFile() && !entry.isSymbolicLink())) continue;
		const id = fileIdentity(path.join(dir, entry.name));
		if (id === null) unprovable.push(entry.name);
		else ids.add(id);
	}
	return { ids, unprovable };
}

function sameDirectory(first: string, second: string): boolean {
	try {
		const a = fs.realpathSync(first);
		const b = fs.realpathSync(second);
		if (a === b) return true;
		// Case aliases can retain different spelling on Windows. Compare actual
		// directory identities rather than lowercasing distinct case-sensitive paths.
		const left = fs.statSync(a, { bigint: true });
		const right = fs.statSync(b, { bigint: true });
		return left.isDirectory() && right.isDirectory() && left.ino !== 0n && left.dev === right.dev && left.ino === right.ino;
	} catch {
		return false; // An unproven identity must not suppress a user override.
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
	const userFile = path.join(getAgentDir(), "roles.json");
	const userRegistry = loadRoleRegistry(userFile, pkgRoot || layout.error ? "user roles.json" : undefined, true);
	const roles = userRegistry.roles;
	let error = layout.error ?? userRegistry.error;
	// Package tier: the bundled roles.json is the base; user roles.json overlays it (see resolveRole).
	const baseRoles = new Map<string, RoleOverride>();
	const packageRoles = new Map<string, RoleOverride>();
	let shipped: AgentConfig[] = [];
	const packageIdentities = pkgRoot ? packageDefinitionIdentities(path.join(pkgRoot, "agents")) : undefined;
	// Unlike registry errors this is reported in every scope: project scope must not admit an alias it cannot identify.
	const identityError = packageIdentities?.listError ?? layout.error ?? (packageIdentities?.unprovable.length ? `package definition file identity cannot be proven (${packageIdentities.unprovable.join(", ")}): ${pkgRoot}` : undefined);
	if (pkgRoot) {
		const basePath = path.join(pkgRoot, "roles.json");
		const base = loadRoleRegistry(basePath, "package roles.json");
		error = error ?? base.error;
		if (!isDirectory(path.join(pkgRoot, "agents"))) error = error ?? `package agents directory is missing: ${pkgRoot}`;
		for (const [name, baseRole] of base.roles) {
			baseRoles.set(name, baseRole);
			const shippedOnly = resolveRole(name, undefined, baseRole);
			if (shippedOnly.error) error = error ?? `package roles.json ${shippedOnly.error}: ${basePath}`;
			// Canonical config is required: tier format with a configured default tier model and nonempty tools. Nothing is inherited from a header or the host.
			if (!shippedOnly.error && (baseRole.legacy !== false || !shippedOnly.role.model || !shippedOnly.role.tools?.length)) {
				error = error ?? `package roles.json role "${name}" needs tier-format model settings and nonempty tools: ${basePath}`;
			}
			const merged = resolveRole(name, baseRole, roles.get(name));
			if (merged.error) error = error ?? `user roles.json ${merged.error}: ${userFile}`;
			// A legacy scalar overlay replaces the tier projection field-wise; unset fields keep the shipped default-tier values.
			const role = merged.role;
			if (!merged.error && !shippedOnly.error && role.legacy === true) {
				role.model ??= shippedOnly.role.model;
				role.fallbackModel ??= shippedOnly.role.fallbackModel;
				role.thinking ??= shippedOnly.role.thinking;
				role.tools ??= shippedOnly.role.tools;
			}
			packageRoles.set(name, role);
		}
		shipped = loadAgentsFromDir(path.join(pkgRoot, "agents"), "package", packageRoles);
		// Every declared role needs exactly one parsed definition, and no parsed definition may be undeclared (an empty set is never valid).
		const declared = [...base.roles.keys()].sort();
		const defined = shipped.map((a) => a.name).sort();
		if (!error && (declared.length === 0 || JSON.stringify(declared) !== JSON.stringify(defined))) {
			const detail = ([["missing definition", declared.filter((n) => !defined.includes(n))], ["undeclared definition", defined.filter((n) => !declared.includes(n))]] as const)
				.filter(([, names]) => names.length).map(([label, names]) => `${label}: ${names.join(", ")}`).join("; ");
			error = `package roles.json and agents disagree on role names${detail ? ` (${detail})` : ""}: ${pkgRoot}`;
		}
	}

	const packageAgents = scope === "project" ? [] : shipped;
	// User-dir overlays keep their raw projection unless they are tier-format or inherit a tier base, so legacy and neutral overlays stay unchanged.
	const userRoles = new Map<string, RoleOverride>();
	for (const [name, overlay] of roles) {
		const baseRole = baseRoles.get(name);
		const inherit = overlay.legacy === false || (overlay.legacy === undefined && baseRole?.legacy === false);
		const resolved = resolveRole(name, inherit ? baseRole : undefined, overlay);
		if (resolved.error) error = error ?? `user roles.json ${resolved.error}: ${userFile}`;
		userRoles.set(name, resolved.role);
	}
	// A package installed in the profile already loaded these exact files above.
	const sharedPackageDir = pkgRoot !== null && sameDirectory(userDir, path.join(pkgRoot, "agents"));
	const userAgents = scope === "project" || sharedPackageDir ? [] : loadAgentsFromDir(userDir, "user", userRoles, packageIdentities?.ids);
	const projectAgents = scope === "user" || !projectAgentsDir ? [] : loadAgentsFromDir(projectAgentsDir, "project", undefined, packageIdentities?.ids);

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
	if (identityError) return { agents: [], projectAgentsDir, error: identityError };
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
