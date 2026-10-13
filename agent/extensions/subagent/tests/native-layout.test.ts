// Native layout: the repo-root package.json declares the native resources directly, and agent/ is the resource root.
// Discovery runs in Node probes against isolated profiles (PI_CODING_AGENT_DIR, HOME/USERPROFILE set to temp dirs); nothing is installed or written outside temp dirs.
// Probes resolve host packages from NATIVE_PROBE_HOST_MODULES or the supported install tree, not a checkout node_modules.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, test } from "bun:test";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "../../../..");
const PROBE = path.join(HERE, "fixtures", "native-probe.mjs");
const AGENTS_TS = path.join(REPO, "agent", "extensions", "subagent", "agents.ts");
const HOST_PACKAGES = ["@earendil-works/pi-agent-core", "@earendil-works/pi-ai", "@earendil-works/pi-coding-agent", "@earendil-works/pi-tui", "typebox"];
import { hostModules } from "./host-modules.ts";
const NATIVE_EXTENSIONS = ["./agent/extensions/subagent/index.ts", "./agent/extensions/ask-user/index.ts"];
const NATIVE_SKILLS = ["./agent/skills/engineering-harness", "./agent/skills/agent-creation"];
const NATIVE_PROMPTS = ["./agent/prompts/learn.md"]; // the only prompt template the package exports

// Cold probes (fresh copies, first module load) exceed bun's 5 s default; used for both the test timeout and the probe spawn.
const PROBE_TIMEOUT_MS = 60_000;
const HOST_MODULES = hostModules(HOST_PACKAGES);
const probeTest = (name: string, fn: () => void) => test(name, fn, PROBE_TIMEOUT_MS);

const dirs: string[] = [];
afterAll(() => {
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

function runProbe(args: string[], profile: string): string {
	const home = tmp("native-home-");
	const run = spawnSync("node", ["--experimental-transform-types", PROBE, ...args], {
		encoding: "utf8",
		timeout: PROBE_TIMEOUT_MS,
		windowsHide: true,
		env: { ...process.env, NATIVE_PROBE_HOST_MODULES: HOST_MODULES, PI_CODING_AGENT_DIR: profile, HOME: home, USERPROFILE: home },
	});
	assert.equal(run.status, 0, run.stderr);
	return run.stdout.trim().split("\n").pop() ?? "";
}

type Discovery = { packageRoot: string | null; error: string | null; agents: { name: string; source: string; model?: string | null; thinking?: string; fallbackModel?: string[]; tools?: string[]; filePath: string; systemPrompt: string }[] };
function discover(agentsTs: string, profile: string, cwd: string, scope = "both"): Discovery {
	return JSON.parse(runProbe(["discover", agentsTs, cwd, scope], profile)) as Discovery;
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
	assert.ok(fs.existsSync(path.join(REPO, "agent", "skills", "agent-creation", "scripts", "create_agent.py")), "agent-create CLI resolves under the package root");
	assert.deepEqual(listFiles(profile), [], "fresh profile stays empty: no copy, no settings, no roles");
});

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
	assert.deepEqual(scout?.fallbackModel, ["openai-codex/gpt-6-luna", "github-copilot/gpt-6-luna"]);
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
	const GIT = "git:github.com/alsevilla/pi-agent-harness";
	assert.ok(quickstart.includes(`pi install ${GIT}`), "Quickstart installs from the Git source");
	assert.ok(install.includes("```text\npi install " + GIT + "\n```"), "Install's first command is the Git source");
	assert.ok(install.includes(`pi update ${GIT}`), "update names the Git source");
	assert.ok(install.includes(`pi remove ${GIT}`), "remove names the Git source");
	assert.match(install, /not pinned/, "unqualified source is not described as pinned");
	assert.match(install, /default branch/, "unqualified source requires this change on the default branch");
	assert.ok(install.includes("@fix/worker-prompts-and-domain-separation"), "PR testing ref");
	assert.match(install, /optional development/i, "local checkout is an optional development alternative");
	assert.ok(install.includes("pi install C:/path/to/pi-agent-harness"), "local checkout command stays documented");
	assert.match(install, /not executed/, "install, update and remove were not executed");
	assert.doesNotMatch(readme, /Install it from a local checkout|pi install <absolute checkout path>|`git:` sources are not covered/);
	assert.doesNotMatch(readme, /git:github\.com\/alsevilla\/pi-agent-harness-pi-package|x-access-token|ghp_|github_pat_/);
});

test("the README states the two default native extensions, opt-in external compaction, two native skills, manual prompts and optional components", () => {
	const readme = fs.readFileSync(path.join(REPO, "README.md"), "utf8");
	for (const rel of [...NATIVE_EXTENSIONS.map((r) => path.posix.dirname(r.slice(2))), ...NATIVE_SKILLS.map((r) => r.slice(2))]) assert.ok(readme.includes(rel), rel);
	assert.doesNotMatch(readme, /Five profile skills|registers one browser skill/);
	assert.match(readme, /native package exports one prompt template, `\/learn`/);
	assert.doesNotMatch(readme, /exports no prompt templates|the public SDK loader reports none/);
	assert.match(readme, /manual, optional prompt templates/i);
	assert.match(readme, /`engineering-environment`, `qmd` and `refresh` are not in the default exports/);
	assert.doesNotMatch(readme, /lists only optional/);
	assert.match(readme, /Do not overwrite your live/);
});

test("the agent-creation skill names the bundled role paths and the refusal label the helper emits", () => {
	const skill = fs.readFileSync(path.join(REPO, "agent", "skills", "agent-creation", "SKILL.md"), "utf8");
	const helper = fs.readFileSync(path.join(REPO, "agent", "skills", "agent-creation", "scripts", "create_agent.py"), "utf8");
	assert.doesNotMatch(skill, /defaults\/(roles\.json|agents)/);
	assert.ok(skill.includes("agent/roles.json") && skill.includes("agent/agents/*.md"), "bundled role paths");
	assert.ok(fs.existsSync(path.join(REPO, "agent", "roles.json")));
	assert.ok(fs.statSync(path.join(REPO, "agent", "agents")).isDirectory());
	assert.ok(helper.includes('"package roles.json"') && skill.includes("`package roles.json`"), "refusal label");
	assert.doesNotMatch(skill, /`package default`/);
});
