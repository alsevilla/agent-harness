// Opt-in OS sandbox for workers on Linux (bubblewrap, as Claude Code uses there). The whole filesystem is mounted read-only and only the
// folders a worker needs are writable: its candidate checkout (writing roles only), the task's _evidence and _scratch folders, the temp
// folder (the parent's prompt and control files), the provider-cooldown state and the cargo target folder. Network stays on: the worker's
// own Pi process must reach the model API. This turns the guard's lexical write rules into enforced ones; it is not network isolation.
//   PI_SUBAGENT_SANDBOX unset or "off": no sandbox (default). "on": sandbox when bwrap works, else launch with a note.
//   "require": refuse to launch when the sandbox is unavailable. PI_SUBAGENT_SANDBOX_WRITABLE: extra writable paths (path-delimited).
import * as childProcess from "node:child_process"; // namespace import: test doubles that stub only `spawn` still link
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export const SANDBOX_ENV = "PI_SUBAGENT_SANDBOX";
export const SANDBOX_WRITABLE_ENV = "PI_SUBAGENT_SANDBOX_WRITABLE";
export type SandboxMode = "off" | "on" | "require";

export function sandboxMode(env: NodeJS.ProcessEnv = process.env): SandboxMode {
	const v = (env[SANDBOX_ENV] ?? "").trim().toLowerCase();
	return v === "on" || v === "1" || v === "true" ? "on" : v === "require" ? "require" : "off";
}

let available: boolean | undefined;
/** Linux with a working bwrap (user namespaces allowed). Probed once per process. */
export function sandboxAvailable(probe: () => boolean = () => childProcess.spawnSync("bwrap", ["--ro-bind", "/", "/", "--dev-bind", "/dev", "/dev", "true"], { stdio: "ignore", timeout: 5000 }).status === 0): boolean {
	if (process.platform !== "linux") return false;
	if (available === undefined) { try { available = probe(); } catch { available = false; } }
	return available;
}
export function resetSandboxProbe(): void { available = undefined; }

/** The checkout root containing cwd (nearest ancestor with .git), or cwd itself. */
function checkoutRoot(cwd: string): string {
	let dir = path.resolve(cwd);
	for (;;) {
		if (fs.existsSync(path.join(dir, ".git"))) return dir;
		const parent = path.dirname(dir);
		if (parent === dir) return path.resolve(cwd);
		dir = parent;
	}
}

/** _evidence and _scratch of the candidate's artifact group: <parent>/worktrees/<repo>/ for a worktree task, or beside a primary checkout. */
export function artifactRoots(candidate: string): string[] {
	const root = checkoutRoot(candidate);
	const parent = path.dirname(root);
	const group = path.basename(parent) && path.basename(path.dirname(parent)) === "worktrees" ? parent : path.join(parent, "worktrees", path.basename(root));
	return ["_evidence", "_scratch"].map((kind) => path.join(group, kind));
}

export interface SandboxPlan { writable: string[]; args: string[] }
/** bwrap arguments for one worker launch. Writable paths that do not exist yet are created (artifact folders) or skipped. */
export function sandboxPlan(opts: { cwd: string; readOnly: boolean; agentDir: string; env?: NodeJS.ProcessEnv }): SandboxPlan {
	const env = opts.env ?? process.env;
	const wanted = [
		...(opts.readOnly ? [] : [checkoutRoot(opts.cwd)]),
		...artifactRoots(opts.cwd),
		os.tmpdir(),
		path.join(opts.agentDir, "run-state"),
		...(env.CARGO_TARGET_DIR ? [env.CARGO_TARGET_DIR] : []),
		...(env.PI_CARGO_TARGET_ROOT ? [env.PI_CARGO_TARGET_ROOT] : []),
		...(env[SANDBOX_WRITABLE_ENV] ?? "").split(path.delimiter).filter(Boolean),
	];
	const writable: string[] = [];
	for (const p of wanted.map((x) => path.resolve(x))) {
		if (writable.includes(p)) continue;
		try { if (!fs.existsSync(p) && (p.includes(`${path.sep}_evidence`) || p.includes(`${path.sep}_scratch`) || p.endsWith(`${path.sep}run-state`))) fs.mkdirSync(p, { recursive: true }); } catch { /* skipped below */ }
		if (fs.existsSync(p)) writable.push(p);
	}
	// A read-only role's checkout is mounted read-only last, so it stays read-only even when it lies under a writable folder (for example temp).
	const lock = opts.readOnly ? ["--ro-bind", checkoutRoot(opts.cwd), checkoutRoot(opts.cwd)] : [];
	const args = ["--die-with-parent", "--ro-bind", "/", "/", "--dev-bind", "/dev", "/dev", ...writable.flatMap((p) => ["--bind", p, p]), ...lock, "--chdir", path.resolve(opts.cwd), "--"];
	return { writable, args };
}

/** Wraps a worker invocation, leaves it as is, or refuses it, according to the mode and availability. */
export function sandboxInvocation(invocation: { command: string; args: string[] }, opts: { cwd: string; readOnly: boolean; agentDir: string; env?: NodeJS.ProcessEnv; available?: boolean }):
	| { ok: true; command: string; args: string[]; note?: string }
	| { ok: false; reason: string } {
	const mode = sandboxMode(opts.env);
	if (mode === "off") return { ok: true, ...invocation };
	const ready = opts.available ?? sandboxAvailable();
	if (!ready) {
		const why = process.platform !== "linux" ? "the OS sandbox is Linux-only" : "bubblewrap (bwrap) is missing or user namespaces are disabled";
		return mode === "require" ? { ok: false, reason: `${SANDBOX_ENV}=require but ${why}; nothing was launched` } : { ok: true, ...invocation, note: `Worker ran without the OS sandbox: ${why}.` };
	}
	const plan = sandboxPlan(opts);
	return { ok: true, command: "bwrap", args: [...plan.args, invocation.command, ...invocation.args] };
}
