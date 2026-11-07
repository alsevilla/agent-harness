// Recorded Pi runs: the real Pi CLI drives a scripted stand-in model (simulate-pi-shaping/recorder.mjs) through four scenarios, each
// twice with the same tool calls: with the harness's request shaping and without it. Every request Pi sends is recorded, then priced
// with an Anthropic-style prompt-cache model. Needs an installed Pi; no model, network or credentials.
// Run: NATIVE_PROBE_HOST_MODULES=<node_modules holding @earendil-works/pi-coding-agent> npm run simulate:pi > docs/simulations/pi-shaping-results.json
import { spawn, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(here);
const modules = process.env.NATIVE_PROBE_HOST_MODULES ?? join(execFileSync("npm", ["root", "-g"], { encoding: "utf8" }).trim());
const piCli = join(modules, "@earendil-works", "pi-coding-agent", "dist", "bundle", "cli.js");
const piAi = join(modules, "@earendil-works", "pi-ai", "dist", "index.js");
if (!existsSync(piCli) || !existsSync(piAi)) throw new Error(`No Pi install under ${modules}; set NATIVE_PROBE_HOST_MODULES to the node_modules folder that holds @earendil-works/pi-coding-agent.`);
const piVersion = JSON.parse(readFileSync(join(modules, "@earendil-works", "pi-coding-agent", "package.json"), "utf8")).version;

// Fixtures: each file is one generated line pattern, so the runs need no checked-in sources.
const lines = (n, f) => Array.from({ length: n }, (_, i) => f(i) + "\n").join("");
const call = (name, tag) => (i) => `${name}_${i}(q: &Request) -> Result<Response> { let v = parse(q)?; respond(v) } // ${tag} ${i}`;
function fixture(kind) {
	if (kind === "rep") return { "src/empty.rs": "", "src/tiny.rs": "pub const X: u8 = 1;\n", "src/medium.rs": lines(60, (i) => `pub fn med_${i}() -> u32 { ${i} } // med`), "src/large.rs": lines(500, (i) => `pub fn big_${i}() -> u32 { ${i} } // big`) };
	const repo = { "README.md": "# Fixture\nRun the queue tests.\n" };
	for (let k = 0; k < 10; k++) repo[`src/mod${k}.rs`] = lines(330, call(`pub fn m${k}`, `m${k}`));
	for (const [file, name, n] of [["src/queue.rs", "queue", 160], ["src/sender.rs", "sender", 90], ["src/config.rs", "config", 40], ["tests/queue_test.rs", "test", 70]]) repo[file] = lines(n, call(`fn ${name}`, `${name} line`));
	return repo;
}

// One Pi session in RPC mode: send each prompt, wait for the agent to finish it, return the recorded requests.
async function record(scenario, shaped, work) {
	const run = join(work, `${scenario.name}-${shaped ? "on" : "off"}`);
	const cwd = join(run, "checkout"), agentDir = join(run, "agent"), out = join(run, "requests.jsonl"), script = join(run, "script.json");
	for (const [rel, text] of Object.entries(fixture(scenario.fixture))) { mkdirSync(dirname(join(cwd, rel)), { recursive: true }); writeFileSync(join(cwd, rel), text); }
	execFileSync("git", ["init", "-q", cwd]); // the scripts run git status
	mkdirSync(agentDir, { recursive: true });
	writeFileSync(script, JSON.stringify(scenario.script));
	const extension = scenario.main ? join(repoRoot, "agent/extensions/subagent/index.ts") : join(repoRoot, "agent/extensions/subagent/safety-guard-entry.ts");
	const off = scenario.main ? { PI_SUBAGENT_MAIN_FOLD_TOKENS: "0", PI_SUBAGENT_HANDOFF_WINDOW: "0" } : {};
	// Without shaping, a worker run loads no harness extension; main keeps the subagent extension with both of its shortenings off.
	const extensions = shaped || scenario.main ? ["--extension", extension] : [];
	const env = { ...process.env, ...(shaped ? {} : off), PI_CODING_AGENT_DIR: agentDir, SCRIPT: script, RECORD_OUT: out, PI_AI_MODULE: piAi, NODE_PATH: modules };
	const args = [piCli, "--mode", "rpc", "--no-session", "--no-extensions", "--no-mcp", "--no-skills", "--no-prompt-templates", "--offline", "--provider", "rec", "--model", "rec-model",
		"--extension", join(here, "simulate-pi-shaping", "recorder.mjs"), ...extensions, "--tools", "read,grep,find,ls,bash,edit"];
	const proc = spawn(process.execPath, args, { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
	let stderr = "", waiting, tools = 0, errors = 0;
	proc.stderr.on("data", (d) => { stderr += d; });
	readline.createInterface({ input: proc.stdout }).on("line", (line) => {
		let e; try { e = JSON.parse(line); } catch { return; }
		if (e.type === "tool_execution_end") { tools++; if (e.isError) { errors++; if (process.env.SHOW_ERRORS) process.stderr.write(`tool error: ${JSON.stringify(e.result ?? e).slice(0, 300)}\n`); } }
		if (e.type === "agent_end" && waiting) { const w = waiting; waiting = undefined; w(); }
	});
	const timer = setTimeout(() => { proc.kill(); throw new Error(`${scenario.name}: timed out; stderr: ${stderr.slice(-2000)}`); }, 240_000);
	for (const [i, message] of scenario.prompts.entries()) await new Promise((resolve) => { waiting = resolve; proc.stdin.write(JSON.stringify({ type: "prompt", id: String(i), message }) + "\n"); });
	clearTimeout(timer); proc.kill();
	if (errors) throw new Error(`${scenario.name}: ${errors} tool errors`);
	return { tools, requests: readFileSync(out, "utf8").trim().split("\n").map((l) => JSON.parse(l)) };
}

// Anthropic-style cache model, as Pi places breakpoints: one on the system block, one on the last message. A request reads the longest
// earlier-written prefix ending within 20 blocks of its breakpoint and writes the rest. Sizes are characters / 4.
const tok = (s) => Math.ceil(s.length / 4);
const sha = (s) => createHash("sha256").update(s).digest("hex");
function measure(requests) {
	const systemOf = (c) => { const s = c.systemPrompt ?? c.messages.find((m) => m.role === "system") ?? null; const { timestamp, ...rest } = s && typeof s === "object" ? s : { v: s }; return JSON.stringify({ system: rest, tools: c.tools ?? null }); };
	const systems = new Set(requests.map((c) => sha(systemOf(c))));
	const entries = new Set();
	let read = 0, write = 0, flat = 0, haiku = 0;
	const sizes = requests.map((c) => tok(JSON.stringify(c)));
	requests.forEach((c, n) => {
		const sys = systemOf(c), body = c.messages.filter((m) => m.role !== "system").map((m) => JSON.stringify(m));
		const keys = []; const acc = createHash("sha256").update(sys);
		for (const b of body) { acc.update(b); keys.push(acc.copy().digest("hex")); }
		let hit = -1;
		for (let k = body.length - 1; k >= Math.max(0, body.length - 21); k--) if (entries.has(keys[k])) { hit = k; break; }
		const sysCached = n > 0 && systems.size === 1;
		const r = (sysCached ? tok(sys) : 0) + body.slice(0, hit + 1).reduce((a, b) => a + tok(b), 0);
		const w = (sysCached ? 0 : tok(sys)) + body.slice(hit + 1).reduce((a, b) => a + tok(b), 0);
		read += r; write += w;
		flat += r * 0.1 + w * 1.25; // input-token equivalents: cache read 0.1x, cache write 1.25x
		haiku += (r * 0.1 + w * 1.25) * (sizes[n] > 100_000 ? 5 : 1); // Claude Haiku 5.5 charges 5x for a request over 100k input tokens
		entries.add(keys[keys.length - 1]);
	});
	return { requests: requests.length, systemPromptStable: systems.size === 1, sent: sizes.reduce((a, b) => a + b, 0), peak: Math.max(...sizes), over100k: sizes.filter((s) => s > 100_000).length,
		cacheRead: read, cacheWrite: write, hitPercent: Math.round((100 * read) / (read + write)), cost: Math.round(flat), haikuCost: Math.round(haiku) };
}

const only = process.env.ONLY?.split(",");
const scenarios = [["long", false], ["repetition", false], ["standard", false], ["main", true]].filter(([name]) => !only || only.includes(name)).map(([name, main]) => ({ name, main, ...JSON.parse(readFileSync(join(here, "simulate-pi-shaping", "scenarios", `${name}.json`), "utf8")) }));
const work = mkdtempSync(join(tmpdir(), "harness-pi-simulation-"));
try {
	const results = [];
	for (const scenario of scenarios) {
		const off = await record(scenario, false, work), on = await record(scenario, true, work);
		if (off.tools !== on.tools || off.requests.length !== on.requests.length) throw new Error(`${scenario.name}: the two arms differ in tool calls or requests`);
		const a = measure(off.requests), b = measure(on.requests);
		const saving = (x, y) => Math.round(1000 * (1 - y / x)) / 10;
		results.push({ scenario: scenario.name, toolCalls: on.tools, off: a, on: b, tokenSavingPercent: saving(a.sent, b.sent), costSavingPercent: saving(a.cost, b.cost), haikuCostSavingPercent: saving(a.haikuCost, b.haikuCost) });
		process.stderr.write(`${scenario.name}: tokens ${a.sent} -> ${b.sent} (${saving(a.sent, b.sent)}% fewer), cost ${saving(a.cost, b.cost)}% lower, Haiku 5.5 ${saving(a.haikuCost, b.haikuCost)}% lower, peak ${a.peak} -> ${b.peak}\n`);
	}
	console.log(JSON.stringify({ schema: 1, sourceCommit: execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoRoot, encoding: "utf8" }).trim(), piVersion,
		cacheModel: "Anthropic-style: breakpoints on the system block and the last message, 20-block lookback; read 0.1x, write 1.25x of input; Haiku 5.5 5x above 100k; characters / 4", results }, null, 2));
} finally { rmSync(work, { recursive: true, force: true }); }
