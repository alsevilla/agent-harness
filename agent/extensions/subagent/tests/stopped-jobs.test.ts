// Field report: after /reload, `subagent_control result bg-12@<old epoch>` said only "epoch mismatch"; the reload had stopped the job.
// Review: records are scoped to the originating session and taken only by that session (reload) or its successor (new/resume/fork).
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { BackgroundWorkers } from "../background.ts";
import { stateCard } from "../handoff-window.ts";
import { recordFile, saveStoppedJobs, takeStoppedJobs } from "../stopped-jobs.ts";

const ctxFor = (sessionFile: string, notes: string[] = []) => ({ sessionManager: { getSessionFile: () => sessionFile, getSessionId: () => "id" }, ui: { notify: (text: string) => notes.push(text) } });
function runtime(epoch: string, dir: string, records = new Map<string, { name: string; task: string }>()) {
	const handlers = new Map<string, (event: unknown, ctx: unknown) => void>();
	const pi = { on: (name: string, fn: (event: unknown, ctx: unknown) => void) => handlers.set(name, fn) };
	const rt = new BackgroundWorkers(pi as never, { store: { records, changed() {} } } as never, undefined, epoch);
	rt.stoppedJobsDir = dir;
	return { rt, fire: (name: string, event: unknown, ctx: unknown) => handlers.get(name)?.(event, ctx) };
}
const running = (id: string, workerIds: string[]) => ({ id, generation: 0, state: "running", controller: new AbortController(), workerIds, nodes: new Map(), pendingSteers: [] });
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "stopped-jobs-"));
const job = (task: string, stoppedAt = new Date().toISOString()) => ({ job: "bg-1@abc", roles: ["scout"], task, stoppedAt });

test("reload: the session records its running jobs, then takes them back; notice, state card and a one-time result explanation", () => {
	const dir = tmp();
	try {
		const A = "/sessions/a.jsonl";
		const records = new Map([["w1", { name: "backend-worker", task: "Implement API seam ONLY for approved SMS visibility slice.\nSole writer candidate C:/w/RFID" }]]);
		const before = runtime("aaaa1111", dir, records);
		(before.rt.jobs as Map<string, unknown>).set("bg-12", running("bg-12", ["w1"]));
		(before.rt.jobs as Map<string, unknown>).set("bg-11", { ...running("bg-11", []), state: "completed" });
		before.fire("session_shutdown", { reason: "reload" }, ctxFor(A));
		const saved = JSON.parse(fs.readFileSync(recordFile(dir, A), "utf8"));
		assert.equal(saved.session, A);
		assert.equal(saved.reason, "reload");
		assert.deepEqual(saved.jobs.map((j: { job: string }) => j.job), ["bg-12@aaaa1111"], "only running jobs");
		assert.match(saved.jobs[0].task, /^Implement API seam ONLY for approved SMS visibility slice\. Sole writer candidate C:\/w\/RFID$/);

		const notes: string[] = [];
		const after = runtime("bbbb2222", dir);
		after.fire("session_start", { reason: "reload" }, ctxFor(A, notes));
		assert.equal(fs.existsSync(recordFile(dir, A)), false, "taken once");
		assert.match(notes[0], /^Stopped by the last reload or session change: bg-12@aaaa1111 \(backend-worker\): Implement API seam/);
		assert.match(stateCard([], "bbbb2222", 0, after.rt.stoppedEarlier) ?? "", /no result will arrive: bg-12@aaaa1111 \(backend-worker\); check their candidates and ask the user before relaunching/);
		assert.throws(() => after.rt.result("bg-12@aaaa1111"), /epoch mismatch.*stopped by a reload or session change at .* while backend-worker ran "Implement API seam.*No outcome is implied/s);
		assert.equal(after.rt.stoppedEarlier.length, 0, "asking drops the card line");
		assert.throws(() => after.rt.result("bg-12@aaaa1111"), (e: Error) => !/stopped by a reload/.test(e.message), "explained once");
	} finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("/new: the successor takes its predecessor's record through previousSessionFile; the unqualified id works in the same runtime", () => {
	const dir = tmp();
	try {
		const A = "/sessions/a.jsonl", B = "/sessions/b.jsonl";
		const rt = runtime("cccc3333", dir, new Map([["w", { name: "scout", task: "map the SMS module" }]]));
		(rt.rt.jobs as Map<string, unknown>).set("bg-3", running("bg-3", ["w"]));
		rt.fire("session_shutdown", { reason: "new" }, ctxFor(A));
		rt.fire("session_start", { reason: "new", previousSessionFile: A }, ctxFor(B));
		assert.equal(rt.rt.stoppedEarlier.length, 1);
		assert.throws(() => rt.rt.result("bg-3"), /Result unavailable for "bg-3"\. It was stopped by a reload or session change .* while scout ran "map the SMS module"/);
		rt.fire("session_shutdown", { reason: "quit" }, ctxFor(B));
		assert.deepEqual(fs.readdirSync(dir), [], "nothing running: no record");
	} finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("parallel sessions: one session never reads, overwrites or deletes another's record", () => {
	const dir = tmp();
	try {
		const A = "/sessions/a.jsonl", C = "/sessions/c.jsonl";
		saveStoppedJobs(dir, { session: A, reason: "reload" }, [job("A's job")]);
		saveStoppedJobs(dir, { session: C, reason: "reload" }, [job("C's job")]);
		assert.equal(fs.readdirSync(dir).length, 2, "one file per originating session");
		assert.deepEqual(takeStoppedJobs(dir, { current: C }).map((j) => j.task), ["C's job"]);
		assert.equal(fs.existsSync(recordFile(dir, A)), true, "A's record is untouched");
		assert.deepEqual(takeStoppedJobs(dir, { current: A }).map((j) => j.task), ["A's job"]);
	} finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("a predecessor record that named a different successor is left for that session", () => {
	const dir = tmp();
	try {
		const A = "/sessions/a.jsonl";
		saveStoppedJobs(dir, { session: A, target: "/sessions/b.jsonl", reason: "resume" }, [job("for b")]);
		assert.deepEqual(takeStoppedJobs(dir, { current: "/sessions/x.jsonl", previous: A }), [], "not x's");
		assert.deepEqual(takeStoppedJobs(dir, { current: "/sessions/b.jsonl", previous: A }).map((j) => j.task), ["for b"]);
	} finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("stale, malformed and foreign entries are dropped; a missing directory is fine", () => {
	const dir = tmp();
	try {
		assert.deepEqual(takeStoppedJobs(path.join(dir, "none"), { current: "/s" }), []);
		const now = Date.parse("2026-11-05T12:00:00Z");
		saveStoppedJobs(dir, { session: "/s" }, [job("fresh", "2026-11-05T11:00:00Z"), job("stale", "2026-11-03T11:00:00Z"), { ...job("foreign"), job: "rm -rf /" }]);
		assert.deepEqual(takeStoppedJobs(dir, { current: "/s" }, now).map((j) => j.task), ["fresh"]);
		fs.writeFileSync(recordFile(dir, "/s"), "{not json");
		assert.deepEqual(takeStoppedJobs(dir, { current: "/s" }, now), []);
	} finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
