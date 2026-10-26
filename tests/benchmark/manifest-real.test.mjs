// The committed checkpoint manifest stays valid: schema, harness-only scope, 8-10 tasks, >=3 T3, >=1 debugging, fixed order.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { validateManifest, checkCheckpointContract, manifestDigest } from "./lib/manifest.mjs";
import { taskPrompt, reviewPrompt } from "./lib/runner.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const manifest = JSON.parse(fs.readFileSync(path.join(here, "manifest.json"), "utf8"));

test("the committed manifest validates and meets the checkpoint contract", () => {
	validateManifest(manifest);
	assert.deepEqual(checkCheckpointContract(manifest), []);
	assert.deepEqual(manifest.tasks.map((t) => t.id), ["H4", "H5", "H6", "H8", "H9", "H10", "H11", "H12"]);
});

test("every task has a commit identity, a held-out acceptance test and an explicit exclusion record for skipped candidates", () => {
	for (const t of manifest.tasks) {
		assert.match(t.commit, /^[0-9a-f]{7,40}$/);
		assert.ok(t.acceptanceTests.length >= 1, t.id);
		assert.ok(t.riskRationale.length > 20, t.id);
	}
	assert.ok(manifest.excludedCandidates.every((e) => typeof e.reason === "string" && e.reason.length > 20));
	assert.match(manifestDigest(manifest), /^[0-9a-f]{64}$/);
});

// R8: every task carries an explicit brief that states the observable contract of the commit; the briefs are labelled as reconstructed, never as the original request.
test("every task has an explicit behavior brief, labelled as a reconstructed contract and never presented as the original request", () => {
	assert.match(manifest.briefProvenance, /^reconstructedContract:/);
	assert.match(manifest.briefProvenance, /NOT the original user request/);
	for (const t of manifest.tasks) {
		assert.ok(typeof t.brief === "string" && t.brief.length > 400, `${t.id} brief is a real contract, not a subject restatement`);
		assert.notEqual(t.brief.trim(), t.subject.trim(), t.id);
		assert.ok(!t.brief.includes(t.commit) && !t.brief.includes(t.parent), `${t.id} carries no commit identity`);
	}
});

test("H10 and H12 describe implementing and testing harness behavior; neither asks to save real knowledge, release or publish anything", () => {
	const by = Object.fromEntries(manifest.tasks.map((t) => [t.id, t]));
	assert.match(by.H10.brief, /saves no real knowledge/);
	assert.match(by.H12.brief, /performs no real merge, release, push or publication/);
	for (const id of ["H10", "H12"]) assert.doesNotMatch(taskPrompt(by[id]), /Release v\d|publish (the|a) /i, `${id} prompt`);
	assert.doesNotMatch(taskPrompt(by.H12), /Release v1\.9\.1/, "the release-titled subject is not the prompt goal");
});

// Oracle F4: the reviewer judges the same accepted brief and scope as the implementer, never the obsolete commit subject.
test("the review prompt carries the same brief goal and file scope as the task prompt; H10 and H12 are not judged as a real save or release", () => {
	const by = Object.fromEntries(manifest.tasks.map((t) => [t.id, t]));
	for (const id of ["H10", "H12"]) {
		const review = reviewPrompt(by[id], [], { accepted: false });
		assert.ok(review.includes(`Goal: ${by[id].brief}`), `${id} review goal is the exact brief`);
		assert.ok(!review.includes(`Goal: ${by[id].subject}`), `${id} review goal is not the subject`);
		assert.ok(review.includes(by[id].allowedFiles.join(", ")), `${id} review states the same allowed-file scope`);
	}
	assert.match(reviewPrompt(by.H12, [], { accepted: true }), /performs no real merge, release, push or publication/);
	assert.match(reviewPrompt(by.H10, [], { accepted: true }), /saves no real knowledge/);
	const t = manifest.tasks[0];
	assert.ok(reviewPrompt({ ...t, brief: undefined }, [], { accepted: true }).includes(`Goal: ${t.subject}`));
});

test("the task prompt uses the brief as its goal, and the subject only when a task has no brief", () => {
	const t = manifest.tasks[0];
	assert.ok(taskPrompt(t).includes(`Goal: ${t.brief}`));
	assert.ok(taskPrompt({ ...t, brief: undefined }).includes(`Goal: ${t.subject}`));
});
