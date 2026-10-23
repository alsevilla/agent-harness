import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { after, test } from "node:test";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
const { assembleChildSystemPrompt, candidateNavigationGuidance, configureCodeIntegrations, CORE_GUIDANCE, graphReferenceGuidance, packageResourceGuidance, unavailableIntegrationGuidance } = await import("../code-integrations.ts");
// Controlled fixtures: a nonexistent global graph directory (no host ~/.graphify read), and git checkouts under a temp root removed at the end.
const EMPTY_GLOBAL = join(tmpdir(), "code-integrations-no-global-graph");
const fixtureRoot = fs.mkdtempSync(join(tmpdir(), "code-integrations-cwd-"));
after(() => fs.rmSync(fixtureRoot, { recursive: true, force: true }));
function repoAt(name: string): string {
  const dir = join(fixtureRoot, name);
  fs.mkdirSync(join(dir, ".git"), { recursive: true });
  return dir;
}
// Every optional integration launched: Ponytail extension, Serena and QMD tools, Graphify skill (as configureCodeIntegrations emits them).
const FULL_LAUNCH = ["--extension", "/fx/npm/node_modules/@dietrichgebert/ponytail/pi-extension/index.js", "--extension", "/fx/npm/node_modules/@bacnh85/pi-serena/extensions/index.ts", "--extension", "/fx/qmd/index.ts", "--skill", "/fx/skills/graphify/SKILL.md", "--tools", "read,grep,find,ls,serena_find_symbol,qmd_search"];
function assembled(cwd: string, options: { launchArgs?: string[]; packageRoot?: string | null; enabled?: boolean; name?: string } = {}): string {
  return assembleChildSystemPrompt({ name: options.name ?? "general-worker", systemPrompt: "ROLE BODY" }, { codeIntegrationsEnabled: options.enabled ?? true, cwd, packageRoot: options.packageRoot ?? null, launchArgs: options.launchArgs ?? [], globalGraphDirectory: EMPTY_GLOBAL });
}
const config = JSON.parse(fs.readFileSync(new URL("../integrations.json", import.meta.url), "utf8"));
const unsafeMutations = [
  "serena_replace_symbol_body", "serena_insert_before_symbol", "serena_insert_after_symbol",
  "serena_rename_symbol", "serena_safe_delete_symbol", "serena_replace_content",
];
function role(name: string) {
  const filePath = new URL(`../../../agents/${name}.md`, import.meta.url);
  const content = fs.readFileSync(filePath, "utf8");
  const frontmatter = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  assert.ok(frontmatter, `${name}: frontmatter missing`);
  const toolsLine = frontmatter[1].match(/^tools:\s*([^\r\n]*)/m);
  assert.ok(toolsLine, `${name}: tools declaration missing`);
  return { name, description: "actual role test", source: "user" as const, filePath: fileURLToPath(filePath),
    tools: toolsLine[1].split(",").map(tool => tool.trim()) };
}
function effectiveTools(agent: ReturnType<typeof role>) {
  const args: string[] = [];
  assert.equal(configureCodeIntegrations(args, agent), true);
  const index = args.indexOf("--tools");
  assert.ok(index >= 0 && args[index + 1], "effective allowlist missing");
  return args[index + 1].split(",");
}
for (const name of ["backend-worker", "frontend-worker", "general-worker", "database-worker"]) {
  test(`${name} actual frontmatter keeps precise edit, excludes write and six Serena mutations`, () => {
    const agent = role(name);
    assert.ok(agent.tools.includes("edit"));
    assert.ok(!agent.tools.includes("write"));
    const tools = withAgentDir({ ponytailExtension: true, ponytailSkill: true }, () => effectiveTools(agent));
    for (const tool of agent.tools) assert.ok(tools.includes(tool), `role tool lost: ${tool}`);
    assert.ok(!tools.includes("write"));
    for (const tool of unsafeMutations) assert.ok(!tools.includes(tool), `unexpected mutation: ${tool}`);
    assert.ok(config.readOnlyTools.length > 0, "read-only integrations unexpectedly absent");
    for (const tool of config.readOnlyTools) assert.ok(tools.includes(tool), `read-only integration lost: ${tool}`);
  });
}
// Core guidance is unconditional for every integrations-enabled and package-shape child, so these rules are asserted on CORE_GUIDANCE.
test("shared code-leaf guidance specifies artifact placement and missing-path handoff", () => {
  assert.match(CORE_GUIDANCE, /_scratch\/<task>/);
  assert.match(CORE_GUIDANCE, /_evidence\/<task>/);
  assert.match(CORE_GUIDANCE, /absolute.*paths.*task packet/i);
  assert.match(CORE_GUIDANCE, /do not create.*beside the primary checkout/i);
  assert.match(CORE_GUIDANCE, /return.*main.*missing/i);
  assert.match(CORE_GUIDANCE, /report.*artifact paths.*handoff/i);
});
test("shared guidance treats live SQLite and running executables as relocation blockers", () => {
  assert.match(CORE_GUIDANCE, /SQLite.*-wal.*-shm/i);
  assert.match(CORE_GUIDANCE, /running executable/i);
  assert.match(CORE_GUIDANCE, /verify processes have stopped before relocating/i);
  assert.match(CORE_GUIDANCE, /Restart only with verified DB_PATH[\s\S]*otherwise leave services stopped/i);
});
test("worktree policy permits safe relocation without a known restart configuration", () => {
  const paths = ["../../../AGENTS.md", "../../../../README.md", "../README.md", "../../../skills/engineering-harness/worktree/index.md"];
  for (const path of paths) {
    const policy = fs.readFileSync(new URL(path, import.meta.url), "utf8");
    assert.match(policy, /unknown restart configuration does not block authorized relocation/i, path);
  }
});
test("package resource guidance states precedence and empty outside the package", () => {
  assert.equal(packageResourceGuidance(null), "");
  const note = packageResourceGuidance("C:\\pkg");
  assert.match(note, /Precedence: these bundled paths take effect over any profile path/);
  assert.match(note, /Backend, frontend, graphify and browser skill catalogs are not bundled/);
  assert.match(note, /Roles not bundled in this package are unavailable and are never dispatched\./);
});
test("database-specialist remains read-only with no precise-edit or write grant", () => {
  const agent = role("database-specialist");
  assert.ok(!agent.tools.includes("edit") && !agent.tools.includes("write"));
  const tools = withAgentDir({ ponytailExtension: true, ponytailSkill: true }, () => effectiveTools(agent));
  for (const tool of [...agent.tools, ...config.readOnlyTools]) assert.ok(tools.includes(tool), tool);
  for (const tool of ["edit", "write", ...unsafeMutations]) assert.ok(!tools.includes(tool), tool);
});
test("actual read-only scout grants remain unchanged", () => {
  const agent = role("scout");
  assert.ok(!agent.tools.includes("edit") && !agent.tools.includes("write"));
  const tools = withAgentDir({ ponytailExtension: true, ponytailSkill: true }, () => effectiveTools(agent));
  for (const tool of [...agent.tools, ...config.readOnlyTools]) assert.ok(tools.includes(tool), tool);
  for (const tool of ["edit", "write", ...unsafeMutations]) assert.ok(!tools.includes(tool), tool);
});

// Ponytail is optional for reviewer launches only: fixtures toggle its extension/skill and the other integrations stay required.
type Present = { ponytailExtension?: boolean; ponytailSkill?: boolean; qmd?: boolean; serena?: boolean; graphifyExtension?: boolean; graphifySkill?: boolean };
const ponytailExtensionPath = (dir: string) => join(dir, "npm", "node_modules", "@dietrichgebert", "ponytail", "pi-extension", "index.js");
const ponytailSkillPath = (dir: string) => join(dir, "npm", "node_modules", "@dietrichgebert", "ponytail", "skills", "ponytail-review", "SKILL.md");
function withAgentDir<T>(present: Present, run: (dir: string, qmdExtension?: string) => T): T {
  const { ponytailExtension = false, ponytailSkill = false, qmd = true, serena = true, graphifyExtension = true, graphifySkill = true } = present;
  const dir = fs.mkdtempSync(join(tmpdir(), "code-integrations-fixture-"));
  const packages = join(dir, "npm", "node_modules");
  const files = [
    ...(ponytailExtension ? [ponytailExtensionPath(dir)] : []),
    ...(ponytailSkill ? [ponytailSkillPath(dir)] : []),
    ...(serena ? [join(packages, "@bacnh85", "pi-serena", "extensions", "index.ts")] : []),
    ...(graphifyExtension ? [join(packages, "graphify-pi", "extensions", "graphify.ts")] : []),
    ...(graphifySkill ? [join(dir, "skills", "graphify", "SKILL.md")] : []),
  ];
  for (const file of files) { fs.mkdirSync(join(file, ".."), { recursive: true }); fs.writeFileSync(file, ""); }
  const saved = agentDir;
  agentDir = dir;
  try { return run(dir, qmd ? undefined : join(dir, "qmd-absent", "index.ts")); } finally { agentDir = saved; fs.rmSync(dir, { recursive: true, force: true }); }
}
test("reviewer launches with Ponytail absent: normal reviewer integrations and no Ponytail grant", () => {
  withAgentDir({}, () => {
    const args: string[] = [];
    assert.equal(configureCodeIntegrations(args, role("reviewer")), true);
    assert.ok(!args.some(arg => /ponytail/i.test(arg)), args.join(" "));
    assert.equal(args.filter(arg => arg === "--extension").length, 3, "qmd, serena and graphify extensions");
    assert.ok(args.includes("--skill"), "graphify skill still loaded");
  });
});
test("reviewer with Ponytail extension and review skill loads both for supplemental guidance", () => {
  withAgentDir({ ponytailExtension: true, ponytailSkill: true }, dir => {
    const args: string[] = [];
    assert.equal(configureCodeIntegrations(args, role("reviewer")), true);
    for (const [flag, file] of [["--extension", ponytailExtensionPath(dir)], ["--skill", ponytailSkillPath(dir)]]) {
      const index = args.indexOf(file);
      assert.ok(index > 0 && args[index - 1] === flag, `${flag} ${file} missing`);
    }
  });
});
test("reviewer with Ponytail extension but no review skill still launches with the extension", () => {
  withAgentDir({ ponytailExtension: true }, dir => {
    const args: string[] = [];
    assert.equal(configureCodeIntegrations(args, role("reviewer")), true);
    assert.ok(args.includes(ponytailExtensionPath(dir)));
    assert.ok(!args.includes(ponytailSkillPath(dir)));
  });
});
for (const name of ["general-worker", "scout"]) {
  test(`${name} still fails closed when Ponytail is absent`, () => {
    withAgentDir({}, () => {
      assert.throws(() => configureCodeIntegrations([], role(name)), new RegExp(`Code integration missing for ${name}: .*ponytail`));
    });
  });
}
test("reviewer with Serena absent launches with QMD and Graphify, without Serena tools", () => {
  const run = launch("reviewer", { ponytailExtension: true, ponytailSkill: true, serena: false });
  assert.equal(run.enabled, true);
  assert.equal(loaded.serena(run), false);
  assert.equal(loaded.qmd(run), true);
  assert.equal(loaded.graphifyExtension(run), true);
  assert.deepEqual(integrationFamilies(run.tools), ["qmd_"]);
});
test("reviewer keeps read-only tools and excludes edit, write and Serena mutations with Ponytail absent", () => {
  withAgentDir({}, () => {
    const tools = effectiveTools(role("reviewer"));
    assert.ok(!tools.includes("edit") && !tools.includes("write"));
    for (const tool of unsafeMutations) assert.ok(!tools.includes(tool), tool);
    for (const tool of config.readOnlyTools) assert.ok(tools.includes(tool), `read-only integration lost: ${tool}`);
  });
});
test("code-leaf guidance makes Ponytail conditional on the loaded extension", () => {
  const loadedText = assembled(repoAt("ponytail-loaded"), { launchArgs: FULL_LAUNCH });
  assert.doesNotMatch(loadedText, /Ponytail's native extension is present in this launch/);
  assert.equal(loadedText.split("When Ponytail's native extension is loaded in this launch").length - 1, 1);
  // Without the Ponytail extension in the launch argv, the Ponytail paragraph is absent.
  const unloaded = assembled(repoAt("ponytail-absent"), { launchArgs: FULL_LAUNCH.filter(arg => !arg.includes("ponytail")) });
  assert.equal(unloaded.includes("When Ponytail's native extension is loaded"), false);
});
test("reviewer keeps its verdict contract; Ponytail review skill is optional supplemental guidance", () => {
  const content = fs.readFileSync(new URL("../../../agents/reviewer.md", import.meta.url), "utf8");
  for (const verdict of ["APPROVE", "APPROVE WITH NOTES", "REQUEST CHANGES", "ESCALATE"]) assert.match(content, new RegExp(`^${verdict}$`, "m"));
  assert.match(content, /ponytail-review/);
  assert.match(content, /optional/i);
  assert.match(content, /Verdict: Ship[\s\S]*do(es)? not (override|replace)/);
  assert.match(content, /absent[\s\S]*not a blocker/i);
});

// Expanded contract: QMD, Serena and Graphify are optional for every configured role; Ponytail stays required except for reviewer.
const sorted = (values: string[]) => [...new Set(values)].sort();
function flagValues(args: string[], flag: string) { return args.flatMap((arg, i) => args[i - 1] === flag ? [arg] : []); }
function toolsOf(args: string[]) { const index = args.indexOf("--tools"); assert.ok(index >= 0 && args[index + 1], "effective allowlist missing"); return args[index + 1].split(","); }
// Non-reviewer roles require Ponytail, so the default fixture carries it; a case can still override it.
function launch(name: string, present: Present = {}, extraTools: string[] = []) {
  return withAgentDir({ ponytailExtension: true, ...present }, (dir, qmdExtension) => {
    const args: string[] = [];
    const enabled = configureCodeIntegrations(args, role(name), extraTools, qmdExtension);
    return { dir, enabled, extensions: flagValues(args, "--extension"), skills: flagValues(args, "--skill"), tools: toolsOf(args) };
  });
}
type Run = ReturnType<typeof launch>;
const loaded = {
  ponytail: (run: Run) => run.extensions.includes(ponytailExtensionPath(run.dir)),
  qmd: (run: Run) => run.extensions.some(file => file.endsWith(join("extensions", "qmd", "index.ts"))),
  serena: (run: Run) => run.extensions.some(file => file.includes("pi-serena")),
  graphifyExtension: (run: Run) => run.extensions.some(file => file.endsWith(join("graphify-pi", "extensions", "graphify.ts"))),
  graphifySkill: (run: Run) => run.skills.length > 0,
};
const integrationFamilies = (tools: string[]) => ["serena_", "qmd_"].filter(prefix => tools.some(tool => tool.startsWith(prefix)));
test("general-worker with QMD, Serena and Graphify all absent: Ponytail still loaded, ordinary tools only", () => {
  const agent = role("general-worker");
  const run = launch("general-worker", { qmd: false, serena: false, graphifyExtension: false, graphifySkill: false });
  assert.equal(run.enabled, true);
  assert.deepEqual(run.extensions, [ponytailExtensionPath(run.dir)]);
  assert.deepEqual(run.skills, []);
  assert.deepEqual(sorted(run.tools), sorted(agent.tools));
});
test("reviewer with Ponytail absent and all three optional integrations absent: reviewer tools only", () => {
  const agent = role("reviewer");
  const run = launch("reviewer", { ponytailExtension: false, ponytailSkill: false, qmd: false, serena: false, graphifyExtension: false, graphifySkill: false });
  assert.equal(run.enabled, true);
  assert.deepEqual(run.extensions, []);
  assert.deepEqual(run.skills, []);
  assert.deepEqual(sorted(run.tools), sorted(agent.tools));
});
const partialCases: [string, Present, Record<keyof typeof loaded, boolean>, string[]][] = [
  ["Serena absent", { serena: false }, { ponytail: true, qmd: true, serena: false, graphifyExtension: true, graphifySkill: true }, ["qmd_"]],
  ["QMD absent", { qmd: false }, { ponytail: true, qmd: false, serena: true, graphifyExtension: true, graphifySkill: true }, ["serena_"]],
  ["Graphify extension absent", { graphifyExtension: false }, { ponytail: true, qmd: true, serena: true, graphifyExtension: false, graphifySkill: true }, ["serena_", "qmd_"]],
  ["Graphify skill absent", { graphifySkill: false }, { ponytail: true, qmd: true, serena: true, graphifyExtension: true, graphifySkill: false }, ["serena_", "qmd_"]],
  ["QMD and Serena absent", { qmd: false, serena: false }, { ponytail: true, qmd: false, serena: false, graphifyExtension: true, graphifySkill: true }, []],
  ["QMD and Graphify skill absent", { qmd: false, graphifySkill: false }, { ponytail: true, qmd: false, serena: true, graphifyExtension: true, graphifySkill: false }, ["serena_"]],
];
for (const [label, present, expected, families] of partialCases) {
  test(`general-worker with ${label}: the other integrations and ordinary tools stay`, () => {
    const agent = role("general-worker");
    const run = launch("general-worker", present);
    assert.equal(run.enabled, true);
    for (const key of Object.keys(expected) as (keyof typeof loaded)[]) assert.equal(loaded[key](run), expected[key], key);
    assert.deepEqual(integrationFamilies(run.tools), families);
    for (const tool of agent.tools) assert.ok(run.tools.includes(tool), `role tool lost: ${tool}`);
  });
}
test("general-worker still fails closed when Ponytail is absent, even with every optional integration absent", () => {
  withAgentDir({ ponytailExtension: false, ponytailSkill: false, qmd: false, serena: false, graphifyExtension: false, graphifySkill: false }, () => {
    assert.throws(() => configureCodeIntegrations([], role("general-worker")), /Code integration missing for general-worker: .*ponytail/);
  });
});
test("unavailable integrations are named with fallback guidance; present ones are not", () => {
  withAgentDir({ serena: false, graphifySkill: false }, () => {
    const note = unavailableIntegrationGuidance("general-worker");
    assert.match(note, /Serena/);
    assert.match(note, /Graphify skill/);
    assert.doesNotMatch(note, /QMD/);
    assert.match(note, /read, grep and find/);
    assert.match(note, /do not call them/);
    // Shared code-leaf guidance already requires naming reduced capability in the handoff; the note must not repeat it.
    assert.doesNotMatch(note, /name the skipped integration/);
  });
  withAgentDir({ qmd: false }, (_dir, qmdExtension) => assert.match(unavailableIntegrationGuidance("general-worker", qmdExtension), /QMD/));
  withAgentDir({ ponytailExtension: false, ponytailSkill: false }, () => assert.match(unavailableIntegrationGuidance("reviewer"), /Ponytail.*ponytail-review/s));
  withAgentDir({ ponytailExtension: true, serena: true, qmd: true, graphifyExtension: true, graphifySkill: true }, () => assert.equal(unavailableIntegrationGuidance("general-worker"), ""));
});
test("shared guidance: a failing integration is reported once, not retried, and presence is not health", () => {
  const text = assembled(repoAt("failure-once"), { launchArgs: FULL_LAUNCH });
  assert.equal(text.split("do not retry it in a loop").length - 1, 1);
  assert.match(text, /reduced capability/i);
  assert.match(text, /does not prove the backend is healthy/i);
});
// Explicit role allowlists may name integration tools; an omitted integration drops them, while ordinary tools and per-launch grants stay.
test("explicit integration tool names are omitted with their integration; ordinary tools and grants stay", () => {
  const explicit = { ...role("general-worker"), tools: ["read", "serena_find_symbol", "qmd_search", "edit"] };
  const cases: [Present, string[], string[]][] = [
    [{ serena: false, qmd: false }, ["serena_find_symbol", "qmd_search"], []],
    [{ serena: false }, ["serena_find_symbol"], ["qmd_search"]],
    [{ qmd: false }, ["qmd_search"], ["serena_find_symbol"]],
    [{}, [], ["serena_find_symbol", "qmd_search"]],
  ];
  for (const [present, dropped, kept] of cases) {
    withAgentDir({ ponytailExtension: true, ...present }, (_dir, qmdExtension) => {
      const args: string[] = [];
      assert.equal(configureCodeIntegrations(args, explicit, ["request_decision"], qmdExtension), true);
      const tools = toolsOf(args);
      for (const tool of dropped) assert.ok(!tools.includes(tool), `${tool} leaked without its integration: ${JSON.stringify(present)}`);
      for (const tool of kept) assert.ok(tools.includes(tool), `${tool} dropped while its integration is present: ${JSON.stringify(present)}`);
      for (const tool of ["read", "edit", "request_decision"]) assert.ok(tools.includes(tool), `${tool} lost: ${JSON.stringify(present)}`);
    });
  }
});
// Non-configured roles keep the exact explicit allowlist plus grants; no integration filtering applies.
test("non-configured role keeps its explicit allowlist and grants unfiltered", () => {
  const args: string[] = [];
  assert.equal(configureCodeIntegrations(args, { ...role("general-worker"), name: "not-configured", tools: ["read", "serena_find_symbol"] }, ["request_decision"]), false);
  assert.deepEqual(args, ["--tools", "read,serena_find_symbol,request_decision"]);
});

// Characterization (GREEN before and after): shell and artifact rules stay unconditional for every role.
test("shared guidance keeps shell and artifact rules unconditional for every role", () => {
  assert.match(CORE_GUIDANCE, /export NAME='value'/);
  assert.match(CORE_GUIDANCE, /\$env:NAME, \$LASTEXITCODE/);
  assert.match(CORE_GUIDANCE, /Never submit it to bash/);
  assert.match(CORE_GUIDANCE, /_scratch\/<task>/);
});
// The runtime injects CARGO_TARGET_DIR into every child in a git checkout (build-env.ts), so the no-delete and no-server protection stays unconditional in the shared guidance.
test("shared build folder protection is unconditional for integrations-enabled children, not gated on Cargo", () => {
  assert.match(CORE_GUIDANCE, /When CARGO_TARGET_DIR is set, it is a shared per-checkout build folder: do not delete it and never run a server from it\./);
});
// Detailed Rust rules are applicable only with a Cargo manifest at the working directory or an ancestor up to the candidate root.
// Below-cwd manifests are not scanned (documented limit). The shared build-folder rule stays in core for every shape.
test("Rust build output rules apply only with a Cargo manifest at the working directory or an ancestor; the build-folder rule is always present", () => {
  const rule = "When CARGO_TARGET_DIR is set, it is a shared per-checkout build folder: do not delete it and never run a server from it.";
  const plain = repoAt("rust-plain");
  const deep = repoAt("rust-deep");
  fs.mkdirSync(join(deep, "a", "b", "c", "d"), { recursive: true });
  fs.writeFileSync(join(deep, "a", "b", "c", "d", "Cargo.toml"), "[package]\n");
  const manifestAtCwd = join(deep, "a", "b", "c", "d");
  for (const cwd of [plain, deep, join(deep, "a")]) {
    const text = assembled(cwd);
    assert.equal(text.includes("## Rust build output"), false, `no manifest at or above ${cwd}`);
    assert.equal(text.split(rule).length - 1, 1, cwd);
  }
  const text = assembled(manifestAtCwd);
  assert.equal(text.split("## Rust build output").length - 1, 1, manifestAtCwd);
  for (const rust of [/CARGO_TARGET_DIR/, /CARGO_INCREMENTAL=0/, /Use it for every cargo command; do not create or set another target directory/, /locks its file and breaks later builds/, /If CARGO_TARGET_DIR is unset/]) assert.match(text, rust, manifestAtCwd);
});
test("assembled child prompt: core headings once in every shape; navigation and retrieval only with their launch evidence", () => {
  const rule = "When CARGO_TARGET_DIR is set, it is a shared per-checkout build folder: do not delete it and never run a server from it.";
  const plain = repoAt("assembled-plain");
  const live = assembled(plain, { launchArgs: FULL_LAUNCH });
  assert.ok(live.startsWith("ROLE BODY"));
  for (const heading of ["## Shell syntax", "## Artifact placement", "## Integration and graph authority", "## Code navigation integrations", "## Candidate navigation and shared retrieval", "## Final handoff to main"]) assert.equal(live.split(heading).length - 1, 1, heading);
  assert.equal(live.split(rule).length - 1, 1);
  assert.equal(live.includes("## Rust build output"), false, "no Cargo manifest, so no Rust detail");
  const bare = assembled(plain);
  assert.equal(bare.includes("## Code navigation integrations"), false, "no integration in the launch, so no navigation section");
  assert.equal(bare.includes("## Candidate navigation and shared retrieval"), false);
  assert.equal(bare.split("## Final handoff to main").length - 1, 1);
  const pkg = assembled(plain, { enabled: false, packageRoot: "C:\\pkg" });
  assert.equal(pkg.split("## Shell syntax").length - 1, 1, "core is unconditional, so the package shape carries it too");
  assert.equal(pkg.split(rule).length - 1, 1);
  assert.doesNotMatch(pkg, /## Rust build output/);
  assert.match(pkg, /Package resources:/);
  assert.ok(pkg.includes("## Final handoff to main"));
});
// F2: package-shape children get no code guidance, so the build-folder rule is appended exactly once; integrations-enabled prompts keep it once too.
test("package-shape children carry the shared build-folder rule exactly once, and so does an integrations-enabled prompt", () => {
  const agent = { name: "general-worker", systemPrompt: "ROLE BODY" };
  const rule = "When CARGO_TARGET_DIR is set, it is a shared per-checkout build folder: do not delete it and never run a server from it.";
  const pkg = assembleChildSystemPrompt(agent, { codeIntegrationsEnabled: false, cwd: tmpdir(), packageRoot: "C:\\pkg", globalGraphDirectory: EMPTY_GLOBAL });
  assert.equal(pkg.split(rule).length - 1, 1);
  const live = assembleChildSystemPrompt(agent, { codeIntegrationsEnabled: true, cwd: tmpdir(), packageRoot: null, globalGraphDirectory: EMPTY_GLOBAL });
  assert.equal(live.split(rule).length - 1, 1);
});
test("shared code-leaf guidance keeps Ponytail, QMD and missing-graph authority limits", () => {
  const text = assembled(repoAt("authority-limits"), { launchArgs: FULL_LAUNCH });
  assert.match(text, /never overrides user requirements, candidate boundaries, required checks or delegation policy/);
  assert.match(text, /Do not reload its base skill/);
  assert.equal(text.split("Missing graphs never authorize a fresh graph build").length - 1, 1);
  assert.match(text, /run one focused qmd_search \(maxResults 3, at most 5\)[\s\S]*only when that context is needed/);
  assert.match(text, /Do not initialize\/update/);
  assert.match(text, /read-only roles must not build\/update graphs/i);
  assert.match(text, /Integrations never authorize nested agents, broader writes or new tasks/);
  assert.match(text, /Graph references never widen write authority\./);
});
test("graph reference keeps candidate scope, no automatic fallback and read-only limits in both launch shapes", () => {
  const root = fs.mkdtempSync(join(tmpdir(), "graph-guidance-"));
  try {
    const candidate = join(root, "candidate");
    const globalDir = join(root, "global");
    fs.mkdirSync(join(candidate, ".git"), { recursive: true });
    fs.mkdirSync(globalDir, { recursive: true });
    fs.writeFileSync(join(globalDir, "global-graph.json"), "{}");
    // Candidate scope (Serena project path) is candidate navigation, emitted only when Serena or QMD is launched.
    const scope = candidateNavigationGuidance(candidate, true, false);
    assert.ok(scope.includes("pass project explicitly as " + candidate), "candidate root must be named for Serena calls");
    assert.match(scope, /Never activate the primary checkout just because it holds the graph/);
    // Unmatched global corpus (no manifest source_path for this candidate) is not injected at all.
    const none = graphReferenceGuidance(candidate, globalDir);
    assert.equal(none, "", "unmatched global corpus must not be injected");
    // Manifest coverage: exact source_path match to the candidate graph.json; no project artifacts yet, so the global block carries the no-assumed-folder, read-only and fallback limits.
    fs.writeFileSync(join(globalDir, "global-manifest.json"), JSON.stringify({ repos: { candidateRepo: { source_path: join(candidate, "graphify-out", "graph.json") }, unrelatedRepo: { source_path: join(root, "elsewhere", "graphify-out", "graph.json") } } }));
    const matched = graphReferenceGuidance(candidate, globalDir);
    assert.match(matched, /No project Graphify artifacts were found at dispatch; do not ls\/read an assumed candidate graphify-out folder/);
    assert.match(matched, /Candidate\/primary checkout manifest matches: candidateRepo\n/);
    assert.equal(matched.includes("unrelatedRepo"), false, "unrelated manifest repositories are not listed");
    assert.match(matched, /read-only orientation/);
    assert.match(matched, /automatic fallback/);
    assert.match(matched, /never treat their nodes as candidate source evidence/);
    assert.match(matched, /Do not load the (entire|whole) global JSON/);
    assert.match(matched, /rebuild\/merge\/update it to repair a missing candidate folder/);
    assert.equal(matched.includes("## Graph reference location"), false);
    fs.mkdirSync(join(candidate, "graphify-out"), { recursive: true });
    fs.writeFileSync(join(candidate, "graphify-out", "graph.json"), "{}");
    const graph = graphReferenceGuidance(candidate, globalDir);
    assert.ok(graph.includes(join(candidate, "graphify-out", "graph.json")), "listed artifact must be its absolute path");
    assert.match(graph, /Use these absolute paths directly/);
    assert.match(graph, /Never change the candidate cwd\/project/);
    assert.match(graph, /Verify symbols and changed behavior against the candidate checkout/);
    assert.equal(graph.includes("graph reference access does not widen write authority"), false, "authority is stated once, in core");
    assert.match(assembled(candidate, { launchArgs: [] }), /Graph references never widen write authority\./);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("candidate retrieval pins the QMD prior-evidence verification contract, emitted only when QMD tools are launched", () => {
  const candidate = repoAt("qmd-contract");
  assert.match(candidateNavigationGuidance(candidate, false, true), /Treat retrieved notes as prior evidence; verify current files\/requirements in the candidate\./);
  assert.equal(candidateNavigationGuidance(candidate, false, false), "");
  assert.equal(graphReferenceGuidance(candidate, join(fixtureRoot, "no-global")), "");
});
