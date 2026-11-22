// Field report: `subagent_control steer bg-1@<epoch>` on a running single-worker job answered "Worker is not ready or has finished",
// while list showed the worker running and steering by worker ID worked. Job targets were looked up without stripping the @epoch
// suffix that notices and list print, so the job was never found. steer, pause and cancel now resolve bg-N@epoch like result does.
import assert from "node:assert/strict";
import test from "node:test";
import { BackgroundWorkers } from "../background.ts";

const EPOCH = "783eb58442e1";
function runningJob() {
	const records = new Map<string, Record<string, unknown>>([["1:4", { id: "1:4", name: "backend-worker", state: "running", events: [] }]]);
	const pi = { on() {}, sendMessage() {} };
	const rt = new BackgroundWorkers(pi as never, { store: { records, changed() {} } } as never, undefined, EPOCH);
	const job = rt.start((signal) => new Promise((resolve) => signal.addEventListener("abort", () => resolve({ content: [{ type: "text", text: "stopped" }] }))));
	const sent: string[] = [];
	const paused: boolean[] = [];
	const client = { send: async (_method: string, message: string) => { sent.push(message); return { disposition: "queued" }; }, setPaused: (value: boolean) => paused.push(value) };
	rt.note(job.id, "1:4");
	rt.attach(job.id, "1:4", client as never, new AbortController());
	return { rt, job, sent, paused };
}

test("steer resolves a running single-worker job by bg-N@epoch, bg-N and worker ID", async () => {
	const { rt, job, sent } = runningJob();
	try {
		for (const target of [`${job.id}@${EPOCH}`, job.id, "1:4", "#4"]) {
			assert.match(await rt.steer(target, `focus on the API (${target})`), /^Worker 1:4: queued\. Instruction will apply between tool turns\.$/, target);
		}
		assert.deepEqual(sent, [`focus on the API (${job.id}@${EPOCH})`, `focus on the API (${job.id})`, "focus on the API (1:4)", "focus on the API (#4)"]);
	} finally { rt.cancel(job.id); }
});

test("pause and cancel accept the same bg-N@epoch target", () => {
	const { rt, job, paused } = runningJob();
	assert.match(rt.pause(`${job.id}@${EPOCH}`), /^Pause requested for /);
	assert.match(rt.pause(`${job.id}@${EPOCH}`, false), /^Resumed /);
	assert.deepEqual(paused, [true, false]);
	assert.equal(rt.cancel(`${job.id}@${EPOCH}`), `Stopping job ${job.id}@${EPOCH}`);
});

test("unresolvable targets say what is wrong, never that a running worker has finished", async () => {
	const { rt, job } = runningJob();
	try {
		await assert.rejects(rt.steer(`${job.id}@0123456789ab`, "x"), /names another Pi runtime \(epoch mismatch\); use subagent_control list/);
		await assert.rejects(rt.steer("bg-9", "x"), /^Error: No running job bg-9 in this runtime; use subagent_control list/);
		await assert.rejects(rt.steer(`bg-9@${EPOCH}`, "x"), /^Error: No running job bg-9@783eb58442e1 in this runtime/);
		await assert.rejects(rt.steer("7:1", "x"), /^Error: No active worker matches 7:1; use subagent_control list/);
		for (const target of [`${job.id}@${EPOCH}`, job.id]) assert.doesNotMatch(await rt.steer(target, "x"), /not ready|has finished/);
	} finally { rt.cancel(job.id); }
});
