import test from "node:test";
import { expect } from "./support/expect.ts";
import { existsSync, readFileSync, mkdirSync, mkdtempSync, rmSync, cpSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

const root = resolve(import.meta.dirname, "..");
const manifestPath = join(root, ".github", "plugin", "plugin.json");

test("manifest hook target exists and registers a sessionStart command", () => {
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  expect(typeof manifest.hooks).toBe("string");
  const hooksPath = resolve(root, manifest.hooks);
  expect(existsSync(hooksPath)).toBe(true);
  const hooks = JSON.parse(readFileSync(hooksPath, "utf8"));
  expect(hooks.hooks.sessionStart).toEqual(expect.arrayContaining([expect.objectContaining({ type: "command" })]));
});

test("session-start reader exists", () => {
  expect(existsSync(join(root, ".github", "plugin", "session-start.mjs"))).toBe(true);
});

test("reader emits shared installed policy context from an unrelated cwd", () => {
  const reader = join(root, ".github", "plugin", "session-start.mjs");
  const unrelatedCwd = mkdtempSync(join(tmpdir(), "copilot-bootstrap-cwd-"));
  const policyRoot = join(root, "agent");
  try {
    const result = spawnSync("node", [reader], {
      cwd: unrelatedCwd,
      input: JSON.stringify({ sessionId: "bootstrap-test", timestamp: 1700000000000, cwd: unrelatedCwd, source: "startup" }),
      encoding: "utf8",
      env: { ...process.env, HOME: unrelatedCwd, USERPROFILE: unrelatedCwd },
    });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    const lines = result.stdout.trim().split(/\r?\n/);
    expect(lines).toHaveLength(1);
    const response = JSON.parse(lines[0]);
    const context = response.additionalContext;
    expect(typeof context).toBe("string");
    expect(context).toContain(join(policyRoot, "AGENTS.md"));
    expect(context).toContain(join(policyRoot, "skills", "SKILLS.md"));
    expect(context).toContain(readFileSync(join(policyRoot, "AGENTS.md"), "utf8").trim());
    expect(context).toContain(readFileSync(join(policyRoot, "skills", "SKILLS.md"), "utf8").trim());
    expect(context).toContain(root);
  } finally {
    rmSync(unrelatedCwd, { recursive: true, force: true });
  }
});

test("configured PowerShell hook uses its installed root from an unrelated cwd", () => {
  const hooks = JSON.parse(readFileSync(join(root, ".github", "plugin", "hooks.json"), "utf8"));
  const scratch = mkdtempSync(join(tmpdir(), "copilot-bootstrap-hook-"));
  const installedRoot = join(scratch, "plugin ü with spaces");
  const unrelatedCwd = join(scratch, "unrelated cwd");
  mkdirSync(unrelatedCwd);
  try {
    cpSync(join(root, ".github", "plugin"), join(installedRoot, ".github", "plugin"), { recursive: true });
    cpSync(join(root, "agent"), join(installedRoot, "agent"), { recursive: true });
    const command = hooks.hooks.sessionStart[0].powershell;
    const result = spawnSync("pwsh", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command], {
      cwd: unrelatedCwd,
      env: { ...process.env, COPILOT_PLUGIN_ROOT: installedRoot },
      input: JSON.stringify({ sessionId: "bootstrap-test", timestamp: 1700000000000, cwd: unrelatedCwd, source: "startup" }),
      encoding: "utf8",
      timeout: 15000,
    });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    const response = JSON.parse(result.stdout);
    expect(response.additionalContext).toContain(installedRoot);
    expect(response.additionalContext).toContain(join(installedRoot, "agent", "AGENTS.md"));
    expect(result.stderr).toBe("");
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("configured Bash hook uses its installed root from an unrelated cwd with spaces and Unicode", () => {
  // Runs the hooks.json bash command string as written (PLUGIN_ROOT, not the PowerShell COPILOT_PLUGIN_ROOT variable).
  const hooks = JSON.parse(readFileSync(join(root, ".github", "plugin", "hooks.json"), "utf8"));
  const command = hooks.hooks.sessionStart[0].bash;
  const scratch = mkdtempSync(join(tmpdir(), "copilot-bootstrap-bash-"));
  const installedRoot = join(scratch, "plugin ü with spaces");
  const unrelatedCwd = join(scratch, "unrelated cwd");
  mkdirSync(unrelatedCwd);
  try {
    cpSync(join(root, ".github", "plugin"), join(installedRoot, ".github", "plugin"), { recursive: true });
    cpSync(join(root, "agent"), join(installedRoot, "agent"), { recursive: true });
    const env: Record<string, string | undefined> = { ...process.env, PLUGIN_ROOT: installedRoot };
    delete env.COPILOT_PLUGIN_ROOT;
    const result = spawnSync("bash", ["-c", command], {
      cwd: unrelatedCwd,
      env: env as NodeJS.ProcessEnv,
      input: JSON.stringify({ sessionId: "bootstrap-test", timestamp: 1700000000000, cwd: unrelatedCwd, source: "startup" }),
      encoding: "utf8",
      timeout: 15000,
    });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    const lines = result.stdout.trim().split(/\r?\n/);
    expect(lines).toHaveLength(1);
    const response = JSON.parse(lines[0]);
    expect(response.additionalContext).toContain(installedRoot);
    expect(response.additionalContext).toContain(join(installedRoot, "agent", "AGENTS.md"));
    for (const rel of [["agent", "AGENTS.md"], ["agent", "skills", "SKILLS.md"]]) {
      const installed = readFileSync(join(installedRoot, ...rel), "utf8");
      expect(installed).toBe(readFileSync(join(root, ...rel), "utf8"));
      expect(response.additionalContext).toContain(installed.trim());
    }
    expect(result.stderr).toBe("");
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("malformed input fails without echoing untrusted content", () => {
  for (const marker of ["UNTRUSTED_SECRET_5279", "TOPSECRET_INITIAL_PROMPT"]) {
    const result = spawnSync("node", [join(root, ".github", "plugin", "session-start.mjs")], {
      cwd: tmpdir(), input: `{"initialPrompt":${marker}}`, encoding: "utf8",
    });
    expect(result.status).not.toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).not.toContain(marker.startsWith("UNTRUSTED") ? "UNTRUSTED" : "TOPSECRET");
  }
});
