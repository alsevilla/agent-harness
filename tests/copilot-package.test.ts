import { test, expect } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { hostModules } from "../agent/extensions/subagent/tests/host-modules.ts";

const root = join(import.meta.dir, "..");

test("Copilot plugin manifest has supported metadata and contained shared paths", () => {
  const manifest = JSON.parse(readFileSync(join(root, ".github", "plugin", "plugin.json"), "utf8"));
  expect(manifest.name).toBe("agent-harness");
  expect(manifest.version).toBe("1.6.0");
  expect(manifest.agents).toBe("./agent/agents");
  expect(manifest.skills).toBe("./agent/skills");
  for (const [path, sentinel] of [[manifest.agents, "general-worker.md"], [manifest.skills, "engineering-harness/SKILL.md"]]) {
    const resolved = resolve(root, path);
    expect(resolved.startsWith(`${root}${sep}`)).toBe(true);
    expect(readFileSync(join(resolved, sentinel), "utf8")).toBeTruthy();
  }
  expect(() => readFileSync(join(root, ".copilot", "plugin.json"), "utf8")).toThrow();
  if (readdirSync(root).includes(".copilot")) expect(readdirSync(join(root, ".copilot"))).not.toContain("agents");
  expect(() => readFileSync(join(root, "plugin.json"))).toThrow();
  expect(readFileSync(join(root, "agent", "roles.json"), "utf8")).toBeTruthy();
});

test("Copilot marketplace lists this plugin and its platform-specific source", () => {
  const marketplace = JSON.parse(
    readFileSync(join(root, ".github", "plugin", "marketplace.json"), "utf8"),
  );
  expect(marketplace.name).toBe("alsevilla");
  expect(marketplace.plugins).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ name: "agent-harness", source: "./" }),
    ]),
  );
  expect(readFileSync(join(root, "package.json"), "utf8")).toContain('"name": "@alsevilla/pi-engineering-harness"');
});

test("backend-worker Copilot metadata matches its declared primary and preserves Pi runtime settings", async () => {
  const text = readFileSync(join(nativeAgents, "backend-worker.md"), "utf8");
  const { metadata } = frontmatter(text);
  const sdkMetadata = await sdkFrontmatter(text);
  expect(metadata.name).toBe("backend-worker");
  expect(metadata.description).toMatch(/^Implements authorized backend services/);
  expect(metadata.model).toBe("claude-sonnet-5.5");
  expect(metadata.fallbackModel).toBeUndefined();
  expect(metadata.thinking).toBeUndefined();
  expect(metadata.metadata).toEqual({
    "pi.model": "anthropic/claude-sonnet-5-5",
    "pi.fallbackModel": "openai-codex/gpt-6.1-sol",
    "pi.thinking": "medium",
    "pi.tools": "read, grep, find, ls, bash, powershell, edit",
  });
  expect(sdkMetadata.metadata).toEqual(metadata.metadata);
  expect(metadata.tools).toBe("read, search, execute, edit");
  expect(metadata.pi).toBeUndefined();
});

test("SDK declaration check without NATIVE_PROBE_HOST_MODULES reads the latest complete installed host", async () => {
  const previous = process.env.NATIVE_PROBE_HOST_MODULES;
  delete process.env.NATIVE_PROBE_HOST_MODULES;
  try {
    const text = readFileSync(join(nativeAgents, "backend-worker.md"), "utf8");
    const sdk = await sdkFrontmatter(text);
    expect(sdk.name).toBe("backend-worker");
    expect(sdk.metadata).toEqual(frontmatter(text).metadata.metadata);
  } finally {
    if (previous === undefined) delete process.env.NATIVE_PROBE_HOST_MODULES;
    else process.env.NATIVE_PROBE_HOST_MODULES = previous;
  }
});

test("Copilot metadata reuses shared Pi component sources without duplicate adapters", () => {
  expect(() => readdirSync(join(root, ".copilot", "agents"))).toThrow();
  expect(() => readdirSync(join(root, ".copilot", "skills"))).toThrow();
  expect(readFileSync(join(root, "agent", "agents", "general-worker.md"), "utf8")).toBeTruthy();
  expect(readFileSync(join(root, "agent", "skills", "engineering-harness", "SKILL.md"), "utf8")).toBeTruthy();
});

const nativeAgents = join(root, "agent", "agents");
const frontmatter = (text: string) => {
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/);
  if (!match) throw new Error("missing YAML frontmatter");
  return { metadata: Bun.YAML.parse(match[1]) as Record<string, unknown>, body: text.slice(match[0].length) };
};
// NATIVE_PROBE_HOST_MODULES pins an explicit host tree; unset uses the latest complete installed release (hostModules keeps its version-compat failure).
const sdkFrontmatter = async (text: string) => {
  const modules = hostModules(["@earendil-works/pi-coding-agent"]);
  const { parseFrontmatter } = await import(pathToFileURL(join(modules, "@earendil-works", "pi-coding-agent", "dist", "index.js")).href);
  return parseFrontmatter(text).frontmatter as Record<string, unknown>;
};
const copilotModels: Record<string, string> = { "anthropic/claude-haiku-5-5": "claude-haiku-5.5", "anthropic/claude-sonnet-5-5": "claude-sonnet-5.5", "anthropic/claude-opus-5-5": "claude-opus-5.5", "openai-codex/gpt-6-luna": "gpt-6-luna", "openai-codex/gpt-6.1-sol": "gpt-6.1-sol" };
const agentNames = () => JSON.parse(readFileSync(join(root, "agent", "roles.json"), "utf8")).map((r: { name: string }) => r.name);

test("all profiles expose native Copilot headers and preserve Pi runtime settings", async () => {
  const aliases: Record<string, string> = { read: "read", grep: "search", find: "search", ls: "search", bash: "execute", powershell: "execute", edit: "edit", write: "edit" };
  const roles = JSON.parse(readFileSync(join(root, "agent", "roles.json"), "utf8")) as Array<{ name: string; defaultModelTier: string; modelTiers: Record<string, { model: string; fallbackModel: string; thinking: string }>; tools: string }>;
  for (const role of roles) {
    const tier = role.modelTiers[role.defaultModelTier];
    const text = readFileSync(join(nativeAgents, `${role.name}.md`), "utf8");
    const { metadata } = frontmatter(text);
    const sdk = await sdkFrontmatter(text);
    const expected = { "pi.model": tier.model, "pi.fallbackModel": tier.fallbackModel, "pi.thinking": tier.thinking, "pi.tools": role.tools };
    expect(metadata.model).toBe(copilotModels[tier.model]);
    expect(metadata.fallbackModel).toBeUndefined();
    expect(metadata.thinking).toBeUndefined();
    expect(metadata.pi).toBeUndefined();
    expect(metadata.metadata).toEqual(expected);
    expect(sdk.metadata).toEqual(expected);
    const expectedTools = [...new Set(role.tools.split(",").map((tool) => aliases[tool.trim()]).filter(Boolean))].join(", ");
    expect(metadata.tools).toBe(expectedTools);
  }
});

test("native profiles have valid metadata, exact roles, and documented tools", () => {
  const names = agentNames();
  expect(names).toHaveLength(20);
  expect(new Set(names).size).toBe(20);
  const files = readdirSync(nativeAgents).filter((f) => f.endsWith(".md")).map((f) => f.replace(/\.md$/, ""));
  expect(files.sort()).toEqual([...names].sort());
  expect(readdirSync(nativeAgents)).toEqual(expect.arrayContaining(names.map((name) => `${name}.md`)));
  for (const name of names) {
    const { metadata } = frontmatter(readFileSync(join(nativeAgents, `${name}.md`), "utf8"));
    expect(metadata.name).toBe(name);
    expect(typeof metadata.description).toBe("string");
    expect((metadata.description as string).trim().length).toBeGreaterThan(0);
    const tools = metadata.tools;
    expect(typeof tools).toBe("string");
  }
});

test("Copilot profiles and common skill are standalone, scoped native contracts", () => {
  const names = agentNames();
  for (const name of names) {
    const { body } = frontmatter(readFileSync(join(nativeAgents, `${name}.md`), "utf8"));
    expect(body).not.toMatch(/\.copilot\/skills\/engineering-harness\/SKILL\.md/);
    expect(body).toMatch(/assigned|authorized|scope/i);
    expect(body).toMatch(/candidate/i);
    expect(body).toMatch(/evidence|report/i);
    expect(body).toMatch(/helper/i);
    if (["reviewer", "test-engineer", "debugger", "scout", "database-specialist", "security-specialist"].includes(name)) {
      expect(body).toMatch(/read.only|do not modify|without modifying/i);
    }
    expect(body.length).toBeGreaterThan(0);
  }
  const skillText = readFileSync(join(root, "agent", "skills", "engineering-harness", "SKILL.md"), "utf8");
  const { metadata, body } = frontmatter(skillText);
  expect(metadata.name).toBe("engineering-harness");
  expect(metadata.description).toBeTruthy();
  expect(body.length).toBeGreaterThan(0);
});
