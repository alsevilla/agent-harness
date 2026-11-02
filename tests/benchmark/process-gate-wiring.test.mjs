// Public-seam wiring of the process gate and its compare eligibility: REAL runBenchmark + FAKE adapter (synthetic:false) + REAL createProcessGate with a PURE injected run(). No OS helper, no
// process signal, no SDK/provider/model/network. The fake helper only records the text it is given.
import assert from "node:assert/strict";
import test from "node:test";
import { runBenchmark } from "./lib/runner.mjs";
import { compareResults } from "./lib/compare.mjs";
import { GATE_METHOD, GateFailure, createProcessGate } from "./lib/process-gate.mjs";
import { task, manifest, root, fakeWorkspace, gate, fakeAdapter, fixMain, fixtureConfig } from "./fixtures/fake-runtime.mjs";

const cfg = () => fixtureConfig({ limits: { roundSettleTimeoutMs: { value: 600000, source: "t" }, shutdownGraceMs: { value: 100, source: "t" }, taskTimeoutMs: { value: 400, source: "t" } } });
const RT = [100, 1, "1000"], HP = [999, 100, "5000"], D = [200, 100, "2000"];
const tbl = (rows, kills = []) => `self 999\n${kills.map((k) => `k ${k[0]} ${k[1]}\n`).join("")}${rows.map((r) => `p ${r.join(" ")}\n`).join("")}end\n`;
const cutFirst = () => {
	let first = true;
	const ad = fakeAdapter({ synthetic: false, mainScript: (s, t) => (first ? ((first = false), new Promise((r) => { s.release = () => r({ events: [], text: "" }); })) : fixMain(s, t)) });
	const close = ad.closeSession;
	ad.closeSession = async (s) => { s.release?.(); return close(s); };
	return ad;
};
// The pure helper: answers from a script, logs every call on the adapter timeline, never touches the OS.
const helper = (ad, script) => { const calls = []; const run = async (input) => { calls.push(input); ad.log.push(["helper", input.split("\n")[0].split(" ")[0]]); const x = script.shift(); if (x instanceof Error) throw x; return x; }; run.calls = calls; return run; };
const gateOf = (run, platform = "win32") => createProcessGate({ run, rootPid: 100, platform });
const slowPrepare = (ids, ad) => { const b = fakeWorkspace(root()); return { ...b, async prepare(t, d, o) { ad?.log.push(["prepare", t.id]); if (ids.includes(t.id)) await new Promise((r) => setTimeout(r, 350)); return b.prepare(t, d, o); } }; };
const go = (tasks, ad, pg, { mode = "long-fixed", workspace } = {}) => runBenchmark({ manifest: manifest(tasks), mode, adapter: ad, workspace: workspace ?? slowPrepare([], ad), acceptance: gate, config: cfg(), processGate: pg });
const T3 = () => [task("H1"), task("H2"), task("H3")];
const scripts = {
	quiet: () => [tbl([RT, HP, D]), tbl([RT, HP])],
	terminated: () => [tbl([RT, HP, D]), tbl([RT, HP, D]), tbl([RT, HP], [[200, "terminated"]])],
	naturalExit: () => [tbl([RT, HP, D]), tbl([RT, HP, D]), tbl([RT, HP], [[200, "gone"]])],
	stuck: () => [tbl([RT, HP, D]), tbl([RT, HP, D]), tbl([RT, HP, D], [[200, "terminate_failed"]]), tbl([RT, HP, D], [[200, "terminate_failed"]])],
	// review1 F1: the recorded PID (200, created 2000) is still present after the close but its identity can no longer be read
	unreadable: () => [tbl([RT, HP, D]), tbl([RT, HP, [200, 100, "-"]])],
};
async function scenario(name, tasks = T3()) { const ad = cutFirst(); const run = helper(ad, scripts[name]()); const r = await go(tasks, ad, gateOf(run), { workspace: slowPrepare([], ad) }); return { ad, run, r }; }
const eligible = (r) => { const c = compareResults(structuredClone(r), structuredClone(r)); return { c, ok: c.baselineEligible }; };
const idx = (ad, pred) => ad.log.findIndex(pred);

test("wiring: a confirmed gate runs begin -> close -> finish -> history snapshot -> next prepare; the exact controlled record; an eligible control with UNKNOWN quality", async () => {
	const { ad, run, r } = await scenario("quiet");
	assert.deepEqual(r.tasks.map((t) => t.status), ["budget_exhausted", "completed", "completed"]);
	const order = [idx(ad, (e) => e[0] === "helper"), idx(ad, (e) => e[0] === "close" && e[1] === 1), ad.log.findLastIndex((e) => e[0] === "helper"), idx(ad, (e) => e[0] === "snapshot"), idx(ad, (e) => e[0] === "prepare" && e[1] === "H2")];
	assert.ok(order.every((n, i) => n >= 0 && (i === 0 || order[i - 1] < n)), `order ${order}`);
	assert.equal(run.calls.length, 2, "completed/final transitions never call the helper"); assert.ok(run.calls.every((c) => /^snapshot \d+\n$/.test(c)), "snapshot requests carry the original-deadline tick");
	assert.deepEqual(r.tasks[0].shutdown.processGate, { method: GATE_METHOD, confirmed: true, assessable: true, recorded: 1, attributedAlive: 0, terminated: 0, targeted: 0, remainingAlive: 0, waitMs: r.tasks[0].shutdown.processGate.waitMs, failure: null });
	const { c, ok } = eligible(r);
	assert.equal(ok, true, JSON.stringify(c.inconclusive)); assert.equal(c.verdict, "INCONCLUSIVE"); assert.equal(c.quality.status, "unknown"); assert.deepEqual(c.inconclusive, []);
});

test("wiring: the termination path signals ONLY the recorded fake identity (never root/helper) and is eligible; a natural exit between observations is a legitimate zero-termination proof", async () => {
	const t = await scenario("terminated");
	const term = t.run.calls[2].split("\n").filter(Boolean);
	assert.deepEqual(term, [term[0], "t 200 2000"]); assert.match(term[0], /^terminate 100 \d+ \d+$/);
	assert.ok(!t.run.calls.join("\n").includes("t 100 ") && !t.run.calls.join("\n").includes("t 999 "));
	const g = t.r.tasks[0].shutdown.processGate;
	assert.deepEqual([g.confirmed, g.attributedAlive, g.targeted, g.terminated, g.remainingAlive], [true, 1, 1, 1, 0]);
	assert.ok(idx(t.ad, (e) => e[0] === "snapshot") < idx(t.ad, (e) => e[0] === "prepare" && e[1] === "H2"), "history before the next prepare");
	assert.equal(eligible(t.r).ok, true);
	const n = await scenario("naturalExit");
	const ng = n.r.tasks[0].shutdown.processGate;
	assert.deepEqual([ng.confirmed, ng.attributedAlive, ng.targeted, ng.terminated, ng.remainingAlive], [true, 1, 1, 0, 0], "measured natural exit: alive at the first observation, gone at the final one");
	assert.equal(eligible(n.r).ok, true, JSON.stringify(eligible(n.r).c.inconclusive));
	assert.deepEqual(n.r.tasks.map((x) => x.status), ["budget_exhausted", "completed", "completed"]);
});

test("wiring: a persistent or un-killable attributed process stops the run before history, prepare and a new session; the record keeps the last observed count", async () => {
	const { ad, r } = await scenario("stuck");
	assert.deepEqual(r.notRun, ["H2", "H3"]);
	assert.deepEqual(r.continuationStop, { task: "H1", reason: "quiescence_unconfirmed" });
	assert.equal(ad.log.filter((e) => e[0] === "snapshot").length, 0); assert.equal(ad.log.filter((e) => e[0] === "prepare").length, 1); assert.equal(ad.log.filter((e) => e[0] === "open" && e[2] === "main").length, 1);
	const g = r.tasks[0].shutdown.processGate;
	assert.deepEqual([g.confirmed, g.assessable, g.failure, g.remainingAlive, g.attributedAlive, g.terminated], [false, true, "terminate_failed", 1, 1, 0]);
	assert.equal(r.tasks[0].shutdown.confirmed, true, "the SDK close proof stays separate");
	assert.equal(eligible(r).ok, false);
});

test("F1 wiring: a recorded PID that is still present but unreadable after the close is never confirmed: no signal, no history, no next prepare/session, never eligible", async () => {
	const { ad, run, r } = await scenario("unreadable");
	assert.deepEqual(r.notRun, ["H2", "H3"]); assert.deepEqual(r.continuationStop, { task: "H1", reason: "quiescence_unconfirmed" });
	assert.equal(run.calls.length, 2); assert.ok(run.calls.every((c) => c.startsWith("snapshot")), "the ambiguous identity is never signalled");
	assert.equal(ad.log.filter((e) => e[0] === "snapshot").length, 0); assert.equal(ad.log.filter((e) => e[0] === "prepare").length, 1); assert.equal(ad.log.filter((e) => e[0] === "open" && e[2] === "main").length, 1);
	const g = r.tasks[0].shutdown.processGate;
	assert.deepEqual([g.confirmed, g.failure, g.remainingAlive], [false, "identity_unreadable", null]);
	assert.equal(r.tasks[0].shutdown.confirmed, true, "the SDK close proof stays separate");
	assert.equal(eligible(r).ok, false);
});

test("wiring: a helper timeout/failure at begin or at finish is a controlled record (no raw text), stops the run, and is never eligible", async () => {
	for (const [label, script] of [["begin", [new GateFailure("timeout")]], ["finish", [tbl([RT, HP, D]), new Error("RAW secret helper text")]], ["begin-raw", [new Error("RAW secret helper text")]]]) {
		const ad = cutFirst(); const run = helper(ad, script);
		const r = await go(T3(), ad, gateOf(run), { workspace: slowPrepare([], ad) });
		assert.deepEqual(r.notRun, ["H2", "H3"], label);
		const g = r.tasks[0].shutdown.processGate;
		assert.equal(g.confirmed, false, label); assert.equal(g.remainingAlive, null, label); assert.ok(["timeout", "tool_failed"].includes(g.failure), label);
		assert.equal(JSON.stringify(r).includes("RAW"), false, label);
		assert.equal(ad.log.filter((e) => e[0] === "prepare").length, 1, label);
		assert.equal(eligible(r).ok, false, label);
	}
});

test("wiring: a non-Windows platform is unsupported: the helper is never called and the run stops", async () => {
	const ad = cutFirst(); const run = helper(ad, []);
	const r = await go(T3(), ad, gateOf(run, "linux"), { workspace: slowPrepare([], ad) });
	assert.equal(run.calls.length, 0); assert.deepEqual(r.notRun, ["H2", "H3"]);
	assert.equal(r.tasks[0].shutdown.processGate.failure, "unsupported_platform"); assert.equal(r.continuationStop.reason, "quiescence_unconfirmed");
});

test("wiring: fresh mode, completed transitions and the final task never call the helper; fresh eligibility is unchanged and needs no gate", async () => {
	const ad = cutFirst(); const run = helper(ad, []);
	const f = await go(T3(), ad, gateOf(run), { mode: "fresh" });
	assert.equal(run.calls.length, 0); assert.equal(f.config.continuation, undefined);
	assert.ok(f.tasks.every((t) => t.shutdown.processGate === undefined));
	const cf = eligible(f); assert.equal(cf.ok, true, JSON.stringify(cf.c.inconclusive)); assert.equal(cf.c.quality.status, "unknown");
	const ad2 = fakeAdapter({ synthetic: false, mainScript: fixMain }); const run2 = helper(ad2, []);
	await go(T3(), ad2, gateOf(run2)); assert.equal(run2.calls.length, 0, "no cut: no gate");
	const ad3 = cutFirst(); const run3 = helper(ad3, []);
	const one = await go([task("H1")], ad3, gateOf(run3)); assert.equal(run3.calls.length, 0, "the final close is outside the gate"); assert.equal(one.tasks[0].shutdown.processGate, undefined);
	assert.equal(eligible(one).ok, true, "a final cut needs no proof");
	// an old fresh result that is merely labelled Windows pi-sdk is untouched (fresh is not applicable)
	const legacy = structuredClone(f); legacy.environment.platform = "win32"; legacy.environment.adapter.name = "pi-sdk";
	assert.equal(compareResults(legacy, structuredClone(legacy)).attemptCoverage.candidate.eligible, true);
});

test("wiring: a cut before any session opened, and a cut that leaves a RETAINED LIVE session alone, carry the no-session marker, call no helper, and are eligible", async () => {
	for (const [label, ids, at] of [["initial pre-session cut", ["H1"], 0], ["retained live session cut", ["H2"], 1]]) {
		const ad = fakeAdapter({ synthetic: false, mainScript: fixMain }); const run = helper(ad, []);
		const r = await go(T3(), ad, gateOf(run), { workspace: slowPrepare(ids, ad) });
		assert.equal(r.tasks[at].status, "budget_exhausted", label); assert.equal(r.tasks[at].budget.stage, "workspace_prepare", label);
		assert.deepEqual(r.tasks[at].shutdown.processGate, { method: GATE_METHOD, applicable: false, reason: "no_session_closed" }, label);
		assert.equal(run.calls.length, 0, label);
		assert.equal(ad.log.filter((e) => e[0] === "open" && e[2] === "main").length, 1, `${label}: one shared main session, never replaced (a retained session is not gated or closed at the cut)`);
		assert.equal(eligible(r).ok, true, label);
		assert.equal(r.tasks.filter((t) => t.shutdown.processGate).length, 1, "only the cut transition carries a marker");
	}
});

const sides = ["candidate", "baseline"];
const check = (c, side, label) => { assert.equal(c.attemptCoverage[side].eligible, false, `${label}: per-side`); assert.equal(c.baselineEligible, false, `${label}: overall`); assert.ok(c.attemptCoverage[side].reasons.some((x) => /process gate/.test(x)), `${label}: ${JSON.stringify(c.attemptCoverage[side].reasons)}`); };
const pg = (r) => r.tasks[0].shutdown.processGate;
const contradictions = {
	"confirmed false": (r) => { pg(r).confirmed = false; },
	"assessable false": (r) => { pg(r).assessable = false; },
	"failure tool_failed + unconfirmed": (r) => { pg(r).failure = "tool_failed"; pg(r).confirmed = false; },
	"failure set but confirmed": (r) => { pg(r).failure = "tool_failed"; },
	"method other": (r) => { pg(r).method = "other/1"; },
	"platform not windows": (r) => { r.environment.platform = "linux"; },
	"remaining alive 1": (r) => { pg(r).remainingAlive = 1; },
	"remaining missing": (r) => { delete pg(r).remainingAlive; },
	"remaining null": (r) => { pg(r).remainingAlive = null; },
	"initial alive 3 (recorded 1)": (r) => { pg(r).attributedAlive = 3; },
	"alive negative": (r) => { pg(r).attributedAlive = -1; },
	"alive non-integer": (r) => { pg(r).attributedAlive = 1.5; },
	"alive string": (r) => { pg(r).attributedAlive = "0"; },
	"recorded negative": (r) => { pg(r).recorded = -1; },
	"recorded missing": (r) => { delete pg(r).recorded; },
	"terminated above targeted": (r) => { pg(r).terminated = pg(r).targeted + 1; },
	"targeted missing": (r) => { delete pg(r).targeted; },
	"waitMs NaN": (r) => { pg(r).waitMs = Number.NaN; },
	"extra identifying key": (r) => { pg(r).pid = 4242; },
	"record deleted": (r) => { delete r.tasks[0].shutdown.processGate; },
	"record null": (r) => { r.tasks[0].shutdown.processGate = null; },
	"root policy deleted": (r) => { delete r.config.continuation.gate; },
	"root policy mismatched": (r) => { r.config.continuation.gate = "other/1"; },
	"marker replaces a proof on a worked cut": (r) => { r.tasks[0].shutdown.processGate = { method: GATE_METHOD, applicable: false, reason: "no_session_closed" }; },
};
test("compare: the genuine controls are eligible (true, quality unknown) and EVERY contradiction makes the side AND the overall baseline ineligible, on either side, with cached labels still good", async () => {
	const runs = { quiet: (await scenario("quiet")).r, terminated: (await scenario("terminated")).r, naturalExit: (await scenario("naturalExit")).r };
	for (const [name, r] of Object.entries(runs)) { const c = compareResults(structuredClone(r), structuredClone(r)); assert.equal(c.baselineEligible, true, name); assert.equal(c.attemptCoverage.candidate.eligible && c.attemptCoverage.baseline.eligible, true, name); assert.equal(c.quality.status, "unknown", name); }
	let n = 0;
	for (const [name, f] of Object.entries(contradictions)) for (const side of sides) {
		const a = structuredClone(runs.quiet), b = structuredClone(runs.quiet);
		const m = side === "candidate" ? b : a; f(m); n++;
		assert.equal(m.tasks[0].shutdown.confirmed, true, "the SDK shutdown label stays good"); assert.equal(m.status, "unfinished");
		check(compareResults(a, b), side, `${side} ${name}`);
	}
	assert.equal(n, sides.length * Object.keys(contradictions).length);
	// count semantics on the runs with a termination round: a bogus initial count is invalid, while a natural exit (alive 1, terminated 0, targeted 1) is valid (checked above)
	for (const name of ["terminated", "naturalExit"]) for (const side of sides) for (const [label, f] of [["recorded 0 (an empty seed cannot yield survivors or termination activity)", (r) => { pg(r).recorded = 0; }], ["alive 3", (r) => { pg(r).attributedAlive = 3; }], ["alive 0 with a termination round", (r) => { pg(r).attributedAlive = 0; }], ["remaining 1", (r) => { pg(r).remainingAlive = 1; }], ["targeted dropped", (r) => { pg(r).targeted = 0; }]]) {
		const a = structuredClone(runs[name]), b = structuredClone(runs[name]); f(side === "candidate" ? b : a);
		check(compareResults(a, b), side, `${name} ${side} ${label}`);
	}
	// F5: a coherent EMPTY seed (nothing recorded, nothing alive, nothing signalled) stays valid; zero-seed activity of any kind is not
	{ const z = structuredClone(runs.quiet); pg(z).recorded = 0; assert.equal(compareResults(z, structuredClone(z)).baselineEligible, true, "coherent zero seed"); }
	for (const [label, f] of [["alive", (r) => { pg(r).attributedAlive = 1; }], ["targeted", (r) => { pg(r).targeted = 1; }], ["terminated", (r) => { pg(r).terminated = 1; pg(r).targeted = 1; }]]) for (const side of sides) {
		const a = structuredClone(runs.quiet), b = structuredClone(runs.quiet); pg(a).recorded = 0; pg(b).recorded = 0; f(side === "candidate" ? b : a);
		check(compareResults(a, b), side, `zero seed with ${label}`);
	}
	// but alive may legitimately EXCEED a positive recorded count (a linked late child) and a repeated round may target more than the seed: no general upper bound
	{ const late = structuredClone(runs.terminated); Object.assign(pg(late), { recorded: 1, attributedAlive: 2, targeted: 3, terminated: 2 }); assert.equal(compareResults(late, structuredClone(late)).baselineEligible, true, "linked late child / repeated targeting"); }
});

test("compare: an unknown/missing adapter identity is never evidence that the gate is not applicable; supported fake/synthetic producers and non-Windows stay exempt", async () => {
	const ad = fakeAdapter({ synthetic: false, mainScript: fixMain });
	const { r } = await scenario("quiet");
	const base = structuredClone(r); base.environment.platform = "win32"; base.environment.adapter.name = "pi-sdk";
	assert.equal(compareResults(structuredClone(base), structuredClone(base)).baselineEligible, true, "intact gated control");
	const strip = (m) => { delete m.config.continuation.gate; for (const t of m.tasks) delete t.shutdown.processGate; };
	const variants = { deleted: (m) => { delete m.environment.adapter.name; }, null: (m) => { m.environment.adapter.name = null; }, number: (m) => { m.environment.adapter.name = 7; }, empty: (m) => { m.environment.adapter.name = ""; }, space: (m) => { m.environment.adapter.name = " "; }, array: (m) => { m.environment.adapter.name = ["pi-sdk"]; }, object: (m) => { m.environment.adapter.name = {}; }, "pi-sdk2": (m) => { m.environment.adapter.name = "pi-sdk2"; }, "adapter deleted": (m) => { delete m.environment.adapter; }, "environment deleted": (m) => { delete m.environment; } };
	for (const [label, f] of Object.entries(variants)) {
		const x = structuredClone(base), y = structuredClone(base);
		for (const m of [x, y]) { strip(m); f(m); if (label !== "environment deleted") m.environment.platform = "win32"; }
		const c = compareResults(x, y);
		assert.equal(c.baselineEligible, false, `${label}: overall`);
		for (const side of ["baseline", "candidate"]) assert.equal(c.attemptCoverage[side].eligible, false, `${label}: ${side}`);
		const mm = compareResults(structuredClone(base), x);
		assert.equal(mm.baselineEligible, false, label); assert.ok(mm.inconclusive.some((m) => /gate policy/.test(m)), `${label}: ${JSON.stringify(mm.inconclusive)}`);
	}
	// controls: the supported fake and synthetic producers (win32 or unknown OS), a known non-Windows unknown adapter, and fresh stay eligible
	for (const name of ["fake-adapter", "synthetic"]) for (const plat of ["win32", undefined]) {
		const c = structuredClone(r); strip(c); c.environment.adapter.name = name; if (plat === undefined) delete c.environment.platform; else c.environment.platform = plat;
		assert.equal(compareResults(c, structuredClone(c)).attemptCoverage.candidate.eligible, true, `${name} ${plat}`);
	}
	const lin = structuredClone(base); strip(lin); lin.environment.platform = "linux"; delete lin.environment.adapter.name;
	assert.equal(compareResults(lin, structuredClone(lin)).attemptCoverage.candidate.eligible, true, "known non-Windows");
	const fr = await go(T3(), ad, gateOf(helper(ad, [])), { mode: "fresh" }); delete fr.environment.adapter.name;
	assert.equal(compareResults(fr, structuredClone(fr)).attemptCoverage.candidate.eligible, true, "fresh");
});

test("compare: only a documented canonical non-Windows process.platform value exempts a gate-stripped pi-sdk long result; every other platform value is unknown (exact match, no normalization)", async () => {
	const { r } = await scenario("quiet");
	const base = structuredClone(r); base.environment.platform = "win32"; base.environment.adapter.name = "pi-sdk";
	const strip = (m) => { delete m.config.continuation.gate; for (const t of m.tasks) delete t.shutdown.processGate; };
	// Node process.platform documented values (https://nodejs.org/docs/latest-v24.x/api/process.html#processplatform); android is experimental and unsupported here
	const NON_WIN = ["aix", "darwin", "freebsd", "linux", "openbsd", "sunos"];
	const malformed = [undefined, null, "", " ", "\t", "\n", "android", "cygwin", "not-an-os", "unknown", "windows", "win64", "nt", "posix", "unix", "macos", "mac", "osx", "gnu/linux", 7, 0, true, false, {}, [], ["linux"], ["win32"], { platform: "linux" }];
	for (const p of ["win32", ...NON_WIN]) for (const f of [(s) => s.toUpperCase(), (s) => s[0].toUpperCase() + s.slice(1), (s) => ` ${s}`, (s) => `${s} `, (s) => `${s}\n`, (s) => `\t${s}`, (s) => `${s}\0`, (s) => `x${s}`, (s) => `${s}x`, (s) => `${s}2`, (s) => s.slice(1), (s) => s.slice(0, -1), (s) => `${s}.`, (s) => `${s}-`]) malformed.push(f(p));
	const platforms = ["win32", ...NON_WIN, ...malformed];
	const adapters = { "pi-sdk": "pi-sdk", "fake-adapter": "fake-adapter", synthetic: "synthetic", "unknown adapter": undefined };
	let cells = 0;
	for (const [alabel, aname] of Object.entries(adapters)) for (const plat of platforms) {
		const x = structuredClone(base); strip(x);
		if (aname === undefined) delete x.environment.adapter.name; else x.environment.adapter.name = aname;
		if (plat === undefined) delete x.environment.platform; else x.environment.platform = plat;
		const y = JSON.parse(JSON.stringify(x)), z = JSON.parse(JSON.stringify(x)), want = aname === "fake-adapter" || aname === "synthetic" || (typeof plat === "string" && NON_WIN.includes(plat)), what = `${alabel} / ${JSON.stringify(plat)}`;
		const c = compareResults(z, y);
		assert.equal(c.baselineEligible, want, `${what}: overall`);
		for (const side of ["baseline", "candidate"]) assert.equal(c.attemptCoverage[side].eligible, want, `${what}: ${side}`);
		if (!want) assert.ok(c.inconclusive.length > 0, what);
		// one stripped side against the intact gated record stays a policy mismatch
		if (!want) { const m = compareResults(structuredClone(base), x); assert.equal(m.baselineEligible, false, what); assert.ok(m.inconclusive.some((s) => /gate policy/.test(s)), what); }
		cells++;
	}
	assert.equal(cells, 4 * platforms.length);
	// the intact gated win32 record and an actually synthetic root stay as before
	assert.equal(compareResults(structuredClone(base), structuredClone(base)).baselineEligible, true);
	const syn = structuredClone(base); strip(syn); syn.environment.platform = "linux"; syn.synthetic = true;
	assert.equal(compareResults(syn, structuredClone(syn)).baselineEligible, false);
});

test("compare: a no-session marker needs task-record corroboration; forged markers are invalid; a legacy Windows pi-sdk long result with a closed session and no gate is not a baseline", async () => {
	const ad = fakeAdapter({ synthetic: false, mainScript: fixMain });
	const retained = await go(T3(), ad, gateOf(helper(ad, [])), { workspace: slowPrepare(["H2"], ad) });
	assert.equal(eligible(retained).ok, true);
	const forge = {
		"start context present": (t) => { t.startContext = { contextTokens: 1 }; },
		"stage main_prompt": (t) => { t.budget.stage = "main_prompt"; },
		"work stage in history": (t) => { t.budget.stages.push({ stage: "main_prompt", startOffsetMs: 0, endOffsetMs: 1 }); },
		"extra key": (t) => { t.shutdown.processGate.pid = 1; },
		"wrong reason": (t) => { t.shutdown.processGate.reason = "other"; },
		"wrong method": (t) => { t.shutdown.processGate.method = "other/1"; },
	"canonical session-close ms 20 contradicts the marker": (t) => { t.shutdown.ms = 20; },
	"canonical session-close ms 0 (non-null) contradicts the marker": (t) => { t.shutdown.ms = 0; },
		"marker deleted": (t) => { delete t.shutdown.processGate; },
	};
	for (const [name, f] of Object.entries(forge)) for (const side of sides) {
		const a = structuredClone(retained), b = structuredClone(retained); f((side === "candidate" ? b : a).tasks[1]);
		check(compareResults(a, b), side, `${side} ${name}`);
	}
	const { r } = await scenario("quiet");
	const a = structuredClone(r), b = structuredClone(r);
	for (const m of [a, b]) { delete m.config.continuation.gate; delete m.tasks[0].shutdown.processGate; m.environment.platform = "win32"; m.environment.adapter.name = "pi-sdk"; }
	for (const side of sides) check(compareResults(a, b), side, "legacy pi-sdk without gate");
	// F4: the same canonical-close contradiction on the INITIAL pre-session marker; both actual controls (ms null) stay eligible
	const adI = fakeAdapter({ synthetic: false, mainScript: fixMain });
	const initial = await go(T3(), adI, gateOf(helper(adI, [])), { workspace: slowPrepare(["H1"], adI) });
	assert.equal(initial.tasks[0].shutdown.ms, null); assert.equal(retained.tasks[1].shutdown.ms, null); assert.equal(eligible(initial).ok, true); assert.equal(eligible(retained).ok, true);
	for (const ms of [20, 0]) for (const side of sides) {
		const x = structuredClone(initial), y = structuredClone(initial); (side === "candidate" ? y : x).tasks[0].shutdown.ms = ms;
		check(compareResults(x, y), side, `initial marker with ms ${ms}`);
	}
	// F3: a pi-sdk shared-long result whose gate policy, records AND platform metadata were all stripped cannot become eligible by omission
	const base3 = structuredClone(r); base3.environment.platform = "win32"; base3.environment.adapter.name = "pi-sdk";
	assert.equal(compareResults(structuredClone(base3), structuredClone(base3)).baselineEligible, true, "the intact gated control is eligible");
	const strip = (m) => { delete m.config.continuation.gate; for (const t of m.tasks) delete t.shutdown.processGate; };
	for (const [label, setPlatform] of [["deleted", (e) => { delete e.platform; }], ["null", (e) => { e.platform = null; }], ["empty", (e) => { e.platform = ""; }], ["number", (e) => { e.platform = 7; }], ["object", (e) => { e.platform = {}; }]]) {
		const x = structuredClone(base3), y = structuredClone(base3);
		for (const m of [x, y]) { strip(m); if (label === "environment deleted") { m.environment = { adapter: { name: "pi-sdk" } }; delete m.environment.platform; } else setPlatform(m.environment, m); }
		for (const side of sides) check(compareResults(x, y), side, `stripped platform ${label} (both sides)`);
		// one stripped side against an intact gated side stays a policy mismatch
		const c = compareResults(structuredClone(base3), x);
		assert.equal(c.baselineEligible, false, label); assert.ok(c.inconclusive.some((m) => /gate policy/.test(m)), `${label}: ${JSON.stringify(c.inconclusive)}`);
	}
	// a genuinely non-Windows pi-sdk result with no gate is still not subject to the Windows gate, and the OS is never inferred from the comparator host
	const lin = structuredClone(base3); strip(lin); lin.environment.platform = "linux";
	assert.equal(compareResults(lin, structuredClone(lin)).attemptCoverage.candidate.eligible, true);
	// fresh keeps its scope even with the metadata deleted
	const fr = await go(T3(), fakeAdapter({ synthetic: false, mainScript: fixMain }), gateOf(helper(ad, [])), { mode: "fresh" });
	fr.environment.adapter.name = "pi-sdk"; delete fr.environment.platform;
	assert.equal(compareResults(fr, structuredClone(fr)).attemptCoverage.candidate.eligible, true, "fresh is not applicable");
	// the same no-gate shape from a fake adapter has no gate obligation
	const fake = structuredClone(r); delete fake.config.continuation.gate; delete fake.tasks[0].shutdown.processGate;
	assert.equal(compareResults(fake, structuredClone(fake)).attemptCoverage.candidate.eligible, true);
});
