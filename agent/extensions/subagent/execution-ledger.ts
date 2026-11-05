// Execution ledger for workers (after Ledger, arXiv 2608.00808: an explicit execution state of what an agent has observed, modified and
// attempted cut SWE-bench cost 28.9% and 31.8% and raised Pass@1; the state view gave most of the cost saving, the action checks most of
// the success gain). Deterministic: built only from this worker's completed tool calls, no model calls.
//
// - Observations: which files, and which line ranges of them, a read actually returned (truncated or failed reads are not coverage),
//   and whether each is still current: the worker has not edited that file since, and no shell command that may change files has run.
// - Modifications: files changed through edit or write, with counts.
// - Commands: normalized shell commands with their category (inspect, check, other) and outcome.
//
// Inform: a short state view is appended to the end of each request (after the history, so the cached prefix is untouched; regenerated
// every request, never stored). Govern, after a call ran: an inspection command that returns exactly its earlier output under unchanged
// conditions is replaced by a one-line reference to it (like the duplicate-read note), and a check repeated with no change since, or the
// same command run three times in a short span, gets one appended line. Nothing is ever blocked; interventions are capped per run, never
// repeated for the same command, and a command run again right after its note passes untouched.
import { createHash } from "node:crypto";
import * as path from "node:path";
import { foldCase } from "./path-case.ts";

type Part = { type: string; text?: string };
export const LEDGER_TYPE = "subagent-ledger";
const MAX_INTERVENTIONS = 8;
const VIEW_MIN_CALLS = 4;
const VIEW_FILES = 10;
const VIEW_COMMANDS = 6;
const LOOP_SPAN = 6;

type Category = "inspect" | "check" | "other";
interface Observation { start: number; end?: number; step: number; fileEdits: number; shell: number } // end undefined = whole file
interface FileState { display: string; edits: number; lastEditStep?: number; observations: Observation[] }
interface CommandRecord { norm: string; display: string; category: Category; step: number; global: number; failed: boolean; hash?: string }

const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const textOf = (content: unknown) => (Array.isArray(content) ? (content as Part[]).filter((p) => p?.type === "text" && typeof p.text === "string").map((p) => p.text).join("\n") : "");

const CHECK = /\b(?:cargo\s+(?:test|nextest|check|clippy|build)|(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:test|build|lint|check|typecheck)|vitest|jest|pytest|go\s+(?:test|build|vet)|dotnet\s+(?:test|build)|node\s+--test|tsc\b|eslint\b|mvn\s+(?:test|verify)|gradle\w*\s+(?:test|build)|playwright\s+test)/i;
const INSPECT = /^(?:cat|head|tail|less|ls|dir|tree|wc|file|stat|rg|grep|egrep|find|fd|sed\s+-n|awk|type|Get-Content|gc|Get-ChildItem|gci|Select-String|sls|Test-Path|Select-Object|sort|uniq|Measure-Object|git\s+(?:status|diff|log|show|blame|ls-files|grep|branch)|node\s+\S*serena\.mjs|(?:python3?|py)\s+\S*read_graph\.py)\b/i;
const WRITES = /(?:^|[^<>&\d])>{1,2}(?!&)|\b(?:tee|Set-Content|Add-Content|Out-File|New-Item|Remove-Item|Move-Item|Copy-Item|rm|mv|cp|mkdir|touch|chmod)\b|\bsed\s+(?:-[a-z]*i|--in-place)|\bperl\s+-[a-z]*i/i;

/** One shell command without incidental differences: leading `cd <dir> &&`/`;`, repeated spaces and surrounding whitespace. */
export function normalizeCommand(command: string): string {
	let c = command.trim().replace(/\s+/g, " ");
	for (let i = 0; i < 3; i++) {
		const next = c.replace(/^(?:cd|Set-Location|pushd)\s+(?:"[^"]*"|'[^']*'|\S+)\s*(?:&&|;)\s*/i, "");
		if (next === c) break;
		c = next;
	}
	return c;
}
export function commandCategory(norm: string): Category {
	if (CHECK.test(norm)) return "check";
	// Inspect only when every piece of a compound command reads (cat a | grep x, rg y; git status) and nothing redirects or writes.
	// Quoted text is blanked only for the write check (a quoted ">" in a grep pattern is not a redirect); pieces keep their quoted paths.
	const unquoted = norm.replace(/"[^"]*"|'[^']*'/g, '""');
	const pieces = norm.split(/&&|\|\||;|\|/).map((p) => p.trim()).filter(Boolean);
	if (pieces.length && !WRITES.test(unquoted) && pieces.every((p) => INSPECT.test(p))) return "inspect";
	return "other";
}

/** Lines a successful read actually returned (1-based, end inclusive; end undefined = the whole file). Undefined = no coverage. */
export function readCoverage(input: { offset?: unknown; limit?: unknown }, text: string): { start: number; end?: number } | undefined {
	if (/^\[Line \d+ is .* exceeds /m.test(text)) return undefined;
	const shown = /\n\n\[Showing lines (\d+)-(\d+) of \d+/.exec(text);
	if (shown) return { start: Number(shown[1]), end: Number(shown[2]) };
	const start = typeof input.offset === "number" && input.offset > 0 ? Math.floor(input.offset) : 1;
	const more = /\n\n\[\d+ more lines in file\. Use offset=(\d+) to continue\.\]$/.exec(text);
	if (more) return { start, end: Number(more[1]) - 1 };
	return start === 1 ? { start } : { start, end: undefined };
}

const rangeLabel = (o: Observation) => (o.end === undefined ? (o.start === 1 ? "whole file" : `lines ${o.start}-end`) : `lines ${o.start}-${o.end}`);
const short = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

export function createExecutionLedger() {
	let step = 0;
	let global = 0; // advances on every edit/write and every shell command that may change files
	let shell = 0; // advances only on shell commands that may change files (not inspect or check)
	let interventions = 0;
	let lastOther: CommandRecord | undefined;
	const files = new Map<string, FileState>();
	const commands: CommandRecord[] = [];
	const noted = new Set<string>(); // commands that already received a note
	let viewOff = false; // older outputs were masked or compacted: earlier copies may be gone, so no "still current" claims or reuse

	const fileFor = (cwd: string, p: string): FileState => {
		const key = foldCase(path.resolve(cwd, p.replace(/^@/, "")));
		let f = files.get(key);
		if (!f) { f = { display: p.replace(/^@/, ""), edits: 0, observations: [] }; files.set(key, f); }
		return f;
	};
	const intervene = (norm: string) => {
		if (interventions >= MAX_INTERVENTIONS || noted.has(norm)) return false;
		interventions++;
		noted.add(norm);
		return true;
	};

	return {
		/** Record a completed call; returns replacement content (a reuse note, or the output with one appended line) or undefined. */
		onResult(toolName: string, input: unknown, content: unknown, isError: boolean, cwd: string): Part[] | undefined {
			step++;
			const args = (input ?? {}) as Record<string, unknown>;
			if ((toolName === "edit" || toolName === "write") && typeof args.path === "string") {
				if (isError) return undefined;
				const f = fileFor(cwd, args.path);
				f.edits++; f.lastEditStep = step; global++;
				return undefined;
			}
			if (toolName === "read" && typeof args.path === "string") {
				if (isError) return undefined;
				const text = textOf(content);
				const coverage = text ? readCoverage(args, text) : undefined;
				if (coverage) {
					const f = fileFor(cwd, args.path);
					f.observations = [...f.observations.slice(-4), { ...coverage, step, fileEdits: f.edits, shell }];
				}
				return undefined;
			}
			if ((toolName !== "bash" && toolName !== "powershell") || typeof args.command !== "string") return undefined;
			const norm = normalizeCommand(args.command);
			const category = commandCategory(norm);
			const output = textOf(content);
			const earlier = [...commands].reverse().find((c) => c.norm === norm);
			const record: CommandRecord = { norm, display: short(norm, 90), category, step, global, failed: isError, hash: category === "inspect" ? hash(output) : undefined };
			// A command run again right after its note passes untouched (no loop between the worker and the runtime).
			const justNoted = noted.has(norm) && earlier && earlier.step === step - 1;
			let result: Part[] | undefined;
			if (earlier && !justNoted && earlier.global === global) {
				if (category === "inspect" && !viewOff && !isError && earlier.hash === record.hash && output.length >= 200 && intervene(norm)) {
					result = [{ type: "text", text: `[unchanged: \`${record.display}\` returned exactly what it returned at step ${earlier.step}, and no file changed since; use that earlier output.]` }];
				} else if (category === "check" && intervene(norm)) {
					result = [...((content as Part[]) ?? []), { type: "text", text: `[harness] Same check as step ${earlier.step} (${earlier.failed ? "failed" : "passed"} then), and no file changed since. Rerun it only for a cause outside the files (environment, a service, flakiness); otherwise act on that result.` }];
				}
			}
			if (!result) {
				const recent = commands.filter((c) => c.step > step - LOOP_SPAN && c.norm === norm).length;
				if (recent >= 2 && category !== "check" && intervene(norm)) result = [...((content as Part[]) ?? []), { type: "text", text: `[harness] \`${record.display}\` has now run ${recent + 1} times in the last ${LOOP_SPAN} calls. If it is not giving you something new, change the approach.` }];
			}
			commands.push(record);
			if (commands.length > 200) commands.splice(0, commands.length - 200);
			if (category === "other") { global++; shell++; lastOther = record; }
			return result;
		},
		/** The state view appended to the end of a request, or undefined while there is little to show. */
		view(): string | undefined {
			const calls = commands.length + [...files.values()].reduce((n, f) => n + f.observations.length + f.edits, 0);
			if (calls < VIEW_MIN_CALLS) return undefined;
			const lines = ["[execution state: facts from this run's tool calls, kept by the harness; not instructions]"];
			const changed = [...files.values()].filter((f) => f.edits > 0).sort((a, b) => (b.lastEditStep ?? 0) - (a.lastEditStep ?? 0)).slice(0, VIEW_FILES);
			if (changed.length) lines.push(`Changed by you: ${changed.map((f) => `${f.display} (${f.edits} edit${f.edits === 1 ? "" : "s"}, last at step ${f.lastEditStep})`).join("; ")}`);
			if (!viewOff) {
				const current: string[] = [];
				const stale: string[] = [];
				for (const f of [...files.values()].reverse()) {
					for (const o of f.observations) {
						const label = `${f.display} ${rangeLabel(o)} (step ${o.step})`;
						if (f.edits > o.fileEdits) stale.push(`${label}: you edited it at step ${f.lastEditStep}`);
						else if (shell > o.shell && lastOther && lastOther.step > o.step) stale.push(`${label}: \`${lastOther.display}\` at step ${lastOther.step} may have changed files`);
						else current.push(label);
					}
				}
				if (current.length) lines.push(`Read and still current (the earlier output is the file now): ${current.slice(0, VIEW_FILES).join("; ")}`);
				if (stale.length) lines.push(`Read, but may have changed since: ${stale.slice(0, VIEW_FILES).join("; ")}`);
			}
			const checks = new Map<string, CommandRecord>();
			for (const c of commands) if (c.category === "check") checks.set(c.norm, c);
			const lastChecks = [...checks.values()].sort((a, b) => b.step - a.step).slice(0, VIEW_COMMANDS);
			if (lastChecks.length) lines.push(`Checks (latest run of each): ${lastChecks.map((c) => `\`${c.display}\` ${c.failed ? "failed" : "passed"} at step ${c.step}${c.global === global ? ", no change since" : ", files changed since"}`).join("; ")}`);
			return lines.length > 1 ? lines.join("\n") : undefined;
		},
		/** Older outputs were masked or the run was compacted: earlier copies may be gone, so stop claiming them current or reusing them. */
		earlierCopiesGone(): void { viewOff = true; },
		/** After a compaction everything before it is a summary; start the observation index again. */
		compacted(): void { for (const f of files.values()) f.observations = []; viewOff = false; },
		get interventions() { return interventions; },
	};
}
