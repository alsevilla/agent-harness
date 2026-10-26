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
import crypto from "node:crypto";
import { runtimeExtensionPaths, verifyLoadedResources } from "./runtime.mjs";
import { loadReviewerContract } from "./reviewer-contract.mjs";

const READ_ONLY_TOOLS = ["read", "grep", "find", "ls"];
// The main session delegates implementation through native subagent dispatch and never edits or writes the task directly (C6). subagent_control is the
// native control surface (list, steer, cancel, result, decisions); both must be active, and neither is an edit or write tool.
const CONTROL_TOOLS = ["subagent", "subagent_control"];
const MAIN_TOOLS = [...READ_ONLY_TOOLS, ...CONTROL_TOOLS];
const sha256 = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");
const fileSha = (file) => { try { return sha256(fs.readFileSync(file)); } catch { return null; } };
function markdownUnder(dir, rel = "") {
	if (!fs.existsSync(dir)) return [];
	return fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1)).flatMap((e) => (e.isDirectory() ? markdownUnder(path.join(dir, e.name), `${rel}${e.name}/`) : /.md$/i.test(e.name) ? [`${rel}${e.name}`] : []));
}
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
	return { contract, tools: session, appendSystemPrompt, identity, guidance };
}

// Effective reviewer prompt/resource identity: hashes only, never prompt text. The SDK renders the prompt as tagged sections whose only per-run variable is the
// <cwd> section; that exact section is the only text normalised, so an unknown prompt shape has no semantic hash (the identity is incomplete, never guessed).
// resourcesSha256 covers the loaded SYSTEM/context/append files, each skill (metadata and file bytes) and every review guidance markdown file; promptSha256 keeps the cwd for audit.
function reviewerResources({ loader, session, cwd, guidance }) {
	const prompt = typeof session.systemPrompt === "string" ? session.systemPrompt : "";
	const parts = prompt.split("<cwd>\n" + cwd.replace(/\\/g, "/") + "\n</cwd>");
	const entries = [];
	const system = loader.getSystemPrompt?.();
	if (system !== undefined) { const source = loader.getSystemPromptSource?.()?.path ?? null; entries.push({ kind: "system", path: source, sha256: sha256(system), fileSha256: source ? fileSha(source) : null }); }
	for (const f of loader.getAgentsFiles?.().agentsFiles ?? []) entries.push({ kind: "context", path: f.path, sha256: sha256(f.content ?? ""), fileSha256: fileSha(f.path) });
	for (const f of loader.getAppendSystemPromptSources?.() ?? []) entries.push({ kind: "append", path: f.path, sha256: fileSha(f.path) });
	for (const sk of loader.getSkills?.().skills ?? []) entries.push({ kind: "skill", name: sk.name, descriptionSha256: sha256(sk.description ?? ""), path: sk.filePath, sha256: fileSha(sk.filePath) });
	const dir = path.dirname(guidance);
	for (const rel of markdownUnder(dir)) entries.push({ kind: "review-guidance", path: path.join(dir, rel), sha256: fileSha(path.join(dir, rel)) });
	entries.sort((a, b) => (JSON.stringify(a) < JSON.stringify(b) ? -1 : 1));
	return { promptSha256: sha256(prompt), effectivePromptSha256: parts.length === 2 ? sha256(parts.join("<cwd></cwd>")) : null, resourcesSha256: sha256(JSON.stringify(entries)), files: entries.length };
}

// Session events to the runner's records. A subagent call keeps isError, its text (the runner redacts and bounds it) and the background/jobId/mode marks, so a
// receipt, a refusal and a foreground result stay distinguishable. A completion notice (a custom message) carries the per-worker metadata in its details only:
// the notice content, which is what the model sees, is not read here.
function textOf(result) {
	return (result?.content ?? []).filter((c) => c?.type === "text").map((c) => c.text).join("\n");
}

function normalise(ev) {
	if (ev?.type === "message_end" && ev.message?.role === "assistant") {
		const m = ev.message;
		return { type: "assistant", message: { role: "assistant", usage: m.usage, provider: m.provider, model: m.model } };
	}
	if (ev?.type === "message_end" && ev.message?.role === "custom" && ev.message.customType === "subagent-completion") {
		const d = ev.message.details ?? {};
		return { type: "completion", jobId: typeof d.jobId === "string" ? d.jobId : null, state: typeof d.state === "string" ? d.state : null, results: Array.isArray(d.results) ? d.results : [] };
	}
	if (ev?.type === "tool_execution_end" && ev.toolName === "subagent") return { type: "subagent", toolCallId: ev.toolCallId, isError: ev.isError === true || ev.result?.isError === true, text: textOf(ev.result), details: ev.result?.details };
	// Tool name and outcome only (no arguments, no packet text); error text is kept only for a failed call.
	if (ev?.type === "tool_execution_end") {
		const text = textOf(ev.result);
		return { type: "tool", name: ev.toolName ?? null, isError: ev.isError === true, errorText: ev.isError === true && text ? text : null };
	}
	return null;
}

// Settlement tracking: a background receipt is pending until its completion; epoch counts changes so a wake-up is never lost between checks.
function track(state, n) {
	if (n?.type === "subagent" && n.details?.background === true && typeof n.details?.jobId === "string") {
		if (!state.completed.has(n.details.jobId)) state.pending.set(n.details.jobId, { mode: n.details.mode ?? null });
	} else if (n?.type === "completion" && n.jobId) {
		state.pending.delete(n.jobId);
		state.completed.add(n.jobId);
	} else return;
	state.epoch++;
	for (const wake of state.waiters.splice(0)) wake();
}

// Resolves to {value} or {error}, or {timedOut: true} once ms elapse (the timer is always cleared).
const race = (promise, ms) => new Promise((resolve) => {
	const timer = setTimeout(() => resolve({ timedOut: true }), Math.max(0, ms));
	Promise.resolve(promise).then((value) => { clearTimeout(timer); resolve({ value }); }, (error) => { clearTimeout(timer); resolve({ error }); });
});

// Event driven: wait for Pi to be idle; if background jobs are still pending, wait for the next completion (or the deadline) and check again, because a
// completion turn can launch another job. Quiescent means idle, nothing pending and no completion arrived while idling. Never polls on a timer.
async function settleRound(state, timeoutMs) {
	if (!Number.isInteger(timeoutMs) || timeoutMs < 1) throw new Error("round settlement needs an explicit timeout (milliseconds > 0) from the run configuration");
	const started = Date.now();
	const left = () => Math.max(0, timeoutMs - (Date.now() - started));
	let timedOut = false;
	for (;;) {
		const seen = state.epoch;
		const idle = await race(state.session.waitForIdle(), left());
		if (idle.timedOut) { timedOut = true; break; }
		if (idle.error) throw idle.error;
		if (state.epoch !== seen) continue; // a completion arrived meanwhile: re-check idleness before deciding
		if (state.pending.size === 0) break;
		const woke = await race(new Promise((resolve) => { if (state.epoch !== seen) resolve(); else state.waiters.push(resolve); }), left());
		if (woke.timedOut) { timedOut = true; break; }
	}
	const pendingJobs = [...state.pending.keys()];
	// Timeout: stop the main's run now; closing the session then cancels and awaits every owning worker (nothing is snapshotted or scored meanwhile).
	if (timedOut) await race(state.session.abort?.(), state.limits?.shutdownGraceMs?.value ?? 0);
	return { settled: !timedOut && pendingJobs.length === 0, timedOut, pendingJobs, waitedMs: Date.now() - started };
}

// Shutdown through the runtime; confirmed only when the extension's session_shutdown handlers (which await their workers) finished within the grace.
async function closeState(state) {
	state.unsubscribe?.();
	const started = Date.now();
	const pendingJobs = [...(state.pending?.keys() ?? [])];
	// A reviewer's resources must be the bytes it started with: a guidance, skill or SYSTEM edit during the review leaves the identity unstable (INCONCLUSIVE).
	const res = state.identity?.contract?.resources;
	if (res && state.recheck) { const end = state.recheck(); res.endResourcesSha256 = end.resourcesSha256; res.stable = end.resourcesSha256 === res.resourcesSha256 && end.effectivePromptSha256 === res.effectivePromptSha256; }
	// Abort and await idle first: the run (and any foreground child it owns) must be closed before shutdown is confirmed; runtime.dispose() only invalidates the session synchronously.
	const done = Promise.resolve().then(async () => { await state.session.abort?.(); await state.runtime.dispose(); });
	const grace = state.limits?.shutdownGraceMs?.value;
	const r = grace === undefined ? { ...(await done.then((value) => ({ value }), (error) => ({ error }))) } : await race(done, grace);
	const error = r.error ? String(r.error.message ?? r.error).slice(0, 300) : null;
	return { confirmed: !r.timedOut && !r.error, ms: Date.now() - started, pendingJobs, error };
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
		async openSession({ cwd, role, compactionEnabled, taskId, runtime, roleSpec, limits }) {
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
			// What the loader really carries: a candidate AGENTS.md or skill that a profile copy shadows is not measured, so the open fails closed.
			const loaded = { agentsFiles: loader.getAgentsFiles?.().agentsFiles ?? [], skills: loader.getSkills?.().skills ?? [] };
			if (!isReview) {
				const shadowed = verifyLoadedResources({ candidateRoot: runtime.root, loaded });
				if (shadowed.length) throw Object.assign(new Error(`candidate prompt resources are not what the session would load (profile copies shadow them): ${shadowed.join("; ")}`), { infrastructure: true, kind: "resource_shadowing" });
			}
			const appendLoaded = isReview ? loader.getAppendSystemPrompt().includes(review.contract.body) : null;
			if (isReview && appendLoaded !== true) throw new Error("reviewer contract did not reach the loaded system prompt; refusing to open the session");
			const options = { cwd, sessionManager: m.SessionManager.inMemory(cwd), settingsManager, resourceLoader: loader, modelRuntime, model: resolved.model };
			if (roleSpec.thinking) options.thinkingLevel = roleSpec.thinking;
			options.tools = isReview ? review.tools : MAIN_TOOLS;
			if (!isReview && !Number.isInteger(limits?.shutdownGraceMs?.value)) throw new Error("the main session needs limits.shutdownGraceMs from the run configuration");
			const { session } = await m.createAgentSession(options);
			// The supported lifecycle owner: AgentSessionRuntime.dispose() emits session_shutdown to the extensions (which cancel and await their background
			// workers) and then disposes the session. Session.dispose() alone emits no shutdown, and session_start is only emitted by bindExtensions().
			if (typeof m.AgentSessionRuntime !== "function") { session.dispose(); throw Object.assign(new Error("the Pi SDK exports no AgentSessionRuntime; refusing to open a session whose shutdown cannot be confirmed"), { infrastructure: true, kind: "lifecycle_unavailable" }); }
			const services = { cwd, agentDir: m.getAgentDir(), modelRuntime, settingsManager, resourceLoader: loader, diagnostics: [] };
			const lifecycle = new m.AgentSessionRuntime(session, services, async () => { throw new Error("session replacement is not supported by the benchmark"); });
			const state = { session, runtime: lifecycle, role, taskId, buffer: [], limits, pending: new Map(), completed: new Set(), epoch: 0, waiters: [], extensionErrors: [] };
			await session.bindExtensions({ onError: (e) => state.extensionErrors.push({ event: e?.event ?? null, error: String(e?.error ?? "").slice(0, 300) }) });
			const active = session.getActiveToolNames?.() ?? [];
			const missing = isReview ? [] : CONTROL_TOOLS.filter((t) => !active.includes(t));
			if (missing.length) {
				await closeState(state);
				throw Object.assign(new Error(`native ${missing.join(" and ")} not active in the main session; refusing to open (main must delegate and control workers, not write)`), { infrastructure: true, kind: "native_dispatch_unavailable" });
			}
			state.identity = {
				configured: { ...roleSpec },
				selected: { model: resolved.selected },
				attempts: resolved.attempts,
				observed: { model: session.model ? `${session.model.provider}/${session.model.id}` : null, thinking: session.thinkingLevel ?? null },
				servedThinking: "unknown",
			};
			if (isReview) {
				const measure = () => reviewerResources({ loader, session, cwd, guidance: review.guidance });
				state.identity.contract = { ...review.identity, appendLoaded, resources: { ...measure(), endResourcesSha256: null, stable: null } };
				state.recheck = measure;
			}
			else state.identity.resources = { agentsFiles: loaded.agentsFiles.map((f) => ({ path: f.path, sha256: sha256(Buffer.from(f.content ?? "", "utf8")) })), skills: loaded.skills.map((sk) => ({ name: sk.name, filePath: sk.filePath })), extensionErrors: state.extensionErrors };
			state.unsubscribe = session.subscribe((ev) => { const n = normalise(ev); if (n) { state.buffer.push(n); track(state, n); } });
			return state;
		},
		async startContext(state) {
			const s = state.session;
			const usage = s.getContextUsage?.();
			return { contextTokens: usage?.tokens ?? null, contextWindow: usage?.contextWindow ?? null, systemPromptChars: s.systemPrompt.length, activeTools: s.getActiveToolNames(), messageCount: s.messages.length };
		},
		// The main session's prompt returns only once its round is settled (idle, no pending background job); a reviewer has no workers to wait for.
		async prompt(state, text, { settle } = {}) {
			state.buffer = [];
			await state.session.prompt(text);
			const settlement = state.role === "main" ? await settleRound(state, settle?.timeoutMs) : null;
			return { events: state.buffer, text: state.session.getLastAssistantText() ?? "", settlement };
		},
		async compact(state) {
			const r = await state.session.compact();
			return { tokensBefore: r.tokensBefore, usage: r.usage };
		},
		async closeSession(state) { return closeState(state); },
	};
}
