// Pi SDK adapter for the benchmark runner (Pi 1.4.0 public exports: createAgentSession, SessionManager, SettingsManager,
// ModelRuntime, DefaultResourceLoader, getAgentDir). The Pi package loads lazily; importing this module starts nothing.
// Live use is an operator/main-owned invocation of the benchmark CLI, never a leaf dispatch.
// Model identity: the main session uses the profile default (settings defaultProvider/defaultModel/defaultThinkingLevel); the
// reviewer uses the registry's reviewer tier. Each model is resolved from the SDK registry with configured credentials; the next
// configured fallback is used only when a candidate is absent or has no credentials, and every attempt is recorded. A provider
// failure during a run is never replayed here: it fails the task. Served model/provider come from assistant message events.
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { runtimeExtensionPaths } from "./runtime.mjs";
import { loadReviewerContract } from "./reviewer-contract.mjs";

const READ_ONLY_TOOLS = ["read", "grep", "find", "ls"];
// The main session delegates implementation through native subagent dispatch and never edits or writes the task directly (C6).
const MAIN_TOOLS = [...READ_ONLY_TOOLS, "subagent"];
const REVIEW_CONTRACT = "You are the reviewer role of the Pi harness benchmark: a fresh, read-only review session. Do not edit files; report findings only in the requested line format.";
// How the reviewer contract reaches the session: an isolated SDK session carrying the candidate role body. Not native named dispatch.
export const REVIEWER_EXECUTION = "sdk-isolated-session-role-contract";

// Tries the configured chain in order; returns the first model that exists in the registry with configured credentials.
async function resolveChain(spec, modelRuntime) {
	const chain = [spec.model, ...(spec.fallbacks ?? [])];
	const attempts = [];
	for (const qualified of chain) {
		const slash = qualified.indexOf("/");
		const provider = qualified.slice(0, slash);
		const id = qualified.slice(slash + 1);
		const model = modelRuntime.getModel(provider, id);
		if (!model) { attempts.push({ model: qualified, status: "not in catalog" }); continue; }
		if (!modelRuntime.hasConfiguredAuth(provider)) { attempts.push({ model: qualified, status: "no configured credentials" }); continue; }
		attempts.push({ model: qualified, status: "selected" });
		return { model, selected: qualified, attempts };
	}
	throw new Error(`no usable model for ${spec.role ?? "main"}: tried ${chain.join(", ")} (${attempts.map((a) => a.status).join("; ")})`);
}

// Reviewer inputs resolved before any loader or session exists (fail closed): the candidate contract body, the declared tools
// restricted to read-only, and the absolute installed review guidance reference.
function reviewerSetup({ roleSpec, runtime, agentDir }) {
	const contract = loadReviewerContract({ candidateRoot: runtime.root });
	if (!Array.isArray(roleSpec.tools)) throw new Error("reviewer declares no tools in roles.json: refusing to choose a tool set");
	const declared = roleSpec.tools.slice();
	const session = READ_ONLY_TOOLS.filter((t) => declared.includes(t));
	const excluded = declared.filter((t) => !READ_ONLY_TOOLS.includes(t));
	const guidance = path.join(agentDir, "skills", "engineering-harness", "review", "index.md");
	const moduleReference = { path: guidance, present: fs.existsSync(guidance) };
	const appendSystemPrompt = [contract.body, `${REVIEW_CONTRACT} Installed review guidance (absolute path; read it before substantive review when present): ${guidance}`];
	const identity = { role: "reviewer", file: contract.file, sha256: contract.sha256, bodySha256: contract.bodySha256, execution: REVIEWER_EXECUTION, nativeDispatch: false, tools: { declared, session, excluded }, moduleReference };
	return { contract, tools: session, appendSystemPrompt, identity };
}

function normalise(ev) {
	if (ev?.type === "message_end" && ev.message?.role === "assistant") {
		const m = ev.message;
		return { type: "assistant", message: { role: "assistant", usage: m.usage, provider: m.provider, model: m.model } };
	}
	if (ev?.type === "tool_execution_end" && ev.toolName === "subagent") return { type: "subagent", details: ev.result?.details };
	// Tool name and outcome only (no arguments, no packet text); error text is kept only for a failed call.
	if (ev?.type === "tool_execution_end") {
		const text = (ev.result?.content ?? []).filter((c) => c?.type === "text").map((c) => c.text).join("\n");
		return { type: "tool", name: ev.toolName ?? null, isError: ev.isError === true, errorText: ev.isError === true && text ? text : null };
	}
	return null;
}

export function createPiSdkAdapter({ piPackageRoot, loadPi } = {}) {
	let sdk = null;
	let registry = null;
	const pi = async () => {
		if (sdk) return sdk;
		if (loadPi) sdk = await loadPi();
		else if (piPackageRoot) sdk = await import(pathToFileURL(path.join(piPackageRoot, "dist", "index.js")).href);
		else throw new Error("piPackageRoot is required to load the Pi SDK (pass --pi-package-root)");
		return sdk;
	};
	return {
		describe: () => ({ name: "pi-sdk", synthetic: false, piPackageRoot: piPackageRoot ?? null, extensions: "candidate package.json pi.extensions (global discovery off)" }),
		async agentDir() { return (await pi()).getAgentDir(); },
		// The profile default main model and thinking level, read from the SDK settings registry (never chosen by the benchmark).
		async resolveMainSpec({ candidateRoot }) {
			const m = await pi();
			const settings = m.SettingsManager.create(candidateRoot, m.getAgentDir());
			const provider = settings.getDefaultProvider();
			const id = settings.getDefaultModel();
			if (!provider || !id) throw new Error("no default model in the profile settings (defaultProvider/defaultModel); refusing to choose one");
			return { model: `${provider}/${id}`, fallbacks: [], thinking: settings.getDefaultThinkingLevel() ?? null, source: "profile default (settings defaultProvider/defaultModel/defaultThinkingLevel)" };
		},
		async openSession({ cwd, role, compactionEnabled, taskId, runtime, roleSpec }) {
			const m = await pi();
			if (!roleSpec) throw new Error(`no configured ${role} identity for task ${taskId}`);
			registry ??= m.ModelRuntime.create();
			const modelRuntime = await registry;
			const resolved = await resolveChain({ ...roleSpec, role }, modelRuntime);
			const settingsManager = m.SettingsManager.inMemory({ compaction: { enabled: compactionEnabled } });
			const isReview = role === "review";
			const review = isReview ? reviewerSetup({ roleSpec, runtime, agentDir: m.getAgentDir() }) : null;
			// Discovery and the extensions come from the candidate root; tools and writes target the task replay (cwd).
			const loaderOptions = { cwd: runtime.root, agentDir: m.getAgentDir(), settingsManager, noExtensions: true, additionalExtensionPaths: isReview ? [] : runtimeExtensionPaths(runtime) };
			if (isReview) Object.assign(loaderOptions, { noContextFiles: true, appendSystemPrompt: review.appendSystemPrompt });
			const loader = new m.DefaultResourceLoader(loaderOptions);
			await loader.reload();
			const appendLoaded = isReview ? loader.getAppendSystemPrompt().includes(review.contract.body) : null;
			if (isReview && appendLoaded !== true) throw new Error("reviewer contract did not reach the loaded system prompt; refusing to open the session");
			const options = { cwd, sessionManager: m.SessionManager.inMemory(cwd), settingsManager, resourceLoader: loader, modelRuntime, model: resolved.model };
			if (roleSpec.thinking) options.thinkingLevel = roleSpec.thinking;
			options.tools = isReview ? review.tools : MAIN_TOOLS;
			const { session } = await m.createAgentSession(options);
			if (!isReview && !(session.getActiveToolNames?.() ?? []).includes("subagent")) {
				session.dispose();
				throw Object.assign(new Error("native subagent dispatch is not active in the main session; refusing to open (main must delegate, not write)"), { infrastructure: true });
			}
			const state = { session, role, taskId, buffer: [] };
			state.identity = {
				configured: { ...roleSpec },
				selected: { model: resolved.selected },
				attempts: resolved.attempts,
				observed: { model: session.model ? `${session.model.provider}/${session.model.id}` : null, thinking: session.thinkingLevel ?? null },
				servedThinking: "unknown",
			};
			if (isReview) state.identity.contract = { ...review.identity, appendLoaded };
			state.unsubscribe = session.subscribe((ev) => { const n = normalise(ev); if (n) state.buffer.push(n); });
			return state;
		},
		async startContext(state) {
			const s = state.session;
			const usage = s.getContextUsage?.();
			return { contextTokens: usage?.tokens ?? null, contextWindow: usage?.contextWindow ?? null, systemPromptChars: s.systemPrompt.length, activeTools: s.getActiveToolNames(), messageCount: s.messages.length };
		},
		async prompt(state, text) {
			state.buffer = [];
			await state.session.prompt(text);
			return { events: state.buffer, text: state.session.getLastAssistantText() ?? "" };
		},
		async compact(state) {
			const r = await state.session.compact();
			return { tokensBefore: r.tokensBefore, usage: r.usage };
		},
		async closeSession(state) {
			state.unsubscribe?.();
			state.session.dispose();
		},
	};
}
