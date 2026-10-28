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
import { checkAgentTopology, describeProblems, safeTopologyReason, TOPOLOGY_REASONS } from "./topology.mjs";
import { loadNativeAgents } from "./topology-loader.mjs";

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

// Allowlists for everything that is not model-visible text. Only these shapes ever leave a native event: no prompt, steer/answer body, authorization, stderr or error text.
const CONTROL_ACTIONS = new Set(["list", "steer", "pause", "resume", "cancel", "result", "decisions", "answer", "decline", "advice"]);
const DECISION_STATES = new Set(["open", "settled", "rejected"]);
const AUDIT_STATES = new Set(["completed", "failed", "aborted", "running"]);
const DIAGNOSTIC_CODES = new Set(["completion_delivery_failed"]);
export const TERMINAL_AUDIT = "subagent-terminal-audit";
export const DELIVERY_DIAGNOSTIC = "subagent-delivery-diagnostic";
// Identities are validated against what Pi and the subagent extension actually generate (job bg-N, worker <generation>:<n>, decision dec-<alnum>, see
// agent/extensions/subagent index.ts NATIVE_TARGET and decision-relay-state REQUEST_ID) or against the registered roles, never by character class: a token-shaped secret
// passes any character filter. Anything else is omitted.
export const JOB_ID = /^bg-\d{1,9}$/;
const WORKER_ID = /^(?:\d{1,9}|bg-\d{1,9}):\d{1,9}$/;
const REQUEST_ID = /^dec-[A-Za-z0-9]{8,40}$/;
const TARGET = /^(?:bg-\d{1,9}|\d{1,9}:\d{1,9}|#\d{1,9}|dec-[A-Za-z0-9]{8,40}|cons-\d{1,9})$/;
const TOKEN = /^[A-Za-z0-9._:/@+-]{1,96}$/;
const token = (v) => (typeof v === "string" && TOKEN.test(v) ? v : undefined);
const matching = (re) => (v) => (typeof v === "string" && re.test(v) ? v : null);
const jobId = matching(JOB_ID), requestId = matching(REQUEST_ID), targetId = matching(TARGET), workerId = matching(WORKER_ID);
// A role is recorded only when the candidate's registered role set contains it (ctx.roles); with no registry no name is recorded.
const roleOf = (name, roles) => (typeof name === "string" && roles?.has(name) ? name : undefined);
const fin = (v) => (Number.isFinite(v) ? v : undefined);
const usageOf = (u) => (u && typeof u === "object" ? { input: fin(u.input), output: fin(u.output), cacheRead: fin(u.cacheRead), cacheWrite: fin(u.cacheWrite), cost: fin(u.cost), turns: fin(u.turns), contextTokens: fin(u.contextTokens) } : undefined);
// The producer's abort provenance: a plain object whose OWN fields running/priorFailure are both booleans, reduced to exactly those two. Anything else (missing,
// array, inherited, non-boolean, partial) is undefined: never defaulted to false, and no other key or error body is ever carried.
const abortOf = (a) => {
	if (!a || typeof a !== "object" || Array.isArray(a)) return undefined;
	const p = Object.getPrototypeOf(a);
	if (p !== Object.prototype && p !== null) return undefined;
	const own = (k) => Object.hasOwn(a, k) && typeof a[k] === "boolean";
	return own("running") && own("priorFailure") ? { running: a.running, priorFailure: a.priorFailure } : undefined;
};
const resultOf = (r, i, roles) => ({
	position: Number.isInteger(r?.position) ? r.position : i, workerId: workerId(r?.workerId) ?? undefined, agent: roleOf(r?.agent, roles), exitCode: fin(r?.exitCode), stopReason: token(r?.stopReason),
	abort: abortOf(r?.abort), model: token(r?.model), modelTier: token(r?.modelTier), modelSlot: token(r?.modelSlot), usage: usageOf(r?.usage),
	phase1: r?.phase1 ? { taskId: token(r.phase1.taskId), attempts: fin(r.phase1.attempts), firstTurnPromptTokens: fin(r.phase1.firstTurnPromptTokens) ?? null, peakPromptTokens: fin(r.phase1.peakPromptTokens) ?? null, unpricedTurns: fin(r.phase1.unpricedTurns) } : undefined,
});
// A foreground child result: the same allowlisted identity/usage shape as a completion child, plus its error flag and bounded-by-the-runner error text. An agent name the registry does
// does not know is omitted and scrubbed from the error text (it is caller-supplied); numeric usage and the other diagnostics stay.
const foregroundResultOf = (r, i, roles) => {
	const base = resultOf(r, i, roles);
	const bad = typeof r?.agent === "string" && r.agent !== "" && base.agent === undefined ? r.agent : null;
	const text = (v) => (typeof v === "string" ? (bad ? v.split(bad).join("[unknown-role]") : v) : undefined);
	return { ...base, isError: r?.isError === true, errorMessage: text(r?.errorMessage), stderr: text(r?.stderr) };
};
const controlOf = (c) => (c && CONTROL_ACTIONS.has(c.action) ? { action: c.action, ...(targetId(c.target) ? { target: c.target } : {}) } : null);
const COMPLETION_STATES = new Set(["suppressed", "submitted", "submit_failed"]);
// Job ids seen at a prompt (receipt) or completion carry the task whose prompt showed them; an audit, diagnostic or close record is stamped from that map only, never guessed.
const stampTask = (ctx, id) => (typeof id === "string" && ctx.taskOf ? { taskId: ctx.taskOf(id) } : {});

// The extension's hidden entries (pi.appendEntry custom entries, never model context). An audit whose owner session is not this session is reported ignored, never counted.
function hiddenOf(entry, ctx) {
	const d = entry?.data;
	if (entry?.customType === TERMINAL_AUDIT) {
		if (!d || d.v !== 1 || !jobId(d.jobId)) return null;
		const owner = token(d.ownerSession) ?? null;
		if (ctx.session && owner && owner !== ctx.session) return { type: "audit_ignored", jobId: d.jobId, reason: "owner_mismatch" };
		return { type: "audit", jobKey: `${ctx.session ?? ""}/${d.jobId}`, jobId: d.jobId, ownerSession: owner, state: AUDIT_STATES.has(d.state) ? d.state : null, startedAt: fin(d.startedAt) ?? null, endedAt: fin(d.endedAt) ?? null,
			completionSuppressed: d.completionSuppressed === true, completion: COMPLETION_STATES.has(d.completion) ? d.completion : null, results: Array.isArray(d.results) ? d.results.map((r, i) => resultOf(r, i, ctx.roles)) : [], ...stampTask(ctx, d.jobId) };
	}
	if (entry?.customType === DELIVERY_DIAGNOSTIC) {
		if (!d || !DIAGNOSTIC_CODES.has(d.code) || !jobId(d.jobId)) return null;
		const owner = token(d.ownerSession) ?? null;
		if (ctx.session && owner && owner !== ctx.session) return { type: "audit_ignored", jobId: d.jobId, reason: "owner_mismatch" };
		return { type: "diagnostic", code: d.code, jobId: d.jobId, jobKey: `${ctx.session ?? ""}/${d.jobId}`, ...stampTask(ctx, d.jobId) };
	}
	return null;
}

// ctx: { at: () => task-relative ms | null, session: owning session id | null }. Offsets are on native events only.
export function normalise(ev, ctx = {}) {
	const stamp = (o) => (ctx.at ? { ...o, atMs: ctx.at() } : o);
	const key = (jobId) => (jobId === null ? null : `${ctx.session ?? ""}/${jobId}`);
	if (ev?.type === "message_end" && ev.message?.role === "assistant") {
		const m = ev.message;
		return { type: "assistant", message: { role: "assistant", usage: m.usage, provider: m.provider, model: m.model } };
	}
	if (ev?.type === "message_end" && ev.message?.role === "custom" && ev.message.customType === "subagent-completion") {
		const d = ev.message.details ?? {};
		const id = jobId(d.jobId);
		return stamp({ type: "completion", jobId: id, jobKey: key(id), session: ctx.session ?? null, state: AUDIT_STATES.has(d.state) ? d.state : null, results: Array.isArray(d.results) ? d.results.map((r, i) => resultOf(r, i, ctx.roles)) : [], ...(id && ctx.claim ? { taskId: ctx.claim(id) } : {}) });
	}
	// Notice state and ids only: the question, options, context and answer stay in the message.
	if (ev?.type === "message_end" && ev.message?.role === "custom" && ev.message.customType === "subagent-decision") {
		const d = ev.message.details ?? {};
		return stamp({ type: "decision", state: DECISION_STATES.has(d.state) ? d.state : null, requestId: requestId(d.requestId), jobId: jobId(d.jobId) });
	}
	if (ev?.type === "entry_appended" && ev.entry?.type === "custom") { const h = hiddenOf(ev.entry, ctx); return h ? stamp(h) : null; }
	if (ev?.type === "tool_execution_end" && ev.toolName === "subagent") {
		const d = ev.result?.details;
		return stamp({ type: "subagent", toolCallId: ev.toolCallId, isError: ev.isError === true || ev.result?.isError === true, text: textOf(ev.result), details: d && typeof d === "object" ? { ...d, roles: undefined, ...(Array.isArray(d.results) ? { results: d.results.map((r, i) => foregroundResultOf(r, i, ctx.roles)) } : {}) } : d, session: ctx.session ?? null, roles: Array.isArray(d?.roles) ? d.roles.map((n) => roleOf(n, ctx.roles)).filter(Boolean) : null, ...(Number.isInteger(d?.rolesInvalid) ? { rolesInvalid: d.rolesInvalid } : {}) });
	}
	// Tool name and outcome only (no arguments, no packet text); error text is kept only for a failed call. A control call adds its validated action and safe id.
	if (ev?.type === "tool_execution_end") {
		const text = textOf(ev.result);
		const base = { type: "tool", name: ev.toolName ?? null, isError: typeof ev.isError === "boolean" ? ev.isError : null, errorText: ev.isError === true && text ? text : null };
		if (ev.toolName !== "subagent_control") return base;
		const control = controlOf(ev.result?.details?.control);
		// A retrieved job result (action result on a job id): its child usage, allowlisted like a completion's. It is retrieval, never a launch or a delivery.
		const rs = ev.result?.details?.results;
		const retrieved = control?.action === "result" && jobId(control.target) && ev.isError !== true && Array.isArray(rs);
		return stamp({ ...base, control, ...(retrieved ? { session: ctx.session ?? null, controlResults: rs.map((r, i) => resultOf(r, i, ctx.roles)) } : {}) });
	}
	return null;
}

// The role names the session can legitimately dispatch: the candidate package's agents and the profile's user agents (file name = role name).
function registeredRoles(...dirs) {
	const names = new Set();
	for (const dir of dirs) { try { for (const f of fs.readdirSync(dir)) if (f.endsWith(".md")) names.add(f.slice(0, -3)); } catch { /* an absent directory registers nothing */ } }
	return names;
}

// Settlement tracking: a background receipt is pending until its completion; epoch counts changes so a wake-up is never lost between checks.
function track(state, n) {
	if (n?.type === "subagent" && n.details?.background === true && typeof n.details?.jobId === "string") {
		if (!state.jobTasks.has(n.details.jobId)) state.jobTasks.set(n.details.jobId, state.curTask ?? null);
		if (!state.completed.has(n.details.jobId)) {
			state.pending.set(n.details.jobId, { mode: n.details.mode ?? null });
			state.jobs.set(n.details.jobId, { jobId: n.details.jobId, roles: n.roles ?? null, mode: n.details.mode ?? null, receiptAtMs: n.atMs ?? null, lastEventAtMs: n.atMs ?? null, lastEvent: "receipt" });
		}
	} else if (n?.type === "completion" && n.jobId) {
		state.pending.delete(n.jobId);
		state.completed.add(n.jobId);
	} else return;
	state.epoch++;
	for (const wake of state.waiters.splice(0)) wake();
}

// The last native event that named a still-pending job (a control call on it or a decision of its worker), by task-relative offset. Unknown stays null.
function noteJobEvent(state, n) {
	const jobId = n?.type === "tool" && n.control ? n.control.target : n?.type === "decision" ? n.jobId : null;
	const j = jobId ? state.jobs.get(jobId) : null;
	if (!j) return;
	j.lastEventAtMs = n.atMs ?? null;
	j.lastEvent = n.type === "tool" ? `control:${n.control.action}` : `decision:${n.state ?? "unknown"}`;
}
// Every still-pending job with what is known of it, taken before anything is aborted. A missing value is null (not recorded), never zero.
const pendingSnapshot = (state) => [...state.pending.keys()].map((jobId) => { const j = state.jobs.get(jobId) ?? {}; return { jobId, roles: j.roles ?? null, mode: j.mode ?? null, receiptAtMs: j.receiptAtMs ?? null, lastEventAtMs: j.lastEventAtMs ?? null, lastEvent: j.lastEvent ?? null }; });

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
	// Wait phases on the task clock: idle (the main run is working) or completion (idle, waiting for a background worker's completion).
	const startedAtMs = state.at(); const phases = []; let phase = null; let phaseAt = null;
	const enter = (p) => { leave(); phase = p; phaseAt = state.at(); };
	const leave = () => { if (phase) { phases.push({ phase, startMs: phaseAt, endMs: state.at() }); phase = null; } };
	let lastPhase = null;
	for (;;) {
		const seen = state.epoch;
		enter("idle"); lastPhase = "idle";
		const idle = await race(state.session.waitForIdle(), left());
		if (idle.timedOut) { timedOut = true; break; }
		if (idle.error) throw idle.error;
		if (state.epoch !== seen) continue; // a completion arrived meanwhile: re-check idleness before deciding
		if (state.pending.size === 0) break;
		enter("completion"); lastPhase = "completion";
		const woke = await race(new Promise((resolve) => { if (state.epoch !== seen) resolve(); else state.waiters.push(resolve); }), left());
		if (woke.timedOut) { timedOut = true; break; }
	}
	const pendingJobs = [...state.pending.keys()];
	// Snapshot BEFORE the abort: what was pending and when it last did anything, so the abort cannot change the record.
	const snapshotAtMs = state.at(); const pending = pendingSnapshot(state);
	leave();
	const endedAtMs = state.at();
	// Timeout: stop the main's run now; closing the session then cancels and awaits every owning worker (nothing is snapshotted or scored meanwhile).
	if (timedOut) await race(state.session.abort?.(), state.limits?.shutdownGraceMs?.value ?? 0);
	return { settled: !timedOut && pendingJobs.length === 0, timedOut, pendingJobs, waitedMs: Date.now() - started, startedAtMs, endedAtMs, snapshotAtMs, lastPhase, phases, pending };
}

// Shutdown through the runtime; confirmed only when the extension's session_shutdown handlers (which await their workers) finished within the grace.
// Hidden entries (audit, diagnostic, ignored audit) of this session. The subscription saw most of them live; the session's own entries are read once more after the
// shutdown generation drained, so an entry whose event was missed is still found. Each entry counts once (by its entry id).
function ingestEntry(state, entry) {
	if (entry?.id !== undefined) { if (state.seenEntries.has(entry.id)) return null; state.seenEntries.add(entry.id); }
	const n = normalise({ type: "entry_appended", entry }, state.ctx());
	if (n) state.hidden.push(n);
	return n;
}
function collectHidden(state) {
	try { for (const e of state.session.sessionManager?.getEntries?.() ?? []) if (e?.type === "custom") ingestEntry(state, e); } catch { /* the live subscription remains the source */ }
	const of = (type) => state.hidden.filter((h) => h.type === type);
	return { audits: of("audit"), ignoredAudits: of("audit_ignored"), diagnostics: of("diagnostic") };
}

// budgetMs (the caller's remaining time) only ever tightens the configured grace: effective = min(grace, budgetMs); 0/negative/non-finite = expired (fail closed, no default).
// One abort/dispose operation per session (cached); a later call waits on it only for its own effective budget, so a stricter budget never waits for a longer cached one.
async function closeState(state, { budgetMs } = {}) {
	const started = Date.now();
	const pendingJobs = [...(state.pending?.keys() ?? [])];
	// A reviewer's resources must be the bytes it started with: a guidance, skill or SYSTEM edit during the review leaves the identity unstable (INCONCLUSIVE).
	const res = state.identity?.contract?.resources;
	if (res && state.recheck) { const end = state.recheck(); res.endResourcesSha256 = end.resourcesSha256; res.stable = end.resourcesSha256 === res.resourcesSha256 && end.effectivePromptSha256 === res.effectivePromptSha256; }
	// Abort and await idle first: the run (and any foreground child it owns) must be closed before shutdown is confirmed; runtime.dispose() only invalidates the session synchronously.
	state.closing ??= Promise.resolve().then(async () => { await state.session.abort?.(); await state.runtime.dispose(); });
	const done = state.closing;
	const configured = state.limits?.shutdownGraceMs?.value;
	const cap = budgetMs === undefined ? undefined : (Number.isFinite(budgetMs) ? Math.max(0, budgetMs) : 0);
	const grace = cap === undefined ? configured : configured === undefined ? cap : Math.min(configured, cap);
	// Neither a configured grace nor a caller budget: nothing bounds the wait and no default is invented, so the close is treated as expired (unconfirmed unless already finished).
	const r = await race(done, grace ?? 0);
	const error = r.error ? String(r.error.message ?? r.error).slice(0, 300) : null;
	// Collected after the awaited shutdown and before the state is forgotten; the live subscription stays attached until here.
	const hidden = collectHidden(state);
	state.unsubscribe?.();
	// pi.sendMessage returns void and Pi reports an async delivery failure only through the extension error channel, with no job id: counted here, never attributed or quoted.
	const sendMessageErrors = state.extensionErrors.filter((e) => e.event === "send_message").length;
	const jobTasks = Object.fromEntries([...state.jobTasks].map(([id, t]) => [`${state.sessionId ?? ""}/${id}`, t]));
	return { confirmed: !r.timedOut && !r.error, ms: Date.now() - started, jobTasks, sendMessageErrors, pendingJobs, pendingKeys: pendingJobs.map((id) => `${state.sessionId ?? ""}/${id}`), error, ...hidden, ...(state.abortSnapshot ? { abortSnapshot: state.abortSnapshot } : {}) };
}

// Pi 1.4.0 gives createAgentSession and loader.reload() no AbortSignal, so an open cannot be interrupted midway: the task signal is checked at every await
// boundary and whatever a late factory produced is disposed through the lifecycle owner. Compaction and runs have real cancellation (abortCompaction, abort).
// A dispose that throws (sync) or rejects (async) is an unconfirmed shutdown; its error text is dropped, never propagated.
const disposedOk = async (dispose) => { try { await dispose(); return true; } catch { return false; } };
const cancelled = (what) => Object.assign(new Error(`${what} cancelled: the task deadline passed`), { cancelled: true });
const live = (signal, what) => { if (signal?.aborted) throw cancelled(what); };

// topology: test-boundary injection of the agent topology proof ({runtime, cwd, agentDir} -> result). The default is the REAL check (native discovery, installed SDK);
// there is no skip option, and a missing proof is never assumed to pass.
export function createPiSdkAdapter({ piPackageRoot, loadPi, clock = () => performance.now(), topology } = {}) {
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
		// Do the canonical package roles resolve as PACKAGE roles for the exact extension this runtime loads, at this cwd? The ambient SDK getAgentDir is what the native
		// child sees (no environment swap). Throws when the proof cannot be produced (no explicit installed SDK root, no registerHooks); never returns a guessed ok.
		async agentTopology({ runtime, cwd }) {
			const entry = runtimeExtensionPaths(runtime)[0];
			const agentDir = (await pi()).getAgentDir();
			if (topology) return topology({ runtime, cwd, agentDir });
			const native = await loadNativeAgents({ extensionEntry: entry, piPackageRoot });
			return checkAgentTopology({ candidateRoot: runtime.root, extensionEntry: entry, discover: native.discoverAgents, resolveTier: native.resolveModelTier, cwd, agentDir });
		},
		// The profile default main model and thinking level, read from the SDK settings registry (never chosen by the benchmark).
		async resolveMainSpec({ candidateRoot }) {
			const m = await pi();
			const settings = m.SettingsManager.create(candidateRoot, m.getAgentDir());
			const provider = settings.getDefaultProvider();
			const id = settings.getDefaultModel();
			if (!provider || !id) throw new Error("no default model in the profile settings (defaultProvider/defaultModel); refusing to choose one");
			return { model: `${provider}/${id}`, fallbacks: [], thinking: settings.getDefaultThinkingLevel() ?? null, source: "profile default (settings defaultProvider/defaultModel/defaultThinkingLevel)" };
		},
		async openSession({ cwd, role, compactionEnabled, taskId, runtime, roleSpec, limits, signal, timeline, onEvent }) {
			live(signal, "session open");
			const m = await pi();
			live(signal, "session open");
			if (!roleSpec) throw new Error(`no configured ${role} identity for task ${taskId}`);
			// The main session runs the candidate extension at the REPLAY cwd (a nearer project agents directory can override a canonical role): proven before any
			// ModelRuntime, loader, factory or prompt exists.
			if (role !== "review") {
				let proof;
				try { proof = await this.agentTopology({ runtime, cwd }); } catch (e) { const reason = safeTopologyReason(e); throw Object.assign(new Error(`agent topology could not be proven (topology_check_failed${reason ? `: ${TOPOLOGY_REASONS[reason]}` : ""})`), { infrastructure: true, kind: "agent_topology", ...(reason ? { reason } : {}) }); }
				if (proof?.ok !== true) throw Object.assign(new Error(`agent topology blocks this session (the canonical package roles do not all resolve as package roles): ${describeProblems(proof) || "no proof"}`), { infrastructure: true, kind: "agent_topology", topology: proof ?? null });
			}
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
			live(signal, "session open");
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
			if (typeof m.AgentSessionRuntime !== "function") { const ok = await disposedOk(() => session.dispose()); throw Object.assign(new Error("the Pi SDK exports no AgentSessionRuntime; refusing to open a session whose shutdown cannot be confirmed"), { infrastructure: true, kind: "lifecycle_unavailable", unconfirmed: !ok }); }
			const services = { cwd, agentDir: m.getAgentDir(), modelRuntime, settingsManager, resourceLoader: loader, diagnostics: [] };
			const lifecycle = new m.AgentSessionRuntime(session, services, async () => { throw new Error("session replacement is not supported by the benchmark"); });
			// A session the factory returned after the cutoff is shut down through the runtime (extension workers awaited) and never bound or prompted.
			if (signal?.aborted) { const ok = await disposedOk(() => lifecycle.dispose()); throw Object.assign(cancelled("session open"), { unconfirmed: !ok }); }
			const state = { session, runtime: lifecycle, role, taskId, buffer: [], limits, pending: new Map(), completed: new Set(), epoch: 0, waiters: [], extensionErrors: [], jobs: new Map(), hidden: [], seenEntries: new Set(), jobTasks: new Map(), curTask: taskId ?? null, roles: registeredRoles(path.join(runtime.root, "agent", "agents"), path.join(m.getAgentDir(), "agents")), timeline: timeline ?? null, onEvent: onEvent ?? null, abortSnapshot: null, requested: new Set() };
			// Task-relative offsets on the injected monotonic clock; null when no task timeline was supplied (not recorded, never zero). sessionId is the owner key of every audit.
			state.at = () => (state.timeline ? clock() - state.timeline.startedAt : null);
			state.sessionId = session.sessionManager?.getSessionId?.() ?? null;
			state.ctx = () => ({ at: state.at, session: state.sessionId, roles: state.roles, taskOf: (id) => state.jobTasks.get(id) ?? null, claim: (id) => state.jobTasks.get(id) ?? null });
			await session.bindExtensions({ onError: (e) => state.extensionErrors.push({ event: typeof e?.event === "string" && /^[a-z][a-z0-9_]{0,39}$/.test(e.event) ? e.event : null, error: null }) });
			if (signal?.aborted) { const c = await closeState(state); throw Object.assign(cancelled("session open"), { unconfirmed: c.confirmed === false }); }
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
			state.unsubscribe = session.subscribe((ev) => {
				// A subagent call started but not yet ended has no receipt/result: it is REQUESTED (unknown outcome), never a launch.
				if (ev?.type === "tool_execution_start" && ev.toolName === "subagent") state.requested.add(ev.toolCallId);
				else if (ev?.type === "tool_execution_end" && ev.toolName === "subagent") state.requested.delete(ev.toolCallId);
				if (ev?.type === "entry_appended") { if (ev.entry?.id !== undefined) { if (state.seenEntries.has(ev.entry.id)) return; state.seenEntries.add(ev.entry.id); } }
				const n = normalise(ev, state.ctx());
				if (!n) return;
				if (n.type === "audit" || n.type === "audit_ignored" || n.type === "diagnostic") state.hidden.push(n);
				state.buffer.push(n); track(state, n); noteJobEvent(state, n);
				if (n.type !== "assistant" && !(n.type === "tool" && !n.control)) { try { state.onEvent?.(n); } catch { /* progress is best effort */ } }
			});
			return state;
		},
		async startContext(state) {
			const s = state.session;
			const usage = s.getContextUsage?.();
			return { contextTokens: usage?.tokens ?? null, contextWindow: usage?.contextWindow ?? null, systemPromptChars: s.systemPrompt.length, activeTools: s.getActiveToolNames(), messageCount: s.messages.length };
		},
		// The main session's prompt returns only once its round is settled (idle, no pending background job); a reviewer has no workers to wait for.
		async prompt(state, text, { settle, budgetMs, signal, timeline, onEvent, taskId } = {}) {
			live(signal, "prompt");
			if (taskId !== undefined) state.curTask = taskId;
			if (timeline) state.timeline = timeline;
			if (onEvent) state.onEvent = onEvent;
			// The task signal aborts the real run (session.abort awaits idle); a model call is never started after the cutoff.
			// What was pending is recorded first, so the abort cannot change it.
			const onAbort = () => { state.abortSnapshot ??= { atMs: state.at(), pending: pendingSnapshot(state) }; void Promise.resolve(state.session.abort?.()).catch(() => {}); };
			signal?.addEventListener("abort", onAbort, { once: true });
			try { return await runPrompt(state, text, { settle, budgetMs }); } finally { signal?.removeEventListener("abort", onAbort); }
		},
		// What this session has already observed in the current prompt, read-only (no SDK call, no message to the model); safe structured events only.
		observed(state) { return { events: [...state.buffer], pending: pendingSnapshot(state), requestedUnacked: state.requested.size }; },
		async compact(state, { signal } = {}) {
			live(signal, "compaction");
			// abortCompaction() is the supported cancel; compact() then settles (rejects) and is awaited here.
			const onAbort = () => { try { state.session.abortCompaction?.(); } catch { /* the awaited compact() reports the outcome */ } };
			signal?.addEventListener("abort", onAbort, { once: true });
			try {
				const r = await state.session.compact();
				return { tokensBefore: r.tokensBefore, usage: r.usage };
			} finally { signal?.removeEventListener("abort", onAbort); }
		},
		async closeSession(state, opts) { return closeState(state, opts); },
	};
}

// One main or reviewer prompt: the run is bounded by budgetMs (aborted and awaited within the grace on expiry), then the round settles.
async function runPrompt(state, text, { settle, budgetMs }) {
	state.buffer = [];
	const started = Date.now();
	if (budgetMs !== undefined) {
		// The task deadline reaches the model run itself: on expiry the run is aborted (awaited within the grace), never merely abandoned.
		const r = await race(state.session.prompt(text), budgetMs);
		if (r.error) throw r.error;
		if (r.timedOut) {
			const snapshotAtMs = state.at(); const pending = pendingSnapshot(state);
			await race(state.session.abort?.(), state.limits?.shutdownGraceMs?.value ?? 0);
			return { events: state.buffer, text: "", settlement: { settled: false, timedOut: true, budgetExhausted: true, pendingJobs: [...state.pending.keys()], waitedMs: Date.now() - started, startedAtMs: null, endedAtMs: state.at(), snapshotAtMs, lastPhase: "prompt", phases: [], pending } };
		}
	} else await state.session.prompt(text);
	const remaining = budgetMs === undefined ? undefined : budgetMs - (Date.now() - started);
	// Under one whole ms left there is nothing to settle in: never a fresh 1 ms grant beyond the budget.
	if (remaining !== undefined && remaining < 1) return { events: state.buffer, text: "", settlement: { settled: false, timedOut: true, budgetExhausted: true, pendingJobs: [...state.pending.keys()], waitedMs: Date.now() - started, startedAtMs: null, endedAtMs: state.at(), snapshotAtMs: state.at(), lastPhase: "prompt", phases: [], pending: pendingSnapshot(state) } };
	const settleMs = remaining === undefined ? settle?.timeoutMs : Math.min(settle?.timeoutMs ?? budgetMs, remaining);
	const settlement = state.role === "main" ? await settleRound(state, settleMs) : null;
	return { events: state.buffer, text: state.session.getLastAssistantText() ?? "", settlement };
}
