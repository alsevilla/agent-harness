// Opt-in Linux OS sandbox (bubblewrap): modes, the writable set, and real enforcement when bwrap is available.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test, { after } from "node:test";
import { artifactRoots, resetSandboxProbe, sandboxAvailable, sandboxInvocation, sandboxMode, sandboxPlan } from "../sandbox.ts";

// Outside the temp folder (which the sandbox keeps writable), so "outside the allowed folders" really is outside.
const root = fs.realpathSync.native(fs.mkdtempSync(path.join(path.resolve(import.meta.dirname, "..", "..", "..", ".."), ".sandbox-test-")));
after(() => fs.rmSync(root, { recursive: true, force: true }));
const primary = path.join(root, "proj", "app");
fs.mkdirSync(path.join(primary, ".git"), { recursive: true });
const agentDir = path.join(root, "agent");
const inv = { command: "node", args: ["pi.js", "--mode", "rpc"] };

test("modes: off by default; on and require are opt-in", () => {
	assert.equal(sandboxMode({}), "off");
	assert.equal(sandboxMode({ PI_SUBAGENT_SANDBOX: "off" }), "off");
	assert.equal(sandboxMode({ PI_SUBAGENT_SANDBOX: "on" }), "on");
	assert.equal(sandboxMode({ PI_SUBAGENT_SANDBOX: "require" }), "require");
	assert.deepEqual(sandboxInvocation(inv, { cwd: primary, readOnly: false, agentDir, env: {} }), { ok: true, ...inv });
});

test("unavailable sandbox: on launches with a note, require refuses", () => {
	const on = sandboxInvocation(inv, { cwd: primary, readOnly: false, agentDir, env: { PI_SUBAGENT_SANDBOX: "on" }, available: false });
	assert.equal(on.ok, true);
	assert.match((on as any).note, /without the OS sandbox/);
	assert.equal((on as any).command, "node");
	const req = sandboxInvocation(inv, { cwd: primary, readOnly: false, agentDir, env: { PI_SUBAGENT_SANDBOX: "require" }, available: false });
	assert.equal(req.ok, false);
	assert.match((req as any).reason, /PI_SUBAGENT_SANDBOX=require but .*nothing was launched/);
});

test("writable set: the checkout only for writers; artifact folders, temp, run-state, cargo target and extras for all", () => {
	const [evidence, scratch] = artifactRoots(primary);
	assert.equal(evidence, path.join(root, "proj", "worktrees", "app", "_evidence"));
	const task = path.join(root, "proj", "worktrees", "app", "t1");
	fs.mkdirSync(task, { recursive: true }); fs.writeFileSync(path.join(task, ".git"), "gitdir: x\n");
	assert.deepEqual(artifactRoots(task), [evidence, scratch], "a worktree task shares its group's artifact folders");
	const extra = path.join(root, "cache"); fs.mkdirSync(extra);
	const writer = sandboxPlan({ cwd: primary, readOnly: false, agentDir, env: { PI_SUBAGENT_SANDBOX_WRITABLE: extra } }).writable;
	assert.deepEqual(writer, [primary, evidence, scratch, path.resolve(os.tmpdir()), path.join(agentDir, "run-state"), extra]);
	const reader = sandboxPlan({ cwd: primary, readOnly: true, agentDir, env: {} }).writable;
	assert.ok(!reader.includes(primary), "a read-only role gets no writable checkout");
	const wrapped = sandboxInvocation(inv, { cwd: primary, readOnly: false, agentDir, env: { PI_SUBAGENT_SANDBOX: "on" }, available: true }) as any;
	assert.equal(wrapped.command, "bwrap");
	assert.deepEqual(wrapped.args.slice(0, 7), ["--die-with-parent", "--ro-bind", "/", "/", "--dev-bind", "/dev", "/dev"]);
	assert.deepEqual(wrapped.args.slice(wrapped.args.indexOf("--") + 1), ["node", "pi.js", "--mode", "rpc"]);
});

resetSandboxProbe();
const real = sandboxAvailable();
test("real bwrap: a read-only worker cannot write its checkout, a writer can, and both can write evidence", { skip: real ? false : "bwrap is not available here" }, () => {
	const [evidence] = artifactRoots(primary);
	const run = (readOnly: boolean, script: string) => {
		const { args } = sandboxPlan({ cwd: primary, readOnly, agentDir, env: {} });
		return spawnSync("bwrap", [...args, "bash", "-c", script], { encoding: "utf8" });
	};
	assert.notEqual(run(true, `echo x > "${primary}/a.txt"`).status, 0, "read-only role: checkout write refused by the OS");
	const underTmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "sandbox-ro-")));
	fs.mkdirSync(path.join(underTmp, ".git"));
	const { args } = sandboxPlan({ cwd: underTmp, readOnly: true, agentDir, env: {} });
	assert.notEqual(spawnSync("bwrap", [...args, "bash", "-c", `echo x > "${underTmp}/a.txt"`]).status, 0, "read-only even under the writable temp folder");
	fs.rmSync(underTmp, { recursive: true, force: true });
	assert.equal(run(true, `echo x > "${evidence}/r.md"`).status, 0, "read-only role: evidence write allowed");
	assert.equal(run(false, `echo x > "${primary}/a.txt"`).status, 0, "writer: checkout write allowed");
	assert.notEqual(run(false, `echo x > "${root}/outside.txt"`).status, 0, "writer: outside the allowed folders refused");
	assert.equal(run(false, "echo x > /dev/null && node -e 0").status, 0, "devices and node work");
});
