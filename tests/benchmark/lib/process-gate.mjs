// Benchmark-only Windows process gate (method windows-handle-verified-descendants/1). At a shared-long cutoff transition the runner records the descendants of the benchmark
// process BEFORE the session is closed (so ancestry is not lost), and after the close it stops only those recorded identities that are still alive. It is detective and attributed:
// it never proves that no writer exists (see README: blind spots). Nothing here uses a command line, a process name, a private SDK PID or a new dependency.
//
// Public API used: Win32 CreateToolhelp32Snapshot/Process32First/Next (PID + parent PID), OpenProcess, GetProcessTimes (64-bit FILETIME creation identity, kept as a decimal string, never a JS
// float), GetExitCodeProcess, TerminateProcess, WaitForSingleObject, CloseHandle, called from one fixed built-in Windows PowerShell script (Add-Type P/Invoke).
// Signal safety: a target is OPENED, its creation time is compared with the recorded identity ON THAT HANDLE, and only then is the same handle terminated and waited on. While the handle
// is open the PID cannot be reused, so there is no check/kill PID-reuse window. There is no tree kill (no taskkill /T): an identity that was not recorded or verified is never signalled.
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";

export const GATE_METHOD = "windows-handle-verified-descendants/1";
const MAX_ROUNDS = 2; // terminate+reassess rounds
const KILL_WAIT_MS = 2000; // per call cap for the handle wait
const MAX_OUT = 4 << 20;
export const FAILURES = ["unsupported_platform", "budget_spent", "timeout", "tool_failed", "root_unidentified", "identity_unreadable", "terminate_failed", "still_alive"];

// Original-deadline clock (verified public facts, see README): Node os.uptime() is libuv uv_uptime = GetTickCount64()/1000.0 and the native helper reads kernel32 GetTickCount64 (Windows PowerShell 5.1 has no
// Environment.TickCount64), so both read ONE system tick counter in ms. Microsoft documents its resolution as the system timer's, typically 10-16 ms. A sample is therefore stale by at most one tick, and the deadline
// D carried to the helper is (uptime sampled BEFORE the original remaining) + remaining - TICK_MARGIN_MS, so a check that admits an action at D cannot be later than the original deadline.
// shortcut: TICK_MARGIN_MS assumes a tick step <= 32 ms (two documented ticks); a host with a coarser timer is not covered (process-gate-real.test.mjs measures the host step), upgrade by measuring the step at run time.
export const TICK_MARGIN_MS = 32;
export const uptimeMs = () => Math.floor(os.uptime() * 1000);

export class GateFailure extends Error {
	constructor(code) { super(code); this.code = code; }
}

const CS = `
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class PG {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  struct PE { public uint size, usage, pid; public UIntPtr heap; public uint module, threads, ppid; public int pri; public uint flags; [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)] public string exe; }
  [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr CreateToolhelp32Snapshot(uint f, uint p);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern bool Process32FirstW(IntPtr s, ref PE e);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern bool Process32NextW(IntPtr s, ref PE e);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
  [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr OpenProcess(uint a, bool i, uint pid);
  [DllImport("kernel32.dll")] static extern bool GetProcessTimes(IntPtr h, out long c, out long e, out long k, out long u);
  [DllImport("kernel32.dll")] static extern bool GetExitCodeProcess(IntPtr h, out uint code);
  [DllImport("kernel32.dll")] static extern bool TerminateProcess(IntPtr h, uint code);
  [DllImport("kernel32.dll")] static extern uint WaitForSingleObject(IntPtr h, uint ms);
  [DllImport("kernel32.dll")] static extern ulong GetTickCount64();
  static bool Past(ulong d) { return GetTickCount64() >= d; }
  // 1 active, 0 exited, -1 UNKNOWN (the query failed): unknown is never treated as gone.
  static int State(IntPtr h) { uint c; return GetExitCodeProcess(h, out c) ? (c == 259 ? 1 : 0) : -1; }
  static string Created(IntPtr h) { long c, e, k, u; if (!GetProcessTimes(h, out c, out e, out k, out u)) return null; return ((ulong)c).ToString(); }
  static void Snap(StringBuilder sb) {
    IntPtr s = CreateToolhelp32Snapshot(2, 0);
    if (s == (IntPtr)(-1)) throw new Exception("snapshot");
    try {
      PE e = new PE(); e.size = (uint)Marshal.SizeOf(typeof(PE));
      bool ok = Process32FirstW(s, ref e);
      while (ok) {
        if (e.pid != 0) {
          string c = "-"; bool gone = false;
          IntPtr h = OpenProcess(0x1000, false, e.pid); int err = Marshal.GetLastWin32Error();
          if (h == IntPtr.Zero) { if (err == 87) gone = true; }
          else { try { int st = State(h); if (st == 0) gone = true; else if (st > 0) { string t = Created(h); if (t != null) c = t; } } finally { CloseHandle(h); } }
          if (!gone) sb.Append("p ").Append(e.pid).Append(' ').Append(e.ppid).Append(' ').Append(c).Append('\\n');
        }
        ok = Process32NextW(s, ref e);
      }
    } finally { CloseHandle(s); }
  }
  static string Kill(uint pid, string created, uint self, uint root, System.Diagnostics.Stopwatch sw, long total, ulong d) {
    if (pid == self || pid == root || pid == 0 || pid == 4) return "refused";
    if (Past(d)) return "deadline";
    IntPtr h = OpenProcess(0x1000 | 0x1 | 0x100000, false, pid); int err = Marshal.GetLastWin32Error();
    if (h == IntPtr.Zero) return err == 87 ? "gone" : (err == 5 ? "denied" : "error");
    try {
      int st = State(h); if (st == 0) return "gone"; if (st < 0) return "error";
      string c = Created(h); if (c == null) return "error"; if (c != created) return "replaced";
      if (Past(d)) return "deadline";
      if (!TerminateProcess(h, 1)) { int s2 = State(h); return s2 == 0 ? "gone" : (s2 < 0 ? "error" : "terminate_failed"); }
      long left = Math.Max(0, total - sw.ElapsedMilliseconds);
      ulong now = GetTickCount64(); long byD = now >= d ? 0 : (long)(d - now);
      left = Math.Min(left, byD);
      return WaitForSingleObject(h, (uint)left) == 0 ? "terminated" : "wait_timeout";
    } finally { CloseHandle(h); }
  }
  public static string Run(string input) {
    StringBuilder sb = new StringBuilder();
    uint self = (uint)System.Diagnostics.Process.GetCurrentProcess().Id;
    sb.Append("self ").Append(self).Append('\\n');
    string[] lines = input.Split('\\n');
    string[] head = lines[0].Trim().Split(' ');
    ulong d = ulong.Parse(head[head.Length - 1]);
    if (Past(d)) { sb.Append("late").Append('\\n').Append("end").Append('\\n'); return sb.ToString(); }
    if (head[0] == "terminate") {
      uint root = uint.Parse(head[1]); long total = long.Parse(head[2]);
      System.Diagnostics.Stopwatch sw = System.Diagnostics.Stopwatch.StartNew();
      for (int i = 1; i < lines.Length; i++) {
        string[] t = lines[i].Trim().Split(' ');
        if (t.Length != 3 || t[0] != "t") continue;
        uint pid = uint.Parse(t[1]);
        sb.Append("k ").Append(pid).Append(' ').Append(Kill(pid, t[2], self, root, sw, total, d)).Append('\\n');
      }
    }
    Snap(sb);
    if (Past(d)) { sb.Append("late").Append('\\n'); }
    sb.Append("clock ").Append(GetTickCount64()).Append('\\n');
    sb.Append("end\\n");
    return sb.ToString();
  }
}
`;
const PS = `$ErrorActionPreference = 'Stop'\nAdd-Type -TypeDefinition @'${CS}'@\n[Console]::Out.Write([PG]::Run([Console]::In.ReadToEnd()))\n`;
export const HELPER_ARGS = ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(PS, "utf16le").toString("base64")];
const POWERSHELL = () => path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");

// Runs the fixed helper once, bounded by timeoutMs (the helper is our own child: Node terminates it through its own process handle).
export function runHelper(input, timeoutMs) {
	return new Promise((resolve, reject) => {
		let child;
		try { child = spawn(POWERSHELL(), HELPER_ARGS, { windowsHide: true, stdio: ["pipe", "pipe", "ignore"] }); } catch { reject(new GateFailure("tool_failed")); return; }
		let out = "", over = false, timedOut = false, done = false;
		const finish = (fn) => { if (!done) { done = true; clearTimeout(timer); fn(); } };
		const timer = setTimeout(() => { timedOut = true; try { child.kill(); } catch { /* already gone */ } finish(() => reject(new GateFailure("timeout"))); }, timeoutMs);
		child.stdout.setEncoding("utf8");
		child.stdout.on("data", (d) => { out += d; if (out.length > MAX_OUT) { over = true; try { child.kill(); } catch { /* gone */ } } });
		child.on("error", () => finish(() => reject(new GateFailure("tool_failed"))));
		child.stdin.on("error", () => {});
		child.on("close", (code) => finish(() => (timedOut ? reject(new GateFailure("timeout")) : code === 0 && !over ? resolve(out) : reject(new GateFailure("tool_failed")))));
		child.stdin.end(input);
	});
}

// Pure: helper text -> { self, kills: [{pid, outcome}], table: [{pid, ppid, created|null}] }. A truncated or malformed text is a tool failure, never an empty table.
export function parseHelperOutput(text) {
	const out = { self: null, kills: [], table: [] };
	let ended = false;
	for (const line of String(text).split("\n")) {
		const t = line.trim().split(" ");
		if (t[0] === "self" && /^\d+$/.test(t[1] ?? "")) out.self = Number(t[1]);
		else if (t[0] === "k" && /^\d+$/.test(t[1] ?? "") && t[2]) out.kills.push({ pid: Number(t[1]), outcome: t[2] });
		else if (t[0] === "p" && /^\d+$/.test(t[1] ?? "") && /^\d+$/.test(t[2] ?? "") && (t[3] === "-" || /^\d+$/.test(t[3] ?? ""))) out.table.push({ pid: Number(t[1]), ppid: Number(t[2]), created: t[3] === "-" ? null : t[3] });
		else if (t[0] === "late" && t.length === 1) throw new GateFailure("timeout"); // the helper itself saw the carried original deadline pass: nothing after it is admissible
		else if (t[0] === "clock" && t.length === 2 && /^\d+$/.test(t[1])) out.clock = Number(t[1]);
		else if (t[0] === "end") ended = true;
		else if (line.trim() !== "") throw new GateFailure("tool_failed");
	}
	if (!ended || out.self === null) throw new GateFailure("tool_failed");
	return out;
}

// Pure: the entries reachable from the verified seed entries. A child counts only when its parent identity is alive in the SAME table and the child was created at or after that parent
// (a child older than the current holder of a reused PID belongs to a former holder). An unreadable identity under an attributed parent is ambiguous: fail closed.
export function closure(table, seeds) {
	const kids = new Map();
	for (const e of table) (kids.get(e.ppid) ?? kids.set(e.ppid, []).get(e.ppid)).push(e);
	const out = [...seeds], seen = new Set(seeds.map((e) => e.pid));
	for (let i = 0; i < out.length; i++) {
		for (const c of kids.get(out[i].pid) ?? []) {
			if (seen.has(c.pid)) continue;
			if (c.created === null) throw new GateFailure("identity_unreadable");
			if (BigInt(c.created) < BigInt(out[i].created)) continue;
			seen.add(c.pid); out.push(c);
		}
	}
	return out;
}

const same = (a, b) => a.pid === b.pid && a.created !== null && a.created === b.created;
const helperSet = (table, self) => { const h = table.find((e) => e.pid === self); return new Set(h && h.created !== null ? closure(table, [h]).map((e) => e.pid) : [self]); };

// Pure: recorded descendants of root (before the close): identities with PID + creation time + parent PID. Excludes the root and the inspection helper with its own children.
export function recordDescendants(table, rootPid, self) {
	const root = table.find((e) => e.pid === rootPid);
	if (!root || root.created === null) throw new GateFailure("root_unidentified");
	const skip = helperSet(table, self); skip.add(rootPid);
	return closure(table, [root]).filter((e) => !skip.has(e.pid)).map((e) => ({ pid: e.pid, ppid: e.ppid, created: e.created }));
}

// Pure: recorded identities still alive (same PID AND creation time) plus live descendants of those verified identities. A PID now held by another creation time is dead.
export function attributedAlive(table, recorded, rootPid, self) {
	const root = table.find((e) => e.pid === rootPid);
	if (!root || root.created === null) throw new GateFailure("root_unidentified");
	const skip = helperSet(table, self); skip.add(rootPid);
	// A recorded PID that is present NOW with an unreadable identity is ambiguous (it may be the recorded process): fail closed, never absent. Unrelated unreadable rows are not assumed owned.
	if (table.some((e) => !skip.has(e.pid) && e.created === null && recorded.some((r) => r.pid === e.pid))) throw new GateFailure("identity_unreadable");
	const seeds = table.filter((e) => !skip.has(e.pid) && recorded.some((r) => same(e, r)));
	return closure(table, seeds).filter((e) => !skip.has(e.pid));
}

const CALL_CAP_MS = 15000; // one helper call (compile + snapshot) never takes more of the 60 s reserve than this, so a stuck call cannot spend the whole close budget
const budgetMs = (remaining) => { const ms = Math.floor(Math.min(remaining(), CALL_CAP_MS)); if (!(ms >= 1)) throw new GateFailure("budget_spent"); return ms; };

// run(input, timeoutMs) -> helper text (injectable). remaining(): ms left of the ORIGINAL task deadline; every call is bounded by it and no new time is granted.
export function createProcessGate({ run = runHelper, rootPid = process.pid, platform = process.platform, now = () => performance.now(), uptimeMs: uptime = uptimeMs } = {}) {
	// Per helper call: the tick is sampled FIRST, then the ORIGINAL remaining; D = tick + remaining - margin is carried into the helper (which refuses to start work, signal or wait past it). A return after D (or
	// after the original remaining) is a timeout even if the Node timer has not fired: nothing that came back late is parsed as proof, and no further request follows.
	const exec = async (build, remaining) => {
		const u = uptime();
		const ms = budgetMs(remaining);
		if (ms - TICK_MARGIN_MS < 1) throw new GateFailure("budget_spent");
		const d = u + ms - TICK_MARGIN_MS;
		const out = await run(build(ms, d), ms);
		if (uptime() >= d || !(remaining() >= 1)) throw new GateFailure("timeout");
		return parseHelperOutput(out);
	};
	return {
		method: GATE_METHOD,
		// Before the close. Never throws: a failed record is a controlled state that finish() turns into unconfirmed.
		async begin(remaining) {
			if (platform !== "win32") return { ok: false, failure: "unsupported_platform", recorded: [] };
			try {
				const obs = await exec((ms, d) => `snapshot ${d}\n`, remaining);
				return { ok: true, recorded: recordDescendants(obs.table, rootPid, obs.self) };
			} catch (e) { return { ok: false, failure: FAILURES.includes(e?.code) ? e.code : "tool_failed", recorded: [] }; }
		},
		// After the close and drain. confirmed is true only when a complete assessment found no attributed-alive identity (after identity-verified termination, if any).
		async finish(state, remaining) {
			const t0 = now();
			const res = { method: GATE_METHOD, confirmed: false, assessable: false, recorded: state.recorded.length, attributedAlive: 0, terminated: 0, targeted: 0, remainingAlive: null, waitMs: 0, failure: null };
			try {
				if (!state.ok) throw new GateFailure(state.failure ?? "tool_failed");
				let known = state.recorded, obs = await exec((ms, d) => `snapshot ${d}\n`, remaining), failedKill = false;
				for (let round = 0; ; round++) {
					const alive = attributedAlive(obs.table, known, rootPid, obs.self);
					res.assessable = true;
					if (round === 0) res.attributedAlive = alive.length;
					res.remainingAlive = alive.length; // the LAST observed attributed-alive count (an existing observation, no new OS query): 0 only when a final observation found none
					if (alive.length === 0) { res.confirmed = true; break; }
					if (round >= MAX_ROUNDS) throw new GateFailure(failedKill ? "terminate_failed" : "still_alive");
					known = [...known, ...alive.filter((a) => !known.some((k) => same(a, k))).map((a) => ({ pid: a.pid, ppid: a.ppid, created: a.created }))];
					// targeted counts identities named in a request actually built for the helper (a process may also exit on its own between observations: terminated stays lower)
					obs = await exec((ms, d) => { res.targeted += alive.length; return [`terminate ${rootPid} ${Math.min(KILL_WAIT_MS, Math.floor(ms / 2))} ${d}`, ...alive.map((a) => `t ${a.pid} ${a.created}`), ""].join("\n"); }, remaining);
					let deadline = false;
					for (const k of obs.kills) { if (k.outcome === "terminated") res.terminated++; else if (k.outcome === "deadline") deadline = true; else if (!["gone", "replaced"].includes(k.outcome)) failedKill = true; }
					if (deadline) throw new GateFailure("timeout"); // a deadline refusal is neither terminated nor gone
				}
			} catch (e) { res.confirmed = false; res.failure = FAILURES.includes(e?.code) ? e.code : "tool_failed"; }
			res.waitMs = Math.max(0, Math.round(now() - t0));
			return res;
		},
	};
}
