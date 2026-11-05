// `/subagent trace [worker]`: one worker's tool calls as compact text the user can paste for a cost review. Field report: a usage line
// showed a 28-turn backend-worker at $0.63, and the only way to see why was the live inspector, whose shortcut closed the terminal tab.
// Each line is one call: tool, target, output size, and flags for repeats, whole reads of large files and errors. Every output stays in
// the worker's context for the rest of its run, so the summary ranks outputs by size times the calls that came after them.

export interface TraceTool { name: string; command: string; state: "running" | "ok" | "error"; output: string; outputChars?: number; range?: string; startedAt: number; endedAt?: number }
export interface TraceRecord { id: string; name: string; task: string; state: string; model: string; reportedModel?: string; startedAt: number; endedAt?: number; tools: TraceTool[] }

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
