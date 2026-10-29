// Objective acceptance: the named test files run in the replay workspace with the suite's own toolchain (node or bun).
// A missing file, a non-zero exit, any failing test or zero passing tests is NOT accepted.
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const FLAGS = ["--experimental-transform-types", "--disable-warning=ExperimentalWarning", "--disable-warning=MODULE_TYPELESS_PACKAGE_JSON", "--test", "--test-reporter=tap", "--test-concurrency=4"];

// node: the Node test runner (TAP). bun: the Bun CLI test command, for Bun-written suites (the commit's own toolchain).
export function acceptanceCommand(runner, files) {
	if (runner === "bun") return { exe: "bun", args: ["test", ...files] };
	if (runner === "node" || runner === undefined) return { exe: process.execPath, args: [...FLAGS, ...files] };
	throw new Error(`acceptanceRunner must be node or bun, got ${runner}`);
}

// Last summary count for a name: TAP prints "# pass N"; bun prints " N pass".
function count(out, name, runner) {
	const lines = out.split(/\r?\n/).map((l) => l.trim());
	if (runner === "bun") {
		const hits = lines.filter((l) => /^\d+ /.test(l) && l.endsWith(` ${name}`));
		return hits.length ? Number(hits[hits.length - 1].split(" ")[0]) : 0;
	}
	const hits = lines.filter((l) => l.startsWith(`# ${name} `));
	return hits.length ? Number(hits[hits.length - 1].split(" ")[2]) : 0;
}

export function runAcceptance({ cwd, files, runner = "node", timeoutMs }) {
	if (!Array.isArray(files) || files.length === 0) return { accepted: false, exitCode: null, pass: 0, fail: 0, reason: "no acceptance tests declared" };
	const missing = files.filter((f) => !fs.existsSync(path.join(cwd, f)));
	if (missing.length) return { accepted: false, exitCode: null, pass: 0, fail: 0, reason: `missing acceptance test ${missing.join(", ")}` };
	const cmd = acceptanceCommand(runner, files);
	const env = { ...process.env };
	delete env.NODE_TEST_CONTEXT;
	const started = Date.now();
	const r = spawnSync(cmd.exe, cmd.args, { cwd, env, encoding: "utf8", maxBuffer: 64 << 20, timeout: timeoutMs });
	const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
	const pass = count(out, "pass", runner), fail = count(out, "fail", runner);
	const accepted = !r.error && r.status === 0 && fail === 0 && pass > 0;
	return {
		accepted, exitCode: r.status, pass, fail, runner, durationMs: Date.now() - started,
		reason: accepted ? undefined : r.error ? `acceptance did not run: ${r.error.message}` : r.status !== 0 ? `exit ${r.status}` : fail > 0 ? `${fail} failing` : "no passing tests",
		outputTail: out.slice(-3000),
	};
}

// Async, owned acceptance run: killed (process tree) and drained when timeoutMs expires, so a hung suite cannot block the task deadline.
export function runAcceptanceAsync({ cwd, files, runner = "node", timeoutMs, signal }) {
	if (!Array.isArray(files) || files.length === 0 || files.some((f) => !fs.existsSync(path.join(cwd, f)))) return Promise.resolve(runAcceptance({ cwd, files, runner }));
	const cmd = acceptanceCommand(runner, files);
	const env = { ...process.env };
	delete env.NODE_TEST_CONTEXT;
	const started = Date.now();
	return new Promise((resolve) => {
		const child = spawn(cmd.exe, cmd.args, { cwd, env, windowsHide: true, detached: process.platform !== "win32" });
		let out = ""; let timedOut = false; let spawnError = null;
		const keep = (d) => { out = (out + d).slice(-(64 << 20)); };
		child.stdout.on("data", keep); child.stderr.on("data", keep);
		child.on("error", (e) => { spawnError = e; });
		const killTree = () => {
			if (process.platform === "win32") spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
			else try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); }
		};
		// The task abort signal kills the same process tree; the promise still resolves only when the child has closed.
		const onAbort = () => { timedOut = true; killTree(); };
		if (signal?.aborted) onAbort(); else signal?.addEventListener("abort", onAbort, { once: true });
		const timer = timeoutMs === undefined ? null : setTimeout(() => { timedOut = true; killTree(); }, Math.max(0, timeoutMs));
		child.on("close", (status) => {
			if (timer) clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
			const pass = count(out, "pass", runner), fail = count(out, "fail", runner);
			const accepted = !timedOut && !spawnError && status === 0 && fail === 0 && pass > 0;
			resolve({ accepted, exitCode: status, pass, fail, runner, timedOut, durationMs: Date.now() - started, reason: accepted ? undefined : timedOut ? "acceptance timed out at the task deadline" : spawnError ? `acceptance did not run: ${spawnError.message}` : status !== 0 ? `exit ${status}` : fail > 0 ? `${fail} failing` : "no passing tests", outputTail: out.slice(-3000) });
		});
	});
}
