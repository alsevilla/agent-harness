// Role registry and lifecycle contracts (RED first): the packaged profile registers exactly the 20 generic roles, every definition agrees
// with the registry, and lifecycle ownership stays explicit. Project-local domain roles are not part of this generic profile.
import { test } from "bun:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { hostModules } from "./host-modules.ts";
const modules = hostModules(["@earendil-works/pi-coding-agent"]);
const { parseFrontmatter } = await import(pathToFileURL(`${modules}/@earendil-works/pi-coding-agent/dist/index.js`).href);
const probePath = fileURLToPath(new URL("./fixtures/role-registry-probe.mjs", import.meta.url));
const agentsPath = pathToFileURL(fileURLToPath(new URL("../agents.ts", import.meta.url))).href;
const discoverAgents = (cwd: string, scope: "project" | "both") => {
  const probe = spawnSync("node", ["--experimental-transform-types", probePath, agentsPath, cwd, scope], {
    cwd: process.cwd(), env: { ...process.env, NATIVE_PROBE_HOST_MODULES: modules },
    encoding: "utf8", timeout: 30000, windowsHide: true,
  });
  assert.equal(probe.status, 0, probe.stdout + probe.stderr);
  return JSON.parse(probe.stdout) as { agents: import("../agents.ts").AgentConfig[]; error?: string };
};

const integrations = JSON.parse(fs.readFileSync(new URL("../integrations.json", import.meta.url), "utf8"));
const roles = JSON.parse(fs.readFileSync(new URL("../../../roles.json", import.meta.url), "utf8"));

const GENERIC_ROLES = [
  "api-specialist", "architecture-specialist", "backend-worker", "concurrency-specialist", "debugger", "devops-specialist",
  "frontend-worker", "general-worker", "observability-specialist", "oracle", "performance-specialist", "release-engineer",
  "reviewer", "scout", "security-specialist", "database-specialist", "database-worker", "test-engineer", "ui-ux-specialist", "platform-worker",
];

function frontmatter(name: string) {
  const file = new URL(`../../../agents/${name}.md`, import.meta.url);
  return parseDefinition(name, fs.readFileSync(file, "utf8"));
}

// Values come from the public parseFrontmatter that agents.ts uses, so YAML quoting is decoded: fallbackModel: "" and a bare key both mean the empty string.
function parseDefinition(name: string, text: string) {
  assert.ok(/^---\r?\n[\s\S]*?\r?\n---/.test(text), `${name}: frontmatter missing`);
  const { frontmatter: fm } = parseFrontmatter<Record<string, unknown>>(text);
  const field = (key: string) => (fm[key] === null ? "" : (fm[key] as string | undefined));
  const metadata = fm.metadata && typeof fm.metadata === "object" ? fm.metadata as Record<string, unknown> : {};
  const piField = (key: string) => Object.hasOwn(metadata, `pi.${key}`)
    ? metadata[`pi.${key}`] as string | undefined
    : field(key);
  return { text, name: field("name"), tools: piField("tools") ?? "", model: piField("model"), fallbackModel: piField("fallbackModel"), thinking: piField("thinking") };
}

test("Pi annotations override legacy frontmatter fields for project agents", () => {
  const cwd = fs.mkdtempSync(`${os.tmpdir()}/pi-annotations-`);
  const dir = pathToFileURL(`${cwd.replaceAll("\\", "/")}/.pi/agents/`);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(new URL("probe.md", dir), `---\nname: probe\ndescription: probe\nmodel: github-copilot/copilot-top\nfallbackModel: legacy/fallback\nthinking: low\ntools: read, bash\nmetadata:\n  pi.model: github-copilot/pi-picked\n  pi.fallbackModel: github-copilot/pi-fallback || anthropic/pi-last\n  pi.thinking: high\n  pi.tools: read, grep\n---\nbody\n`);
  try {
    const result = discoverAgents(cwd, "project");
    assert.equal(result.error, undefined);
    assert.deepEqual(result.agents.map(({ model, fallbackModel, thinking, tools }) => ({ model, fallbackModel, thinking, tools })), [{
      model: "github-copilot/pi-picked",
      fallbackModel: ["github-copilot/pi-fallback", "anthropic/pi-last"],
      thinking: "high",
      tools: ["read", "grep"],
    }]);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("empty fallbackModel annotations explicitly disable legacy fallback in project discovery", () => {
  for (const empty of ['""', "''"]) {
    const cwd = fs.mkdtempSync(`${os.tmpdir()}/pi-empty-fallback-`);
    const dir = `${cwd}/.pi/agents`;
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(`${dir}/probe.md`, `---\nname: probe\ndescription: probe\nfallbackModel: legacy/fallback\nmetadata:\n  pi.fallbackModel: ${empty}\n---\nbody\n`);
    try {
      const result = discoverAgents(cwd, "project");
      assert.equal(result.error, undefined);
      assert.deepEqual(result.agents.find((agent) => agent.name === "probe")?.fallbackModel, []);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  }
});

test("malformed known Pi annotations reject the project role instead of falling back", () => {
  for (const [key, value] of [["pi.tools", "17"], ["pi.tools", "''"], ["pi.tools", "', ,'"], ["pi.model", "17"], ["pi.model", "''"], ["pi.fallbackModel", "17"], ["pi.fallbackModel", "null"], ["pi.fallbackModel", "[]"], ["pi.thinking", "17"], ["pi.thinking", "unsupported"]]) {
    const cwd = fs.mkdtempSync(`${os.tmpdir()}/pi-invalid-annotation-`);
    const dir = `${cwd}/.pi/agents`;
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(`${dir}/probe.md`, `---\nname: probe\ndescription: probe\nmodel: github-copilot/copilot-native\ntools: read, bash\nmetadata:\n  ${key}: ${value}\n---\nbody\n`);
    try {
      const result = discoverAgents(cwd, "project");
      assert.equal(result.agents.some((agent) => agent.name === "probe"), false, `${key}: ${value}`);
      assert.equal(result.error, undefined);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  }
});

test("registry fields override annotations field-wise in real package discovery", () => {
  const cwd = fs.mkdtempSync(`${os.tmpdir()}/pi-registry-override-`);
  const user = `${cwd}/user`;
  fs.mkdirSync(`${user}/agents`, { recursive: true });
  fs.writeFileSync(`${user}/roles.json`, JSON.stringify([{ name: "backend-worker", provider: "override-provider", model: "override-model", tools: "read, grep" }]));
  fs.writeFileSync(`${user}/agents/backend-worker.md`, `---\nname: backend-worker\ndescription: user role\nmetadata:\n  pi.fallbackModel: github-copilot/pi-fallback || anthropic/pi-last\n  pi.thinking: high\n  pi.model: ignored/annotation\n  pi.tools: bash\n---\nbody\n`);
  const oldAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = user;
  try {
    const result = discoverAgents(cwd, "both");
    assert.equal(result.error, undefined);
    const role = result.agents.find((agent) => agent.name === "backend-worker");
    assert.ok(role);
    assert.equal(role.source, "user");
    assert.equal(role.model, "override-provider/override-model");
    assert.deepEqual(role.tools, ["read", "grep"]);
    assert.deepEqual(role.fallbackModel, ["github-copilot/pi-fallback", "anthropic/pi-last"]);
    assert.equal(role.thinking, "high");
  } finally {
    if (oldAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = oldAgentDir;
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("registry registers exactly the 20 generic roles, unique, without statusline-setup", () => {
  assert.equal(roles.length, 20);
  assert.equal(new Set(roles.map((r: { name: string }) => r.name)).size, 20);
  assert.deepEqual(roles.map((r: { name: string }) => r.name).sort(), [...GENERIC_ROLES].sort());
  assert.ok(!roles.some((r: { name: string }) => r.name === "statusline-setup"));
  assert.ok(!fs.existsSync(new URL("../../../agents/statusline-setup.md", import.meta.url)), "statusline-setup definition removed");
  assert.deepEqual(fs.readdirSync(new URL("../../../agents/", import.meta.url)).filter((f) => f.endsWith(".md")).sort(), GENERIC_ROLES.map((n) => `${n}.md`).sort());
});

test("every generic role receives standard code navigation integrations", () => {
  assert.equal(integrations.roles.length, 20);
  assert.ok(integrations.roles.includes("database-worker"));
  assert.ok(integrations.roles.includes("database-specialist"));
  assert.deepEqual([...integrations.roles].sort(), roles.map((r: { name: string }) => r.name).sort());
});

test("every role definition agrees with the registry", () => {
  for (const role of roles) {
    const fm = frontmatter(role.name);
    assert.equal(fm.name, role.name, `${role.name}: name`);
    assert.equal(fm.model, `${role.provider}/${role.model}`, `${role.name}: primary model`);
    assert.equal(fm.fallbackModel, role.fallbackModel, `${role.name}: fallbackModel`);
    assert.equal(fm.thinking, role.thinking, `${role.name}: thinking`);
    assert.equal(fm.tools, role.tools, `${role.name}: tools`);
  }
});

test("backend-worker declarations match project discovery without registry overrides", () => {
  const cwd = fs.mkdtempSync(`${os.tmpdir()}/pi-backend-declaration-`);
  const isolatedUser = `${cwd}/user`;
  const projectRoot = `${cwd}/project`;
  const dir = `${projectRoot}/.pi/agents`;
  const source = fs.readFileSync(new URL("../../../agents/backend-worker.md", import.meta.url), "utf8");
  fs.mkdirSync(`${isolatedUser}/agents`, { recursive: true });
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(`${isolatedUser}/roles.json`, "[]");
  fs.writeFileSync(`${projectRoot}/package.json`, JSON.stringify({ name: "isolated-project" }));
  fs.writeFileSync(`${dir}/backend-worker.md`, source);
  const oldAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = isolatedUser;
  try {
    const declaration = parseDefinition("backend-worker", source);
    const result = discoverAgents(projectRoot, "project");
    assert.equal(result.error, undefined);
    const actual = result.agents.find((agent) => agent.name === "backend-worker");
    assert.ok(actual, "backend-worker: project discovery omitted the declaration");
    const role = roles.find((entry: { name: string }) => entry.name === "backend-worker");
    assert.ok(role);
    assert.equal(declaration.model, `${role.provider}/${role.model}`, "backend-worker: declared primary model");
    assert.equal(declaration.fallbackModel, role.fallbackModel, "backend-worker: declared fallback chain");
    assert.equal(declaration.thinking, role.thinking, "backend-worker: declared thinking");
    assert.equal(declaration.tools, role.tools, "backend-worker: declared Pi tools (not native aliases)");
    assert.equal(actual.model, `${role.provider}/${role.model}`);
    assert.deepEqual(actual.fallbackModel, role.fallbackModel ? role.fallbackModel.split(" || ") : []);
    assert.equal(actual.thinking, role.thinking);
    assert.deepEqual(actual.tools, ["read", "grep", "find", "ls", "bash", "powershell", "edit"]);
  } finally {
    if (oldAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = oldAgentDir;
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("release engineer links its assigned ship module and keeps model metadata", () => {
  const fm = frontmatter("release-engineer");
  assert.ok(fm.model, "release-engineer: missing model");
  assert.ok(fm.thinking, "release-engineer: missing thinking level");
  assert.ok(fm.text.includes("engineering-harness/ship/index.md"), "release-engineer: missing assigned module engineering-harness/ship/index.md");
});

test("release engineer has precise edit but not bulk write", () => {
  const fm = frontmatter("release-engineer");
  assert.match(fm.tools, /(^|,\s*)edit(\s*,|$)/);
  assert.ok(!/(^|,\s*)write(\s*,|$)/.test(fm.tools));
  assert.match(fm.text, /do \*\*not\*\* modify product implementation code/i);
});

test("registry mirrors precise edit restriction for implementation workers", () => {
  for (const name of ["backend-worker", "frontend-worker", "general-worker", "platform-worker"]) {
    const role = roles.find((r: { name: string }) => r.name === name);
    assert.ok(role, name);
    assert.match(role.tools, /(^|,\s*)edit(\s*,|$)/);
    assert.ok(!/(^|,\s*)write(\s*,|$)/.test(role.tools));
  }
});

test("database-worker uses implementation-worker metadata and database ownership", () => {
  const role = roles.find((r: { name: string }) => r.name === "database-worker");
  assert.ok(role);
  assert.deepEqual({ provider: role.provider, model: role.model, fallbackModel: role.fallbackModel, thinking: role.thinking, tools: role.tools }, { provider: "anthropic", model: role.model, fallbackModel: role.fallbackModel, thinking: role.thinking, tools: "read, grep, find, ls, bash, powershell, edit" });
  const text = fs.readFileSync(new URL("../../../agents/database-worker.md", import.meta.url), "utf8");
  assert.match(text, /schema.*migrations.*transactions/is);
  assert.match(text, /database-specialist/i);
});

test("implementation workers are backend, frontend, general and platform with registry-defined defaults", () => {
  assert.equal(roles.find((r: { name: string }) => r.name === "rust-worker"), undefined, "rust-worker retired from registry");
  assert.equal(fs.existsSync(new URL("../../../agents/rust-worker.md", import.meta.url)), false, "rust-worker definition retired");
  for (const name of ["backend-worker", "frontend-worker", "general-worker", "platform-worker", "database-worker"]) {
    const role = roles.find((r: { name: string }) => r.name === name);
    assert.ok(role, name);
    assert.equal(role.provider, "anthropic", name);
    assert.equal(typeof role.model, "string", name);
    assert.equal(typeof role.fallbackModel, "string", name);
    assert.equal(typeof role.thinking, "string", name);
    assert.equal(role.tools, "read, grep, find, ls, bash, powershell, edit", name);
  }
});

test("every role description is a YAML plain scalar (no ': ' that parses as a nested mapping)", () => {
  for (const role of roles) {
    const description = frontmatter(role.name).text.match(/^description:(.*)$/m)?.[1] ?? "";
    assert.ok(!/:\s/.test(description), `${role.name}: description contains ': ' and fails YAML frontmatter parsing`);
  }
});

test("lifecycle ownership is explicit: main PLAN, release SHIP and LEARN", () => {
  const plan = fs.readFileSync(new URL("../../../skills/engineering-harness/plan/index.md", import.meta.url), "utf8");
  const ship = fs.readFileSync(new URL("../../../skills/engineering-harness/ship/index.md", import.meta.url), "utf8");
  const learn = fs.readFileSync(new URL("../../../skills/engineering-harness/learn/index.md", import.meta.url), "utf8");
  assert.match(plan, /owned by the \*\*main orchestrator\*\*/i);
  assert.match(ship, /belongs to the `release-engineer` role/i);
  assert.match(learn, /belongs to the `release-engineer` role/i);
});

test("routing keeps generic domain adjacency and leaves project-local domain specialists to the project", () => {
  const route = fs.readFileSync(new URL("../../../skills/engineering-harness/references/routing.md", import.meta.url), "utf8");
  assert.match(route, /project-local domain specialists/i);
  assert.match(route, /database-worker/i);
  assert.match(route, /database-specialist/i);
  assert.match(route, /Tokio.*concurrency-specialist/i);
  assert.match(route, /deployment.*devops-specialist/i);
  assert.match(route, /self-contained packet.*exact unresolved question/is);
});

test("quoted empty fallbackModel decodes to the registry empty value; a non-empty fallback still differs", () => {
  const doc = (fallback: string) => `---\nname: probe\nmodel: anthropic/claude-haiku-5-5\n${fallback}\nthinking: low\ntools: read\n---\nbody\n`;
  assert.equal(parseDefinition("probe", doc('fallbackModel: ""')).fallbackModel, "");
  assert.equal(parseDefinition("probe", doc("fallbackModel: ''")).fallbackModel, "");
  // Discriminating control: a real fallback must not compare equal to the empty registry value.
  assert.notEqual(parseDefinition("probe", doc('fallbackModel: "github-copilot/gpt-6-luna"')).fallbackModel, "");
  assert.equal(parseDefinition("probe", doc('fallbackModel: "github-copilot/gpt-6-luna"')).fallbackModel, "github-copilot/gpt-6-luna");
});

// Platform implementation is a distinct writer: it applies accepted infrastructure contracts but never owns design, delivery or live mutation authority.
test("platform-worker is a precise-edit writer distinct from read-only devops design and release delivery", () => {
  const fm = frontmatter("platform-worker");
  assert.match(fm.tools, /(^|,\s*)edit(\s*,|$)/);
  assert.ok(!/(^|,\s*)write(\s*,|$)/.test(fm.tools));
  const devops = frontmatter("devops-specialist");
  assert.ok(!/(^|,\s*)edit(\s*,|$)/.test(devops.tools), "devops-specialist stays read-only");
  assert.match(fm.text, /editing files is not authority/i);
  assert.match(fm.text, /dry-run|plan validation/i);
  assert.match(fm.text, /explicit target[^.\n]*(tenant|subscription|namespace)/i);
  assert.match(fm.text, /never (print|expose|echo)[^.\n]*secret/i);
  assert.match(fm.text, /devops-specialist/);
  assert.match(fm.text, /release-engineer/);
});
