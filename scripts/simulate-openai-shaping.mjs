// Offline, deterministic replay of the production shaping functions; no Pi host or model API.
// Run: npm run simulate:openai > docs/simulations/openai-shaping-results.json
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { capWorkerContext, createMainFold, shortenContext, workerMaskPolicy } from '../agent/extensions/subagent/handoff-window.ts';
import { createReadDedupe } from '../agent/extensions/subagent/read-dedupe.ts';
import { createExecutionLedger } from '../agent/extensions/subagent/execution-ledger.ts';
import { capShellOutput } from '../agent/extensions/subagent/output-cap.ts';

// Standard API USD per million tokens, verified 2026-11-07. 30-minute writes replace
// the ordinary input rate for written tokens; they are not an additional input charge.
const models = [
  { id: 'gpt-6.1-sol', input: 2, read: 0.10, write: 2.50 },
  { id: 'gpt-6.1-terra', input: 1, read: 0.05, write: 1.25 },
  { id: 'gpt-6-astra', input: 10, read: 1, write: 12.50 },
  { id: 'gpt-6-luna', input: 0.10, read: 0.01, write: 0.125 },
];
const text = value => [{ type: 'text', text: value }];
const fill = (label, size) => (label + '\n').repeat(Math.ceil(size / (label.length + 1))).slice(0, size);
const hash = value => createHash('sha256').update(value).digest('hex');
// Fixed synthetic system/tool prefix, identical between arms. Not a real model prompt.
const prefix = fill('Fixed system instructions and tool definitions', 48_000);
const scenarios = [
  { name: 'long-worker', calls: 30, kind: 'worker' },
  { name: 'repeated-reads', calls: 30, kind: 'worker' },
  { name: 'ordinary-worker', calls: 30, kind: 'worker' },
  { name: 'main-10-turns', calls: 30, kind: 'main' },
  ...[150, 300, 480].map(requests => ({ name: `main-${requests}`, calls: requests - 1, kind: 'main' })),
];

// Idealized warm cache: every complete message boundary is reusable for the run.
// Match against all earlier prefixes, not just the previous request. No eviction,
// expiry, hidden prompt, network timing, tokenizer or provider lookback simulation.
function meter() {
  const cached = new Set();
  const rows = [];
  return {
    record(messages) {
      let key = '', chars = 0, hit = 0;
      const boundaries = [];
      for (const block of [prefix, ...messages.map(message => JSON.stringify(message))]) {
        chars += block.length;
        key = hash(key + '\0' + block);
        const tokens = Math.ceil(chars / 4);
        if (tokens >= 1024) {
          if (cached.has(key)) hit = tokens;
          boundaries.push(key);
        }
      }
      const tokens = Math.ceil(chars / 4);
      assert.ok(hit <= tokens);
      rows.push({ input: tokens, read: hit, write: tokens - hit });
      boundaries.forEach(key => cached.add(key));
    },
    finish() {
      return { requests: rows.length, input: rows.reduce((n, r) => n + r.input, 0),
        read: rows.reduce((n, r) => n + r.read, 0), write: rows.reduce((n, r) => n + r.write, 0),
        peak: Math.max(...rows.map(r => r.input)), last: rows.at(-1).input, trace: rows };
    },
  };
}

function replay(scenario, shaped, model) {
  const history = [], m = meter(), dedupe = createReadDedupe(), ledger = createExecutionLedger();
  const fold = createMainFold(50_000);
  const policy = workerMaskPolicy({ provider: 'openai', id: model.id }, {});
  let masked = false;
  function request() {
    let view = history;
    if (shaped && scenario.kind === 'main') {
      view = shortenContext(history, 10) ?? history;
      view = fold.apply(history, view, true) ?? view;
    } else if (shaped) {
      const result = capWorkerContext(history, policy.from, policy.budget, prefix.length / 4, 1);
      assert.notEqual(result.step, 'over', 'fixture needs native compaction, which this replay does not model');
      view = result.messages ?? history;
      if (result.messages && !masked) { masked = true; dedupe.reset(); ledger.earlierCopiesGone(); }
    }
    m.record(view);
  }
  for (let i = 0; i <= scenario.calls; i++) {
    if (i === 0 || (scenario.kind === 'main' && i < scenario.calls && i % 3 === 0)) {
      history.push({ role: 'user', content: fill(`Task ${i}: retain requirements and report evidence`, 240), timestamp: i + 1 });
    }
    request();
    if (i === scenario.calls) break;
    let tool, args, body;
    if (scenario.kind === 'main') {
      tool = 'subagent'; args = { task: `task-${i}` };
      body = `STATUS: PASS completed\nNEXT: done\nRISKS: none\nEVIDENCE: /simulation/report-${i}.md\n` + fill(`Evidence ${i}`, 1450);
    } else {
      tool = scenario.name === 'long-worker' && i % 2 ? 'bash' : 'read';
      args = tool === 'bash' ? { command: `npm run check-${i}` } : { path: `/simulation/file-${scenario.name === 'repeated-reads' ? i % 5 : i}.ts` };
      const size = scenario.name === 'long-worker' ? (tool === 'bash' ? 32_000 : 24_000) : scenario.name === 'repeated-reads' ? 12_000 : 1_000;
      body = fill(tool === 'read' ? args.path : args.command, size);
    }
    history.push({ role: 'assistant', content: [...text(fill(`Step ${i}`, 300)), { type: 'toolCall', id: `c${i}`, name: tool, arguments: args }] });
    let content = text(body);
    if (shaped && scenario.kind === 'worker') {
      content = ledger.onResult(tool, args, content, false, '/simulation') ?? content;
      if (!masked) content = dedupe.onResult(tool, args, content, false, '/simulation') ?? content;
      content = capShellOutput(tool, content, {}, 16_000, scratch) ?? content;
      const view = ledger.viewForResult();
      if (view) content = [...content, ...text(view)];
    }
    history.push({ role: 'toolResult', toolName: tool, toolCallId: `c${i}`, content, isError: false });
  }
  return m.finish();
}

// Check cache accounting on known prefixes before measuring fixtures.
const probe = meter();
probe.record([{ role: 'user', content: 'first' }]);
probe.record([{ role: 'user', content: 'first' }]);
probe.record([{ role: 'user', content: 'other' }]);
probe.record([{ role: 'user', content: 'first' }]);
const probeRows = probe.finish().trace;
assert.equal(probeRows[0].read, 0);
assert.equal(probeRows[1].write, 0);
assert.equal(probeRows[2].read, prefix.length / 4);
assert.equal(probeRows[3].write, 0, 'an older matching prefix remains reusable');
for (const row of probeRows) assert.equal(row.read + row.write, row.input);

const scratch = mkdtempSync(join(tmpdir(), 'harness-simulation-'));
// mkdtemp has a fixed-length suffix: only its bytes change, not the request sizes
// or cache matching within a run. Full shell outputs live here and are removed below.
try {
  const results = [];
  for (const model of models) for (const scenario of scenarios) {
    const off = replay(scenario, false, model), on = replay(scenario, true, model);
    assert.equal(off.requests, on.requests);
    const cost = run => run.trace.reduce((sum, row) => sum + (row.read * model.read + row.write * model.write) * (row.input > 272_000 ? 2 : 1) / 1e6, 0);
    const noCacheCost = run => run.trace.reduce((sum, row) => sum + row.input * model.input * (row.input > 272_000 ? 2 : 1) / 1e6, 0);
    results.push({ model: model.id, scenario: scenario.name, off, on,
      tokenSavingPercent: 100 * (1 - on.input / off.input),
      inputCostUSD: { off: cost(off), on: cost(on) },
      inputCostSavingPercent: 100 * (1 - cost(on) / cost(off)),
      noCacheInputCostUSD: { off: noCacheCost(off), on: noCacheCost(on) } });
  }
  for (const result of results) for (const arm of ['off', 'on']) {
    result[arm].over272k = result[arm].trace.filter(row => row.input > 272_000).length;
    if (!process.argv.includes('--trace')) delete result[arm].trace;
  }
  const sourceHashes = Object.fromEntries(['scripts/simulate-openai-shaping.mjs', ...['handoff-window', 'read-dedupe', 'execution-ledger', 'output-cap'].map(name => `agent/extensions/subagent/${name}.ts`)]
    .map(file => [file, hash(readFileSync(new URL('../' + file, import.meta.url)))]));
  console.log(JSON.stringify({ schema: 1, sourceCommit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), sourceHashes,
    pricingDate: '2026-11-07', pricingURL: 'https://developers.openai.com/api/docs/pricing', models, results }, null, 2));
} finally { rmSync(scratch, { recursive: true, force: true }); }
