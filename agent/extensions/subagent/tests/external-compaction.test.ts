import assert from "node:assert/strict";
import test from "node:test";
import { registerExternalCompaction } from "../external-compaction-entry.ts";

type Handler = (event: any, ctx: any) => any;
// Any pi API other than pi.on is a failure: the guard may not register tools, commands, permissions or active-tool changes.
function fakePi() {
	const handlers = new Map<string, Handler[]>();
	const calls: string[] = [];
	const pi = new Proxy({}, {
		get(_target, prop) {
			if (prop === "on") return (name: string, handler: Handler) => { calls.push(`on:${name}`); handlers.set(name, [...(handlers.get(name) ?? []), handler]); };
			return () => { throw new Error(`unexpected pi.${String(prop)}`); };
		},
	}) as any;
	return { pi, handlers, calls };
}
function fakeCtx() {
	const notes: { message: string; type?: string }[] = [];
	return { ctx: { ui: { notify: (message: string, type?: string) => notes.push({ message, type }) } }, notes };
}
const on = { PI_EXTERNAL_COMPACTION: "1" };

test("env unset or not exactly 1 registers no handler and no notification", () => {
	for (const env of [{}, { PI_EXTERNAL_COMPACTION: undefined }, { PI_EXTERNAL_COMPACTION: "0" }, { PI_EXTERNAL_COMPACTION: "false" }, { PI_EXTERNAL_COMPACTION: "" }]) {
		const { pi, calls } = fakePi();
		registerExternalCompaction(pi, { env });
		assert.deepEqual(calls, [], JSON.stringify(env));
	}
});

test("opted in registers only session_start and session_before_compact, with no other pi API", () => {
	const { pi, handlers, calls } = fakePi();
	registerExternalCompaction(pi, { env: on });
	assert.deepEqual(calls, ["on:session_start", "on:session_before_compact"]);
	assert.equal(handlers.get("session_before_compact")!.length, 1);
});

test("manual /compact is cancelled with a warning that the external proxy owns compression", () => {
	const { pi, handlers } = fakePi();
	const { ctx, notes } = fakeCtx();
	registerExternalCompaction(pi, { env: on });
	const result = handlers.get("session_before_compact")![0]({ type: "session_before_compact", reason: "manual", willRetry: false }, ctx);
	assert.deepEqual(result, { cancel: true });
	assert.equal(notes.length, 1);
	assert.equal(notes[0].type, "warning");
	assert.match(notes[0].message, /\/compact/);
	assert.match(notes[0].message, /external/);
});

test("threshold compaction is cancelled silently after the startup note", () => {
	const { pi, handlers } = fakePi();
	const { ctx, notes } = fakeCtx();
	registerExternalCompaction(pi, { env: on });
	handlers.get("session_start")![0]({ type: "session_start" }, ctx);
	assert.equal(notes.length, 1);
	assert.equal(notes[0].type, "info");
	assert.match(notes[0].message, /PI_EXTERNAL_COMPACTION=1/);
	const result = handlers.get("session_before_compact")![0]({ type: "session_before_compact", reason: "threshold", willRetry: false }, ctx);
	assert.deepEqual(result, { cancel: true });
	assert.equal(notes.length, 1, "threshold must not add per-event notifications");
});

test("overflow recovery is cancelled with a warning that it needs external compression or a new session and is never retried", () => {
	const { pi, handlers } = fakePi();
	const { ctx, notes } = fakeCtx();
	registerExternalCompaction(pi, { env: on });
	for (const willRetry of [false, true]) {
		const result = handlers.get("session_before_compact")![0]({ type: "session_before_compact", reason: "overflow", willRetry }, ctx);
		assert.deepEqual(result, { cancel: true }, `willRetry=${willRetry}`);
	}
	assert.equal(notes.length, 2);
	for (const note of notes) {
		assert.equal(note.type, "warning");
		assert.match(note.message, /overflow/);
		assert.match(note.message, /external compression|new session/);
		assert.match(note.message, /nothing was compressed/);
	}
});

test("child mode (notify false) cancels the same events without any UI notification", () => {
	const { pi, handlers } = fakePi();
	const { ctx, notes } = fakeCtx();
	registerExternalCompaction(pi, { env: on, notify: false });
	handlers.get("session_start")![0]({ type: "session_start" }, ctx);
	for (const reason of ["manual", "threshold", "overflow"]) {
		assert.deepEqual(handlers.get("session_before_compact")![0]({ type: "session_before_compact", reason, willRetry: false }, ctx), { cancel: true });
	}
	assert.equal(notes.length, 0);
});

test("the child default export registers the same cancel hook silently when the env is set and nothing when unset", async () => {
	const { default: childGuard } = await import("../external-compaction-entry.ts");
	const saved = process.env.PI_EXTERNAL_COMPACTION;
	try {
		delete process.env.PI_EXTERNAL_COMPACTION;
		const off = fakePi();
		childGuard(off.pi);
		assert.deepEqual(off.calls, []);
		process.env.PI_EXTERNAL_COMPACTION = "1";
		const on = fakePi();
		const { ctx, notes } = fakeCtx();
		childGuard(on.pi);
		assert.deepEqual(on.handlers.get("session_before_compact")![0]({ type: "session_before_compact", reason: "overflow", willRetry: true }, ctx), { cancel: true });
		assert.equal(notes.length, 0);
	} finally {
		if (saved === undefined) delete process.env.PI_EXTERNAL_COMPACTION;
		else process.env.PI_EXTERNAL_COMPACTION = saved;
	}
});
