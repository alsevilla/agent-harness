// Long-mode continuation after a genuine, confirmed deadline cut: the run keeps going from the faithful restored history (fake adapter, no SDK/provider/model).
// The adapter-level restore (real SessionManager data, new id, ownership) is in sdk-adapter.test.mjs (C1-C3).
import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { runBenchmark } from "./lib/runner.mjs";
import { compareResults } from "./lib/compare.mjs";
import { task, manifest, root, fakeWorkspace, gate, fakeAdapter, fixMain, fixtureConfig } from "./fixtures/fake-runtime.mjs";

const hang = () => new Promise(() => {});
const cfg = (timeout = 400, grace = 100, over = {}) => fixtureConfig({ limits: { roundSettleTimeoutMs: { value: 600000, source: "t" }, shutdownGraceMs: { value: grace, source: "t" }, taskTimeoutMs: { value: timeout, source: "t" } }, ...over });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// The first main prompt hangs until its session is closed (what the real adapter does through session.abort), so the drain is confirmed; every other prompt fixes the task.
function cutFirst(extra = {}) {
	let first = true;
	const ad = fakeAdapter({ mainScript: (s, text) => (first ? ((first = false), new Promise((r) => { s.release = () => r({ events: [], text: "" }); })) : fixMain(s, text)), ...extra });
	const close = ad.closeSession;
	ad.closeSession = async (s) => { s.release?.(); return close(s); };
	return ad;
}
const run = (tasks, mode, adapter, o = {}) => runBenchmark({ manifest: manifest(tasks), mode, adapter, workspace: o.workspace ?? fakeWorkspace(root()), acceptance: gate, config: o.config ?? cfg() });
const mainOpens = (ad) => ad.log.filter((e) => e[0] === "open" && e[2] === "main");
const T = () => [task("H1"), task("H2"), task("H3")];

test("long-fixed: a confirmed cut of H1 continues H2 and H3 from the restored history under a new session, with the shared workspace rematerialised only after the old close", async () => {
	const base = fakeWorkspace(root()); let ad;
	const workspace = { ...base, async prepare(t, d, o) { ad.log.push(["prepare", t.id]); return base.prepare(t, d, o); } };
	ad = cutFirst();
	const r = await run(T(), "long-fixed", ad, { workspace });
	assert.deepEqual(r.tasks.map((t) => [t.id, t.status, t.accepted]), [["H1", "budget_exhausted", false], ["H2", "completed", true], ["H3", "completed", true]]);
	assert.deepEqual(r.notRun, []);
	assert.equal(r.status, "unfinished");
	assert.deepEqual(r.budgetExhausted, ["H1"]);
	assert.equal(r.tasks[0].shutdown.confirmed, true);
	assert.equal(mainOpens(ad).length, 2, "one replacement session, reused for H3");
	assert.equal(mainOpens(ad)[1][4], 2, "seeded with the 2 entries of the first session");
	assert.equal(r.tasks[1].startContext.messageCount, 1, "the restored context is measured, not guessed");
	assert.deepEqual(r.tasks[1].continuation, { policy: "faithful-history-restore/1", restored: { fromTaskId: "H1", entryCount: 2, appendedOnOpen: 0, newSessionId: true }, captured: null, stop: null });
	assert.deepEqual(r.tasks[0].continuation.captured, { entryCount: 2 });
	assert.equal(r.tasks[2].continuation, undefined, "H3 reuses the stable session: nothing restored");
	const i = (pred) => ad.log.findIndex(pred);
	assert.ok(i((e) => e[0] === "close" && e[1] === 1) < i((e) => e[0] === "snapshot"), "snapshot after the confirmed close");
	assert.ok(i((e) => e[0] === "snapshot") < i((e) => e[0] === "prepare" && e[1] === "H2"), "the shared workspace is wiped only after the old runtime is gone");
	assert.equal(r.config.continuation.policy, "faithful-history-restore/1");
	assert.equal(r.tasks[1].models.main.opened.selected.model, "fake/main-model");
});

test("long-compacted: open(seed) -> compact -> prompt, inside the next task's budget; compaction usage counted", async () => {
	const ad = cutFirst();
	const r = await run(T(), "long-compacted", ad);
	assert.deepEqual(r.tasks.map((t) => t.status), ["budget_exhausted", "completed", "completed"]);
	assert.deepEqual(r.notRun, []);
	const seq = ad.log.filter((e) => e[2] !== "review" && ["open", "compact", "prompt", "snapshot"].includes(e[0])).map((e) => e[0] === "open" ? (e[4] ? "O*" : "O") : e[0] === "compact" ? "C" : e[0] === "snapshot" ? "S" : "P");
	assert.deepEqual(seq, ["O", "P", "S", "O*", "C", "P", "C", "P"], "H1 cut -> snapshot -> restored open -> compaction -> prompt, then the next compaction on the same session");
	assert.equal(r.tasks[1].compactionBefore.tokensBefore, 900);
	assert.equal(r.totals.compaction.calls, 2);
	assert.equal(r.tasks[1].continuation.restored.fromTaskId, "H1");
});

test("long-compacted: a cut reopening (open ignores the abort) is owned and disposed; the snapshot is kept and the next task restores from it", async () => {
	const ad = cutFirst(); const open = ad.openSession; let n = 0;
	ad.openSession = async (o) => { if (o.role === "main" && o.history && ++n === 1) await sleep(350); return open(o); };
	const r = await run(T(), "long-compacted", ad);
	assert.equal(r.tasks[1].budget.stage, "session_open");
	assert.equal(r.tasks[1].shutdown.confirmed, true);
	assert.ok(ad.log.some((e) => e[0] === "close" && e[1] === 2), "the late replacement session was disposed");
	assert.equal(ad.log.filter((e) => e[0] === "prompt" && e[1] === 2).length, 0, "never prompted");
	assert.equal(r.tasks[2].status, "completed");
	assert.equal(mainOpens(ad).filter((e) => e[4]).length, 2, "H3 restored from the retained H1 snapshot again");
	assert.deepEqual(r.notRun, []);
});

test("a cut before any session exists continues with a first fresh open (nothing to restore); a cut before the stable session is reached keeps that session", async () => {
	const base = fakeWorkspace(root()); let calls = 0;
	const slowFirst = { ...base, async prepare(t, d, o) { if (++calls === 1) await sleep(350); return base.prepare(t, d, o); } };
	const ad = fakeAdapter({ mainScript: fixMain });
	const r = await run(T(), "long-fixed", ad, { workspace: slowFirst });
	assert.equal(r.tasks[0].budget.stage, "workspace_prepare");
	assert.equal(r.tasks.length, 3);
	assert.equal(mainOpens(ad).length, 1);
	assert.equal(mainOpens(ad)[0][4], null);
	// H2 cut at prepare while H1's session is still open and quiescent: it is kept and reused, no snapshot.
	let k = 0; const slowSecond = { ...base, async prepare(t, d, o) { if (++k === 2) await sleep(350); return base.prepare(t, d, o); } };
	const ad2 = fakeAdapter({ mainScript: fixMain });
	const r2 = await run(T(), "long-fixed", ad2, { workspace: slowSecond });
	assert.equal(r2.tasks[1].budget.stage, "workspace_prepare");
	assert.equal(r2.tasks.length, 3);
	assert.equal(mainOpens(ad2).length, 1);
	assert.equal(ad2.log.filter((e) => e[0] === "snapshot").length, 0);
});

for (const [name, tweak, reason] of [
	["an unconfirmed close", (ad) => { const c = ad.closeSession; ad.closeSession = async (s) => { await c(s); return { confirmed: false }; }; }, "shutdown_unconfirmed"],
	["an adapter without the restore capability", null, "adapter_history_unsupported"],
	["a snapshot that throws", (ad) => { ad.snapshotHistory = () => { throw new Error("RAW boom"); }; }, "history_snapshot_failed"],
	["an invalid snapshot", (ad) => { ad.snapshotHistory = () => ({ entryCount: -1 }); }, "history_snapshot_invalid"],
]) {
	test(`long-fixed stops explicitly (no fake history, no empty session) for ${name}`, async () => {
		const ad = cutFirst(name === "an adapter without the restore capability" ? { history: false } : {});
		tweak?.(ad);
		const r = await run(T(), "long-fixed", ad);
		assert.deepEqual(r.tasks.map((t) => t.id), ["H1"]);
		assert.deepEqual(r.notRun, ["H2", "H3"]);
		assert.equal(r.status, "unfinished");
		assert.equal(mainOpens(ad).length, 1, "no replacement session");
		if (reason === "shutdown_unconfirmed") assert.equal(r.shutdownUnconfirmed.task, "H1");
		else { assert.deepEqual(r.continuationStop, { task: "H1", reason }); assert.equal(r.tasks[0].continuation.stop.reason, reason); assert.match(r.error, new RegExp(reason)); }
		assert.equal(JSON.stringify(r).includes("RAW boom"), false);
	});
}

test("pending operations after the close, infrastructure, method and ordinary errors never reach the continuation path", async () => {
	const hung = fakeAdapter({ mainScript: hang });
	const a = await run(T(), "long-fixed", hung);
	assert.deepEqual(a.notRun, ["H2", "H3"]);
	assert.equal(a.tasks[0].shutdown.confirmed, false);
	assert.equal(hung.log.filter((e) => e[0] === "snapshot").length, 0, "no snapshot of an unconfirmed shutdown");
	for (const err of [Object.assign(new Error("x"), { infrastructure: true, kind: "native_dispatch_unavailable" }), new Error("boom")]) {
		const ad = fakeAdapter({ mainScript: () => { throw err; } });
		const r = await run(T(), "long-fixed", ad);
		assert.deepEqual(r.tasks.map((t) => t.id), ["H1"]);
		assert.equal(r.tasks[0].budget.exhausted, false);
		assert.equal(ad.log.filter((e) => e[0] === "snapshot").length, 0);
		assert.equal(r.tasks[0].continuation, undefined);
		assert.notEqual(r.status, "unfinished");
	}
});

test("an adapter that does not prove the restore fails the run closed: no empty session is prompted", async () => {
	const ad = cutFirst(); const open = ad.openSession;
	ad.openSession = async (o) => { const s = await open(o); if (o.history) delete s.restored; return s; };
	const r = await run(T(), "long-fixed", ad);
	assert.equal(r.status, "failed");
	assert.match(r.error, /history restore was not confirmed/);
	assert.equal(r.tasks[1].status, "error");
	assert.equal(r.tasks[1].continuation.stop.reason, "history_restore_failed");
	assert.equal(ad.log.filter((e) => e[0] === "prompt" && e[1] === 2).length, 0);
	assert.ok(ad.log.some((e) => e[0] === "close" && e[1] === 2), "the unproven session was closed");
	assert.deepEqual(r.notRun, ["H3"]);
});

test("the restore seed stays in memory: no raw history in the result, and a snapshot is taken once per cut", async () => {
	const ad = cutFirst(); const snap = ad.snapshotHistory;
	ad.snapshotHistory = (s) => ({ ...snap(s), data: { calls: s.calls, tail: "RAWTRANSCRIPT" } });
	const r = await run(T(), "long-fixed", ad);
	assert.equal(JSON.stringify(r).includes("RAWTRANSCRIPT"), false);
	assert.equal(ad.log.filter((e) => e[0] === "snapshot").length, 1);
});

test("two cuts in a row: each is snapshotted from the session that held it, and later history includes the earlier one", async () => {
	let n = 0;
	const ad = fakeAdapter({ mainScript: (s, text) => (++n <= 2 ? new Promise((r) => { s.release = () => r({ events: [], text: "" }); }) : fixMain(s, text)) });
	const close = ad.closeSession; ad.closeSession = async (s) => { s.release?.(); return close(s); };
	const r = await run(T(), "long-fixed", ad);
	assert.deepEqual(r.tasks.map((t) => t.status), ["budget_exhausted", "budget_exhausted", "completed"]);
	assert.deepEqual(r.budgetExhausted, ["H1", "H2"]);
	assert.deepEqual(mainOpens(ad).map((e) => e[4]), [null, 2, 3]);
	assert.equal(r.tasks[2].continuation.restored.fromTaskId, "H2");
});

test("fresh mode is unchanged: no snapshot, no continuation field, no continuation config", async () => {
	const ad = cutFirst();
	const r = await run([task("H1"), task("H2")], "fresh", ad);
	assert.equal(r.tasks.length, 2);
	assert.equal(ad.log.filter((e) => e[0] === "snapshot").length, 0);
	assert.ok(r.tasks.every((t) => t.continuation === undefined));
	assert.equal("continuation" in r.config, false);
	assert.equal(mainOpens(ad).every((e) => e[4] === null), true);
});

test("compare: the continuation policy is only required for long modes; fresh is not applicable and a long mismatch is inconclusive", async () => {
	const fresh = await run([task("H1")], "fresh", fakeAdapter({ mainScript: fixMain }));
	const a = compareResults(fresh, structuredClone(fresh));
	assert.equal(a.inconclusive.some((x) => /continuation/.test(x)), false);
	const long = await run([task("H1")], "long-fixed", fakeAdapter({ mainScript: fixMain }));
	assert.equal(compareResults(long, structuredClone(long)).inconclusive.some((x) => /continuation/.test(x)), false);
	const other = structuredClone(long); delete other.config.continuation;
	assert.ok(compareResults(long, other).inconclusive.some((x) => /continuation policy/.test(x)));
	assert.equal(a.appliedPolicy.continuation.baseline, "not-applicable");
});

// ---- review-1 corrections: no compaction of a nonexistent session; no continuation from a snapshot that completed past the ORIGINAL deadline ----
const LONG = ["long-fixed", "long-compacted"];
const clocked = () => { const c = { time: 0 }; c.now = () => c.time; return c; };
const compactCalls = (ad) => ad.log.filter((e) => e[0] === "compact");
// Prepare of the numbered calls overruns the whole work window on the injected clock (a confirmed structured cut before any session of that task exists).
const prepareCut = (c, which) => { const base = fakeWorkspace(root()); let n = 0; return { ...base, async prepare(t, d, o) { const p = await base.prepare(t, d, o); if (which.includes(++n)) c.time += 301; return p; } }; };
// The first main prompt returns at 301ms with its settlement timed out (the runner's main_settlement cut); every other prompt fixes the task.
const settleCut = (c, extra = {}) => { let first = true; return fakeAdapter({ mainScript: (s, text) => (first ? ((first = false), (c.time += 301), { ...fixMain(s, text), settlement: { timedOut: true } }) : fixMain(s, text)), ...extra }); };

for (const mode of LONG) {
	test(`${mode}: a cut before the first session exists opens a first session for the next task (no compaction of a nonexistent session)`, async () => {
		const c = clocked(); const ad = fakeAdapter({ mainScript: fixMain });
		const r = await run(T(), mode, ad, { workspace: prepareCut(c, [1]), config: cfg(400, 100, { clock: c.now }) });
		assert.deepEqual(r.tasks.map((t) => [t.status, t.budget.stage]), [["budget_exhausted", "workspace_prepare"], ["completed", null], ["completed", null]]);
		assert.equal(r.status, "unfinished"); assert.deepEqual(r.notRun, []);
		assert.equal(r.tasks[1].compactionBefore, null);
		assert.equal(compactCalls(ad).length, mode === "long-compacted" ? 1 : 0, "only H3 compacts, on the session H2 opened");
		assert.equal(mainOpens(ad).length, 1); assert.equal(mainOpens(ad)[0][4], null, "nothing existed to restore");
		assert.equal(ad.log.filter((e) => e[0] === "snapshot").length, 0);
		assert.equal(r.continuationStop, undefined); assert.deepEqual(r.compactionFailures, []);
	});

	test(`${mode}: repeated cuts before any session exists still reach the first open`, async () => {
		const c = clocked(); const ad = fakeAdapter({ mainScript: fixMain });
		const r = await run([...T(), task("H4")], mode, ad, { workspace: prepareCut(c, [1, 2]), config: cfg(400, 100, { clock: c.now }) });
		assert.deepEqual(r.tasks.map((t) => t.status), ["budget_exhausted", "budget_exhausted", "completed", "completed"]);
		assert.equal(compactCalls(ad).length, mode === "long-compacted" ? 1 : 0);
		assert.equal(mainOpens(ad).length, 1);
		assert.deepEqual(r.notRun, []);
	});

	test(`${mode}: main_settlement cut continues from the faithful history`, async () => {
		const c = clocked(); const ad = settleCut(c);
		const r = await run(T(), mode, ad, { config: cfg(400, 100, { clock: c.now }) });
		assert.equal(r.tasks[0].budget.stage, "main_settlement");
		assert.deepEqual(r.tasks.map((t) => t.status), ["budget_exhausted", "completed", "completed"]);
		assert.equal(mainOpens(ad)[1][4], 2);
		assert.equal(r.tasks[1].continuation.restored.fromTaskId, "H1");
		assert.equal(compactCalls(ad).length, mode === "long-compacted" ? 2 : 0);
	});

	test(`${mode}: main_prompt cut continues from the faithful history`, async () => {
		const ad = cutFirst();
		const r = await run(T(), mode, ad);
		assert.equal(r.tasks[0].budget.stage, "main_prompt");
		assert.deepEqual(r.tasks.map((t) => t.status), ["budget_exhausted", "completed", "completed"]);
		assert.equal(r.tasks[1].continuation.restored.entryCount, 2);
	});

	// The cut is at 301ms of 400: 98 and 97.5 leave 1 and 1.5ms (accepted); 98.5 (0.5ms left), exactly 99 and later are late (under one whole ms is no budget).
	for (const [ms, late] of [[50, false], [97.5, false], [98, false], [98.5, true], [99, true], [200, true]]) {
		test(`${mode}: a snapshot that completes ${ms}ms after the cut is ${late ? "discarded past" : "accepted inside"} the original deadline`, async () => {
			const c = clocked(); const ad = settleCut(c); const snap = ad.snapshotHistory;
			ad.snapshotHistory = (s) => { const h = snap(s); c.time += ms; return { ...h, data: { ...h.data, tail: "RAWTRANSCRIPT" } }; };
			const r = await run(T(), mode, ad, { config: cfg(400, 100, { clock: c.now }) });
			assert.equal(JSON.stringify(r).includes("RAWTRANSCRIPT"), false);
			assert.equal(r.tasks[0].status, "budget_exhausted"); assert.equal(r.tasks[0].budget.stage, "main_settlement"); assert.equal(r.tasks[0].shutdown.confirmed, true);
			if (late) {
				assert.deepEqual(r.tasks.map((t) => t.id), ["H1"]); assert.deepEqual(r.notRun, ["H2", "H3"]);
				assert.deepEqual(r.continuationStop, { task: "H1", reason: "snapshot_after_task_deadline" });
				assert.equal(r.tasks[0].continuation.captured, null); assert.equal(r.tasks[0].continuation.stop.reason, "snapshot_after_task_deadline");
				assert.equal(mainOpens(ad).length, 1, "no replacement session from the late snapshot");
				assert.equal(ad.log.filter((e) => e[0] === "close" && e[1] === 1).length, 1, "the closed session is not disposed again");
			} else {
				assert.deepEqual(r.notRun, []); assert.equal(r.tasks[1].status, "completed"); assert.deepEqual(r.tasks[0].continuation.captured, { entryCount: 2 });
			}
		});
	}
}

test("long-fixed: an earlier snapshot survives a later cut before that task opened a session", async () => {
	const ad = cutFirst(); const base = fakeWorkspace(root()); let k = 0;
	const slow = { ...base, async prepare(t, d, o) { if (++k === 2) await sleep(350); return base.prepare(t, d, o); } };
	const r = await run(T(), "long-fixed", ad, { workspace: slow });
	assert.deepEqual(r.tasks.map((t) => t.status), ["budget_exhausted", "budget_exhausted", "completed"]);
	assert.equal(r.tasks[1].budget.stage, "workspace_prepare");
	assert.deepEqual(mainOpens(ad).map((e) => e[4]), [null, 2], "H3 restores the retained H1 snapshot; no empty session is ever substituted");
	assert.equal(r.tasks[2].continuation.restored.fromTaskId, "H1");
});

test("long-compacted: a compaction cut is owned, snapshotted from the reopened session and restored again; a failed restore never compacts", async () => {
	const ad = cutFirst(); const compact = ad.compact; let n = 0;
	ad.compact = async (...a) => { if (++n === 1) await sleep(350); return compact(...a); };
	const r = await run(T(), "long-compacted", ad);
	assert.equal(r.tasks[1].budget.stage, "compaction"); assert.equal(r.tasks[1].shutdown.confirmed, true);
	assert.equal(r.tasks[2].status, "completed"); assert.equal(r.tasks[2].continuation.restored.fromTaskId, "H2");
	const bad = cutFirst(); const open = bad.openSession;
	bad.openSession = async (o) => { if (o.history) throw new Error("restore boom"); return open(o); };
	const f = await run(T(), "long-compacted", bad);
	assert.equal(f.status, "failed"); assert.match(f.error, /restore boom/);
	assert.equal(compactCalls(bad).length, 0); assert.equal(mainOpens(bad).length, 1, "no empty session in place of the history");
	assert.deepEqual(f.notRun, ["H2", "H3"].slice(f.tasks.length - 1));
});

// ---- review-2 correction: compaction applicability from the SDK's own public context data (actual adapter, source-shaped FAKE SDK, real SessionManager data container; no AgentSession/provider) ----
// The fake factory follows the installed SDK 1.4 sdk.js startup (model/thinking METADATA entries only when the context has no messages) and its compact() preconditions
// (agent-session.js manual compact: last branch entry a compaction -> "Already compacted"; no context to summarize -> "Nothing to compact (session too small)").
import fs from "node:fs";
import os from "node:os";
import { pathToFileURL } from "node:url";
import { createPiSdkAdapter } from "./lib/sdk-adapter.mjs";
import { u } from "./fixtures/fake-runtime.mjs";
const SM_PATH = path.join(process.env.PI_PACKAGE_ROOT ?? path.join(os.homedir(), ".pi", "agent", "install", "releases", "1.4.0", "node_modules", "@earendil-works", "pi-coding-agent"), "dist", "core", "session-manager.js");
const haveSM = fs.existsSync(SM_PATH);
const SessionManager = haveSM ? (await import(pathToFileURL(SM_PATH).href)).SessionManager : null;
const userMsg = (text) => ({ role: "user", content: text, timestamp: 1 });
const asstMsg = (text, stopReason = "stop") => ({ role: "assistant", content: [{ type: "text", text }], provider: "p", model: "m", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason, timestamp: 2 });
// opts.seed(sm, n): extra history the n-th created session already has (what a prompt would have added); opts.cuts: startContext calls after which the work cutoff passes;
// opts.compactError: a real compaction/provider failure on a nonempty context; opts.noApplicability: a manager exposing no context data.
async function sdkRun(opts = {}) {
	const dir = fs.mkdtempSync(path.join(process.env.TEMP ?? os.tmpdir(), "ctxapp-"));
	fs.mkdirSync(path.join(dir, "participant", "agent", "agents"), { recursive: true });
	fs.writeFileSync(path.join(dir, "participant", "agent", "agents", "general-worker.md"), "---\nname: general-worker\n---\n");
	const sessions = []; const log = []; let time = 0; let starts = 0;
	class Loader { async reload() {} getAgentsFiles() { return { agentsFiles: [] }; } getSkills() { return { skills: [] }; } }
	const sdk = {
		SessionManager, SettingsManager: { inMemory: (x) => x }, getAgentDir: () => path.join(dir, "profile"), DefaultResourceLoader: Loader,
		ModelRuntime: { create: async () => ({ getModel: (provider, id) => ({ provider, id, contextWindow: 10000 }), hasConfiguredAuth: () => true }) },
		AgentSessionRuntime: class { constructor(s) { this.s = s; } async dispose() { this.s.dispose(); } },
		async createAgentSession(o) {
			const sm = o.sessionManager; const n = sessions.length + 1;
			if (sm.buildSessionContext().messages.length === 0) { sm.appendModelChange(o.model.provider, o.model.id); sm.appendThinkingLevelChange(o.thinkingLevel); }
			opts.seed?.(sm, n);
			if (opts.openAdvance?.[n]) time += opts.openAdvance[n];
			const s = {
				sessionManager: opts.noApplicability ? { getEntries: () => sm.getEntries(), getSessionId: () => sm.getSessionId() } : sm, model: o.model, thinkingLevel: o.thinkingLevel, systemPrompt: "CANARY", disposed: 0,
				get messages() { return sm.buildSessionContext().messages; },
				getActiveToolNames: () => o.tools, getContextUsage: () => ({ tokens: 0, contextWindow: 10000 }), async bindExtensions() {}, subscribe() { return () => {}; }, async abort() {}, dispose() { this.disposed++; },
				async compact() {
					const branch = sm.getBranch(); const ctx = sm.buildSessionContext().messages;
					log.push(["compact", n, ctx.length]);
					if (branch.at(-1)?.type === "compaction") throw new Error("Already compacted");
					if (ctx.length === 0) throw new Error("Nothing to compact (session too small)");
					if (opts.compactError) throw new Error(opts.compactError);
					sm.appendCompaction("summary", branch.find((e) => e.type === "message")?.id ?? null, 500);
					return { tokensBefore: 500, usage: u(30, 10, 0, 0, 0.05) };
				},
				async prompt() { log.push(["prompt", n]); throw new Error("fake sdk: no prompt in this probe"); },
			};
			sessions.push(s); log.push(["open", n, ctxCount(sm)]);
			return { session: s };
		},
	};
	const ctxCount = (sm) => sm.buildSessionContext().messages.length;
	const ad = createPiSdkAdapter({ loadPi: async () => sdk, topology: () => ({ ok: true }), clock: () => time });
	const startContext = ad.startContext;
	ad.startContext = async (s) => { const out = await startContext(s); if (opts.cuts?.includes(++starts)) time += 301; return out; };
	const config = fixtureConfig({ clock: () => time, limits: { taskTimeoutMs: { value: 400, source: "t" }, shutdownGraceMs: { value: 100, source: "t" }, roundSettleTimeoutMs: { value: 600000, source: "t" } } });
	config.runtime = { root: path.join(dir, "participant"), extensions: ["agent/extensions/subagent/index.ts"], fingerprint: "t" };
	const r = await runBenchmark({ manifest: manifest(opts.tasks ?? [task("H1"), task("H2"), task("H3")]), mode: "long-compacted", adapter: ad, workspace: fakeWorkspace(path.join(dir, "workspace")), acceptance: gate, config });
	return { r, log, sessions, compacts: log.filter((e) => e[0] === "compact"), dir };
}
const sk = { skip: !haveSM };
const history = (sm, n) => { if (n === 1) { sm.appendMessage(userMsg("work")); sm.appendMessage(asstMsg("done")); } };

test("review2 RED/GREEN: a first session cut after open but before any prompt (metadata-only context) restores and the next task continues without an unsupported compaction", sk, async () => {
	const { r, compacts, sessions } = await sdkRun({ cuts: [1], tasks: [task("H1"), task("H2")] });
	assert.equal(r.tasks[0].status, "budget_exhausted"); assert.equal(r.tasks[0].shutdown.confirmed, true); assert.equal(r.tasks[0].continuation.captured.entryCount, 2);
	assert.deepEqual(r.compactionFailures, []); assert.equal(r.notRun.includes("H2"), false, "H2 is attempted"); assert.equal(r.tasks.length, 2);
	assert.equal(compacts.length, 0, "no compact() call and no provider work for a context without messages");
	assert.deepEqual(r.tasks[1].compactionBefore, { compactionNotApplicable: "context-empty", tokensBefore: null, usage: null });
	assert.equal(r.totals.compaction.calls, 0, "no bill for a no-op");
	assert.notEqual(sessions[0].sessionManager.getSessionId(), sessions[1].sessionManager.getSessionId());
	assert.deepEqual(sessions.map((s) => s.disposed), [1, 1]);
});

test("review2: repeated empty-context cuts keep restoring the same faithful entries and never compact", sk, async () => {
	const { r, compacts, log } = await sdkRun({ cuts: [1, 2] });
	assert.deepEqual(r.compactionFailures, []); assert.equal(compacts.length, 0);
	assert.deepEqual(r.tasks.slice(0, 2).map((t) => t.status), ["budget_exhausted", "budget_exhausted"]); assert.equal(r.tasks.length, 3);
	assert.deepEqual(log.filter((e) => e[0] === "open").map((e) => e[2]), [0, 0, 0]);
});

test("review2: a context of settings and custom/audit entries only (header-less entry list, no message) is not applicable; no entry is trimmed", sk, async () => {
	const { r, compacts, sessions } = await sdkRun({ cuts: [1], tasks: [task("H1"), task("H2")], seed: (sm, n) => { if (n === 1) sm.appendCustomEntry("audit", { x: 1 }); } });
	assert.equal(compacts.length, 0); assert.deepEqual(r.compactionFailures, []);
	assert.equal(r.tasks[1].compactionBefore.compactionNotApplicable, "context-empty");
	const old = sessions[0].sessionManager.getEntries().map((e) => e.id);
	assert.equal(old.length, 3, "2 settings + the custom entry");
	assert.deepEqual(sessions[1].sessionManager.getEntries().slice(0, 3).map((e) => e.id), old, "all restored in order, none deleted (the SDK itself appends fresh settings on open)");
});

test("review2: a restored session with real history still compacts once (manual compaction is never skipped for threshold); cost is counted", sk, async () => {
	const { r, compacts } = await sdkRun({ cuts: [1], tasks: [task("H1"), task("H2")], seed: history });
	assert.equal(compacts.length, 1); assert.equal(compacts[0][2] > 0, true);
	assert.equal(r.tasks[1].compactionBefore.tokensBefore, 500); assert.equal(r.tasks[1].compactionBefore.compactionNotApplicable, undefined);
	assert.equal(r.totals.compaction.calls, 1);
});

test("review2: an aborted assistant tail is ordinary SDK context (public conversion keeps it), so compaction is attempted and its SDK result decides", sk, async () => {
	const { compacts } = await sdkRun({ cuts: [1], tasks: [task("H1"), task("H2")], seed: (sm, n) => { if (n === 1) { sm.appendMessage(userMsg("work")); sm.appendMessage(asstMsg("partial", "aborted")); } } });
	assert.equal(compacts.length, 1);
});

test("review2: a previously compacted session with no new messages is not compacted again (SDK 'Already compacted'); a new message after it is", sk, async () => {
	// open1 history, cut; H2 compacts (the compaction entry becomes the last entry), cut again; H3 restores that tail: nothing new to compact.
	const { r, compacts } = await sdkRun({ cuts: [1, 2], seed: history });
	assert.equal(compacts.length, 1, "only H2 compacts");
	assert.deepEqual(r.compactionFailures, []); assert.equal(r.tasks[2].compactionBefore.compactionNotApplicable, "already-compacted");
	assert.equal(r.totals.compaction.calls, 1);
});

test("review2: a real compaction/provider error on a nonempty context propagates (fail closed), never swallowed as not applicable", sk, async () => {
	for (const msg of ["provider 429 rate limit", "Nothing to compact (session too small)"]) {
		const { r, compacts } = await sdkRun({ cuts: [1], tasks: [task("H1"), task("H2")], seed: history, compactError: msg });
		assert.equal(compacts.length, 1); assert.equal(r.status, "failed"); assert.equal(r.compactionFailures.length, 1); assert.match(r.compactionFailures[0].error, new RegExp(msg.slice(0, 12)));
		assert.equal(r.totals?.compaction?.calls ?? 0, 0, "no usage is invented for a failed compaction");
	}
});

test("review2: a manager that exposes no context data is not assumed empty; compact() is called and its error propagates", sk, async () => {
	const { r, compacts } = await sdkRun({ cuts: [1], tasks: [task("H1"), task("H2")], noApplicability: true });
	// the manager used by the adapter has no getBranch/buildSessionContext: the fake compact (which reads the real manager) sees the metadata-only context and rejects.
	assert.equal(compacts.length, 1); assert.equal(r.status, "failed"); assert.equal(r.compactionFailures.length, 1);
});

test("review2: a restore that finishes at or after the fractional cutoff skips compaction and applicability; every session is disposed once", sk, async () => {
	const { r, compacts, sessions } = await sdkRun({ cuts: [1], tasks: [task("H1"), task("H2")], seed: history, openAdvance: { 2: 300.5 } });
	assert.equal(compacts.length, 0); assert.equal(r.tasks[1].status, "budget_exhausted");
	assert.deepEqual(sessions.map((s) => s.disposed), [1, 1]);
});
