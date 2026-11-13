import assert from "node:assert/strict";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { auditToolSchemas, resolveToolDeclarations } from "../scripts/audit-tool-schemas.mjs";

const read = { name: "read", description: "Read a file", parameters: { type: "object" } };
const edit = { name: "edit", description: "Edit a file", parameters: { type: "object" } };
test("counts actual serialized definitions across requests, separately from message contents", () => {
	const requests = [{ tools: [read, edit], messages: ["private fixture text"] }, { tools: [read, edit], messages: ["changed"] }];
	const result = auditToolSchemas(requests);
	assert.equal(result.totalChars, 2 * JSON.stringify([read, edit]).length);
	assert.equal(result.stable, true);
	assert.equal(result.schemaVariants, 1);
	assert.deepEqual(result.tools.map((r) => [r.name, r.requests, r.totalChars]), [["edit", 2, 2 * JSON.stringify(edit).length], ["read", 2, 2 * JSON.stringify(read).length]]);
	assert.ok(!JSON.stringify(result).includes("private fixture text"));
	assert.ok(!JSON.stringify(result).includes("Read a file"));
});
test("detects schema edits and order changes even when tool names do not change", () => {
	for (const tools of [[edit, read], [read, { ...edit, description: "Changed contract" }]]) {
		const result = auditToolSchemas([{ tools: [read, edit] }, { tools }]);
		assert.equal(result.stable, false);
		assert.equal(result.schemaVariants, 2);
	}
});
test("records tool-set changes and intentionally empty lists", () => {
	const result = auditToolSchemas([{ tools: [read] }, { tools: [] }]);
	assert.equal(result.tools[0].requests, 1);
	assert.equal(result.minChars, 2);
	assert.equal(result.stable, false);
	assert.equal(auditToolSchemas([{ tools: [] }]).totalChars, 2);
});
test("rejects incomplete traces instead of reporting zero overhead", () => {
	for (const requests of [[], [{}], [{ tools: null }], [{ tools: [{ parameters: {} }] }], [{ tools: [read, read] }]]) {
		assert.throws(() => auditToolSchemas(requests));
	}
});

test("resolves transcript declarations through the host without changing recorded requests", () => {
	const messages = [{ role: "system", toolsAdded: [read] }, { role: "system", toolsAdded: [edit], toolsRemoved: [{ name: "read" }] }];
	const requests = [{ messages }];
	const before = JSON.stringify(requests);
	const resolved = resolveToolDeclarations(requests, (input) => {
		assert.equal(input, messages);
		return [edit]; // The host owns declaration replay; the audit consumes its result.
	});
	assert.deepEqual(auditToolSchemas(resolved).tools.map((row) => row.name), ["edit"]);
	assert.equal(JSON.stringify(requests), before);
	assert.throws(() => resolveToolDeclarations([{ messages: [] }], () => []));
	assert.throws(() => resolveToolDeclarations(requests, undefined));
	assert.deepEqual(resolveToolDeclarations([{ tools: [] }], undefined), [{ tools: [] }]);
});

test("CLI reports counts and rejects malformed JSON without echoing its contents", () => {
	const dir = mkdtempSync(join(tmpdir(), "schema-audit-test-"));
	try {
		const file = join(dir, "requests.jsonl");
		const script = fileURLToPath(new URL("../scripts/audit-tool-schemas.mjs", import.meta.url));
		writeFileSync(file, JSON.stringify({ tools: [read], messages: ["private fixture text"] }) + "\n");
		const good = spawnSync(process.execPath, [script, file], { encoding: "utf8" });
		assert.equal(good.status, 0, good.stderr);
		assert.equal(JSON.parse(good.stdout).tools[0].name, "read");
		assert.ok(!good.stdout.includes("private fixture text"));
		writeFileSync(file, '{"private fixture text":');
		const bad = spawnSync(process.execPath, [script, file], { encoding: "utf8" });
		assert.equal(bad.status, 1);
		assert.match(bad.stderr, /invalid request JSONL/);
		assert.ok(!bad.stderr.includes("private fixture text"));
	} finally { rmSync(dir, { recursive: true, force: true }); }
});
