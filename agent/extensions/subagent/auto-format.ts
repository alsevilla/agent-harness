// Workers only: format a file right after a worker edits it (like a Claude Code PostToolUse hook), so no fix round is spent on a
// formatter or lint failure. The commands come only from the user's own profile, `<agent dir>/format.json`, never from the project or
// the worker: a repository or a worker could otherwise make the harness run commands. Absent or invalid file: nothing runs.
//
//   { "rules": [ { "match": [".rs"], "command": ["rustfmt", "--edition", "2021", "{file}"] },
//                { "match": [".ts", ".tsx"], "command": ["npx", "prettier", "--write", "{file}"] } ],
//     "timeoutSeconds": 20 }
//
// After a successful edit or write of a matching file, the command runs from the worker's folder with the file's absolute path for
// {file}. When it changes the file, one line tells the worker to read the changed lines before its next edit there; when it fails, one
// line carries its first output. Unchanged files and successful no-op runs add nothing.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

type Part = { type: string; text?: string };
export interface FormatRule { match: string[]; command: string[] }
export interface FormatConfig { rules: FormatRule[]; timeoutSeconds: number }

/** The profile's format.json, validated; undefined when absent or not valid (nothing then runs). */
export function loadFormatConfig(file: string): FormatConfig | undefined {
	let raw: any;
	try { raw = JSON.parse(fs.readFileSync(file, "utf8")); } catch { return undefined; }
	if (!raw || !Array.isArray(raw.rules)) return undefined;
	const rules = raw.rules.filter((r: any) => Array.isArray(r?.match) && r.match.length && r.match.every((m: unknown) => typeof m === "string" && /^\.[A-Za-z0-9]+$/.test(m))
		&& Array.isArray(r?.command) && r.command.length && r.command.every((c: unknown) => typeof c === "string" && c.length > 0) && r.command.some((c: string) => c.includes("{file}")));
	if (!rules.length) return undefined;
	const timeout = Number(raw.timeoutSeconds);
	return { rules, timeoutSeconds: Number.isFinite(timeout) && timeout > 0 ? Math.min(timeout, 120) : 20 };
}

const digest = (file: string) => { try { return createHash("sha256").update(fs.readFileSync(file)).digest("hex"); } catch { return undefined; } };
const quote = (arg: string) => (/[\s"&|<>^]/.test(arg) ? `"${arg.replace(/"/g, '\\"')}"` : arg);

export function createAutoFormat(config: FormatConfig | undefined, run: typeof spawnSync = spawnSync) {
	return {
		/** One appended line after a matching edit or write, or undefined. */
		onResult(toolName: string, input: unknown, content: unknown, isError: boolean, cwd: string): Part[] | undefined {
			if (!config || isError || (toolName !== "edit" && toolName !== "write") || !Array.isArray(content)) return undefined;
			const p = (input as { path?: unknown })?.path;
			if (typeof p !== "string" || !p) return undefined;
			const file = path.resolve(cwd, p.replace(/^@/, ""));
			const ext = path.extname(file).toLowerCase();
			const rule = config.rules.find((r) => r.match.some((m) => m.toLowerCase() === ext));
			if (!rule) return undefined;
			const before = digest(file);
			const [cmd, ...args] = rule.command.map((c) => c.split("{file}").join(file));
			// Windows runs npx, npm and other .cmd launchers only through a shell; the arguments are then quoted.
			const shell = process.platform === "win32";
			const result = run(cmd, shell ? args.map(quote) : args, { cwd, timeout: config.timeoutSeconds * 1000, windowsHide: true, encoding: "utf8", shell });
			const name = path.basename(cmd);
			const shown = path.relative(cwd, file).split(path.sep).join("/") || file;
			if (result.error || result.status !== 0) {
				const detail = String(result.error?.message ?? (`${result.stderr ?? ""}${result.stdout ?? ""}`)).trim().replace(/\s+/g, " ").slice(0, 400);
				return [...(content as Part[]), { type: "text", text: `[harness] ${name} reported a problem in ${shown}${result.signal ? " (timed out)" : ""}: ${detail || `exit ${result.status}`}` }];
			}
			if (digest(file) === before) return undefined;
			return [...(content as Part[]), { type: "text", text: `[harness] Formatted ${shown} with ${name}; read the changed lines again before your next edit there.` }];
		},
	};
}
