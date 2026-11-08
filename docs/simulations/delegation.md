# The harness against a single agent

The README's [harness against a single agent](../../README.md#the-harness-against-a-single-agent) table. Results: [`delegation-results.json`](delegation-results.json), with the commit it ran on.

```sh
npm run --silent simulate:delegation > docs/simulations/delegation-results.json
```

Offline, no Pi host, model or network; about ten seconds. [`scripts/simulate-delegation.mjs`](../../scripts/simulate-delegation.mjs) runs the same ten-task session four ways and prices every request.

## The session

Ten tasks in one user session: four small fixes (2 reads, a search, 2 edits, 2 test runs), three bug hunts (12 reads, 3 searches and 2 test runs to diagnose, then 2 edits and 2 test runs), and three features (4 reads to plan, 10 reads, 2 searches, 8 edits and 4 test runs to build, then 3 reads and 3 test runs to verify). Files are 4-24k characters. Two tasks fail once and need a second fix round (2 edits and a test run) after the user reports it.

## The four ways

- **Single agent, one session:** one model in plain Pi does everything in one context, with every tool output kept. No native compaction triggers at these sizes on a 1M-context model.
- **Single agent, fresh session per task:** the same, with a new session for each task (the second fix round stays in its task's session). The fairer baseline: it is how a careful user runs one agent.
- **Harness, every role on main's model:** main reads at most two named files, writes a packet and delegates each phase to a role in its own context: a fix to `backend-worker`; a bug hunt to `debugger` then `backend-worker`; a feature to `planner`, `backend-worker`, then `test-engineer`; a second fix round to a new `backend-worker`. Main's requests go through the production main hook (older-result shortening and checkpoint folding at 50k); each worker's through the production worker shaping (execution ledger, duplicate-read notes, shell-output cap, threshold masking). Each worker also reads `orient` extra files to get its bearings, writes a report and hands main a four-line result with 1.2k characters of findings.
- **Harness, roles on their own models:** the same, with main choosing each implementation's tier at plan time, as [`routing.md`](../../agent/skills/engineering-harness/references/routing.md) ("Explicit Pi model tier") says: economy for a bounded, known-contract implementation, capable otherwise. The fixture labels the three multi-file feature implementations complex (capable) and the four small fixes, three bug-hunt fixes and both retries non-complex (economy); `debugger`, `planner` and `test-engineer` run their economy defaults. With Anthropic models that is 3 workers on Claude Sonnet 5.5 and 18 on Claude Haiku 5.5. Main stays on the baseline's model. The labels are fixture assumptions, recorded per task in the results; no role setting changes.

The two harness rows separate the two effects: separate contexts alone (same model), then the model mix on top.

## Sizes and prices

- System prompts, measured: Pi's own 7.3k characters (recorded runs); main's 14.1k with the subagent extension (recorded) plus `agent/AGENTS.md`; each role's assembled child prompt (14.3-18.8k, from `scripts/measure-child-prompt.mjs`) on top of Pi's. Tool definitions are not in the recordings: 6k characters are assumed for every context, plus 4k for main's subagent tools.
- Per model call: 300 characters of assistant text kept in the history and 350 output tokens billed (text and thinking, the same in every arm); 900 output tokens for main's packet, 500 for a worker's report, 300 for a reply to the user.
- Prices, USD per million tokens (Anthropic first-party list prices): Claude Opus 5.5 $4 input, $20 output, $0.20 cache read; Claude Sonnet 5.5 $2, $10, $0.20; Claude Haiku 5.5 $0.10, $0.50 and 5x above 100k input tokens. Cache writes (5-minute) are 1.25x input. Haiku's cache-read price is not listed: 0.1x input is assumed.
- Cache model: one breakpoint on the system block and one on the last message; a request reads the longest earlier-written prefix ending within 20 blocks of its breakpoint and writes the rest. Each context, and each model, has its own cache. Sizes are characters / 4.

## What a scripted run cannot know

Two behaviours are settings, swept against the fresh-session single agent:

- `orient`: extra files each worker launch reads to get its bearings, which the single agent already has in context (default 1). It decides whether delegation pays.
- `economyX`: how many times the reads, searches and checks every economy-tier worker needs, implementation included (default 1). It moves the cost little, because those workers are cheap.

Not modelled at all: whether a worker or a single agent finishes the task correctly (an economy-tier worker on a simple fix included), how a single agent's long context affects its mistakes, and main re-checking a result (the policy says accept on evidence, not by re-reading). The second fix round is the same in both arms. These are estimates of the token mechanics, not a measurement of cost per completed task: that needs the paid [benchmark procedure](../../agent/skills/engineering-harness/references/token-efficiency.md#benchmark-procedure-only-when-authorized-paid-runs-are-not-part-of-this-repository).

## OpenAI comparison

Run the same fixture and four configurations with Astra, Sol, Terra and Luna as main:

```sh
npm run --silent simulate:delegation:openai > docs/simulations/openai-delegation-results.json
```

This invokes the same script with `--openai`, including both sweeps. Results: [`openai-delegation-results.json`](openai-delegation-results.json). The routing is the same as above; each tier's OpenAI model is its `fallbackModel` in `agent/roles.json`: economy is GPT-6 Luna and capable GPT-6.1 Sol, so each mixed-model run launches 18 Luna workers and 3 Sol workers.

The ten tasks, prompt sizes, outputs, retries and shaping functions are shared with the Claude run. Worker masking selects the production OpenAI policy. Pi prompt sizes are retained as controlled fixture assumptions, not measured Codex prompts. This estimates Pi harness requests at OpenAI API rates; it does not simulate Codex or Copilot request construction or subscription billing.

[Standard API prices](https://developers.openai.com/api/docs/pricing), checked 2026-11-08, in USD per million tokens:

| Model | Input | Output | Cache read | 30-minute write |
| --- | ---: | ---: | ---: | ---: |
| GPT-6 Astra | 10 | 50 | 1 | 12.50 |
| GPT-6.1 Sol | 2 | 10 | 0.10 | 2.50 |
| GPT-6.1 Terra | 1 | 5 | 0.05 | 1.25 |
| GPT-6 Luna | 0.10 | 0.50 | 0.01 | 0.125 |

Above 272k input tokens, input/cache rates are multiplied by 2 and output by 1.5 for the full request. Output costs include the fixed thinking/output allowance already described above. Tool execution fees are excluded.

OpenAI uses the same idealized warm-cache assumption as the OpenAI shaping replay: every complete message prefix of at least 1,024 estimated tokens can be reused, with independent caches per context/model. No expiry, eviction, cross-context reuse, tokenizer-specific boundaries or routing misses are modelled. This is not the Claude 20-block cache model. See [OpenAI cache documentation](https://developers.openai.com/api/docs/guides/prompt-caching). Prices, prompt sizes and cache assumptions are emitted in JSON. The script checks cold-write/warm-read accounting at short and long sizes before running the fixture.

Both commands are deterministic: two runs at the same commit give byte-identical output (compare with `cmp`).
