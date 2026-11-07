# OpenAI shaping simulation

Run on 2026-11-07 against production shaping code at `352a2f6`. This is an independent,
offline sandbox replay, not a rerun of the README's Claude-session fixtures. Those
original scripts and traces were not available in the repository. No model, Pi CLI,
subscription, network request or paid inference runs inside this simulation.

```sh
node --experimental-strip-types scripts/simulate-openai-shaping.mjs > results.json
```

Add `--trace` for per-request input/cache counters. The committed
[results](openai-shaping-results.json) include source hashes, rates, totals, peaks,
warm-cache input costs and no-cache input costs. The reported commit identifies the
checkout; hashes identify the exact simulation and production sources. Temporary
shell-output files are created under the system temp directory and removed afterward.

## Workloads

Both arms receive identical scripted actions and raw results. Each request has a
fixed synthetic 48,000-character system/tool prefix. Every tool call has 300
characters of assistant text; user messages have 240 characters. Sizes are
JavaScript string lengths divided by four, rounded up, including serialized message
framing. This is not an OpenAI tokenizer measurement.

| Scenario | Fixed workload |
| --- | --- |
| Long worker | 30 alternating reads (24,000 characters) and shell results (32,000); 31 requests |
| Repeated reads | 30 reads cycling over five unchanged 12,000-character files; 31 requests |
| Ordinary worker | 30 distinct 1,000-character reads; 31 requests |
| Main, 10 user turns | 30 subagent results; new user message every three calls; 31 requests |
| Main, 150/300/480 requests | 149/299/479 subagent results; new user message every three calls |

Main results contain a successful four-line handoff plus 1,450 characters of evidence.
They are intentionally recoverable, risk-free results, not failures or unresolved
decisions. The workloads do not model changed model decisions after compression.

The enabled worker arm calls the real execution ledger, duplicate-read suppression,
shell-output cap and context cap in their production order. After masking, dedupe
and ledger reuse are disabled as in the worker entry. All four OpenAI models currently
select the same 80k trigger and 95k budget; no environment overrides are inherited.
The enabled main arm uses the real ten-result batching and 50k checkpoint policy.
The baseline disables these transformations. Native compaction, provider usage
calibration, auto-formatting, lookup nudges, dispatch, system-prompt assembly and
host request serialization are outside this replay. An assertion fails if a worker
would require native compaction.

## Cost assumptions

[Standard OpenAI API prices](https://developers.openai.com/api/docs/pricing), checked
2026-11-07, in USD per million input tokens:

| Model | Uncached | Cached read | 30-minute write |
| --- | ---: | ---: | ---: |
| GPT-6.1 Sol | 2.00 | 0.10 | 2.50 |
| GPT-6.1 Terra | 1.00 | 0.05 | 1.25 |
| GPT-6 Astra | 10.00 | 1.00 | 12.50 |
| GPT-6 Luna | 0.10 | 0.01 | 0.125 |

The warm-cache scenario assumes every complete message prefix remains reusable for
the run, a 1,024-token minimum, no expiry/eviction and no cross-arm cache sharing.
Matching uses complete prefix hashes, so a changed earlier message invalidates the
suffix. All non-hit tokens are charged as new writes, not as both writes and ordinary
input. This idealized cache does not reproduce provider routing, eligible-boundary
lookback or timing. See the [prompt-cache documentation](https://developers.openai.com/api/docs/guides/prompt-caching).

For each request, input cost is `(cache reads * read rate + new writes * write rate)
/ 1,000,000`. Requests over 272,000 estimated input tokens use twice the input/cache
rates, as documented on the model pages. Only the 480-request baseline crosses that
boundary. The JSON also reports a no-cache sensitivity calculation: all input at the
ordinary rate, with the same long-context adjustment.

These are **input-side cost estimates only**. Output/reasoning tokens, tools, elapsed
time, task success and subscription billing are excluded. In particular, the API
cache-write and long-context assumptions must not be applied to Codex subscription
usage. Equal percentages for Sol/Terra and Astra/Luna follow from their equal relative
cache rates and identical replay policies; they do not establish equal model behavior.

## Interpretation

The long worker saves 61.6% of estimated input tokens; repeated reads save 52.1%.
The ordinary worker uses 2.0% more tokens because its unique, short outputs do not
benefit from compression and the ledger adds text. The short main run saves 6.9%
of tokens but increases warm-cache input cost by 22.5% on Sol/Terra and 12.5% on
Astra/Luna: rewriting cached history costs more than it saves on this workload.
Longer main runs amortize that rewrite cost. All outcomes, including regressions,
are included in the README table. These fixtures do not justify changing runtime
thresholds or claiming a measured improvement in live task cost.
