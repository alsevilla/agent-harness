// Native layout: the repo-root package.json declares the native resources directly, and agent/ is the resource root.
// Discovery runs in Node probes against isolated profiles (PI_CODING_AGENT_DIR, HOME/USERPROFILE set to temp dirs); nothing is installed or written outside temp dirs.
// Probes resolve host packages from NATIVE_PROBE_HOST_MODULES or the supported install tree, not a checkout node_modules.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { after, test } from "node:test";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "../../../..");
const PROBE = path.join(HERE, "fixtures", "native-probe.mjs");
const AGENTS_TS = path.join(REPO, "agent", "extensions", "subagent", "agents.ts");
const HOST_PACKAGES = ["@earendil-works/pi-agent-core", "@earendil-works/pi-ai", "@earendil-works/pi-coding-agent", "@earendil-works/pi-tui", "typebox"];
import { hostModules } from "./host-modules.ts";
const NATIVE_EXTENSIONS = ["./agent/extensions/subagent/index.ts", "./agent/extensions/ask-user/index.ts"];
const NATIVE_SKILLS = ["./agent/skills/engineering-harness", "./agent/skills/agent-creation"];
const NATIVE_PROMPTS = ["./agent/prompts/learn.md"]; // the only prompt template the package exports

// Cold probes (fresh copies, first module load) exceed a short default timeout; used for both the test timeout and the probe spawn.
const PROBE_TIMEOUT_MS = 60_000;
const HOST_MODULES = hostModules(HOST_PACKAGES);
const probeTest = (name: string, fn: () => void) => test(name, { timeout: PROBE_TIMEOUT_MS }, fn);

const dirs: string[] = [];
after(() => {
	for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
});

function tmp(prefix: string): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
	dirs.push(dir);
	return dir;
}

// Copies the native agent/ tree (never the local install snapshot) and optionally mutates the copy.
function copyAgentTree(root: string): void {
	fs.cpSync(path.join(REPO, "agent"), path.join(root, "agent"), { recursive: true, filter: (src) => path.relative(REPO, src) !== path.join("agent", "install") });
}

function copyNativeTree(mutate?: (root: string) => void): string {
	const root = tmp("native-tree-");
	fs.copyFileSync(path.join(REPO, "package.json"), path.join(root, "package.json"));
	copyAgentTree(root);
	mutate?.(root);
	return root;
}

function listFiles(dir: string): string[] {
	if (!fs.existsSync(dir)) return [];
	return fs.readdirSync(dir, { recursive: true, withFileTypes: false }).map(String).sort();
}

function runProbe(args: string[], profile: string, nodeArgs: string[] = []): string {
	const home = tmp("native-home-");
	const run = spawnSync("node", ["--experimental-transform-types", ...nodeArgs, PROBE, ...args], {
		encoding: "utf8",
		timeout: PROBE_TIMEOUT_MS,
		windowsHide: true,
		env: { ...process.env, NATIVE_PROBE_HOST_MODULES: HOST_MODULES, PI_CODING_AGENT_DIR: profile, HOME: home, USERPROFILE: home },
	});
	assert.equal(run.status, 0, run.stderr);
	return run.stdout.trim().split("\n").pop() ?? "";
}

type Discovery = { packageRoot: string | null; error: string | null; agents: { name: string; source: string; model?: string | null; thinking?: string; fallbackModel?: string[]; tools?: string[]; filePath: string; systemPrompt: string }[] };
function discover(agentsTs: string, profile: string, cwd: string, scope = "both", nodeArgs: string[] = []): Discovery {
	return JSON.parse(runProbe(["discover", agentsTs, cwd, scope], profile, nodeArgs)) as Discovery;
}

// Exact-path EACCES on listing `dir` (first call only, or every call) via a probe-scoped preload: no ACL or permission change on the host.
function listingFault(dir: string, mode: "once" | "always"): string[] {
	const file = path.join(tmp("native-fault-"), "fault.mjs");
	fs.writeFileSync(file, [
		'import fs from "node:fs";',
		'import path from "node:path";',
		'import { syncBuiltinESMExports } from "node:module";',
		`const target = path.resolve(${JSON.stringify(dir)});`,
		`let left = ${mode === "once" ? 1 : "Infinity"};`,
		"const original = fs.readdirSync;",
		'fs.readdirSync = function (p, ...rest) { if (left > 0 && path.resolve(String(p)) === target) { left--; throw Object.assign(new Error("EACCES: permission denied, scandir " + p), { code: "EACCES" }); } return original.call(this, p, ...rest); };',
		"syncBuiltinESMExports();", // agents.ts imports the `node:fs` namespace
		"",
	].join("\n"));
	return [`--import=${pathToFileURL(file).href}`];
}

function sourceFiles(dir: string): string[] {
	return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) return entry.name === "tests" || entry.name === "fixtures" ? [] : sourceFiles(full);
		return entry.name.endsWith(".ts") ? [full] : [];
	});
}

test("root manifest declares the native resources directly and the host packages only as peers", () => {
	const manifest = JSON.parse(fs.readFileSync(path.join(REPO, "package.json"), "utf8"));
	assert.equal(manifest.name, "@alsevilla/pi-engineering-harness");
	assert.deepEqual(manifest.pi, { extensions: NATIVE_EXTENSIONS, skills: NATIVE_SKILLS, prompts: NATIVE_PROMPTS });
	for (const rel of [...NATIVE_EXTENSIONS, ...NATIVE_SKILLS, ...NATIVE_PROMPTS]) assert.ok(fs.existsSync(path.join(REPO, rel)), rel);
	assert.deepEqual(manifest.peerDependencies, Object.fromEntries(HOST_PACKAGES.map((name) => [name, "*"])));
	assert.deepEqual(Object.keys(manifest.dependencies ?? {}).filter((name) => HOST_PACKAGES.includes(name) || name.startsWith("@earendil-works/")), []);
	assert.equal(manifest.license, "MIT");
	assert.deepEqual(manifest.engines, { node: ">=22.19.0" });
	assert.doesNotMatch(JSON.stringify(manifest), /pi-package|defaults/);
});

// Undeclared host-package and node: specifiers in `from` clauses, in either quote style (only the host-package families; other bare specifiers are not scanned).
function undeclaredImports(source: string): string[] {
	const imported = new Set<string>();
	for (const match of source.matchAll(/from\s+(["'])((?:@earendil-works\/[^"'/]+)|typebox|node:[^"']+)(?:\/[^"']*)?\1/g)) imported.add(match[2]);
	return [...imported].filter((name) => !name.startsWith("node:") && !HOST_PACKAGES.includes(name));
}

test("the native extensions import only the declared host packages (trust boundary)", () => {
	const undeclared: string[] = [];
	for (const file of sourceFiles(path.join(REPO, "agent", "extensions"))) undeclared.push(...undeclaredImports(fs.readFileSync(file, "utf8")));
	assert.deepEqual(undeclared, []);
});

test("the trust-boundary scan checks single-quoted and double-quoted imports alike", () => {
	assert.deepEqual(undeclaredImports(`import { Type } from "typebox";\nimport { x } from 'typebox';\nimport { y } from '@earendil-works/pi-tui';`), []);
	assert.deepEqual(undeclaredImports(`import { z } from "@earendil-works/unlisted-host";`), ["@earendil-works/unlisted-host"]);
	assert.deepEqual(undeclaredImports(`import { z } from '@earendil-works/unlisted-host';`), ["@earendil-works/unlisted-host"]);
});

probeTest("a fresh isolated profile resolves the 20 bundled roles from the native package and writes nothing", () => {
	const profile = tmp("native-profile-");
	const found = discover(AGENTS_TS, profile, tmp("native-cwd-"));
	assert.equal(found.error, null);
	assert.equal(found.packageRoot, path.join(REPO, "agent"));
	const roles = JSON.parse(fs.readFileSync(path.join(REPO, "agent", "roles.json"), "utf8")) as { name: string }[];
	assert.equal(roles.length, 20);
	assert.deepEqual(found.agents.map((agent) => agent.name).sort(), roles.map((role) => role.name).sort());
	for (const agent of found.agents) {
		assert.equal(agent.source, "package", agent.name);
		assert.equal(agent.filePath, path.join(REPO, "agent", "agents", `${agent.name}.md`), agent.name);
	}
	assert.ok(fs.existsSync(path.join(REPO, "agent", "skills", "agent-creation", "scripts", "create-agent.mjs")), "agent-create CLI resolves under the package root");
	assert.deepEqual(listFiles(profile), [], "fresh profile stays empty: no copy, no settings, no roles");
});

for (const layout of ["direct", "linked", ...(process.platform === "win32" ? ["case-alias"] : [])]) {
	probeTest(`a shared package/profile directory keeps package provenance (${layout})`, () => {
		const root = copyNativeTree();
		const packageAgentDir = path.join(root, "agent");
		let profile = packageAgentDir;
		if (layout === "linked") {
			profile = path.join(tmp("native-profile-link-"), "agent");
			fs.symlinkSync(packageAgentDir, profile, process.platform === "win32" ? "junction" : "dir");
		} else if (layout === "case-alias") {
			profile = packageAgentDir.toUpperCase();
		}
		const agentsTs = path.join(packageAgentDir, "extensions", "subagent", "agents.ts");
		const cwd = tmp("native-cwd-");
		for (const scope of ["user", "both"]) {
			const found = discover(agentsTs, profile, cwd, scope);
			assert.equal(found.error, null);
			assert.equal(found.agents.length, 20);
			for (const agent of found.agents) {
				assert.equal(agent.source, "package", `${layout}/${scope}/${agent.name}`);
				assert.equal(agent.filePath, path.join(packageAgentDir, "agents", `${agent.name}.md`));
			}
		}
		assert.deepEqual(discover(agentsTs, profile, cwd, "project").agents, []);
	});
}

probeTest("a project-local role overrides the bundled role and private project roles stay project-scoped", () => {
	const cwd = tmp("native-project-");
	fs.mkdirSync(path.join(cwd, ".pi", "agents"), { recursive: true });
	fs.writeFileSync(path.join(cwd, ".pi", "agents", "reviewer.md"), "---\nname: reviewer\ndescription: project reviewer\n---\nProject reviewer body.\n");
	fs.writeFileSync(path.join(cwd, ".pi", "agents", "private-domain-role.md"), "---\nname: private-domain-role\ndescription: project private role\n---\nPrivate body.\n");
	const found = discover(AGENTS_TS, tmp("native-profile-"), cwd);
	assert.equal(found.error, null);
	assert.equal(found.agents.find((agent) => agent.name === "reviewer")?.source, "project");
	assert.equal(found.agents.find((agent) => agent.name === "private-domain-role")?.source, "project");
	assert.equal(found.agents.filter((agent) => agent.source === "package").length, 19);
});

probeTest("a renamed root manifest is inert: no package mode and no bundled roles", () => {
	const root = copyNativeTree((dir) => fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "someone-else" })));
	const found = discover(path.join(root, "agent", "extensions", "subagent", "agents.ts"), tmp("native-profile-"), tmp("native-cwd-"));
	assert.equal(found.packageRoot, null);
	assert.equal(found.error, null);
	assert.deepEqual(found.agents, []);
});

probeTest("a copied profile without a root manifest keeps the legacy live mode", () => {
	const root = tmp("native-live-");
	copyAgentTree(root);
	const found = discover(path.join(root, "agent", "extensions", "subagent", "agents.ts"), tmp("native-profile-"), tmp("native-cwd-"));
	assert.equal(found.packageRoot, null);
	assert.equal(found.error, null);
	assert.deepEqual(found.agents, []);
});

probeTest("an unreadable root manifest fails closed in package mode", () => {
	// Node resolves the probe's module scope to the nearest package.json, so a stub at agent/ stops it before the broken root manifest.
	const root = copyNativeTree((dir) => {
		fs.writeFileSync(path.join(dir, "package.json"), "{");
		fs.writeFileSync(path.join(dir, "agent", "package.json"), '{"type":"module"}\n');
	});
	const found = discover(path.join(root, "agent", "extensions", "subagent", "agents.ts"), tmp("native-profile-"), tmp("native-cwd-"));
	assert.match(found.error ?? "", /package manifest is unreadable or not valid JSON/);
});

const DAMAGED_BUNDLE: [string, (root: string) => void, RegExp][] = [
	["missing roles.json", (root) => fs.rmSync(path.join(root, "agent", "roles.json")), /package roles\.json|disagree on role names/],
	["unparseable roles.json", (root) => fs.writeFileSync(path.join(root, "agent", "roles.json"), "{"), /package roles\.json/],
	["empty roles.json", (root) => fs.writeFileSync(path.join(root, "agent", "roles.json"), "[]\n"), /disagree on role names/],
	["missing agents directory", (root) => fs.rmSync(path.join(root, "agent", "agents"), { recursive: true }), /package agents directory is missing/],
	["one agent definition missing", (root) => fs.rmSync(path.join(root, "agent", "agents", "reviewer.md")), /disagree on role names/],
];
for (const [label, mutate, expected] of DAMAGED_BUNDLE) {
	probeTest(`a damaged bundle fails closed (${label})`, () => {
		const root = copyNativeTree(mutate);
		const found = discover(path.join(root, "agent", "extensions", "subagent", "agents.ts"), tmp("native-profile-"), tmp("native-cwd-"));
		assert.match(found.error ?? "", expected);
		assert.deepEqual(found.agents, []);
	});
}

probeTest("the public SDK loader lists exactly the native extensions and skills and exports no prompt templates", () => {
	const profile = tmp("native-profile-");
	const out = JSON.parse(runProbe(["sdk", REPO, tmp("native-cwd-")], profile)) as { prompts: string[]; extensions: string[]; extensionErrors: string[]; skills: { name: string; filePath: string }[] };
	const agentRoot = path.join(REPO, "agent") + path.sep;
	const extensions = out.extensions.filter((file) => file.startsWith(agentRoot)).map((file) => path.relative(REPO, file).split(path.sep).join("/")).sort();
	assert.deepEqual(extensions, NATIVE_EXTENSIONS.map((rel) => rel.slice(2)).sort());
	assert.deepEqual(out.extensionErrors, []);
	// Only /learn is exported from agent/prompts/; every other workflow and domain prompt stays a manual, optional file.
	assert.deepEqual(out.prompts, ["learn"]);
	assert.deepEqual(out.promptFiles.map((file) => path.relative(REPO, file).split(path.sep).join("/")), NATIVE_PROMPTS.map((rel) => rel.slice(2)));
	const skills = out.skills.filter((skill) => skill.filePath.startsWith(agentRoot)).map((skill) => skill.name).sort();
	assert.deepEqual(skills, ["agent-creation", "engineering-harness"]);
	assert.deepEqual(listFiles(profile), [], "SDK loading writes nothing into the profile");
});

probeTest("a project scope lists no bundled roles", () => {
	const found = discover(AGENTS_TS, tmp("native-profile-"), tmp("native-cwd-"), "project");
	assert.equal(found.error, null);
	assert.deepEqual(found.agents, []);
});

probeTest("a user agent file with a bundled role's name wins over the bundled definition", () => {
	const profile = tmp("native-profile-");
	fs.mkdirSync(path.join(profile, "agents"), { recursive: true });
	fs.writeFileSync(path.join(profile, "agents", "general-worker.md"), "---\nname: general-worker\ndescription: user override\ntools: read\n---\nUser override body.\n");
	const found = discover(AGENTS_TS, profile, tmp("native-cwd-"), "user");
	assert.equal(found.error, null);
	assert.equal(found.agents.length, 20);
	const general = found.agents.find((agent) => agent.name === "general-worker");
	assert.equal(general?.source, "user");
	assert.deepEqual(general?.tools, ["read"]);
	assert.match(general?.systemPrompt ?? "", /User override body\./);
});

probeTest("a user roles.json overlays a bundled default field-wise and keeps the unset defaults", () => {
	const profile = tmp("native-profile-");
	fs.writeFileSync(path.join(profile, "roles.json"), JSON.stringify([{ name: "scout", provider: "openai-codex", model: "gpt-6-luna", thinking: "high" }]));
	const scout = discover(AGENTS_TS, profile, tmp("native-cwd-"), "user").agents.find((agent) => agent.name === "scout");
	assert.equal(scout?.model, "openai-codex/gpt-6-luna");
	assert.equal(scout?.thinking, "high");
	assert.deepEqual(scout?.fallbackModel, ["openai-codex/gpt-6-luna"]);
});

// Malformed user registry in the native layout (the bundled roles.json is the baseline): an error result, never a silent fallback.
const MALFORMED_USER_ROLES: [string, string, RegExp][] = [
	["unparseable JSON", '[{"name":"oracle"', /user roles\.json/],
	["not a JSON list", '{"name":"scout"}', /must be a JSON list/],
	["capitalised Name key", '[{"Name":"debugger","provider":"openai-codex","model":"gpt-6-luna"}]', /user roles\.json/],
	["unknown key modle", '[{"name":"scout","modle":"gpt-6-luna"}]', /user roles\.json/],
	["non-string tools", '[{"name":"scout","tools":5}]', /user roles\.json/],
	["empty name", '[{"name":"","model":"x"}]', /user roles\.json/],
	["duplicate names", '[{"name":"scout","thinking":"low"},{"name":"scout","thinking":"high"}]', /user roles\.json/],
];
for (const [label, text, expected] of MALFORMED_USER_ROLES) {
	probeTest(`a malformed user roles.json fails closed in the native layout (${label})`, () => {
		const profile = tmp("native-profile-");
		fs.writeFileSync(path.join(profile, "roles.json"), text);
		const found = discover(AGENTS_TS, profile, tmp("native-cwd-"), "user");
		assert.match(found.error ?? "", expected);
		assert.deepEqual(found.agents, []);
	});
}

// Canonical package config is REQUIRED: roles.json is the single source of every Pi setting and tool grant, so an incomplete or invalid
// package entry fails the whole bundle closed. There is no inherited session model, no native Copilot header tools and no host-wide tool fallback.
type PackageRole = Record<string, unknown> & { name: string; modelTiers?: Record<string, Record<string, unknown>> };
const editPackageRoles = (change: (roles: PackageRole[]) => void) => (root: string) => {
	const file = path.join(root, "agent", "roles.json");
	const roles = JSON.parse(fs.readFileSync(file, "utf8")) as PackageRole[];
	change(roles);
	fs.writeFileSync(file, JSON.stringify(roles, null, 2));
};
const roleOf = (roles: PackageRole[], name = "reviewer") => roles.find((role) => role.name === name)!;
const INVALID_CANONICAL: [string, (root: string) => void][] = [
	["role without tools", editPackageRoles((roles) => { delete roleOf(roles).tools; })],
	["role with blank tools", editPackageRoles((roles) => { roleOf(roles).tools = " , "; })],
	["role with non-string tools", editPackageRoles((roles) => { roleOf(roles).tools = 5; })],
	["role without defaultModelTier", editPackageRoles((roles) => { delete roleOf(roles).defaultModelTier; })],
	["default tier not configured", editPackageRoles((roles) => { roleOf(roles).defaultModelTier = roleOf(roles).defaultModelTier === "capable" ? "economy" : "capable"; delete roleOf(roles).modelTiers![roleOf(roles).defaultModelTier as string]; })],
	["default tier without a model", editPackageRoles((roles) => { const r = roleOf(roles); delete r.modelTiers![r.defaultModelTier as string].model; })],
	["role without modelTiers", editPackageRoles((roles) => { delete roleOf(roles).modelTiers; })],
	["legacy flat package entry", editPackageRoles((roles) => { const i = roles.indexOf(roleOf(roles)); roles[i] = { name: "reviewer", provider: "openai-codex", model: "gpt-6-luna", fallbackModel: "", thinking: "low", tools: "read, grep" }; })],
];
for (const [label, mutate] of INVALID_CANONICAL) {
	probeTest(`canonical package config fails closed with no header or host fallback (${label})`, () => {
		const root = copyNativeTree(mutate);
		const found = discover(path.join(root, "agent", "extensions", "subagent", "agents.ts"), tmp("native-profile-"), tmp("native-cwd-"));
		assert.match(found.error ?? "", /package roles\.json/);
		assert.deepEqual(found.agents, []);
	});
}

probeTest("a JSON-only default change reaches discovery with no definition edit; header mirrors cannot override it", () => {
	const root = copyNativeTree(editPackageRoles((roles) => {
		const reviewer = roleOf(roles);
		const tier = reviewer.modelTiers![reviewer.defaultModelTier as string];
		Object.assign(tier, { model: "fixture-provider/json-only", fallbackModel: "", thinking: "low" });
		reviewer.tools = "read, grep";
	}));
	const before = fs.readFileSync(path.join(root, "agent", "agents", "reviewer.md"), "utf8");
	const found = discover(path.join(root, "agent", "extensions", "subagent", "agents.ts"), tmp("native-profile-"), tmp("native-cwd-"));
	assert.equal(found.error, null);
	const reviewer = found.agents.find((agent) => agent.name === "reviewer");
	assert.equal(reviewer?.model, "fixture-provider/json-only");
	assert.equal(reviewer?.thinking, "low");
	assert.deepEqual(reviewer?.fallbackModel, []);
	assert.deepEqual(reviewer?.tools, ["read", "grep"], "Pi tools come from roles.json, never from the native Copilot header");
	assert.equal(fs.readFileSync(path.join(root, "agent", "agents", "reviewer.md"), "utf8"), before);
});

probeTest("a package definition with legacy header mirrors still takes every Pi setting from roles.json only", () => {
	const root = copyNativeTree((dir) => {
		const file = path.join(dir, "agent", "agents", "reviewer.md");
		fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace(/\r?\ntools:/, "\nmodel: stale/header-model\nfallbackModel: stale/header-fallback\nthinking: off\nmetadata:\n  pi.model: stale/pi-model\n  pi.tools: write\ntools:"));
	});
	const roles = JSON.parse(fs.readFileSync(path.join(root, "agent", "roles.json"), "utf8")) as PackageRole[];
	const reviewerRole = roleOf(roles);
	const tier = reviewerRole.modelTiers![reviewerRole.defaultModelTier as string];
	const reviewer = discover(path.join(root, "agent", "extensions", "subagent", "agents.ts"), tmp("native-profile-"), tmp("native-cwd-")).agents.find((agent) => agent.name === "reviewer");
	assert.equal(reviewer?.model, tier.model);
	assert.equal(reviewer?.thinking, tier.thinking);
	assert.deepEqual(reviewer?.tools, String(reviewerRole.tools).split(",").map((tool) => tool.trim()));
});

// Physical identity: a user/project definition that IS a package definition (directory junction or hardlink) is never a legacy role.
// The package-only rule follows the file (dev:ino), not its name or the validity of roles.json; genuine distinct copies stay legacy.
const packageTuple = (root: string, name: string) => {
	const role = roleOf(JSON.parse(fs.readFileSync(path.join(root, "agent", "roles.json"), "utf8")) as PackageRole[], name);
	const tier = role.modelTiers![role.defaultModelTier as string];
	return { model: tier.model, thinking: tier.thinking, tools: String(role.tools).split(",").map((tool) => tool.trim()) };
};
const assertAllCanonical = (found: Discovery, root: string, label: string) => {
	assert.equal(found.error, null, label);
	assert.equal(found.agents.length, 20, label);
	for (const agent of found.agents) {
		assert.equal(agent.source, "package", `${label}/${agent.name}`);
		assert.equal(agent.filePath, path.join(root, "agent", "agents", `${agent.name}.md`), `${label}/${agent.name}`);
	}
	const reviewer = found.agents.find((agent) => agent.name === "reviewer");
	assert.deepEqual({ model: reviewer?.model, thinking: reviewer?.thinking, tools: reviewer?.tools }, packageTuple(root, "reviewer"), label);
};
const agentsTsOf = (root: string) => path.join(root, "agent", "extensions", "subagent", "agents.ts");
const projectWithAgentsDir = () => {
	const cwd = tmp("native-project-");
	fs.mkdirSync(path.join(cwd, ".pi"), { recursive: true });
	return cwd;
};
const linkAgents = (root: string, dir: string, names: string[], as = (name: string) => name) => {
	fs.mkdirSync(dir, { recursive: true });
	for (const name of names) fs.linkSync(path.join(root, "agent", "agents", `${name}.md`), path.join(dir, `${as(name)}.md`));
};

for (const scope of ["both", "project"]) {
	probeTest(`a project directory junction onto the package definitions never yields legacy project roles (${scope})`, () => {
		const root = copyNativeTree();
		const cwd = projectWithAgentsDir();
		fs.symlinkSync(path.join(root, "agent", "agents"), path.join(cwd, ".pi", "agents"), process.platform === "win32" ? "junction" : "dir");
		const found = discover(agentsTsOf(root), tmp("native-profile-"), cwd, scope);
		if (scope === "both") assertAllCanonical(found, root, scope);
		else assert.deepEqual(found, { packageRoot: path.join(root, "agent"), error: null, agents: [] });
	});

	probeTest(`project hardlinks of package definitions, under any file name, never yield legacy project roles (${scope})`, () => {
		const root = copyNativeTree();
		const cwd = projectWithAgentsDir();
		linkAgents(root, path.join(cwd, ".pi", "agents"), ["reviewer", "scout"]);
		linkAgents(root, path.join(cwd, ".pi", "agents"), ["debugger"], () => "renamed-alias");
		const found = discover(agentsTsOf(root), tmp("native-profile-"), cwd, scope);
		if (scope === "both") assertAllCanonical(found, root, scope);
		else assert.deepEqual(found.agents, []);
	});
}

for (const scope of ["user", "both"]) {
	probeTest(`user-profile hardlinks of package definitions resolve to the canonical package role (${scope})`, () => {
		const root = copyNativeTree();
		const profile = tmp("native-profile-");
		linkAgents(root, path.join(profile, "agents"), ["reviewer", "scout"]);
		assertAllCanonical(discover(agentsTsOf(root), profile, tmp("native-cwd-"), scope), root, scope);
	});
}

for (const scope of ["both", "project"]) {
	probeTest(`an invalid user registry behind a project alias still never falls through as a legacy project role (${scope})`, () => {
		const root = copyNativeTree();
		const profile = tmp("native-profile-");
		fs.writeFileSync(path.join(profile, "roles.json"), "{bad");
		const cwd = projectWithAgentsDir();
		fs.symlinkSync(path.join(root, "agent", "agents"), path.join(cwd, ".pi", "agents"), process.platform === "win32" ? "junction" : "dir");
		const found = discover(agentsTsOf(root), profile, cwd, scope);
		assert.deepEqual(found.agents, []);
		if (scope === "both") assert.match(found.error ?? "", /user roles\.json/);
	});
}

probeTest("distinct external copies and custom definitions stay legacy while a sibling alias is canonical", () => {
	const root = copyNativeTree();
	const cwd = projectWithAgentsDir();
	const dir = path.join(cwd, ".pi", "agents");
	linkAgents(root, dir, ["scout"]);
	fs.copyFileSync(path.join(root, "agent", "agents", "reviewer.md"), path.join(dir, "reviewer.md"));
	fs.writeFileSync(path.join(dir, "custom.md"), "---\nname: custom\ndescription: custom\nmodel: external/custom-model\n---\nCustom body.\n");
	const found = discover(agentsTsOf(root), tmp("native-profile-"), cwd, "both");
	assert.equal(found.error, null);
	assert.equal(found.agents.length, 21);
	assert.equal(found.agents.find((agent) => agent.name === "scout")?.source, "package");
	const reviewer = found.agents.find((agent) => agent.name === "reviewer");
	assert.equal(reviewer?.source, "project");
	assert.equal(reviewer?.model, null, "a genuine distinct copy keeps legacy semantics: no canonical model");
	assert.equal(found.agents.find((agent) => agent.name === "custom")?.model, "external/custom-model");
	assert.deepEqual(discover(agentsTsOf(root), tmp("native-profile-"), cwd, "project").agents.map((agent) => agent.name).sort(), ["custom", "reviewer"]);
});

// A failed package listing is never a proven-empty set: project scope (which drops package errors) must refuse the alias like every other scope.
const aliasEverywhere = (root: string, profile: string, cwd: string, names = ["reviewer"]) => {
	linkAgents(root, path.join(profile, "agents"), names);
	linkAgents(root, path.join(cwd, ".pi", "agents"), names);
};
const noAgentsAdmitted = (found: Discovery, label: string) => {
	assert.ok(found.error, `${label}: error`);
	assert.deepEqual(found.agents, [], label);
};
const PACKAGE_LISTING_BREAKS: [string, (root: string) => void][] = [
	["agents replaced by a regular file (ENOTDIR)", (root) => { fs.rmSync(path.join(root, "agent", "agents"), { recursive: true }); fs.writeFileSync(path.join(root, "agent", "agents"), "x"); }],
	["agents directory removed (ENOENT)", (root) => fs.rmSync(path.join(root, "agent", "agents"), { recursive: true })],
];
for (const [label, breakListing] of PACKAGE_LISTING_BREAKS) {
	for (const scope of ["project", "both", "user"]) {
		probeTest(`a package agents directory that cannot be listed (${label}) refuses a surviving canonical alias (${scope})`, () => {
			const root = copyNativeTree();
			const profile = tmp("native-profile-");
			const cwd = projectWithAgentsDir();
			aliasEverywhere(root, profile, cwd);
			breakListing(root);
			const found = discover(agentsTsOf(root), profile, cwd, scope);
			noAgentsAdmitted(found, scope);
			assert.match(found.error ?? "", scope === "project" ? /package agents directory cannot be listed \((ENOTDIR|ENOENT)\)/ : /package agents directory is missing/);
		});
	}
}

for (const scope of ["project", "both", "user"]) {
	for (const mode of ["always", "once"] as const) {
		probeTest(`an EACCES package listing (${mode === "once" ? "first listing only" : "persistent"}) never lets a canonical alias become a legacy role (${scope})`, () => {
			const root = copyNativeTree();
			const profile = tmp("native-profile-");
			const cwd = projectWithAgentsDir();
			aliasEverywhere(root, profile, cwd);
			fs.writeFileSync(path.join(cwd, ".pi", "agents", "custom.md"), "---\nname: custom\ndescription: custom\n---\nCustom body.\n");
			const found = discover(agentsTsOf(root), profile, cwd, scope, listingFault(path.join(root, "agent", "agents"), mode));
			noAgentsAdmitted(found, `${mode}/${scope}`);
			// Persistent failure in user/both also empties the package tier, so the coverage error wins there; project (and a one-shot failure) reports the listing.
			assert.match(found.error ?? "", mode === "always" && scope !== "project" ? /disagree on role names/ : /package agents directory cannot be listed \(EACCES\)/);
		});
	}
}

for (const scope of ["project", "both"]) {
	probeTest(`a corrupt root manifest fails closed even when a canonical project alias exists (${scope})`, () => {
		const root = copyNativeTree();
		const cwd = projectWithAgentsDir();
		linkAgents(root, path.join(cwd, ".pi", "agents"), ["reviewer"]);
		fs.writeFileSync(path.join(root, "package.json"), "{");
		fs.writeFileSync(path.join(root, "agent", "package.json"), '{"type":"module"}\n');
		const found = discover(agentsTsOf(root), tmp("native-profile-"), cwd, scope);
		noAgentsAdmitted(found, scope);
		assert.match(found.error ?? "", /package manifest is unreadable or not valid JSON/);
	});
}

probeTest("without package mode (renamed or absent manifest) and with a readable empty package listing, project aliases stay legacy and error-free", () => {
	for (const [label, mutate] of [["renamed", (dir: string) => fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "someone-else" }))], ["absent", (dir: string) => fs.rmSync(path.join(dir, "package.json"))]] as const) {
		const root = copyNativeTree(mutate);
		const cwd = projectWithAgentsDir();
		linkAgents(root, path.join(cwd, ".pi", "agents"), ["reviewer"]);
		const found = discover(agentsTsOf(root), tmp("native-profile-"), cwd, "project");
		assert.equal(found.error, null, label);
		assert.deepEqual(found.agents.map((agent) => `${agent.name}/${agent.source}`), ["reviewer/project"], label);
	}
	// Listing succeeds but is empty: no package file can be aliased, so an ordinary project file is a legacy role (user/both still fail on declared != defined).
	const root = copyNativeTree();
	const cwd = projectWithAgentsDir();
	fs.mkdirSync(path.join(cwd, ".pi", "agents"), { recursive: true });
	fs.writeFileSync(path.join(cwd, ".pi", "agents", "reviewer.md"), "---\nname: reviewer\ndescription: external\n---\nExternal body.\n");
	for (const name of fs.readdirSync(path.join(root, "agent", "agents"))) fs.rmSync(path.join(root, "agent", "agents", name));
	const project = discover(agentsTsOf(root), tmp("native-profile-"), cwd, "project");
	assert.equal(project.error, null);
	assert.deepEqual(project.agents.map((agent) => `${agent.name}/${agent.source}`), ["reviewer/project"]);
	assert.match(discover(agentsTsOf(root), tmp("native-profile-"), cwd, "both").error ?? "", /disagree on role names/);
});

for (const scope of ["user", "both"]) {
	probeTest(`a package definition without a roles.json entry is a coverage error, not a silently missing role (${scope})`, () => {
		const root = copyNativeTree(editPackageRoles((roles) => { roles.splice(roles.indexOf(roleOf(roles)), 1); }));
		const found = discover(agentsTsOf(root), tmp("native-profile-"), tmp("native-cwd-"), scope);
		assert.match(found.error ?? "", /package roles\.json and agents disagree on role names.*reviewer/);
		assert.deepEqual(found.agents, []);
	});
}

test("the third-party notices point at the shipped Pi license copy", () => {
	const notices = fs.readFileSync(path.join(REPO, "THIRD_PARTY_NOTICES.md"), "utf8");
	assert.match(notices, /agent\/PI-LICENSE/);
	assert.ok(fs.existsSync(path.join(REPO, "agent", "PI-LICENSE")), "agent/PI-LICENSE");
});

test("every skill reference in the native skill entry files resolves inside its own skill directory", () => {
	let checked = 0;
	const missing: string[] = [];
	for (const skill of ["engineering-harness", "agent-creation"]) {
		const dir = path.join(REPO, "agent", "skills", skill);
		for (const m of fs.readFileSync(path.join(dir, "SKILL.md"), "utf8").matchAll(/`((?:references|scripts|examples)\/[A-Za-z0-9_./-]+\.(?:md|py|json))`/g)) {
			checked++;
			if (!fs.existsSync(path.join(dir, m[1]))) missing.push(`${skill}: ${m[1]}`);
		}
	}
	assert.ok(checked >= 6, `expected skill references, found ${checked}`);
	assert.deepEqual(missing, []);
});

// The git-source install ships the tracked tree: ignored personal, auth, runtime and local-state files must never be tracked or unignored.
test("no personal, auth, runtime or local-state file is tracked or unignored in the candidate", () => {
	const files = execFileSync("git", ["ls-files", "-z", "-co", "--exclude-standard"], { cwd: REPO, maxBuffer: 64 * 1024 * 1024 }).toString("utf8").split("\0").filter(Boolean);
	assert.ok(files.length > 100, "candidate file list too small");
	const forbidden = /(^|\/)(auth\.json|settings\.json|models(-store)?\.json|mcp-onboarding\.json)$|(^|\/)(sessions|node_modules|install|npm|run-state|_scratch|_evidence)\//;
	assert.deepEqual(files.filter((file) => forbidden.test(file)), []);
});

test("the retired pi-package generator refuses and no pi-package tree exists", () => {
	const run = spawnSync("node", [path.join(REPO, "scripts", "build-pi-package.mjs")], { cwd: REPO, encoding: "utf8", timeout: 60_000, windowsHide: true });
	assert.notEqual(run.status, 0);
	assert.match(run.stderr, /pi-package generation is retired/);
	assert.equal(fs.existsSync(path.join(REPO, "pi-package")), false);
});

test("the README installs and removes the native package and no longer recommends the removed pi-package path", () => {
	const readme = fs.readFileSync(path.join(REPO, "README.md"), "utf8");
	assert.doesNotMatch(readme, /pi-package\//);
	assert.match(readme, /pi install (git:|\.\/|\/|[A-Za-z]:)/);
	assert.match(readme, /pi remove /);
});

test("the README's primary install, update and remove commands use the Git source and keep the local checkout optional", () => {
	const readme = fs.readFileSync(path.join(REPO, "README.md"), "utf8").replace(/\r\n/g, "\n"); // checkouts with autocrlf hold CRLF
	const section = (heading: string) => {
		const start = readme.indexOf(heading);
		assert.ok(start >= 0, heading);
		const next = readme.indexOf("\n## ", start + heading.length);
		return readme.slice(start, next < 0 ? undefined : next);
	};
	const quickstart = section("## Quickstart");
	const install = section("## Install");
	const GIT = "git:github.com/alsevilla/agent-harness";
	assert.ok(quickstart.includes(`pi install ${GIT}`), "Quickstart installs from the Git source");
	assert.ok(install.includes("```text\npi install " + GIT + "\n```"), "Install's first command is the Git source");
	assert.ok(install.includes(`pi update ${GIT}`), "update names the Git source");
	assert.ok(install.includes(`pi remove ${GIT}`), "remove names the Git source");
	assert.match(install, /not pinned/, "unqualified source is not described as pinned");
	assert.match(install, /default branch \(`master`\)/, "unqualified source follows the target default branch");
	assert.doesNotMatch(install, /@fix\/worker-prompts-and-domain-separation/, "obsolete feature branch is not offered as an install target");
	assert.match(install, /optional development/i, "local checkout is an optional development alternative");
	assert.ok(install.includes("pi install C:/path/to/agent-harness"), "local checkout command stays documented");
	assert.match(install, /not executed/, "install, update and remove were not executed");
	assert.doesNotMatch(readme, /Install it from a local checkout|pi install <absolute checkout path>|`git:` sources are not covered/);
	assert.doesNotMatch(readme, /git:github\.com\/alsevilla\/pi-agent-harness-pi-package|x-access-token|ghp_|github_pat_/);
});

test("the external compaction guard is removed: no extension files, no child injection, no packaging or docs", () => {
	const ext = path.join(REPO, "agent", "extensions");
	assert.ok(!fs.existsSync(path.join(ext, "external-compaction")));
	assert.ok(!fs.existsSync(path.join(ext, "subagent", "external-compaction-entry.ts")));
	for (const rel of [["agent", "extensions", "subagent", "index.ts"], ["agent", "extensions", "subagent", "README.md"], ["scripts", "build-pi-package.mjs"], ["README.md"], ["package.json"]]) {
		assert.doesNotMatch(fs.readFileSync(path.join(REPO, ...rel), "utf8"), /external[- ]compaction|PI_EXTERNAL_COMPACTION/i, rel.join("/"));
	}
});

test("the README states the two default native extensions, two native skills, manual prompts and optional components", () => {
	const readme = fs.readFileSync(path.join(REPO, "README.md"), "utf8");
	for (const rel of [...NATIVE_EXTENSIONS.map((r) => path.posix.dirname(r.slice(2))), ...NATIVE_SKILLS.map((r) => r.slice(2))]) assert.ok(readme.includes(rel), rel);
	assert.doesNotMatch(readme, /Five profile skills|registers one browser skill/);
	assert.match(readme, /native package exports one prompt template, `\/learn`/);
	assert.match(readme, /Copilot CLI integration is a limited native preview/);
	assert.match(readme, /Pi's built-in GitHub Copilot model provider/);
	assert.doesNotMatch(readme, /exports no prompt templates|the public SDK loader reports none/);
	assert.match(readme, /manual, optional prompt templates/i);
	assert.match(readme, /`engineering-environment`, `qmd` and `refresh` are not in the default exports/);
	assert.doesNotMatch(readme, /lists only optional/);
	assert.match(readme, /Do not overwrite your live/);
});

test("the agent-creation skill names the bundled role paths and the refusal label the helper emits", () => {
	const skill = fs.readFileSync(path.join(REPO, "agent", "skills", "agent-creation", "SKILL.md"), "utf8");
	const helper = fs.readFileSync(path.join(REPO, "agent", "skills", "agent-creation", "scripts", "create-agent.mjs"), "utf8");
	assert.doesNotMatch(skill, /defaults\/(roles\.json|agents)/);
	assert.ok(skill.includes("agent/roles.json") && skill.includes("agent/agents/*.md"), "bundled role paths");
	assert.ok(fs.existsSync(path.join(REPO, "agent", "roles.json")));
	assert.ok(fs.statSync(path.join(REPO, "agent", "agents")).isDirectory());
	assert.ok(helper.includes('"package roles.json"') && skill.includes("`package roles.json`"), "refusal label");
	assert.doesNotMatch(skill, /`package default`/);
});
