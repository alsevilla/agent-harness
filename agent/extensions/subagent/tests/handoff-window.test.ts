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

test("env: unset, blank, invalid and below-5 values use the default of 10; 0 is off; 5 and larger are taken", () => {
	assert.equal(DEFAULT_HANDOFF_WINDOW, 10, "main: batches of 10 cost less under caching than 5");
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
	assert.equal(registerHandoffWindow(pi as never, {}), DEFAULT_HANDOFF_WINDOW);
	assert.deepEqual([...handlers.keys()], ["context"]);
	const handler = handlers.get("context")!;
	assert.equal(await handler({ messages: [user("hi"), fg(1)] }), undefined);
	assert.equal(await handler({ messages: Array.from({ length: 19 }, (_, i) => fg(i)) }), undefined, "19 results do not yet fill a second batch of 10");
	const event = { messages: Array.from({ length: 20 }, (_, i) => fg(i)) };
	const result = (await handler(event)) as { messages: Msg[] };
	assert.equal(result.messages.filter(shortened).length, 10);
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
import { CLEARED_CARD, stateCard, STATE_CARD_TYPE } from "../handoff-window.ts";
test("state card: names running jobs and open decisions, nothing when idle", () => {
	assert.equal(stateCard([], "ep1", 0), undefined);
	assert.equal(stateCard([{ jobId: "bg-1", state: "completed" }], "ep1", 0), undefined);
	const card = stateCard([{ jobId: "bg-2", state: "running", workers: [{ name: "backend-worker" }] }, { jobId: "bg-3", state: "running", paused: true, workers: [] }], "ep1", 1)!;
	assert.match(card, /^\[runtime state, not user text\] running: bg-2@ep1 \(backend-worker\); bg-3@ep1 \(starting, paused\); 1 worker decision waiting/);
	assert.match(card, /do not re-launch running work/);
});
// Pi puts the one conversation cache breakpoint on the last block of the last user message. A card appended to the end of every request
// held it, so no cache entry ever matched the next request and main's whole history was written to the cache on every request while a job
// ran. The invariant that matters: each request starts with the previous request's messages exactly (the old entry is a prefix of it).
test("state card: each card stays where it first appeared, so every request extends the previous one; a change adds a card, emptying adds a cleared card", async () => {
	const handlers = new Map<string, (event: unknown) => unknown>();
	let card: string | undefined;
	registerHandoffWindow({ on: (name: string, fn: any) => handlers.set(name, fn) } as never, { [HANDOFF_WINDOW_ENV]: "0" }, () => card);
	const at = (i: number) => ({ ...user(`m${i}`), timestamp: i });
	const history: Msg[] = [at(0)];
	const request = async () => ((await handlers.get("context")!({ messages: [...history] })) as { messages: Msg[] } | undefined)?.messages ?? [...history];
	assert.deepEqual(await request(), history, "idle: no card, nothing changes");
	card = "[runtime state, not user text] running: bg-1@e (x).";
	let previous = await request();
	assert.equal(previous.at(-1)!.customType, STATE_CARD_TYPE);
	assert.equal(previous.at(-1)!.display, false);
	for (let i = 1; i <= 4; i++) {
		history.push(at(i));
		if (i === 3) card = "[runtime state, not user text] running: bg-1@e (backend-worker).";
		if (i === 4) card = undefined;
		const next = await request();
		assert.deepEqual(next.slice(0, previous.length), previous, `request ${i} starts with request ${i - 1} exactly`);
		previous = next;
	}
	const cards = previous.filter((m) => m.customType === STATE_CARD_TYPE).map((m) => String(m.content));
	assert.deepEqual(cards, ["[runtime state, not user text] running: bg-1@e (x).", "[runtime state, not user text] running: bg-1@e (backend-worker).", CLEARED_CARD], "one card per change, then cleared");
	assert.equal(previous.at(-1)!.customType, STATE_CARD_TYPE, "the cleared card follows the message that was last when the state emptied");
	history.splice(0, history.length, at(10), at(11)); // compaction: the anchors are gone
	card = "[runtime state, not user text] running: bg-2@e (y).";
	const after = await request();
	assert.deepEqual(after.filter((m) => m.customType === STATE_CARD_TYPE).map((m) => String(m.content)), [card], "after a compaction the trail starts again");
});

// Claude Haiku 5.5 prices a request over 100k input tokens at 5x; workers kept every tool output, so a long debugger run crossed it.
import { capWorkerContext, DEFAULT_WORKER_MASK_TOKENS, estimateTokens, workerBudgetFromEnv, workerMaskFromEnv, WORKER_BUDGET_ENV, WORKER_MASK_ENV } from "../handoff-window.ts";
test("worker cap: threshold from the environment, 0 turns it off, nonsense keeps the default", () => {
	assert.equal(DEFAULT_WORKER_MASK_TOKENS, 80_000);
	assert.equal(workerMaskFromEnv({}), 80_000);
	assert.equal(workerMaskFromEnv({ [WORKER_MASK_ENV]: "0" }), 0);
	assert.equal(workerMaskFromEnv({ [WORKER_MASK_ENV]: "60000" }), 60_000);
	assert.equal(workerMaskFromEnv({ [WORKER_MASK_ENV]: "500" }), 80_000, "below 20k is refused");
	assert.equal(workerMaskFromEnv({ [WORKER_MASK_ENV]: "lots" }), 80_000);
});
const capCall = (i: number) => ({ role: "assistant", content: [{ type: "toolCall", id: `c${i}`, name: "read", arguments: { path: `/w/src/f${i}.ts` } }] });
const capOut = (i: number, size: number) => ({ role: "toolResult", toolCallId: `c${i}`, toolName: "read", isError: false, content: [{ type: "text", text: "x".repeat(size) }] });
const run = (n: number, size: number) => Array.from({ length: n }, (_, i) => [capCall(i), capOut(i, size)]).flat() as never[];
const capOutputs = (messages: any[]) => messages.filter((m) => m.role === "toolResult").map((m) => m.content[0].text as string);

test("worker cap: budget from the environment, never below the trigger", () => {
	assert.equal(workerBudgetFromEnv({}), 95_000);
	assert.equal(workerBudgetFromEnv({ [WORKER_BUDGET_ENV]: "70000", [WORKER_MASK_ENV]: "80000" }), 80_000);
	assert.equal(workerBudgetFromEnv({ [WORKER_BUDGET_ENV]: "120000" }), 120_000);
});

test("worker cap: nothing changes below the trigger", () => {
	const small = run(12, 4000);
	const r = capWorkerContext(small, 80_000);
	assert.equal(r.messages, undefined);
	assert.equal(r.step, undefined);
	assert.equal(r.before, estimateTokens(small));
	assert.equal(capWorkerContext(run(12, 30_000), 0).messages, undefined, "0 is off");
});

test("worker cap: normal batching first, re-measured; it stops at the first step that fits the budget", () => {
	const big = run(12, 30_000); // ~90k: over the trigger, under the budget after one batch
	const r = capWorkerContext(big, 80_000, 95_000);
	assert.equal(r.step, "batch");
	assert.equal(capOutputs(r.messages!).filter((t) => t.startsWith("[older read output, shortened")).length, 5, "oldest whole batch of five");
	assert.equal(capOutputs(r.messages!).filter((t) => t.length === 30_000).length, 7, "the rest word for word");
	assert.ok(r.after < 95_000 && r.after < r.before);
	assert.equal(capOutputs(big)[0].length, 30_000, "input not mutated");
});

test("worker cap: still over budget after batching, every older output is masked, then outputs are bounded, then the last resort, then 'over'", () => {
	const allOlder = capWorkerContext(run(9, 45_000), 80_000, 95_000); // ~101k, nine outputs: no whole batch beyond the newest five
	assert.equal(allOlder.step, "all-older");
	assert.equal(capOutputs(allOlder.messages!).filter((t) => t.startsWith("[older read output")).length, 4, "all four older outputs");
	assert.ok(allOlder.after < 95_000);

	const bounded = capWorkerContext(run(6, 80_000), 80_000, 95_000); // the newest five alone are ~100k
	assert.equal(bounded.step, "bounded");
	const texts = capOutputs(bounded.messages!);
	assert.equal(texts[texts.length - 1].length, 80_000, "the latest result stays whole");
	assert.match(texts[texts.length - 2], /^x{2000}\n\[… 76,000 characters shortened to stay in budget; read again with offset and limit, or rerun, if you need them …\]\nx{2000}$/);
	assert.ok(bounded.after < 95_000);

	const latestHuge = capWorkerContext(run(2, 400_000), 80_000, 95_000); // the latest result alone is over budget
	assert.equal(latestHuge.step, "last-resort", "the latest result is bounded for this request, not left over budget");
	const last = capOutputs(latestHuge.messages!);
	assert.match(last[last.length - 1], /^x{8000}\n\[… 384,000 characters shortened to stay in budget; read again with offset and limit, or rerun, if you need them …\]\nx{8000}$/);
	assert.match(last[0], /^\[older read output, shortened/, "every older output masked");
	assert.ok(latestHuge.after < 95_000);

	const talk = [{ role: "assistant", content: [{ type: "text", text: "y".repeat(400_000) }] }, ...run(1, 1_000)] as never[];
	const over = capWorkerContext(talk, 80_000, 95_000); // assistant text, not tool output, fills the budget
	assert.equal(over.step, "over", "only then is the host asked to compact");
	assert.ok(over.after >= 95_000);
});

test("worker cap: the system prompt counts toward the trigger and the budget", () => {
	const mid = run(12, 20_000); // ~60k of messages
	assert.equal(capWorkerContext(mid, 80_000, 95_000).step, undefined);
	assert.equal(capWorkerContext(mid, 80_000, 95_000, 25_000).step, "batch", "with a 25k system prompt it is over the trigger");
});

// Field report on v1.14.0: test-engineer peaked at 128,481 and debugger at 140,152 provider tokens against a 95k budget, because
// characters / 4 undercounts code and tool output. The estimate is now scaled by the provider-reported input of the latest request.
import { requestScale } from "../handoff-window.ts";
const withUsage = (messages: any[], real: number) => [...messages, { role: "assistant", content: [{ type: "text", text: "ok" }], usage: { input: 10, cacheRead: real - 10, cacheWrite: 0 } }];
test("calibration: provider tokens per estimated token from the latest reported request, between 1 and 4; 1 without usage", () => {
	const msgs = run(4, 40_000); // ~40k estimated
	const est = estimateTokens(msgs);
	assert.equal(requestScale(msgs), 1, "no usage yet");
	assert.ok(Math.abs(requestScale(withUsage(msgs, Math.round(est * 1.4))) - 1.4) < 0.01);
	assert.equal(requestScale(withUsage(msgs, Math.round(est * 0.5))), 1, "never scaled down");
	assert.equal(requestScale(withUsage(msgs, est * 10)), 4, "capped");
	assert.ok(Math.abs(requestScale(withUsage(msgs, Math.round((est + 5_000) * 1.3)), 5_000) - 1.3) < 0.01, "the system prompt counts in the base");
});
test("calibration: an undercounted request that looked fine by characters is now shortened to the budget", () => {
	const msgs = run(12, 24_000); // ~72k estimated: under the 80k trigger by characters alone
	const est = estimateTokens(msgs);
	const real = withUsage(msgs, Math.round(est * 1.4)); // the provider counted ~101k for it
	assert.equal(capWorkerContext(msgs, 80_000, 95_000, 0, 1).step, undefined, "uncalibrated: no action");
	const r = capWorkerContext(real, 80_000, 95_000);
	assert.ok(r.scale > 1.39 && r.before > 100_000, "measured in provider tokens");
	assert.ok(r.step && r.after < 95_000, `shortened to fit (${r.step}, ${r.after})`);
});
test("small-older: many mid-size outputs (long test runs) are masked when large-output steps are not enough", () => {
	const mid = run(60, 1_800); // sixty 1,800-character outputs: none reach the 2,000 large-output cutoff
	const r = capWorkerContext(withUsage(mid, Math.round(estimateTokens(mid) * 4)), 80_000, 95_000);
	assert.equal(r.step, "small-older");
	assert.equal(capOutputs(r.messages!).filter((t) => t.startsWith("[older read output")).length, 55, "all but the newest five");
	assert.ok(r.after < 95_000);
});

import { readFileSync } from "node:fs";
import { FLAT_PRICE_MASK_TOKENS, HAIKU_MASK_TOKENS, workerMaskPolicy } from "../handoff-window.ts";
test("mask policy follows the model serving the request: Haiku 5.5 from 90k, flat-priced Anthropic models from 200k, others keep 80k; the env setting wins", () => {
	const haiku = workerMaskPolicy({ provider: "anthropic", id: "claude-haiku-5-5" }, {});
	assert.deepEqual([haiku.from, haiku.budget], [HAIKU_MASK_TOKENS, 95_000], "under the 100k surcharge line");
	for (const id of ["claude-sonnet-5-5", "claude-opus-5-5", "claude-fable-5-1", "claude-mythos-5-1"]) {
		const p = workerMaskPolicy({ provider: "anthropic", id }, {});
		assert.deepEqual([p.from, p.budget], [FLAT_PRICE_MASK_TOKENS, FLAT_PRICE_MASK_TOKENS], id);
	}
	// Fallbacks run as new workers on their own model; a Copilot-served Claude model, Codex models and unknown ones keep the old default.
	for (const model of [{ provider: "github-copilot", id: "claude-sonnet-5-5" }, { provider: "openai-codex", id: "gpt-6-luna" }, { provider: "anthropic", id: "claude-haiku-4-5" }, undefined]) {
		const p = workerMaskPolicy(model, {});
		assert.deepEqual([p.from, p.budget], [80_000, 95_000], JSON.stringify(model));
	}
	const forced = workerMaskPolicy({ provider: "anthropic", id: "claude-sonnet-5-5" }, { [WORKER_MASK_ENV]: "60000" });
	assert.deepEqual([forced.from, forced.budget], [60_000, 95_000], "an explicit setting overrides the model policy");
	assert.equal(workerMaskPolicy({ provider: "anthropic", id: "claude-opus-5-5" }, { [WORKER_MASK_ENV]: "0" }).from, 0, "0 still turns it off");
	assert.equal(workerMaskPolicy({ provider: "anthropic", id: "claude-haiku-5-5" }, { [WORKER_BUDGET_ENV]: "120000" }).budget, 120_000, "the budget setting still applies");
	assert.equal(workerMaskPolicy({ provider: "anthropic", id: "claude-sonnet-5-5" }, { [WORKER_BUDGET_ENV]: "120000" }).budget, FLAT_PRICE_MASK_TOKENS, "never below the trigger");
	const entry = readFileSync(new URL("../safety-guard-entry.ts", import.meta.url), "utf8");
	assert.match(entry, /policy = workerMaskPolicy\(ctx\?\.model\)/, "decided per request from the serving model");
	assert.match(entry, /capWorkerContext\(event\.messages, policy\.from, policy\.budget, base\)/);
});
