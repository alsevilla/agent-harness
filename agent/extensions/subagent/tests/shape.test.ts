import assert from "node:assert/strict";
import test from "node:test";
import { expandShape, shapeStepStop } from "../shape.ts";

const roles = (shape: Parameters<typeof expandShape>[0]) => {
	const out = expandShape(shape);
	assert.ok(out.ok, out.ok ? "" : out.error);
	return out.chain;
};

test("T1 is one worker step with the packet as-is", () => {
	assert.deepEqual(roles({ name: "T1", worker: "backend-worker", packets: { worker: "add field" } }), [{ agent: "backend-worker", task: "add field" }]);
});

test("T2 runs debugger then worker; later steps get the previous report; test and review are optional", () => {
	const chain = roles({ name: "T2", worker: "frontend-worker", packets: { debugger: "find cause", worker: "fix it", test: "verify", review: "review" }, cwd: "/w" });
	assert.deepEqual(chain.map((s) => s.agent), ["debugger", "frontend-worker", "test-engineer", "reviewer"]);
	assert.equal(chain[0].task, "find cause");
	assert.ok(chain.slice(1).every((s) => s.task.endsWith("Previous step report:\n{previous}")));
	assert.ok(chain.every((s) => s.cwd === "/w"));
	assert.deepEqual(chain.map((s) => s.readOnly ?? false), [true, false, true, true]);
	assert.ok(chain.every((s) => s.modelTier === undefined), "T2 keeps role defaults");
});

test("T3 order: economy planner, specialist, worker, capable test-engineer and reviewer", () => {
	const chain = roles({ name: "T3", worker: "database-worker", specialist: "database-specialist", packets: { planner: "plan", specialist: "decide", worker: "build", test: "verify", review: "review" } });
	assert.deepEqual(chain.map((s) => [s.agent, s.modelTier]), [["planner", "economy"], ["database-specialist", undefined], ["database-worker", undefined], ["test-engineer", "capable"], ["reviewer", "capable"]]);
	assert.deepEqual(roles({ name: "T3", worker: "backend-worker", packets: { worker: "build", test: "verify" } }).map((s) => s.agent), ["backend-worker", "test-engineer"]);
});

test("a packet that already places {previous} is not given a second copy", () => {
	const chain = roles({ name: "T2", worker: "backend-worker", packets: { debugger: "d", worker: "cause: {previous}. fix it" } });
	assert.equal(chain[1].task, "cause: {previous}. fix it");
});

test("invalid shapes are refused, never trimmed", () => {
	const bad: [any, RegExp][] = [
		[{ name: "T4", worker: "backend-worker", packets: { worker: "x" } }, /T4 and unusual tasks/],
		[{ name: "T1", worker: "release-engineer", packets: { worker: "x" } }, /worker must be/],
		[{ name: "T1", worker: "backend-worker", packets: {} }, /needs a "worker"/],
		[{ name: "T1", worker: "backend-worker", packets: { worker: "x", test: "y" } }, /"test" is not part of T1/],
		[{ name: "T2", worker: "backend-worker", packets: { worker: "x" } }, /needs a "debugger"/],
		[{ name: "T2", worker: "backend-worker", packets: { debugger: "d", worker: "x", planner: "p" } }, /"planner" is not part of T2/],
		[{ name: "T3", worker: "backend-worker", packets: { worker: "x" } }, /needs a "test"/],
		[{ name: "T3", worker: "backend-worker", specialist: "security-specialist", packets: { worker: "x", test: "t" } }, /go together/],
		[{ name: "T3", worker: "backend-worker", specialist: "reviewer", packets: { worker: "x", test: "t", specialist: "s" } }, /\*-specialist/],
		[{ name: "T3", worker: "backend-worker", packets: { worker: " ", test: "t" } }, /non-empty/],
		[{ name: "T1", worker: "backend-worker", packets: { worker: "x", ship: "y" } }, /"ship" is not part of T1/],
	];
	for (const [shape, error] of bad) {
		const out = expandShape(shape);
		assert.equal(out.ok, false, JSON.stringify(shape));
		assert.match((out as { error: string }).error, error);
	}
});

test("a step continues only on STATUS PASS", () => {
	assert.equal(shapeStepStop("STATUS: PASS root cause found\nNEXT: fix"), undefined);
	assert.equal(shapeStepStop("notes\n  status: pass"), undefined);
	assert.equal(shapeStepStop("STATUS: BLOCKED missing access"), "STATUS BLOCKED missing access");
	assert.equal(shapeStepStop("STATUS: INCONCLUSIVE"), "STATUS INCONCLUSIVE");
	assert.equal(shapeStepStop("STATUS: PASSING-ish"), "STATUS PASSING-ish");
	assert.equal(shapeStepStop("all good"), "no STATUS line");
});
