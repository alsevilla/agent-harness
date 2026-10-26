// Benchmark runner: fixed-order manifest, three session policies, per-task accounting.
// It drives an injected adapter (Pi SDK or synthetic) and a workspace; all session creation goes through that adapter.
import { runAcceptance } from "./acceptance.mjs";
import { validateManifest, manifestDigest } from "./manifest.mjs";
import { addUsage, addWorkerUsage, emptyLedger, ledgerTotals, addLedgers, sumCosts } from "./usage.mjs";
import { evaluatorOf, summarizeEvaluators } from "./evaluator.mjs";

// v2: each reviewer cycle records its effective evaluator (compare requires it); totals.evaluator summarises it. v1 results are not comparable.
export const RESULT_SCHEMA_VERSION = "harness-benchmark-result/2";
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

async function runTask({ task, order, mode, spec, adapter, workspace, acceptance, cap, runtime, roles, shared, compactionBefore }) {
	const started = Date.now();
	const dir = workspace.dirFor(mode, task);
	const raw = { main: emptyLedger("model"), rework: emptyLedger("model"), worker: emptyLedger("worker"), review: emptyLedger("model"), served: new Map() };
	const rec = {
		id: task.id, order, tier: task.tier, category: task.category, subject: task.subject, commit: task.commit, parent: task.parent,
		maxReworkRounds: task.maxReworkRounds !== undefined ? { value: task.maxReworkRounds, source: `manifest task ${task.id}` } : cap, status: "running", accepted: false, compactionBefore,
		models: { main: { configured: roles.main, opened: null, served: [] }, reviewer: { configured: roles.reviewer } },
		startContext: null, reworkRounds: 0, reworkTurns: null, main: null, worker: null,
		reviewer: { cycles: [], usage: null }, acceptance: { cycles: [] },
		changedFiles: { changed: [], unrelated: [], missing: [] }, heldOutOverwritten: [], durationMs: null,
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
		const overwritten = new Set();
		let prompt = taskPrompt(task);
		let round = 0;
		for (;;) {
			const out = await adapter.prompt(session, prompt);
			absorb(out?.events, { ...raw, isRework: round > 0 });
			const afterMain = await workspace.snapshot(dir);
			await workspace.heldOut(task, dir);
			const afterHeld = await workspace.snapshot(dir);
			for (const p of task.acceptanceTests) if (afterMain.get(p) !== afterHeld.get(p)) overwritten.add(p);
			const d = workspace.diff(before, afterHeld);
			const changed = [...d.added, ...d.modified, ...d.removed].filter((p) => !task.acceptanceTests.includes(p)).sort();
			const unrelated = changed.filter((p) => !task.allowedFiles.includes(p));
			const gate = await acceptance({ cwd: dir, files: task.acceptanceTests, runner: task.acceptanceRunner ?? "node" });
			const testsPassed = gate.accepted === true;
			rec.acceptance.cycles.push({ round, testsPassed, exitCode: gate.exitCode ?? null, pass: gate.pass ?? null, fail: gate.fail ?? null, reason: gate.reason, outputTail: gate.outputTail });
			const review = await runReview({ adapter, dir, task, changed, gate: { accepted: testsPassed }, ledger: raw.review, runtime, roleSpec: roles.reviewer });
			rec.reviewer.cycles.push({ round, status: review.status, findings: review.findings, highCount: review.highCount, text: review.text, identity: review.identity, evaluator: evaluatorOf(review.identity), served: review.served });
			rec.changedFiles = { changed, unrelated, missing: task.allowedFiles.filter((p) => !changed.includes(p)) };
			rec.heldOutOverwritten = [...overwritten].sort();
			rec.accepted = testsPassed && unrelated.length === 0;
			const needRework = !rec.accepted || (review.status === "ok" && review.highCount > 0);
			if (!needRework || round >= rec.maxReworkRounds.value) break;
			round++;
			prompt = reworkPrompt(task, round, { ...gate, accepted: testsPassed }, review, unrelated);
		}
		rec.reworkRounds = round;
		rec.status = "completed";
	} catch (e) {
		rec.status = "error";
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
	if (!config.roles?.main || !config.roles?.reviewer) throw new Error("config.roles.main and config.roles.reviewer are required (the configured identities)");
	if (!config.runtime?.fingerprint) throw new Error("config.runtime is required: the candidate runtime identity");
	const desc = adapter.describe();
	const result = {
		schemaVersion: RESULT_SCHEMA_VERSION, mode, order: manifest.tasks.map((t) => t.id), manifestDigest: manifestDigest(manifest),
		synthetic: desc.synthetic === true,
		config: {
			maxReworkRounds: config.maxReworkRounds, sessionPolicy: spec.sessionPolicy, compaction: spec.compaction, reviewer: "fresh-session-per-review",
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
			const { rec, raw } = await runTask({ task, order: i + 1, mode, spec, adapter, workspace, acceptance, cap: config.maxReworkRounds, runtime: config.runtime, roles: config.roles, shared, compactionBefore });
			result.tasks.push(rec);
			raws.push(raw);
			writeResult(result);
			if (rec.status !== "completed") throw new Error(`task ${task.id} ${rec.status}: ${rec.error}`);
		}
		result.status = "complete";
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
