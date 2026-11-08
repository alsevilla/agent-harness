// Long main sessions: a seeded synthetic session of 150, 300 and 480 requests (user messages, subagent PASS results with long reports,
// main's own reads and shell output) priced three ways: no shaping, older-result shortening alone, and the full main shaping
// (shortening in batches of ten plus checkpoint folding at 50k) through the production context hook. Same Anthropic-style cache model as
// simulate-pi-shaping.mjs, at Opus 5.5 cache prices (read 0.05x, write 1.25x of input). Offline; no Pi host, model or network.
// Run: npm run simulate:main > docs/simulations/main-sessions-results.json
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { registerHandoffWindow, shortenContext } from "../agent/extensions/subagent/handoff-window.ts";

const SYSTEM = 14_000; // tokens of system prompt and tool definitions, fixed for the session
const READ = 0.05, WRITE = 1.25;
const PASTE_SHARE = Number(process.env.PASTE_SHARE ?? 0); // share of user messages that are 3-6k-character pastes
const tok = (s) => Math.ceil(s.length / 4);
const text = (m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content));
const fill = (n, tag) => { let s = "", i = 0; while (s.length < n) s += `${tag} ${i++}: the scheduler drains the queue at a fixed pace and records each send. `; return s.slice(0, n); };

function session(turns) {
	let seed = 11; const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
	const msgs = [{ role: "user", content: fill(800, "ask") }];
	let id = 0;
	for (let t = 0; t < turns; t++) {
		const r = rnd();
		if (r < 0.12) { const paste = rnd() < PASTE_SHARE; msgs.push({ role: "user", content: fill(paste ? 3000 + rnd() * 3000 : 300 + rnd() * 900, `u${t}`) }); continue; }
		const callId = `c${id++}`;
		if (r < 0.45) { // a subagent result: PASS with a long report body
			msgs.push({ role: "assistant", content: [{ type: "text", text: fill(400, `plan${t}`) }, { type: "toolCall", id: callId, name: "subagent", arguments: { agent: "backend-worker", task: fill(1200, `packet${t}`) } }] });
			const body = `STATUS: PASS - done ${t}\nNEXT: none\nRISKS: none\nEVIDENCE: _evidence/run${t}.md\n${fill(2500 + rnd() * 6000, `report${t}`)}`;
			msgs.push({ role: "toolResult", toolName: "subagent", toolCallId: callId, content: [{ type: "text", text: body }], details: { results: [{ agent: "backend-worker" }] } });
		} else { // main's own read or shell output
			const tool = r < 0.75 ? "read" : "bash";
			msgs.push({ role: "assistant", content: [{ type: "text", text: fill(250, `look${t}`) }, { type: "toolCall", id: callId, name: tool, arguments: tool === "read" ? { path: `src/f${t}.rs` } : { command: "git log --oneline -20" } }] });
			msgs.push({ role: "toolResult", toolName: tool, toolCallId: callId, content: [{ type: "text", text: fill(500 + rnd() * 7000, `out${t}`) }] });
		}
	}
	return msgs.map((m, i) => ({ ...m, timestamp: i + 1 }));
}

// arm: "none" (no shaping), "shorten" (older results shortened in batches of ten, no fold), "full" (the production hook: both).
function run(requests, arm) {
	const full = session(requests - 1); // the first request is the opening user message; each step adds one more
	let hook;
	if (arm === "full") registerHandoffWindow({ on: (_, fn) => { hook = fn; } }, { PI_SUBAGENT_HANDOFF_WINDOW: "10", PI_SUBAGENT_MAIN_FOLD_TOKENS: "50000" }, () => undefined);
	const entries = new Set();
	let cost = 0, read = 0, write = 0, last = 0, sysCached = false;
	const cut = []; full.forEach((m, i) => { if (m.role !== "assistant") cut.push(i + 1); }); // request k sees the history up to its k-th step
	for (const end of cut) {
		const history = full.slice(0, end);
		const msgs = arm === "full" ? (hook({ messages: history })?.messages ?? history) : arm === "shorten" ? (shortenContext(history, 10) ?? history) : history;
		const sizes = msgs.map((m) => tok(text(m)) + 8);
		const keys = []; const h = createHash("sha256");
		for (const m of msgs) { h.update(text(m)); keys.push(h.copy().digest("hex")); }
		let hit = -1;
		for (let k = msgs.length - 1; k >= Math.max(0, msgs.length - 21); k--) if (entries.has(keys[k])) { hit = k; break; }
		const rd = (sysCached ? SYSTEM : 0) + sizes.slice(0, hit + 1).reduce((a, b) => a + b, 0);
		const wr = (sysCached ? 0 : SYSTEM) + sizes.slice(hit + 1).reduce((a, b) => a + b, 0);
		read += rd; write += wr; cost += rd * READ + wr * WRITE; sysCached = true;
		entries.add(keys[keys.length - 1]);
		last = SYSTEM + sizes.reduce((a, b) => a + b, 0);
	}
	return { requests: cut.length, input: read + write, cacheRead: read, cacheWrite: write, cost: Math.round(cost), lastRequest: last };
}

const saving = (x, y) => Math.round(1000 * (1 - y / x)) / 10;
const results = [150, 300, 480].map((turns) => {
	const none = run(turns, "none"), shorten = run(turns, "shorten"), full = run(turns, "full");
	process.stderr.write(`${full.requests} requests: tokens ${saving(none.input, full.input)}% fewer, cost ${saving(none.cost, full.cost)}% lower, last request ${none.lastRequest} -> ${full.lastRequest}\n`);
	return { requests: full.requests, none, shorten, full, tokenSavingPercent: saving(none.input, full.input), costSavingPercent: saving(none.cost, full.cost) };
});
console.log(JSON.stringify({ schema: 1, sourceCommit: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
	cacheModel: "Anthropic-style: 20-block lookback; Opus 5.5 cache read 0.05x, write 1.25x of input; characters / 4", results }, null, 2));
