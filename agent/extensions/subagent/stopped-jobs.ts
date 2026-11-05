// Jobs a /reload or session change stopped. Shutdown aborts every running background job and clears its memory, so the new runtime
// could only answer "epoch mismatch" for them. Shutdown now writes a small record (job, roles, a short task label, time) and the next
// runtime reads it once, deletes it, tells the user and keeps one line in main's state card until main asks about the job.
import * as fs from "node:fs";
import * as path from "node:path";

export type StoppedJob = { job: string; roles: string[]; task: string; stoppedAt: string };
export const STOPPED_JOBS_FILE = "stopped-jobs.json";
const MAX_AGE_MS = 24 * 60 * 60_000;
const MAX_JOBS = 8;

const oneLine = (text: string, max: number) => {
	const line = text.replace(/[\x00-\x1f\x7f]+/g, " ").replace(/\s+/g, " ").trim();
	return line.length > max ? `${line.slice(0, max - 1)}…` : line;
};

/** Write the stopped jobs; nothing is written when none were running. Errors are swallowed: this is a courtesy, never a gate. */
export function saveStoppedJobs(file: string, jobs: StoppedJob[]): void {
	if (!jobs.length) return;
	try {
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(file, JSON.stringify(jobs.slice(0, MAX_JOBS).map((j) => ({ ...j, task: oneLine(j.task, 160), roles: j.roles.map((r) => oneLine(r, 64)) })), null, 2));
	} catch { /* best effort */ }
}

/** Read and delete the record once. Malformed, foreign or stale (over 24 hours) entries are dropped. */
export function takeStoppedJobs(file: string, now = Date.now()): StoppedJob[] {
	let raw: string;
	try { raw = fs.readFileSync(file, "utf8"); } catch { return []; }
	try { fs.rmSync(file, { force: true }); } catch { /* read once anyway */ }
	try {
		const parsed: unknown = JSON.parse(raw);
		if (!Array.isArray(parsed)) return [];
		return parsed.filter((j): j is StoppedJob => !!j && typeof j.job === "string" && /^bg-\d+@[A-Za-z0-9]{1,16}$/.test(j.job)
			&& Array.isArray(j.roles) && j.roles.every((r: unknown) => typeof r === "string") && typeof j.task === "string"
			&& typeof j.stoppedAt === "string" && now - Date.parse(j.stoppedAt) >= 0 && now - Date.parse(j.stoppedAt) <= MAX_AGE_MS).slice(0, MAX_JOBS);
	} catch { return []; }
}

const who = (j: StoppedJob) => `${j.job} (${j.roles.join(", ") || "starting"})`;

export function stoppedJobsNotice(jobs: StoppedJob[]): string {
	return `Stopped by the last reload or session change: ${jobs.map((j) => `${who(j)}: ${j.task}`).join("; ")}. Check each job's candidate checkout and REPORT for partial work before relaunching.`;
}

export function stoppedJobsCardPart(jobs: StoppedJob[]): string {
	return `stopped by the last reload or session change, no result will arrive: ${jobs.map(who).join("; ")}; check their candidates and ask the user before relaunching`;
}

export function stoppedJobDetail(j: StoppedJob): string {
	return ` It was stopped by a reload or session change at ${j.stoppedAt} while ${j.roles.join(", ") || "a worker"} ran "${j.task}"; check that candidate checkout and its REPORT for partial work, then ask the user before relaunching.`;
}
