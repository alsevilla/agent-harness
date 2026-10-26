// Objective acceptance: the named test files run in the replay workspace with the suite's own toolchain (node or bun).
// A missing file, a non-zero exit, any failing test or zero passing tests is NOT accepted.
import { spawnSync } from "node:child_process";
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
