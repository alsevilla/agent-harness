// Benchmark runner: fixed-order manifest, three session policies, per-task accounting.
// It drives an injected adapter (Pi SDK or synthetic) and a workspace; all session creation goes through that adapter.
import { runAcceptance } from "./acceptance.mjs";
import { validateManifest, manifestDigest } from "./manifest.mjs";
import { addUsage, addWorkerUsage, emptyLedger, ledgerTotals, addLedgers, sumCosts } from "./usage.mjs";
import { evaluatorOf, summarizeEvaluators } from "./evaluator.mjs";

// v2: each reviewer cycle records its effective evaluator (compare requires it); totals.evaluator summarises it. v1 results are not comparable.
// v3: method validity (infrastructure and methodinvalid stops, delegation and main diagnostics, per-round held-out baseline). v2 results are not comparable.
export const RESULT_SCHEMA_VERSION = "harness-benchmark-result/3";
// No literal rework default: config.maxReworkRounds is resolved from roles.json (general-worker) or a run flag, with its source.
export const MODES = {
	fresh: { sessionPolicy: "new-per-task", compaction: "none" },
	"long-fixed": { sessionPolicy: "shared-fixed-order", compaction: "none" },
	"long-compacted": { sessionPolicy: "shared-fixed-order", compaction: "manual-between-tasks" },
};
const TAIL = 2000;

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

export function taskPrompt(task) {
	return [
		`Harness task ${task.id} (${task.tier}, ${task.category}).`,
		`Goal: ${task.subject}`,
		`Edit only these files: ${task.allowedFiles.join(", ")}.`,
		"Work only inside this workspace. Finish with a short statement of what you changed.",
	].join("\n");
}

export function reworkPrompt(task, round, gate, review, unrelated) {
	const lines = [`REWORK round ${round} for ${task.id}: the change is not accepted yet.`];
	if (!gate.accepted) lines.push(`Acceptance failed (${gate.reason ?? "tests did not pass"}). Output tail:\n${String(gate.outputTail ?? "").slice(-TAIL)}`);
	if (unrelated.length) lines.push(`Revert changes outside the allowed files: ${unrelated.join(", ")}.`);
	const high = review.status === "ok" ? review.findings.filter((f) => f.severity === "critical" || f.severity === "high") : [];
	if (high.length) lines.push(`Reviewer findings to fix:\n${high.map((f) => `- ${f.severity}: ${f.text}`).join("\n")}`);
	lines.push(`Edit only these files: ${task.allowedFiles.join(", ")}.`);
	return lines.join("\n");
}

export function reviewPrompt(task, changed, gate) {
	return [
		`REVIEW ${task.id}: read-only review of a harness change. Do not edit files.`,
		`Goal: ${task.subject}`,
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

const WRITE_TOOLS = ["edit", "write"];

// Each child result of one subagent call: role, outcome and bounded diagnostics. A child with no assistant turn is a failed attempt, not a measured workload.
function launchRecords(details, limit) {
	const results = Array.isArray(details?.results) ? details.results : [];
	if (results.length === 0) return [{ agent: null, status: "unreported", turns: null }];
	return results.map((r) => {
		const turns = Number.isFinite(r?.usage?.turns) ? r.usage.turns : null;
		return {
			agent: typeof r?.agent === "string" ? r.agent : null,
			status: turns === null ? "unreported" : turns === 0 ? "no-child-turn" : "measured",
			turns, exitCode: Number.isInteger(r?.exitCode) ? r.exitCode : null,
			stopReason: typeof r?.stopReason === "string" ? r.stopReason : null,
			errorMessage: boundedDiagnostic(r?.errorMessage, limit).text,
			stderrTail: boundedDiagnostic(r?.stderr, limit, { tail: true }).text,
			model: typeof r?.model === "string" ? r.model : null,
			modelTier: r?.modelTier ?? null, modelSlot: r?.modelSlot ?? null,
		};
	});
}

// One main round from its own events: assistant turns, tool names, counts and errors (never arguments), and subagent launches.
function observeRound(events, limit) {
	const tools = {}; const launches = []; let assistantTurns = 0;
	for (const ev of events ?? []) {
		if (ev?.type === "assistant") assistantTurns++;
		else if (ev?.type === "tool") {
			const t = (tools[ev.name] ??= { calls: 0, errors: 0 });
			t.calls++;
			if (ev.isError) { t.errors++; const e = boundedDiagnostic(ev.errorText, limit).text; if (e !== null && t.firstError === undefined) t.firstError = e; }
		} else if (ev?.type === "subagent") launches.push(...launchRecords(ev.details, limit));
	}
	return { assistantTurns, tools, launches };
}

// Method validity of one round, in order. Infrastructure (a launch with no child turn, or no assistant turn) stops the run and nothing is scored.
// A direct main edit or write, or no measured launch of the expected writer, is methodinvalid: it stops before review and never scores as success.
// Other launches (for example debugger) are optional and recorded with their actual role.
export function classifyRound(diag, expectedWriter) {
	const failed = diag.launches.find((l) => l.status !== "measured");
	if (failed) return { class: "infrastructure", kind: "launch_failed", agent: failed.agent, launchStatus: failed.status };
	if (diag.assistantTurns === 0) return { class: "infrastructure", kind: "no_assistant_turn" };
	const writes = WRITE_TOOLS.reduce((s, n) => s + (diag.tools[n]?.calls ?? 0), 0);
	if (writes > 0) return { class: "methodinvalid", kind: "direct_main_write", writes };
	if (!diag.launches.some((l) => l.agent === expectedWriter && l.status === "measured")) return { class: "methodinvalid", kind: "missing_delegation", expectedWriter, launchedAgents: [...new Set(diag.launches.map((l) => l.agent))] };
	return null;
}

// Records one round on the task: tool counts, bounded final text, launch outcomes (with their round) and the writer count.
function noteRound(rec, diag, round, text, limit, expectedWriter) {
	const md = rec.mainDiagnostics;
	md.assistantTurns += diag.assistantTurns;
	for (const [name, t] of Object.entries(diag.tools)) {
		const acc = (md.tools[name] ??= { calls: 0, errors: 0 });
		acc.calls += t.calls; acc.errors += t.errors;
		if (t.firstError !== undefined && acc.firstError === undefined) acc.firstError = t.firstError;
	}
	md.finalText = boundedDiagnostic(text ?? "", limit);
	rec.delegation.launches.push(...diag.launches.map((l) => ({ round, ...l })));
	rec.delegation.writerLaunches += diag.launches.filter((l) => l.agent === expectedWriter && l.status === "measured").length;
}

// Assistant turns feed the main ledger (and the rework ledger during a rework prompt); subagent results feed the worker ledger.
function absorb(events, { main, rework, worker, isRework, served }) {
	for (const ev of events ?? []) {
		if (ev?.type === "assistant") {
			addUsage(main, ev.message?.usage);
			if (isRework) addUsage(rework, ev.message?.usage);
			noteServed(served, ev);
		} else if (ev?.type === "subagent") addWorkerUsage(worker, ev.details);
	}
}

// Served provider/model as reported by the assistant message; a missing value stays absent, never guessed.
function noteServed(served, ev) {
	const { provider, model } = ev.message ?? {};
	if (served && (provider || model)) served.set(`${provider ?? "?"}/${model ?? "?"}`, { provider: provider ?? null, model: model ?? null });
}

// A fresh reviewer session per review, read-only tools, no extensions (see sdk-adapter).
async function runReview({ adapter, dir, task, changed, gate, ledger, runtime, roleSpec }) {
	const session = await adapter.openSession({ cwd: dir, role: "review", compactionEnabled: false, taskId: task.id, runtime, roleSpec });
	const served = new Map();
	try {
		const out = await adapter.prompt(session, reviewPrompt(task, changed, gate));
		for (const ev of out?.events ?? []) {
			if (ev?.type === "assistant") addUsage(ledger, ev.message?.usage);
			noteServed(served, ev);
		}
		return { ...parseReviewOutput(out?.text), text: out?.text ?? "", identity: session.identity ?? null, served: [...served.values()] };
	} finally {
		await adapter.closeSession(session);
	}
}

async function runTask({ task, order, mode, spec, adapter, workspace, acceptance, cap, diagnosticsRun, expectedWriter, runtime, roles, shared, compactionBefore }) {
	const started = Date.now();
	const dir = workspace.dirFor(mode, task);
	// Diagnostic cap precedence: manifest task override > run cap (role default unless a run flag). The winning source is recorded.
	const diagnostics = task.diagnosticChars !== undefined ? { value: task.diagnosticChars, source: `manifest task ${task.id}` } : diagnosticsRun;
	const raw = { main: emptyLedger("model"), rework: emptyLedger("model"), worker: emptyLedger("worker"), review: emptyLedger("model"), served: new Map() };
	const rec = {
		id: task.id, order, tier: task.tier, category: task.category, subject: task.subject, commit: task.commit, parent: task.parent,
		maxReworkRounds: task.maxReworkRounds !== undefined ? { value: task.maxReworkRounds, source: `manifest task ${task.id}` } : cap, status: "running", accepted: false, compactionBefore,
		models: { main: { configured: roles.main, opened: null, served: [] }, reviewer: { configured: roles.reviewer } },
		startContext: null, reworkRounds: 0, reworkTurns: null, main: null, worker: null,
		reviewer: { cycles: [], usage: null }, acceptance: { cycles: [] },
		changedFiles: { changed: [], unrelated: [], missing: [] }, heldOutOverwritten: [], durationMs: null,
		delegation: { expectedWriter, diagnosticChars: diagnostics, writerLaunches: 0, launches: [] }, mainDiagnostics: { tools: {}, assistantTurns: 0, finalText: null },
	};
	let session = null;
	try {
		await workspace.prepare(task, dir);
		const before = await workspace.snapshot(dir);
		if (spec.sessionPolicy === "new-per-task" || shared.session === null) {
			session = await adapter.openSession({ cwd: dir, role: "main", compactionEnabled: false, taskId: task.id, runtime, roleSpec: roles.main });
			if (spec.sessionPolicy !== "new-per-task") shared.session = session;
		} else session = shared.session;
		rec.models.main.opened = session.identity ?? null;
		rec.startContext = contextOf(await adapter.startContext(session));
		let prompt = taskPrompt(task);
		let round = 0;
		for (;;) {
			// Held-out baseline: the state this round's main session receives (the previous round's restored tests), reset every round.
			const prePrompt = await workspace.snapshot(dir);
			const out = await adapter.prompt(session, prompt);
			absorb(out?.events, { ...raw, isRework: round > 0 });
			const diag = observeRound(out?.events, diagnostics.value);
			noteRound(rec, diag, round, out?.text, diagnostics.value, expectedWriter);
			const stop = classifyRound(diag, expectedWriter);
			if (stop) throw new RoundStop({ ...stop, round });
			const afterMain = await workspace.snapshot(dir);
			await workspace.heldOut(task, dir);
			const afterHeld = await workspace.snapshot(dir);
			const overwritten = task.acceptanceTests.filter((p) => afterMain.get(p) !== prePrompt.get(p)).sort();
			const d = workspace.diff(before, afterHeld);
			const changed = [...d.added, ...d.modified, ...d.removed].filter((p) => !task.acceptanceTests.includes(p)).sort();
			const unrelated = changed.filter((p) => !task.allowedFiles.includes(p));
			const gate = await acceptance({ cwd: dir, files: task.acceptanceTests, runner: task.acceptanceRunner ?? "node" });
			const testsPassed = gate.accepted === true;
			rec.acceptance.cycles.push({ round, testsPassed, exitCode: gate.exitCode ?? null, pass: gate.pass ?? null, fail: gate.fail ?? null, reason: gate.reason, outputTail: gate.outputTail, heldOutOverwritten: overwritten });
			const review = await runReview({ adapter, dir, task, changed, gate: { accepted: testsPassed }, ledger: raw.review, runtime, roleSpec: roles.reviewer });
			rec.reviewer.cycles.push({ round, status: review.status, findings: review.findings, highCount: review.highCount, text: review.text, identity: review.identity, evaluator: evaluatorOf(review.identity), served: review.served });
			rec.changedFiles = { changed, unrelated, missing: task.allowedFiles.filter((p) => !changed.includes(p)) };
			rec.heldOutOverwritten = [...overwritten].sort();
			rec.accepted = testsPassed && unrelated.length === 0;
			const needRework = !rec.accepted || (review.status === "ok" && review.highCount > 0);
			if (!needRework || round >= rec.maxReworkRounds.value) break;
			round++;
			rec.reworkRounds = round;
			prompt = reworkPrompt(task, round, { ...gate, accepted: testsPassed }, review, unrelated);
		}
		rec.reworkRounds = round;
		rec.status = "completed";
	} catch (e) {
		if (e instanceof RoundStop) { rec.status = e.info.class === "infrastructure" ? "infrastructure" : "method_invalid"; rec.invalid = e.info; }
		else if (e.infrastructure === true) { rec.status = "infrastructure"; rec.invalid = { class: "infrastructure", kind: "native_dispatch_unavailable" }; }
		else rec.status = "error";
		rec.error = e.message;
	} finally {
		if (session && spec.sessionPolicy === "new-per-task") await adapter.closeSession(session);
		rec.models.main.served = [...raw.served.values()];
		rec.reworkTurns = ledgerTotals(raw.rework).turns;
		rec.main = ledgerTotals(raw.main);
		rec.worker = ledgerTotals(raw.worker);
		rec.reviewer.usage = ledgerTotals(raw.review);
		rec.durationMs = Date.now() - started;
	}
	return { rec, raw };
}

// Manual compaction between tasks: the only compaction in the compacted arm (auto-compaction is disabled in every arm).
async function compactShared({ adapter, session, ledger }) {
	const k = await adapter.compact(session);
	addUsage(ledger, k?.usage);
	return { tokensBefore: k?.tokensBefore ?? null, usage: ledgerTotals(addUsage(emptyLedger("model"), k?.usage)) };
}

const sumNullable = (values) => (values.some((v) => v === null || v === undefined) ? null : values.reduce((s, v) => s + v, 0));

// Totals are sums of raw ledgers; any unavailable part makes the sum unavailable (null), never a partial total.
export function computeTotals(records, raws, compactionLedger) {
	const sum = (key, kind) => raws.reduce((acc, r) => addLedgers(acc, r[key]), emptyLedger(kind));
	const main = ledgerTotals(sum("main", "model"));
	const worker = ledgerTotals(sum("worker", "worker"));
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
export async function runBenchmark({ manifest, mode, adapter, workspace, acceptance = runAcceptance, config = {}, writeResult = () => {}, now = () => new Date().toISOString() }) {
	const spec = MODES[mode];
	if (!spec) throw new Error(`unknown mode "${mode}"; use one of ${Object.keys(MODES).join(", ")}`);
	validateManifest(manifest);
	assertCap(config.maxReworkRounds, "config.maxReworkRounds");
	assertCap(config.diagnosticChars, "config.diagnosticChars");
	if (!config.roles?.main || !config.roles?.reviewer) throw new Error("config.roles.main and config.roles.reviewer are required (the configured identities)");
	if (!config.runtime?.fingerprint) throw new Error("config.runtime is required: the candidate runtime identity");
	const desc = adapter.describe();
	const result = {
		schemaVersion: RESULT_SCHEMA_VERSION, mode, order: manifest.tasks.map((t) => t.id), manifestDigest: manifestDigest(manifest), expectedWriter: manifest.expectedWriter,
		synthetic: desc.synthetic === true,
		config: {
			maxReworkRounds: config.maxReworkRounds, diagnosticChars: config.diagnosticChars, sessionPolicy: spec.sessionPolicy, compaction: spec.compaction, reviewer: "fresh-session-per-review",
			roles: { main: config.roles.main, reviewer: config.roles.reviewer },
			registry: config.registry ?? null,
			runtime: { root: config.runtime.root ?? null, extensions: config.runtime.extensions ?? null, fingerprint: config.runtime.fingerprint, endFingerprint: null },
		},
		environment: { node: process.version, platform: process.platform, arch: process.arch, adapter: desc },
		status: "running", startedAt: now(), finishedAt: null, compactionFailures: [], tasks: [], notRun: [], totals: null,
	};
	const raws = [];
	const compactionLedger = emptyLedger("model");
	const shared = { session: null };
	try {
		for (let i = 0; i < manifest.tasks.length; i++) {
			const task = manifest.tasks[i];
			let compactionBefore = null;
			if (spec.compaction === "manual-between-tasks" && i > 0) {
				try {
					compactionBefore = await compactShared({ adapter, session: shared.session, ledger: compactionLedger });
				} catch (e) {
					result.compactionFailures.push({ beforeTask: task.id, error: e.message });
					throw e;
				}
			}
			const { rec, raw } = await runTask({ task, order: i + 1, mode, spec, adapter, workspace, acceptance, cap: config.maxReworkRounds, diagnosticsRun: config.diagnosticChars, expectedWriter: manifest.expectedWriter, runtime: config.runtime, roles: config.roles, shared, compactionBefore });
			result.tasks.push(rec);
			raws.push(raw);
			writeResult(result);
			// Infrastructure or methodinvalid: stop here (no further tasks), keep the partial results, and the run is not complete.
			if (rec.status === "infrastructure" || rec.status === "method_invalid") {
				result.status = "invalid";
				result.error = `task ${task.id} ${rec.status}: ${rec.invalid.kind}`;
				result.invalid = { task: task.id, class: rec.invalid.class, kind: rec.invalid.kind };
				break;
			}
			if (rec.status !== "completed") throw new Error(`task ${task.id} ${rec.status}: ${rec.error}`);
		}
		if (result.status === "running") result.status = "complete";
	} catch (e) {
		result.status = "failed";
		result.error = e.message;
	} finally {
		if (shared.session) await adapter.closeSession(shared.session);
		shared.session = null;
	}
	result.notRun = manifest.tasks.slice(result.tasks.length).map((t) => t.id);
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
