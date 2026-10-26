// OFFLINE SYNTHETIC adapter: no Pi, no provider, no model. Output is labelled synthetic and is NOT a performance baseline.
// Used by the offline integration test and as a CLI smoke path.
const usage = (total = 0.001) => ({ input: 100, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 110, cost: { input: total / 2, output: total / 4, cacheRead: 0, cacheWrite: 0, total } });

export function createSyntheticAdapter({ script } = {}) {
	let n = 0;
	const defaultScript = () => ({ events: [{ type: "assistant", message: { role: "assistant", usage: usage() } }], text: "synthetic pass" });
	const run = script ?? defaultScript;
	return {
		describe: () => ({ name: "synthetic", synthetic: true, note: "SYNTHETIC OFFLINE ADAPTER: not a performance baseline" }),
		async agentDir() { return null; },
		async resolveMainSpec() { return { model: "synthetic/main", fallbacks: [], thinking: null, source: "synthetic (no profile read)" }; },
		async openSession(o) {
			const model = o.roleSpec?.model;
			return { id: ++n, calls: 0, ...o, identity: { configured: o.roleSpec ?? null, selected: { model }, attempts: [], observed: { model, thinking: null }, servedThinking: "unknown" } };
		},
		async startContext() { return { contextTokens: null, contextWindow: null, systemPromptChars: 0, activeTools: [], messageCount: 0 }; },
		async prompt(session, text) {
			if (session.role === "review") return { events: [{ type: "assistant", message: { role: "assistant", usage: usage() } }], text: "NO FINDINGS" };
			session.calls++;
			return run(session, text);
		},
		async compact() { return { tokensBefore: null, usage: undefined }; },
		async closeSession() {},
	};
}
