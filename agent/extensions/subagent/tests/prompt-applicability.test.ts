// Applicability matrix for assembled child prompts. Core guidance (shell, artifact bounds, shared build folder, relocation safety,
// graph/integration authority, compact handoff) is unconditional and appears exactly once per prompt shape. Rust, Serena/QMD, graph and
// package detail appear only with actual launch evidence: structural Cargo manifests, --tools names, real --extension/--skill paths and graph artifacts.
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { after, test } from "node:test";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join, win32 } from "node:path";
import { fileURLToPath } from "node:url";

let agentDir = fileURLToPath(new URL("../../../", import.meta.url));
// Node equivalent of the former module mock: resolve the Pi package to a data: module exposing only getAgentDir.
(globalThis as any).__piTestAgentDir = () => agentDir;
registerHooks({
  resolve(specifier: string, context: object, nextResolve: (s: string, c: object) => { url: string }) {
    if (specifier === "@earendil-works/pi-coding-agent") return { url: "data:text/javascript," + encodeURIComponent("export const getAgentDir = () => globalThis.__piTestAgentDir();"), shortCircuit: true };
    return nextResolve(specifier, context);
  },
} as never);
const { assembleChildSystemPrompt, configureCodeIntegrations } = await import("../code-integrations.ts");

const ROLE_BODY = "ROLE BODY";
// Controlled global home: an empty directory, so no host ~/.graphify corpus can leak into any assertion.
const EMPTY_GLOBAL = fs.mkdtempSync(join(tmpdir(), "applicability-empty-global-"));
after(() => fs.rmSync(EMPTY_GLOBAL, { recursive: true, force: true }));
const SHARED = "When CARGO_TARGET_DIR is set, it is a shared per-checkout build folder: do not delete it and never run a server from it.";
const CORE = {
  shell: "## Shell syntax",
  artifact: "## Artifact placement",
  shared: SHARED,
  relocation: "Do not move live SQLite .db, -wal or -shm files or a running executable.",
  noGraphBuild: "Missing graphs never authorize a fresh graph build as a prerequisite.",
  graphAuthority: "Graph references never widen write authority.",
  nested: "Integrations never authorize nested agents, broader writes or new tasks",
  installRule: "do not install, reconfigure, rebuild or repair an integration or index",
  handoff: "## Final handoff to main",
};
const count = (text: string, needle: string) => text.split(needle).length - 1;

function role(name: string) {
  const content = fs.readFileSync(new URL(`../../../agents/${name}.md`, import.meta.url), "utf8");
  const toolsLine = content.match(/^tools:\s*([^\r\n]*)/m);
  assert.ok(toolsLine, `${name}: tools declaration missing`);
  return { name, systemPrompt: ROLE_BODY, tools: toolsLine[1].split(",").map(tool => tool.trim()) };
}

type Spec = { ponytail?: boolean; serena?: boolean; qmd?: boolean; graphifyExtension?: boolean; graphifySkill?: boolean; projectGraph?: boolean; globalGraph?: boolean; globalMatch?: boolean; cargoAt?: string[]; cwdRel?: string; pkg?: boolean };
// Controlled world: every integration file, Cargo manifest, graph artifact and package root is a temp fixture; no real profile or home is read.
function world(spec: Spec) {
  const root = fs.mkdtempSync(join(tmpdir(), "prompt-applicability-"));
  const dir = join(root, "agent");
  const home = join(root, "home");
  const candidate = join(root, "candidate");
  const packages = join(dir, "npm", "node_modules");
  const put = (file: string, text = "") => { fs.mkdirSync(join(file, ".."), { recursive: true }); fs.writeFileSync(file, text); };
  fs.mkdirSync(join(candidate, ".git"), { recursive: true });
  fs.mkdirSync(home, { recursive: true });
  if (spec.ponytail) put(join(packages, "@dietrichgebert", "ponytail", "pi-extension", "index.js"));
  if (spec.serena) put(join(packages, "@bacnh85", "pi-serena", "extensions", "index.ts"));
  if (spec.graphifyExtension) put(join(packages, "graphify-pi", "extensions", "graphify.ts"));
  if (spec.graphifySkill) put(join(dir, "skills", "graphify", "SKILL.md"));
  const qmdExtension = join(root, "qmd", "extensions", "qmd", "index.ts");
  if (spec.qmd) { put(qmdExtension); put(join(qmdExtension, "..", "config.json"), "{}"); }
  for (const rel of spec.cargoAt ?? []) put(join(candidate, rel, "Cargo.toml"), "[package]\nname = \"fixture\"\n");
  if (spec.projectGraph) { put(join(candidate, "graphify-out", "graph.json"), "{}"); put(join(candidate, "graphify-out", "GRAPH_REPORT.md"), "# report\n"); }
  if (spec.globalGraph) { put(join(home, ".graphify", "global-graph.json"), "{}"); put(join(home, ".graphify", "global-manifest.json"), JSON.stringify({ repos: { [spec.globalMatch ? "candidate-repo" : "unrelated-repo"]: { source_path: spec.globalMatch ? join(candidate, "graphify-out", "graph.json") : join(root, "elsewhere", "graphify-out", "graph.json") } } })); }
  const packageRoot = join(root, "package");
  if (spec.pkg) { fs.mkdirSync(join(packageRoot, "skills", "engineering-harness"), { recursive: true }); fs.mkdirSync(join(packageRoot, "skills", "agent-creation"), { recursive: true }); }
  const cwd = join(candidate, spec.cwdRel ?? "");
  fs.mkdirSync(cwd, { recursive: true });
  return { root, dir, home, candidate, cwd, qmdExtension, packageRoot, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}
// One launch: configureCodeIntegrations decides the allowlist exactly as index.ts does, then the prompt is assembled from those launch args.
function launch(agent: { name: string; systemPrompt: string; tools?: string[] }, spec: Spec, extraTools: string[] = []) {
  const w = world(spec);
  const saved = agentDir;
  agentDir = w.dir;
  try {
    const args: string[] = [];
    const enabled = configureCodeIntegrations(args, agent as never, extraTools, w.qmdExtension);
    const prompt = assembleChildSystemPrompt(agent, { codeIntegrationsEnabled: enabled, cwd: w.cwd, packageRoot: spec.pkg ? w.packageRoot : null, launchArgs: args, qmdExtension: w.qmdExtension, globalGraphDirectory: join(w.home, ".graphify") } as never);
    return { prompt, args, enabled, candidate: w.candidate, cwd: w.cwd };
  } finally {
    agentDir = saved;
    w.cleanup();
  }
}

test("plain general-worker without optional integrations gets core and the fallback only: no Rust, Serena, QMD or graph detail", () => {
  const { prompt } = launch(role("general-worker"), { ponytail: true });
  for (const needle of Object.values(CORE)) assert.equal(count(prompt, needle), 1, needle);
  for (const absent of ["## Rust build output", "CARGO_INCREMENTAL", "qmd_search", "pass project explicitly as", "## Graph reference location", "## Global graph reference", "The graphify skill is on demand", "do not ls/read an assumed"]) assert.equal(prompt.includes(absent), false, absent);
  assert.match(prompt, /## Integrations not loaded in this launch/);
  assert.match(prompt, /read, grep and find/);
});

test("Cargo at the candidate root gives a Rust-capable worker the full Rust detail; a plain general-worker gets none", () => {
  const rust = launch(role("backend-worker"), { ponytail: true, cargoAt: [""] }).prompt;
  for (const needle of ["## Rust build output", "Workers inherit CARGO_TARGET_DIR", "CARGO_INCREMENTAL=0", "Use it for every cargo command; do not create or set another target directory", "locks its file and breaks later builds", "If CARGO_TARGET_DIR is unset"]) assert.equal(count(rust, needle), 1, needle);
  assert.equal(count(launch(role("general-worker"), { ponytail: true }).prompt, "## Rust build output"), 0);
  // Structural, not role-keyed: a general-worker running in a Cargo checkout gets the same Rust detail.
  assert.equal(count(launch(role("general-worker"), { ponytail: true, cargoAt: [""] }).prompt, "## Rust build output"), 1);
});

test("Cargo above the working directory (workspace root) is detected; Cargo only below it is a documented limit and the shared build-folder rule stays", () => {
  const workspace = launch(role("backend-worker"), { ponytail: true, cargoAt: [""], cwdRel: "crates/app" }).prompt;
  assert.equal(count(workspace, "## Rust build output"), 1);
  const below = launch(role("backend-worker"), { ponytail: true, cargoAt: ["crates/app"] }).prompt;
  assert.equal(count(below, "## Rust build output"), 0, "nested manifest below cwd is not scanned (no recursive scan)");
  assert.equal(count(below, SHARED), 1);
});

test("QMD and Serena sentences appear only when their tools are in the launch allowlist", () => {
  const none = launch(role("general-worker"), { ponytail: true }).prompt;
  assert.equal(none.includes("qmd_search"), false);
  assert.equal(none.includes("pass project explicitly as"), false);
  const present = launch(role("general-worker"), { ponytail: true, serena: true, qmd: true });
  assert.equal(count(present.prompt, "pass project explicitly as " + present.candidate), 1);
  assert.equal(count(present.prompt, "qmd_search"), 1);
});

test("graph reference is included only for actual artifacts; with no artifacts only the core authority line remains", () => {
  const plain = launch(role("general-worker"), { ponytail: true }).prompt;
  assert.equal(plain.includes("## Graph reference location"), false);
  assert.equal(plain.includes("## Global graph reference"), false);
  assert.equal(count(plain, CORE.noGraphBuild), 1);
});

test("project graph with no Graphify tool or skill: listed absolute artifacts and write authority still appear", () => {
  const run = launch(role("general-worker"), { ponytail: true, projectGraph: true, serena: false, qmd: false });
  assert.equal(count(run.prompt, "## Graph reference location"), 1);
  assert.ok(run.prompt.includes(join(run.candidate, "graphify-out", "graph.json")), "listed artifact must be its absolute path");
  assert.equal(count(run.prompt, CORE.graphAuthority), 1);
  assert.equal(run.prompt.includes("The graphify skill is on demand"), false, "no Graphify skill text without the skill");
});

test("global graph with manifest coverage: read-only orientation block with no-automatic-fallback limits, no project location", () => {
  const run = launch(role("general-worker"), { ponytail: true, globalGraph: true, globalMatch: true });
  for (const needle of ["## Global graph reference", "candidate-repo", "never treat their nodes as candidate source evidence", "Do not load the entire global JSON", "read-only orientation", "do not ls/read an assumed candidate graphify-out folder", "automatic fallback"]) assert.ok(run.prompt.includes(needle), needle);
  assert.equal(run.prompt.includes("## Graph reference location"), false);
  assert.equal(count(run.prompt, CORE.graphAuthority), 1);
});

test("unmatched global corpus is not injected: no global block and no unrelated repository name, even with a present ~/.graphify", () => {
  const run = launch(role("general-worker"), { ponytail: true, globalGraph: true });
  assert.equal(run.prompt.includes("## Global graph reference"), false);
  assert.equal(run.prompt.includes("unrelated-repo"), false);
  assert.equal(run.prompt.includes("Existing global graph"), false);
});

test("every prompt shape carries the core guidance and the handoff exactly once", () => {
  const shapes = [
    launch(role("general-worker"), { ponytail: true }).prompt,
    launch(role("backend-worker"), { ponytail: true, cargoAt: [""], serena: true, qmd: true, graphifyExtension: true, graphifySkill: true, projectGraph: true, globalGraph: true }).prompt,
    launch({ name: "custom-role", systemPrompt: ROLE_BODY, tools: ["read", "grep", "find", "ls"] }, { ponytail: true }).prompt,
    launch(role("general-worker"), { ponytail: true, pkg: true }).prompt,
  ];
  for (const [index, prompt] of shapes.entries()) for (const [key, needle] of Object.entries(CORE)) assert.equal(count(prompt, needle), 1, `shape ${index}: ${key}`);
});

test("package shape assembles core, the package note and the handoff once, with no integration or Rust detail", () => {
  const w = world({ pkg: true });
  try {
    const agent = { name: "general-worker", systemPrompt: ROLE_BODY };
    const prompt = assembleChildSystemPrompt(agent, { codeIntegrationsEnabled: false, cwd: w.cwd, packageRoot: w.packageRoot, launchArgs: [], qmdExtension: w.qmdExtension, globalGraphDirectory: join(w.home, ".graphify") } as never);
    assert.equal(count(prompt, "Package resources:"), 1);
    assert.match(prompt, /engineering-harness/);
    for (const [key, needle] of Object.entries(CORE)) assert.equal(count(prompt, needle), 1, key);
    for (const absent of ["## Code navigation integrations", "## Rust build output", "qmd_search", "pass project explicitly as"]) assert.equal(prompt.includes(absent), false, absent);
  } finally {
    w.cleanup();
  }
});

test("overlapping instructions are not restated: install/reconfigure rule and shared build-folder rule appear once", () => {
  const fallback = launch(role("general-worker"), { ponytail: true, serena: false, qmd: false, graphifySkill: false, graphifyExtension: false }).prompt;
  assert.equal(count(fallback, "reconfigure"), 1, "reconfigure stated once");
  assert.equal(count(fallback, CORE.installRule), 1);
  const full = launch(role("backend-worker"), { ponytail: true, cargoAt: [""], serena: true, qmd: true, graphifyExtension: true, graphifySkill: true, projectGraph: true }).prompt;
  assert.equal(count(full, SHARED), 1);
  assert.equal(count(full, "Missing graphs never authorize"), 1);
  assert.equal(count(full, "Use it for every cargo command"), 1);
});

test("unavailable integrations keep their fallback: named, read/grep/find fallback, and do-not-call instruction", () => {
  const run = launch(role("general-worker"), { ponytail: true, serena: false });
  assert.match(run.prompt, /Not loaded: .*Serena extension/);
  assert.match(run.prompt, /read, grep and find/);
  assert.match(run.prompt, /do not call them/);
});

test("reviewer launch without Ponytail gets no Ponytail navigation paragraph", () => {
  const run = launch(role("reviewer"), { ponytail: false, serena: true, qmd: true, graphifyExtension: true, graphifySkill: true });
  assert.equal(run.args.some(arg => /ponytail/i.test(arg)), false, run.args.join(" "));
  assert.equal(run.prompt.includes("When Ponytail's native extension is loaded in this launch"), false);
  for (const needle of Object.values(CORE)) assert.equal(count(run.prompt, needle), 1, needle);
});

// Windows launches pass backslash paths in argv; the Ponytail and Graphify-skill detectors must accept both separators.
test("Ponytail and Graphify-skill navigation are detected from Windows backslash launch paths", () => {
	const ponytailArgv = ["--extension", win32.join("C:/", "Users", "dev", "agent", "npm", "node_modules", "@dietrichgebert", "ponytail", "pi-extension", "index.js")];
	const skillArgv = ["--skill", win32.join("C:/", "Users", "dev", "agent", "skills", "graphify", "SKILL.md")];
	assert.ok(ponytailArgv[1].includes(win32.sep) && skillArgv[1].includes(win32.sep), "fixture must be a backslash Windows path");
	const agent = { name: "general-worker", systemPrompt: ROLE_BODY };
	const options = { codeIntegrationsEnabled: true, cwd: join(tmpdir(), "applicability-no-such-candidate"), packageRoot: null, globalGraphDirectory: EMPTY_GLOBAL };
	assert.match(assembleChildSystemPrompt(agent, { ...options, launchArgs: ponytailArgv }), /When Ponytail's native extension is loaded/);
	assert.match(assembleChildSystemPrompt(agent, { ...options, launchArgs: skillArgv }), /The graphify skill is on demand/);
});

// Caller regression: the production launch must forward its argv (args holds --tools and integration --extension/--skill) into the prompt assembler.
test("production caller forwards the launch argv to assembleChildSystemPrompt, so capability detection sees the real launch", () => {
	const source = fs.readFileSync(new URL("../index.ts", import.meta.url), "utf8");
	const start = source.indexOf("assembleChildSystemPrompt(agent, {");
	assert.ok(start >= 0, "production assembler call missing");
	assert.ok(source.slice(start, source.indexOf("})", start)).includes("launchArgs: args"), "launchArgs: args must be passed at the production call");
});
