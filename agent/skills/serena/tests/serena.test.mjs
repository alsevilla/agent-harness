// serena skill client (serena.mjs): Serena output turned into 1-based, worker-sized text; the heuristic fallback when Serena is missing or
// cannot serve the checkout; project setup only in an ignoring primary checkout. Runs without Serena (a fake connection stands in).
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { main, projectRoot, serenaFind, serenaOutline, serenaRefs } from "../scripts/serena.mjs";

const SCRIPT = fileURLToPath(new URL("../scripts/serena.mjs", import.meta.url));
const git = (cwd, ...args) => assert.equal(spawnSync("git", args, { cwd, encoding: "utf8" }).status, 0, `git ${args.join(" ")}`);

// Shapes recorded from Serena 2.1 against the RFID repository (0-based lines).
const FIND = {
	queue_status_sms: [{ name_path: "queue_status_sms", kind: "Function", relative_path: "backend/src/services/attendance.rs", body_location: { start_line: 118, end_line: 138 } }],
	response: [{ name_path: "impl ScanResult/response", kind: "Method", relative_path: "backend/src/services/attendance.rs", body_location: { start_line: 219, end_line: 241 }, body: "pub(crate) fn response(\n    &self,\n) {}" }],
	new: [{ name_path: "Queue/new", kind: "Function", relative_path: "a.rs", body_location: { start_line: 0, end_line: 2 } }, { name_path: "Store/new", kind: "Function", relative_path: "b.rs", body_location: { start_line: 4, end_line: 6 } }],
};
const REFS = { "backend/src/services/attendance.rs": { Function: [
	{ name_path: "recompute_open_day_in_tx", body_location: { start_line: 140, end_line: 203 }, content_around_reference: "... 189:    let awaiting_review = x;\n  > 190:    queue_status_sms(\n... 191:        tx," },
	{ name_path: "decide_scan_in_tx_with_windows", body_location: { start_line: 787, end_line: 1032 }, content_around_reference: "  >1008:    queue_status_sms(" },
] } };
function fake(root = "/w/app") {
	const calls = [];
	return {
		root, calls,
		tool: async (name, params) => {
			calls.push([name, params]);
			if (name === "find_symbol") return JSON.stringify(FIND[params.name_path_pattern] ?? []);
			if (name === "find_referencing_symbols") return JSON.stringify(REFS);
			throw new Error(`unexpected ${name}`);
		},
		outline: async () => [
			{ name_path: "ScanResult", kind: "Struct", body_location: { start_line: 205, end_line: 216 }, children: [{ name_path: "ScanResult/success", kind: "Field", body_location: { start_line: 208, end_line: 208 } }] },
			{ name_path: "impl ScanResult", kind: "Object", body_location: { start_line: 218, end_line: 242 }, children: [{ name_path: "impl ScanResult/response", kind: "Method", body_location: { start_line: 219, end_line: 241 } }] },
			{ name_path: "queue_status_sms", kind: "Function", body_location: { start_line: 118, end_line: 138 } },
		],
	};
}

test("Serena answers become 1-based worker text: outline sorted by line without fields, find with body, refs with enclosing symbols", async () => {
	const s = fake();
	assert.equal(await serenaOutline(s, ["/w/app/backend/src/services/attendance.rs"]), [
		"backend/src/services/attendance.rs (3 top-level symbols)",
		"  function queue_status_sms  L119-139",
		"  struct ScanResult  L206-217",
		"  object impl ScanResult  L219-243",
		"    method response  L220-242",
	].join("\n"));
	assert.equal(await serenaFind(s, "queue_status_sms"), "1 definition of queue_status_sms\nbackend/src/services/attendance.rs:119-139  function  queue_status_sms");
	const body = await serenaFind(s, "ScanResult/response", undefined, { body: true });
	assert.match(body, /^1 definition of ScanResult\/response\nbackend\/src\/services\/attendance\.rs:220-242  method  impl ScanResult\/response\n {3}220  pub\(crate\) fn response\(\n {3}221 {6}&self,/);
	assert.deepEqual(s.calls.slice(-2).map(([, p]) => p.name_path_pattern), ["ScanResult/response", "response"], "Owner/name retries the name and keeps the owner's (Rust impl blocks)");
	assert.equal(await serenaRefs(s, "queue_status_sms"), [
		"2 references to queue_status_sms (backend/src/services/attendance.rs:119-139)",
		"backend/src/services/attendance.rs:191  [recompute_open_day_in_tx]  queue_status_sms(",
		"backend/src/services/attendance.rs:1009  [decide_scan_in_tx_with_windows]  queue_status_sms(",
	].join("\n"));
	assert.match(await serenaRefs(s, "new"), /^new is defined 2 times; pass the file or use Owner\/name:\na\.rs:1-3  function  Queue\/new\nb\.rs:5-7  function  Store\/new$/);
	assert.match(await serenaFind(s, "missing"), /no definition of missing found by Serena/);
	assert.equal(await serenaFind(s, "new", undefined, { kind: "method" }).then((t) => t.startsWith("no definition")), true, "--kind filters");
});

test("without Serena, or in a worktree it cannot serve, the heuristic parser answers and says why", async () => {
	const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "serena-client-")));
	const saved = process.env.HARNESS_SERENA_PYTHON;
	try {
		git(dir, "init", "-q");
		fs.mkdirSync(path.join(dir, "src"));
		fs.writeFileSync(path.join(dir, "src", "q.rs"), "pub fn drain() {}\nfn main() { drain(); }\n");
		process.env.HARNESS_SERENA_PYTHON = path.join(dir, "no-python");
		const found = await main(["find", "drain"], dir);
		assert.match(found, /^\[heuristic parser, not Serena: Serena is not installed \(uv tool install serena-agent\)\]\n1 definition of drain\n/);
		assert.match(await main(["refs", "drain", "src"], dir), /^\[heuristic parser, not Serena: .*\]\n1 reference to drain in 1 file\n/);
		assert.match(await main(["outline", path.join(dir, "src", "q.rs")], dir), /^\[heuristic parser, not Serena: .*\]\n.*q\.rs \(3 lines, 2 symbols\)/);
		assert.equal(projectRoot(path.join(dir, "src")), dir);
		await assert.rejects(main(["find", "drain", os.tmpdir()], dir), /outside the project/);
		await assert.rejects(main(["nope"], dir), /usage:/);

		// A linked worktree without .serena: never written to; the heuristic answers. A fake Serena Python makes the check reach that point.
		fs.writeFileSync(path.join(dir, "python"), "");
		process.env.HARNESS_SERENA_PYTHON = path.join(dir, "python");
		git(dir, "-c", "user.name=t", "-c", "user.email=t@example.test", "commit", "-q", "--allow-empty", "-m", "init");
		const tree = path.join(dir, "..", `${path.basename(dir)}-wt`);
		git(dir, "worktree", "add", "-q", tree);
		fs.mkdirSync(path.join(tree, "src"), { recursive: true });
		fs.writeFileSync(path.join(tree, "src", "q.rs"), "pub fn drain() {}\n");
		assert.match(await main(["find", "drain"], tree), /^\[heuristic parser, not Serena: Serena is not set up for this worktree .* the skill does not add one to a worktree\]/);
		assert.equal(fs.existsSync(path.join(tree, ".serena")), false);
		// A primary checkout that does not ignore .serena/: not set up, nothing written.
		assert.match(await main(["find", "drain"], dir), /^\[heuristic parser, not Serena: Serena is not set up for .*: add \.serena\/ to its \.gitignore/);
		assert.equal(fs.existsSync(path.join(dir, ".serena")), false);
		git(dir, "worktree", "remove", "--force", tree);
	} finally {
		if (saved === undefined) delete process.env.HARNESS_SERENA_PYTHON; else process.env.HARNESS_SERENA_PYTHON = saved;
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("the command line prints the answer, and a usage error exits 2", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "serena-cli-"));
	try {
		fs.writeFileSync(path.join(dir, "a.py"), "def f():\n    return 1\n");
		const env = { ...process.env, HARNESS_SERENA_PYTHON: path.join(dir, "none") };
		const ok = spawnSync(process.execPath, [SCRIPT, "find", "f"], { cwd: dir, encoding: "utf8", env });
		assert.equal(ok.status, 0, ok.stderr);
		assert.match(ok.stdout, /^\[heuristic parser, not Serena: Serena is not installed/);
		const bad = spawnSync(process.execPath, [SCRIPT], { cwd: dir, encoding: "utf8", env });
		assert.equal(bad.status, 2);
		assert.match(bad.stderr, /usage:/);
	} finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
