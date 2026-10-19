// Role registry and lifecycle contracts (RED first): the packaged profile registers exactly the 20 generic roles, every definition agrees
// with the registry, and lifecycle ownership stays explicit. Project-local domain roles are not part of this generic profile.
import { test } from "bun:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import { hostModules } from "./host-modules.ts";
import { resolveModelTier } from "../model-routing.ts";
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

// Canonical definitions carry no Pi settings: model, fallback, thinking and Pi tools come from roles.json; text is the definition file.
function frontmatter(name: string) {
  const file = new URL(`../../../agents/${name}.md`, import.meta.url);
  const declaration = parseDefinition(name, fs.readFileSync(file, "utf8"));
  const role = roles.find((entry: { name: string }) => entry.name === name);
  assert.ok(role, `${name}: roles.json entry`);
  const tier = role.modelTiers[role.defaultModelTier];
  return { ...declaration, tools: role.tools as string, model: tier.model as string, fallbackModel: tier.fallbackModel as string, thinking: tier.thinking as string };
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

test("registry contains the approved tier pairs without changing default role fields", () => {
  const expected: Record<string, { economy: [string, string]; capable?: [string, string] }> = {
    "backend-worker": { economy: ["openai-codex/gpt-6-luna", "anthropic/claude-haiku-5-5"], capable: ["anthropic/claude-sonnet-5-5", "openai-codex/gpt-6.1-sol"] },
    "frontend-worker": { economy: ["anthropic/claude-haiku-5-5", "openai-codex/gpt-6-luna"], capable: ["anthropic/claude-sonnet-5-5", "openai-codex/gpt-6.1-sol"] },
    "database-worker": { economy: ["anthropic/claude-haiku-5-5", "openai-codex/gpt-6-luna"], capable: ["openai-codex/gpt-6.1-sol", "anthropic/claude-sonnet-5-5"] },
    "general-worker": { economy: ["anthropic/claude-haiku-5-5", "openai-codex/gpt-6-luna"], capable: ["anthropic/claude-sonnet-5-5", "openai-codex/gpt-6.1-sol"] },
    "platform-worker": { economy: ["anthropic/claude-haiku-5-5", "openai-codex/gpt-6-luna"], capable: ["anthropic/claude-sonnet-5-5", "openai-codex/gpt-6.1-sol"] },
    "test-engineer": { economy: ["anthropic/claude-haiku-5-5", "openai-codex/gpt-6-luna"], capable: ["anthropic/claude-sonnet-5-5", "openai-codex/gpt-6.1-sol"] },
    scout: { economy: ["anthropic/claude-haiku-5-5", "openai-codex/gpt-6-luna"] },
  };
  for (const [name, tiers] of Object.entries(expected)) {
    const role = roles.find((item: { name: string }) => item.name === name);
    assert.ok(role);
    for (const [tier, [model, fallback]] of Object.entries(tiers)) {
      const configured = role.modelTiers[tier];
      assert.ok(configured, `${name}.${tier}`);
      assert.equal(configured.model, model);
      assert.equal(configured.fallbackModel, fallback);
    }
  }
  assert.equal(Object.values(expected).reduce((count, tiers) => count + Object.keys(tiers).length, 0), 13);
  const backendDefault = roles.find((role: { name: string }) => role.name === "backend-worker");
  // User-approved preset update (approved-user-presets.json): backend-worker now defaults to its economy tier; capable stays configured and unchanged.
  assert.equal(backendDefault.defaultModelTier, "economy");
  assert.equal(backendDefault.modelTiers.capable.model, "anthropic/claude-sonnet-5-5");
  assert.equal(backendDefault.modelTiers.capable.fallbackModel, "openai-codex/gpt-6.1-sol");
  assert.equal(roles.find((role: { name: string }) => role.name === "scout").modelTiers.capable, undefined);
});

// Scenario regression for the written tier policy (routing.md "Explicit Pi model tier"). Fixtures pin what the existing resolver
// returns for a requested tier on the real package registry; they do not measure whether an orchestrator chooses that tier.
test("written tier scenarios resolve through the real package registry to the configured model, fallback and thinking", () => {
  const cwd = fs.mkdtempSync(`${os.tmpdir()}/pi-tier-scenarios-`);
  const user = `${cwd}/user`;
  fs.mkdirSync(`${user}/agents`, { recursive: true });
  const oldAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = user;
  try {
    const result = discoverAgents(cwd, "both");
    assert.equal(result.error, undefined);
    const role = (name: string) => {
      const found = result.agents.find((agent) => agent.name === name);
      assert.ok(found, name);
      return found;
    };
    const scenarios: Array<[string, "economy" | "capable", string, string, string]> = [
      ["backend-worker", "economy", "openai-codex/gpt-6-luna", "anthropic/claude-haiku-5-5", "medium"], // bounded backend change
      ["frontend-worker", "economy", "anthropic/claude-haiku-5-5", "openai-codex/gpt-6-luna", "medium"], // bounded presentational change
      ["database-worker", "capable", "openai-codex/gpt-6.1-sol", "anthropic/claude-sonnet-5-5", "low"], // consequential migration
      ["platform-worker", "capable", "anthropic/claude-sonnet-5-5", "openai-codex/gpt-6.1-sol", "low"], // consequential infrastructure
      ["test-engineer", "capable", "anthropic/claude-sonnet-5-5", "openai-codex/gpt-6.1-sol", "low"], // data-integrity verification
      ["observability-specialist", "capable", "anthropic/claude-sonnet-5-5", "openai-codex/gpt-6.1-sol", "low"], // capable tier added by the approved preset update
    ];
    for (const [name, tier, model, fallback, thinking] of scenarios) {
      const resolved = resolveModelTier(role(name), tier);
      assert.equal(resolved.modelTier, tier, `${name}: tier`);
      assert.equal(resolved.model, model, `${name}.${tier}: model`);
      assert.deepEqual(resolved.fallbackModel, [fallback], `${name}.${tier}: fallback`);
      assert.equal(resolved.thinking, thinking, `${name}.${tier}: thinking`);
    }
    // Omission on an economy-default role runs economy, so high-risk work must request capable explicitly.
    const omitted = resolveModelTier(role("database-worker"));
    assert.equal(omitted.modelTier, "economy");
    assert.equal(omitted.model, "anthropic/claude-haiku-5-5");
    assert.deepEqual(omitted.fallbackModel, ["openai-codex/gpt-6-luna"]);
    assert.equal(omitted.thinking, "low");
    // Roles without a configured capable tier are refused for capable: the selection is unresolved, not economy.
    for (const name of ["scout"]) assert.throws(() => resolveModelTier(role(name), "capable"), /not supported/, name);
    // The resolver refuses any tier the role does not configure, including unsupported names.
    assert.throws(() => resolveModelTier(role("backend-worker"), "complex" as unknown as "economy"), /not supported/);
  } finally {
    if (oldAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = oldAgentDir;
    fs.rmSync(cwd, { recursive: true, force: true });
  }
}, 30000);

// Single source: roles.json owns every Pi setting; a canonical definition keeps only identity, native Copilot tools and the body.
const headerRemoval = JSON.parse(fs.readFileSync(new URL("./fixtures/header-removal-baseline.json", import.meta.url), "utf8")) as {
  roles: { name: string; headLfSha256: string; nativeToolsLine: string; descriptionLine: string; removed: string[]; bodySha256: string; expectedAfterLfSha256: string }[];
};
test("every canonical definition is header-free: identity and native tools only, all Pi settings live in roles.json", () => {
  assert.deepEqual(headerRemoval.roles.map((entry) => entry.name).sort(), [...GENERIC_ROLES].sort());
  for (const role of roles) {
    const text = fs.readFileSync(new URL(`../../../agents/${role.name}.md`, import.meta.url), "utf8");
    const { frontmatter: fm } = parseFrontmatter<Record<string, unknown>>(text);
    assert.equal(fm.name, role.name, `${role.name}: name`);
    assert.deepEqual(Object.keys(fm), ["name", "description", "tools"], `${role.name}: header keys`);
    const native = headerRemoval.roles.find((entry) => entry.name === role.name)!;
    assert.equal(text.replace(/\r\n/g, "\n").split("\n").find((line) => line.startsWith("tools:")), native.nativeToolsLine, `${role.name}: native Copilot tools unchanged`);
    assert.ok(typeof role.tools === "string" && role.tools.trim(), `${role.name}: roles.json tools`);
    assert.ok(role.modelTiers[role.defaultModelTier].model, `${role.name}: roles.json default model`);
  }
});

test("package discovery normalizes tier registry data and field-wise user tier overlay", () => {
  const cwd = fs.mkdtempSync(`${os.tmpdir()}/pi-tier-overlay-`);
  const user = `${cwd}/user`;
  fs.mkdirSync(`${user}/agents`, { recursive: true });
  fs.writeFileSync(`${user}/roles.json`, JSON.stringify([{ name: "backend-worker", modelTiers: { economy: { provider: "fixture-provider", model: "fixture-primary", fallbackModel: "fixture-fallback" } } }]));
  const oldAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = user;
  try {
    const result = discoverAgents(cwd, "both");
    assert.equal(result.error, undefined);
    const role = result.agents.find((item) => item.name === "backend-worker");
    assert.ok(role);
    assert.equal(role.source, "package");
    assert.equal(role.model, "openai-codex/gpt-6-luna", "the root model keeps the base default-tier projection (economy after the approved preset update)");
    assert.deepEqual(role.modelTiers?.economy, { model: "fixture-provider/fixture-primary", fallbackModel: ["fixture-fallback"] });
    assert.equal(role.modelTiers?.capable, undefined, "the optional modelTiers field is replaced atomically by the user overlay");
    fs.writeFileSync(`${user}/roles.json`, JSON.stringify([{ name: "backend-worker", modelTiers: {} }]));
    const emptyOverlay = discoverAgents(cwd, "both");
    assert.deepEqual(emptyOverlay.agents, [], "an explicit empty tier field replaces package tiers; the inherited economy default is then unconfigured, so the registry fails closed");
    assert.match(emptyOverlay.error ?? "", /defaultModelTier "economy" is not configured/);
  } finally {
    if (oldAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = oldAgentDir;
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("malformed tier registry fails closed", () => {
  for (const modelTiers of [{ extra: { provider: "p", model: "m", fallbackModel: "f" } }, { economy: { provider: "p", fallbackModel: "f" } }, { economy: { provider: "p", model: "m", fallbackModel: 3 } }, { economy: { provider: "p", model: "m", fallbackModel: "||" } }, { economy: { provider: "p", model: "m", fallbackModel: "f", tools: "edit" } }]) {
    const cwd = fs.mkdtempSync(`${os.tmpdir()}/pi-invalid-tier-registry-`);
    const user = `${cwd}/user`;
    fs.mkdirSync(`${user}/agents`, { recursive: true });
    fs.writeFileSync(`${user}/roles.json`, JSON.stringify([{ name: "backend-worker", modelTiers }]));
    const oldAgentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = user;
    try {
      const result = discoverAgents(cwd, "both");
      assert.equal(result.error?.includes("modelTiers"), true);
      assert.deepEqual(result.agents, []);
    } finally {
      if (oldAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = oldAgentDir;
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  }
});

test("a header-free definition outside the package declares no Pi settings of its own", () => {
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
    const result = discoverAgents(projectRoot, "project");
    assert.equal(result.error, undefined);
    const actual = result.agents.find((agent) => agent.name === "backend-worker");
    assert.ok(actual, "backend-worker: project discovery omitted the declaration");
    assert.equal(actual.source, "project");
    assert.equal(actual.model, undefined, "no Pi model in the header: the child inherits the dispatch default");
    assert.equal(actual.thinking, undefined);
    assert.deepEqual(actual.fallbackModel, undefined);
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

test("release engineer gains native write only as the named knowledge/release artifact grant", () => {
  const fm = frontmatter("release-engineer");
  assert.equal(fm.tools, "read, grep, find, ls, bash, powershell, edit, write");
  assert.match(fm.text, /do \*\*not\*\* modify product implementation code/i);
  assert.match(fm.text, /`write`[^\n]*new files? only[^\n]*explicitly named/i);
  assert.match(fm.text, /shell (redirection|heredoc)[^\n]*not a bypass/i);
  assert.match(fm.text, /normal guards still apply/i);
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
  const tier = role.modelTiers[role.defaultModelTier];
  assert.deepEqual({ defaultModelTier: role.defaultModelTier, model: tier.model, fallbackModel: tier.fallbackModel, thinking: tier.thinking, tools: role.tools }, { defaultModelTier: "economy", model: "anthropic/claude-haiku-5-5", fallbackModel: "openai-codex/gpt-6-luna", thinking: "low", tools: "read, grep, find, ls, bash, powershell, edit" });
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
    const tier = role.modelTiers[role.defaultModelTier];
    assert.match(tier.model, /^(anthropic|openai-codex)\/\S+$/, name); // exact per-role defaults are pinned by approved-user-presets.json
    assert.equal(typeof tier.fallbackModel, "string", name);
    assert.equal(typeof tier.thinking, "string", name);
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

// Tier-only registry (RED first): new-format reader contracts, exercised through the real SDK subprocess probe.
function discoverWithUserRoles(registry: unknown): { agents: import("../agents.ts").AgentConfig[]; error?: string } {
  const cwd = fs.mkdtempSync(`${os.tmpdir()}/pi-tier-only-`);
  const user = `${cwd}/user`;
  fs.mkdirSync(`${user}/agents`, { recursive: true });
  fs.writeFileSync(`${user}/roles.json`, JSON.stringify(registry));
  const oldAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = user;
  try {
    return discoverAgents(cwd, "both");
  } finally {
    if (oldAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = oldAgentDir;
    fs.rmSync(cwd, { recursive: true, force: true });
  }
}

const tierEntry = (model: unknown, fallbackModel: unknown, thinking: unknown) => ({ model, fallbackModel, thinking });
const tierOnlyBackend = (overrides: Record<string, unknown> = {}) => ({
  name: "backend-worker",
  defaultModelTier: "capable",
  modelTiers: { capable: tierEntry("fixture-provider/capable-model", "fixture-provider/fallback-model", "high") },
  ...overrides,
});
const BACKEND_TOOLS = ["read", "grep", "find", "ls", "bash", "powershell", "edit"];

test("tier-only overlay projects the configured default and keeps per-tier thinking", () => {
  const result = discoverWithUserRoles([tierOnlyBackend({
    defaultModelTier: "economy",
    modelTiers: {
      economy: tierEntry("fixture-provider/economy-model", "fixture-provider/economy-fallback || anthropic/claude-sonnet-5-5", "low"),
      capable: tierEntry("fixture-provider/capable-model", "", "high"),
    },
  })]);
  assert.equal(result.error, undefined);
  const role = result.agents.find((agent) => agent.name === "backend-worker");
  assert.ok(role);
  assert.equal(role.source, "package");
  assert.equal(role.defaultModelTier, "economy");
  assert.equal(role.model, "fixture-provider/economy-model");
  assert.deepEqual(role.fallbackModel, ["fixture-provider/economy-fallback", "anthropic/claude-sonnet-5-5"]);
  assert.equal(role.thinking, "low");
  assert.deepEqual(role.tools, BACKEND_TOOLS);
  assert.deepEqual(role.modelTiers, {
    economy: { model: "fixture-provider/economy-model", fallbackModel: ["fixture-provider/economy-fallback", "anthropic/claude-sonnet-5-5"], thinking: "low" },
    capable: { model: "fixture-provider/capable-model", fallbackModel: [], thinking: "high" },
  });
});

test("literal empty fallbackModel on a tier stays empty and invents no partner (Oracle shape)", () => {
  const result = discoverWithUserRoles([{ name: "oracle", defaultModelTier: "capable", modelTiers: { capable: tierEntry("anthropic/claude-opus-5-5", "", "high") } }]);
  assert.equal(result.error, undefined);
  const oracle = result.agents.find((agent) => agent.name === "oracle");
  assert.ok(oracle);
  assert.equal(oracle.defaultModelTier, "capable");
  assert.equal(oracle.model, "anthropic/claude-opus-5-5");
  assert.deepEqual(oracle.fallbackModel, []);
  assert.equal(oracle.thinking, "high");
});

test("malformed tier-only data fails the whole registry closed without legacy or annotation fallthrough", () => {
  const cases: [string, Record<string, unknown>, RegExp][] = [
    ["null defaultModelTier", tierOnlyBackend({ defaultModelTier: null }), /defaultModelTier must be economy or capable/],
    ["unknown defaultModelTier", tierOnlyBackend({ defaultModelTier: "premium" }), /defaultModelTier must be economy or capable/],
    ["default not configured", tierOnlyBackend({ defaultModelTier: "economy" }), /defaultModelTier "economy" is not configured/],
    ["unsupported effort", tierOnlyBackend({ modelTiers: { capable: tierEntry("fixture-provider/m", "", "extreme") } }), /modelTiers\.capable\.thinking/],
    ["effort casing is not aliased", tierOnlyBackend({ modelTiers: { capable: tierEntry("fixture-provider/m", "", "High") } }), /modelTiers\.capable\.thinking/],
    ["null effort", tierOnlyBackend({ modelTiers: { capable: tierEntry("fixture-provider/m", "", null) } }), /modelTiers\.capable\.thinking/],
    ["missing effort", tierOnlyBackend({ modelTiers: { capable: { model: "fixture-provider/m", fallbackModel: "" } } }), /modelTiers\.capable\.thinking/],
    ["unqualified model", tierOnlyBackend({ modelTiers: { capable: tierEntry("fixture-primary", "", "high") } }), /modelTiers\.capable\.model/],
    ["model with surrounding whitespace", tierOnlyBackend({ modelTiers: { capable: tierEntry(" fixture-provider/m", "", "high") } }), /modelTiers\.capable\.model/],
    ["null fallbackModel", tierOnlyBackend({ modelTiers: { capable: tierEntry("fixture-provider/m", null, "high") } }), /modelTiers\.capable\.fallbackModel/],
    ["array fallbackModel", tierOnlyBackend({ modelTiers: { capable: tierEntry("fixture-provider/m", ["fixture-provider/f"], "high") } }), /modelTiers\.capable\.fallbackModel/],
    ["unqualified fallback", tierOnlyBackend({ modelTiers: { capable: tierEntry("fixture-provider/m", "fallback-model", "high") } }), /modelTiers\.capable\.fallbackModel/],
    ["trailing fallback delimiter", tierOnlyBackend({ modelTiers: { capable: tierEntry("fixture-provider/m", "fixture-provider/f || ", "high") } }), /modelTiers\.capable\.fallbackModel/],
    ["whitespace-only fallback", tierOnlyBackend({ modelTiers: { capable: tierEntry("fixture-provider/m", "   ", "high") } }), /modelTiers\.capable\.fallbackModel/],
    ["unknown tier key", tierOnlyBackend({ modelTiers: { premium: tierEntry("fixture-provider/m", "", "high") } }), /unknown modelTiers key premium/],
    ["null tier", tierOnlyBackend({ modelTiers: { capable: null } }), /modelTiers\.capable/],
    ["tier provider mixed with new fields", tierOnlyBackend({ modelTiers: { capable: { provider: "fixture-provider", model: "m", fallbackModel: "", thinking: "high" } } }), /mixes defaultModelTier or tier thinking with legacy/],
    ["root provider mixed with defaultModelTier", tierOnlyBackend({ provider: "fixture-provider" }), /mixes defaultModelTier or tier thinking with legacy/],
    ["root model mixed with defaultModelTier", tierOnlyBackend({ model: "fixture-provider/m" }), /mixes defaultModelTier or tier thinking with legacy/],
    ["root thinking mixed with defaultModelTier", tierOnlyBackend({ thinking: "high" }), /mixes defaultModelTier or tier thinking with legacy/],
  ];
  for (const [label, entry, message] of cases) {
    const result = discoverWithUserRoles([entry]);
    assert.match(result.error ?? "", message, label);
    assert.deepEqual(result.agents, [], `${label}: no agents may launch from a malformed registry`);
  }
});

test("partial tier overlays inherit the base default and replace modelTiers atomically", () => {
  const inherited = discoverWithUserRoles([{ name: "backend-worker", defaultModelTier: "economy" }]);
  assert.equal(inherited.error, undefined);
  const economy = inherited.agents.find((agent) => agent.name === "backend-worker");
  assert.ok(economy);
  assert.equal(economy.defaultModelTier, "economy");
  assert.equal(economy.model, "openai-codex/gpt-6-luna");
  assert.deepEqual(economy.fallbackModel, ["anthropic/claude-haiku-5-5"]);
  assert.equal(economy.thinking, "medium");
  assert.deepEqual(economy.tools, BACKEND_TOOLS);

  const replaced = discoverWithUserRoles([tierOnlyBackend({ modelTiers: { capable: tierEntry("fixture-provider/cap", "", "xhigh") } })]);
  assert.equal(replaced.error, undefined);
  const capable = replaced.agents.find((agent) => agent.name === "backend-worker");
  assert.ok(capable);
  assert.deepEqual(Object.keys(capable.modelTiers ?? {}), ["capable"], "the economy tier is not refilled from the base");
  assert.equal(capable.model, "fixture-provider/cap");
  assert.deepEqual(capable.fallbackModel, []);
  assert.equal(capable.thinking, "xhigh");

  const missingDefault = discoverWithUserRoles([{ name: "scout", defaultModelTier: "capable" }]);
  assert.match(missingDefault.error ?? "", /defaultModelTier "capable" is not configured/);
  assert.deepEqual(missingDefault.agents, []);

  const emptyMap = discoverWithUserRoles([{ name: "backend-worker", defaultModelTier: "capable", modelTiers: {} }]);
  assert.match(emptyMap.error ?? "", /defaultModelTier "capable" is not configured/);
  assert.deepEqual(emptyMap.agents, []);
});

test("tools-only and legacy scalar overlays keep their existing projection", () => {
  const toolsOnly = discoverWithUserRoles([{ name: "backend-worker", tools: "read" }]);
  assert.equal(toolsOnly.error, undefined);
  const tools = toolsOnly.agents.find((agent) => agent.name === "backend-worker");
  assert.ok(tools);
  assert.deepEqual(tools.tools, ["read"]);
  assert.equal(tools.model, "openai-codex/gpt-6-luna");
  assert.equal(tools.defaultModelTier, "economy", "a tools-only overlay inherits the base default tier");

  const legacy = discoverWithUserRoles([{ name: "backend-worker", provider: "fixture-provider", model: "legacy-model", thinking: "low" }]);
  assert.equal(legacy.error, undefined);
  const scalar = legacy.agents.find((agent) => agent.name === "backend-worker");
  assert.ok(scalar);
  assert.equal(scalar.model, "fixture-provider/legacy-model");
  assert.equal(scalar.thinking, "low");
  assert.deepEqual(scalar.fallbackModel, ["anthropic/claude-haiku-5-5"]);
  assert.equal(scalar.defaultModelTier, undefined, "legacy omission projection carries no default tier");
});

// Pre-migration oracle: pins the 20 shipped normal tuples, tools, tier models and raw profile bytes captured before any registry data change.
const baseline = JSON.parse(fs.readFileSync(new URL("./fixtures/tier-only-baseline.json", import.meta.url), "utf8")) as {
  rolesJsonSha256: string;
  profileSha256: Record<string, string>;
  roles: { name: string; normal: { model: string; fallbackModel: string[]; thinking: string; tools: string[] }; tiers: Record<string, { model: string; fallbackModel: string[]; thinking: string }> }[];
};
// Checkout EOL only: CRLF->LF; latin1 round-trip keeps every other byte exact (utf8 decoding would mangle non-UTF-8 bytes).
const fileSha256 = (file: URL) => createHash("sha256").update(Buffer.from(fs.readFileSync(file).toString("latin1").replace(/\r\n/g, "\n"), "latin1")).digest("hex");
// Provenance literals: pre-migration agent/roles.json at e2ddaed (CRLF checkout bytes; git blob adf8b6c9714cb844bcc97fea83580e0ce152c14a).
const ORIGINAL_ROLES_SHA256 = "40381940f244381ae91f24ff7e467dedd88e9c071f2061cd106fc61db70c4219";
// The user-approved preset update supersedes the tier-only-baseline default tuples for exactly the ledger in this independent oracle
// (generated from the approved snapshot, never from the candidate roles.json). tier-only-baseline.json itself stays byte-immutable.
const APPROVED_SNAPSHOT_SHA256 = "5e236e57ad816d2c01806510d511cff10a7542b6502b6937e778e32abfb68ef7";
type ApprovedTier = { model: string; fallbackModel: string[]; thinking: string };
const approved = JSON.parse(fs.readFileSync(new URL("./fixtures/approved-user-presets.json", import.meta.url), "utf8")) as {
  approvedSnapshotSha256: string; changedFromBaseline: string[];
  roles: { name: string; defaultModelTier: "economy" | "capable"; tiers: Record<string, ApprovedTier>; tools: string[] }[];
};
// The one approved tool delta: release-engineer gains native write for named knowledge/release artifacts only (tools otherwise pinned; model tuples never change here).
const APPROVED_TOOL_DELTAS: Record<string, string[]> = { "release-engineer": ["read", "grep", "find", "ls", "bash", "powershell", "edit", "write"] };
// Test-local LF digests of the 20 shipped profiles: git blobs at e2ddaed (== HEAD) with CRLF->LF only. Checkout EOL (core.autocrlf) is not content;
// the fixture's raw profileSha256 pins the historical mixed-EOL checkout (line 5 LF) and stays byte-immutable.
const PROFILE_LF_SHA256: Record<string, string> = {
  "api-specialist": "2a1cd5468e0d4a91d2ca05a7466ca858f9539adcff8a12f72d37e072a9aa3c3d",
  "architecture-specialist": "8106df81a7aabe10afc04a9775ac0c6f431ac321c524696967d1c4180f410be8",
  "backend-worker": "302848b0fb88377940a683f4a20198d699a1fa91cceee54085821954222c69b2",
  "concurrency-specialist": "c0257bb5d0a3c4c554c2c0515cc47b36cc3234b7546f5e0097b1519f040dfcfc",
  "database-specialist": "4cb3a4e9d8fad5c940048289502cc5fd5a9f5ba9433710d68f64cf1d8990091a",
  "database-worker": "ecac5169a646f2809d311b39cde97a877781ad3cec46249f22abea122abee529",
  "debugger": "075f7d677d115d2ac5ee4496d711239a58182d2e0518c5005d2ee06e6c53424c",
  "devops-specialist": "d298ebdf6261996cac69754b4e186875b177bc509281789a03e4d7b45691ff35",
  "frontend-worker": "69959fd558924e6652f850fc47a10d2789b1fc21c7489412d4f5c006399ae839",
  "general-worker": "a6736ddf7d437112a2fc5c6cb1af82bf68187ec335297b33d979802ec8946c22",
  "observability-specialist": "919593d1a33de204261a447f89145c858de7b1c34e562945020b2152f01c9733",
  "oracle": "7a0f4b2f6f352badefe704c85130c45ceb1f7fc169cc3c3ec64365b11bcf643a",
  "performance-specialist": "6b2f515634a9d28eed126d559485e65d951dd7c149a50f6bab171abd9381e982",
  "platform-worker": "622a779038cf1772f623cceda07bce73f041060926ccb866b6fda55e6bcf2337",
  "release-engineer": "ab82c1de6975d585fbfb4bb11e714268b6dbb2c4a493dd2bd765891d86861dda",
  "reviewer": "2fa4f83c09325a8a5ec7d4974a594ad24d393e64cf91662a1fc9dc2c23ee0dcb",
  "scout": "ea3751237a9bc5918f59007e00316f99e7b5c9d46e86485568e1a2fe13eb0f50",
  "security-specialist": "11ba6c3bfcd3e1a24cfb2e029014fa2cfea13b986e150862a2cab30f26c564b0",
  "test-engineer": "4e4b76045f54123b91ae66792f26b708331a37f320050545be67ea9497f7eb46",
  "ui-ux-specialist": "eca72528cfb10065d2a0280014ca9c4b39aa903b6713c24386c8b041ca0d2924",
};
// Approved post-change LF digest of the one profile whose pi.tools/body changed for the write grant; replaces its pre-change PROFILE_LF_SHA256 pin for the byte check.
const APPROVED_PROFILE_DIGESTS: Record<string, string> = { "release-engineer": "c47d394b8257c7c10d6dccdf9bd937200a951d202571505db263650af7bc9869" };
// Approved policy exception (authorized-retirement-policy): release-engineer's body gained the separate Authorized retirement mode and qualified its routine-mode ban.
// P2 (cleanup-routing-followups) added one release-engineer sentence stating that named write paths are instruction-enforced, not hard isolation; only these current pins moved.
// These current-specific pins are mechanically derived from the on-disk profile; the header-removal-baseline fixture and every historical pin above stay byte-immutable.
const POLICY_EXCEPTION_PINS: Record<string, { afterLfSha256: string; bodySha256: string; reinsertedLfSha256: string }> = {
  "release-engineer": { afterLfSha256: "ca8c4a06fdc32ebdc75e3ec5654aa2c867ed4963f831b21bc1c6d364ceed1f98", bodySha256: "6798d969032898afdb30038f653ca93fa1d149276875af19f78800fce605fb6c", reinsertedLfSha256: "16446a855cd9acf98e4f401832fa3bb28a956e683fe847d09059aa6de36609f1" },
};
type RawTier = { model: string; fallbackModel: string; thinking: string };
type RawRole = { name: string; defaultModelTier: "economy" | "capable"; modelTiers: Partial<Record<"economy" | "capable", RawTier>>; tools: string };
const RAW_ROLES = () => JSON.parse(fs.readFileSync(new URL("../../../roles.json", import.meta.url), "utf8")) as RawRole[];
const parseFallback = (text: string) => (text === "" ? [] : text.split("||").map((part) => part.trim()));

// Independent proof that header removal touched only the approved fields: reinserting the recorded removed lines (captured from git HEAD before any edit)
// right after the native tools line must reproduce the historical pinned profile bytes, and the pinned post-change bytes must equal what is on disk.
const lfText = (file: URL) => fs.readFileSync(file).toString("latin1").replace(/\r\n/g, "\n");
const sha256Latin1 = (text: string) => createHash("sha256").update(Buffer.from(text, "latin1")).digest("hex");
test("tier-only baseline pins the 20 shipped roles; header removal removed only the approved model and metadata lines", () => {
  assert.equal(baseline.roles.length, 20);
  assert.deepEqual(baseline.roles.map((role) => role.name).sort(), [...GENERIC_ROLES].sort());
  assert.equal(Object.keys(baseline.profileSha256).length, 20);
  assert.deepEqual(Object.keys(PROFILE_LF_SHA256).sort(), Object.keys(baseline.profileSha256).sort(), "LF pin set matches the fixture's 20 profiles");
  assert.equal(baseline.rolesJsonSha256, ORIGINAL_ROLES_SHA256, "fixture provenance: pinned roles.json is the pre-migration e2ddaed bytes");
  for (const [name, digest] of Object.entries(PROFILE_LF_SHA256)) {
    const entry = headerRemoval.roles.find((item) => item.name === name)!;
    assert.equal(entry.headLfSha256, APPROVED_PROFILE_DIGESTS[name] ?? digest, `${name}: historical pin and header-removal baseline agree`);
    const text = lfText(new URL(`../../../agents/${name}.md`, import.meta.url));
    assert.equal(sha256Latin1(text), POLICY_EXCEPTION_PINS[name]?.afterLfSha256 ?? entry.expectedAfterLfSha256, `${name}: post-change profile bytes`);
    assert.equal(sha256Latin1(text), POLICY_EXCEPTION_PINS[name]?.afterLfSha256 ?? entry.expectedAfterLfSha256, `${name}: post-change profile bytes`);
    assert.equal(entry.removed.length, 6, `${name}: exactly model + metadata block removed`);
    assert.deepEqual(entry.removed.map((line) => line.split(":")[0].trim()), ["model", "metadata", "pi.model", "pi.fallbackModel", "pi.thinking", "pi.tools"], `${name}: removed field names`);
    const lines = text.split("\n");
    const at = lines.indexOf(entry.nativeToolsLine);
    assert.ok(at > 0, `${name}: native tools line preserved`);
    assert.equal(lines[at - 1], entry.descriptionLine, `${name}: description line preserved`);
    assert.equal(sha256Latin1([...lines.slice(0, at + 1), ...entry.removed, ...lines.slice(at + 1)].join("\n")), POLICY_EXCEPTION_PINS[name]?.reinsertedLfSha256 ?? entry.headLfSha256, `${name}: reinserting the removed lines reproduces the historical bytes`);
    assert.equal(sha256Latin1([...lines.slice(0, at + 1), ...entry.removed, ...lines.slice(at + 1)].join("\n")), POLICY_EXCEPTION_PINS[name]?.reinsertedLfSha256 ?? entry.headLfSha256, `${name}: reinserting the removed lines reproduces the historical bytes`);
    const body = text.slice(text.indexOf("\n---", 4) + 5);
    assert.equal(sha256Latin1(body), POLICY_EXCEPTION_PINS[name]?.bodySha256 ?? entry.bodySha256, `${name}: body unchanged`);
    assert.equal(sha256Latin1(body), POLICY_EXCEPTION_PINS[name]?.bodySha256 ?? entry.bodySha256, `${name}: body unchanged`);
  }
});

test("profile digest ignores CRLF/LF checkout EOL but pins every content byte (header, body, tools and trailing-space mutations fail)", () => {
  const dir = fs.mkdtempSync(`${os.tmpdir()}/pi-profile-eol-`);
  try {
    const base = fs.readFileSync(new URL("../../../agents/general-worker.md", import.meta.url)).toString("latin1").replace(/\r\n/g, "\n");
    const expected = headerRemoval.roles.find((entry) => entry.name === "general-worker")!.expectedAfterLfSha256;
    const lines = base.split("\n");
    const variants: Record<string, string> = {
      lf: base,
      crlf: base.replace(/\n/g, "\r\n"),
      historicalMixed: lines.map((line, i) => (i === lines.length - 1 ? line : line + (i === 4 ? "\n" : "\r\n"))).join(""),
    };
    for (const [label, text] of Object.entries(variants)) {
      const file = `${dir}/${label}.md`;
      fs.writeFileSync(file, Buffer.from(text, "latin1"));
      assert.equal(fileSha256(pathToFileURL(file)), expected, `${label} EOL variant must match the pinned LF digest`);
    }
    const flipped: Record<string, number> = { header: base.indexOf("description:"), tools: base.indexOf("tools: ") + 7, body: base.trimEnd().length - 1 };
    for (const [label, at] of Object.entries(flipped)) {
      const bytes = Buffer.from(base, "latin1");
      bytes[at] ^= 0x01;
      const file = `${dir}/mutant-${label}.md`;
      fs.writeFileSync(file, bytes);
      assert.notEqual(fileSha256(pathToFileURL(file)), expected, `${label} one-byte mutation must fail the pin`);
    }
    const trailing = `${dir}/mutant-trailing-space.md`;
    fs.writeFileSync(trailing, Buffer.from(base.replace("\n", " \n"), "latin1"));
    assert.notEqual(fileSha256(pathToFileURL(trailing)), expected, "trailing-space mutation must fail: no whitespace trim");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("package discovery projects the approved presets: default tuple, tools and every tier for all 20 roles", () => {
  const result = discoverWithUserRoles([]);
  assert.equal(result.error, undefined);
  assert.equal(approved.roles.length, 20);
  for (const expected of approved.roles) {
    const agent = result.agents.find((item) => item.name === expected.name);
    assert.ok(agent, expected.name);
    const def = expected.tiers[expected.defaultModelTier];
    assert.equal(agent.defaultModelTier, expected.defaultModelTier, `${expected.name}: default tier`);
    assert.equal(agent.model, def.model, `${expected.name}: model`);
    assert.deepEqual(agent.fallbackModel, def.fallbackModel, `${expected.name}: fallbackModel`);
    assert.equal(agent.thinking, def.thinking, `${expected.name}: thinking`);
    assert.deepEqual(agent.tools, expected.tools, `${expected.name}: tools`);
    assert.deepEqual(Object.keys(agent.modelTiers ?? {}).sort(), Object.keys(expected.tiers).sort(), `${expected.name}: tier set`);
    for (const [tier, pinned] of Object.entries(expected.tiers)) {
      const configured = agent.modelTiers?.[tier as "economy" | "capable"] as { model: string; fallbackModel: string[]; thinking?: string } | undefined;
      assert.ok(configured, `${expected.name}.${tier}`);
      assert.equal(configured.model, pinned.model, `${expected.name}.${tier}: model`);
      assert.deepEqual(configured.fallbackModel, pinned.fallbackModel, `${expected.name}.${tier}: fallbackModel`);
      assert.equal(configured.thinking ?? agent.thinking, pinned.thinking, `${expected.name}.${tier}: effort`);
    }
  }
});

test("shipped roles.json is tier-only: exact entry keys, no root provider/model/fallbackModel/thinking, configured default tier", () => {
  const raw = fs.readFileSync(new URL("../../../roles.json", import.meta.url), "utf8");
  const roles = JSON.parse(raw) as Record<string, unknown>[];
  assert.equal(roles.length, 20);
  for (const entry of roles) {
    const name = String(entry.name);
    assert.deepEqual(Object.keys(entry).sort(), ["defaultModelTier", "modelTiers", "name", "tools"], `${name}: entry keys`);
    assert.ok(entry.defaultModelTier === "economy" || entry.defaultModelTier === "capable", `${name}: defaultModelTier`);
    const tiers = entry.modelTiers as Record<string, Record<string, unknown>>;
    assert.ok(Object.keys(tiers).includes(entry.defaultModelTier as string), `${name}: default tier is configured`);
    for (const [tier, cfg] of Object.entries(tiers)) {
      assert.ok(tier === "economy" || tier === "capable", `${name}: tier name ${tier}`);
      assert.deepEqual(Object.keys(cfg).sort(), ["fallbackModel", "model", "thinking"], `${name}.${tier}: exact tier keys`);
      assert.match(String(cfg.model), /^[^/\s]+\/\S+$/, `${name}.${tier}.model is fully qualified`);
      assert.ok(typeof cfg.fallbackModel === "string", `${name}.${tier}.fallbackModel is a string`);
      for (const part of parseFallback(cfg.fallbackModel as string)) assert.match(part, /^[^/\s]+\/\S+$/, `${name}.${tier}.fallbackModel part qualified`);
      assert.ok(["off", "minimal", "low", "medium", "high", "xhigh"].includes(cfg.thinking as string), `${name}.${tier}.thinking enum`);
    }
  }
});

test("raw roles.json equals the approved preset oracle for every role: default tier, tiers, fallback order, thinking and tools", () => {
  const raw = RAW_ROLES();
  assert.equal(raw.length, approved.roles.length);
  for (const expected of approved.roles) {
    const role = raw.find((item) => item.name === expected.name);
    assert.ok(role, expected.name);
    assert.equal(role.defaultModelTier, expected.defaultModelTier, `${expected.name}: default tier`);
    assert.deepEqual(role.tools.split(",").map((tool) => tool.trim()), expected.tools, `${expected.name}: tools`);
    assert.deepEqual(Object.keys(role.modelTiers).sort(), Object.keys(expected.tiers).sort(), `${expected.name}: tier set`);
    for (const [tier, pinned] of Object.entries(expected.tiers)) {
      const cfg = role.modelTiers[tier as "economy" | "capable"];
      assert.ok(cfg, `${expected.name}.${tier}`);
      assert.equal(cfg.model, pinned.model, `${expected.name}.${tier}: model`);
      assert.deepEqual(parseFallback(cfg.fallbackModel), pinned.fallbackModel, `${expected.name}.${tier}: fallback order`);
      assert.equal(cfg.thinking, pinned.thinking, `${expected.name}.${tier}: thinking`);
    }
  }
});

test("approved preset update differs from the immutable baseline only by the recorded ledger; permissions and the role set are unchanged", () => {
  assert.equal(approved.approvedSnapshotSha256, APPROVED_SNAPSHOT_SHA256, "oracle provenance: the user-approved snapshot bytes");
  assert.deepEqual(approved.roles.map((role) => role.name).sort(), baseline.roles.map((role) => role.name).sort(), "role set unchanged");
  const changed: string[] = [];
  for (const role of approved.roles) {
    const golden = baseline.roles.find((item) => item.name === role.name)!;
    // Tool permissions: identical to the baseline except the separately approved release-engineer write grant.
    assert.deepEqual(role.tools, APPROVED_TOOL_DELTAS[role.name] ?? golden.normal.tools, `${role.name}: tools unchanged`);
    assert.ok(role.tiers[role.defaultModelTier], `${role.name}: default tier configured`);
    const same = (a: ApprovedTier | undefined, b: ApprovedTier) => !!a && a.model === b.model && a.thinking === b.thinking && JSON.stringify(a.fallbackModel) === JSON.stringify(b.fallbackModel);
    if (!same(golden.normal, role.tiers[role.defaultModelTier])) changed.push(`${role.name}.default`);
    for (const tier of Object.keys(golden.tiers)) assert.ok(role.tiers[tier], `${role.name}.${tier}: no baseline tier removed`);
    for (const [tier, cfg] of Object.entries(role.tiers)) if (!same(golden.tiers[tier], cfg)) changed.push(`${role.name}.${tier}`);
  }
  assert.deepEqual(changed, approved.changedFromBaseline, "the approved delta ledger is exact");
  // User-chosen architecture-specialist default (economy) and Oracle's capable-only configuration (no invented economy tier).
  assert.equal(approved.roles.find((role) => role.name === "architecture-specialist")!.defaultModelTier, "economy");
  assert.deepEqual(Object.keys(approved.roles.find((role) => role.name === "oracle")!.tiers), ["capable"]);
});

test("write is the one approved tool delta: only release-engineer gains it, pinned to its baseline tools plus write", () => {
  const pinned = baseline.roles.find((role) => role.name === "release-engineer");
  assert.ok(pinned);
  assert.deepEqual(APPROVED_TOOL_DELTAS["release-engineer"], [...pinned.normal.tools, "write"]);
  assert.equal(Object.keys(APPROVED_TOOL_DELTAS).length, 1, "no other role has an approved tool delta");
  for (const role of RAW_ROLES()) {
    if (role.name !== "release-engineer") assert.doesNotMatch(role.tools, /(^|,\s*)write(\s*,|$)/, `${role.name}: no write grant`);
  }
});

test("shipped tier census matches the approved data shape (informational; not a runtime eligibility gate)", () => {
  const roles = RAW_ROLES();
  assert.equal(roles.length, 20);
  const defaults = roles.map((role) => role.defaultModelTier);
  assert.equal(defaults.filter((tier) => tier === "economy").length, 19);
  assert.equal(defaults.filter((tier) => tier === "capable").length, 1, "only Oracle defaults to capable; it has no economy tier");
  const entries = roles.flatMap((role) => Object.keys(role.modelTiers));
  assert.equal(entries.length, 38);
  assert.equal(entries.filter((tier) => tier === "economy").length, 19);
  assert.equal(entries.filter((tier) => tier === "capable").length, 19);
});
