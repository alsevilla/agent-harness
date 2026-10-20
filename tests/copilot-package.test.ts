import { test, expect } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { hostModules } from "../agent/extensions/subagent/tests/host-modules.ts";

const root = join(import.meta.dir, "..");

test("Copilot plugin manifest has supported metadata and contained shared paths", () => {
  const manifest = JSON.parse(readFileSync(join(root, ".github", "plugin", "plugin.json"), "utf8"));
  expect(manifest.name).toBe("agent-harness");
  expect(manifest.version).toBe("1.9.1");
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

test("Pi package, Copilot manifest and README Source release name the same current release", () => {
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const manifest = JSON.parse(readFileSync(join(root, ".github", "plugin", "plugin.json"), "utf8"));
  const row = readFileSync(join(root, "README.md"), "utf8").match(/^\| Source release \| v(\d+\.\d+\.\d+) /m);
  expect(row?.[1]).toBe("1.9.1");
  expect(pkg.version).toBe(row?.[1]);
  expect(manifest.version).toBe(row?.[1]);
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

test("README Copilot install commands use the marketplace and plugin names from the manifests", () => {
  const manifest = JSON.parse(readFileSync(join(root, ".github", "plugin", "plugin.json"), "utf8"));
  const marketplace = JSON.parse(readFileSync(join(root, ".github", "plugin", "marketplace.json"), "utf8"));
  const readme = readFileSync(join(root, "README.md"), "utf8");
  expect(marketplace.plugins).toEqual(expect.arrayContaining([expect.objectContaining({ name: manifest.name })]));
  expect(readme).toContain(`copilot plugin marketplace add ${manifest.repository.replace("https://github.com/", "")}`);
  expect(readme).toContain(`copilot plugin install ${manifest.name}@${marketplace.name}`);
  expect(readme).toContain("copilot --plugin-dir ");
});

// Native Copilot headers carry identity and native tools only: no model (Copilot inherits the outer/session model) and no Pi metadata (roles.json is the single Pi source).
test("backend-worker Copilot header has identity and native tools only; Pi settings live in roles.json", async () => {
  const text = readFileSync(join(nativeAgents, "backend-worker.md"), "utf8");
  const { metadata } = frontmatter(text);
  const sdkMetadata = await sdkFrontmatter(text);
  expect(metadata.name).toBe("backend-worker");
  expect(metadata.description).toMatch(/^Implements authorized backend services/);
  expect(Object.keys(metadata)).toEqual(["name", "description", "tools"]);
  expect(Object.keys(sdkMetadata)).toEqual(["name", "description", "tools"]);
  expect(metadata.tools).toBe("read, search, execute, edit");
});

test("SDK declaration check without NATIVE_PROBE_HOST_MODULES reads the latest complete installed host", async () => {
  const previous = process.env.NATIVE_PROBE_HOST_MODULES;
  delete process.env.NATIVE_PROBE_HOST_MODULES;
  try {
    const text = readFileSync(join(nativeAgents, "backend-worker.md"), "utf8");
    const sdk = await sdkFrontmatter(text);
    expect(sdk.name).toBe("backend-worker");
    expect(Object.keys(sdk)).toEqual(["name", "description", "tools"]);
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
const agentNames = () => JSON.parse(readFileSync(join(root, "agent", "roles.json"), "utf8")).map((r: { name: string }) => r.name);

test("all profiles expose native Copilot headers with unchanged native tools and no model or Pi metadata", async () => {
  const aliases: Record<string, string> = { read: "read", grep: "search", find: "search", ls: "search", bash: "execute", powershell: "execute", edit: "edit", write: "edit" };
  const roles = JSON.parse(readFileSync(join(root, "agent", "roles.json"), "utf8")) as Array<{ name: string; defaultModelTier: string; modelTiers: Record<string, { model: string; fallbackModel: string; thinking: string }>; tools: string }>;
  for (const role of roles) {
    const tier = role.modelTiers[role.defaultModelTier];
    const text = readFileSync(join(nativeAgents, `${role.name}.md`), "utf8");
    const { metadata } = frontmatter(text);
    const sdk = await sdkFrontmatter(text);
    expect(tier.model).toBeTruthy();
    for (const header of [metadata, sdk]) {
      expect(Object.keys(header)).toEqual(["name", "description", "tools"]);
      for (const key of ["model", "fallbackModel", "thinking", "metadata", "pi"]) expect(header[key]).toBeUndefined();
    }
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
