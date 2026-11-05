// Jobs a /reload or session change stopped. Shutdown aborts every running background job and clears its memory, so the new runtime
// could only answer "epoch mismatch" for them. Shutdown writes one small record per ORIGINATING session (job, roles, a short task
// label, time, the shutdown reason and target session). The next runtime takes only its own session's record (after /reload) or its
// predecessor's (previousSessionFile after /new, resume or fork); other Pi sessions' records are never read, overwritten or deleted.
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

export type StoppedJob = { job: string; roles: string[]; task: string; stoppedAt: string };
export interface StoppedRecord { session: string; target?: string; reason?: string; jobs: StoppedJob[] }
export const STOPPED_JOBS_DIR = "stopped-jobs";
const MAX_AGE_MS = 24 * 60 * 60_000;
const MAX_JOBS = 8;

const oneLine = (text: string, max: number) => {
	const line = text.replace(/[\x00-\x1f\x7f]+/g, " ").replace(/\s+/g, " ").trim();
	return line.length > max ? `${line.slice(0, max - 1)}…` : line;
};
/** One file per originating session: a hash of its session file (or id), so names never collide and never echo a path. */
export const recordFile = (dir: string, session: string) => path.join(dir, `${createHash("sha256").update(session).digest("hex").slice(0, 24)}.json`);

/** Write this session's stopped jobs; nothing when none were running. Errors are swallowed: a courtesy, never a gate. */
export function saveStoppedJobs(dir: string, origin: { session: string; target?: string; reason?: string }, jobs: StoppedJob[]): void {
	if (!jobs.length || !origin.session) return;
	const record: StoppedRecord = { ...origin, jobs: jobs.slice(0, MAX_JOBS).map((j) => ({ ...j, task: oneLine(j.task, 160), roles: j.roles.map((r) => oneLine(r, 64)) })) };
	try {
		fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(recordFile(dir, origin.session), JSON.stringify(record, null, 2));
	} catch { /* best effort */ }
}

const validJobs = (jobs: unknown, now: number): StoppedJob[] => (Array.isArray(jobs) ? jobs : []).filter((j): j is StoppedJob => !!j && typeof j.job === "string"
	&& /^bg-\d+@[A-Za-z0-9]{1,16}$/.test(j.job) && Array.isArray(j.roles) && j.roles.every((r: unknown) => typeof r === "string") && typeof j.task === "string"
	&& typeof j.stoppedAt === "string" && now - Date.parse(j.stoppedAt) >= 0 && now - Date.parse(j.stoppedAt) <= MAX_AGE_MS).slice(0, MAX_JOBS);

/**
 * Take (read and delete) the records that belong to this session: its own (a /reload of the same session) and its predecessor's
 * (`previous`, after /new, resume or fork). A predecessor record that named a different successor is left for that session.
 * Records older than 24 hours are removed for every session, since they can no longer be acted on.
 */
export function takeStoppedJobs(dir: string, scope: { current: string; previous?: string }, now = Date.now()): StoppedJob[] {
	const taken: StoppedJob[] = [];
	const owners = [...new Set([scope.current, scope.previous].filter((s): s is string => !!s))];
	for (const owner of owners) {
		const file = recordFile(dir, owner);
		let record: StoppedRecord;
		try { record = JSON.parse(fs.readFileSync(file, "utf8")); } catch { continue; }
		if (!record || record.session !== owner) continue;
		const mine = owner === scope.current || !record.target || record.target === scope.current;
		if (!mine) continue;
		try { fs.rmSync(file, { force: true }); } catch { /* read once anyway */ }
		taken.push(...validJobs(record.jobs, now));
	}
	try {
		for (const name of fs.readdirSync(dir)) {
			const file = path.join(dir, name);
			try { if (now - fs.statSync(file).mtimeMs > MAX_AGE_MS) fs.rmSync(file, { force: true }); } catch { /* skip */ }
		}
	} catch { /* no directory yet */ }
	return taken.slice(0, MAX_JOBS);
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
