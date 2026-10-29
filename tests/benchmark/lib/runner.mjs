// Benchmark runner: fixed-order manifest, three session policies, per-task accounting.
// It drives an injected adapter (Pi SDK or synthetic) and a workspace; all session creation goes through that adapter.
import { runAcceptanceAsync } from "./acceptance.mjs";
import { validateManifest, manifestDigest } from "./manifest.mjs";
import { addUsage, addWorkerUsage, addJobUsage, newJob, observeJob, markUnknown, emptyLedger, ledgerTotals, addLedgers, sumCosts } from "./usage.mjs";
import { evaluatorOf, summarizeEvaluators } from "./evaluator.mjs";
import { JOB_ID } from "./sdk-adapter.mjs";
import { TOPOLOGY_METHOD, describeProblems } from "./topology.mjs";

// v2: each reviewer cycle records its effective evaluator (compare requires it); totals.evaluator summarises it. v1 results are not comparable.
// v3: method validity (infrastructure and methodinvalid stops, delegation and main diagnostics, per-round held-out baseline). v2 results are not comparable.
// v5: per-round telemetry, cumulative per-task writer rule (classifyRound), and a recorded measurement exclusion policy for generated tool state. v4 results are not comparable.
// v4: background receipts, refusals and completions are distinct; worker usage is counted once from completions; rounds settle before any snapshot; shutdown is confirmed. v3 results are not comparable.
// v6: one monotonic task deadline (config.limits.taskTimeoutMs, grace reserved inside), budget_exhausted tasks and the unfinished run status; task-relative native timeline, structured
// receipt roles, hidden terminal audits folded into the worker ledger (total null + known subtotal + unresolved ids when any part is unknown). v5 results are not comparable.
// Job identity is the owning session plus the native job id; each worker result keeps its position, so duplicate roles and reused job ids never merge.
const keyOf = (session, jobId) => `${session ?? ""}/${jobId}`;
// Run-level execution ownership (not task-local): every background job belongs to the task whose round first showed it (receipt or completion), whichever task later
// receives its completion, audit or close record. Keys are namespaced by the session object, so the same job id in two fresh sessions is two jobs. A record of a job no
// task can be proven to own is never charged to the current task: it is kept as an explicitly unattributed unknown.
let sessionSeq = 0;
const sessionNs = new WeakMap();
const nsOf = (session) => { if (!session || typeof session !== "object") return "0"; if (!sessionNs.has(session)) sessionNs.set(session, String(++sessionSeq)); return sessionNs.get(session); };
const sessionUsers = new WeakMap(); // session object -> task ids that prompted it
const sendErrorsFolded = new WeakMap(); // session object -> adapter send_message error count already folded
function createRegistry() {
	const owners = new Map(); const tasks = new Map(); const orphan = emptyLedger("worker"); const orphans = []; const orphanJobs = new Map();
	const registry = {
		orphan, orphans, tasks,
		enroll(taskId, rec, raw) { tasks.set(taskId, { rec, raw }); },
		ownerOf: (ns, key) => owners.get(`${ns}|${key}`) ?? null,
		knows: (taskId) => tasks.has(taskId),
		claim(ns, key, taskId) {
			const k = `${ns}|${key}`;
			if (!owners.has(k)) { owners.set(k, taskId); tasks.get(taskId).raw.jobs.set(k, newJob(key)); }
			return owners.get(k);
		},
		// One observation of a job, merged into the owning task's job (never summed) and its record refreshed when that task already finished.
		observe(ns, key, taskId, obs, { completion = false, partial = false } = {}) {
			const owner = registry.claim(ns, key, taskId);
			const t = tasks.get(owner); const job = t.raw.jobs.get(`${ns}|${key}`);
			observeJob(job, obs, { partial });
			if (completion) job.completionSeen = true;
			if (obs.type === "audit") noteHidden(t.rec, { audits: [obs] });
			registry.refresh(owner);
			return owner;
		},
		// The record's known child usage is kept (never any task's); the run total stays unknown because the owner is.
		unattributed(key, reason, what, obs) {
			markUnknown(orphan, key, reason);
			if (!orphans.some((o) => o.jobKey === key && o.kind === what)) orphans.push({ jobKey: key, kind: what });
			if (Array.isArray(obs?.results) && obs.results.length) { if (!orphanJobs.has(key)) orphanJobs.set(key, newJob(key)); observeJob(orphanJobs.get(key), obs, { partial: true }); }
		},
		orphanLedger() { const l = addLedgers(emptyLedger("worker"), orphan); for (const j of orphanJobs.values()) addJobUsage(l, j); return l; },
		refresh(taskId) {
			const t = tasks.get(taskId);
			if (!t?.rec.worker) return; // the task is still running; its own finalization computes it
			t.rec.worker = ledgerTotals(workerLedger(t.raw));
			const seen = new Set([...t.raw.jobs.values()].filter((j) => j.completionSeen).map((j) => j.key));
			for (const a of t.rec.delegation.audits) a.completionObserved = seen.has(a.jobKey);
		},
	};
	return registry;
}
// A task's worker ledger: its foreground results plus every background job it owns. Built fresh each time, so a late record of an owned job replaces rather than adds.
function workerLedger(raw) {
	const l = addLedgers(emptyLedger("worker"), raw.worker);
	for (const job of raw.jobs.values()) addJobUsage(l, job);
	return l;
}
export const RESULT_SCHEMA_VERSION = "harness-benchmark-result/6";
// No literal rework default: config.maxReworkRounds is resolved from roles.json (general-worker) or a run flag, with its source.
export const MODES = {
	fresh: { sessionPolicy: "new-per-task", compaction: "none" },
	"long-fixed": { sessionPolicy: "shared-fixed-order", compaction: "none" },
	"long-compacted": { sessionPolicy: "shared-fixed-order", compaction: "manual-between-tasks" },
};
const TAIL = 2000;
// Long modes only: after a confirmed deadline cut the faithful in-memory session history (aborted tail included, no session header) seeds a replacement session with a new id.
// Recorded in config.continuation; compare requires the same policy on both long sides. A fresh run has no such field (not applicable).
export const CONTINUATION_POLICY = "faithful-history-restore/1";

// Reviewer output counts only when it contains the structured lines; anything else is unavailable, never zero findings.
export function parseReviewOutput(text) {
	const findings = [];
	let none = false;
	for (const line of String(text ?? "").split(/\r?\n/)) {
		const m = /^\s*FINDING (critical|high|medium|low):\s*(.+?)\s*$/.exec(line);
		if (m) findings.push({ severity: m[1], text: m[2] });
		else if (/^\s*NO FINDINGS\s*$/.test(line)) none = true;
	}
	if (findings.length === 0 && !none) return { status: "unavailable", findings: [], highCount: null };
	return { status: "ok", findings, highCount: findings.filter((f) => f.severity === "critical" || f.severity === "high").length };
}

// artifacts: the exact absolute task-owned {scratch, evidence} directories (outside the workspace); without them the older blanket wording is kept.
const artifactLine = (a) => `Implementation and tests only in this workspace; task-owned scratch/evidence ONLY at exactly these absolute assigned paths: scratch ${a.scratch}; evidence ${a.evidence}. Anything else created inside the workspace counts as an unrelated change.`;
export function taskPrompt(task, artifacts) {
	return [
		`Harness task ${task.id} (${task.tier}, ${task.category}).`,
		`Goal: ${task.brief ?? task.subject}`,
		`Edit only these files: ${task.allowedFiles.join(", ")}.`,
		artifacts ? artifactLine(artifacts) : "Work only inside this workspace.",
		"Finish with a short statement of what you changed.",
	].join("\n");
}

export function reworkPrompt(task, round, gate, review, unrelated, artifacts) {
	const lines = [`REWORK round ${round} for ${task.id}: the change is not accepted yet.`];
	if (!gate.accepted) lines.push(`Acceptance failed (${gate.reason ?? "tests did not pass"}). Output tail:\n${String(gate.outputTail ?? "").slice(-TAIL)}`);
	if (unrelated.length) lines.push(`Revert changes outside the allowed files: ${unrelated.join(", ")}.`);
	const high = review.status === "ok" ? review.findings.filter((f) => f.severity === "critical" || f.severity === "high") : [];
	if (high.length) lines.push(`Reviewer findings to fix:\n${high.map((f) => `- ${f.severity}: ${f.text}`).join("\n")}`);
	lines.push(`Edit only these files: ${task.allowedFiles.join(", ")}.`);
	if (artifacts) lines.push(artifactLine(artifacts));
	return lines.join("\n");
}

export function reviewPrompt(task, changed, gate) {
	return [
		`REVIEW ${task.id}: read-only review of a harness change. Do not edit files.`,
		`Goal: ${task.brief ?? task.subject}`,
		`Edit scope (the only files the task may change): ${task.allowedFiles.join(", ")}.`,
		`Changed files: ${changed.join(", ") || "none"}`,
		`Acceptance: ${gate.accepted ? "passed" : "not passed"}`,
		"Output one line per finding in the form: FINDING <critical|high|medium|low>: <text>",
		"If there are no findings, output the single line: NO FINDINGS",
	].join("\n");
}

// A rework cap is {value, source}: the value is a whole number >= 0 and the source says where it came from (never silent).
const assertCap = (cap, name) => {
	if (!cap || typeof cap !== "object" || !Number.isInteger(cap.value) || cap.value < 0) throw new Error(`${name} must be {value: whole number >= 0, source}`);
	if (typeof cap.source !== "string" || cap.source.trim() === "") throw new Error(`${name} source is required`);
};

// A time limit is a whole number of milliseconds > 0 with a source; there is no literal fallback (the default comes from roles.json).
const assertLimit = (cap, name) => {
	assertCap(cap, name);
	if (cap.value < 1) throw new Error(`${name} must be a whole number of milliseconds > 0`);
};

const contextOf = (raw) => {
	if (!raw) return { measured: false };
	return { measured: typeof raw.contextTokens === "number", contextTokens: raw.contextTokens ?? null, contextWindow: raw.contextWindow ?? null, systemPromptChars: raw.systemPromptChars ?? null, activeTools: raw.activeTools ?? [], messageCount: raw.messageCount ?? null };
};

// Diagnostic text is redacted of credentials first, then bounded to the cap (tail keeps the end, e.g. stderr). Reasoning and packet text are never stored.
const SECRET_PATTERNS = [
	[/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, "[REDACTED KEY]"],
	[/\bBearer\s+[A-Za-z0-9._~+\/=-]+/gi, "Bearer [REDACTED]"],
	[/(\bAuthorization\s*:\s*Basic\s+)[A-Za-z0-9+\/=._~-]+/gi, "$1[REDACTED]"],
	[/(\b[a-z][a-z0-9+.-]*:\/\/)[^\s\/@]+(?::[^\s\/@]*)?@/gi, "$1[REDACTED]@"],
	[/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, "[REDACTED]"],
	[/(\b[A-Za-z0-9_]*(?:api[_-]?key|token|secret|password|passwd|credential)[A-Za-z0-9_]*\s*[:=]\s*)\S+/gi, "$1[REDACTED]"],
	[/("[A-Za-z0-9_-]*(?:api[_-]?key|token|secret|password|passwd|credential)[A-Za-z0-9_-]*"\s*:\s*)"(?:[^"\\]|\\.)*"/gi, '$1"[REDACTED]"'],
	[/\b(?:sk|pk|ghp|gho|ghu|ghs|ghr|github_pat|xox[abprs])[-_][A-Za-z0-9_-]{8,}/g, "[REDACTED]"],
];
export function boundedDiagnostic(value, limit, { tail = false } = {}) {
	if (value === undefined || value === null) return { text: null, truncated: false };
	let s = String(value);
	for (const [re, rep] of SECRET_PATTERNS) s = s.replace(re, rep);
	if (s.length <= limit) return { text: s, truncated: false };
	return { text: tail ? s.slice(s.length - limit) : s.slice(0, limit), truncated: true };
}

// Thrown when a main round is invalid: the run stops before review, rework or the next task.
class RoundStop extends Error {
	constructor(info) { super(`${info.class}: ${info.kind}`); this.info = info; }
}
// The task deadline's work cutoff passed during a stage; the owned session is then closed (abort and drain) and nothing further is scored.
class BudgetStop extends Error {
	constructor(stage) { super(`task budget exhausted during ${stage}`); this.stage = stage; }
}

// Resolves {value}, {error} or {timedOut: true} once ms elapse (timer always cleared). A timeout is not cancellation: callers abort and drain the owner.
const race = (promise, ms) => new Promise((resolve) => {
	const timer = setTimeout(() => resolve({ timedOut: true }), Math.max(0, ms));
	Promise.resolve(promise).then((value) => { clearTimeout(timer); resolve({ value }); }, (error) => { clearTimeout(timer); resolve({ error }); });
});
// Owns every operation the runner abandoned at the cutoff. A lost Promise.race does not stop the underlying work, so each abandoned promise is kept here;
// a value it produces late is disposed (late), and drain() waits for it only until the task deadline. An operation still pending then is reported (never
// "closed"): the shutdown is unconfirmed and nothing further runs. A late rejection is swallowed after it settles.
function createOwner() {
	const ops = []; const noted = [];
	return {
		track(name, promise, late) {
			const op = { name, settled: false, unconfirmed: false };
			op.done = Promise.resolve(promise).then(async (value) => { try { const r = await late?.(value); if (r?.confirmed === false) op.unconfirmed = true; } catch { op.unconfirmed = true; } }, (e) => { if (e?.unconfirmed === true) op.unconfirmed = true; }).finally(() => { op.settled = true; });
			ops.push(op);
		},
		note: (name) => { noted.push(name); },
		async drain(ms) {
			await race(Promise.all(ops.map((o) => o.done)), ms);
			return [...ops.filter((o) => !o.settled || o.unconfirmed).map((o) => o.name), ...noted];
		},
	};
}
// A subprocess timeout must be a whole number of milliseconds (the monotonic clock is fractional).
const wholeMs = (ms) => Math.max(1, Math.floor(ms));
// Task budget precedence: manifest task override > run limit. The winning source is recorded.
const taskBudgetOf = (task, limits) => (task.taskTimeoutMs !== undefined ? { value: task.taskTimeoutMs, source: `manifest task ${task.id}` } : limits.taskTimeoutMs);

const WRITE_TOOLS = ["edit", "write"];

// Each child result of one subagent call or background completion: role, outcome and bounded diagnostics. A child with no assistant turn is a failed
// attempt, not a measured workload. terminal: the job itself ended failed or aborted, an actual terminal worker failure (never a quality score).
// mainCancel: this job's SUCCESSFUL main cancel (a started job, aborted before its completion). Only the exact abort-kill shape is exempt; it is labelled
// "cancelled-by-main" (never a measured writer, never infrastructure). Exempt only with the producer's attestation abort.running === true and abort.priorFailure === false (the
// abort diagnostic is non-empty for every aborted child and absent fields prove nothing). Missing/malformed provenance, any other exit code or a never-started child stays a terminal failure.
function launchRecords(results, limit, { terminal = false, jobId = null, mainCancel = false } = {}) {
	const list = Array.isArray(results) ? results : [];
	if (list.length === 0) return [{ agent: null, status: "unreported", turns: null, jobId }];
	return list.map((r) => {
		const turns = Number.isFinite(r?.usage?.turns) ? r.usage.turns : null;
		// A child that errored, exited nonzero or stopped by error/abort is a terminal failure whatever it was charged for; usage is still counted once by the caller.
		const byMain = mainCancel && turns > 0 && r?.exitCode === 1 && r?.stopReason === "aborted" && r?.abort?.running === true && r?.abort?.priorFailure === false;
		const failed = terminal || r?.isError === true || (Number.isInteger(r?.exitCode) && r.exitCode !== 0) || r?.stopReason === "error" || r?.stopReason === "aborted";
		return {
			agent: typeof r?.agent === "string" ? r.agent : null,
			status: turns === null ? "unreported" : turns === 0 ? "no-child-turn" : byMain ? "cancelled-by-main" : failed ? "terminal-failure" : "measured",
			turns, exitCode: Number.isInteger(r?.exitCode) ? r.exitCode : null,
			stopReason: typeof r?.stopReason === "string" ? r.stopReason : null,
			errorMessage: boundedDiagnostic(r?.errorMessage, limit).text,
			stderrTail: boundedDiagnostic(r?.stderr, limit, { tail: true }).text,
			model: typeof r?.model === "string" ? r.model : null,
			modelTier: r?.modelTier ?? null, modelSlot: r?.modelSlot ?? null, jobId,
		};
	});
}

// A subagent call is one of: a background receipt (pending until its completion), a refusal (an error with no launch), results (foreground), or unreported.
export function callKind(ev) {
	const d = ev?.details;
	if (d?.background === true && typeof d?.jobId === "string") return "receipt";
	if (Array.isArray(d?.results) && d.results.length > 0) return "results";
	if (ev?.isError === true) return "refused";
	return "unreported";
}

// Model-chosen tool names are data: look up and create only OWN records (defineProperty, so "__proto__"/"constructor"/"toString" never hit inherited members or the prototype setter).
const ownTool = (tools, name) => (Object.hasOwn(tools, name) ? tools[name] : Object.defineProperty(tools, name, { value: { calls: 0, errors: 0 }, enumerable: true, writable: true, configurable: true })[name]);

// One main round from its own events: assistant turns, tool names, counts and errors (never arguments), subagent receipts/refusals/completions and launches.
function observeRound(events, limit) {
	const tools = {}; const launches = []; const receipts = []; const refusals = []; const completed = new Set(); const completedKeys = new Set(); const timeline = []; const audits = []; const diagnostics = []; const ignoredAudits = []; const cancelled = new Set(); const receiptIds = new Set(); let assistantTurns = 0;
	const at = (ev) => (Number.isFinite(ev?.atMs) ? ev.atMs : null);
	for (const ev of events ?? []) {
		if (ev?.type === "assistant") assistantTurns++;
		else if (ev?.type === "tool") {
			const t = ownTool(tools, ev.name);
			t.calls++;
			if (ev.isError) { t.errors++; const e = boundedDiagnostic(ev.errorText, limit).text; if (e !== null && t.firstError === undefined) t.firstError = e; }
			// A cancel counts only when it succeeded, named a safe job id, and came BEFORE that job's completion (events are in order).
			// It also needs this job's receipt already seen (a cancel before the receipt can never match).
			if (ev.control?.action === "cancel" && ev.isError === false && typeof ev.control.target === "string" && receiptIds.has(ev.control.target)) cancelled.add(ev.control.target);
			if (ev.control) timeline.push({ type: "control", action: ev.control.action, target: ev.control.target ?? null, atMs: at(ev) });
		} else if (ev?.type === "subagent") {
			const kind = callKind(ev);
			// Only the adapter's registry-validated roles; the raw details.roles is untrusted caller text and is never read here. rolesInvalid is a count.
			const roles = Array.isArray(ev.roles) ? ev.roles : null;
			if (kind === "receipt") { receiptIds.add(ev.details.jobId); receipts.push({ jobId: ev.details.jobId, mode: typeof ev.details.mode === "string" ? ev.details.mode : null, roles, ...(Number.isInteger(ev.rolesInvalid) ? { rolesInvalid: ev.rolesInvalid } : {}), key: keyOf(ev.session, ev.details.jobId), atMs: at(ev) }); timeline.push({ type: "receipt", jobId: ev.details.jobId, roles, atMs: at(ev) }); }
			else if (kind === "results") { launches.push(...launchRecords(ev.details.results, limit)); timeline.push({ type: "foreground", roles, atMs: at(ev) }); }
			else if (kind === "refused") {
				// A refusal that named a role the registry does not know quotes untrusted caller text: only the count is kept, never the text (the redactor cannot know what a name is).
				const invalid = Number.isInteger(ev.rolesInvalid) && ev.rolesInvalid > 0 ? ev.rolesInvalid : 0;
				refusals.push(invalid ? { text: null, rolesInvalid: invalid, reason: "unknown_role" } : { text: boundedDiagnostic(ev.text, limit).text }); timeline.push({ type: "refusal", atMs: at(ev) }); }
			else launches.push(...launchRecords([], limit));
		} else if (ev?.type === "decision") timeline.push({ type: "decision", state: ev.state ?? null, requestId: ev.requestId ?? null, jobId: ev.jobId ?? null, atMs: at(ev) });
		else if (ev?.type === "audit") { audits.push(ev); timeline.push({ type: "audit", jobId: ev.jobId ?? null, state: ev.state ?? null, atMs: at(ev) }); }
		else if (ev?.type === "diagnostic") { diagnostics.push(ev); timeline.push({ type: "diagnostic", code: ev.code, jobId: ev.jobId ?? null, atMs: at(ev) }); }
		else if (ev?.type === "audit_ignored") ignoredAudits.push({ jobId: ev.jobId ?? null, reason: ev.reason ?? null });
		else if (ev?.type === "completion") {
			completed.add(ev.jobId); completedKeys.add(ev.jobKey ?? keyOf(ev.session, ev.jobId));
			timeline.push({ type: "completion", jobId: ev.jobId ?? null, state: ev.state ?? null, atMs: at(ev) });
			launches.push(...launchRecords(ev.results, limit, { terminal: ev.state === "failed" || ev.state === "aborted", jobId: ev.jobId ?? null, mainCancel: ev.state === "aborted" && cancelled.has(ev.jobId) && receiptIds.has(ev.jobId) }));
		}
	}
	const pendingJobs = [...new Set(receipts.map((r) => r.jobId))].filter((id) => !completed.has(id));
	const pendingKeys = [...new Set(receipts.map((r) => r.key))].filter((k) => !completedKeys.has(k));
	return { assistantTurns, tools, launches, receipts: receipts.map(({ key, ...r }) => ({ ...r, completed: completed.has(r.jobId) })), refusals, pendingJobs, pendingKeys, timeline, audits, diagnostics, ignoredAudits };
}

// Method validity of one round, in order. Infrastructure (a launch with no child turn, or no assistant turn) stops the run and nothing is scored.
// A direct main edit or write, or no measured launch of the expected writer, is methodinvalid: it stops before review and never scores as success.
// Other launches (for example debugger) are optional and recorded with their actual role.
// The writer is required once per TASK: cumulativeWriterLaunches (measured expected-writer launches so far, this round included) lets a rework round without a new
// writer stay valid after an earlier one; omitted, only this round counts. Round 0 has no earlier launches, so the first-round guard is unchanged.
export function classifyRound(diag, expectedWriter, { cumulativeWriterLaunches } = {}) {
	const failed = diag.launches.find((l) => l.status !== "measured" && l.status !== "cancelled-by-main");
	if (failed) return { class: "infrastructure", kind: "launch_failed", agent: failed.agent, launchStatus: failed.status };
	// A receipt never matched by its completion, or a settlement that timed out, means a worker may still be running: nothing is snapshotted, reviewed or scored.
	const pending = [...new Set([...diag.pendingJobs, ...(diag.settlement?.pendingJobs ?? [])])];
	if (pending.length || diag.settlement?.settled === false) return { class: "infrastructure", kind: "background_unsettled", pendingJobs: pending, timedOut: diag.settlement?.timedOut === true };
	if (diag.assistantTurns === 0) return { class: "infrastructure", kind: "no_assistant_turn" };
	const writes = WRITE_TOOLS.reduce((s, n) => s + (diag.tools[n]?.calls ?? 0), 0);
	if (writes > 0) return { class: "methodinvalid", kind: "direct_main_write", writes };
	if (!(cumulativeWriterLaunches > 0) && !diag.launches.some((l) => l.agent === expectedWriter && l.status === "measured")) return { class: "methodinvalid", kind: "missing_delegation", expectedWriter, launchedAgents: [...new Set(diag.launches.map((l) => l.agent))] };
	return null;
}

// Records one round on the task: tool counts, bounded final text, launch outcomes (with their round) and the writer count.
function noteRound(rec, diag, round, text, limit, expectedWriter, open) {
	const md = rec.mainDiagnostics;
	if (open) delete open.partial; // the round completed: the pre-created record becomes the normal one
	md.assistantTurns += diag.assistantTurns;
	for (const [name, t] of Object.entries(diag.tools)) {
		const acc = ownTool(md.tools, name);
		acc.calls += t.calls; acc.errors += t.errors;
		if (t.firstError !== undefined && acc.firstError === undefined) acc.firstError = t.firstError;
	}
	md.finalText = boundedDiagnostic(text ?? "", limit);
	rec.delegation.launches.push(...diag.launches.map((l) => ({ round, ...l })));
	rec.delegation.receipts.push(...diag.receipts.map((r) => ({ round, ...r })));
	rec.delegation.refusals.push(...diag.refusals.map((r) => ({ round, ...r })));
	// The settlement keeps its task-relative offsets, the wait phase it ended in and what was pending (roles, last event) at the moment it gave up; absent values stay null.
	if (diag.settlement) {
		const s = diag.settlement;
		rec.delegation.settlements.push({ round, settled: s.settled === true, timedOut: s.timedOut === true, waitedMs: s.waitedMs ?? null, pendingJobs: s.pendingJobs ?? [], startedAtMs: s.startedAtMs ?? null, endedAtMs: s.endedAtMs ?? null, snapshotAtMs: s.snapshotAtMs ?? null, lastPhase: s.lastPhase ?? null, phases: s.phases ?? [], pending: s.pending ?? [] });
	}
	rec.delegation.timeline.push(...diag.timeline.map((e) => ({ round, ...e })));
	noteHidden(rec, { audits: diag.audits, diagnostics: diag.diagnostics, ignoredAudits: diag.ignoredAudits });
	const writerLaunches = diag.launches.filter((l) => l.agent === expectedWriter && l.status === "measured").length;
	rec.delegation.writerLaunches += writerLaunches;
	// Per-round telemetry from counts only (no arguments, no reasoning), so nothing is inferred from task totals.
	const entry = { round, assistantTurns: diag.assistantTurns, writerLaunches, toolCalls: Object.values(diag.tools).reduce((s, t) => s + t.calls, 0), tools: Object.entries(diag.tools).reduce((o, [n, t]) => { Object.assign(ownTool(o, n), { calls: t.calls, errors: t.errors }); return o; }, {}) };
	if (open) { for (const k of Object.keys(open)) delete open[k]; Object.assign(open, entry); } else md.rounds.push(entry);
}

// A round that ended before its prompt returned: what the adapter had ALREADY observed (counts, ids, roles, statuses; no text, arguments or error strings), kept as partial.
// Known counts are separate from coverage: an unobserved part is unknown, never zero, and nothing here is added to the writer count, the ledgers or any pass verdict.
// Usage stays with the owned prompt operation (absorbed once if it returns late), so nothing is double counted.
// Interrupted-round persistence is an allowlist: trusted structured outcome (status, counts, exit code) plus controlled values only. No child/native free-form text
// (errorMessage, stderr, refusal text) and no provider-owned strings (model, tier, slot, unvalidated stopReason/job id/mode) is copied.
const STOP_REASONS = new Set(["stop", "length", "toolUse", "error", "aborted"]);
const SAFE_MODES = new Set(["single", "parallel", "chain"]);
const safeJob = (v) => (typeof v === "string" && JOB_ID.test(v) ? v : null);
// Tool names are SDK event.toolName: the model can name any string, and the SDK still reports a rejected call under it. Only the controlled session vocabulary
// (adapter MAIN_TOOLS plus the write tools the main session must not use) is a name; every other name aggregates under one fixed key, never as a key or value.
const KNOWN_TOOLS = new Set(["read", "grep", "find", "ls", "subagent", "subagent_control", ...WRITE_TOOLS]);
function partialTools(tools) {
	const out = {};
	for (const [n, t] of Object.entries(tools)) { const k = KNOWN_TOOLS.has(n) ? n : "unknown_tool"; const acc = ownTool(out, k); acc.calls += t.calls; acc.errors += t.errors; }
	return out;
}
const partialLaunch = (l) => ({ agent: l.agent, status: l.status, turns: l.turns, exitCode: l.exitCode, stopReason: STOP_REASONS.has(l.stopReason) ? l.stopReason : l.stopReason === null ? null : "other", jobId: safeJob(l.jobId) });
const partialReceipt = (r) => ({ jobId: safeJob(r.jobId), mode: SAFE_MODES.has(r.mode) ? r.mode : null, roles: r.roles, ...(r.rolesInvalid !== undefined ? { rolesInvalid: r.rolesInvalid } : {}), completed: r.completed, atMs: r.atMs });
const partialRefusal = (r) => ({ text: null, reason: r.reason ?? "refused", ...(r.rolesInvalid !== undefined ? { rolesInvalid: r.rolesInvalid } : {}) });
const partialTimeline = (t) => (t.type === "receipt" ? { ...t, jobId: safeJob(t.jobId) } : t);
function interruptRound(rec, open, e, adapter, session, registry, task, limit, expectedWriter, atMs) {
	let snap = null;
	try { snap = typeof adapter.observed === "function" ? adapter.observed(session) : null; } catch { snap = null; }
	const ns = nsOf(session);
	// A completion/audit of a job another task owns is not this round's; an unclaimed one (this round's own) is kept.
	const events = snap ? (snap.events ?? []).filter((ev) => !(ev?.type === "completion" || ev?.type === "audit" || ev?.type === "diagnostic") || (registry.ownerOf(ns, ev.jobKey ?? keyOf(ev.session, ev.jobId)) ?? task.id) === task.id) : null;
	const d = events ? observeRound(events, limit) : null;
	const round = open.round;
	const cause = e instanceof BudgetStop ? "budget_exhausted" : "error";
	Object.assign(open, {
		partial: true, interrupted: { cause, stage: e instanceof BudgetStop ? e.stage : "main_prompt", ...(cause === "error" ? { source: typeof e?.kind === "string" ? e.kind : e?.name ?? null, infrastructure: e?.infrastructure === true } : {}), endOffsetMs: atMs },
		known: d ? { assistantTurns: d.assistantTurns, toolCalls: Object.values(d.tools).reduce((s, t) => s + t.calls, 0), tools: partialTools(d.tools), launches: d.launches.length, receipts: d.receipts.length, refusals: d.refusals.length, expectedWriterLaunches: d.launches.filter((l) => l.agent === expectedWriter && l.status === "measured").length } : null,
		coverage: { complete: false, events: d ? "partial" : "unknown", adapterObservability: d ? "available" : "unavailable", requestedUnacked: Number.isInteger(snap?.requestedUnacked) ? snap.requestedUnacked : null, pendingJobs: d ? d.pendingJobs.map(safeJob) : null },
	});
	if (!d) return;
	const dl = rec.delegation;
	dl.launches.push(...d.launches.map((l) => ({ round, partial: true, ...partialLaunch(l) })));
	dl.receipts.push(...d.receipts.map((r) => ({ round, partial: true, ...partialReceipt(r) })));
	dl.refusals.push(...d.refusals.map((r) => ({ round, partial: true, ...partialRefusal(r) })));
	dl.timeline.push(...d.timeline.map((t) => ({ round, partial: true, ...partialTimeline(t) })));
	noteHidden(rec, { audits: d.audits, diagnostics: d.diagnostics, ignoredAudits: d.ignoredAudits });
	dl.partialCoverage = { complete: false, rounds: [...new Set([...(dl.partialCoverage?.rounds ?? []), round])] };
	for (const [n, t] of Object.entries(partialTools(d.tools))) { const acc = ownTool(rec.mainDiagnostics.tools, n); acc.calls += t.calls; acc.errors += t.errors; }
	rec.mainDiagnostics.assistantTurns += d.assistantTurns;
}

// Hidden-entry facts of a task: terminal audits (owner, state, and what the producer did with the completion: suppressed, submitted or submit_failed; submitted is an attempt,
// delivery is proven only by an observed completion, completionObserved), delivery failures and ignored old-owner audits. Ids and codes only.
function noteHidden(rec, { audits = [], diagnostics = [], ignoredAudits = [] }) {
	const d = rec.delegation;
	for (const a of audits) if (!d.audits.some((x) => x.jobKey === a.jobKey)) d.audits.push({ jobKey: a.jobKey, jobId: a.jobId ?? null, state: a.state ?? null, completionSuppressed: a.completionSuppressed === true, completion: a.completion ?? null, completionObserved: false, results: Array.isArray(a.results) ? a.results.length : 0 });
	for (const f of diagnostics) if (!d.deliveryFailures.some((x) => x.jobId === f.jobId && x.code === f.code)) d.deliveryFailures.push({ jobId: f.jobId ?? null, code: f.code });
	for (const i of ignoredAudits) if (!d.ignoredAudits.some((x) => x.jobId === i.jobId && x.reason === i.reason)) d.ignoredAudits.push({ jobId: i.jobId, reason: i.reason });
}

// After the session closed and every abandoned operation drained: each close record is routed to the task that OWNS its job (registry, then the adapter's originating-task stamp,
// then the only task that ever prompted the session); a record no task can be proven to own is an explicit unknown, never the closing task's usage. A hidden audit (the only record of a
// worker whose completion was suppressed by the shutdown generation) merges into its job. Runs before the closing task's totals are computed.
function foldClose(registry, task, session, rec, closed) {
	const ns = nsOf(session);
	const users = sessionUsers.get(session);
	const valid = (id) => (typeof id === "string" && registry.knows(id) ? id : null);
	const resolve = (key, stamp) => registry.ownerOf(ns, key) ?? valid(stamp) ?? valid(closed.jobTasks?.[key]) ?? (users?.size === 1 ? valid([...users][0]) : null);
	for (const key of closed.pendingKeys ?? (closed.pendingJobs ?? []).map((id) => keyOf(null, id))) {
		const o = resolve(key);
		if (o) registry.claim(ns, key, o); else registry.unattributed(key, "owner_unattributed", "pending");
	}
	for (const a of closed.audits ?? []) {
		const o = resolve(a.jobKey, a.taskId);
		if (o) registry.observe(ns, a.jobKey, o, a); else registry.unattributed(a.jobKey, "owner_unattributed", "audit", a);
	}
	for (const f of closed.diagnostics ?? []) {
		const o = resolve(f.jobKey ?? keyOf(null, f.jobId), f.taskId);
		if (o) noteHidden(registry.tasks.get(o).rec, { diagnostics: [f] }); else registry.orphans.push({ jobKey: f.jobKey ?? f.jobId, kind: "diagnostic" });
	}
	noteHidden(rec, { ignoredAudits: closed.ignoredAudits });
	// The adapter's count is cumulative per session: only the part not yet folded is added, so a repeated close never counts the same error twice.
	if (Number.isInteger(closed.sendMessageErrors) && closed.sendMessageErrors > 0) {
		const prior = session ? (sendErrorsFolded.get(session) ?? 0) : 0;
		if (session) sendErrorsFolded.set(session, Math.max(prior, closed.sendMessageErrors));
		rec.delegation.uncorrelatedSendErrors += Math.max(0, closed.sendMessageErrors - prior);
	}
	if (closed.abortSnapshot) rec.budget.pendingAtAbort = closed.abortSnapshot;
}

// Routes one round's events by job ownership before anything is counted. A receipt or a first-seen completion claims its job for this task; a completion, audit or delivery
// diagnostic of a job another task owns is merged into that task's job (its usage and launches are not this task's) and removed from this round's own events.
function routeEvents(registry, task, ns, events, users) {
	const own = [];
	// Observation during this task is no ownership proof. The only fallback is exclusivity: a session that only one task ever prompted (same rule as foldClose).
	const sole = users?.size === 1 && registry.knows([...users][0]) ? [...users][0] : null;
	for (const ev of events ?? []) {
		if (ev?.type === "tool" && ev.controlResults && ev.control?.target) {
			// A retrieved result is not a launch or a delivery: its children are merged (partial evidence) into the owning job, once.
			const k = keyOf(ev.session, ev.control.target); const o = registry.ownerOf(ns, k) ?? sole;
			if (o) registry.observe(ns, k, o, { results: ev.controlResults }, { partial: true }); else registry.unattributed(k, "owner_unattributed", "control_result", { results: ev.controlResults });
			own.push(ev); continue;
		}
		if (ev?.type === "subagent" && callKind(ev) === "receipt") { registry.claim(ns, keyOf(ev.session, ev.details.jobId), task.id); own.push(ev); continue; }
		if (ev?.type !== "completion" && ev?.type !== "audit" && ev?.type !== "diagnostic") { own.push(ev); continue; }
		const key = ev.jobKey ?? keyOf(ev.session, ev.jobId);
		const owner = registry.ownerOf(ns, key) ?? (registry.knows(ev.taskId) ? ev.taskId : sole);
		if (!owner) { if (ev.type === "diagnostic") registry.orphans.push({ jobKey: key, kind: "diagnostic" }); else registry.unattributed(key, "owner_unattributed", ev.type, ev); continue; }
		if (ev.type === "diagnostic") { if (owner === task.id) own.push(ev); else noteHidden(registry.tasks.get(owner).rec, { diagnostics: [ev] }); continue; }
		registry.observe(ns, key, owner, ev, { completion: ev.type === "completion" });
		if (owner === task.id) own.push(ev);
	}
	return own;
}

// Assistant turns feed the main ledger (and the rework ledger during a rework prompt). Worker usage is counted exactly once per launch: a foreground subagent call by its
// toolCallId; a background job is reconciled per child in the run registry (routeEvents), never by its receipt or a later control result, and a receipt that never
// reported is an unknown job there, not an omitted one. A refusal launched nothing.
function absorb(events, { main, rework, worker, isRework, served, seen }) {
	for (const ev of events ?? []) {
		if (ev?.type === "assistant") {
			addUsage(main, ev.message?.usage);
			if (isRework) addUsage(rework, ev.message?.usage);
			noteServed(served, ev);
		} else if (ev?.type === "subagent") {
			const kind = callKind(ev);
			if (kind === "receipt" || kind === "refused") continue;
			const key = `call:${ev.toolCallId ?? ""}`;
			if (ev.toolCallId !== undefined) { if (seen.has(key)) continue; seen.add(key); }
			addWorkerUsage(worker, ev.details);
		}
	}
}

// Served provider/model as reported by the assistant message; a missing value stays absent, never guessed.
function noteServed(served, ev) {
	const { provider, model } = ev.message ?? {};
	if (served && (provider || model)) served.set(`${provider ?? "?"}/${model ?? "?"}`, { provider: provider ?? null, model: model ?? null });
}

// A fresh reviewer session per review, read-only tools, no extensions (see sdk-adapter). Open, prompt and close all run under the task clock; a session that
// opens after the cutoff is disposed by the owner, never prompted.
async function runReview({ adapter, dir, task, changed, gate, ledger, runtime, roleSpec, stage, owner, closeMs }) {
	const session = await stage("review_open", (ms, signal) => adapter.openSession({ cwd: dir, role: "review", compactionEnabled: false, taskId: task.id, runtime, roleSpec, signal }), { strict: true, late: (s) => adapter.closeSession(s, { budgetMs: closeMs() }) });
	const served = new Map();
	try {
		// Usage is counted inside the owned operation, so a turn that completes after the cutoff is still charged to the review.
		const out = await stage("review", async (ms, signal) => {
			const o = await adapter.prompt(session, reviewPrompt(task, changed, gate), { budgetMs: ms, signal });
			for (const ev of o?.events ?? []) { if (ev?.type === "assistant") addUsage(ledger, ev.message?.usage); noteServed(served, ev); }
			return o;
		});
		return { ...parseReviewOutput(out?.text), text: out?.text ?? "", identity: session.identity ?? null, served: [...served.values()] };
	} finally {
		const closed = await closeRecorded(adapter, session, closeMs());
		if (closed.confirmed === false) owner.note("review_close");
	}
}

// Opens the main session. With a restored history the adapter must prove it restored exactly that many entries under a NEW session id; otherwise the open fails closed
// (an empty or silently different session is never labelled long). The raw history is only handed to the adapter, in memory.
async function openMain({ adapter, dir, task, runtime, roles, limits, signal, timeline, onEvent, history }) {
	const s = await adapter.openSession({ cwd: dir, role: "main", compactionEnabled: false, taskId: task.id, runtime, roleSpec: roles.main, limits, signal, timeline, onEvent, ...(history ? { history } : {}) });
	if (history && (s?.restored?.entryCount !== history.entryCount || s.restored.newSession !== true)) {
		const c = await closeRecorded(adapter, s, limits.shutdownGraceMs.value);
		throw Object.assign(new Error(`history restore was not confirmed (restored entries and a new session id are required)${c.confirmed ? "" : "; the unproven session could not be confirmed closed"}`), { continuationRestore: true });
	}
	return s;
}
const restoredNote = (history, session) => ({ fromTaskId: history.fromTaskId, entryCount: history.entryCount, appendedOnOpen: Number.isInteger(session.restored?.appendedOnOpen) ? session.restored.appendedOnOpen : null, newSessionId: true });

async function runTask({ task, order, mode, spec, adapter, workspace, acceptance, cap, diagnosticsRun, expectedWriter, runtime, roles, limits, shared, compactionBefore, clock, startedAt, preStop, owner, ac, progress, registry, isFinal }) {
	const started = Date.now();
	const budget = taskBudgetOf(task, limits);
	const cutoffAt = startedAt + budget.value - limits.shutdownGraceMs.value;
	const left = () => cutoffAt - clock();
	const budgetRec = { taskTimeoutMs: budget.value, source: budget.source, graceMs: limits.shutdownGraceMs.value, workCutoffOffsetMs: budget.value - limits.shutdownGraceMs.value, deadlineOffsetMs: budget.value, exhausted: false, stage: null, stages: [] };
	const deadlineLeft = () => Math.max(0, startedAt + budget.value - clock());
	// Runs one stage under the shared task clock and the task abort signal. On the cutoff the signal fires and the still-running operation is handed to the
	// owner (drained and its late value disposed before the task can be called closed); nothing here claims the timer stopped the work. strict: an operation
	// that returns after the cutoff (for example synchronous work that overran) has its value disposed too, because nothing may continue from it.
	const stage = async (name, fn, { late, strict = false } = {}) => {
		const ms = left();
		if (ms <= 0) throw new BudgetStop(name);
		const from = clock() - startedAt;
		progress?.({ task: task.id, round, stage: name, lastEvent: null });
		const p = Promise.resolve().then(() => fn(ms, ac.signal));
		const r = await race(p, ms);
		budgetRec.stages.push({ stage: name, startOffsetMs: from, endOffsetMs: clock() - startedAt });
		if (r.timedOut) { ac.abort(); owner.track(name, p, late); throw new BudgetStop(name); }
		// A bounded subprocess (execFileSync timeout) that expired is the deadline, not a failure of the task.
		if (r.error?.code === "ETIMEDOUT") { ac.abort(); throw new BudgetStop(name); }
		if (r.error) throw r.error;
		if (strict && left() <= 0) { ac.abort(); owner.track(name, Promise.resolve(r.value), late); throw new BudgetStop(name); }
		return r.value;
	};
	let round = 0;
	const dir = workspace.dirFor(mode, task);
	const snap = () => stage("workspace_snapshot", () => workspace.snapshot(dir, { stop: () => left() <= 0 }), { strict: true });
	// Diagnostic cap precedence: manifest task override > run cap (role default unless a run flag). The winning source is recorded.
	const diagnostics = task.diagnosticChars !== undefined ? { value: task.diagnosticChars, source: `manifest task ${task.id}` } : diagnosticsRun;
	// Round settlement timeout precedence: manifest task (packet) override > run flag > roles.json default; the winning source is recorded.
	const settleTimeout = task.roundSettleTimeoutMs !== undefined ? { value: task.roundSettleTimeoutMs, source: `manifest task ${task.id}` } : limits.roundSettleTimeoutMs;
	const raw = { main: emptyLedger("model"), rework: emptyLedger("model"), worker: emptyLedger("worker"), review: emptyLedger("model"), served: new Map(), seen: new Set(), jobs: new Map() };
	const rec = {
		id: task.id, order, tier: task.tier, category: task.category, subject: task.subject, commit: task.commit, parent: task.parent,
		maxReworkRounds: task.maxReworkRounds !== undefined ? { value: task.maxReworkRounds, source: `manifest task ${task.id}` } : cap, status: "running", accepted: false, compactionBefore,
		models: { main: { configured: roles.main, opened: null, served: [] }, reviewer: { configured: roles.reviewer } },
		startContext: null, reworkRounds: 0, reworkTurns: null, main: null, worker: null,
		reviewer: { cycles: [], usage: null }, acceptance: { cycles: [] },
		changedFiles: { changed: [], unrelated: [], missing: [] }, heldOutOverwritten: [], durationMs: null,
		budget: budgetRec,
		delegation: { expectedWriter, diagnosticChars: diagnostics, roundSettleTimeoutMs: settleTimeout, shutdownGraceMs: limits.shutdownGraceMs, writerLaunches: 0, launches: [], receipts: [], refusals: [], settlements: [], timeline: [], audits: [], deliveryFailures: [], ignoredAudits: [], uncorrelatedSendErrors: 0 }, mainDiagnostics: { tools: {}, assistantTurns: 0, rounds: [], finalText: null },
	};
	// Task-relative native timeline: offsets on the shared task clock, and a compact event hook (ids, codes and offsets only) that updates the written progress.
	const timeline = { startedAt };
	const onEvent = (e) => progress?.({ task: task.id, round, lastEvent: { type: e.type, atMs: Number.isFinite(e.atMs) ? e.atMs : null, jobId: e.jobId ?? e.details?.jobId ?? null, ...(e.control ? { action: e.control.action } : {}), ...(e.state ? { state: e.state } : {}), ...(e.code ? { code: e.code } : {}) } });
	registry.enroll(task.id, rec, raw);
	let session = null; let currentRound = null;
	// Controlled continuation metadata only (ids, counts, reason codes): never any transcript content.
	const cont = () => (rec.continuation ??= { policy: CONTINUATION_POLICY, restored: null, captured: null, stop: null });
	const noteRestore = () => { if (shared.restored) { cont().restored = shared.restored; shared.restored = null; } };
	try {
		if (preStop) { session = shared.session; noteRestore(); throw new BudgetStop(preStop); }
		const prepared = await stage("workspace_prepare", (ms, signal) => workspace.prepare(task, dir, { timeoutMs: wholeMs(ms), remainingMs: left, signal }), { strict: true });
		const before = await snap();
		// Owned scratch/evidence outside the scored workspace, created under the same task clock (no separate grant).
		const artifacts = workspace.artifactsFor ? workspace.artifactsFor(mode, task) : null;
		if (artifacts) { await stage("artifact_prepare", () => workspace.prepareArtifacts(artifacts), { strict: true }); rec.artifacts = artifacts; }
		const tracked = new Set(prepared?.paths ?? []);
		const policy = workspace.toolStatePolicy ?? null;
		if (spec.sessionPolicy === "new-per-task" || shared.session === null) {
			const history = spec.sessionPolicy === "new-per-task" ? null : shared.history;
			session = await stage("session_open", (ms, signal) => openMain({ adapter, dir, task, runtime, roles, limits, signal, timeline, onEvent, history }), { strict: true, late: (s) => adapter.closeSession(s, { budgetMs: deadlineLeft() }) });
			if (spec.sessionPolicy !== "new-per-task") {
				shared.session = session; shared.opened = true;
				if (history) { shared.restored = restoredNote(history, session); shared.history = null; }
			}
		} else session = shared.session;
		noteRestore();
		if (!sessionUsers.has(session)) sessionUsers.set(session, new Set());
		sessionUsers.get(session).add(task.id);
		rec.models.main.opened = session.identity ?? null;
		rec.startContext = contextOf(await stage("start_context", () => adapter.startContext(session)));
		let prompt = taskPrompt(task, artifacts);
		for (;;) {
			// Held-out baseline: the state this round's main session receives (the previous round's restored tests), reset every round.
			const prePrompt = await snap();
			// Usage is absorbed inside the owned operation: a turn that completes after the cutoff is still counted, and never scored.
			// The round record exists BEFORE the prompt: a cut, cancel or error keeps it (partial) instead of losing the round.
			currentRound = { round, partial: true, startOffsetMs: clock() - startedAt };
			rec.mainDiagnostics.rounds.push(currentRound);
			const { out, diag } = await stage("main_prompt", async (ms, signal) => {
				// The settle round takes whole ms only; under one whole ms left is budget exhaustion, never a new 1 ms grant (wholeMs would grant one).
				const whole = Math.floor(ms);
				if (whole < 1) throw new BudgetStop("main_prompt");
				const o = await adapter.prompt(session, prompt, { settle: { timeoutMs: Math.min(settleTimeout.value, whole) }, budgetMs: whole, signal, timeline, onEvent, taskId: task.id });
				// Ownership first: another task's job is merged into that task, and only this task's own events are observed and counted below.
				const events = routeEvents(registry, task, nsOf(session), o?.events, sessionUsers.get(session));
				const d = observeRound(events, diagnostics.value);
				d.settlement = o?.settlement ?? null;
				absorb(events, { ...raw, isRework: round > 0 });
				return { out: o, diag: d };
			});
			noteRound(rec, diag, round, out?.text, diagnostics.value, expectedWriter, currentRound);
			currentRound = null;
			if ((diag.settlement?.timedOut === true || diag.settlement?.budgetExhausted === true) && left() <= 0) throw new BudgetStop("main_settlement");
			const stop = classifyRound(diag, expectedWriter, { cumulativeWriterLaunches: rec.delegation.writerLaunches });
			if (stop) throw new RoundStop({ ...stop, round });
			const afterMain = await snap();
			await stage("held_out", (ms) => workspace.heldOut(task, dir, { timeoutMs: wholeMs(ms), remainingMs: left }), { strict: true });
			const afterHeld = await snap();
			const overwritten = task.acceptanceTests.filter((p) => afterMain.get(p) !== prePrompt.get(p)).sort();
			const d = workspace.diff(before, afterHeld);
			const everyChanged = [...d.added, ...d.modified, ...d.removed].filter((p) => !task.acceptanceTests.includes(p)).sort();
			const toolState = policy ? d.added.filter((p) => everyChanged.includes(p) && policy.isToolState(p, { tracked, before })) : [];
			const changed = everyChanged.filter((p) => !toolState.includes(p));
			const unrelated = changed.filter((p) => !task.allowedFiles.includes(p));
			const gate = await stage("acceptance", (ms, signal) => acceptance({ cwd: dir, files: task.acceptanceTests, runner: task.acceptanceRunner ?? "node", timeoutMs: ms, signal }));
			if (gate?.timedOut === true) throw new BudgetStop("acceptance");
			const testsPassed = gate.accepted === true;
			rec.acceptance.cycles.push({ round, testsPassed, exitCode: gate.exitCode ?? null, pass: gate.pass ?? null, fail: gate.fail ?? null, reason: gate.reason, outputTail: gate.outputTail, heldOutOverwritten: overwritten });
			const review = await runReview({ adapter, dir, task, changed, gate: { accepted: testsPassed }, ledger: raw.review, runtime, roleSpec: roles.reviewer, stage, owner, closeMs: deadlineLeft });
			rec.reviewer.cycles.push({ round, status: review.status, findings: review.findings, highCount: review.highCount, text: review.text, identity: review.identity, evaluator: evaluatorOf(review.identity), served: review.served });
			rec.changedFiles = { changed, unrelated, missing: task.allowedFiles.filter((p) => !changed.includes(p)), toolStateChanges: toolState.map((p) => ({ path: p, sha256: afterHeld.get(p) })), inventory: { added: d.added, modified: d.modified, removed: d.removed } };
			rec.heldOutOverwritten = [...overwritten].sort();
			rec.accepted = testsPassed && unrelated.length === 0;
			const needRework = !rec.accepted || (review.status === "ok" && review.highCount > 0);
			if (!needRework || round >= rec.maxReworkRounds.value) break;
			round++;
			rec.reworkRounds = round;
			prompt = reworkPrompt(task, round, { ...gate, accepted: testsPassed }, review, unrelated, artifacts);
		}
		rec.reworkRounds = round;
		rec.status = "completed";
	} catch (e) {
		if (currentRound) interruptRound(rec, currentRound, e, adapter, session, registry, task, diagnostics.value, expectedWriter, clock() - startedAt);
		if (e instanceof BudgetStop) {
			rec.status = "budget_exhausted"; rec.accepted = false;
			budgetRec.exhausted = true; budgetRec.stage = e.stage; budgetRec.exhaustedAtOffsetMs = clock() - startedAt;
			// A review cut by the deadline is unknown, never zero findings; a stale pre-edit review is not carried forward as current.
			if (e.stage === "review" || e.stage === "review_open") rec.reviewer.cycles.push({ round, status: "unknown", findings: [], highCount: null, text: "", identity: null, evaluator: evaluatorOf(null), served: [] });
		} else if (e instanceof RoundStop) { rec.status = e.info.class === "infrastructure" ? "infrastructure" : "method_invalid"; rec.invalid = e.info; }
		else if (e.infrastructure === true) { rec.status = "infrastructure"; rec.invalid = { class: "infrastructure", kind: e.kind ?? "native_dispatch_unavailable" }; }
		else rec.status = "error";
		if (e.continuationRestore === true) cont().stop = { reason: "history_restore_failed", fromTaskId: shared.history?.fromTaskId ?? null };
		rec.error = e.message;
	} finally {
		// A stopped round closes its session at once (even a shared one): shutdown cancels and awaits every owning worker before the workspace can be reused.
		// Close is bounded by the task deadline, and every abandoned operation is then drained to that same deadline: only a session that closed AND an empty
		// owner make the shutdown confirmed. Anything still pending is reported, never assumed stopped.
		const stopped = rec.status === "infrastructure" || rec.status === "method_invalid" || rec.status === "error" || rec.status === "budget_exhausted";
		if (stopped) ac.abort();
		let closed = { confirmed: true, ms: null, pendingJobs: [] };
		// The final task of a shared-session run closes its session HERE, under its own original deadline and ownership (not later in an outer cleanup with a fresh grace), so its
		// terminal audits are folded before the task and run totals are final.
		if (session && (spec.sessionPolicy === "new-per-task" || stopped || isFinal)) {
			if (shared.session === session) shared.session = null;
			closed = await closeRecorded(adapter, session, deadlineLeft());
			// A close that timed out or returned after the task deadline (an adapter that ignored its budget) is an overrun: unfinished, never a pass. Its audits are still folded below.
			if (rec.status === "completed" && (closed.timedOut === true || clock() - startedAt > budget.value)) {
				rec.status = "budget_exhausted"; rec.accepted = false;
				budgetRec.exhausted = true; budgetRec.stage = "session_close"; budgetRec.exhaustedAtOffsetMs = clock() - startedAt;
				rec.error = "task budget exhausted during session_close";
			}
		}
		const pendingOperations = await owner.drain(deadlineLeft());
		rec.shutdown = { confirmed: closed.confirmed && pendingOperations.length === 0, ms: closed.ms, pendingJobs: closed.pendingJobs, pendingOperations, ...(closed.error ? { error: closed.error } : {}) };
		foldClose(registry, task, session, rec, closed);
		if (rec.shutdown.confirmed === false && rec.status === "completed") { rec.status = "infrastructure"; rec.invalid = { class: "infrastructure", kind: "shutdown_unconfirmed" }; }
		// A closed shared session cannot be prompted again, but its SessionManager entries stay readable. After a CONFIRMED deadline cut (abort awaited, runtime disposed, owner empty,
		// still inside the original deadline) the faithful history is snapshotted here, before the session reference is lost; any other stop leaves no history and the run stops.
		if (session && stopped && spec.sessionPolicy !== "new-per-task") {
			shared.history = null; shared.historyStop = null;
			if (rec.status === "budget_exhausted") {
				if (rec.shutdown.confirmed !== true) shared.historyStop = "shutdown_unconfirmed";
				else if (typeof adapter.snapshotHistory !== "function") shared.historyStop = "adapter_history_unsupported";
				else if (Math.floor(deadlineLeft()) < 1) shared.historyStop = "snapshot_after_task_deadline";
				else {
					try {
						const h = adapter.snapshotHistory(session);
						// The synchronous capture cannot be preempted: an overrun is detected after it returns and the late seed is discarded (same whole-ms rule, no grant).
						if (Math.floor(deadlineLeft()) < 1) shared.historyStop = "snapshot_after_task_deadline";
						else if (!h || h.data === undefined || !Number.isInteger(h.entryCount) || h.entryCount < 0) shared.historyStop = "history_snapshot_invalid";
						else { shared.history = { data: h.data, entryCount: h.entryCount, sessionId: h.sessionId ?? null, fromTaskId: task.id }; cont().captured = { entryCount: h.entryCount }; }
					} catch { shared.historyStop = "history_snapshot_failed"; }
				}
			}
		}
		rec.models.main.served = [...raw.served.values()];
		rec.reworkTurns = ledgerTotals(raw.rework).turns;
		rec.main = ledgerTotals(raw.main);
		rec.worker = ledgerTotals(workerLedger(raw));
		rec.reviewer.usage = ledgerTotals(raw.review);
		rec.durationMs = Date.now() - started;
	}
	return { rec, raw };
}

// Closes a session and records whether shutdown confirmed that every owning background worker ended. The close is bounded by ms: a close that does not return
// in time (or throws) is unconfirmed, because an adapter that cannot report is not proof that anything stopped.
async function closeRecorded(adapter, session, ms) {
	try {
		const r = await race(adapter.closeSession(session, { budgetMs: ms }), ms);
		if (r.timedOut) return { confirmed: false, timedOut: true, ms: null, pendingJobs: [], error: "session close did not return before the task deadline" };
		if (r.error) throw r.error;
		const v = r.value;
		return { confirmed: v?.confirmed !== false, ms: v?.ms ?? null, pendingJobs: v?.pendingJobs ?? [], pendingKeys: v?.pendingKeys, audits: v?.audits, diagnostics: v?.diagnostics, ignoredAudits: v?.ignoredAudits, sendMessageErrors: v?.sendMessageErrors, abortSnapshot: v?.abortSnapshot };
	} catch (e) {
		return { confirmed: false, ms: null, pendingJobs: [], error: boundedDiagnostic(e.message, 300).text };
	}
}

// Manual compaction between tasks: the only compaction in the compacted arm (auto-compaction is disabled in every arm).
async function compactShared({ adapter, session, ledger, signal }) {
	const k = await adapter.compact(session, { signal });
	// A not-applicable state is recorded as such: no call, no usage, no savings (a truthful no-op, never a compressed-summary claim).
	if (k?.compactionNotApplicable) return { compactionNotApplicable: k.compactionNotApplicable, tokensBefore: null, usage: null };
	addUsage(ledger, k?.usage);
	return { tokensBefore: k?.tokensBefore ?? null, usage: ledgerTotals(addUsage(emptyLedger("model"), k?.usage)) };
}

const sumNullable = (values) => (values.some((v) => v === null || v === undefined) ? null : values.reduce((s, v) => s + v, 0));

// Totals are sums of raw ledgers; any unavailable part makes the sum unavailable (null), never a partial total.
export function computeTotals(records, raws, compactionLedger) {
	const sum = (key, kind) => raws.reduce((acc, r) => addLedgers(acc, r[key]), emptyLedger(kind));
	const main = ledgerTotals(sum("main", "model"));
	const worker = ledgerTotals(raws.reduce((acc, r) => addLedgers(acc, workerLedger(r)), emptyLedger("worker")));
	const reviewer = ledgerTotals(sum("review", "model"));
	const rework = ledgerTotals(sum("rework", "model"));
	const compaction = compactionLedger.calls === 0
		? { status: "none", calls: 0, cost: { total: 0, cacheTier: 0 } }
		: { ...ledgerTotals(compactionLedger), calls: compactionLedger.calls };
	const parts = [main, worker, reviewer, compaction];
	const accepted = records.filter((r) => r.accepted).length;
	const part = (f) => parts.map((p) => (p.status === "none" ? 0 : f(p)));
	return {
		acceptance: { accepted, total: records.length, rate: records.length ? accepted / records.length : null },
		highFindings: {
			first: sumNullable(records.map((r) => r.reviewer.cycles[0]?.highCount ?? null)),
			final: sumNullable(records.map((r) => r.reviewer.cycles.at(-1)?.highCount ?? null)),
		},
		reviewer: {
			cycles: records.reduce((s, r) => s + r.reviewer.cycles.length, 0),
			unavailableCycles: records.reduce((s, r) => s + r.reviewer.cycles.filter((c) => c.status === "unavailable").length, 0),
			usage: reviewer,
		},
		evaluator: summarizeEvaluators(records),
		rework: { rounds: records.reduce((s, r) => s + r.reworkRounds, 0), turns: sumNullable(records.map((r) => r.reworkTurns)) },
		main, worker, compaction,
		endToEnd: {
			turns: sumNullable(parts.map((p) => (p.status === "none" ? 0 : (p.turns ?? p.calls) ?? null))),
			input: sumNullable(part((p) => p.input)),
			output: sumNullable(part((p) => p.output)),
			cacheRead: sumNullable(part((p) => p.cacheRead)),
			cacheWrite: sumNullable(part((p) => p.cacheWrite)),
			cost: sumCosts(parts.map((p) => p.cost.total)),
			cacheTier: sumCosts(parts.map((p) => p.cost.cacheTier)),
		},
		wallMs: records.reduce((s, r) => s + (r.durationMs ?? 0), 0),
	};
}

// Runs the fixed-order manifest once in one mode. Writes the result after every task and at the end; never retries a task.
export async function runBenchmark({ manifest, mode, adapter, workspace, acceptance = runAcceptanceAsync, config = {}, writeResult = () => {}, now = () => new Date().toISOString() }) {
	const spec = MODES[mode];
	if (!spec) throw new Error(`unknown mode "${mode}"; use one of ${Object.keys(MODES).join(", ")}`);
	validateManifest(manifest);
	assertCap(config.maxReworkRounds, "config.maxReworkRounds");
	assertCap(config.diagnosticChars, "config.diagnosticChars");
	assertLimit(config.limits?.roundSettleTimeoutMs, "config.limits.roundSettleTimeoutMs");
	assertLimit(config.limits?.shutdownGraceMs, "config.limits.shutdownGraceMs");
	assertLimit(config.limits?.taskTimeoutMs, "config.limits.taskTimeoutMs");
	for (const t of manifest.tasks) {
		const b = taskBudgetOf(t, config.limits);
		assertLimit(b, `task ${t.id} taskTimeoutMs`);
		if (b.value <= config.limits.shutdownGraceMs.value) throw new Error(`task ${t.id} taskTimeoutMs ${b.value} leaves no positive work window after the reserved shutdown grace ${config.limits.shutdownGraceMs.value}`);
	}
	const clock = config.clock ?? (() => performance.now());
	if (!config.roles?.main || !config.roles?.reviewer) throw new Error("config.roles.main and config.roles.reviewer are required (the configured identities)");
	if (!config.runtime?.fingerprint) throw new Error("config.runtime is required: the candidate runtime identity");
	const desc = adapter.describe();
	const result = {
		schemaVersion: RESULT_SCHEMA_VERSION, mode, order: manifest.tasks.map((t) => t.id), manifestDigest: manifestDigest(manifest), expectedWriter: manifest.expectedWriter,
		synthetic: desc.synthetic === true,
		config: {
			maxReworkRounds: config.maxReworkRounds, diagnosticChars: config.diagnosticChars, limits: config.limits, resources: config.resources ?? null, sessionPolicy: spec.sessionPolicy, compaction: spec.compaction, reviewer: "fresh-session-per-review",
			roles: { main: config.roles.main, reviewer: config.roles.reviewer },
			registry: config.registry ?? null,
			...(spec.sessionPolicy === "new-per-task" ? {} : { continuation: { policy: CONTINUATION_POLICY } }),
			// Agent topology proof (topology.mjs): a measured (non-synthetic) run needs ok true; compare requires the same method. Null for a synthetic run.
			topology: config.topology ?? null,
			measurementPolicy: { artifacts: workspace.artifactPolicy ? { id: workspace.artifactPolicy.id, rule: workspace.artifactPolicy.rule } : null, toolState: workspace.toolStatePolicy ? { id: workspace.toolStatePolicy.id, roots: workspace.toolStatePolicy.roots, rule: workspace.toolStatePolicy.rule } : null },
			runtime: { root: config.runtime.root ?? null, extensions: config.runtime.extensions ?? null, fingerprint: config.runtime.fingerprint, endFingerprint: null },
		},
		environment: { node: process.version, platform: process.platform, arch: process.arch, adapter: desc },
		status: "running", startedAt: now(), finishedAt: null, compactionFailures: [], tasks: [], notRun: [], totals: null, progress: null,
	};
	// Event-driven progress (no polling): the current task, round, stage and last meaningful native event, written at stage starts and at those events.
	const progress = (u) => { result.progress = { ...(result.progress ?? {}), ...u }; writeResult(result); };
	const raws = [];
	const compactionLedger = emptyLedger("model");
	// shared.history is the in-memory restore seed (never written to the result); opened: a session was ever opened; restored/historyStop: controlled notes.
	const shared = { session: null, history: null, opened: false, restored: null, historyStop: null };
	let activeDeadlineAt = null; // original deadline of the task being run: an outer emergency close may not grant itself a fresh grace beyond it
	const registry = createRegistry();
	// A direct library caller cannot bypass the CLI guard: a measured run needs the agent topology proof BEFORE any workspace, session, provider or prompt.
	const topoStop = result.synthetic ? null : !config.topology || config.topology.method !== TOPOLOGY_METHOD ? { class: "methodinvalid", kind: "agent_topology_missing", detail: "no agent topology proof of this method" } : config.topology.ok !== true ? { class: "infrastructure", kind: "agent_topology_blocked", detail: describeProblems(config.topology) } : null;
	if (topoStop) { result.status = "invalid"; result.error = `${topoStop.kind}: ${topoStop.detail}`; result.invalid = { task: null, class: topoStop.class, kind: topoStop.kind }; }
	try {
		for (let i = 0; i < (topoStop ? 0 : manifest.tasks.length); i++) {
			const task = manifest.tasks[i];
			let compactionBefore = null;
			// The task clock starts before its setup compaction: between-task compaction belongs to the next task's budget.
			const startedAt = clock();
			activeDeadlineAt = startedAt + taskBudgetOf(task, config.limits).value;
			let preStop = null;
			const owner = createOwner();
			const ac = new AbortController();
			if (spec.compaction === "manual-between-tasks" && i > 0) {
				const budget = taskBudgetOf(task, config.limits);
				const cutoffAt = startedAt + budget.value - config.limits.shutdownGraceMs.value;
				// A cut task closed the shared session: it is reopened from its faithful history FIRST, inside this task's own setup budget (no model call), then compacted.
				// A failed restore fails the run closed (no empty session is substituted).
				if (cutoffAt - clock() > 0 && shared.session === null && shared.history) {
					const history = shared.history;
					const op = Promise.resolve().then(() => openMain({ adapter, dir: workspace.dirFor(mode, task), task, runtime: config.runtime, roles: config.roles, limits: config.limits, signal: ac.signal, timeline: { startedAt }, history }));
					const o = await race(op, cutoffAt - clock());
					if (o.timedOut) { ac.abort(); owner.track("session_open", op, (s) => adapter.closeSession(s, { budgetMs: Math.max(0, activeDeadlineAt - clock()) })); preStop = "session_open"; }
					else if (o.error) throw o.error;
					else {
						shared.session = o.value; shared.opened = true; shared.restored = restoredNote(history, o.value); shared.history = null;
						if (clock() >= cutoffAt) preStop = "session_open";
					}
				}
				try {
					const ms = cutoffAt - clock();
					// No session and no history: only provable when no session ever opened (the continuation admission guarantees it), so there is nothing to compact and the task
					// opens its first session normally. Any other no-session state would lose context: fail closed, never compact null.
					if (!preStop && shared.session === null && !shared.history) {
						if (shared.opened) throw new Error("long-compacted has no live or restorable session after an opened session (context unavailable)");
					}
					else if (preStop) { /* cut while reopening: nothing further runs */ }
					else if (ms <= 0) preStop = "compaction";
					else {
						const p = Promise.resolve().then(() => compactShared({ adapter, session: shared.session, ledger: compactionLedger, signal: ac.signal }));
						const r = await race(p, ms);
						// A timed out compaction is aborted and owned (its late usage is still counted); it is not assumed stopped.
						if (r.timedOut) { ac.abort(); owner.track("compaction", p); preStop = "compaction"; }
						else if (r.error) throw r.error;
						else { compactionBefore = r.value; if (clock() >= cutoffAt) preStop = "compaction"; }
					}
				} catch (e) {
					result.compactionFailures.push({ beforeTask: task.id, error: e.message });
					throw e;
				}
			}
			const { rec, raw } = await runTask({ task, order: i + 1, mode, spec, adapter, workspace, acceptance, cap: config.maxReworkRounds, diagnosticsRun: config.diagnosticChars, expectedWriter: manifest.expectedWriter, runtime: config.runtime, roles: config.roles, limits: config.limits, shared, compactionBefore, clock, startedAt, preStop, owner, ac, progress, registry, isFinal: i === manifest.tasks.length - 1 });
			result.tasks.push(rec);
			raws.push(raw);
			writeResult(result);
			// A deliberate budget expiry is unfinished, never a pass. Fresh mode continues only after a confirmed drain; a long session continues only from its faithful restored history (never silently recreated empty).
			if (rec.status === "budget_exhausted") {
				(result.budgetExhausted ??= []).push(task.id);
				result.status = "unfinished";
				result.error = `task ${task.id} budget exhausted during ${rec.budget.stage}`;
				if (rec.shutdown?.confirmed !== true) {
					result.shutdownUnconfirmed = { task: task.id, pendingOperations: rec.shutdown?.pendingOperations ?? [], pendingJobs: rec.shutdown?.pendingJobs ?? [] };
					result.error += `; shutdown unconfirmed (${[...result.shutdownUnconfirmed.pendingOperations, ...result.shutdownUnconfirmed.pendingJobs].join(", ") || "close not confirmed"}): the run stops and no further task starts`;
				}
				if (rec.shutdown?.confirmed === true) {
					if (spec.sessionPolicy === "new-per-task") continue;
					// A long run continues only when no context can be lost: the still-open session (the cut never reached it), the confirmed faithful snapshot, or no session ever existed.
					if (shared.session !== null || shared.history !== null || !shared.opened) continue;
					const reason = shared.historyStop ?? "history_unavailable";
					(rec.continuation ??= { policy: CONTINUATION_POLICY, restored: null, captured: null, stop: null }).stop = { reason };
					result.continuationStop = { task: task.id, reason };
					result.error += `; long-session continuation is not possible (${reason}): the run stops and the remaining tasks are not run`;
				}
				break;
			}
			// Infrastructure or methodinvalid: stop here (no further tasks), keep the partial results, and the run is not complete.
			if (rec.status === "infrastructure" || rec.status === "method_invalid") {
				result.status = "invalid";
				result.error = `task ${task.id} ${rec.status}: ${rec.invalid.kind}`;
				result.invalid = { task: task.id, class: rec.invalid.class, kind: rec.invalid.kind };
				break;
			}
			if (rec.status !== "completed") throw new Error(`task ${task.id} ${rec.status}: ${rec.error}`);
		}
		if (result.status === "running") result.status = "complete"; // a topology stop is already "invalid"
	} catch (e) {
		result.status = "failed";
		result.error = e.message;
	} finally {
		if (shared.session) {
			const closed = await closeRecorded(adapter, shared.session, Math.max(0, Math.min(config.limits.shutdownGraceMs.value, activeDeadlineAt - clock())));
			shared.session = null;
			if (closed.confirmed === false) { result.status = "failed"; result.error = "shutdown_unconfirmed: a background worker may still be running"; }
		}
	}
	result.progress = null;
	result.notRun = manifest.tasks.slice(result.tasks.length).map((t) => t.id);
	for (const id of registry.tasks.keys()) registry.refresh(id);
	// Records no task could be proven to own are explicit unknowns of the run, never any task's usage.
	if (registry.orphan.unresolved.length) { raws.push({ main: emptyLedger("model"), rework: emptyLedger("model"), worker: registry.orphanLedger(), review: emptyLedger("model"), jobs: new Map() }); result.unattributed = registry.orphans; }
	result.totals = computeTotals(result.tasks, raws, compactionLedger);
	if (config.recheckRuntime) {
		const end = config.recheckRuntime();
		result.config.runtime.endFingerprint = end;
		if (end !== config.runtime.fingerprint) {
			result.status = "failed";
			result.error = `candidate runtime changed during the run (start ${config.runtime.fingerprint}, end ${end})`;
		}
	}
	result.finishedAt = now();
	writeResult(result);
	return result;
}
