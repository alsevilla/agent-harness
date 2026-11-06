// Main checkpoints: at an idle task boundary main's earlier turns are folded into one checkpoint built from the messages (no model call),
// so a long session stops carrying its whole history (field report: main at 348k tokens, 478 requests averaging ~159k, visibly slower).
import assert from "node:assert/strict";
import test from "node:test";
import { CHECKPOINT_TYPE, DEFAULT_MAIN_FOLD_TOKENS, MAIN_FOLD_ENV, mainFoldFromEnv, registerHandoffWindow, requestMainFold, retainedUser, STATE_CARD_TYPE } from "../handoff-window.ts";

type Msg = Record<string, any>;
let clock = 0;
const user = (text: string): Msg => ({ role: "user", content: text, timestamp: ++clock });
const reply = (text: string, call?: string): Msg => ({ role: "assistant", content: [{ type: "thinking", thinking: "plan" }, { type: "text", text }, ...(call ? [{ type: "toolCall", id: call, name: "subagent", arguments: { agent: "backend-worker", task: "x" } }] : [])], timestamp: ++clock });
const result = (call: string, n: number, size = 9000): Msg => ({ role: "toolResult", toolName: "subagent", toolCallId: call, content: [{ type: "text", text: `STATUS: PASS - task ${n} done\nNEXT: open the PR\nRISKS: none\nEVIDENCE: _evidence/t${n}/REPORT.md\n${"detail ".repeat(size / 7)}` }], details: { results: [{ agent: "backend-worker" }] }, timestamp: ++clock });
const turn = (n: number): Msg[] => [user(`Task ${n}: please pace the SMS sender (rule: never push to master)`), reply(`Launching backend-worker for task ${n}.`, `c${n}`), result(`c${n}`, n), reply(`Task ${n} is done; PR #${100 + n} is open.`)];

function setup(env: Record<string, string>, card: () => string | undefined = () => undefined) {
	const handlers = new Map<string, (event: unknown) => any>();
	registerHandoffWindow({ on: (name: string, fn: any) => handlers.set(name, fn) } as never, env, card);
	return async (messages: Msg[]) => ((await handlers.get("context")!({ messages: [...messages] }))?.messages ?? messages) as Msg[];
}

test("env: default 50k, 0 off, values under 20k refused", () => {
	assert.equal(DEFAULT_MAIN_FOLD_TOKENS, 50_000);
	assert.equal(mainFoldFromEnv({}), DEFAULT_MAIN_FOLD_TOKENS);
	assert.equal(mainFoldFromEnv({ [MAIN_FOLD_ENV]: "0" }), 0);
	assert.equal(mainFoldFromEnv({ [MAIN_FOLD_ENV]: "150000" }), 150_000);
	assert.equal(mainFoldFromEnv({ [MAIN_FOLD_ENV]: "500" }), DEFAULT_MAIN_FOLD_TOKENS);
});

test("folds at an idle new user turn past the threshold; user messages stay separate from checkpoint result lines and replies; later requests extend it exactly", async () => {
	const request = setup({ [MAIN_FOLD_ENV]: "20000" });
	const history: Msg[] = [];
	for (let n = 1; n <= 12; n++) history.push(...turn(n));
	history.push(user("x".repeat(3000))); // a long paste in the last folded turn
	history.push(reply("Here is my analysis. Want me to build it?"));
	const below = await request(history.slice(0, 8));
	assert.equal(below.some((m) => m.customType === CHECKPOINT_TYPE), false, "under the threshold nothing folds");
	const mid = await request([...history, { ...result("cz", 99), timestamp: ++clock }]);
	assert.equal(mid.some((m) => m.customType === CHECKPOINT_TYPE), false, "only at a new user turn");
	history.push(user("yes"));
	const folded = await request(history);
	assert.equal(folded.length, history.filter((m) => m.role === "user").length + 1);
	assert.equal(folded[0].customType, CHECKPOINT_TYPE);
	assert.equal(folded[0].display, false);
	assert.deepEqual(folded.at(-1), history.at(-1), "the newest user message stays last");
	const cp = String(folded[0].content);
	assert.match(cp, /^\[main checkpoint, not user text\]/);
	assert.deepEqual(folded.filter((m) => m.role === "user"), history.filter((m) => m.role === "user"));
	assert.match(cp, /Result: \[older subagent result, shortened: subagent backend-worker\] STATUS PASS - task 1 done \| NEXT open the PR \| EVIDENCE _evidence\/t1\/REPORT\.md/);
	assert.match(cp, /Main: Task 12 is done; PR #112 is open\./);
	assert.doesNotMatch(cp, /x{600}/, "notes do not duplicate truncated user previews");
	assert.match(cp, /Main: Here is my analysis\. Want me to build it\?/, "the last exchange keeps main's question");
	let previous = folded;
	for (const next of [reply("Building it.", "c50"), result("c50", 50, 2000), reply("Done.")]) {
		history.push(next);
		const now = await request(history);
		assert.deepEqual(now.slice(0, previous.length), previous, "each request starts with the previous one exactly");
		previous = now;
	}
	history.push(user("next task"));
	const again = await request(history);
	assert.equal(again[0].content, previous[0].content, "under the threshold again: the same checkpoint, no new fold");
});

test("never folds while a job runs or a decision waits; a later fold adds to the checkpoint; a compaction starts over", async () => {
	let card: string | undefined = "[runtime state, not user text] running: bg-1@e (x).";
	const request = setup({ [MAIN_FOLD_ENV]: "20000" }, () => card);
	const history: Msg[] = [];
	for (let n = 1; n <= 12; n++) history.push(...turn(n));
	history.push(user("status?"));
	assert.equal((await request(history)).some((m) => m.customType === CHECKPOINT_TYPE), false, "busy: no fold");
	card = undefined;
	history.push(reply("All done."), user("thanks"));
	const first = await request(history);
	assert.equal(first[0].customType, CHECKPOINT_TYPE);
	assert.ok(first.some((m) => m.customType === STATE_CARD_TYPE), "the cleared card after the kept message stays");
	for (let n = 13; n <= 26; n++) history.push(...turn(n));
	history.push(user("one more"));
	const second = await request(history);
	const cp = String(second[0].content);
	assert.match(cp, /STATUS PASS - task 1 done/, "the first fold's notes stay");
	assert.match(cp, /Task 26 is done/, "the new turns are added");
	assert.deepEqual(second.filter((m) => m.role === "user"), history.filter((m) => m.role === "user"));
	const compacted = [{ role: "user", content: "summary of everything", timestamp: ++clock }, user("go on")];
	const after = await request(compacted);
	assert.equal(after.some((m) => m.customType === CHECKPOINT_TYPE), false, "after a compaction the old fold point is gone: start over");
});

test("/subagent fold folds at the next idle user turn whatever the size; 0 turns checkpoints off", async () => {
	const request = setup({});
	const history: Msg[] = [...turn(1), user("new task")];
	assert.equal((await request(history)).some((m) => m.customType === CHECKPOINT_TYPE), false);
	assert.match(requestMainFold(), /at your next message/);
	history.push(reply("ok"), user("go"));
	const folded = await request(history);
	assert.equal(folded[0].customType, CHECKPOINT_TYPE);
	setup({ [MAIN_FOLD_ENV]: "0" });
	assert.match(requestMainFold(), /off/);
});

test("the README's command table lists /subagent fold", async () => {
	const { readFileSync } = await import("node:fs");
	const readme = readFileSync(new URL("../../../../README.md", import.meta.url), "utf8");
	assert.match(readme, /^\| `\/subagent fold` \| /m);
	assert.match(readme, /^## Context and cost$/m, "the row's link target exists");
});

// User text is the conservative constraint record: do not try to infer which
// sentences contain requirements, holds, authorization limits or open questions.
test("requirements anywhere in messages up to 3,000 characters survive repeated folds and checkpoint pressure", async () => {
	const request = setup({});
	const text = "Never deploy.\n" + "a".repeat(1_400) + "\nWhich API version? Leave this unresolved.\n" + "b".repeat(1_400) + "\nDo not change the public contract.";
	const original = { ...user(text), content: [{ type: "text", text }, { type: "image", data: "original-image", mimeType: "image/png" }] };
	const history = [original, reply("Acknowledged.")];
	for (let n = 0; n < 3; n++) {
		// Enough notes to exercise the 40k checkpoint cap as well as repeated folds.
		for (let i = 0; i < 25; i++) history.push(user(`turn ${n}-${i}`), reply("notes ".repeat(1000)), result(`large-${n}-${i}`, i));
		history.push(user(`continue ${n}`));
		requestMainFold();
		const before = JSON.stringify(history);
		const folded = await request(history);
		assert.equal(JSON.stringify(history), before, "saved messages are unchanged");
		assert.deepEqual(folded.filter((m) => m.role === "user"), history.filter((m) => m.role === "user"), "all user content and nontext parts stay verbatim, once and in order");
		assert.ok(String(folded[0].content).length < 41_000, "only recoverable notes are capped");
		history.push(reply("Continuing."));
	}
});

test("the native session branch restores user constraints after compaction and reload without resurrecting another branch", async () => {
	const original = user("Never push or deploy. " + "detail ".repeat(300) + " Preserve the schema.");
	const current = user("continue");
	let branch = [original, reply("done"), current].map((message) => ({ type: "message", message }));
	const handlers = new Map<string, (event: any, ctx?: any) => any>();
	const register = () => registerHandoffWindow({ on: (name: string, fn: any) => handlers.set(name, fn) } as never, {}, () => undefined);
	const compacted = [{ role: "compactionSummary", summary: "Lossy summary", tokensBefore: 100_000, timestamp: ++clock }, current];
	const ctx = { sessionManager: { getBranch: () => branch } };
	register();
	const first = handlers.get("context")!({ messages: compacted }, ctx).messages;
	assert.deepEqual(first.filter((m: Msg) => m.role === "user"), [original, current]);
	register(); // fresh extension instance, same persisted branch
	assert.deepEqual(handlers.get("context")!({ messages: compacted }, ctx).messages, first);
	assert.equal(handlers.get("context")!({ messages: [original, current] }, ctx), undefined, "no duplicate when already present");
	branch = [{ type: "message", message: current }]; // fork/rewind selected another branch
	assert.equal(handlers.get("context")!({ messages: compacted }, ctx), undefined, "no stale in-memory constraint archive");
});

test("restoring a missing middle turn preserves later corrections and host-transformed messages", () => {
	const first = user("Never deploy.");
	const middle = user("You may deploy staging.");
	const latest = user("Stop all deployment.");
	const handlers = new Map<string, (event: any, ctx?: any) => any>();
	registerHandoffWindow({ on: (name: string, fn: any) => handlers.set(name, fn) } as never, {}, () => undefined);
	const transformed = { ...latest, content: latest.content + " [host expansion]" };
	const ctx = { sessionManager: { getBranch: () => [first, middle, latest].map((message) => ({ type: "message", message })) } };
	const result = handlers.get("context")!({ messages: [first, transformed] }, ctx);
	assert.deepEqual(result.messages, [first, middle, transformed]);
});


test("older pastes retain 2,000 head and 800 tail characters across text parts, keeping images and newest input", async () => {
	const request = setup({});
	const image = { type: "image", data: "keep-image", mimeType: "image/png" };
	const first = user("a".repeat(3_000));
	const large = { ...user(""), content: [{ type: "text", text: "H".repeat(1_500) }, image, { type: "text", text: "H".repeat(500) + "M".repeat(5_000) }, { type: "text", text: "T".repeat(800) }] };
	const latest = user("newest ".repeat(1_000));
	const history = [first, reply("done"), large, reply("done"), latest];
	const saved = JSON.stringify(history);
	requestMainFold();
	const folded = await request(history);
	const users = folded.filter((m) => m.role === "user");
	assert.deepEqual(users[0], first, "exactly 3,000 characters stay whole");
	assert.deepEqual(users[2], latest, "newest message is never cut");
	assert.equal(users[1].content[1], image);
	const text = users[1].content.filter((p: any) => p.type === "text").map((p: any) => p.text).join("");
	assert.ok(text.startsWith("H".repeat(2_000)));
	assert.ok(text.endsWith("T".repeat(800)));
	assert.match(text, /full text is in the saved session/);
	assert.ok(text.length < 3_000);
	assert.ok(!text.includes("M"), "the middle of an oversized paste is intentionally omitted");
	assert.equal(JSON.stringify(history), saved, "saved transcript is untouched");
	history.push(reply("done"), user("next"));
	requestMainFold();
	const again = (await request(history)).filter((m) => m.role === "user");
	assert.deepEqual(again[1], users[1], "repeated folds do not truncate retained text again");
	assert.ok(again[2].content.length < 3_000, "the formerly newest paste is bounded once it becomes older");
});

test("native compaction restoration limits older pastes but preserves the newest message", () => {
	const older = user("H".repeat(2_000) + "M".repeat(5_000) + "T".repeat(800));
	const newest = user("newest ".repeat(1_000));
	const handlers = new Map<string, (event: any, ctx?: any) => any>();
	registerHandoffWindow({ on: (name: string, fn: any) => handlers.set(name, fn) } as never, {}, () => undefined);
	const ctx = { sessionManager: { getBranch: () => [older, newest].map((message) => ({ type: "message", message })) } };
	const { messages } = handlers.get("context")!({ messages: [newest] }, ctx);
	assert.ok(messages[0].content.startsWith("H".repeat(2_000)));
	assert.ok(messages[0].content.endsWith("T".repeat(800)));
	assert.ok(messages[0].content.length < 3_000);
	assert.deepEqual(messages[1], newest);
	assert.equal(older.content.length, 7_800, "persisted branch text is unchanged");
});
