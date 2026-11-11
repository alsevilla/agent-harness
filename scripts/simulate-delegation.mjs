// The harness against a single agent: the same ten-task session done by one model in plain Pi (one context, no shaping) and by the
// harness (main delegates to role workers, each in its own context, with the production shaping in every context). Models come from
// agent/roles.json (OpenAI uses fallbackModel with --openai); prices are first-party API list prices. What a scripted run cannot know (extra calls a worker needs to orient,
// extra calls on the economy model) are settings, swept to find where delegation stops paying. Offline; no Pi host, model or network.
// Run: npm run --silent simulate:delegation > docs/simulations/delegation-results.json
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerHandoffWindow, capWorkerContext, workerMaskPolicy } from "../agent/extensions/subagent/handoff-window.ts";
import { createReadDedupe } from "../agent/extensions/subagent/read-dedupe.ts";
import { createExecutionLedger } from "../agent/extensions/subagent/execution-ledger.ts";
import { capShellOutput } from "../agent/extensions/subagent/output-cap.ts";

// USD per million tokens, Anthropic first-party list prices (Claude API reference, 2026-10). Cache writes (5-minute) are 1.25x input.
// Haiku 5.5's cache-read price is not listed there: 0.1x input is assumed. Haiku 5.5 charges 5x above 100k input tokens.
const OPENAI = process.argv.includes("--openai");
const PROVIDER = OPENAI ? "openai" : "anthropic";
// Standard API rates verified 2026-11-08; long requests multiply input/cache by 2 and output by 1.5.
const PRICES = OPENAI ? {
	"gpt-6-astra": { input: 10, output: 50, read: 1, longFrom: 272_000, longX: 2, longOutputX: 1.5 },
	"gpt-6.1-sol": { input: 2, output: 10, read: 0.1, longFrom: 272_000, longX: 2, longOutputX: 1.5 },
	"gpt-6.1-terra": { input: 1, output: 5, read: 0.05, longFrom: 272_000, longX: 2, longOutputX: 1.5 },
	"gpt-6-luna": { input: 0.1, output: 0.5, read: 0.01, longFrom: 272_000, longX: 2, longOutputX: 1.5 },
} : {
	"claude-fable-5-1": { input: 10, output: 50, read: 0.25 },
	"claude-opus-5-5": { input: 4, output: 20, read: 0.2 },
	"claude-sonnet-5-5": { input: 2, output: 10, read: 0.2 },
	"claude-haiku-5-5": { input: 0.1, output: 0.5, read: 0.01, longFrom: 100_000, longX: 5 },
};
const WRITE_X = 1.25, CHARS_PER_TOKEN = 4, CACHE_LOOKBACK_BLOCKS = 20;
const CACHE_MIN_TOKENS = 1_024;
const MAIN_MODELS = Object.keys(PRICES);
const ORIENT_DEFAULT = 1, ECONOMY_X_DEFAULT = 1;
const MAIN_FOLD_TOKENS = 50_000, HANDOFF_WINDOW = 10, SHELL_OUTPUT_CHARS = 16_000;
const PACKET_CHARS = 1_500, HANDOFF_FINDINGS_CHARS = 1_200;
const ORIENT_SWEEP = [0, 1, 2, 4, 6, 8, 12], ECONOMY_X_SWEEP = [1, 1.5, 2, 3];

// Measured prompt sizes in characters: Pi's own system prompt (recorded runs), main's with the subagent extension (recorded) plus
// agent/AGENTS.md, and each role's assembled child prompt (scripts/measure-child-prompt.mjs), on top of Pi's. Tool definitions are not in
// the recordings: TOOL_SCHEMA_CHARS is assumed for every context, plus SUBAGENT_SCHEMA_CHARS for main's subagent tools.
const PI_SYSTEM = 7_271, MAIN_SYSTEM = 14_084 + readFileSync(new URL("../agent/AGENTS.md", import.meta.url), "utf8").length;
const CHILD_PROMPT = { "backend-worker": 18_809, debugger: 15_674, planner: 14_298, "test-engineer": 17_463 };
const TOOL_SCHEMA_CHARS = 6_000, SUBAGENT_SCHEMA_CHARS = 4_000;
// Per model call: assistant text kept in the history, and output tokens billed (text plus thinking, the same in every arm).
const SAY_CHARS = 300, OUTPUT_PER_CALL = 350, PACKET_OUTPUT = 900, REPORT_OUTPUT = 500, REPLY_OUTPUT = 300;

const roles = Object.fromEntries(JSON.parse(readFileSync(new URL("../agent/roles.json", import.meta.url), "utf8")).map((r) => [r.name, r]));
const roleModel = (name, modelTier = roles[name].defaultModelTier) => { const r = roles[name]; const tier = r.modelTiers[modelTier]; return (OPENAI ? tier.fallbackModel : tier.model).split("/").at(-1); };

const fill = (tag, n) => { let s = ""; let i = 0; while (s.length < n) s += `${tag} ${i++}: the scheduler drains the queue at a fixed pace and records each send.\n`; return s.slice(0, n); };
const tok = (s) => Math.ceil(s.length / CHARS_PER_TOKEN);

// Ten tasks: four small fixes, three bug hunts, three features, in one user session. Each step is a tool call with the size of its
// result; `phase` marks who does it under the harness. Two tasks need a second fix round after the user reports a failure.
const fileSize = (i) => 4_000 + ((i * 7919) % 21) * 1_000; // 4k-24k, deterministic
const read = (i, phase) => ({ tool: "read", arg: `src/f${i}.rs`, size: fileSize(i), phase });
const test = (size, phase) => ({ tool: "bash", arg: "cargo test", size, phase });
const grep = (phase) => ({ tool: "grep", arg: "queue", size: 2_000, phase });
const edit = (i, phase) => ({ tool: "edit", arg: `src/f${i}.rs`, size: 200, phase });
function task(kind, n) {
	const f = (k) => (n * 5 + k) % 40;
	if (kind === "fix") return { kind, steps: [read(f(0), "work"), read(f(1), "work"), grep("work"), edit(f(0), "work"), edit(f(1), "work"), test(4_000, "work"), test(4_000, "work")] };
	if (kind === "bug") return { kind, steps: [
		...Array.from({ length: 10 }, (_, k) => read(f(k), "diagnose")), grep("diagnose"), grep("diagnose"), grep("diagnose"), test(8_000, "diagnose"), test(8_000, "diagnose"), read(f(0), "diagnose"), read(f(1), "diagnose"),
		edit(f(0), "work"), edit(f(1), "work"), test(8_000, "work"), test(8_000, "work")] };
	return { kind, steps: [
		...Array.from({ length: 4 }, (_, k) => read(f(k + 10), "plan")),
		...Array.from({ length: 10 }, (_, k) => read(f(k), "work")), grep("work"), grep("work"), ...Array.from({ length: 8 }, (_, k) => edit(f(k), "work")), ...Array.from({ length: 4 }, () => test(6_000, "work")),
		read(f(0), "verify"), read(f(1), "verify"), read(f(2), "verify"), test(6_000, "verify"), test(6_000, "verify"), test(6_000, "verify")] };
}
const KINDS = ["fix", "bug", "feature", "fix", "bug", "feature", "fix", "bug", "feature", "fix"];
// Explicit fixture labels, not inferred model capability: only the three multi-file feature implementations are complex. Main picks
// each implementation's tier from them at plan time (economy for the rest), for both providers.
const IMPLEMENTATION_COMPLEXITY = ["non-complex", "non-complex", "complex", "non-complex", "non-complex", "complex", "non-complex", "non-complex", "complex", "non-complex"];
const RETRY_COMPLEXITY = "non-complex"; // each scripted retry is two edits and one test, including the feature retry
const implementationTier = (complexity) => complexity === "complex" ? "capable" : "economy";
const FIX_ROUND = new Set([2, 6]); // the third and seventh tasks fail once
const fixRound = (n) => [edit((n * 5) % 40, "work"), edit((n * 5 + 1) % 40, "work"), test(6_000, "work")];

// One context's request stream, priced under Anthropic-style caching: one breakpoint on the system block, one on the last message; a
// request reads the longest earlier-written prefix ending within 20 blocks of its breakpoint and writes the rest.
// OpenAI instead uses idealized warm complete-message prefixes, as in simulate-openai-shaping.mjs; no cache expiry or eviction.
function meter(model, systemChars) {
	const price = PRICES[model], entries = new Set(), system = tok("x".repeat(systemChars));
	let cost = 0, sent = 0, peak = 0, requests = 0, sysCached = false;
	return {
		request(messages, output) {
			const sizes = messages.map((m) => tok(JSON.stringify(m)));
			const keys = []; const h = createHash("sha256");
			for (const m of messages) { h.update(JSON.stringify(m)); keys.push(h.copy().digest("hex")); }
			let hit = -1;
			for (let k = messages.length - 1; k >= Math.max(0, OPENAI ? 0 : messages.length - 1 - CACHE_LOOKBACK_BLOCKS); k--) if (entries.has(keys[k])) { hit = k; break; }
			const read = (sysCached ? system : 0) + sizes.slice(0, hit + 1).reduce((a, b) => a + b, 0);
			const write = (sysCached ? 0 : system) + sizes.slice(hit + 1).reduce((a, b) => a + b, 0);
			const size = read + write, x = price.longFrom && size > price.longFrom ? price.longX : 1;
			const outputX = x === 1 ? 1 : (price.longOutputX ?? x);
			cost += ((read * price.read + write * price.input * WRITE_X) * x + output * price.output * outputX) / 1e6;
			sent += size; peak = Math.max(peak, size); requests++; sysCached = true;
			if (OPENAI) {
				let prefix = system;
				keys.forEach((key, i) => { prefix += sizes[i]; if (prefix >= CACHE_MIN_TOKENS) entries.add(key); });
			} else entries.add(keys[keys.length - 1]);
		},
		get totals() { return { model, requests, sent, peak, cost }; },
	};
}

// Known-prefix accounting check, including OpenAI long-request output pricing.
if (OPENAI) {
	for (const model of MAIN_MODELS) for (const systemChars of [8_000, 1_100_000]) {
		const m = meter(model, systemChars), messages = [{ role: "user", content: "cache probe" }];
		const size = tok("x".repeat(systemChars)) + tok(JSON.stringify(messages[0]));
		m.request(messages, OUTPUT_PER_CALL); m.request(messages, OUTPUT_PER_CALL);
		const p = PRICES[model], long = size > p.longFrom;
		const expected = (size * (p.input * WRITE_X + p.read) * (long ? p.longX : 1)
			+ 2 * OUTPUT_PER_CALL * p.output * (long ? p.longOutputX : 1)) / 1e6;
		assert.ok(Math.abs(m.totals.cost - expected) < 1e-10);
	}
}

let scratch;
// A worker: a fresh context on its role's model with the production shaping (ledger, duplicate-read notes, shell-output cap, masking).
function runWorker(role, model, packet, steps, totals) {
	const m = meter(model, PI_SYSTEM + CHILD_PROMPT[role] + TOOL_SCHEMA_CHARS);
	const history = [{ role: "user", content: [{ type: "text", text: packet }], timestamp: 1 }];
	const ledger = createExecutionLedger(), dedupe = createReadDedupe(), policy = workerMaskPolicy({ provider: PROVIDER, id: model }, {});
	ledger.noteTask?.(packet);
	let masked = false;
	const request = (output) => {
		const r = capWorkerContext(history, policy.from, policy.budget, tok("x".repeat(PI_SYSTEM + CHILD_PROMPT[role] + TOOL_SCHEMA_CHARS)), 1);
		assert.notEqual(r.step, "over", "fixture requires native compaction, which is not modelled");
		if (r.messages && !masked) { masked = true; dedupe.reset(); ledger.earlierCopiesGone(); }
		m.request(r.messages ?? history, output);
	};
	steps.forEach((s, i) => {
		request(OUTPUT_PER_CALL);
		const args = s.tool === "read" || s.tool === "edit" ? { path: s.arg } : s.tool === "grep" ? { pattern: s.arg } : { command: s.arg };
		history.push({ role: "assistant", content: [{ type: "text", text: fill(`step ${i}`, SAY_CHARS) }, { type: "toolCall", id: `w${i}`, name: s.tool, arguments: args }] });
		let content = [{ type: "text", text: fill(`${s.tool} ${s.arg}`, s.size) }];
		content = ledger.onResult(s.tool, args, content, false, "/w") ?? content;
		if (!masked) content = dedupe.onResult(s.tool, args, content, false, "/w") ?? content;
		content = capShellOutput(s.tool, content, {}, SHELL_OUTPUT_CHARS, scratch) ?? content;
		const view = ledger.viewForResult();
		if (view) content = [...content, { type: "text", text: view }];
		history.push({ role: "toolResult", toolName: s.tool, toolCallId: `w${i}`, content, isError: false });
	});
	request(REPORT_OUTPUT); // writes its REPORT and replies with the four handoff lines
	totals.push(m.totals);
	return `STATUS: PASS - ${role} done\nNEXT: none\nRISKS: none\nEVIDENCE: _evidence/task/REPORT.md\n${fill(`${role} findings`, HANDOFF_FINDINGS_CHARS)}`;
}

// The single agent: one context, plain Pi, every tool output kept. fresh: a new session (context) for each task.
function single(model, fresh) {
	const contexts = [];
	let m, history, n = 0, t = 0;
	const start = () => { if (m) contexts.push(m.totals); m = meter(model, PI_SYSTEM + TOOL_SCHEMA_CHARS); history = []; };
	start();
	KINDS.forEach((kind, k) => {
		if (fresh && k) start();
		const steps = [...task(kind, k).steps, ...(FIX_ROUND.has(k) ? [{ user: true }, ...fixRound(k)] : [])];
		history.push({ role: "user", content: `Task ${k}: ${fill(`ask ${k}`, 600)}`, timestamp: ++t });
		for (const s of steps) {
			if (s.user) { m.request(history, REPLY_OUTPUT); history.push({ role: "assistant", content: [{ type: "text", text: fill(`reply ${k}`, 600) }] }, { role: "user", content: `The check still fails: ${fill(`fail ${k}`, 400)}`, timestamp: ++t }); continue; }
			m.request(history, OUTPUT_PER_CALL);
			history.push({ role: "assistant", content: [{ type: "text", text: fill(`step ${n}`, SAY_CHARS) }, { type: "toolCall", id: `s${n}`, name: s.tool, arguments: { arg: s.arg } }] });
			history.push({ role: "toolResult", toolName: s.tool, toolCallId: `s${n}`, content: [{ type: "text", text: fill(`${s.tool} ${s.arg}`, s.size) }], timestamp: ++t });
			n++;
		}
		m.request(history, REPLY_OUTPUT);
		history.push({ role: "assistant", content: [{ type: "text", text: fill(`reply ${k}`, 600) }] });
	});
	contexts.push(m.totals);
	return contexts;
}

// The harness: main on mainModel delegates each phase to a role (debugger, planner, backend-worker, test-engineer) through the production
// main hook (older-result shortening and checkpoint folding). orient: extra reads each worker launch needs; economyX: call multiplier on
// economy-tier roles. sameModel: every role on main's model, which separates the context effect from the model mix.
function harness(mainModel, { orient = ORIENT_DEFAULT, economyX = ECONOMY_X_DEFAULT, sameModel = false } = {}) {
	const workers = [], mainM = meter(mainModel, MAIN_SYSTEM + TOOL_SCHEMA_CHARS + SUBAGENT_SCHEMA_CHARS);
	let hook;
	registerHandoffWindow({ on: (_, fn) => { hook = fn; } }, { PI_SUBAGENT_HANDOFF_WINDOW: String(HANDOFF_WINDOW), PI_SUBAGENT_MAIN_FOLD_TOKENS: String(MAIN_FOLD_TOKENS) }, () => undefined);
	const history = []; let t = 0, id = 0;
	const mainRequest = (output) => { const view = hook({ messages: history })?.messages ?? history; mainM.request(view, output); };
	const delegate = (role, steps, k, complexity = IMPLEMENTATION_COMPLEXITY[k]) => {
		mainRequest(PACKET_OUTPUT);
		const packet = `Task ${k} for ${role}: ${fill(`packet ${k} ${role}`, PACKET_CHARS)}\nChecks:\n- \`cargo test\``;
		const callId = `m${id++}`;
		history.push({ role: "assistant", content: [{ type: "text", text: fill(`plan ${k}`, SAY_CHARS) }, { type: "toolCall", id: callId, name: "subagent", arguments: { agent: role, task: packet } }] });
		// Plan-time tiers (references/routing.md, "Explicit Pi model tier"): main sets economy for a bounded, known-contract
		// implementation and leaves complex work on capable; other roles run their defaults. The same rule for both providers.
		const tier = role === "backend-worker" ? implementationTier(complexity) : roles[role].defaultModelTier;
		const model = sameModel ? mainModel : roleModel(role, tier);
		const economy = !sameModel && tier === "economy";
		// economyX: the economy model needs this many times the reads, searches and checks (each extra one a new, distinct output).
		const looks = steps.filter((s) => s.tool !== "edit");
		const extra = economy && economyX > 1 ? Array.from({ length: Math.round(looks.length * (economyX - 1)) }, (_, i) => ({ ...looks[i % looks.length], arg: `${looks[i % looks.length].arg}#again${i}` })) : [];
		const orientReads = Array.from({ length: orient }, (_, i) => read((k * 5 + 20 + i) % 40, "orient"));
		const handoff = runWorker(role, model, packet, [...orientReads, ...steps, ...extra], workers);
		history.push({ role: "toolResult", toolName: "subagent", toolCallId: callId, content: [{ type: "text", text: handoff }], details: { results: [{ agent: role }] }, timestamp: ++t });
	};
	KINDS.forEach((kind, k) => {
		history.push({ role: "user", content: `Task ${k}: ${fill(`ask ${k}`, 600)}`, timestamp: ++t });
		const steps = task(kind, k).steps;
		// Gather: main reads at most two named files itself before writing the packet (AGENTS.md allows three).
		for (const s of steps.filter((s) => s.tool === "read").slice(0, 2)) {
			mainRequest(OUTPUT_PER_CALL);
			const callId = `m${id++}`;
			history.push({ role: "assistant", content: [{ type: "text", text: fill(`look ${k}`, SAY_CHARS) }, { type: "toolCall", id: callId, name: "read", arguments: { path: s.arg } }] });
			history.push({ role: "toolResult", toolName: "read", toolCallId: callId, content: [{ type: "text", text: fill(`read ${s.arg}`, s.size) }], timestamp: ++t });
		}
		const phase = (p) => steps.filter((s) => s.phase === p);
		if (kind === "bug") { delegate("debugger", phase("diagnose"), k); delegate("backend-worker", phase("work"), k); }
		else if (kind === "feature") { delegate("planner", phase("plan"), k); delegate("backend-worker", phase("work"), k); delegate("test-engineer", phase("verify"), k); }
		else delegate("backend-worker", phase("work"), k);
		mainRequest(REPLY_OUTPUT);
		history.push({ role: "assistant", content: [{ type: "text", text: fill(`reply ${k}`, 600) }] });
		if (FIX_ROUND.has(k)) {
			history.push({ role: "user", content: `The check still fails: ${fill(`fail ${k}`, 400)}`, timestamp: ++t });
			delegate("backend-worker", fixRound(k), k, RETRY_COMPLEXITY);
			mainRequest(REPLY_OUTPUT);
			history.push({ role: "assistant", content: [{ type: "text", text: fill(`reply ${k} again`, 600) }] });
		}
	});
	if (!sameModel) {
		const capable = roleModel("backend-worker", "capable");
		assert.equal(workers.filter((w) => w.model === capable).length, 3, "only the three complex feature implementations run on capable");
		assert.equal(workers.length, 21, "21 worker launches");
	}
	return [mainM.totals, ...workers];
}

const sum = (contexts) => ({ contexts: contexts.length, requests: contexts.reduce((a, c) => a + c.requests, 0), sent: contexts.reduce((a, c) => a + c.sent, 0), peak: Math.max(...contexts.map((c) => c.peak)), cost: Math.round(contexts.reduce((a, c) => a + c.cost, 0) * 1e4) / 1e4,
	byModel: Object.fromEntries(Object.keys(PRICES).map((m) => [m, Math.round(contexts.filter((c) => c.model === m).reduce((a, c) => a + c.cost, 0) * 1e4) / 1e4]).filter(([, v]) => v)) });
scratch = mkdtempSync(join(tmpdir(), "harness-delegation-"));
try {
	const baselines = {}, rows = [];
	for (const model of MAIN_MODELS) {
		const one = sum(single(model, false)), fresh = sum(single(model, true));
		const same = sum(harness(model, { sameModel: true })), mixed = sum(harness(model));
		baselines[model] = { singleOneSession: one, singleFreshPerTask: fresh, harnessSameModel: same, harnessRoleModels: mixed };
		const pct = (a, b) => Math.round(1000 * (1 - b / a)) / 10;
		process.stderr.write(`${model}: single one session $${one.cost} (${one.sent} tokens) | fresh per task $${fresh.cost} | harness same model $${same.cost} (${same.sent}) | harness role models $${mixed.cost} (${mixed.sent}): ${Math.abs(pct(fresh.cost, mixed.cost))}% ${mixed.cost <= fresh.cost ? "below" : "above"} fresh single\n`);
		// Break-even sweeps against the cheaper single-agent baseline (a fresh session per task).
		for (const orient of ORIENT_SWEEP) rows.push({ main: model, sweep: "orient", value: orient, cost: sum(harness(model, { orient })).cost, singleFresh: fresh.cost });
		for (const economyX of ECONOMY_X_SWEEP) rows.push({ main: model, sweep: "economyX", value: economyX, cost: sum(harness(model, { economyX })).cost, singleFresh: fresh.cost });
	}
	console.log(JSON.stringify({ schema: 1, provider: PROVIDER, cacheModel: OPENAI ? "idealized warm complete-message prefixes; no expiry or cross-context reuse" : "system and last-message breakpoints; 20-block lookback",
		...(OPENAI ? { pricingDate: "2026-11-08", pricingURL: "https://developers.openai.com/api/docs/pricing" } : {}), sourceCommit: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(), roleDefaults: Object.fromEntries(["backend-worker", "debugger", "planner", "test-engineer"].map((r) => [r, roleModel(r)])),
		...({ implementationRouting: KINDS.map((kind, k) => ({ task: k + 1, kind, complexity: IMPLEMENTATION_COMPLEXITY[k], model: roleModel("backend-worker", implementationTier(IMPLEMENTATION_COMPLEXITY[k])),
			...(FIX_ROUND.has(k) ? { retryComplexity: RETRY_COMPLEXITY, retryModel: roleModel("backend-worker", implementationTier(RETRY_COMPLEXITY)) } : {}) })) }),
		prices: PRICES, assumptions: { IMPLEMENTATION_COMPLEXITY, RETRY_COMPLEXITY, CACHE_MIN_TOKENS, CHARS_PER_TOKEN, WRITE_X, CACHE_LOOKBACK_BLOCKS, PI_SYSTEM, MAIN_SYSTEM, CHILD_PROMPT, MAIN_FOLD_TOKENS, HANDOFF_WINDOW, SHELL_OUTPUT_CHARS, PACKET_CHARS, HANDOFF_FINDINGS_CHARS, ORIENT_SWEEP, ECONOMY_X_SWEEP, TOOL_SCHEMA_CHARS, SUBAGENT_SCHEMA_CHARS, SAY_CHARS, OUTPUT_PER_CALL, PACKET_OUTPUT, REPORT_OUTPUT, REPLY_OUTPUT, orientDefault: ORIENT_DEFAULT, economyXDefault: ECONOMY_X_DEFAULT }, baselines, sweeps: rows }, null, 2));
} finally { rmSync(scratch, { recursive: true, force: true }); }
