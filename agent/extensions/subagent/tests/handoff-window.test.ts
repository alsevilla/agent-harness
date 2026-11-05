import assert from "node:assert/strict";
import test from "node:test";
import { formatCompletionNotice } from "../compact-handoff.ts";
import { collapseHandoffs, collapsedLine, DEFAULT_HANDOFF_WINDOW, HANDOFF_WINDOW_ENV, handoffWindowFromEnv, maskToolOutputs, registerHandoffWindow, shortenContext } from "../handoff-window.ts";

type Msg = Record<string, any>;
const reply = (status: string, risks = "none", extra = "") => `STATUS: ${status}\nNEXT: done\nRISKS: ${risks}\nEVIDENCE: /w/_evidence/t/REPORT.md${extra}`;
const fg = (n: number, status = "PASS focused tests green", risks = "none"): Msg => ({ role: "toolResult", toolCallId: `c${n}`, toolName: "subagent", content: [{ type: "text", text: reply(status, risks, `\nlong body ${n} `.repeat(40)) }], details: { mode: "single", results: [{ agent: "backend-worker" }] }, isError: false, timestamp: n });
const bg = (n: number, state = "completed", text = reply("PASS done")): Msg => ({ role: "custom", customType: "subagent-completion", content: formatCompletionNotice({ job: `bg-${n}`, state, workers: [`w${n}`], target: `bg-${n}@ep1`, text }), display: false, details: { jobId: `bg-${n}`, state }, timestamp: n });
const user = (text: string): Msg => ({ role: "user", content: text, timestamp: 0 });
const receipt = (n: number): Msg => ({ role: "toolResult", toolCallId: `r${n}`, toolName: "subagent", content: [{ type: "text", text: `Started bg-${n} in the background.` }], isError: false, timestamp: n });
const textOf = (m: Msg) => (typeof m.content === "string" ? m.content : m.content.map((p: any) => p.text).join("\n"));
const shortened = (m: Msg) => textOf(m).startsWith("[older subagent result, shortened:");
const deepFreeze = <T>(value: T): T => { if (value && typeof value === "object") { Object.values(value).forEach(deepFreeze); Object.freeze(value); } return value; };

test("env: unset, blank, invalid and below-5 values use 5; 0 is off; 5 and larger are taken", () => {
	for (const raw of [undefined, "", " ", "abc", "-1", "1", "4", "2.5", "99999"]) assert.equal(handoffWindowFromEnv(raw === undefined ? {} : { [HANDOFF_WINDOW_ENV]: raw }), DEFAULT_HANDOFF_WINDOW, String(raw));
	assert.equal(handoffWindowFromEnv({ [HANDOFF_WINDOW_ENV]: "0" }), 0);
	assert.equal(handoffWindowFromEnv({ [HANDOFF_WINDOW_ENV]: "5" }), 5);
	assert.equal(handoffWindowFromEnv({ [HANDOFF_WINDOW_ENV]: " 8 " }), 8);
});

test("nothing changes until a full batch of results is past the window, and 0 is off", () => {
	const nine = Array.from({ length: 9 }, (_, i) => fg(i));
	assert.equal(collapseHandoffs(nine, 5), undefined, "4 past the window: no batch yet");
	assert.equal(collapseHandoffs([...nine, fg(9)], 0), undefined, "off");
	const ten = collapseHandoffs([...nine, fg(9)], 5)!;
	assert.deepEqual(ten.map(shortened), [true, true, true, true, true, false, false, false, false, false]);
});

test("batches: collapsed lines are fixed once written, so the request prefix changes once per batch", () => {
	const all = Array.from({ length: 16 }, (_, i) => fg(i));
	const at = (n: number) => collapseHandoffs(all.slice(0, n), 5) ?? all.slice(0, n);
	const ten = at(10), fourteen = at(14), fifteen = at(15), sixteen = at(16);
	assert.deepEqual(fourteen.slice(0, 10), ten.slice(0, 10).map((m, i) => (i < 5 ? m : all[i])), "11-14 results: still only the first batch is shortened");
	assert.deepEqual(fifteen.slice(0, 5), ten.slice(0, 5), "earlier lines are byte-identical across batches");
	assert.deepEqual(fifteen.map(shortened), [...Array(10).fill(true), ...Array(5).fill(false)]);
	assert.deepEqual(sixteen.slice(0, 15).map(shortened), fifteen.slice(0, 15).map(shortened));
});

test("failures, open risks, errors and unknown output are never shortened, in either form", () => {
	const kept = [fg(0, "FAIL 2 tests fail"), fg(1, "PASS done", "flaky timing in CI"), fg(2, "INCONCLUSIVE lint not run"), fg(3, "BLOCKED missing schema"), { ...fg(4), isError: true },
		bg(5, "failed"), bg(6, "aborted"), bg(7, "completed", reply("ESCALATE needs a decision")), { ...fg(8), content: [{ type: "image", data: "x", mimeType: "image/png" }, { type: "text", text: reply("PASS") }] }];
	const messages = [...kept, ...Array.from({ length: 10 }, (_, i) => fg(20 + i))];
	const out = collapseHandoffs(messages, 5)!;
	for (let i = 0; i < kept.length; i++) assert.equal(out[i], messages[i], `kept item ${i} is the very same object`);
	assert.ok(out.slice(kept.length, kept.length + 5).every(shortened), "settled PASS results past the window are shortened");
});

test("a partial background notice (INCOMPLETE HANDOFF) stays word for word; a complete PASS notice is shortened with its retrieve target", () => {
	const partial = bg(1, "completed", reply("PASS done", "none", "\n" + "x".repeat(6000)));
	assert.match(textOf(partial), /INCOMPLETE HANDOFF/);
	const messages = [partial, bg(2), ...Array.from({ length: 9 }, (_, i) => fg(10 + i))];
	const out = collapseHandoffs(messages, 5)!;
	assert.equal(out[0], partial);
	assert.ok(shortened(out[1]));
	assert.equal(typeof out[1].content, "string", "a custom message keeps its string content form");
	assert.match(out[1].content, /\[older subagent result, shortened: bg-2@ep1 w2\] STATUS PASS done \| NEXT done \| EVIDENCE \/w\/_evidence\/t\/REPORT\.md \| may be outdated/);
	assert.deepEqual({ ...out[1], content: undefined }, { ...messages[1], content: undefined }, "role, customType, display and details unchanged");
});

test("launch receipts and other messages do not count toward the window and are never touched", () => {
	const messages = [user("go"), receipt(1), ...Array.from({ length: 9 }, (_, i) => fg(i)), receipt(2), user("next")];
	assert.equal(collapseHandoffs(messages, 5), undefined, "9 real results: receipts do not push it to a batch");
	const out = collapseHandoffs([...messages, fg(99)], 5)!;
	assert.equal(out[0], messages[0]);
	assert.equal(out[1], messages[1]);
	assert.equal(out.filter(shortened).length, 5);
});

test("a shortened tool result keeps its call id, tool name, error flag and details, so tool-call pairing stays valid", () => {
	const messages = Array.from({ length: 10 }, (_, i) => fg(i));
	const out = collapseHandoffs(messages, 5)!;
	const { content: a, ...restA } = out[0];
	const { content: b, ...restB } = messages[0];
	assert.deepEqual(restA, restB);
	assert.equal(a.length, 1);
	assert.equal(textOf(out[0]), collapsedLine({ index: 0, length: 0, label: "subagent backend-worker", fields: { status: ["PASS focused tests green"], next: ["done"], risks: ["none"], evidence: ["/w/_evidence/t/REPORT.md"] } }));
	assert.ok(textOf(out[0]).length * 2 < textOf(messages[0]).length, "the shortened line is well under half the original");
});

test("the input list and its messages are never mutated (the request copy changes, the transcript does not)", () => {
	const messages = deepFreeze([user("go"), ...Array.from({ length: 12 }, (_, i) => (i % 2 ? fg(i) : bg(i)))]);
	const before = JSON.stringify(messages);
	const out = collapseHandoffs(messages, 5);
	assert.ok(out && out !== messages);
	assert.equal(JSON.stringify(messages), before);
});

test("a short reply that the one-line form would not halve is left alone, permanently", () => {
	const short = { ...fg(0), content: [{ type: "text", text: reply("PASS done") }] };
	const messages = [short, ...Array.from({ length: 14 }, (_, i) => fg(i + 1))];
	const out = collapseHandoffs(messages, 5)!;
	assert.equal(out[0], short);
	assert.ok(out.slice(1, 10).every(shortened));
});

test("long field values are clipped to one line each", () => {
	const long = { ...fg(0), content: [{ type: "text", text: reply(`PASS ${"word ".repeat(80)}\n`, "none", "\nbody ".repeat(200)) }] };
	const out = collapseHandoffs([long, ...Array.from({ length: 9 }, (_, i) => fg(i + 1))], 5)!;
	assert.ok(!textOf(out[0]).includes("\n"));
	assert.ok(textOf(out[0]).length < 600);
});

test("wiring: registers one context handler that returns a request-only list, or nothing when there is nothing to shorten; off registers none", async () => {
	const handlers = new Map<string, (event: unknown) => unknown>();
	const pi = { on: (name: string, fn: any) => { assert.ok(!handlers.has(name)); handlers.set(name, fn); } };
	assert.equal(registerHandoffWindow(pi as never, {}), 5);
	assert.deepEqual([...handlers.keys()], ["context"]);
	const handler = handlers.get("context")!;
	assert.equal(await handler({ messages: [user("hi"), fg(1)] }), undefined);
	const event = { messages: Array.from({ length: 10 }, (_, i) => fg(i)) };
	const result = (await handler(event)) as { messages: Msg[] };
	assert.equal(result.messages.filter(shortened).length, 5);
	assert.equal(event.messages.filter(shortened).length, 0, "the event's own list is left as it was");
	const none = new Map<string, unknown>();
	assert.equal(registerHandoffWindow({ on: (name: string, fn: unknown) => none.set(name, fn) } as never, { [HANDOFF_WINDOW_ENV]: "0" }), 0);
	assert.equal(none.size, 0);
});

// Main's own large tool outputs: masked in batches like subagent results, with a stub naming the file or command.
const call = (n: number, name: string, args: object): Msg => ({ role: "assistant", content: [{ type: "toolCall", id: `t${n}`, name, arguments: args }], timestamp: n });
const out = (n: number, name: string, size = 3000, extra: object = {}): Msg => ({ role: "toolResult", toolCallId: `t${n}`, toolName: name, content: [{ type: "text", text: "x".repeat(size) }], isError: false, timestamp: n, ...extra });
const reads = (count: number) => Array.from({ length: count }, (_, i) => [call(i, "read", { path: `/w/src/f${i}.ts` }), out(i, "read")]).flat();
const masked = (m: Msg) => textOf(m).startsWith("[older ");

test("tool outputs: nothing until a full batch is past the window; then the oldest batch becomes one stub naming the file", () => {
	assert.equal(maskToolOutputs(reads(9), 5), undefined);
	assert.equal(maskToolOutputs(reads(10), 0), undefined, "off");
	const result = maskToolOutputs(reads(10), 5)!;
	const results = result.filter((m) => m.role === "toolResult");
	assert.deepEqual(results.map(masked), [true, true, true, true, true, false, false, false, false, false]);
	assert.equal(textOf(results[0]), "[older read output, shortened: /w/src/f0.ts] 3,000 characters; run it again if you still need the content");
});

test("tool outputs: errors, short outputs, other tools and subagent results are never masked; input is not mutated", () => {
	const keep = [out(90, "read", 3000, { isError: true }), out(91, "read", 500), out(92, "edit"), out(93, "subagent")];
	const messages = deepFreeze([...keep, ...reads(10)]);
	const result = maskToolOutputs(messages, 5)!;
	for (let i = 0; i < keep.length; i++) assert.equal(result[i], messages[i]);
	assert.equal(result.filter(masked).length, 5);
	const bash = maskToolOutputs([call(100, "bash", { command: "git log --stat" }), out(100, "bash"), ...reads(9)], 5)!;
	assert.match(textOf(bash[1]), /^\[older bash output, shortened: git log --stat\]/);
});

test("shortenContext applies both rules to one request and leaves it alone when neither applies", () => {
	const messages = [...Array.from({ length: 10 }, (_, i) => fg(i)), ...reads(10)];
	const result = shortenContext(messages, 5)!;
	assert.equal(result.filter(shortened).length, 5);
	assert.equal(result.filter((m) => m.role === "toolResult" && m.toolName === "read" && masked(m)).length, 5);
	assert.equal(shortenContext([user("hi"), ...reads(3)], 5), undefined);
});

// Runtime state card: one hidden trailing line while jobs run or decisions wait; the prefix is untouched.
import { stateCard, STATE_CARD_TYPE } from "../handoff-window.ts";
test("state card: names running jobs and open decisions, nothing when idle", () => {
	assert.equal(stateCard([], "ep1", 0), undefined);
	assert.equal(stateCard([{ jobId: "bg-1", state: "completed" }], "ep1", 0), undefined);
	const card = stateCard([{ jobId: "bg-2", state: "running", workers: [{ name: "backend-worker" }] }, { jobId: "bg-3", state: "running", paused: true, workers: [] }], "ep1", 1)!;
	assert.match(card, /^\[runtime state, not user text\] running: bg-2@ep1 \(backend-worker\); bg-3@ep1 \(starting, paused\); 1 worker decision waiting/);
	assert.match(card, /do not re-launch running work/);
});
test("state card wiring: appended last as a hidden custom message, with or without the window; the prefix is unchanged", async () => {
	const handlers = new Map<string, (event: unknown) => unknown>();
	let card: string | undefined = "[runtime state, not user text] running: bg-1@e (x).";
	registerHandoffWindow({ on: (name: string, fn: any) => handlers.set(name, fn) } as never, { [HANDOFF_WINDOW_ENV]: "0" }, () => card);
	const messages = [user("hi"), fg(1)];
	const out = (await handlers.get("context")!({ messages })) as { messages: Msg[] };
	assert.equal(out.messages.length, 3);
	assert.deepEqual(out.messages.slice(0, 2), messages, "prefix untouched");
	assert.equal(out.messages[2].customType, STATE_CARD_TYPE);
	assert.equal(out.messages[2].display, false);
	card = undefined;
	assert.equal(await handlers.get("context")!({ messages }), undefined, "idle: no change");
});

// Claude Haiku 5.5 prices a request over 100k input tokens at 5x; workers kept every tool output, so a long debugger run crossed it.
import { capWorkerContext, DEFAULT_WORKER_MASK_TOKENS, estimateTokens, workerMaskFromEnv, WORKER_MASK_ENV } from "../handoff-window.ts";
test("worker cap: threshold from the environment, 0 turns it off, nonsense keeps the default", () => {
	assert.equal(DEFAULT_WORKER_MASK_TOKENS, 80_000);
	assert.equal(workerMaskFromEnv({}), 80_000);
	assert.equal(workerMaskFromEnv({ [WORKER_MASK_ENV]: "0" }), 0);
	assert.equal(workerMaskFromEnv({ [WORKER_MASK_ENV]: "60000" }), 60_000);
	assert.equal(workerMaskFromEnv({ [WORKER_MASK_ENV]: "500" }), 80_000, "below 20k is refused");
	assert.equal(workerMaskFromEnv({ [WORKER_MASK_ENV]: "lots" }), 80_000);
});
test("worker cap: nothing changes below the threshold; above it older large outputs are masked like main's, newest five kept", () => {
	const call = (i: number) => ({ role: "assistant", content: [{ type: "toolCall", id: `c${i}`, name: "read", arguments: { path: `/w/src/f${i}.ts` } }] });
	const out = (i: number, size: number) => ({ role: "toolResult", toolCallId: `c${i}`, toolName: "read", isError: false, content: [{ type: "text", text: "x".repeat(size) }] });
	const run = (n: number, size: number) => Array.from({ length: n }, (_, i) => [call(i), out(i, size)]).flat() as never[];
	const small = run(12, 4000); // ~12k tokens
	assert.ok(estimateTokens(small) < 80_000);
	assert.equal(capWorkerContext(small, 80_000), undefined, "a short worker run is untouched");
	const big = run(12, 30_000); // ~90k tokens
	assert.ok(estimateTokens(big) >= 80_000);
	const capped = capWorkerContext(big, 80_000)!;
	assert.ok(capped, "masked from the threshold");
	const texts = capped.filter((m: any) => m.role === "toolResult").map((m: any) => m.content[0].text);
	assert.equal(texts.filter((t: string) => t.startsWith("[older read output, shortened: /w/src/f")).length, 5, "oldest whole batch of five");
	assert.equal(texts.filter((t: string) => t.length === 30_000).length, 7, "the rest, including the newest five, word for word");
	assert.ok(estimateTokens(capped) < estimateTokens(big) * 0.65);
	assert.equal(capWorkerContext(big, 0), undefined, "0 is off");
	assert.equal(big.filter((m: any) => m.role === "toolResult")[0].content[0].text.length, 30_000, "input not mutated");
});
