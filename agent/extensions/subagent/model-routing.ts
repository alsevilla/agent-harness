import { classifyProviderError } from "./provider-cooldown.ts";
import type { AgentConfig, ModelTier } from "./agents.ts";
export type { ModelTier } from "./agents.ts";

export interface SelectedAgent extends AgentConfig {
	readonly modelTier?: ModelTier;
}

// Omitted selection runs the role's own default tier (legacy roles keep their flat projection); explicit tiers are package-only.
export function resolveModelTier(agent: AgentConfig, requested?: ModelTier): SelectedAgent {
	if (requested !== undefined && agent.source !== "package") throw new Error(`modelTier is only supported for canonical package roles (\"${agent.name}\")`);
	const tier = requested ?? agent.defaultModelTier;
	if (tier === undefined) return { ...agent, fallbackModel: agent.fallbackModel?.slice(), tools: agent.tools?.slice() };
	const models = agent.modelTiers?.[tier];
	if (!models) throw new Error(requested === undefined ? `defaultModelTier \"${tier}\" is not configured for role \"${agent.name}\"` : `modelTier \"${tier}\" is not supported for role \"${agent.name}\"`);
	return { ...agent, model: models.model, fallbackModel: [...models.fallbackModel], tools: agent.tools?.slice(), thinking: "thinking" in models ? models.thinking : agent.thinking, modelTier: tier };
}

// Model IDs are catalog identifiers: trimmed, otherwise passed through verbatim (no aliasing).
export function parseFallbackModels(value: string | undefined): string[] {
	return [...new Set((value ?? "").split("||").map((model) => model.trim()).filter(Boolean))];
}

// fallbackModels is already parsed at the config boundary (parseFallbackModels); this only drops the primary.
export function getFallbackSequence(primaryModel: string | undefined, fallbackModels: readonly string[] = []): string[] {
	const primary = primaryModel?.trim();
	return fallbackModels.filter((model) => model !== primary);
}

export function nextFallbackModel(
	result: Parameters<typeof isProviderAvailabilityFailure>[0],
	remainingFallbacks: string[],
	aborted = false,
): string | undefined {
	return !aborted && isProviderAvailabilityFailure(result) ? remainingFallbacks[0] : undefined;
}

export function isProviderAvailabilityFailure(result: {
	exitCode: number;
	stopReason?: string;
	errorMessage?: string;
	stderr?: string;
	output?: string;
	toolActivity?: boolean;
}): boolean {
	if (result.stopReason === "aborted" || result.toolActivity || (result.exitCode === 0 && result.stopReason !== "error")) return false;
	// Only a real error stop can be a provider availability failure: length, toolUse, pending and deferred never replay.
	if (result.stopReason !== undefined && result.stopReason !== "error") return false;

	// Only the real error message counts; output/stderr prose never triggers replay. Auth and model errors are not replayed.
	if (/^provider cooldown\b/i.test(result.errorMessage ?? "")) return false; // the guard's own refusals are never provider health; the parent store decides replay
	const kind = classifyProviderError(result.errorMessage).kind;
	return kind === "quota" || kind === "rate" || kind === "transient";
}

export function shouldRetryWithFallback(
	result: Parameters<typeof isProviderAvailabilityFailure>[0],
	primaryModel: string | undefined,
	fallbackModels: string | undefined,
	aborted = false,
): boolean {
	return Boolean(!aborted && getFallbackSequence(primaryModel, parseFallbackModels(fallbackModels)).length && isProviderAvailabilityFailure(result));
}
