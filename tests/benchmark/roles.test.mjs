// Registry resolution for the benchmark: reviewer tier from the effective roles.json (package + user overlay), and the
// rework cap default from the general-worker role. Fail closed on unsupported shapes; no literal fallback values.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { loadEffectiveRoles, resolveReviewerSpec, resolveReworkCap, writerReworkDefault, resolveBenchmarkRoles } from "./lib/roles.mjs";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const tmp = (name) => fs.mkdtempSync(path.join(os.tmpdir(), `bench-roles-${name}-`));

// A candidate root with its own package roles.json (only what the test needs) and an agent dir with an optional user overlay.
function fixtureRoots({ packageRoles, userRoles } = {}) {
	const candidateRoot = tmp("cand");
	fs.mkdirSync(path.join(candidateRoot, "agent"), { recursive: true });
	fs.writeFileSync(path.join(candidateRoot, "agent", "roles.json"), JSON.stringify(packageRoles, null, 2) + "\n");
	const agentDir = tmp("agentdir");
	if (userRoles !== undefined) fs.writeFileSync(path.join(agentDir, "roles.json"), JSON.stringify(userRoles, null, 2) + "\n");
	return { candidateRoot, agentDir };
}

const reviewerEntry = (tiers = {}, extra = {}) => ({
	name: "reviewer", defaultModelTier: "economy",
	modelTiers: {
		economy: { model: "openai-codex/gpt-6-luna", fallbackModel: "anthropic/claude-haiku-5-5", thinking: "high" },
		capable: { model: "openai-codex/gpt-6.1-sol", fallbackModel: "anthropic/claude-sonnet-5-5", thinking: "high" },
		...tiers,
	},
	tools: "read, grep, find, ls, bash, powershell",
	...extra,
});
const workerEntry = (extra = {}) => ({
	name: "general-worker", defaultModelTier: "economy",
	modelTiers: { economy: { model: "anthropic/claude-haiku-5-5", fallbackModel: "openai-codex/gpt-6-luna", thinking: "medium" } },
	tools: "read, grep, find, ls, bash, powershell, edit",
	...extra,
});

test("the reviewer spec is the candidate roles.json reviewer default tier: model, fallback chain and thinking, unchanged", () => {
	const effective = loadEffectiveRoles({ candidateRoot: REPO, agentDir: tmp("none") });
	const spec = resolveReviewerSpec(effective);
	assert.equal(spec.role, "reviewer");
	assert.equal(spec.tier, "economy");
	assert.equal(spec.model, "openai-codex/gpt-6-luna");
	assert.deepEqual(spec.fallbacks, ["anthropic/claude-haiku-5-5"]);
	assert.equal(spec.thinking, "high");
	assert.deepEqual(spec.tools, ["read", "grep", "find", "ls", "bash", "powershell"], "declared registry tools; the adapter restricts them to read-only");
	assert.match(spec.source, /package roles\.json role reviewer tier economy/);
	assert.equal(effective.files.user, null, "absent user roles.json is recorded as absent, not guessed");
});

test("a user roles.json overlay replaces the reviewer default tier and is recorded as the source", () => {
	const { candidateRoot, agentDir } = fixtureRoots({ packageRoles: [reviewerEntry(), workerEntry()], userRoles: [{ name: "reviewer", defaultModelTier: "capable" }] });
	const spec = resolveReviewerSpec(loadEffectiveRoles({ candidateRoot, agentDir }));
	assert.equal(spec.tier, "capable");
	assert.equal(spec.model, "openai-codex/gpt-6.1-sol");
	assert.deepEqual(spec.fallbacks, ["anthropic/claude-sonnet-5-5"]);
	assert.match(spec.source, /user roles\.json role reviewer tier capable/);
});

test("an unknown default tier, a missing reviewer role and a legacy provider/model shape are refused (fail closed)", () => {
	const bad = fixtureRoots({ packageRoles: [reviewerEntry({}, { defaultModelTier: "turbo" }), workerEntry()] });
	assert.throws(() => resolveReviewerSpec(loadEffectiveRoles(bad)), /defaultModelTier/);
	const missing = fixtureRoots({ packageRoles: [workerEntry()] });
	assert.throws(() => resolveReviewerSpec(loadEffectiveRoles(missing)), /reviewer/);
	const legacy = fixtureRoots({ packageRoles: [{ name: "reviewer", provider: "openai-codex", model: "gpt-6-luna", fallbackModel: "", thinking: "high", tools: "read" }, workerEntry()] });
	assert.throws(() => resolveReviewerSpec(loadEffectiveRoles(legacy)), /legacy|unsupported/i);
});

test("the rework cap default comes from the general-worker roles.json entry, not a literal", () => {
	const real = writerReworkDefault(loadEffectiveRoles({ candidateRoot: REPO, agentDir: tmp("none") }));
	assert.deepEqual(real, { value: 2, source: "package roles.json role general-worker" }, "the user policy value 2 is stored in the registry");
	const changed = fixtureRoots({ packageRoles: [reviewerEntry(), workerEntry({ maxReworkRounds: 3 })] });
	assert.deepEqual(writerReworkDefault(loadEffectiveRoles(changed)), { value: 3, source: "package roles.json role general-worker" });
	const overlaid = fixtureRoots({ packageRoles: [reviewerEntry(), workerEntry({ maxReworkRounds: 3 })], userRoles: [{ name: "general-worker", maxReworkRounds: 4 }] });
	assert.deepEqual(writerReworkDefault(loadEffectiveRoles(overlaid)), { value: 4, source: "user roles.json role general-worker" });
});

test("an invalid or missing rework cap in roles.json is refused, never replaced by a default", () => {
	for (const v of [-1, 1.5, "2", null]) {
		const f = fixtureRoots({ packageRoles: [reviewerEntry(), workerEntry({ maxReworkRounds: v })] });
		assert.throws(() => writerReworkDefault(loadEffectiveRoles(f)), /maxReworkRounds/, `value ${JSON.stringify(v)}`);
	}
	const none = fixtureRoots({ packageRoles: [reviewerEntry(), workerEntry()] });
	assert.throws(() => writerReworkDefault(loadEffectiveRoles(none)), /maxReworkRounds/);
});

test("rework cap precedence is manifest task > run flag > roles.json default, and the winning source is returned", () => {
	const roleDefault = { value: 2, source: "package roles.json role general-worker" };
	const runFlag = { value: 1, source: "run flag --max-rework-rounds" };
	assert.deepEqual(resolveReworkCap({ taskOverride: { value: 0, source: "manifest task H1" }, runFlag, roleDefault }), { value: 0, source: "manifest task H1" });
	assert.deepEqual(resolveReworkCap({ runFlag, roleDefault }), runFlag);
	assert.deepEqual(resolveReworkCap({ roleDefault }), roleDefault);
	assert.throws(() => resolveReworkCap({ taskOverride: { value: -1, source: "manifest task H1" }, roleDefault }), /maxReworkRounds/);
	assert.throws(() => resolveReworkCap({ roleDefault: { value: 2, source: "" } }), /source/);
	assert.throws(() => resolveReworkCap({}), /roleDefault/);
});

test("resolveBenchmarkRoles records the main spec, reviewer spec, writer cap and the registry file digests", () => {
	const { candidateRoot, agentDir } = fixtureRoots({ packageRoles: [reviewerEntry(), workerEntry({ maxReworkRounds: 2 })] });
	const main = { model: "anthropic/claude-sonnet-5-5", fallbacks: [], thinking: "high", source: "profile default" };
	const r = resolveBenchmarkRoles({ candidateRoot, agentDir, main });
	assert.equal(r.main.model, "anthropic/claude-sonnet-5-5");
	assert.equal(r.reviewer.model, "openai-codex/gpt-6-luna");
	assert.deepEqual(r.writer, { role: "general-worker", value: 2, source: "package roles.json role general-worker" });
	assert.match(r.files.package.sha256, /^[0-9a-f]{64}$/);
	assert.equal(r.files.user, null);
});
