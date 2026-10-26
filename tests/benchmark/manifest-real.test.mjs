// The committed checkpoint manifest stays valid: schema, harness-only scope, 8-10 tasks, >=3 T3, >=1 debugging, fixed order.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { validateManifest, checkCheckpointContract, manifestDigest } from "./lib/manifest.mjs";

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
