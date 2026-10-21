// Opt-in REPLAY of one retained native Copilot CLI capture (read-only). Not a live run: no process is spawned, no model or network is called.
// Select it with COPILOT_NATIVE_OBSERVATIONS_DIR=<dir holding identity.json result.json usage.json stdout.jsonl hooks.jsonl>. Unset: skipped. Set but missing/malformed/different: fails.
// It re-derives only the finite facts already committed in fixtures/copilot-native-observed.json. It does not establish all-role dispatch, native question/cancellation behavior,
// role isolation, accepted model/effort/fallback honoring or hard authorization.
import { test, expect } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync, existsSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import * as compat from "../.github/plugin/copilot-compat.mjs";

const root = resolve(import.meta.dir, "..");
const FILES = ["identity.json", "result.json", "usage.json", "stdout.jsonl", "hooks.jsonl"] as const;
const fixture = JSON.parse(readFileSync(join(root, "tests", "fixtures", "copilot-native-observed.json"), "utf8"));

/** Reads and validates the fixed capture files; throws a clear error naming the file (never echoing capture content). */
export function replayObservations(dir: string) {
  const text = (name: string) => {
    const file = join(dir, name);
    if (!existsSync(file)) throw new Error(`observation file missing: ${name}`);
    return readFileSync(file, "utf8");
  };
  const json = (name: string) => { const t = text(name); try { return JSON.parse(t); } catch { throw new Error(`observation file malformed: ${name}`); } };
  const lines = (name: string) => text(name).split("\n").filter((l) => l.trim()).map((l, i) => { try { return JSON.parse(l); } catch { throw new Error(`observation file malformed: ${name} line ${i + 1}`); } });
  const sha = (name: string) => createHash("sha256").update(readFileSync(join(dir, name))).digest("hex");
  const identity = json("identity.json"), result = json("result.json"), usage = json("usage.json");
  const stdout = lines("stdout.jsonl"), hooks = lines("hooks.jsonl");
  for (const name of ["stdout.jsonl", "hooks.jsonl", "identity.json"] as const) if (sha(name) !== fixture.sourceSha256[name]) throw new Error(`observation file differs from the committed provenance: ${name}`);
  if (!/1\.0\.98/.test(String(identity.copilotVersion))) throw new Error("observation identity: unexpected Copilot CLI version");
  if (result.exitCode !== 0 || result.timedOut !== false) throw new Error("observation result: not a clean exit");
  if (!usage || typeof usage !== "object" || typeof usage.totalUserRequests !== "number" || !usage.modelMetrics || typeof usage.modelMetrics !== "object") throw new Error("observation usage: malformed");
  const starts = new Map<string, any>(), subStart = new Map<string, any>(), subDone = new Map<string, any>(), done = new Map<string, any>();
  for (const e of stdout) {
    const id = e?.data?.toolCallId;
    if (e.type === "tool.execution_start") starts.set(id, e);
    else if (e.type === "subagent.started") subStart.set(id, e);
    else if (e.type === "subagent.completed") subDone.set(id, e);
    else if (e.type === "tool.execution_complete") done.set(id, e);
  }
  const calls = [...starts.values()].filter((e) => e.data.toolName === "task").map((e) => {
    const id = e.data.toolCallId, end = done.get(id)?.data;
    return { toolCallId: id, agentType: e.data.arguments?.agent_type, toolStart: e.timestamp, subagentStart: subStart.get(id)?.timestamp, subagentCompleted: subDone.get(id)?.timestamp, success: end?.success, error: end?.error?.message as string | undefined };
  });
  return { identity, usage, hooks, calls, askUserStarts: [...starts.values()].filter((e) => e.data.toolName === "ask_user").length };
}

const dir = process.env.COPILOT_NATIVE_OBSERVATIONS_DIR;

test("replay validator refuses missing, malformed and different observation files (never a silent pass)", () => {
  const tmp = mkdtempSync(join(tmpdir(), "native-replay-"));
  try {
    expect(() => replayObservations(join(tmp, "absent"))).toThrow(/missing: identity\.json/);
    for (const name of FILES) writeFileSync(join(tmp, name), name.endsWith("l") ? "{}\n" : "{}");
    expect(() => replayObservations(tmp)).toThrow(/differs from the committed provenance|malformed|unexpected/);
    writeFileSync(join(tmp, "stdout.jsonl"), "{not json}\n");
    expect(() => replayObservations(tmp)).toThrow(/malformed: stdout\.jsonl line 1/);
    writeFileSync(join(tmp, "identity.json"), "{not json");
    expect(() => replayObservations(tmp)).toThrow(/malformed: identity\.json/);
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});

test.skipIf(dir === undefined)("REPLAY of one retained Copilot CLI 1.0.98 capture re-derives the committed finite facts (no live model)", () => {
  const o = replayObservations(dir as string);
  const ns = fixture.pluginNamespace as string;
  // The raw capture agrees with the committed derived calls, call by call (the error tails that list valid types/models are not compared).
  const headOf = (e?: string) => e?.split(/ (?:Valid types are|Available models):/)[0];
  expect(o.calls.map((c) => ({ agentType: c.agentType, toolStart: c.toolStart, subagentStart: c.subagentStart, subagentCompleted: c.subagentCompleted, success: c.success, error: headOf(c.error) })))
    .toEqual(fixture.calls.map((c: any) => ({ agentType: c.agentType, toolStart: c.toolStart, subagentStart: c.subagentStart, subagentCompleted: c.subagentCompleted, success: c.success, error: headOf(c.error) })));
  // Qualified native dispatch: only the exact namespaced names that actually started count as the inventory.
  const inventory = [...new Set(o.calls.filter((c) => c.subagentStart).map((c) => c.agentType))] as string[];
  expect([...inventory].sort()).toEqual([`${ns}:probe-alpha`, `${ns}:probe-beta`]);
  const probeRoles = [{ name: "probe-alpha" }, { name: "probe-beta" }, { name: "probe-missing" }, { name: "probe-model" }];
  expect(compat.nativeIdentity(probeRoles, "probe-alpha", ns, inventory, "supported")).toEqual({ ok: true, nativeName: `${ns}:probe-alpha` });
  // Missing-role refusal: no subagent ever started and the runtime named the unknown agent.
  const missing = o.calls.find((c) => c.agentType === `${ns}:probe-missing`)!;
  expect(missing.success).toBe(false);
  expect(missing.subagentStart).toBeUndefined();
  expect(missing.error).toMatch(/^Unknown agent_type: /);
  expect(compat.nativeIdentity(probeRoles, "probe-missing", ns, inventory, "supported").ok).toBe(false);
  // Parallel overlap: two dispatches issued together actually ran at the same time.
  const par = o.calls.filter((c) => c.agentType.endsWith("probe-alpha") || c.agentType.endsWith("probe-beta")).filter((c, _i, all) => all.filter((d) => d.toolStart === c.toolStart).length === 2);
  expect(par.length).toBe(2);
  const [a, b] = par;
  expect(Date.parse(a.subagentStart!) < Date.parse(b.subagentCompleted!) && Date.parse(b.subagentStart!) < Date.parse(a.subagentCompleted!)).toBe(true);
  // Model refusal: this one observed request for an unavailable model failed before any subagent started. Not evidence that an accepted model is honored.
  const model = o.calls.find((c) => c.agentType === `${ns}:probe-model`)!;
  expect(model.success).toBe(false);
  expect(model.subagentStart).toBeUndefined();
  expect(model.error).toMatch(/^Model '.+' is not available\./);
  // usage.json exists with the capture; hooks carry observed events only (no authority claim).
  expect(o.usage.totalUserRequests).toBeGreaterThan(0);
  expect(new Set(o.hooks.map((h: any) => h.event))).toEqual(new Set(fixture.hooksObserved));
  // The native question tool was never invoked in this capture: its behavior stays unverified (neither positive nor negative evidence).
  expect(o.askUserStarts).toBe(fixture.askUserInvocations);
});
