// OFFLINE SYNTHETIC integration: real git fixture repo, real replay extraction, real node --test acceptance, scripted adapter.
// Labelled SYNTHETIC: measures nothing about Pi, providers or the harness; it is NOT the performance baseline.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { runBenchmark } from "./lib/runner.mjs";
import { createWorkspace } from "./lib/workspace.mjs";
import { runAcceptance } from "./lib/acceptance.mjs";
import { createSyntheticAdapter } from "./lib/synthetic-adapter.mjs";
import { fixtureConfig } from "./fixtures/fake-runtime.mjs";

const git = (cwd, ...a) => execFileSync("git", ["-c", "commit.gpgsign=false", "-c", "user.name=bench", "-c", "user.email=bench@example.invalid", ...a], { cwd, encoding: "utf8" }).trim();
const write = (root, rel, text) => { fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true }); fs.writeFileSync(path.join(root, rel), text); };

// Two fixture tasks: S1 (parent broken -> fixed commit) and S2 (parent broken again -> fixed commit), plus an outside-harness file.
function historyRepo() {
	const repo = fs.mkdtempSync(path.join(os.tmpdir(), "bench-hist-"));
	git(repo, "init", "-q");
	write(repo, "agent/work.txt", "broken\n");
	write(repo, "scripts/ok.txt", "x\n");
	git(repo, "add", "-A"); git(repo, "commit", "-qm", "parent-1");
	const p1 = git(repo, "rev-parse", "HEAD");
	write(repo, "agent/work.txt", "fixed\n");
	write(repo, "tests/gate.test.mjs", "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport fs from 'node:fs';\ntest('gate', () => assert.equal(fs.readFileSync(new URL('../agent/work.txt', import.meta.url), 'utf8').trim(), 'fixed'));\n");
	git(repo, "add", "-A"); git(repo, "commit", "-qm", "fix work");
	const c1 = git(repo, "rev-parse", "HEAD");
	write(repo, "agent/work.txt", "broken again\n");
	write(repo, "unrelated/outside.txt", "not harness\n");
	git(repo, "add", "-A"); git(repo, "commit", "-qm", "parent-2");
	const p2 = git(repo, "rev-parse", "HEAD");
	write(repo, "agent/work.txt", "fixed\n");
	git(repo, "add", "-A"); git(repo, "commit", "-qm", "fix again");
	const c2 = git(repo, "rev-parse", "HEAD");
	return { repo, tasks: [
		{ id: "S1", commit: c1, parent: p1, subject: "fix work", tier: "T1", category: "debugging", riskRationale: "synthetic", allowedFiles: ["agent/work.txt"], acceptanceTests: ["tests/gate.test.mjs"] },
		{ id: "S2", commit: c2, parent: p2, subject: "fix again", tier: "T3", category: "feature", riskRationale: "synthetic", allowedFiles: ["agent/work.txt"], acceptanceTests: ["tests/gate.test.mjs"], maxReworkRounds: 1 },
	] };
}

test("synthetic offline run: git replay, held-out gate via node --test, per-task rework cap, SYNTHETIC label", async () => {
	const { repo, tasks } = historyRepo();
	const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "bench-int-"));
	const workspace = createWorkspace({ repo, scratchRoot: scratch });
	// Synthetic behaviour: S1 is fixed by the main pass; S2 is never fixed, so the per-task cap (1 round) must stop it.
	const adapter = createSyntheticAdapter({ script: (session) => {
		if (session.taskId === "S1") fs.writeFileSync(path.join(session.cwd, "agent/work.txt"), "fixed\n");
		return { events: [{ type: "assistant", message: { role: "assistant", usage: { input: 100, output: 10, cacheRead: 200, cacheWrite: 0, totalTokens: 310, cost: { input: 0.001, output: 0.001, cacheRead: 0.0001, cacheWrite: 0, total: 0.0021 } } } }], text: "done" };
	} });
	const result = await runBenchmark({ manifest: { schemaVersion: "harness-benchmark-manifest/1", name: "synthetic", tasks }, mode: "fresh", adapter, workspace, acceptance: ({ cwd, files }) => runAcceptance({ cwd, files }), config: fixtureConfig({ maxReworkRounds: { value: 2, source: "integration fixture" } }) });
	assert.equal(result.synthetic, true);
	assert.equal(result.status, "complete");
	const [s1, s2] = result.tasks;
	assert.equal(s1.accepted, true, JSON.stringify(s1.acceptance.cycles));
	assert.equal(s1.acceptance.cycles[0].testsPassed, true, "fixed in the first pass");
	assert.equal(s2.accepted, false);
	assert.equal(s2.reworkRounds, 1, "per-task cap of 1 applied");
	assert.deepEqual(s2.changedFiles.unrelated, []);
	assert.ok(s1.main.cost.total > 0);
});
