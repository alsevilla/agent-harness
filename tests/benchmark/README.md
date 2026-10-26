# Harness benchmark (checkpoint before Phase 2)

Status: **implemented, not executed as a baseline.** The three-mode baseline is NOT RUN. Nothing here claims token savings.
The offline synthetic run and the history validation prove the mechanics only; they are not performance evidence.

## What it measures
A fixed, ordered manifest of real past harness commits (`manifest.json`). Each task starts at its parent's harness state, gets
its acceptance tests from the commit (held out until the acceptance step), and is scored on:

- acceptance: held-out `node --test` (or `bun test` for bun:test suites) passes, and no file outside `allowedFiles` changed;
- reviewer findings: `FINDING <critical|high|medium|low>: <text>` lines from a fresh read-only reviewer session; `NO FINDINGS` is zero;
  anything else is `unavailable`, never zero;
- rework: assistant turns spent on rework prompts (a failed acceptance or a high/critical finding triggers it), capped per task;
- cost and tokens per ledger: main, rework (inside main), worker (subagent results), reviewer, compaction, and end-to-end.
  Cost is the SDK `cost.total` (it includes cache prices); the cache-tier part is `cost.cacheRead + cost.cacheWrite`.
  Worker results report total cost only, so their cache-tier split is `null` (unavailable) and so is the end-to-end cache tier;
- start context per task: context tokens and window, system prompt characters, active tools, message count (before the first prompt).

A missing value is `null`, `unavailable` or `partial`, never zero. A failed run, unavailable reviewer data, a synthetic result, a
different manifest, order, mode, rework cap or configured model, or a missing task makes the comparison `INCONCLUSIVE`.

`NO_REGRESSION` is RELATIVE to the baseline on the same matched tasks. It is NOT all tasks passed: `allAccepted` and
`unacceptedTasks` (per side) are always reported, with per-task acceptance and a caveat.

## Modes (session policy; auto-compaction is disabled in every arm)
| mode | main session | compaction |
|---|---|---|
| `fresh` | new in-memory session per task | none |
| `long-fixed` | one session, fixed manifest order | none |
| `long-compacted` | one session, fixed order | manual `session.compact()` between consecutive tasks (none before the first) |

Each mode uses one stable workspace directory: per task for `fresh`, shared for the long modes (re-materialised to each task's parent state).
A reviewer session is always fresh, uses the registry's reviewer tier (model, fallback chain, thinking; see below), has read-only tools
(`read, grep, find, ls`; the role's bash and powershell are excluded), loads no extensions and reads no replay context files.
It is not the main session and is never the profile default model.
The reviewer session carries the full candidate role contract, `agent/agents/reviewer.md`: its body is appended verbatim to the system prompt
(checked against the loader's effective append list before any session opens). Recorded per cycle: file and SHA-256 of the whole file, SHA-256
of the body, the declared registry tools and the read-only subset, the absolute installed review guidance path (with presence), and
`execution: sdk-isolated-session-role-contract` with `nativeDispatch: false`. This is an isolated SDK session with the role contract, not the
native named `reviewer` dispatch of the subagent tool: differences remain (no Pi child-process prompt assembly, no core guidance or
integration sections, no skill injection beyond the referenced path, no bash or powershell). Compare does not yet gate on the contract digest.

## Candidate runtime and configured identities
- Measured runtime: the candidate package's own `pi.extensions` (fingerprint over the declared extension files and their directories,
  recorded at the start and rechecked at the end). Replayed parents supply only the task's files and tools' working directory;
  their `package.json` extensions are never loaded (a sentinel test proves this in every mode).
- Main: the profile default from the SDK settings registry (`defaultProvider`, `defaultModel`, `defaultThinkingLevel`). A missing default is refused.
- Reviewer: the effective `reviewer` role (candidate `agent/roles.json`, overlaid by the user `roles.json`) at its `defaultModelTier`.
- Each model is resolved in the SDK registry with configured credentials. The next configured fallback is used only when a candidate is
  absent or has no credentials; every attempt is recorded. A provider failure during a run is not replayed: the task fails.
- Recorded per task: configured spec, selected model, attempts, the SDK-reported session model and thinking (`observed`), and the served
  provider/model from assistant messages. Served thinking is `unknown`: served model is never certified.

## Invocation (operator or main shell only; never a leaf dispatch)
```
npm run benchmark -- validate                       # schema and checkpoint contract, offline
npm run benchmark -- validate-history --scratch <dir outside the candidate> --out <evidence json>
npm run benchmark -- run --mode fresh --adapter pi-sdk --pi-package-root <Pi 1.4.0 package dir> --confirm-live --scratch <dir outside the candidate> --out <result json> [--max-rework-rounds N] [--manifest <file>]
npm run benchmark -- run --mode long-compacted ...   # same flags; repeat per mode
npm run benchmark -- run --mode fresh --adapter synthetic ...    # SYNTHETIC: not a baseline
npm run benchmark -- compare <baseline.json> <candidate.json> [--out <file>]
```
`compare` is only comparable across results of the same schema (`harness-benchmark-result/2`). Its reviewer guard requires the same
EFFECTIVE reviewer on matched tasks: each cycle records `evaluator` (selected and observed model, the reviewer contract file and body
digests, session tools, guidance reference). The first cycle, the final cycle and the set of distinct evaluators must match per task;
cycle counts may differ with rework. A fallback-selected reviewer, a changed contract, or an unknown identity is INCONCLUSIVE. The
measured candidate runtime is not part of this guard; only the reviewer evaluator is.
`validate-history` runs the ordinary historical node or bun tests in scratch against replayed trees. It starts no Pi session and no provider.
`--adapter pi-sdk` loads the Pi SDK in-process and creates provider-backed sessions; it refuses to run without `--confirm-live`.
Its extensions are the candidate's `package.json` `pi.extensions`; global extension discovery is off.

Whether a parent can run the live baseline without user interaction is **not verified**. The bash tool can run this CLI from the
main session, but a safety guard blocks Pi package launches from leaf sessions and may also block the live run. The live run needs an
explicit operator grant or a main-owned shell.

## Limits and configuration
- `maxReworkRounds`: the default is the `general-worker` role's `maxReworkRounds` in `agent/roles.json` (the writer that performs
  rework; the user policy value is 2). Precedence, most specific first: manifest task override > run flag `--max-rework-rounds` >
  roles.json default. Each task records `{value, source}`. The run flag needs an explicit whole number >= 0 (`0` is valid); a bare,
  empty, signed, fractional or unsafe value refuses the run before it starts. An invalid or missing value never falls back to a literal.
- No wall-clock timeout is imposed (no artificial limit). Task count follows the manifest; the 8-10 contract is a validation check only.

## Harness-only scope and exclusions
- Replays use only the harness roots: `agent/`, `docs/`, `tests/`, `scripts/`, `package.json`, `README.md`. Commits are read with
  `git cat-file`; there is no checkout, index or work-tree write in the candidate. Every write target must be under the assigned scratch root.
- RFID-named paths are excluded from every replay by name (never read or written). Ten exist in the 5ed9fe3 ancestry: one test file
  (`agent/extensions/subagent/tests/rfid-role-overlay.test.ts`) and nine files under `agent/skills/rfid-attendance/`. None exist at HEAD.
  The per-task exclusion list is recorded in each `validate-history` report (`excludedRfidNamed`).
- Commit bodies are not used as prompts; the commit subject is the task goal.
- Excluded candidates and reasons are in `manifest.json` (`excludedCandidates`). Environment-bound acceptance (missing Pi packages,
  installed model catalogs, third-party integrations) is excluded rather than passed.
- Domain coverage: this is a harness-only substitution. Application backend, frontend and database work is NOT represented.

## Runtime vs model policy
The benchmark measures runtime controls: session policy, compaction, rework cap, held-out acceptance. It does not choose models,
thinking levels or routing: every model and thinking level is read from the configured registry and recorded as configured, selected
and observed. The reviewer uses its own registry tier. Served model is never certified.

## Files
- `manifest.json` fixed ordered tasks; `lib/manifest.mjs` schema, path guard, checkpoint contract, digest
- `lib/workspace.mjs` git-backed replay, held-out files, snapshots; `lib/acceptance.mjs` node and bun acceptance
- `lib/history.mjs` RED/GREEN history validation; `lib/usage.mjs` ledgers; `lib/runner.mjs` modes, rework, recording
- `lib/sdk-adapter.mjs` Pi 1.4.0 SDK adapter (lazy import); `lib/synthetic-adapter.mjs` offline, labelled synthetic
- `lib/runtime.mjs` candidate runtime identity (declared extensions, fingerprint); `lib/roles.mjs` registry resolution (reviewer tier, tools, rework cap, precedence)
- `lib/reviewer-contract.mjs` reviewer role contract (candidate `agent/agents/reviewer.md`: body, digests); no Pi import
- `lib/compare.mjs` regression comparison; `cli.mjs` entry point; `*.test.mjs` offline contract tests; `fixtures/` fakes
