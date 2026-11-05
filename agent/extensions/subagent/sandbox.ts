// Opt-in OS sandbox for workers: Linux uses bubblewrap and macOS uses Seatbelt (sandbox-exec), as Claude Code and Codex do there. The whole filesystem is mounted read-only and only the
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
const defaultProbe = (): boolean => process.platform === "darwin"
	? childProcess.spawnSync("sandbox-exec", ["-p", "(version 1)(allow default)", "/usr/bin/true"], { stdio: "ignore", timeout: 5000 }).status === 0
	: childProcess.spawnSync("bwrap", ["--ro-bind", "/", "/", "--dev-bind", "/dev", "/dev", "true"], { stdio: "ignore", timeout: 5000 }).status === 0;
/** Linux with a working bwrap (user namespaces allowed), or macOS with sandbox-exec. Probed once per process. */
export function sandboxAvailable(probe: () => boolean = defaultProbe): boolean {
	if (process.platform !== "linux" && process.platform !== "darwin") return false;
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

export interface SandboxPlan { writable: string[]; args: string[]; command: "bwrap" | "sandbox-exec" }

const sbpl = (p: string) => `"${p.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
/**
 * Seatbelt profile: allow everything except writes outside the allowed folders. One deny rule over allow-by-default, so no rule order
 * matters; a read-only role's checkout is excluded inside that rule. Paths must already be real paths (macOS links /tmp to /private/tmp).
 */
export function seatbeltProfile(writable: readonly string[], lockedRoot?: string): string {
	const folders = writable.map((p) => `(subpath ${sbpl(p)})`);
	const devices = ['(literal "/dev/null")', '(literal "/dev/zero")', '(literal "/dev/dtracehelper")', '(regex #"^/dev/tty")', '(regex #"^/dev/fd/")'];
	const any = `(require-any ${[...folders, ...devices].join(" ")})`;
	const allowed = lockedRoot ? `(require-all ${any} (require-not (subpath ${sbpl(lockedRoot)})))` : any;
	return `(version 1)\n(allow default)\n(deny file-write* (require-not ${allowed}))\n`;
}
/** bwrap arguments for one worker launch. Writable paths that do not exist yet are created (artifact folders) or skipped. */
export function sandboxPlan(opts: { cwd: string; readOnly: boolean; agentDir: string; env?: NodeJS.ProcessEnv; platform?: string }): SandboxPlan {
	const env = opts.env ?? process.env;
	const platform = opts.platform ?? process.platform;
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
	if (platform === "darwin") {
		const real = (p: string) => { try { return fs.realpathSync.native(p); } catch { return p; } };
		const profile = seatbeltProfile([...new Set(writable.map(real))], opts.readOnly ? real(checkoutRoot(opts.cwd)) : undefined);
		return { writable, args: ["-p", profile], command: "sandbox-exec" };
	}
	// A read-only role's checkout is mounted read-only last, so it stays read-only even when it lies under a writable folder (for example temp).
	const lock = opts.readOnly ? ["--ro-bind", checkoutRoot(opts.cwd), checkoutRoot(opts.cwd)] : [];
	const args = ["--die-with-parent", "--ro-bind", "/", "/", "--dev-bind", "/dev", "/dev", ...writable.flatMap((p) => ["--bind", p, p]), ...lock, "--chdir", path.resolve(opts.cwd), "--"];
	return { writable, args, command: "bwrap" };
}

/** Wraps a worker invocation, leaves it as is, or refuses it, according to the mode and availability. */
export function sandboxInvocation(invocation: { command: string; args: string[] }, opts: { cwd: string; readOnly: boolean; agentDir: string; env?: NodeJS.ProcessEnv; available?: boolean; platform?: string }):
	| { ok: true; command: string; args: string[]; note?: string }
	| { ok: false; reason: string } {
	const mode = sandboxMode(opts.env);
	if (mode === "off") return { ok: true, ...invocation };
	const ready = opts.available ?? sandboxAvailable();
	if (!ready) {
		const platform = opts.platform ?? process.platform;
		const why = platform === "darwin" ? "sandbox-exec is not available" : platform !== "linux" ? "the OS sandbox covers Linux and macOS only" : "bubblewrap (bwrap) is missing or user namespaces are disabled";
		return mode === "require" ? { ok: false, reason: `${SANDBOX_ENV}=require but ${why}; nothing was launched` } : { ok: true, ...invocation, note: `Worker ran without the OS sandbox: ${why}.` };
	}
	const plan = sandboxPlan(opts);
	return { ok: true, command: plan.command, args: [...plan.args, invocation.command, ...invocation.args] };
}
