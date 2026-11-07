# The harness against a single agent

The README's [harness against a single agent](../../README.md#the-harness-against-a-single-agent) table. Results: [`delegation-results.json`](delegation-results.json), with the commit it ran on.

```sh
npm run simulate:delegation > docs/simulations/delegation-results.json
```

Offline, no Pi host, model or network; about ten seconds. [`scripts/simulate-delegation.mjs`](../../scripts/simulate-delegation.mjs) runs the same ten-task session four ways and prices every request.

## The session

Ten tasks in one user session: four small fixes (2 reads, a search, 2 edits, 2 test runs), three bug hunts (12 reads, 3 searches and 2 test runs to diagnose, then 2 edits and 2 test runs), and three features (4 reads to plan, 10 reads, 2 searches, 8 edits and 4 test runs to build, then 3 reads and 3 test runs to verify). Files are 4-24k characters. Two tasks fail once and need a second fix round (2 edits and a test run) after the user reports it.

## The four ways

- **Single agent, one session:** one model in plain Pi does everything in one context, with every tool output kept. No native compaction triggers at these sizes on a 1M-context model.
- **Single agent, fresh session per task:** the same, with a new session for each task (the second fix round stays in its task's session). The fairer baseline: it is how a careful user runs one agent.
- **Harness, every role on main's model:** main reads at most two named files, writes a packet and delegates each phase to a role in its own context: a fix to `backend-worker`; a bug hunt to `debugger` then `backend-worker`; a feature to `planner`, `backend-worker`, then `test-engineer`; a second fix round to a new `backend-worker`. Main's requests go through the production main hook (older-result shortening and checkpoint folding at 50k); each worker's through the production worker shaping (execution ledger, duplicate-read notes, shell-output cap, threshold masking). Each worker also reads `orient` extra files to get its bearings, writes a report and hands main a four-line result with 1.2k characters of findings.
- **Harness, roles on their own models:** the same, with each role on its default model from `agent/roles.json`: `backend-worker` on Claude Sonnet 5.5, `debugger`, `planner` and `test-engineer` on Claude Haiku 5.5. Main stays on the baseline's model.

The two harness rows separate the two effects: separate contexts alone (same model), then the model mix on top.

## Sizes and prices

- System prompts, measured: Pi's own 7.3k characters (recorded runs); main's 14.1k with the subagent extension (recorded) plus `agent/AGENTS.md`; each role's assembled child prompt (14.3-18.8k, from `scripts/measure-child-prompt.mjs`) on top of Pi's. Tool definitions are not in the recordings: 6k characters are assumed for every context, plus 4k for main's subagent tools.
- Per model call: 300 characters of assistant text kept in the history and 350 output tokens billed (text and thinking, the same in every arm); 900 output tokens for main's packet, 500 for a worker's report, 300 for a reply to the user.
- Prices, USD per million tokens (Anthropic first-party list prices): Claude Opus 5.5 $4 input, $20 output, $0.20 cache read; Claude Sonnet 5.5 $2, $10, $0.20; Claude Haiku 5.5 $0.10, $0.50 and 5x above 100k input tokens. Cache writes (5-minute) are 1.25x input. Haiku's cache-read price is not listed: 0.1x input is assumed.
- Cache model: one breakpoint on the system block and one on the last message; a request reads the longest earlier-written prefix ending within 20 blocks of its breakpoint and writes the rest. Each context, and each model, has its own cache. Sizes are characters / 4.

## What a scripted run cannot know

Two behaviours are settings, swept against the fresh-session single agent:

- `orient`: extra files each worker launch reads to get its bearings, which the single agent already has in context (default 1). It decides whether delegation pays.
- `economyX`: how many times the reads, searches and checks an economy-tier role (Claude Haiku 5.5) needs (default 1). It barely moves the cost, because those roles are cheap.

Not modelled at all: whether a worker or a single agent finishes the task correctly, how a single agent's long context affects its mistakes, and main re-checking a result (the policy says accept on evidence, not by re-reading). The second fix round is the same in both arms. These are estimates of the token mechanics, not a measurement of cost per completed task: that needs the paid [benchmark procedure](../../agent/skills/engineering-harness/references/token-efficiency.md#benchmark-procedure-only-when-authorized-paid-runs-are-not-part-of-this-repository).
