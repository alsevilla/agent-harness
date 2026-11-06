// `/subagent trace [worker]`: one worker's tool calls as compact text the user can paste for a cost review. Field report: a usage line
// showed a 28-turn backend-worker at $0.63, and the only way to see why was the live inspector, whose shortcut closed the terminal tab.
// Each line is one call: tool, target, output size, and flags for repeats, whole reads of large files and errors. Every output stays in
// the worker's context for the rest of its run, so the summary ranks outputs by size times the calls that came after them.

export interface TraceTool { name: string; command: string; state: "running" | "ok" | "error"; output: string; outputChars?: number; range?: string; target?: string; startedAt: number; endedAt?: number }
export interface TraceRecord { id: string; name: string; task: string; state: string; model: string; reportedModel?: string; cwd?: string; startedAt: number; endedAt?: number; tools: TraceTool[] }

const LARGE_WHOLE_READ = 12_000;
const TARGET_WIDTH = 72;

const kchars = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));
const sizeOf = (t: TraceTool) => t.outputChars ?? t.output.length;
const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();
/** The call's target without the tool name: the shell command, or the path and pattern. */
export function traceTarget(t: TraceTool): string {
	const text = t.command.startsWith("$ ") ? t.command.slice(2) : t.command.startsWith(`${t.name} · `) ? t.command.slice(t.name.length + 3) : t.command;
	const target = oneLine(text) + (t.range ? ` (${t.range})` : "");
	return target.length > TARGET_WIDTH ? `${target.slice(0, TARGET_WIDTH - 1)}…` : target;
}
const workerNumber = (r: TraceRecord) => r.id.split(":").pop() ?? r.id;

export function formatTraceIndex(records: TraceRecord[]): string {
	if (!records.length) return "No workers in this Pi session yet (records reset on /reload or a session change).";
	return [
		"Workers in this Pi session (newest last). Run /subagent trace <#number or role> for one worker's tool calls:",
		...records.map((r) => `  #${workerNumber(r)} ${r.name} · ${r.state} · ${r.tools.length} tool calls · ${oneLine(r.task).slice(0, 80)}`),
	].join("\n");
}

/** Pick a worker by "#3", "3" or a role name (the newest of that role). */
export function pickWorker(records: TraceRecord[], selector: string): TraceRecord | undefined {
	const s = selector.trim().replace(/^#/, "");
	return records.find((r) => workerNumber(r) === s) ?? [...records].reverse().find((r) => r.name === s);
}

export function formatTrace(r: TraceRecord): string {
	const seen = new Map<string, number>();
	const lines: string[] = [];
	const counts = new Map<string, number>();
	let total = 0, repeats = 0, repeatChars = 0, errors = 0, wholeLarge = 0;
	const carried: { n: number; size: number; later: number }[] = [];
	r.tools.forEach((t, i) => {
		const n = i + 1;
		const size = sizeOf(t);
		total += size;
		counts.set(t.name, (counts.get(t.name) ?? 0) + 1);
		const key = `${t.name}\0${t.command}\0${t.range ?? ""}`;
		const flags: string[] = [];
		const first = seen.get(key);
		if (first !== undefined && t.name !== "edit" && t.name !== "write") { flags.push(`repeat of #${first}`); repeats++; repeatChars += size; } else if (first === undefined) seen.set(key, n);
		if (t.name === "read" && !t.range && size >= LARGE_WHOLE_READ) { flags.push("whole read of a large file"); wholeLarge++; }
		if (t.state === "error") { flags.push("error"); errors++; }
		if (t.state === "running") flags.push("running");
		const seconds = t.endedAt !== undefined ? `${Math.max(0, Math.round((t.endedAt - t.startedAt) / 1000))}s` : "";
		lines.push(`${String(n).padStart(3)}  ${t.name.padEnd(10)} ${traceTarget(t).padEnd(TARGET_WIDTH)} ${kchars(size).padStart(6)} chars ${seconds.padStart(5)}${flags.length ? `  ${flags.join("; ")}` : ""}`);
		carried.push({ n, size, later: r.tools.length - n });
	});
	const minutes = r.endedAt !== undefined ? ` · ${Math.round((r.endedAt - r.startedAt) / 60_000)} min` : "";
	const byTool = [...counts].sort((a, b) => b[1] - a[1]).map(([name, c]) => `${name} ${c}`).join(", ");
	const heaviest = carried.filter((c) => c.size > 0).sort((a, b) => b.size * b.later - a.size * a.later).slice(0, 5)
		.map((c) => `#${c.n} ${kchars(c.size)} chars × ${c.later} later calls`);
	return [
		`Tool trace: #${workerNumber(r)} ${r.name} · ${r.state} · ${(r.reportedModel ?? r.model).split("/").pop()}${minutes}`,
		`Task: ${oneLine(r.task).slice(0, 200)}`,
		`${r.tools.length} tool calls (${byTool || "none"}); output ${kchars(total)} chars (~${kchars(Math.round(total / 4))} tokens); repeats ${repeats} (${kchars(repeatChars)} chars); whole reads of large files ${wholeLarge}; errors ${errors}`,
		...(heaviest.length ? [`Carried longest (each output stays in context for the later calls): ${heaviest.join(", ")}`] : []),
		"",
		...lines,
	].join("\n");
}

// `/subagent changes [worker]` (after Claude Code's /rewind): the files a worker edited or wrote, how they differ from the last commit now,
// and the exact commands that would undo them. It never runs them: restoring discards every uncommitted change in those files, including
// any made before the worker started, so the user runs them or main asks for approval first.
export type GitRead = (cwd: string, args: string[]) => string | undefined;
export function formatChanges(r: TraceRecord, git: GitRead): string {
	const counts = new Map<string, { edits: number; writes: number }>();
	for (const t of r.tools) {
		if ((t.name !== "edit" && t.name !== "write") || t.state !== "ok" || !t.target) continue;
		const c = counts.get(t.target) ?? { edits: 0, writes: 0 };
		if (t.name === "edit") c.edits++; else c.writes++;
		counts.set(t.target, c);
	}
	const head = `Changes by #${workerNumber(r)} ${r.name} (${r.state})${r.cwd ? ` in ${r.cwd}` : ""}`;
	if (!counts.size) return `${head}: no successful edit or write.`;
	if (!r.cwd) return `${head}: files ${[...counts.keys()].join(", ")}; the worker's folder is unknown, so their current state cannot be shown.`;
	const files = [...counts.keys()];
	const status = new Map<string, string>();
	for (const line of (git(r.cwd, ["status", "--porcelain=v1", "--untracked-files=all", "--", ...files]) ?? "").split(/\r?\n/)) if (line.length > 3) status.set(line.slice(3).replace(/^"|"$/g, ""), line.slice(0, 2));
	const stat = new Map<string, string>();
	for (const line of (git(r.cwd, ["diff", "HEAD", "--numstat", "--", ...files]) ?? "").split(/\r?\n/)) { const m = /^(\d+|-)\t(\d+|-)\t(.+)$/.exec(line); if (m) stat.set(m[3], `+${m[1]} -${m[2]}`); }
	const rel = (f: string) => f.replace(/\\/g, "/").replace(/^\.\//, "");
	const tracked: string[] = [], added: string[] = [], clean: string[] = [];
	const lines = files.map((f) => {
		const key = [...status.keys()].find((k) => k === rel(f) || rel(f).endsWith(`/${k}`) || k.endsWith(rel(f)));
		const st = key ? status.get(key)! : "";
		const diff = [...stat.entries()].find(([k]) => k === rel(f) || rel(f).endsWith(`/${k}`) || k.endsWith(rel(f)))?.[1];
		if (st.includes("?")) added.push(f); else if (st.trim()) tracked.push(f); else clean.push(f);
		const c = counts.get(f)!;
		const what = [c.edits ? `${c.edits} edit${c.edits === 1 ? "" : "s"}` : "", c.writes ? `${c.writes} write${c.writes === 1 ? "" : "s"}` : ""].filter(Boolean).join(", ");
		return `  ${f}  (${what})  ${st.includes("?") ? "new, untracked" : st.trim() ? `modified ${diff ?? ""}`.trim() : "no uncommitted change now"}`;
	});
	const undo = [
		...(tracked.length ? [`  git restore -- ${tracked.map((f) => (/\s/.test(f) ? `"${f}"` : f)).join(" ")}`] : []),
		...(added.length ? [`  delete the new files: ${added.join(", ")}`] : []),
	];
	return [
		`${head}:`,
		...lines,
		...(undo.length ? ["To undo (not run; it discards every uncommitted change in these files, including any made before this worker; run it yourself or ask main to request approval):", ...undo] : ["Nothing to undo: these files have no uncommitted change now."]),
	].join("\n");
}
