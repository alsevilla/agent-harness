// Field report: after /reload, `subagent_control result bg-12@<old epoch>` said only "epoch mismatch"; the reload had stopped the job.
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { BackgroundWorkers } from "../background.ts";
import { stateCard } from "../handoff-window.ts";
import { saveStoppedJobs, takeStoppedJobs } from "../stopped-jobs.ts";

function runtime(epoch: string, file: string, records = new Map<string, { name: string; task: string }>()) {
	const handlers = new Map<string, (event: unknown, ctx: unknown) => void>();
	const pi = { on: (name: string, fn: (event: unknown, ctx: unknown) => void) => handlers.set(name, fn) };
	const monitor = { store: { records, changed() {} } };
	const rt = new BackgroundWorkers(pi as never, monitor as never, undefined, epoch);
	rt.stoppedJobsFile = file;
	return { rt, fire: (name: string, ctx?: unknown) => handlers.get(name)?.({}, ctx) };
}
const running = (id: string, workerIds: string[]) => ({ id, generation: 0, state: "running", controller: new AbortController(), workerIds, nodes: new Map(), pendingSteers: [] });

test("a reload records the running jobs; the next runtime tells the user, keeps a state-card line and explains the result once", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "stopped-jobs-"));
	const file = path.join(dir, "run-state", "stopped-jobs.json");
	try {
		const records = new Map([["w1", { name: "backend-worker", task: "Implement API seam ONLY for approved SMS visibility slice.\nSole writer candidate C:/w/RFID" }]]);
		const a = runtime("aaaa1111", file, records);
		(a.rt.jobs as Map<string, unknown>).set("bg-12", running("bg-12", ["w1"]));
		(a.rt.jobs as Map<string, unknown>).set("bg-11", { ...running("bg-11", []), state: "completed" });
		a.fire("session_shutdown");
		const saved = JSON.parse(fs.readFileSync(file, "utf8"));
		assert.equal(saved.length, 1, "only running jobs are recorded");
		assert.equal(saved[0].job, "bg-12@aaaa1111");
		assert.deepEqual(saved[0].roles, ["backend-worker"]);
		assert.match(saved[0].task, /^Implement API seam ONLY for approved SMS visibility slice\. Sole writer candidate C:\/w\/RFID$/, "one line");

		const notes: string[] = [];
		const b = runtime("bbbb2222", file);
		b.fire("session_start", { ui: { notify: (text: string) => notes.push(text) } });
		assert.equal(fs.existsSync(file), false, "read once and deleted");
		assert.match(notes[0], /^Stopped by the last reload or session change: bg-12@aaaa1111 \(backend-worker\): Implement API seam/);
		assert.match(notes[0], /Check each job's candidate checkout and REPORT for partial work before relaunching/);
		assert.match(stateCard([], "bbbb2222", 0, b.rt.stoppedEarlier) ?? "", /stopped by the last reload or session change, no result will arrive: bg-12@aaaa1111 \(backend-worker\); check their candidates and ask the user before relaunching/);

		assert.throws(() => b.rt.result("bg-12@aaaa1111"), /epoch mismatch.*stopped by a reload or session change at .* while backend-worker ran "Implement API seam.*check that candidate checkout and its REPORT for partial work, then ask the user before relaunching\. No outcome is implied/s);
		assert.equal(b.rt.stoppedEarlier.length, 0, "asking about it drops the state-card line");
		assert.equal(stateCard([], "bbbb2222", 0, b.rt.stoppedEarlier), undefined);
		assert.throws(() => b.rt.result("bg-12@aaaa1111"), (e: Error) => /epoch mismatch/.test(e.message) && !/stopped by a reload/.test(e.message), "explained once");
	} finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("/new in the same runtime: the unqualified id is explained too; no running job writes nothing", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "stopped-jobs-"));
	const file = path.join(dir, "stopped-jobs.json");
	try {
		const a = runtime("cccc3333", file, new Map([["w", { name: "scout", task: "map the SMS module" }]]));
		(a.rt.jobs as Map<string, unknown>).set("bg-3", running("bg-3", ["w"]));
		a.fire("session_shutdown");
		a.fire("session_start");
		assert.equal(a.rt.stoppedEarlier.length, 1);
		assert.throws(() => a.rt.result("bg-3"), /Result unavailable for "bg-3"\. It was stopped by a reload or session change .* while scout ran "map the SMS module"/);
		a.fire("session_shutdown");
		assert.equal(fs.existsSync(file), false, "nothing running: no record");
	} finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("records are dropped when stale, malformed or foreign; a missing file is fine", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "stopped-jobs-"));
	const file = path.join(dir, "s.json");
	try {
		assert.deepEqual(takeStoppedJobs(file), []);
		const now = Date.parse("2026-11-05T12:00:00Z");
		saveStoppedJobs(file, [
			{ job: "bg-1@abc", roles: ["scout"], task: "fresh", stoppedAt: "2026-11-05T11:00:00Z" },
			{ job: "bg-2@abc", roles: ["scout"], task: "stale", stoppedAt: "2026-11-03T11:00:00Z" },
			{ job: "rm -rf /", roles: ["x"], task: "foreign id", stoppedAt: "2026-11-05T11:00:00Z" },
		]);
		assert.deepEqual(takeStoppedJobs(file, now).map((j) => j.task), ["fresh"]);
		fs.writeFileSync(file, "{not json");
		assert.deepEqual(takeStoppedJobs(file, now), []);
		assert.equal(fs.existsSync(file), false);
	} finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
