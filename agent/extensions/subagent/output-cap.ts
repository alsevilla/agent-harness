// Workers only: a long shell output keeps its start and end in context; the full text stays on disk. Pi keeps up to the last 2,000 lines
// or 50 KB (about 12k tokens) of a command's output, and that copy then rides along in every later request of the run. Claude Code cuts
// far sooner. Build and test logs are the usual offenders, and what matters in them is the start (the command, the first error) and the
// end (the summary). Over the cap (default 16,000 characters; PI_SUBAGENT_OUTPUT_CAP, 0 off) the output keeps its first 2,000 and last
// 8,000 characters, with a line naming the file that holds all of it: Pi's own full-output file when Pi already truncated, otherwise a
// file this writes under the system temp folder.
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

type Part = { type: string; text?: string };
export const OUTPUT_CAP_DEFAULT = 16_000;
const HEAD = 2_000;
const TAIL = 8_000;

export function outputCapFromEnv(env: NodeJS.ProcessEnv = process.env): number {
	const raw = env.PI_SUBAGENT_OUTPUT_CAP;
	if (raw === undefined || raw.trim() === "") return OUTPUT_CAP_DEFAULT;
	const n = Number(raw);
	if (!Number.isFinite(n) || n < 0) return OUTPUT_CAP_DEFAULT;
	return n === 0 ? 0 : Math.max(HEAD + TAIL + 1_000, Math.floor(n));
}

export const OUTPUT_LOG_RETENTION_MS = 7 * 24 * 60 * 60 * 1_000;
const OUTPUT_ROOT = path.join(os.tmpdir(), "pi-worker-output");
let lastPrune = 0;

function processRunning(pid: number): boolean {
	try { process.kill(pid, 0); return true; }
	catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; }
}

/** Best-effort retention. Never recurse, follow links, or touch legacy/unrecognised files. */
export function pruneWorkerOutput(root: string, now = Date.now(), isRunning = processRunning): void {
	try {
		if (!fs.lstatSync(root).isDirectory()) return;
		for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
			if (!entry.isDirectory() || !/^[1-9]\d*$/.test(entry.name)) continue;
			const pid = Number(entry.name);
			if (!Number.isSafeInteger(pid) || pid > 2_147_483_647 || isRunning(pid)) continue;
			const dir = path.join(root, entry.name);
			try {
				for (const name of fs.readdirSync(dir)) {
					if (!/^[a-f0-9]{16}\.log$/.test(name)) continue;
					const file = path.join(dir, name);
					try {
						const stat = fs.lstatSync(file);
						if (stat.isFile() && now - stat.mtimeMs > OUTPUT_LOG_RETENTION_MS) fs.unlinkSync(file);
					} catch { /* raced with another worker or inaccessible */ }
				}
				try { fs.rmdirSync(dir); } catch { /* retain nonempty directories */ }
			} catch { /* cleanup must not interrupt tool results */ }
		}
	} catch { /* missing or inaccessible temp directory */ }
}

/** Replacement content for a long shell output, or undefined to keep it. */
export function capShellOutput(toolName: string, content: unknown, details: unknown, cap: number, saveDir?: string): Part[] | undefined {
	if (!(cap > 0) || (toolName !== "bash" && toolName !== "powershell") || !Array.isArray(content)) return undefined;
	const parts = content as Part[];
	if (!parts.every((p) => p?.type === "text" && typeof p.text === "string")) return undefined;
	const text = parts.map((p) => p.text).join("\n");
	if (text.length <= cap) return undefined;
	let full = typeof (details as { fullOutputPath?: unknown })?.fullOutputPath === "string" ? (details as { fullOutputPath: string }).fullOutputPath : undefined;
	if (!full) {
		try {
			const managed = saveDir === undefined;
			saveDir ??= path.join(OUTPUT_ROOT, String(process.pid));
			fs.mkdirSync(saveDir, { recursive: true });
			full = path.join(saveDir, `${createHash("sha256").update(text).digest("hex").slice(0, 16)}.log`);
			fs.writeFileSync(full, text);
			if (managed && Date.now() - lastPrune > 60 * 60 * 1_000) {
				lastPrune = Date.now();
				pruneWorkerOutput(OUTPUT_ROOT, lastPrune);
			}
		} catch { full = undefined; }
	}
	const cut = text.length - HEAD - TAIL;
	const where = full ? `the full output is in ${full.split(path.sep).join("/")}; read it with offset and limit, or grep it` : "rerun with the output sent to a file in your _scratch folder if you need it";
	return [{ type: "text", text: `${text.slice(0, HEAD)}\n[… ${cut.toLocaleString("en-US")} characters cut to keep your context small: ${where} …]\n${text.slice(-TAIL)}` }];
}
