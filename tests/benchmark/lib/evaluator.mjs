// Effective reviewer evaluator identity, recorded per reviewer cycle (schema harness-benchmark-result/2).
// Compare uses only this record. An unknown part stays null and makes the cycle incomplete (INCONCLUSIVE), never a guessed value.
const FIELDS = ["method", "nativeDispatch", "selectedModel", "observedModel", "observedThinking", "contractFileSha256", "contractBodySha256", "sessionTools", "guidancePath", "guidancePresent"];

// Returns the evaluator record for a session identity, or null when any part is unknown or the contract did not reach the session.
export function evaluatorOf(identity) {
	const c = identity?.contract ?? null;
	const e = {
		method: c?.execution ?? null,
		nativeDispatch: typeof c?.nativeDispatch === "boolean" ? c.nativeDispatch : null,
		selectedModel: identity?.selected?.model ?? null,
		observedModel: identity?.observed?.model ?? null,
		observedThinking: identity?.observed?.thinking ?? null,
		contractFileSha256: c?.sha256 ?? null,
		contractBodySha256: c?.bodySha256 ?? null,
		sessionTools: Array.isArray(c?.tools?.session) ? [...c.tools.session].sort() : null,
		guidancePath: c?.moduleReference?.path ?? null,
		guidancePresent: typeof c?.moduleReference?.present === "boolean" ? c.moduleReference.present : null,
	};
	return c?.appendLoaded === true && FIELDS.every((f) => e[f] !== null) ? e : null;
}

// Distinct effective evaluators across all reviewer cycles, plus the count of cycles with no complete identity.
export function summarizeEvaluators(records) {
	const distinct = new Map();
	let unidentifiedCycles = 0;
	for (const r of records) for (const cycle of r.reviewer?.cycles ?? []) {
		if (!cycle.evaluator) { unidentifiedCycles++; continue; }
		const key = JSON.stringify(cycle.evaluator);
		if (!distinct.has(key)) distinct.set(key, cycle.evaluator);
	}
	return { effective: [...distinct.values()], unidentifiedCycles };
}
