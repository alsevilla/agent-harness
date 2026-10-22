import { test, expect } from "bun:test";
import { existsSync, readFileSync, readdirSync, mkdtempSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

// Shared module references are canonical repo-relative `agent/skills/...`: never a user's home (~/.pi) and never a `<skills>` placeholder.
const root = resolve(import.meta.dir, "..");
const read = (...p: string[]) => readFileSync(join(root, ...p), "utf8");
const tracked = spawnSync("git", ["ls-files", "-z"], { cwd: root, encoding: "utf8" }).stdout.split("\0").filter(Boolean);
// Retired generator (matches pinned baseline text) and test sources (which name the forbidden strings as assertions) are not shared references.
const SKIP = (f: string) => /(^|\/)tests\//.test(f) || /\.test\.ts$/.test(f) || f === "scripts/build-pi-package.mjs" || !/\.(md|mjs|ts|json|py)$/.test(f);
const BAD = /~\/\.pi\/agent\/skills|<skills>/;

test("no tracked shared reference names ~/.pi/agent/skills or a <skills> placeholder (README keeps only the Pi discovery location)", () => {
  const hits: string[] = [];
  for (const f of tracked.filter((f) => !SKIP(f) && existsSync(join(root, f)))) {
    read(...f.split("/")).split(/\r?\n/).forEach((l, i) => {
      if (!BAD.test(l)) return;
      if (f === "README.md" && l.startsWith("- Pi discovers `<agent-dir>/skills/`")) return;
      hits.push(`${f}:${i + 1}`);
    });
  }
  expect(hits).toEqual([]);
});

test("user's exact example: ui-ux-specialist names agent/skills/engineering-harness/references/roles/ui-ux-specialist.md, which exists", () => {
  const rel = "agent/skills/engineering-harness/references/roles/ui-ux-specialist.md";
  expect(read("agent", "agents", "ui-ux-specialist.md")).toContain(`\`${rel}\``);
  expect(existsSync(join(root, rel))).toBe(true);
});

test("every agent/skills/... module path in profiles and prompts resolves to a tracked file", () => {
  const missing: string[] = []; let seen = 0;
  for (const dir of ["agent/agents", "agent/prompts"]) for (const f of readdirSync(join(root, dir)).filter((f) => f.endsWith(".md"))) {
    for (const m of read(...dir.split("/"), f).matchAll(/agent\/skills\/[A-Za-z0-9_\-./]+?\.(?:md|py|json)/g)) { seen++; if (!existsSync(join(root, m[0]))) missing.push(`${dir}/${f}: ${m[0]}`); }
  }
  expect(seen).toBeGreaterThan(30);
  expect(missing).toEqual([]);
});

test("profiles that read modules state one portable root rule: agent/skills/... under the verified installed root, never cwd, BLOCKED when absent", () => {
  for (const f of readdirSync(join(root, "agent", "agents")).filter((f) => f.endsWith(".md"))) {
    const lines = read("agent", "agents", f).split(/\r?\n/);
    const uses = lines.filter((l) => l.includes("agent/skills/"));
    const rule = lines.filter((l) => l.startsWith("Module paths written `agent/skills/...`"));
    if (!uses.length) { expect(rule).toHaveLength(0); continue; }
    expect(rule).toHaveLength(1);
    expect(rule[0]).toMatch(/installed shared-source root/);
    expect(rule[0]).toMatch(/subagentStart.*parent handoff.*advertised installed skill/);
    expect(rule[0]).toMatch(/never the project cwd/);
    expect(rule[0]).toMatch(/BLOCKED/);
  }
});

test("subagentStart context from an unrelated cwd gives the installed root plus the agent/skills mapping, without ~/.pi, <skills> or reflected input", () => {
  const cwd = mkdtempSync(join(tmpdir(), "portable ctx "));
  try {
    const r = spawnSync("node", [join(root, ".github", "plugin", "agent-context.mjs")], { cwd, encoding: "utf8", input: JSON.stringify({ sessionId: "s", timestamp: 1, cwd, agentName: "EVIL-NAME", transcriptPath: "t" }) });
    expect(r.status).toBe(0);
    const c: string = JSON.parse(r.stdout).additionalContext;
    expect(c).toContain(root);
    expect(c).toContain("agent/skills/");
    expect(c).toMatch(/never the project cwd/);
    expect(c).not.toMatch(/~\/\.pi|<skills>|EVIL-NAME/);
    expect(c).not.toContain(cwd);
    expect(c).toMatch(/BLOCKED/);
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});
