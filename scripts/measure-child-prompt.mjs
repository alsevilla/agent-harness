// Offline, reproducible measurement of the assembled child system prompt (chars, not tokens).
// Usage: node --experimental-strip-types scripts/measure-child-prompt.mjs --label <name> --out <absolute dir outside this repository> [--agent-dir <absolute empty dir outside this repository>]
// Fixture shapes run in controlled worlds under <out>/fixtures (temp agent dir, temp HOME, temp candidate, temp package root).
// Real profile, home, session, secret, private DB and package files are not read; pi-package is never regenerated.
// Tokens are NOT measured: no offline tokenizer is available; provider count APIs are not called.
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { register } from "node:module";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const piRelease = process.env.PI_INSTALL_DIR;
const piModules = process.env.NATIVE_PROBE_HOST_MODULES ?? (piRelease
	? path.join(piRelease, "node_modules")
	: path.join(os.homedir(), ".pi", "agent", "install", "releases", fs.readdirSync(path.join(os.homedir(), ".pi", "agent", "install", "releases")).filter((name) => /^\d+\.\d+\.\d+$/.test(name)).sort((a, b) => b.localeCompare(a, undefined, { numeric: true })).find((name) => fs.existsSync(path.join(os.homedir(), ".pi", "agent", "install", "releases", name, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "index.js"))) ?? "", "node_modules"));
const piEntry = path.join(piModules, "@earendil-works", "pi-coding-agent", "dist", "index.js");
if (!fs.existsSync(piEntry)) throw new Error(`host Pi package entry missing: ${piEntry}`);
register("data:text/javascript," + encodeURIComponent(`export async function resolve(specifier, context, next) { return specifier === "@earendil-works/pi-coding-agent" ? { url: ${JSON.stringify(pathToFileURL(piEntry).href)}, shortCircuit: true } : next(specifier, context); }`));

const argv = process.argv.slice(2);
const arg = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
const outdir = arg("--out");
const label = arg("--label") ?? "unlabelled";
const agentDirArg = arg("--agent-dir");
const outside = (p) => path.isAbsolute(p) && (() => { const r = path.relative(repo, path.resolve(p)); return r !== "" && (r.startsWith("..") || path.isAbsolute(r)); })();
if (!outdir || !outside(outdir)) throw new Error("--out must be an absolute directory outside the repository");
if (agentDirArg && !outside(agentDirArg)) throw new Error("--agent-dir must be an absolute directory outside the repository");

const sub = path.join(repo, "agent", "extensions", "subagent");
// Role discovery reads the profile agent folder: discover before any controlled environment is set.
process.env.PI_CODING_AGENT_DIR = path.join(repo, "agent");
const { discoverAgents } = await import(pathToFileURL(path.join(sub, "agents.ts")).href);
const cic = await import(pathToFileURL(path.join(sub, "code-integrations.ts")).href);
const ROLES = fs.readdirSync(path.join(repo, "agent", "agents")).filter((f) => f.endsWith(".md")).map((f) => f.slice(0, -3)).sort();
const live = discoverAgents(repo, "user").agents;
const sha256 = (text) => createHash("sha256").update(text).digest("hex");
const countOf = (text, needle) => text.split(needle).length - 1;
const MARKERS = {
	shellSyntaxHeading: "## Shell syntax",
	artifactPlacementHeading: "## Artifact placement",
	sharedBuildFolderRule: cic.SHARED_BUILD_FOLDER_RULE,
	relocationSafety: "Do not move live SQLite",
	noAutomaticGraphBuild: "Missing graphs never authorize a fresh graph build",
	rustBuildHeading: "## Rust build output",
	rustCargoCommandRule: "Use it for every cargo command",
	codeNavigationHeading: "## Code navigation integrations",
	candidateNavigationHeading: "## Candidate navigation and shared retrieval",
	serenaProjectPath: "pass project explicitly as",
	qmdSearchMention: "qmd_search",
	graphReferenceHeading: "## Graph reference location",
	globalGraphHeading: "## Global graph reference",
	integrationsNotLoaded: "## Integrations not loaded",
	packageResources: "Package resources:",
	handoffHeading: "## Final handoff to main",
	nestedAgentsSentence: "do not authorize nested agents",
};
const markerCounts = (text) => Object.fromEntries(Object.entries(MARKERS).map(([key, needle]) => [key, countOf(text, needle)]));
const repeatedLines = (text) => {
	const counts = new Map();
	for (const line of text.split(/\r?\n/).map((l) => l.trim().replace(/\s+/g, " ")).filter((l) => l.length >= 40)) counts.set(line, (counts.get(line) ?? 0) + 1);
	let occurrences = 0, chars = 0;
	for (const [line, n] of counts) if (n > 1) { occurrences += n - 1; chars += line.length * (n - 1); }
	return { repeatedLineOccurrences: occurrences, repeatedLineChars: chars };
};
const toolNames = (args) => { const i = args.indexOf("--tools"); return i >= 0 ? args[i + 1].split(",") : []; };

// Controlled world: integration files, Cargo manifest, graph artifacts and package root are temp fixtures only.
const fixtureRoot = path.join(outdir, "fixtures");
const writeFile = (file, text = "") => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };
function makeWorld(name, spec = {}) {
	const base = path.join(fixtureRoot, name);
	const agentDir = path.join(base, "agent");
	const home = path.join(base, "home");
	const candidate = path.join(base, "candidate");
	const modules = path.join(agentDir, "npm", "node_modules");
	fs.mkdirSync(home, { recursive: true });
	fs.mkdirSync(path.join(candidate, ".git"), { recursive: true });
	if (spec.ponytail) { writeFile(path.join(modules, "@dietrichgebert", "ponytail", "pi-extension", "index.js")); writeFile(path.join(modules, "@dietrichgebert", "ponytail", "skills", "ponytail-review", "SKILL.md")); }
	if (spec.serena) writeFile(path.join(modules, "@bacnh85", "pi-serena", "extensions", "index.ts"));
	if (spec.graphifyExtension) writeFile(path.join(modules, "graphify-pi", "extensions", "graphify.ts"));
	if (spec.graphifySkill) writeFile(path.join(agentDir, "skills", "graphify", "SKILL.md"));
	const qmdExtension = path.join(base, "qmd", "extensions", "qmd", "index.ts");
	if (spec.qmd) writeFile(qmdExtension);
	if (spec.cargo) writeFile(path.join(candidate, "Cargo.toml"), "[package]\nname = \"fixture\"\n");
	if (spec.projectGraph) { writeFile(path.join(candidate, "graphify-out", "graph.json"), "{}"); writeFile(path.join(candidate, "graphify-out", "GRAPH_REPORT.md"), "# report\n"); writeFile(path.join(candidate, "graphify-out", "wiki", "index.md"), "# wiki\n"); }
	if (spec.globalGraph) { writeFile(path.join(home, ".graphify", "global-graph.json"), "{}"); writeFile(path.join(home, ".graphify", "global-manifest.json"), JSON.stringify({ repos: {} })); writeFile(path.join(home, ".graphify", "wiki", "index.md"), "# global\n"); }
	let packageRoot = null;
	if (spec.pkg) { packageRoot = path.join(base, "package"); fs.mkdirSync(path.join(packageRoot, "skills", "engineering-harness"), { recursive: true }); fs.mkdirSync(path.join(packageRoot, "skills", "agent-creation"), { recursive: true }); }
	return { name, agentDir, home, candidate, qmdExtension, packageRoot };
}
// os.homedir() follows USERPROFILE on Windows; getAgentDir() reads PI_CODING_AGENT_DIR on every call.
function enter(world) { process.env.PI_CODING_AGENT_DIR = world.agentDir; process.env.HOME = world.home; process.env.USERPROFILE = world.home; }
const assemble = (agent, world, { codeIntegrationsEnabled, launchArgs, cwd, packageRootPath = world.packageRoot }) =>
	cic.assembleChildSystemPrompt(agent, { codeIntegrationsEnabled, cwd, packageRoot: packageRootPath, launchArgs, qmdExtension: world.qmdExtension, globalGraphDirectory: path.join(world.home, ".graphify") });
const promptDir = path.join(outdir, "prompts", label);
fs.mkdirSync(promptDir, { recursive: true });
function record(shape, role, cwdLabel, text, args, enabled) {
	const file = path.join(promptDir, `${shape.replace(/[^\w.-]+/g, "_")}__${cwdLabel}__${role}.txt`);
	fs.writeFileSync(file, text);
	const tools = toolNames(args);
	return { shape, role, cwd: cwdLabel, codeIntegrations: enabled, chars: text.length, sha256: sha256(text), tokens: "NOT MEASURED",
		headings: [...text.matchAll(/^## .*$/gm)].length, ...repeatedLines(text), components: markerCounts(text), toolCount: tools.length, toolNameChars: tools.join(",").length, promptFile: file };
}

const rows = [];
// Live rows: real role bodies and allowlists in two candidates, with a controlled present world (or an empty --agent-dir: missing integrations).
const liveWorld = makeWorld("live", { ponytail: true, serena: true, qmd: true, graphifyExtension: true, graphifySkill: true });
if (agentDirArg) liveWorld.agentDir = path.resolve(agentDirArg);
const secondCandidate = path.join(fixtureRoot, "second-candidate");
fs.mkdirSync(path.join(secondCandidate, ".git"), { recursive: true });
const candidates = { "profile-checkout": repo, "second-checkout": secondCandidate };
for (const role of ROLES) {
	for (const [cwdLabel, cwd] of Object.entries(candidates)) {
		const agent = live.find((a) => a.name === role);
		if (!agent) throw new Error(`live role not discovered: ${role}`);
		enter(liveWorld);
		const args = [];
		try {
			const enabled = cic.configureCodeIntegrations(args, agent, [], liveWorld.qmdExtension);
			rows.push(record("live", role, cwdLabel, assemble(agent, liveWorld, { codeIntegrationsEnabled: enabled, launchArgs: args, cwd }), args, enabled));
		} catch (error) {
			rows.push({ shape: "live", role, cwd: cwdLabel, refused: String(error.message).slice(0, 200) });
		}
	}
}

// Fixture shapes: identical specs for BEFORE and AFTER; plain candidate unless the spec adds Cargo, graphs or a package root.
const minimal = { ponytail: true };
const customRole = { name: "custom-role", systemPrompt: "CUSTOM ROLE BODY: read and report only.", tools: ["read", "grep", "find", "ls"] };
const SHAPES = [
	{ name: "minimal-general-worker", role: "general-worker", spec: minimal, description: "general-worker; Ponytail only; no Cargo, no graph, no global graph, no QMD/Serena/Graphify, no package" },
	{ name: "rust-general-worker", role: "general-worker", spec: { ...minimal, cargo: true }, description: "minimal-general-worker plus Cargo.toml at the candidate root" },
	{ name: "rust-backend-worker", role: "backend-worker", spec: { ...minimal, cargo: true }, description: "backend-worker plus Cargo.toml at the candidate root" },
	{ name: "full-graph-qmd-package-general-worker", role: "general-worker", spec: { ponytail: true, qmd: true, serena: true, graphifyExtension: true, graphifySkill: true, projectGraph: true, globalGraph: true, pkg: true }, description: "general-worker with Ponytail, QMD, Serena, Graphify extension and skill, project graph, global graph and package root; no Cargo" },
	{ name: "package-custom-role", role: "custom-role", spec: { pkg: true }, description: "non-configured role (read/grep/find/ls allowlist) with a package root" },
];
const fixtureRows = [];
for (const shape of SHAPES) {
	const world = makeWorld(shape.name, shape.spec);
	enter(world);
	const agent = shape.role === "custom-role" ? customRole : live.find((a) => a.name === shape.role);
	if (!agent) throw new Error(`fixture role not discovered: ${shape.role}`);
	const args = shape.role === "custom-role" ? ["--tools", customRole.tools.join(",")] : [];
	const enabled = shape.role === "custom-role" ? false : cic.configureCodeIntegrations(args, agent, [], world.qmdExtension);
	const text = assemble(agent, world, { codeIntegrationsEnabled: enabled, launchArgs: args, cwd: world.candidate });
	const row = { ...record(`fixture:${shape.name}`, shape.role, "fixture-candidate", text, args, enabled), description: shape.description, spec: shape.spec, launchArgs: args };
	rows.push(row);
	fixtureRows.push(row);
}
rows.push({ shape: "package-generated-defaults", role: "(all)", cwd: "profile-checkout", notMeasured: "pi-package is absent in this candidate; generated package defaults are not regenerated. Package-note shapes are covered by the fixture rows." });

fs.mkdirSync(outdir, { recursive: true });
const summary = {
	label, assembler: "assembleChildSystemPrompt", generatedAt: new Date().toISOString(), node: process.version, platform: os.platform(),
	agentDir: agentDirArg ? "controlled empty --agent-dir (missing integrations)" : "controlled present integration world",
	controlledWorld: "temp agent dir, temp HOME (HOME and USERPROFILE), temp candidates and package roots under <out>/fixtures; no real profile, session, secret, private DB or package file read",
	tokenNote: "Tokens not measured. Chars only; built-in and MCP tool schema bytes are not measured (tool names only).",
	fixtureShapes: fixtureRows.map(({ shape, role, chars, description, spec, components, toolCount, codeIntegrations, launchArgs }) => ({ shape, role, chars, description, spec, components, toolCount, codeIntegrations, launchArgs })),
	rows,
};
fs.writeFileSync(path.join(outdir, `measure-${label}.json`), JSON.stringify(summary, null, 2) + "\n");
for (const r of rows) {
	if (r.refused) console.log([label, r.shape, r.cwd, r.role, "REFUSED", r.refused].join("\t"));
	else if (r.notMeasured) console.log([label, r.shape, r.notMeasured].join("\t"));
	else console.log([label, r.shape, r.cwd, r.role, `chars=${r.chars}`, `headings=${r.headings}`, `repeatedLineOcc=${r.repeatedLineOccurrences}`, `tools=${r.toolCount}`, `sha256=${r.sha256.slice(0, 12)}`].join("\t"));
}
console.log(`json=${path.join(outdir, `measure-${label}.json`)}`);
