import { mock, test } from "bun:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

let agentDir = fileURLToPath(new URL("../../../", import.meta.url));
mock.module("@earendil-works/pi-coding-agent", () => ({
  getAgentDir: () => agentDir,
}));
const { configureCodeIntegrations, CODE_NAVIGATION_GUIDANCE, packageResourceGuidance, unavailableIntegrationGuidance } = await import("../code-integrations.ts");
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
for (const name of ["backend-worker", "frontend-worker", "general-worker"]) {
  test(`${name} actual frontmatter keeps precise edit, excludes write and six Serena mutations`, () => {
    const agent = role(name);
    assert.ok(agent.tools.includes("edit"));
    assert.ok(!agent.tools.includes("write"));
    const tools = effectiveTools(agent);
    for (const tool of agent.tools) assert.ok(tools.includes(tool), `role tool lost: ${tool}`);
    assert.ok(!tools.includes("write"));
    for (const tool of unsafeMutations) assert.ok(!tools.includes(tool), `unexpected mutation: ${tool}`);
    assert.ok(config.readOnlyTools.length > 0, "read-only integrations unexpectedly absent");
    for (const tool of config.readOnlyTools) assert.ok(tools.includes(tool), `read-only integration lost: ${tool}`);
  });
}
test("shared code-leaf guidance specifies artifact placement and missing-path handoff", () => {
  assert.match(CODE_NAVIGATION_GUIDANCE, /_scratch\/<task>/);
  assert.match(CODE_NAVIGATION_GUIDANCE, /_evidence\/<task>/);
  assert.match(CODE_NAVIGATION_GUIDANCE, /absolute.*paths.*task packet/i);
  assert.match(CODE_NAVIGATION_GUIDANCE, /do not create.*beside the primary checkout/i);
  assert.match(CODE_NAVIGATION_GUIDANCE, /return.*main.*missing/i);
  assert.match(CODE_NAVIGATION_GUIDANCE, /report.*artifact paths.*handoff/i);
});
test("shared guidance treats live SQLite and running executables as relocation blockers", () => {
  assert.match(CODE_NAVIGATION_GUIDANCE, /SQLite.*-wal.*-shm/i);
  assert.match(CODE_NAVIGATION_GUIDANCE, /running executable/i);
  assert.match(CODE_NAVIGATION_GUIDANCE, /verify processes have stopped before relocating/i);
  assert.match(CODE_NAVIGATION_GUIDANCE, /Restart only with verified DB_PATH[\s\S]*otherwise leave services stopped/i);
});
test("worktree policy permits safe relocation without a known restart configuration", () => {
  const paths = ["../../../AGENTS.md", "../../../../README.md", "../README.md", "../../../skills/engineering-harness/worktree/index.md", "../../../skills/engineering-harness/worktree/guide.md"];
  for (const path of paths) {
    const policy = fs.readFileSync(new URL(path, import.meta.url), "utf8");
    assert.match(policy, /unknown restart configuration does not block authorized relocation/i, path);
  }
});
test("package resource guidance states precedence and empty outside the package", () => {
  assert.equal(packageResourceGuidance(null), "");
  const note = packageResourceGuidance("C:\\pkg");
  assert.match(note, /Precedence: these bundled paths take effect over any profile path/);
  assert.match(note, /Backend, frontend, graphify, browser and RFID skill catalogs are not bundled/);
  for (const role of ["hardware-integration", "attendance-domain-specialist", "event-reconciliation-specialist", "messaging-specialist", "privacy-compliance-specialist"]) assert.match(note, new RegExp(role));
  assert.match(note, /never dispatched/);
});
test("actual read-only scout grants remain unchanged", () => {
  const agent = role("scout");
  assert.ok(!agent.tools.includes("edit") && !agent.tools.includes("write"));
  const tools = effectiveTools(agent);
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
  assert.doesNotMatch(CODE_NAVIGATION_GUIDANCE, /Ponytail's native extension is present in this launch/);
  assert.match(CODE_NAVIGATION_GUIDANCE, /When Ponytail's native extension is loaded in this launch/);
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
    assert.match(note, /do not call, install, reconfigure or rebuild/i);
  });
  withAgentDir({ qmd: false }, (_dir, qmdExtension) => assert.match(unavailableIntegrationGuidance("general-worker", qmdExtension), /QMD/));
  withAgentDir({ ponytailExtension: false, ponytailSkill: false }, () => assert.match(unavailableIntegrationGuidance("reviewer"), /Ponytail.*ponytail-review/s));
  withAgentDir({ ponytailExtension: true, serena: true, qmd: true, graphifyExtension: true, graphifySkill: true }, () => assert.equal(unavailableIntegrationGuidance("general-worker"), ""));
});
test("shared guidance: a failing integration is reported once, not retried, and presence is not health", () => {
  assert.match(CODE_NAVIGATION_GUIDANCE, /do not retry it in a loop/i);
  assert.match(CODE_NAVIGATION_GUIDANCE, /reduced capability/i);
  assert.match(CODE_NAVIGATION_GUIDANCE, /does not prove the backend is healthy/i);
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
