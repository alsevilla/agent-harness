// Benchmark manifest: fixed ordered harness tasks with provenance, scope, held-out acceptance tests and risk rationale.
// Harness-only: every path must sit under HARNESS_ROOTS and must not name an RFID/external project.
import crypto from "node:crypto";

export const SCHEMA_VERSION = "harness-benchmark-manifest/1";
// docs/ is this repository's own harness documentation (knowledge index, Copilot acceptance note), not another project.
export const HARNESS_ROOTS = ["agent", "docs", "tests", "scripts", "package.json", "README.md"];
const TIERS = ["T1", "T2", "T3"];
const SHA = /^[0-9a-f]{7,40}$/;
const TASK_ID = /^[A-Za-z][A-Za-z0-9_-]{0,31}$/;
const ROLE_NAME = /^[a-z][a-z0-9-]*$/;

export function assertHarnessPath(p) {
	if (typeof p !== "string" || p === "") throw new Error("path must be a non-empty string");
	if (p.includes("\\") || p.startsWith("/") || /^[A-Za-z]:/.test(p) || p.split("/").includes("..")) throw new Error(`invalid harness path "${p}": relative POSIX paths only`);
	if (!HARNESS_ROOTS.some((root) => p === root || p.startsWith(`${root}/`))) throw new Error(`path "${p}" is outside the harness roots (${HARNESS_ROOTS.join(", ")})`);
	if (/rfid/i.test(p)) throw new Error(`path "${p}" names an RFID/external project: refused`);
	return p;
}

const nonEmpty = (v) => typeof v === "string" && v.trim() !== "";

// Returns every problem (not just the first) so one run can fix a whole manifest.
export function manifestErrors(manifest) {
	const errors = [];
	if (typeof manifest !== "object" || manifest === null) return ["manifest must be an object"];
	if (manifest.schemaVersion !== SCHEMA_VERSION) errors.push(`schemaVersion must be "${SCHEMA_VERSION}", got ${JSON.stringify(manifest.schemaVersion)}`);
	if (!nonEmpty(manifest.name)) errors.push("name is required");
	// The writer role every task is expected to delegate implementation to (benchmark method metadata; recorded per task).
	if (typeof manifest.expectedWriter !== "string" || !ROLE_NAME.test(manifest.expectedWriter)) errors.push(`expectedWriter must be a role name (lowercase letters, digits, hyphens), got ${JSON.stringify(manifest.expectedWriter ?? null)}`);
	if (!Array.isArray(manifest.tasks) || manifest.tasks.length === 0) return [...errors, "tasks must be a non-empty array"];
	const seen = new Set();
	manifest.tasks.forEach((t, i) => {
		const at = `tasks[${i}]`;
		if (typeof t !== "object" || t === null) return errors.push(`${at} must be an object`);
		if (!TASK_ID.test(t.id ?? "")) errors.push(`${at}.id must match ${TASK_ID}`);
		else if (seen.has(t.id)) errors.push(`duplicate task id ${t.id}`);
		seen.add(t.id);
		if (!SHA.test(t.commit ?? "")) errors.push(`${at}.commit must be a hex SHA (7-40 chars)`);
		if (!SHA.test(t.parent ?? "")) errors.push(`${at}.parent must be a hex SHA (7-40 chars)`);
		if (!nonEmpty(t.subject)) errors.push(`${at}.subject is required`);
		if (!TIERS.includes(t.tier)) errors.push(`${at}.tier must be one of ${TIERS.join(", ")}`);
		if (!nonEmpty(t.category)) errors.push(`${at}.category is required`);
		if (!nonEmpty(t.riskRationale)) errors.push(`${at}.riskRationale is required`);
		for (const key of ["allowedFiles", "acceptanceTests"]) {
			if (!Array.isArray(t[key]) || t[key].length === 0) { errors.push(`${at}.${key} must be a non-empty array`); continue; }
			for (const p of t[key]) { try { assertHarnessPath(p); } catch (e) { errors.push(`${at}.${key}: ${e.message}`); } }
		}
		if (t.maxReworkRounds !== undefined && !(Number.isInteger(t.maxReworkRounds) && t.maxReworkRounds >= 0)) errors.push(`${at}.maxReworkRounds must be a whole number >= 0`);
		if (t.diagnosticChars !== undefined && !(Number.isInteger(t.diagnosticChars) && t.diagnosticChars >= 0)) errors.push(`${at}.diagnosticChars must be a whole number >= 0`);
		if (t.acceptanceRunner !== undefined && t.acceptanceRunner !== "node" && t.acceptanceRunner !== "bun") errors.push(`${at}.acceptanceRunner must be node or bun`);
	});
	return errors;
}

export function validateManifest(manifest) {
	const errors = manifestErrors(manifest);
	if (errors.length) throw new Error(`invalid benchmark manifest: ${errors.join("; ")}`);
	return manifest;
}

// The checkpoint contract from the user: 8-10 real tasks, at least 3 T3, at least 1 debugging. Not a run cap.
export function checkCheckpointContract(manifest) {
	const tasks = manifest.tasks ?? [];
	const problems = [];
	if (tasks.length < 8 || tasks.length > 10) problems.push(`checkpoint contract requires 8-10 tasks, got ${tasks.length}`);
	const t3 = tasks.filter((t) => t.tier === "T3").length;
	if (t3 < 3) problems.push(`checkpoint contract requires at least 3 T3 tasks, got ${t3}`);
	if (!tasks.some((t) => t.category === "debugging")) problems.push("checkpoint contract requires at least 1 debugging task");
	return problems;
}

// SHA-256 of the canonical manifest JSON: results from different benchmarks never compare as equal.
export function manifestDigest(manifest) {
	return crypto.createHash("sha256").update(JSON.stringify(manifest)).digest("hex");
}
