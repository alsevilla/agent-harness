import assert from "node:assert/strict";
import test from "node:test";
import { getFallbackSequence, isProviderAvailabilityFailure, nextFallbackModel, parseFallbackModels, resolveModelTier, shouldRetryWithFallback, type ModelTier } from "../model-routing.ts";
import type { AgentConfig } from "../agents.ts";

const agent = (name: string, source: AgentConfig["source"] = "package"): AgentConfig => ({ name, description: "role", source, filePath: "role.md", systemPrompt: "prompt", model: "configured/model", fallbackModel: ["configured/fallback"], tools: ["read"], thinking: "high" });

test("all supported role tiers resolve exact same-tier pairs without mutating configured roles", () => {
  const expected: Record<string, Partial<Record<ModelTier, [string, string]>>> = {
    "backend-worker": { economy: ["openai-codex/gpt-6-luna", "anthropic/claude-haiku-5-5"], capable: ["anthropic/claude-sonnet-5-5", "openai-codex/gpt-6.1-sol"] },
    "frontend-worker": { economy: ["anthropic/claude-haiku-5-5", "openai-codex/gpt-6-luna"], capable: ["anthropic/claude-sonnet-5-5", "openai-codex/gpt-6.1-sol"] },
    "database-worker": { economy: ["openai-codex/gpt-6-luna", "anthropic/claude-haiku-5-5"], capable: ["openai-codex/gpt-6.1-sol", "anthropic/claude-sonnet-5-5"] },
    "general-worker": { economy: ["anthropic/claude-haiku-5-5", "openai-codex/gpt-6-luna"], capable: ["anthropic/claude-sonnet-5-5", "openai-codex/gpt-6.1-sol"] },
    "platform-worker": { economy: ["anthropic/claude-haiku-5-5", "openai-codex/gpt-6-luna"], capable: ["anthropic/claude-sonnet-5-5", "openai-codex/gpt-6.1-sol"] },
    "test-engineer": { economy: ["openai-codex/gpt-6-luna", "anthropic/claude-haiku-5-5"], capable: ["anthropic/claude-sonnet-5-5", "openai-codex/gpt-6.1-sol"] },
    scout: { economy: ["anthropic/claude-haiku-5-5", "openai-codex/gpt-6-luna"] },
  };
  for (const [name, tiers] of Object.entries(expected)) for (const [tier, [model, fallback]] of Object.entries(tiers)) {
    const original = { ...agent(name), modelTiers: { [tier]: { model, fallbackModel: [fallback] } } };
    const resolved = resolveModelTier(original, tier as ModelTier);
    assert.equal(resolved.model, model);
    assert.equal(resolved.modelTier, tier);
    assert.deepEqual(resolved.fallbackModel, [fallback]);
    assert.notEqual(resolved.tools, original.tools);
    assert.deepEqual(resolved.tools, original.tools);
    assert.equal(resolved.thinking, original.thinking);
    assert.equal(resolved.systemPrompt, original.systemPrompt);
    assert.equal(original.model, "configured/model");
  }
  const configuredScout = { ...agent("scout"), modelTiers: { economy: { model: "configured/economy", fallbackModel: [] }, capable: { model: "configured/capable", fallbackModel: [] } } };
  assert.equal(resolveModelTier(configuredScout, "economy").model, "configured/economy");
  assert.equal(resolveModelTier(configuredScout, "capable").model, "configured/capable");
  for (const name of ["api-specialist", "reviewer"]) {
    const configured = { ...agent(name), modelTiers: { capable: { model: "configured/specialist", fallbackModel: [] } } };
    assert.equal(resolveModelTier(configured, "capable").model, "configured/specialist");
    assert.throws(() => resolveModelTier({ ...agent(name), modelTiers: {} }, "capable"), /not supported/);
    for (const source of ["user", "project"] as const) assert.throws(() => resolveModelTier({ ...agent(name, source), modelTiers: { capable: { model: "configured/specialist", fallbackModel: [] } } }, "capable"), /canonical package roles/);
  }
  for (const source of ["user", "project"] as const) assert.throws(() => resolveModelTier(agent("backend-worker", source), "economy"), /canonical package roles/);
  assert.throws(() => resolveModelTier(agent("unknown"), "economy"), /not supported/);
});

const tiered = (name: string, source: AgentConfig["source"] = "package"): AgentConfig => ({
  ...agent(name, source),
  thinking: "medium",
  defaultModelTier: "capable",
  modelTiers: {
    economy: { model: "fixture-economy/model", fallbackModel: ["fixture-economy/fallback"], thinking: "low" },
    capable: { model: "fixture-capable/model", fallbackModel: ["fixture-capable/fallback"], thinking: "high" },
  },
} as unknown as AgentConfig);

test("omitted selection resolves the configured default tier with its own thinking and labels the resolved tier", () => {
  const role = tiered("backend-worker");
  const omitted = resolveModelTier(role);
  assert.equal(omitted.model, "fixture-capable/model");
  assert.deepEqual(omitted.fallbackModel, ["fixture-capable/fallback"]);
  assert.equal(omitted.thinking, "high");
  assert.equal(omitted.modelTier, "capable");
  const explicit = resolveModelTier(role, "economy");
  assert.equal(explicit.thinking, "low");
  assert.equal(explicit.modelTier, "economy");
  assert.equal(role.thinking, "medium");
});

test("omitted selection owns its fallback and tools arrays after admission", () => {
  const role = tiered("backend-worker");
  const resolved = resolveModelTier(role);
  assert.notEqual(resolved.tools, role.tools);
  assert.deepEqual(resolved.tools, role.tools);
  role.modelTiers!.capable!.fallbackModel[0] = "changed-after-admission";
  (role.tools as string[])[0] = "changed-tool";
  assert.deepEqual(resolved.fallbackModel, ["fixture-capable/fallback"]);
  assert.deepEqual(resolved.tools, ["read"]);
});

test("legacy omitted selection keeps the flat projection and no tier label", () => {
  const legacy = agent("general-worker");
  const resolved = resolveModelTier(legacy);
  assert.equal(Object.hasOwn(resolved, "modelTier"), false);
  assert.equal(resolved.model, "configured/model");
  assert.deepEqual(resolved.fallbackModel, ["configured/fallback"]);
  assert.equal(resolved.thinking, "high");
  assert.notEqual(resolved.fallbackModel, legacy.fallbackModel);
});

test("explicit tier on a legacy-shaped entry without thinking inherits the flat thinking", () => {
  const legacy = { ...agent("backend-worker"), modelTiers: { capable: { model: "configured/capable", fallbackModel: [] } } };
  assert.equal(resolveModelTier(legacy as AgentConfig, "capable").thinking, "high");
});

test("omitted selection refuses a default tier missing from the tier map", () => {
  const role = { ...tiered("backend-worker"), defaultModelTier: "capable", modelTiers: { economy: { model: "fixture-economy/model", fallbackModel: [], thinking: "low" } } } as unknown as AgentConfig;
  assert.throws(() => resolveModelTier(role), /defaultModelTier "capable" is not configured for role "backend-worker"/);
});

test("omitted selection executes user and project shadows with a default tier while explicit tiers stay package-only", () => {
  for (const source of ["user", "project"] as const) {
    const shadow = tiered("backend-worker", source);
    assert.equal(resolveModelTier(shadow).model, "fixture-capable/model");
    assert.equal(resolveModelTier(shadow).modelTier, "capable");
    assert.throws(() => resolveModelTier(shadow, "economy"), /canonical package roles/);
  }
});

test("tier resolution uses only the validated selection and preserves an immutable diagnostic snapshot", () => {
  const fallbackModel = ["fixture-fallback"];
  const configured = { ...agent("backend-worker"), modelTier: "capable", modelTiers: {
    economy: { model: "fixture-provider/shared-primary", fallbackModel },
    capable: { model: "fixture-provider/shared-primary", fallbackModel: ["capable-fallback"] },
  } } as AgentConfig & { modelTier: string };
  const resolved = resolveModelTier(configured, "economy");
  assert.equal(resolved.model, "fixture-provider/shared-primary");
  assert.equal(resolved.modelTier, "economy");
  assert.notEqual(resolved.fallbackModel, fallbackModel);
  assert.deepEqual(resolved.fallbackModel, ["fixture-fallback"]);
  assert.equal(Object.hasOwn(configured, "modelTier"), true);
  assert.equal(configured.modelTier, "capable");
  fallbackModel[0] = "changed-after-selection";
  assert.deepEqual(resolved.fallbackModel, ["fixture-fallback"]);
});

// Explicit fallback slot: same package role and validated tier, first usable configured fallback, empty replay chain.
test("modelSlot fallback selects the first usable configured fallback of the same tier with no replay chain", () => {
  const role = {
    ...tiered("backend-worker"),
    modelTiers: {
      economy: { model: "fixture-economy/model", fallbackModel: ["fixture-economy/model", "fixture-economy/second", "fixture-economy/third"], thinking: "low" },
      capable: { model: "fixture-capable/model", fallbackModel: ["fixture-capable/fallback"], thinking: "high" },
    },
  } as unknown as AgentConfig;
  const normal = resolveModelTier(role, "economy");
  const slotted = resolveModelTier(role, "economy", "fallback");
  assert.equal(slotted.model, "fixture-economy/second"); // exact primary is excluded, never silently relabelled
  assert.deepEqual(slotted.fallbackModel, []);
  assert.equal(slotted.modelTier, "economy");
  assert.equal(slotted.modelSlot, "fallback");
  assert.equal(slotted.thinking, normal.thinking);
  assert.deepEqual(slotted.tools, normal.tools);
  assert.notEqual(slotted.tools, role.tools);
  assert.equal(resolveModelTier(role, "capable", "fallback").model, "fixture-capable/fallback"); // never the other tier's model
  assert.equal(Object.hasOwn(normal, "modelSlot"), false);
  assert.equal(Object.hasOwn(resolveModelTier(role, "economy", undefined), "modelSlot"), false);
  assert.equal(role.modelTiers!.economy!.fallbackModel.length, 3); // configured role is not mutated
});

test("modelSlot fallback refuses before any selection when it cannot be honoured", () => {
  const role = tiered("backend-worker");
  assert.throws(() => resolveModelTier(role, undefined, "fallback"), /requires an explicit modelTier/);
  for (const bad of ["primary", "Fallback", "", null, 1, true, ["fallback"], {}, "anthropic/claude-sonnet-5-5"]) assert.throws(() => resolveModelTier(role, "capable", bad as never), /modelSlot/, JSON.stringify(bad));
  for (const source of ["user", "project"] as const) assert.throws(() => resolveModelTier(tiered("backend-worker", source), "capable", "fallback"), /canonical package roles/);
  const noFallback = { ...tiered("oracle"), modelTiers: { capable: { model: "fixture/primary", fallbackModel: [], thinking: "high" } } } as unknown as AgentConfig;
  assert.throws(() => resolveModelTier(noFallback, "capable", "fallback"), /no usable fallback/);
  const onlyPrimary = { ...tiered("oracle"), modelTiers: { capable: { model: "fixture/primary", fallbackModel: ["fixture/primary"], thinking: "high" } } } as unknown as AgentConfig;
  assert.throws(() => resolveModelTier(onlyPrimary, "capable", "fallback"), /no usable fallback/);
  assert.throws(() => resolveModelTier({ ...tiered("scout"), modelTiers: { economy: { model: "fixture/e", fallbackModel: ["fixture/f"], thinking: "low" } } } as unknown as AgentConfig, "capable", "fallback"), /not supported/);
});

test("fallback strings parse as ordered normalized model sequences", () => {
  assert.deepEqual(parseFallbackModels(" openai-codex/gpt-6-luna || || github-copilot/gpt-6-luna || openai-codex/gpt-6-luna "), [
    "openai-codex/gpt-6-luna",
    "github-copilot/gpt-6-luna",
  ]);
  assert.deepEqual(parseFallbackModels("github-copilot/gpt-6-luna"), ["github-copilot/gpt-6-luna"]);
  assert.deepEqual(getFallbackSequence("anthropic/claude-haiku-5-5", parseFallbackModels("anthropic/claude-haiku-5-5 || github-copilot/gpt-6-luna")), ["github-copilot/gpt-6-luna"]);
});

test("fallback sequence takes parsed arrays, defaults to none, and skips only the exact primary", () => {
  assert.deepEqual(getFallbackSequence("github-copilot/claude-sonnet-5.5", ["github-copilot/claude-sonnet-5", "openai-codex/gpt-6-luna"]), ["github-copilot/claude-sonnet-5", "openai-codex/gpt-6-luna"]);
  assert.deepEqual(getFallbackSequence("github-copilot/claude-sonnet-5.5", ["github-copilot/claude-sonnet-5.5", "github-copilot/claude-sonnet-5"]), ["github-copilot/claude-sonnet-5"]);
  assert.deepEqual(getFallbackSequence("openai-codex/gpt-6-luna", undefined), []);
  assert.deepEqual(getFallbackSequence("openai-codex/gpt-6-luna", []), []);
});

test("literal Sonnet 5.5 IDs are preserved verbatim through fallback parsing and primary matching", () => {
  assert.deepEqual(parseFallbackModels("anthropic/claude-sonnet-5-5 || github-copilot/claude-sonnet-5.5 || github-copilot/claude-sonnet-5 || anthropic/claude-sonnet-5-5"), ["anthropic/claude-sonnet-5-5", "github-copilot/claude-sonnet-5.5", "github-copilot/claude-sonnet-5"]);
  assert.deepEqual(getFallbackSequence("anthropic/claude-sonnet-5-5", parseFallbackModels("anthropic/claude-sonnet-5 || anthropic/claude-sonnet-5-5")), ["anthropic/claude-sonnet-5"]);
});

test("ordered retry policy exhausts on availability errors and never retries task, aborted, or tool results", () => {
  const chain = ["openai-codex/gpt-6-luna", "github-copilot/gpt-6-luna"];
  const unavailable = { exitCode: 1, stopReason: "error", errorMessage: "503 provider unavailable" };
  assert.equal(nextFallbackModel(unavailable, chain), chain[0]);
  assert.equal(nextFallbackModel(unavailable, chain.slice(1)), chain[1]);
  assert.equal(nextFallbackModel(unavailable, []), undefined);
  assert.equal(nextFallbackModel({ ...unavailable, errorMessage: "test failed" }, chain), undefined);
  assert.equal(nextFallbackModel({ ...unavailable, stopReason: "aborted" }, chain), undefined);
  assert.equal(nextFallbackModel({ ...unavailable, toolActivity: true }, chain), undefined);
});

test("declared GPT-6.1 primary is preserved independently of Copilot fallback", () => {
  assert.deepEqual(parseFallbackModels("openai-codex/gpt-6.1-sol || github-copilot/gpt-6-sol"), ["openai-codex/gpt-6.1-sol", "github-copilot/gpt-6-sol"]);
});

test("quota fallback cannot replay edits, canceled work or task failures", () => {
  const primary = "openai-codex/gpt-6.1-sol", fallback = "github-copilot/gpt-6-sol";
  const failure = { exitCode: 1, stopReason: "error", errorMessage: "Codex error: The usage limit has been reached" };
  assert.equal(shouldRetryWithFallback(failure, primary, fallback), true);
  assert.equal(shouldRetryWithFallback(failure, primary, `${primary} || ${fallback}`), true);
  assert.equal(shouldRetryWithFallback({ ...failure, toolActivity: true }, primary, fallback), false);
  assert.equal(shouldRetryWithFallback({ ...failure, stopReason: "aborted" }, primary, fallback), false);
  assert.equal(shouldRetryWithFallback(failure, primary, fallback, true), false);
  assert.equal(shouldRetryWithFallback({ ...failure, errorMessage: "test failed" }, primary, fallback), false);
});

test("availability classifier reads only the real error message: no output/stderr prose, no auth or model replay", () => {
  const base = { exitCode: 1, stopReason: "error" };
  assert.equal(isProviderAvailabilityFailure({ ...base, errorMessage: "You have hit your ChatGPT usage limit (plus plan). Try again in ~53 min." }), true);
  assert.equal(isProviderAvailabilityFailure({ ...base, errorMessage: "upstream returned no response" }), true);
  assert.equal(isProviderAvailabilityFailure({ ...base, errorMessage: "429 Too Many Requests" }), true);
  assert.equal(isProviderAvailabilityFailure({ ...base, errorMessage: "401 unauthorized" }), false);
  assert.equal(isProviderAvailabilityFailure({ ...base, errorMessage: "model gpt-x not found" }), false);
  assert.equal(isProviderAvailabilityFailure({ ...base, errorMessage: "test failed", output: "rate limit exceeded in my answer" }), false);
  assert.equal(isProviderAvailabilityFailure({ ...base, errorMessage: "", stderr: "503 unavailable" }), false);
});

test("the guard's own synthetic cooldown messages are never provider health, so a child refusal cannot bypass the store", () => {
  const base = { exitCode: 1, stopReason: "error" };
  for (const errorMessage of ["provider cooldown unavailable", "provider cooldown cooling", "provider cooldown probe-busy", "provider cooldown blocked"]) {
    assert.equal(isProviderAvailabilityFailure({ ...base, errorMessage }), false, errorMessage);
    assert.equal(shouldRetryWithFallback({ ...base, errorMessage }, "openai-codex/gpt-6.1-sol", "github-copilot/gpt-6-sol"), false, errorMessage);
  }
});
