// Fix round 1: task-owned scratch/evidence outside the scored workspace, and partial (interrupted) round evidence. Synthetic adapters only.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { runBenchmark, taskPrompt, reworkPrompt } from "./lib/runner.mjs";
import { createWorkspace, artifactPaths } from "./lib/workspace.mjs";
import { assistant, writerLaunch, subagent, u, task, manifest, root, fakeWorkspace, gate, fakeAdapter, fixMain, fixtureConfig } from "./fixtures/fake-runtime.mjs";

const withArtifacts = (base) => {
	const ws = fakeWorkspace(base); const rw = createWorkspace({ repo: ".", scratchRoot: base });
	return { ...ws, artifactPolicy: rw.artifactPolicy, artifactsFor: (m, t) => artifactPaths({ scratchRoot: base, mode: m, task: t, workspaceDir: ws.dirFor(m, t) }), prepareArtifacts: rw.prepareArtifacts };
};
const cfg = (timeout = 400, grace = 100) => fixtureConfig({ limits: { roundSettleTimeoutMs: { value: 600000, source: "t" }, shutdownGraceMs: { value: grace, source: "t" }, taskTimeoutMs: { value: timeout, source: "t" } } });
const go = (tasks, adapter, workspace, config) => runBenchmark({ manifest: manifest(tasks), mode: "fresh", adapter, workspace, acceptance: gate, config: config ?? fixtureConfig() });
const pathsIn = (text) => ({ scratch: /scratch (\S+?);/.exec(text)[1], evidence: /evidence (\S+?)\. /.exec(text)[1] });
const hang = () => new Promise(() => {});

test("artifactPaths: exact absolute per-task paths, outside the workspace, never overlapping", () => {
	const base = root(); const ws = fakeWorkspace(base);
	const a = artifactPaths({ scratchRoot: base, mode: "fresh", task: { id: "H1" }, workspaceDir: ws.dirFor("fresh", { id: "H1" }) });
	const b = artifactPaths({ scratchRoot: base, mode: "fresh", task: { id: "H2" }, workspaceDir: ws.dirFor("fresh", { id: "H2" }) });
	for (const p of [a.scratch, a.evidence, b.scratch, b.evidence]) assert.ok(path.isAbsolute(p) && !p.includes("\\"));
	const wsDir = path.resolve(ws.dirFor("fresh", { id: "H1" }));
	for (const p of [a.scratch, a.evidence]) assert.ok(path.relative(wsDir, p).startsWith(".."), "outside the workspace");
	assert.equal(new Set([a.scratch, a.evidence, b.scratch, b.evidence]).size, 4);
	assert.throws(() => artifactPaths({ scratchRoot: base, mode: "fresh", task: { id: "../x" } }), /cannot name/);
	// shared sessions: still outside the shared workspace
	const s = artifactPaths({ scratchRoot: base, mode: "long-fixed", task: { id: "H1" }, workspaceDir: ws.dirFor("long-fixed", { id: "H1" }) });
	assert.ok(path.relative(path.resolve(ws.dirFor("long-fixed", { id: "H1" })), s.scratch).startsWith(".."));
});

test("prompts carry both exact paths and replace the blanket workspace-only wording", () => {
	const t = task("H1"); const a = { scratch: "C:/x/_artifacts/fresh/H1/scratch", evidence: "C:/x/_artifacts/fresh/H1/evidence" };
	const p = taskPrompt(t, a);
	assert.ok(p.includes(a.scratch) && p.includes(a.evidence));
	assert.doesNotMatch(p, /Work only inside this workspace/);
	assert.match(p, /Implementation and tests only in this workspace/);
	assert.ok(reworkPrompt(t, 1, { accepted: true }, { status: "ok", findings: [] }, [], a).includes(a.evidence));
	assert.match(taskPrompt(t), /Work only inside this workspace/); // no artifacts supplied: unchanged
});

test("a writer that keeps its scratch in the assigned external dir is accepted in round 0; the dirs are pre-created and outside the workspace", async () => {
	const base = root(); const seen = [];
	const ad = fakeAdapter({ mainScript: (s, text) => { const a = pathsIn(text); seen.push(a); assert.ok(fs.existsSync(a.scratch) && fs.existsSync(a.evidence)); fs.writeFileSync(path.join(a.scratch, "notes.txt"), "x"); fs.writeFileSync(path.join(a.evidence, "log.txt"), "y"); return fixMain(s); } });
	const r = await go([task("H1"), task("H2")], ad, withArtifacts(base));
	assert.equal(r.tasks.every((t) => t.accepted && t.reworkRounds === 0 && t.changedFiles.unrelated.length === 0), true);
	assert.deepEqual(r.tasks[0].artifacts, seen[0]);
	assert.notEqual(seen[0].scratch, seen[1].scratch);
	assert.ok(fs.existsSync(path.join(seen[0].scratch, "notes.txt")), "outside artifacts are preserved, not cleaned");
	assert.deepEqual(r.config.measurementPolicy.artifacts.id, "task-owned-artifacts-v1");
});

test("the same scratch file INSIDE the workspace is still unrelated, even when the scratch is named", async () => {
	const base = root();
	const ad = fakeAdapter({ mainScript: (s, text) => { const a = pathsIn(text); fs.writeFileSync(path.join(a.scratch, "ok.txt"), "x"); fs.mkdirSync(path.join(s.cwd, ".h1-scratch")); fs.writeFileSync(path.join(s.cwd, ".h1-scratch/notes.txt"), "x"); return fixMain(s); } });
	const r = await go([task("H1")], ad, withArtifacts(base), fixtureConfig({ maxReworkRounds: { value: 0, source: "t" } }));
	assert.deepEqual(r.tasks[0].changedFiles.unrelated, [".h1-scratch/notes.txt"]);
	assert.equal(r.tasks[0].accepted, false);
});

const obs = (events, requestedUnacked = 0) => (s) => ({ events: events.map((e) => ({ ...e })), requestedUnacked });
const receipt = { type: "subagent", details: { background: true, jobId: "bg-1", mode: "single" }, roles: ["general-worker"], session: null, atMs: 5 };

test("a cut main round keeps a PARTIAL round with known launches/receipts and unknown coverage; the writer count is not claimed", async () => {
	const ad = fakeAdapter({ mainScript: hang }); ad.observed = obs([assistant(u(1, 1)), receipt, writerLaunch(), { type: "tool", name: "subagent_control", isError: true, errorText: "SECRET path" }], 1);
	const r = await go([task("H1")], ad, fakeWorkspace(root()), cfg());
	const t = r.tasks[0]; const round = t.mainDiagnostics.rounds[0];
	assert.equal(t.status, "budget_exhausted");
	assert.equal(round.partial, true);
	assert.deepEqual([round.interrupted.cause, round.interrupted.stage], ["budget_exhausted", "main_prompt"]);
	assert.deepEqual([round.known.launches, round.known.receipts, round.known.expectedWriterLaunches, round.known.assistantTurns], [1, 1, 1, 1]);
	assert.equal(round.coverage.complete, false);
	assert.equal(round.coverage.requestedUnacked, 1);
	assert.deepEqual(round.coverage.pendingJobs, ["bg-1"]);
	assert.equal(t.delegation.writerLaunches, 0, "the strict expected-writer count is untouched by partial evidence");
	assert.ok(t.delegation.receipts[0].partial && t.delegation.launches[0].partial);
	assert.equal(t.delegation.receipts[0].completed, false);
	assert.doesNotMatch(JSON.stringify(t), /SECRET/);
	assert.equal(t.main.turns, 0, "no usage inferred from the unreturned prompt");
});

test("without adapter observability the cut round is UNKNOWN, never zero launches or a clean abort", async () => {
	const r = await go([task("H1")], fakeAdapter({ mainScript: hang }), fakeWorkspace(root()), cfg());
	const round = r.tasks[0].mainDiagnostics.rounds[0];
	assert.equal(round.partial, true);
	assert.equal(round.known, null);
	assert.deepEqual([round.coverage.events, round.coverage.adapterObservability, round.coverage.requestedUnacked, round.coverage.pendingJobs], ["unknown", "unavailable", null, null]);
	assert.deepEqual(r.tasks[0].delegation.launches, []);
});

test("a rework round cut mid-prompt keeps the prior completed round and the current partial one", async () => {
	let n = 0;
	const ad = fakeAdapter({ mainScript: (s) => (++n === 1 ? { events: [writerLaunch(), assistant(u(1, 1))], text: "no fix" } : hang()) });
	ad.observed = obs([writerLaunch()]);
	const r = await go([task("H1")], ad, fakeWorkspace(root()), cfg(1500, 200));
	const rounds = r.tasks[0].mainDiagnostics.rounds;
	assert.equal(rounds.length, 2);
	assert.equal(rounds[0].partial, undefined);
	assert.equal(rounds[0].writerLaunches, 1);
	assert.equal(rounds[1].partial, true);
	assert.equal(rounds[1].round, 1);
	assert.equal(r.tasks[0].delegation.writerLaunches, 1);
	assert.equal(r.tasks[0].delegation.launches.filter((l) => l.partial).length, 1);
});

test("a prompt error keeps the partial round with its source and no error text", async () => {
	const ad = fakeAdapter({ mainScript: () => { throw Object.assign(new Error("provider said TOKEN=sk-abcdefgh12345"), { kind: "provider_failure" }); } });
	ad.observed = obs([assistant(u(1, 1))]);
	const r = await go([task("H1")], ad, fakeWorkspace(root()));
	const round = r.tasks[0].mainDiagnostics.rounds[0];
	assert.equal(r.tasks[0].status, "error");
	assert.deepEqual([round.partial, round.interrupted.cause, round.interrupted.source], [true, "error", "provider_failure"]);
	assert.doesNotMatch(JSON.stringify(round), /sk-abcdefgh/);
});

test("a normal full round is unchanged: no partial marker, one record", async () => {
	const r = await go([task("H1")], fakeAdapter({ mainScript: fixMain }), fakeWorkspace(root()));
	const rounds = r.tasks[0].mainDiagnostics.rounds;
	assert.equal(rounds.length, 1);
	assert.deepEqual(Object.keys(rounds[0]).sort(), ["assistantTurns", "round", "toolCalls", "tools", "writerLaunches"]);
	assert.equal(r.tasks[0].delegation.partialCoverage, undefined);
});
