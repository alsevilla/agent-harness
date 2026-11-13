# Pi shaping simulations

Two simulations behind the README's [Token savings](../../README.md#token-savings) tables, both run against Anthropic-style prompt caching; the harness against a single agent is in [delegation.md](delegation.md). Each compares the same work with the harness's request shaping and without it. Results: [`pi-shaping-results.json`](pi-shaping-results.json) and [`main-sessions-results.json`](main-sessions-results.json); each records the commit it ran on.

## Recorded Pi runs

```sh
NATIVE_PROBE_HOST_MODULES=<node_modules holding @earendil-works/pi-coding-agent> npm run simulate:pi > docs/simulations/pi-shaping-results.json
```

Needs an installed Pi (the same `NATIVE_PROBE_HOST_MODULES` folder the host test suites use; without it, the global npm root). No model, network or credentials: Pi's own faux provider plays the model. Takes about ten seconds. Counts move by a few characters between runs, because messages carry timestamps and `ls -la` prints file times; the percentages are the same on every run.

How it works ([`scripts/simulate-pi-shaping.mjs`](../../scripts/simulate-pi-shaping.mjs)):

- The real Pi CLI runs in RPC mode in a fresh temporary Git checkout. The stand-in model ([`recorder.mjs`](../../scripts/simulate-pi-shaping/recorder.mjs)) replays a scripted list of tool calls and appends every request context Pi sends it to a log, so what is measured is exactly what Pi would send a real model.
- Each scenario runs twice with the same script. With shaping, a worker run loads the worker entry (`safety-guard-entry.ts`: execution ledger, duplicate-read notes, shell-output cap, threshold masking); a main run loads the subagent extension. Without shaping, a worker run loads no harness extension, and main runs the subagent extension with `PI_SUBAGENT_MAIN_FOLD_TOKENS=0` and `PI_SUBAGENT_HANDOFF_WINDOW=0`. The runner fails if the two arms differ in tool calls or request count, or if any tool call errors.
- The stand-in model is an unknown model to the harness, so worker masking uses its default threshold (80k tokens); on Claude Haiku 5.5 it starts at 90k.
- Fixtures are generated: ten 30k-character modules plus queue, sender, config and test files for the worker and main scenarios, and empty, tiny, medium and 19k-character files for the repeated-read scenario.

| Scenario ([`scenarios/`](../../scripts/simulate-pi-shaping/scenarios/)) | Work |
| --- | --- |
| `long` | 30 tool calls: 24 whole reads of the ten 30k-character modules (each two or three times) and 6 `git status` |
| `repetition` | 25 tool calls: the same four files read again and again with listings between, then the large file shrunk, read, restored and read again |
| `standard` | 28 tool calls on a small queue task: reads of the queue, sender and test files, two greps, two edits, `git status`, a 6,000-line `seq` output, the check, and twelve small partial reads |
| `main` | 10 user turns, each reading one 30k-character module and running `git status`; one turn adds a 6k-character pasted rule |

Cache model: Pi places one breakpoint on the system block and one on the last message. A request reads the longest earlier-written prefix ending within 20 blocks of its breakpoint and writes everything after it. Cost is input-token equivalents: cache read 0.1x and cache write 1.25x of the input price; for Claude Haiku 5.5, a request over 100k input tokens costs 5x. Sizes are serialized request characters / 4. The system prompt and tool definitions are checked to be identical across every request of a run (`systemPromptStable`).

### Tool-schema audit

Each arm also reports `toolSchemas`: total/min/max serialized active-definition characters, per-tool exposure counts and sizes, and the number of distinct ordered schema lists. This uses the actual Pi request contexts, including definitions registered by loaded extensions. Changes in descriptions, parameters or ordering count as distinct variants. Message bodies are excluded; per-tool totals exclude the array punctuation included in the overall total.

For an existing Pi recorder trace, run `NATIVE_PROBE_HOST_MODULES=<matching Pi node_modules> node scripts/audit-tool-schemas.mjs /absolute/path/to/requests.jsonl`. Current Pi declares tools through system-message updates; the audit uses that installed Pi version’s `getCurrentTools` to reconstruct each active catalog. Legacy explicit `tools` arrays need no Pi dependency. This measures active catalogs before provider-specific serialization, not the bytes of a provider HTTP payload. No provider calls are made and schema contents are not printed. The simulation deletes its temporary raw traces after computing the audit. These measurements do not automatically remove tools, prove a tool is unnecessary, or measure production integration overhead: the fixture tool list is fixed. Existing checked-in result files may predate this additive field; rerun the command above to obtain it.

## Long main sessions

```sh
npm run simulate:main > docs/simulations/main-sessions-results.json
```

Offline, no Pi host; under a second. [`scripts/simulate-main-sessions.mjs`](../../scripts/simulate-main-sessions.mjs) builds a seeded synthetic session: about 12% user messages, 33% subagent PASS results with 2.5-8.5k-character reports, and main's own reads and shell output of 0.5-7.5k characters, with a 14k-token system prompt. Requests 150, 300 and 480 are priced three ways: no shaping, older-result shortening alone (batches of ten), and the production context hook (`registerHandoffWindow`: shortening plus checkpoint folding at 50k). Same cache model as above, at Opus 5.5 cache prices (read 0.05x, write 1.25x). `PASTE_SHARE=0.5` makes half the user messages 3-6k-character pastes.

## Limits

These are scripted runs and size estimates, not a billing benchmark. Characters / 4 is not a tokenizer. A real model may choose different calls once it sees shortened output, which neither simulation models, and the workloads are chosen to exercise each rule: your tasks set the actual mix. The cache model follows Anthropic's documented lookback but not its timing or eviction. Output, thinking and tool costs are excluded.
