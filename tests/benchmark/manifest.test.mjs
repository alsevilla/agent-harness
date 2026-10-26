// Benchmark manifest contract: schema, harness-only path guard, checkpoint contract (8-10 tasks, >=3 T3, >=1 debugging).
import assert from "node:assert/strict";
import test from "node:test";
import { SCHEMA_VERSION, HARNESS_ROOTS, assertHarnessPath, manifestErrors, validateManifest, checkCheckpointContract } from "./lib/manifest.mjs";

const SHA = "a34e74f1234567890abcdef1234567890abcdef0";
const PARENT = "6f4043d1234567890abcdef1234567890abcdef0";
const task = (over = {}) => ({
	id: "H1", commit: SHA, parent: PARENT, subject: "fix: example", tier: "T1", category: "debugging",
	riskRationale: "localized monitor behaviour with one regression test",
	allowedFiles: ["agent/extensions/subagent/monitor.ts"],
	acceptanceTests: ["agent/extensions/subagent/tests/monitor-scrollbar.test.ts"],
	...over,
});
const manifest = (tasks) => ({ schemaVersion: SCHEMA_VERSION, name: "t", expectedWriter: "general-worker", tasks });
const eight = (n = 8) => Array.from({ length: n }, (_, i) => task({ id: `H${i + 1}`, commit: `${"a".repeat(6)}${i}${"0".repeat(33)}`, parent: `${"b".repeat(6)}${i}${"0".repeat(33)}`, tier: i < 3 ? "T3" : "T1", category: i === 0 ? "debugging" : "feature" }));

test("a well-formed harness task is accepted and keeps its array order as the fixed order", () => {
	const m = validateManifest(manifest([task(), task({ id: "H2", commit: "b7aa6ad1234", parent: "a850ea71234" })]));
	assert.deepEqual(m.tasks.map((t) => t.id), ["H1", "H2"]);
});

// C6: the expected writer role is manifest metadata (a role name); a per-task diagnostic cap override must be a whole number >= 0.
test("expectedWriter is required manifest metadata; a per-task diagnosticChars override must be a whole number >= 0", () => {
	assert.ok(manifestErrors({ ...manifest([task()]), expectedWriter: undefined }).some((e) => /expectedWriter/.test(e)));
	assert.ok(manifestErrors({ ...manifest([task()]), expectedWriter: "Not A Role" }).some((e) => /expectedWriter/.test(e)));
	assert.deepEqual(manifestErrors(manifest([task({ diagnosticChars: 0 })])), []);
	assert.ok(manifestErrors(manifest([task({ diagnosticChars: -1 })])).some((e) => /diagnosticChars/.test(e)));
});

test("unknown schema version, malformed lineage and duplicate ids are refused with every problem listed", () => {
	const errors = manifestErrors({ schemaVersion: "v0", tasks: [task({ commit: "XYZ" }), task({ id: "H2", parent: undefined })] });
	assert.ok(errors.some((e) => /schemaVersion/.test(e)), errors.join("\n"));
	assert.ok(errors.some((e) => /tasks\[0\]\.commit/.test(e)), errors.join("\n"));
	assert.ok(errors.some((e) => /tasks\[1\]\.parent/.test(e)), errors.join("\n"));
	assert.throws(() => validateManifest(manifest([task(), task()])), /duplicate task id H1/);
});

test("tier, category, risk rationale and acceptance tests are required and checked", () => {
	const errors = manifestErrors(manifest([task({ tier: "T9", riskRationale: "", acceptanceTests: [] })]));
	assert.ok(errors.some((e) => /tier/.test(e)));
	assert.ok(errors.some((e) => /riskRationale/.test(e)));
	assert.ok(errors.some((e) => /acceptanceTests/.test(e)));
});

test("only harness roots are accepted; traversal, absolute, backslash, mirror and RFID-named paths are refused", () => {
	assert.deepEqual(HARNESS_ROOTS, ["agent", "docs", "tests", "scripts", "package.json", "README.md"]);
	assert.equal(assertHarnessPath("docs/knowledge/README.md"), "docs/knowledge/README.md");
	assert.equal(assertHarnessPath("agent/extensions/subagent/monitor.ts"), "agent/extensions/subagent/monitor.ts");
	assert.equal(assertHarnessPath("package.json"), "package.json");
	for (const bad of ["../agent/x.ts", "/abs/agent/x.ts", "C:/x/agent/x.ts", "agent\\x.ts", "pi-package/extensions/x.ts", "src/app.ts", "agent/rfid/reader.ts", "tests/RFID-attendance.test.ts"]) {
		assert.throws(() => assertHarnessPath(bad), /harness|RFID|path/i, bad);
	}
	assert.ok(manifestErrors(manifest([task({ allowedFiles: ["pi-package/extensions/subagent/monitor.ts"] })])).some((e) => /allowedFiles/.test(e)));
});

test("checkpoint contract: 8-10 tasks, at least 3 T3 tasks and at least one debugging task", () => {
	assert.deepEqual(checkCheckpointContract(manifest(eight())), []);
	assert.ok(checkCheckpointContract(manifest(eight(7))).some((e) => /8-10/.test(e)));
	assert.ok(checkCheckpointContract(manifest(eight(11))).some((e) => /8-10/.test(e)));
	assert.ok(checkCheckpointContract(manifest(eight().map((t) => ({ ...t, tier: "T2" })))).some((e) => /T3/.test(e)));
	assert.ok(checkCheckpointContract(manifest(eight().map((t) => ({ ...t, category: "feature" })))).some((e) => /debugging/.test(e)));
});

test("roundSettleTimeoutMs must be whole milliseconds >= 1 and a brief must be a non-empty string", () => {
	const base = { schemaVersion: "harness-benchmark-manifest/1", name: "m", expectedWriter: "general-worker", tasks: [{ id: "H1", commit: "abcdef1", parent: "abcdef2", subject: "s", tier: "T1", category: "feature", riskRationale: "r", allowedFiles: ["agent/a.txt"], acceptanceTests: ["tests/a.test.mjs"] }] };
	assert.deepEqual(manifestErrors(base), []);
	for (const bad of [0, -1, 1.5, "5"]) assert.match(manifestErrors({ ...base, tasks: [{ ...base.tasks[0], roundSettleTimeoutMs: bad }] }).join(), /roundSettleTimeoutMs must be a whole number of milliseconds >= 1/, String(bad));
	assert.deepEqual(manifestErrors({ ...base, tasks: [{ ...base.tasks[0], roundSettleTimeoutMs: 1000, brief: "Do the thing." }] }), []);
	assert.match(manifestErrors({ ...base, tasks: [{ ...base.tasks[0], brief: "  " }] }).join(), /brief must be a non-empty string/);
});
