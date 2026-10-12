// Role registry and lifecycle contracts (RED first): the packaged profile registers exactly the 19 generic roles, every definition agrees
// with the registry, and lifecycle ownership stays explicit. Project-local domain roles are not part of this generic profile.
import { test } from "bun:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import { parseFrontmatter } from "../../../install/releases/1.1.0/node_modules/@earendil-works/pi-coding-agent/dist/index.js";

const integrations = JSON.parse(fs.readFileSync(new URL("../integrations.json", import.meta.url), "utf8"));
const roles = JSON.parse(fs.readFileSync(new URL("../../../roles.json", import.meta.url), "utf8"));

const GENERIC_ROLES = [
  "api-specialist", "architecture-specialist", "backend-worker", "concurrency-specialist", "debugger", "devops-specialist",
  "frontend-worker", "general-worker", "observability-specialist", "oracle", "performance-specialist", "release-engineer",
  "reviewer", "scout", "security-specialist", "sqlite-specialist", "test-engineer", "ui-ux-specialist", "platform-worker",
];

function frontmatter(name: string) {
  const path = new URL(`../../../agents/${name}.md`, import.meta.url);
  return parseDefinition(name, fs.readFileSync(path, "utf8"));
}

// Values come from the public parseFrontmatter that agents.ts uses, so YAML quoting is decoded: fallbackModel: "" and a bare key both mean the empty string.
function parseDefinition(name: string, text: string) {
  assert.ok(/^---\r?\n[\s\S]*?\r?\n---/.test(text), `${name}: frontmatter missing`);
  const { frontmatter: fm } = parseFrontmatter<Record<string, unknown>>(text);
  const field = (key: string) => (fm[key] === null ? "" : (fm[key] as string | undefined));
  return { text, name: field("name"), tools: field("tools") ?? "", model: field("model"), fallbackModel: field("fallbackModel"), thinking: field("thinking") };
}

test("registry registers exactly the 19 generic roles, unique, without statusline-setup", () => {
  assert.equal(roles.length, 19);
  assert.equal(new Set(roles.map((r: { name: string }) => r.name)).size, 19);
  assert.deepEqual(roles.map((r: { name: string }) => r.name).sort(), [...GENERIC_ROLES].sort());
  assert.ok(!roles.some((r: { name: string }) => r.name === "statusline-setup"));
  assert.ok(!fs.existsSync(new URL("../../../agents/statusline-setup.md", import.meta.url)), "statusline-setup definition removed");
  assert.deepEqual(fs.readdirSync(new URL("../../../agents/", import.meta.url)).filter((f) => f.endsWith(".md")).sort(), GENERIC_ROLES.map((n) => `${n}.md`).sort());
});

test("every generic role receives standard code navigation integrations", () => {
  assert.equal(integrations.roles.length, 19);
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

test("implementation workers are backend, frontend, general and platform with the inherited rust defaults", () => {
  assert.equal(roles.find((r: { name: string }) => r.name === "rust-worker"), undefined, "rust-worker retired from registry");
  assert.equal(fs.existsSync(new URL("../../../agents/rust-worker.md", import.meta.url)), false, "rust-worker definition retired");
  const defaults = { provider: "anthropic", model: "claude-haiku-5-5", fallbackModel: "openai-codex/gpt-6-luna || github-copilot/gpt-6-luna", thinking: "low", tools: "read, grep, find, ls, bash, powershell, edit" };
  for (const name of ["backend-worker", "frontend-worker", "general-worker", "platform-worker"]) {
    const role = roles.find((r: { name: string }) => r.name === name);
    assert.ok(role, name);
    assert.deepEqual({ provider: role.provider, model: role.model, fallbackModel: role.fallbackModel, thinking: role.thinking, tools: role.tools }, defaults, name);
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
  assert.match(route, /SQLite.*sqlite-specialist/i);
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
