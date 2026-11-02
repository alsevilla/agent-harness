// Real Windows OS tests of the process gate: only processes THIS test creates (a Node parent and its Node grandchild; no SDK, no provider, no helper agent, no existing process) are ever signalled,
// and every signal goes through the gate's identity-verified handle path (or the owned ChildProcess object). Skipped with a reason on other platforms.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createProcessGate, runHelper, parseHelperOutput, GateFailure, uptimeMs, TICK_MARGIN_MS } from "./lib/process-gate.mjs";

const win = process.platform === "win32";
const opts = { skip: win ? false : "the Windows handle-verified process gate is Windows-only (non-Windows fails closed: unsupported_platform)", timeout: 180000 };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (pred, ms = 20000) => { const end = Date.now() + ms; while (Date.now() < end) { if (pred()) return true; await sleep(50); } return false; };
// Every helper request carries its original-deadline tick D (public uptime clock, whole ms). These direct calls use a generous 30 s D: the production protocol, not a test shortcut.
const dl = (ms = 30000) => uptimeMs() + ms;
const snap = async () => parseHelperOutput(await runHelper(`snapshot ${dl()}\n`, 30000));
const alive = async (pid, created) => (await snap()).table.some((e) => e.pid === pid && e.created === created);
// Stops ONE recorded identity through the same handle-verified helper path (creation time compared on the opened handle): the test's finalization, never a PID-only kill.
const stopIdentity = async (pid, created) => runHelper(`terminate ${process.pid} 3000 ${dl()}\nt ${pid} ${created}\n`, 30000).then(parseHelperOutput);

// Parent: spawns a DETACHED grandchild (keeps its parent link while captured, but is outside the parent's kill-on-close job, so it can outlive the parent) whose cwd is the fixture workspace (a classic Windows delete blocker) and which keeps appending, then idles.
// TEST-ONLY lease: the fixture grandchild exits BY ITSELF (no signal, no PID) when STOP exists or its LEASE file is missing/stale, so a test that fails or crashes before the gate has identified it
// cannot leave an immortal writer: the leak is bounded by the lease TTL. The owner heartbeats the lease and always writes STOP in its finally. The same predicate is embedded in the child and unit-tested.
const EXPIRED = (stop, mtime, now, ttl) => stop === true || mtime === null || now - mtime > ttl;
const GRANDCHILD = `const fs=require('fs');const EXPIRED=${EXPIRED};const mt=()=>{try{return fs.statSync(process.env.LEASE).mtimeMs}catch{return null}};setInterval(()=>{if(EXPIRED(fs.existsSync(process.env.STOP),mt(),Date.now(),Number(process.env.TTL)))process.exit(0);fs.appendFileSync(process.env.LOG,'x');fs.appendFileSync('late.txt','x')},40)`;
const MAX_LEASE_MS = 120000; // the heartbeat stops by itself, so even a hung owner leaves a child that expires
function lease(dir, ttl, { beat = true } = {}) {
	const file = path.join(dir, "lease"), stop = path.join(dir, "stop"), t0 = Date.now();
	fs.writeFileSync(file, "1");
	const timer = beat ? setInterval(() => { try { if (Date.now() - t0 > MAX_LEASE_MS) clearInterval(timer); else { const n = new Date(); fs.utimesSync(file, n, n); } } catch { /* the fixture directory is gone: the child expires */ } }, 400) : null;
	timer?.unref();
	return { file, stop, env: { LEASE: file, STOP: stop, TTL: String(ttl) }, end() { if (timer) clearInterval(timer); try { fs.writeFileSync(stop, "1"); } catch { /* the lease expiry still bounds the child */ } } };
}
const size = (f) => { try { return fs.statSync(f).size; } catch { return -1; } };
// True once a file stopped growing across one 400 ms window (the 40 ms writer would grow it), false if it never settled inside ms.
const settled = async (f, ms) => { const end = Date.now() + ms; let last = -2; while (Date.now() < end) { const s = size(f); if (s === last) return true; last = s; await sleep(400); } return false; };
const fixture = (name) => { const fx = fs.mkdtempSync(path.join(os.tmpdir(), name)); const ws = path.join(fx, "ws", "sub"); fs.mkdirSync(ws, { recursive: true }); return { fx, ws, log: path.join(fx, "log.txt"), pidfile: path.join(fx, "pid.txt") }; };
const PARENT = `const {spawn}=require('child_process');const g=spawn(process.execPath,['-e',${JSON.stringify(GRANDCHILD)}],{cwd:process.env.WS,stdio:'ignore',env:process.env,detached:true});require('fs').writeFileSync(process.env.PIDFILE,String(g.pid));setInterval(()=>{},1000)`;
const IDLE = "setInterval(()=>{},1000)";
const node = (code, env, cwd) => spawn(process.execPath, ["-e", code], { cwd, env: { ...process.env, ...env }, stdio: "ignore", windowsHide: true });

test("real Windows: a grandchild orphaned by killing ONLY its owned parent is recorded before, identified and stopped by the gate, and gone before the fixture workspace is prepared; late writes stop", opts, async (t) => {
	const { fx, ws, log, pidfile } = fixture("pg-real-");
	fs.writeFileSync(path.join(fx, "ws", "parent-file.txt"), "p");
	const ls = lease(fx, 10000); // far above the gate's own timing, renewed every 400 ms: the happy path can never expire before the gate acts
	let parent = null, gpid = null, gcreated = null, bystander = null;
	try {
		parent = node(PARENT, { WS: ws, LOG: log, PIDFILE: pidfile, ...ls.env });
		assert.ok(await until(() => fs.existsSync(pidfile) && fs.readFileSync(pidfile, "utf8") !== ""), "fixture grandchild started");
		gpid = Number(fs.readFileSync(pidfile, "utf8"));
		assert.ok(await until(() => fs.existsSync(log) && fs.statSync(log).size > 0), "grandchild is writing");
		const gate = createProcessGate();
		const remaining = () => 60000;
		const before = await gate.begin(remaining); // captured while the parent is ALIVE
		assert.equal(before.ok, true, JSON.stringify(before));
		const mine = before.recorded.filter((e) => e.pid === parent.pid || e.pid === gpid);
		assert.equal(mine.length, 2, "parent and grandchild are recorded with identity");
		assert.ok(mine.every((e) => /^\d{17,19}$/.test(e.created)), "creation identity is a lossless decimal string");
		gcreated = mine.find((e) => e.pid === gpid).created;
		assert.equal(mine.find((e) => e.pid === gpid).ppid, parent.pid);
		// A process created AFTER the record (by this test, not under a recorded parent) is never attributed.
		bystander = node(IDLE, {});
		assert.ok(await until(() => bystander.pid > 0));
		// Kill ONLY the owned parent through its ChildProcess object (what index.ts does): the grandchild is orphaned and stays alive.
		const exited = new Promise((r) => parent.once("exit", r));
		parent.kill();
		await exited;
		await sleep(300);
		assert.equal(await alive(gpid, gcreated), true, "RED condition: the orphaned grandchild survives its killed parent");
		assert.throws(() => fs.rmSync(path.join(fx, "ws"), { recursive: true, force: true }), (e) => ["EPERM", "EBUSY", "EACCES", "ENOTEMPTY"].includes(e.code), "RED condition: its cwd blocks the workspace removal");
		const t0 = Date.now();
		const res = await gate.finish(before, remaining);
		assert.equal(res.confirmed, true, JSON.stringify(res));
		assert.equal(res.terminated, 1, "exactly the recorded grandchild was stopped");
		assert.ok(res.attributedAlive >= 1 && res.assessable, JSON.stringify(res));
		assert.ok(Date.now() - t0 < 60000, "inside the 60 s shutdown reserve");
		assert.equal(await alive(gpid, gcreated), false, "gone BEFORE the workspace is prepared");
		assert.equal(bystander.exitCode, null, "the unrecorded bystander was never signalled");
		assert.ok((await snap()).table.some((e) => e.pid === bystander.pid), "bystander still in the table");
		gpid = null;
		// Prepare the own fixture workspace (rm + rebuild), then observe a bounded window: no late write reappears and the log stays flat.
		fs.rmSync(path.join(fx, "ws"), { recursive: true, force: true });
		fs.mkdirSync(path.join(fx, "ws", "sub"), { recursive: true });
		fs.writeFileSync(path.join(fx, "ws", "parent-file.txt"), "p");
		const size = fs.statSync(log).size;
		await sleep(400);
		assert.equal(fs.statSync(log).size, size, "no further writes after the gate");
		assert.deepEqual(fs.readdirSync(path.join(fx, "ws"), { recursive: true }).sort(), ["parent-file.txt", "sub"], "only the parent-commit files: no late write in the new workspace");
	} finally {
		ls.end(); // STOP first and the heartbeat ends: whatever failed above (even before an identity existed) the grandchild now leaves by itself
		if (gpid !== null && gcreated !== null) await stopIdentity(gpid, gcreated).catch(() => {});
		for (const c of [parent, bystander]) if (c && c.exitCode === null && c.signalCode === null) { const gone = new Promise((r) => c.once("exit", r)); c.kill(); await Promise.race([gone, sleep(5000)]); }
		const ended = (c) => (c === null ? "not started" : c.exitCode !== null || c.signalCode !== null ? "ended" : "STILL RUNNING");
		t.diagnostic(`final: parent ${ended(parent)}, bystander ${ended(bystander)}, grandchild identity ${gpid === null ? "stopped by the gate" : "stopped by identity in finally"}, fixture retained`);
	}
});

test("lease predicate (pure): STOP, a missing lease or a stale lease expire the fixture child; a fresh lease without STOP does not", () => {
	assert.equal(EXPIRED(true, 1000, 1001, 60000), true, "STOP wins over a fresh lease");
	assert.equal(EXPIRED(false, null, 1001, 60000), true, "missing lease");
	assert.equal(EXPIRED(false, 1000, 1000 + 10001, 10000), true, "stale lease");
	assert.equal(EXPIRED(false, 1000, 1000 + 10000, 10000), false, "exactly at the TTL is still fresh");
	assert.equal(EXPIRED(false, 1000, 1500, 10000), false);
});

test("real Windows: an owner that never heartbeats (crashed/hung before identifying the child) leaves a fixture grandchild that expires by itself within the lease TTL (observed by files, STOP never written)", opts, async (t) => {
	const { fx, ws, log, pidfile } = fixture("pg-lease-");
	const ls = lease(fx, 8000, { beat: false });
	let parent = null, gid = null;
	try {
		parent = node(PARENT, { WS: ws, LOG: log, PIDFILE: pidfile, ...ls.env });
		assert.ok(await until(() => size(log) > 0), "grandchild is writing");
		const gpid = Number(fs.readFileSync(pidfile, "utf8"));
		// Optional identity (read-only snapshot of this own fixture child): asserted gone only when it was captured before it expired.
		try { const row = (await snap()).table.find((e) => e.pid === gpid); gid = row?.created ? { pid: gpid, created: row.created } : null; } catch { /* identity is optional */ }
		assert.equal(await settled(log, 30000), true, "the writer stopped by itself without STOP and without any signal");
		assert.equal(fs.existsSync(ls.stop), false, "STOP was never written: this was lease expiry");
		const late = path.join(ws, "late.txt"), s = size(late); await sleep(300);
		assert.equal(size(late), s, "no late writes after expiry");
		if (gid) assert.equal(await alive(gid.pid, gid.created), false, "the captured identity is absent");
		t.diagnostic(`final: grandchild expired by lease; identity captured ${gid !== null}; fixture retained`);
	} finally { ls.end(); if (parent && parent.exitCode === null) parent.kill(); }
});

test("real Windows: a failure after spawn and BEFORE any identity exists (gate begin fails) still ends the fixture grandchild through STOP: no identity, no PID fallback, no signal", opts, async (t) => {
	const { fx, ws, log, pidfile } = fixture("pg-early-");
	const ls = lease(fx, 60000); // heartbeating: only STOP (not expiry) can end it quickly
	let parent = null;
	try {
		parent = node(PARENT, { WS: ws, LOG: log, PIDFILE: pidfile, ...ls.env });
		assert.ok(await until(() => size(log) > 0), "grandchild is writing");
		const begun = await createProcessGate({ run: async () => { throw new GateFailure("tool_failed"); } }).begin(() => 60000);
		assert.equal(begun.ok, false, "the gate could not record: no identity exists for the grandchild");
		ls.end(); // exactly what the finally of the real test does
		assert.equal(await settled(log, 10000), true, "STOP ended the writer");
		t.diagnostic("final: grandchild ended by STOP with no identity captured; fixture retained");
	} finally { ls.end(); if (parent && parent.exitCode === null) parent.kill(); }
});

test("real Windows: a terminate request whose creation identity does not match the live process (a replacement holder) never signals it; root and the helper itself are refused", opts, async () => {
	const idle = node(IDLE, {});
	try {
		assert.ok(await until(() => idle.pid > 0));
		const row = (await snap()).table.find((e) => e.pid === idle.pid);
		assert.ok(row?.created, "live identity readable");
		const wrong = String(BigInt(row.created) + 1n);
		const out = await stopIdentity(idle.pid, wrong);
		assert.deepEqual(out.kills, [{ pid: idle.pid, outcome: "replaced" }]);
		await sleep(200);
		assert.equal(idle.exitCode, null, "the replacement-like holder is alive");
		assert.equal(await alive(idle.pid, row.created), true);
		// the benchmark root (this process) is refused even with its true identity
		const me = (await snap()).table.find((e) => e.pid === process.pid);
		const refused = parseHelperOutput(await runHelper(`terminate ${process.pid} 2000 ${dl()}\nt ${process.pid} ${me.created}\nt 4 1\nt 0 1\n`, 30000));
		assert.deepEqual(refused.kills.map((k) => k.outcome), ["refused", "refused", "refused"]);
		// the right identity does stop it, confirmed through the wait on the same handle
		const ok = await stopIdentity(idle.pid, row.created);
		assert.deepEqual(ok.kills, [{ pid: idle.pid, outcome: "terminated" }]);
		assert.equal(await alive(idle.pid, row.created), false);
	} finally { if (idle.exitCode === null) idle.kill(); }
});

test("real Windows: the helper is bounded (a short timeout is a controlled timeout failure, not success) and a gone process is gone", opts, async () => {
	await assert.rejects(() => runHelper(`snapshot ${dl()}\n`, 5), (e) => e.code === "timeout");
	const idle = node(IDLE, {});
	await until(() => idle.pid > 0);
	const row = (await snap()).table.find((e) => e.pid === idle.pid);
	const exited = new Promise((r) => idle.once("exit", r)); idle.kill(); await exited;
	const out = await stopIdentity(idle.pid, row.created);
	assert.ok(["gone"].includes(out.kills[0].outcome), JSON.stringify(out.kills));
});

// ---- review1 F6: the native helper itself enforces the carried ORIGINAL deadline (no Node timer involved: timeoutMs is 30 s, the deadline is already past when the compiled helper first looks) ----
const finalizeOwned = async (c) => { if (c && c.exitCode === null && c.signalCode === null) { const gone = new Promise((r) => c.once("exit", r)); c.kill(); await Promise.race([gone, sleep(5000)]); } };

test("real Windows F6: a deadline already past at helper start (compile overrun) signals NOTHING: an OWNED child recorded by identity stays alive for terminate AND snapshot requests, with no Node timer", opts, async (t) => {
	const idle = node(IDLE, {});
	try {
		assert.ok(await until(() => idle.pid > 0));
		const row = (await snap()).table.find((e) => e.pid === idle.pid);
		assert.ok(row?.created, "owned child identity readable");
		// D = now + 1 ms: the helper reaches its first check only after Add-Type (hundreds of ms), far past D. Timer = 30 s, so only the helper can refuse.
		const t0 = Date.now();
		await assert.rejects(() => runHelper(`terminate ${process.pid} 3000 ${uptimeMs() + 1}\nt ${idle.pid} ${row.created}\n`, 30000).then(parseHelperOutput), (e) => e instanceof GateFailure && e.code === "timeout");
		assert.ok(Date.now() - t0 < 25000, "returned by the helper, not by the 30 s timer");
		await assert.rejects(() => runHelper(`snapshot ${uptimeMs() + 1}\n`, 30000).then(parseHelperOutput), (e) => e.code === "timeout");
		await sleep(200);
		assert.equal(idle.exitCode, null, "the owned child was not signalled"); assert.equal(await alive(idle.pid, row.created), true, "same PID + creation identity still alive");
		// The same through the production gate (its Node deadline checks are real too): remaining 45 ms -> D = u + 13 ms, long before the compile finishes.
		const gate = createProcessGate({ run: (input) => runHelper(input, 30000) });
		const rec = { ok: true, recorded: [{ pid: idle.pid, ppid: process.pid, created: row.created }] };
		const res = await gate.finish(rec, () => 45);
		assert.deepEqual([res.confirmed, res.failure, res.terminated, res.targeted], [false, "timeout", 0, 0]);
		assert.equal(idle.exitCode, null); assert.equal(await alive(idle.pid, row.created), true);
		assert.deepEqual(await gate.begin(() => 45), { ok: false, failure: "timeout", recorded: [] });
	} finally { await finalizeOwned(idle); t.diagnostic(`final: owned child ${idle.exitCode !== null || idle.signalCode !== null ? "ended through its ChildProcess handle" : "STILL RUNNING"}`); }
});

test("real Windows F6: with a generous carried deadline the same owned child IS terminated by identity (control: the refusal above is the deadline, not a broken path), and the helper reports its tick", opts, async (t) => {
	const idle = node(IDLE, {});
	try {
		assert.ok(await until(() => idle.pid > 0));
		const row = (await snap()).table.find((e) => e.pid === idle.pid);
		const out = await stopIdentity(idle.pid, row.created);
		assert.deepEqual(out.kills, [{ pid: idle.pid, outcome: "terminated" }]);
		assert.equal(typeof out.clock, "number");
		assert.equal(await alive(idle.pid, row.created), false);
	} finally { await finalizeOwned(idle); }
});

test("real Windows F6 clock facts: the helper's GetTickCount64 and Node's os.uptime() are the SAME clock in whole ms (libuv uv_uptime = GetTickCount64()/1000), and this host's tick step is inside the 32 ms margin assumption", opts, async (t) => {
	const before = uptimeMs();
	const out = parseHelperOutput(await runHelper(`snapshot ${dl()}\n`, 30000));
	const after = uptimeMs();
	assert.ok(Number.isSafeInteger(out.clock), "clock line present");
	assert.ok(out.clock >= before - 1 && out.clock <= after + 1, `tick ${out.clock} outside [${before}, ${after}]: unit/epoch mismatch between GetTickCount64 and os.uptime()`);
	// Host assumption behind D = u + ms - TICK_MARGIN_MS: the counter is stale by at most one tick step. Observe this host's step (distinct consecutive values over ~300 ms).
	const seen = []; const end = Date.now() + 300; let last = uptimeMs();
	while (Date.now() < end) { const v = uptimeMs(); if (v !== last) { seen.push(v - last); last = v; } }
	assert.ok(seen.length >= 3, "the counter advances"); assert.ok(Math.max(...seen) <= TICK_MARGIN_MS, `tick step ${Math.max(...seen)} ms exceeds the margin ${TICK_MARGIN_MS}: the conservative-deadline assumption does not hold on this host`);
	t.diagnostic(`host tick: before ${before}, helper ${out.clock}, after ${after}; steps ${[...new Set(seen)].sort((a, b) => a - b).join("/")} ms (docs: typically 10-16 ms)`);
});
