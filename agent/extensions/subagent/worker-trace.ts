// Durable worker trace: one JSON-lines file per worker process under <agent dir>/run-state/worker-traces, written by the parent from the
// child's RPC events. Workers run with --no-session and background results live in memory, so after a reload nothing showed which
// commands a worker ran or which the guard refused (field report: a design document appeared in a checkout after a read-only
// specialist's run, and no record could say who wrote it). Each file holds the launch (role, model, folder, read-only root, job, task
// excerpt), every tool call with its arguments, every result with its error flag and guard rule, and the exit. Best effort: a failed
// write never affects the worker. Files older than 14 days are removed when a worker starts. PI_SUBAGENT_TRACE_LOG=0 turns it off.
// The files stay on this machine, beside Pi's own session files, and record what the worker sent to its tools, unredacted.
import * as fs from "node:fs";
import * as path from "node:path";

export const TRACE_ENV = "PI_SUBAGENT_TRACE_LOG";
export const TRACE_RETENTION_MS = 14 * 24 * 60 * 60 * 1000;
const ARG_CHARS = 4_000; // per string argument: enough for a command, a path or an edit's old text
const EXCERPT_CHARS = 400; // of an error result: the guard's refusal names its rule and target in its first sentence

export function traceDir(agentDir: string): string {
	return path.join(agentDir, "run-state", "worker-traces");
}

export interface TraceMeta {
	role: string;
	model?: string;
	cwd: string;
	readOnlyRoot?: string;
	jobId?: string;
	workerId?: string;
	task: string;
}

export interface WorkerTrace {
	readonly file: string;
	event(event: any): void;
	close(exitCode: number, stopReason?: string): void;
}

const capStrings = (value: unknown): unknown => {
	if (typeof value === "string") return value.length > ARG_CHARS ? `${value.slice(0, ARG_CHARS)}… [${value.length} chars]` : value;
	if (Array.isArray(value)) return value.map(capStrings);
	if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, capStrings(v)]));
	return value;
};
const textOf = (result: any): string => (Array.isArray(result?.content) ? result.content : []).filter((c: any) => c?.type === "text").map((c: any) => String(c.text ?? "")).join("\n");

/** Removes trace files older than the retention period; never throws. */
export function pruneTraces(dir: string, now = Date.now()): void {
	try {
		for (const name of fs.readdirSync(dir)) {
			if (!name.endsWith(".jsonl")) continue;
			const file = path.join(dir, name);
			try { const stat = fs.lstatSync(file); if (stat.isFile() && now - stat.mtimeMs > TRACE_RETENTION_MS) fs.unlinkSync(file); } catch { /* raced or inaccessible */ }
		}
	} catch { /* no folder yet */ }
}

/** Starts a worker's trace file, or returns undefined when tracing is off or the folder cannot be written. */
export function createWorkerTrace(agentDir: string, meta: TraceMeta, env: NodeJS.ProcessEnv = process.env, now = new Date()): WorkerTrace | undefined {
	if (env[TRACE_ENV] === "0") return undefined;
	const dir = traceDir(agentDir);
	try { fs.mkdirSync(dir, { recursive: true }); } catch { return undefined; }
	pruneTraces(dir, now.getTime());
	const stamp = now.toISOString().replace(/[:.]/g, "-");
	const safe = (s: string) => s.replace(/[^A-Za-z0-9_-]+/g, "_").slice(0, 60);
	const file = path.join(dir, `${stamp}-${safe(meta.role)}-${safe(meta.workerId ?? String(process.pid))}.jsonl`);
	let open = true;
	const write = (entry: Record<string, unknown>) => {
		if (!open) return;
		try { fs.appendFileSync(file, JSON.stringify({ t: new Date().toISOString(), ...entry }) + "\n"); } catch { open = false; }
	};
	write({ type: "worker", ...capStrings({ ...meta, task: meta.task.slice(0, ARG_CHARS) }) as object });
	return {
		file,
		event(event: any) {
			if (event?.type === "tool_execution_start") write({ type: "call", id: event.toolCallId, tool: event.toolName, args: capStrings(event.args ?? {}) });
			else if (event?.type === "tool_execution_end") {
				const text = textOf(event.result);
				const guard = /Blocked by harness safety guard \[([A-Z_]+)\]/.exec(text)?.[1];
				write({ type: "result", id: event.toolCallId, tool: event.toolName, isError: event.isError === true, ...(guard ? { guard } : {}), chars: text.length, ...(event.isError ? { excerpt: text.slice(0, EXCERPT_CHARS) } : {}) });
			}
		},
		close(exitCode: number, stopReason?: string) {
			write({ type: "end", exitCode, ...(stopReason ? { stopReason } : {}) });
			open = false;
		},
	};
}
