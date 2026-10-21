// Pure helper tests: they exercise deterministic normalization/interpretation only. They do not intercept or prove native Copilot dispatch, questions or hooks.
import { test, expect } from "bun:test";
import { readFileSync, existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { join, resolve, isAbsolute } from "node:path";
import * as compat from "../.github/plugin/copilot-compat.mjs";

const root = resolve(import.meta.dir, "..");
const rolesPath = join(root, "agent", "roles.json");
const roles = JSON.parse(readFileSync(rolesPath, "utf8")) as { name: string; tools: string }[];
const packet = { candidate: root, task: "t", expectedBehavior: "b", allowedScope: ["src"], prohibitedActions: ["none"] };
const headers = () => Object.fromEntries(roles.map((r) => [r.name, compat.readHeader(readFileSync(join(root, "agent", "agents", `${r.name}.md`), "utf8"))]));

test("registry stays the original bare array with no host sections or model fields from Copilot", () => {
  expect(Array.isArray(JSON.parse(readFileSync(rolesPath, "utf8")))).toBe(true);
  for (const r of roles) expect(Object.keys(r)).not.toEqual(expect.arrayContaining(["copilot"]));
});

test("normalizes Pi tools to the verified native aliases without expanding privilege", () => {
  expect(compat.nativeTools("read, grep, find, ls, bash, powershell, edit, write")).toBe("read, search, execute, edit");
  expect(compat.nativeTools("read, grep")).toBe("read, search");
  expect(compat.nativeTools("grep,find")).toBe("search");
});

test("unknown, native-already, empty or blank tools fail instead of defaulting to all tools", () => {
  for (const bad of ["read, browser", "read, mcp__x", "read, search", "", "  ", "read,,grep", undefined, 7, "READ"]) expect(() => compat.nativeTools(bad as never)).toThrow();
});

test("all registry roles have native headers aligned to registry grants", () => {
  expect(compat.checkAlignment(roles, headers())).toEqual([]);
});

test("alignment reports drift: widened tools, model keys, missing/extra profiles, name mismatch", () => {
  const h = headers();
  const tampered = structuredClone(h);
  tampered["scout"].tools = "read, search, execute, edit";
  tampered["reviewer"].model = "x";
  delete tampered["oracle"];
  tampered["ghost"] = { name: "ghost", description: "d", tools: "read" };
  tampered["debugger"].name = "other";
  const problems = compat.checkAlignment(roles, tampered).join("\n");
  for (const p of [/scout.*tools/, /reviewer.*(model|keys)/, /oracle.*missing/, /ghost.*(extra|unknown)/, /debugger.*name/]) expect(problems).toMatch(p);
});

test("an unmappable registry tool is reported, not skipped", () => {
  const bad = [{ name: "scout", tools: "read, browser" }];
  expect(compat.checkAlignment(bad, { scout: { name: "scout", description: "d", tools: "read" } }).join("\n")).toMatch(/scout.*browser/);
});

test("exact named dispatch needs a supported capability and the exact available role", () => {
  const names = ["reviewer", "scout"];
  expect(compat.resolveRole("reviewer", names, "supported")).toEqual({ ok: true, role: "reviewer" });
  for (const status of ["unsupported", "unverified", undefined, "yes"]) expect(compat.resolveRole("reviewer", names, status as never).ok).toBe(false);
  for (const missing of ["test-engineer", "Reviewer", "reviewer ", "general-purpose", ""]) {
    const r = compat.resolveRole(missing, names, "supported");
    expect(r.ok).toBe(false);
    expect("role" in r).toBe(false);
  }
});

test("a cancelled, missing or malformed native question result is never approval", () => {
  for (const r of [undefined, null, {}, { status: "cancelled" }, { status: "answered" }, { status: "answered", answer: "" }, { status: "answered", answer: "no" }, "yes", { status: "timeout", answer: "Approve" }]) expect(compat.isApproval(r, "Approve")).toBe(false);
  expect(compat.isApproval({ status: "answered", answer: "Approve" }, "Approve")).toBe(true);
  expect(compat.isApproval({ status: "answered", answer: "Approve" }, "")).toBe(false);
});

test("handoff PASS needs real check commands with exit codes and an absolute evidence path", () => {
  const ok = { ...packet, status: "PASS", checks: [{ command: "bun test", exitCode: 0 }], evidence: [resolve(root, "README.md")], next: "done", risks: "none" };
  expect(compat.validateHandoff(ok)).toEqual([]);
  for (const bad of [
    undefined, "done", { ...ok, checks: "done" }, { ...ok, checks: [] }, { ...ok, checks: ["done"] }, { ...ok, checks: [{ command: "done" }] },
    { ...ok, checks: [{ command: "bun test", exitCode: 1 }] }, { ...ok, checks: [{ command: "", exitCode: 0 }] },
    { ...ok, evidence: [] }, { ...ok, evidence: ["rel/path"] }, { ...ok, status: "done" },
  ]) expect(compat.validateHandoff(bad as never).length).toBeGreaterThan(0);
  expect(compat.validateHandoff({ ...ok, status: "FAIL", checks: [{ command: "bun test", exitCode: 1 }], risks: "tests fail" })).toEqual([]);
});

test("handoff needs nonblank next action and risk statement, and dense complete entries (structural only)", () => {
  const ok = { ...packet, status: "PASS", checks: [{ command: "bun test", exitCode: 0 }], evidence: [resolve(root, "README.md")], next: "none", risks: "none" };
  const { next, ...noNext } = ok; const { risks, ...noRisks } = ok;
  // eslint-disable-next-line no-sparse-arrays
  const sparse = (a: unknown[]) => { const x = new Array(a.length + 1); a.forEach((v, i) => (x[i] = v)); return x; };
  for (const bad of [
    noNext, noRisks, { ...ok, next: "" }, { ...ok, risks: "  " }, { ...ok, next: 1 }, { ...ok, risks: null },
    { ...ok, checks: sparse(ok.checks) }, { ...ok, evidence: sparse(ok.evidence) }, { ...ok, evidence: [resolve(root, "README.md"), 7] },
    { ...ok, evidence: [resolve(root, "README.md"), "  "] }, { ...ok, checks: [...ok.checks, null] }, { ...ok, checks: [{ command: "   ", exitCode: 0 }] },
    { ...ok, checks: [{ command: "bun test", exitCode: "0" }] }, { ...ok, checks: [{ command: 5, exitCode: 0 }] },
  ]) expect(compat.validateHandoff(bad as never).length).toBeGreaterThan(0);
  expect(compat.validateHandoff({ ...ok, next: "main reviews", risks: "none" })).toEqual([]);
});

test("exact role matching refuses malformed requested role and inventory without throwing", () => {
  const sparse = new Array(2); sparse[0] = "reviewer";
  for (const inv of ["senior-reviewer", "reviewer", undefined, null, {}, 7, ["reviewer", 1], ["reviewer", ""], ["reviewer", null], ["reviewer", " "], sparse, new Set(["reviewer"])]) {
    let r: { ok: boolean } | undefined;
    expect(() => { r = compat.resolveRole("reviewer", inv as never, "supported"); }).not.toThrow();
    expect(r!.ok).toBe(false);
  }
  for (const req of [undefined, null, 7, ["reviewer"], "", "  "]) expect(compat.resolveRole(req as never, ["reviewer"], "supported").ok).toBe(false);
  expect(compat.resolveRole("reviewer", ["scout", "reviewer"], "supported")).toEqual({ ok: true, role: "reviewer" });
});

test("approval comparison rejects non-textual, blank, and malformed options/answers/records; matching is exact", () => {
  for (const [r, o] of [
    [{ status: "answered", answer: 7 }, 7], [{ status: "answered", answer: "   " }, "   "], [{ status: "answered", answer: {} }, {}], [{ status: "answered", answer: ["Approve"] }, ["Approve"]],
    [{ status: "answered", answer: true }, true], [{ status: "answered", answer: " Approve" }, "Approve"], [{ status: "answered", answer: "approve" }, "Approve"],
    [{ status: "answered", answer: "Approve" }, null], [{ status: "answered", answer: "Approve" }, undefined], [["answered", "Approve"], "Approve"],
  ] as const) expect(compat.isApproval(r as never, o as never)).toBe(false);
});

test("header reader rejects duplicate, unsupported, malformed lines and ambiguous non-string scalars", () => {
  const h = (...lines: string[]) => ["---", ...lines, "---", "body", ""].join("\n");
  expect(compat.readHeader(h("name: scout", "description: A plain one, with (punct).", "tools: read"))).toEqual({ name: "scout", description: "A plain one, with (punct).", tools: "read" });
  for (const bad of [
    h("name: scout", "description: # missing", "tools: read"), h("name: scout", "description: d", "tools: *", "tools: read"),
    h("name: scout", "description: d", "tools: read", "tools: read"), h("name: scout", "description:", "tools: read"),
    h("name: scout", "description: null", "tools: read"), h("name: scout", "description: ~", "tools: read"), h("name: scout", "description: true", "tools: read"),
    h("name: scout", "description: 12", "tools: read"), h("name: scout", "description: [a]", "tools: read"), h("name: scout", "description: {a: b}", "tools: read"),
    h("name: scout", "description: !!str d", "tools: read"), h("name: scout", "description: &a d", "tools: read"), h("name: scout", "description: a: b", "tools: read"),
    h("name: scout", "description: d # c", "tools: read"), h("name: scout", "description: 'q'", "tools: read"), h("name: scout", "description: |", "tools: read"),
    h("name: scout", "description: d", "  tools: read"), h("name: scout", "", "tools: read"), h("name: scout", "# c", "tools: read"), h("name: scout", "description:d", "tools: read"),
    h("name: scout", "description: d", "- tools"),
  ]) expect(() => compat.readHeader(bad)).toThrow();
});

test("alignment reports non-string or ambiguous header values", () => {
  const base = { name: "scout", description: "d", tools: "read" };
  const r = [{ name: "scout", tools: "read" }];
  for (const v of [{ ...base, description: null }, { ...base, description: 5 }, { ...base, description: "# x" }, { ...base, tools: ["read"] }, { ...base, description: "null" }]) expect(compat.checkAlignment(r, { scout: v as never }).length).toBeGreaterThan(0);
});

test("check CLI exits 1 on a package whose header is malformed", () => {
  const dir = mkdtempSync(join(tmpdir(), "compat-"));
  try {
    mkdirSync(join(dir, "agent", "agents"), { recursive: true });
    writeFileSync(join(dir, "agent", "roles.json"), JSON.stringify([{ name: "scout", tools: "read" }]));
    writeFileSync(join(dir, "agent", "agents", "scout.md"), ["---", "name: scout", "description: # missing", "tools: read", "---", "b", ""].join("\n"));
    const out = spawnSync("node", [join(root, ".github", "plugin", "copilot-compat.mjs"), "--root", dir], { encoding: "utf8" });
    expect(out.status).toBe(1);
    writeFileSync(join(dir, "agent", "agents", "scout.md"), ["---", "name: scout", "description: ok", "tools: read", "---", "b", ""].join("\n"));
    expect(spawnSync("node", [join(root, ".github", "plugin", "copilot-compat.mjs"), "--root", dir], { encoding: "utf8" }).status).toBe(0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("check CLI exits 0 on aligned package and 1 on drift", () => {
  const run = (args: string[]) => spawnSync("node", [join(root, ".github", "plugin", "copilot-compat.mjs"), ...args], { encoding: "utf8" });
  expect(run([]).status).toBe(0);
  expect(run(["--root", join(root, "agent", "skills")]).status).toBe(1);
});

test("bootstrap emits bounded canonical sections without a dangling copilot.md pointer or modelTiers", () => {
  const out = spawnSync("node", [join(root, ".github", "plugin", "session-start.mjs")], { input: JSON.stringify({ sessionId: "s", timestamp: 1, cwd: root, source: "startup" }), encoding: "utf8" });
  expect(out.status).toBe(0);
  const context = JSON.parse(out.stdout).additionalContext as string;
  expect(context).toContain("Shared Copilot bootstrap from");
  expect(context).not.toMatch(/copilot\.md/);
  expect(context).not.toContain('"modelTiers"');
});

test("deleted references/copilot.md has no dangling pointer in package, README, skill or bootstrap", () => {
  expect(existsSync(join(root, "agent", "skills", "engineering-harness", "references", "copilot.md"))).toBe(false);
  for (const f of [["agent", "skills", "engineering-harness", "SKILL.md"], [".github", "plugin", "session-start.mjs"], ["README.md"]]) expect(readFileSync(join(root, ...f), "utf8")).not.toMatch(/references\/copilot\.md/);
});

test("header reader accepts only a conservative plain-string subset, confirmed against Bun YAML", () => {
  const h = (d: string) => ["---", "name: scout", `description: ${d}`, "tools: read", "---", "body", ""].join("\n");
  const good = ["A plain one, with (punct).", "Read-only a/b; c, d.", "x1 y2", "Null object", "nope", "e.g. fine", "yes or no questions"];
  for (const g of good) {
    expect(compat.readHeader(h(g)).description).toBe(g);
    expect((Bun as any).YAML.parse(h(g).split("---")[1]).description).toBe(g);
  }
  for (const bad of ["]", "}", ")", "1.", "-1.", "+1.", "1.e2", ".5", "1e3", "0x1F", ".inf", "-.inf", ".nan", "1_0", "1:2", "a'b", 'a"b', "a@b", "a%b", "a#b", "a\tb", "a,]", "d]", "a{b", "a|b", "a>b", "<<", "=", "\u00e9", "NULL", "No", "~"]) {
    expect(() => compat.readHeader(h(bad)), bad).toThrow();
    expect(compat.checkAlignment([{ name: "scout", tools: "read" }], { scout: { name: "scout", description: bad, tools: "read" } as never }).length, bad).toBeGreaterThan(0);
  }
});

test("check CLI refuses unsupported scalar headers", () => {
  const dir = mkdtempSync(join(tmpdir(), "compat-"));
  try {
    mkdirSync(join(dir, "agent", "agents"), { recursive: true });
    writeFileSync(join(dir, "agent", "roles.json"), JSON.stringify([{ name: "scout", tools: "read" }]));
    for (const d of ["]", "1.", "}", "1.e2"]) {
      writeFileSync(join(dir, "agent", "agents", "scout.md"), ["---", "name: scout", `description: ${d}`, "tools: read", "---", "b", ""].join("\n"));
      expect(spawnSync("node", [join(root, ".github", "plugin", "copilot-compat.mjs"), "--root", dir], { encoding: "utf8" }).status, d).toBe(1);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("decorated sparse arrays are not dense: refused for inventory and handoff evidence/checks", () => {
  const inv: string[] = ["reviewer"]; inv.length = 2; (inv as any).note = "metadata";
  expect(compat.resolveRole("reviewer", inv, "supported").ok).toBe(false);
  const ev: unknown[] = new Array(1); (ev as any).note = "metadata, not a path";
  const checks: unknown[] = new Array(1); (checks as any).note = "m";
  const ok = { ...packet, status: "PASS", checks: [{ command: "bun test", exitCode: 0 }], evidence: [resolve(root, "README.md")], next: "none", risks: "none" };
  expect(compat.validateHandoff({ ...ok, evidence: ev } as never).length).toBeGreaterThan(0);
  expect(compat.validateHandoff({ ...ok, checks } as never).length).toBeGreaterThan(0);
  const dense = ["reviewer"]; (dense as any).note = "extra non-index property is not a hole";
  expect(compat.resolveRole("reviewer", dense, "supported").ok).toBe(true);
  expect(compat.validateHandoff(ok)).toEqual([]);
});

const real = (name: string) => roles.find((r) => r.name === name) as never;
const observed = JSON.parse(readFileSync(join(root, "tests", "fixtures", "copilot-native-observed.json"), "utf8"));
const cli = (...args: string[]) => spawnSync("node", [join(root, ".github", "plugin", "copilot-compat.mjs"), ...args], { encoding: "utf8" });

test("model requirement is the verbatim declared-default-tier source for every real role", () => {
  for (const r of roles as any[]) {
    const src = r.modelTiers[r.defaultModelTier];
    expect(compat.modelRequirement(r)).toEqual({ role: r.name, tier: r.defaultModelTier, model: src.model, fallbackModel: src.fallbackModel, thinking: src.thinking });
  }
  expect(compat.modelRequirement(real("oracle"))).toEqual({ role: "oracle", tier: "capable", model: "anthropic/claude-opus-5-5", fallbackModel: "", thinking: "high" });
  expect(compat.modelRequirement(real("scout")).tier).toBe("economy");
});

test("malformed or missing model source fails clearly and is never taken from elsewhere", () => {
  const base = { name: "x", defaultModelTier: "economy", modelTiers: { economy: { model: "m", fallbackModel: "f", thinking: "low" } } };
  expect(compat.modelRequirement(base as never).model).toBe("m");
  const bad: unknown[] = [
    null, "x", [], { ...base, defaultModelTier: undefined }, { ...base, defaultModelTier: "" }, { ...base, defaultModelTier: "capable" }, { ...base, defaultModelTier: "toString" },
    { ...base, modelTiers: undefined }, { ...base, modelTiers: [] }, { ...base, modelTiers: { economy: null } },
    { ...base, modelTiers: { economy: { fallbackModel: "f", thinking: "low" } } }, { ...base, modelTiers: { economy: { model: " ", fallbackModel: "f", thinking: "low" } } },
    { ...base, modelTiers: { economy: { model: "m", thinking: "low" } } }, { ...base, modelTiers: { economy: { model: "m", fallbackModel: 1, thinking: "low" } } },
    { ...base, modelTiers: { economy: { model: "m", fallbackModel: "f" } } }, { ...base, modelTiers: { economy: { model: "m", fallbackModel: "f", thinking: "" } } },
    { ...base, name: "" },
  ];
  for (const b of bad) expect(() => compat.modelRequirement(b as never)).toThrow();
});

test("model compatibility is never ready: absent evidence unverified, rejected/unadvertised unsupported, advertised still unverified", () => {
  const req = compat.modelRequirement(real("reviewer"));
  const none = compat.modelCompatibility(req, undefined);
  expect(none).toMatchObject({ status: "unverified", ready: false });
  expect(compat.modelCompatibility(req, { rejectedModels: [req.model] })).toMatchObject({ status: "unsupported", ready: false });
  expect(compat.modelCompatibility(req, { advertisedModels: ["other"] })).toMatchObject({ status: "unsupported", ready: false });
  const advertised = compat.modelCompatibility(req, { advertisedModels: [req.model, req.fallbackModel] });
  expect(advertised).toMatchObject({ status: "unverified", ready: false });
  expect(advertised.reasons.join(" ")).toMatch(/thinking|effort/);
  for (const e of [{ honored: true }, { ready: true }, { status: "honored" }, true, "honored", { advertisedModels: "x" }, { advertisedModels: new Array(2) }, { rejectedModels: [1] }, {}, [], null])
    expect(compat.modelCompatibility(req, e as never)).toMatchObject({ ready: false, status: expect.stringMatching(/^(unverified|unsupported)$/) });
  expect(compat.modelCompatibility(req, { honored: true } as never).status).toBe("unverified");
  expect(none.requirement).toEqual(req);
  expect(JSON.stringify(none)).not.toMatch(/honored":true|"ready":true/);
});

test("native identity needs canonical registry role, explicit namespace and exact qualified runtime inventory", () => {
  const inv = ["probe:reviewer", "probe:scout", "explore", "reviewer"];
  expect(compat.nativeIdentity(roles, "reviewer", "probe", inv, "supported")).toEqual({ ok: true, nativeName: "probe:reviewer" });
  for (const [role, ns, i, cap] of [
    ["reviewer", "probe", inv, "unverified"], ["reviewer", "probe", inv, "unsupported"], ["reviewer", "probe", inv, undefined],
    ["reviewer", "other", inv, "supported"], ["reviewer", "", inv, "supported"], ["reviewer", undefined, inv, "supported"], ["reviewer", "pro:be", inv, "supported"],
    ["explore", "probe", ["probe:explore", "explore"], "supported"], ["ghost", "probe", ["probe:ghost"], "supported"],
    ["review", "probe", inv, "supported"], ["Reviewer", "probe", inv, "supported"], ["reviewer", "probe", ["probe:reviewer-2", "xprobe:reviewer"], "supported"],
    ["reviewer", "probe", ["reviewer"], "supported"], ["reviewer", "probe", "probe:reviewer", "supported"], ["reviewer", "probe", new Array(1), "supported"],
    [undefined, "probe", inv, "supported"], ["test-engineer", "probe", inv, "supported"],
  ] as const) {
    const r = compat.nativeIdentity(roles, role as never, ns as never, i as never, cap as never);
    expect(r.ok, JSON.stringify([role, ns, cap])).toBe(false);
    expect("nativeName" in r).toBe(false);
  }
  expect(compat.nativeIdentity([], "reviewer", "probe", inv, "supported").ok).toBe(false);
});

test("role preflight keeps native availability separate from non-ready model compatibility", () => {
  const inv = ["probe:reviewer"];
  const p = compat.rolePreflight(roles, { role: "reviewer", namespace: "probe", inventory: inv, dispatch: "supported" });
  expect(p.native.ok).toBe(true);
  expect(p.model).toMatchObject({ status: "unverified", ready: false });
  expect(p.ready).toBe(false);
  expect(p.modelBoundDelegation).toBe("non-ready");
  expect(p.limitations.join(" ")).toMatch(/not.*(intercept|authority)/i);
  const none = compat.rolePreflight(roles, { role: "reviewer" } as never);
  expect(none.native.ok).toBe(false);
  expect(none.ready).toBe(false);
  expect(() => compat.rolePreflight(roles, { role: "ghost" } as never)).toThrow(/registry/);
  const unsupportedModel = compat.rolePreflight(roles, { role: "reviewer", namespace: "probe", inventory: inv, dispatch: "supported", modelEvidence: { rejectedModels: [compat.modelRequirement(real("reviewer")).model] } });
  expect(unsupportedModel.native.ok).toBe(true);
  expect(unsupportedModel.model.status).toBe("unsupported");
});

test("handoff needs the full packet: absolute candidate, task, expected behavior, dense nonblank scope lists", () => {
  const ok = { ...packet, status: "PASS", checks: [{ command: "bun test", exitCode: 0 }], evidence: [resolve(root, "README.md")], next: "none", risks: "none" };
  expect(compat.validateHandoff(ok)).toEqual([]);
  const without = (k: string) => { const c: any = { ...ok }; delete c[k]; return c; };
  for (const k of ["candidate", "task", "expectedBehavior", "allowedScope", "prohibitedActions"]) expect(compat.validateHandoff(without(k)).join("\n"), k).toMatch(new RegExp(k));
  const sparse = new Array(1);
  for (const bad of [
    { candidate: "rel/path" }, { candidate: "" }, { candidate: 5 }, { task: " " }, { task: 1 }, { expectedBehavior: "" }, { expectedBehavior: null },
    { allowedScope: [] }, { allowedScope: "src" }, { allowedScope: [""] }, { allowedScope: [" "] }, { allowedScope: [1] }, { allowedScope: sparse },
    { prohibitedActions: [] }, { prohibitedActions: "none" }, { prohibitedActions: ["x", null] }, { prohibitedActions: sparse },
  ]) expect(compat.validateHandoff({ ...ok, ...bad } as never).length, JSON.stringify(bad)).toBeGreaterThan(0);
  expect(compat.validateHandoff({ ...ok, allowedScope: ["a", "b"], prohibitedActions: ["no push", "no merge"] })).toEqual([]);
});

test("dense predicate does not allocate by length: a huge sparse array is refused quickly", () => {
  const huge: unknown[] = []; huge.length = 2 ** 32 - 1;
  const t = Date.now();
  expect(compat.resolveRole("reviewer", huge as never, "supported").ok).toBe(false);
  expect(Date.now() - t).toBeLessThan(1000);
});

test("observed finite sample: provenance, namespaced exact calls, refusal, overlap, model rejection, unknown question", () => {
  const file = join(root, "tests", "fixtures", "copilot-native-observed.json");
  const observed = JSON.parse(readFileSync(file, "utf8"));
  expect(observed.kind).toBe("observed-finite-sample");
  expect(observed.copilotVersion).toBe("1.0.98");
  for (const hash of Object.values(observed.sourceSha256) as string[]) expect(hash).toMatch(/^[0-9a-f]{64}$/);
  expect(JSON.stringify(observed)).not.toMatch(/Users|MSI|-[0-9a-f]{4}-[0-9a-f]{4}-|call_|secret|token/i);
  expect(readFileSync(file).length).toBeLessThan(8192);
  const ns = observed.pluginNamespace;
  const calls = observed.calls as any[];
  const inventory = [...new Set(calls.filter((c) => c.subagentStart).map((c) => c.agentType))] as string[];
  expect([...inventory].sort()).toEqual([`${ns}:probe-alpha`, `${ns}:probe-beta`]);
  const probeRoles = [{ name: "probe-alpha" }, { name: "probe-beta" }, { name: "probe-missing" }, { name: "probe-model" }];
  expect(compat.nativeIdentity(probeRoles, "probe-alpha", ns, inventory, "supported")).toEqual({ ok: true, nativeName: `${ns}:probe-alpha` });
  const missing = calls.find((c) => c.agentType === `${ns}:probe-missing`);
  expect(missing.success).toBe(false);
  expect(missing.subagentStart).toBeUndefined();
  expect(compat.nativeIdentity(probeRoles, "probe-missing", ns, inventory, "supported").ok).toBe(false);
  const par = calls.filter((c) => c.toolStart === "2026-10-21T11:06:21.257Z");
  expect(par.length).toBe(2);
  const [a, b] = par;
  expect(Date.parse(a.subagentStart) < Date.parse(b.subagentCompleted) && Date.parse(b.subagentStart) < Date.parse(a.subagentCompleted)).toBe(true);
  const model = calls.find((c) => c.agentType === `${ns}:probe-model`);
  expect(model.success).toBe(false);
  expect(model.subagentStart).toBeUndefined();
  // a model rejection is a model incompatibility; other exact roles stay natively available
  const req = { role: "probe-model", tier: "t", model: "anthropic/claude-haiku-5-5", fallbackModel: "", thinking: "low" };
  expect(model.error).toContain(req.model);
  expect(compat.modelCompatibility(req, { rejectedModels: [req.model] })).toMatchObject({ status: "unsupported", ready: false });
  expect(observed.askUserInvocations).toBe(0);
  expect(compat.isApproval(undefined, "Approve")).toBe(false);
  expect(observed.hooksObserved).toContain("preToolUse");
  expect(observed.hookPayloadHasAuthority).toBe(false);
});

test("named-role CLI prints registry requirement and is non-ready/unverified without active evidence", () => {
  const out = cli("--role", "reviewer");
  expect(out.status).toBe(2);
  const j = JSON.parse(out.stdout);
  expect(j.requirement).toEqual(compat.modelRequirement(real("reviewer")));
  expect(j).toMatchObject({ ready: false, native: { ok: false }, model: { status: "unverified", ready: false } });
  expect(cli("--role", "ghost").status).toBe(1);
  expect(cli("--role", "Reviewer").status).toBe(1);
  expect(cli("--role").status).toBe(1);
  const dir = mkdtempSync(join(tmpdir(), "compat-"));
  try {
    mkdirSync(join(dir, "agent"), { recursive: true });
    writeFileSync(join(dir, "agent", "roles.json"), JSON.stringify([{ name: "scout", tools: "read" }]));
    expect(cli("--role", "scout", "--root", dir).status).toBe(1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("CLI refuses unsupported arguments; default metadata check unchanged", () => {
  for (const a of [["--bogus"], ["extra"], ["--role", "reviewer", "--bogus"], ["--root"], ["--root", root, "--root", root], ["--role", "reviewer", "--role", "scout"], ["--check"]]) expect(cli(...a).status, a.join(" ")).toBe(1);
  expect(cli().status).toBe(0);
  expect(cli("--root", root).status).toBe(0);
});

