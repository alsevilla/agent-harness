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
integration sections, no bash or powershell). The reviewer is told the same goal (the task brief, else the subject) and allowed-file scope as the implementer.
Per cycle the adapter also records hashes only (no prompt text) of the effective session prompt and the loaded resources: `promptSha256` (raw, carries the
replay cwd, audit only), `effectivePromptSha256` (the prompt with only its known `<cwd>` section removed; an unknown prompt shape leaves it null), and
`resourcesSha256` (profile SYSTEM.md, context files, each skill's metadata and file bytes, every review guidance markdown file), re-hashed at close:
a resource edited during the review makes `stable` false. An incomplete or unstable identity is INCONCLUSIVE.

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
`compare` is only comparable across results of the same schema (`harness-benchmark-result/6`; older `/5` results are not comparable and are never migrated or mixed). Its reviewer guard requires the same
EFFECTIVE reviewer on matched tasks: each cycle records `evaluator` (selected and observed model, the reviewer contract file and body
digests, session tools, guidance reference, effective prompt and resource hashes). The first cycle, the final cycle and the set of distinct evaluators must match per task;
cycle counts may differ with rework. A fallback-selected reviewer, a changed contract, or an unknown identity is INCONCLUSIVE. The
measured candidate runtime is not part of this guard; only the reviewer evaluator is.
`validate-history` runs the ordinary historical node or bun tests in scratch against replayed trees. It starts no Pi session and no provider.
`--adapter pi-sdk` loads the Pi SDK in-process and creates provider-backed sessions; it refuses to run without `--confirm-live`.
Its extensions are the candidate's `package.json` `pi.extensions`; global extension discovery is off.

`preflight` (operator-owned; add `--confirm-no-prompt-preflight`, `--scratch <dir outside the candidate>`, the Pi package root flag and optionally `--out <json>`) opens the main
session exactly as a run does, requires both `subagent` and `subagent_control` active, sends NO prompt, opens no reviewer and no worker, and requires a confirmed
shutdown. It reads local configuration only, but this code cannot prove the SDK makes no provider call while opening; hence the explicit operator confirmation. A
child-argv probe (`get_state` over RPC for each expected role) is NOT implemented: the exact native child argv is assembled inside the dispatch path (per-job guard and
prompt files), so a standalone reproduction would not be the native one. Supported fallback: run the preflight, then the single-task smoke.

Whether a parent can run the live baseline without user interaction is **not verified**. The bash tool can run this CLI from the
main session, but a safety guard blocks Pi package launches from leaf sessions and may also block the live run. The live run needs an
explicit operator grant or a main-owned shell.

## Limits and configuration
- `maxReworkRounds`: the default is the `general-worker` role's `maxReworkRounds` in `agent/roles.json` (the writer that performs
  rework; the user policy value is 2). Precedence, most specific first: manifest task override > run flag `--max-rework-rounds` >
  roles.json default. Each task records `{value, source}`. The run flag needs an explicit whole number >= 0 (`0` is valid); a bare,
  empty, signed, fractional or unsafe value refuses the run before it starts. An invalid or missing value never falls back to a literal.
- `diagnosticChars`: the cap on stored launch and main diagnostics (sanitized, then bounded; the tail is kept for stderr). Sanitizing is pattern-based (PEM blocks, Bearer and Basic auth, AWS access key IDs, URL userinfo, key/token/secret/password fields in key=value or JSON form, and sk-/ghp_-style tokens); it is not a complete secret scanner. Default is
  the `general-worker` role's `diagnosticChars` in `agent/roles.json` (300). Precedence: manifest task override > run flag
  `--diagnostic-chars` > roles.json default. The run flag needs an explicit whole number >= 0; an invalid value refuses the run.
- `expectedWriter` (manifest metadata, `general-worker`): every task's implementation must be delegated to a measured child of that
  role through the native subagent tool. The main session has only read, grep, find, ls, subagent and subagent_control (no edit or write).
- Method validity, checked after each main round before review: a launch with no child turn or a main turn with no assistant message is
  `infrastructure`; a direct main edit or write, or no measured writer launch for the task, is `methodinvalid`. The writer is required once per task, cumulatively: round 0 must launch a measured writer (`missing_delegation` otherwise), and a later rework round with an idle turn, a debugger-only launch or only refusals stays valid after an earlier measured writer and gets normal acceptance and review; no extra dispatch or permission is forced, and a genuinely unfixed failure at the rework cap is scored not accepted while the next task runs. A direct main write, a failed or unreported child, a missing assistant turn and unsettled background work still stop the task in any round. Either stops the task before review,
  rework and the next task, records the partial results, and makes the run `invalid` (CLI exit 1). A healthy writer whose check fails
  is scored normally (not accepted). Other launches, such as debugger, are optional and recorded with their actual role. `mainDiagnostics.rounds` records per round `round`, `assistantTurns`, `writerLaunches`, `toolCalls` and per-tool `calls`/`errors` (counts only, no arguments or reasoning).
- Measurement exclusion policy (`config.measurementPolicy.toolState`, introduced in schema 5 and still recorded in the current schema 6): a generated, untracked root `.serena/` backend state file is not implementation output. Only an added file under root `.serena/` that is neither materialized from the parent commit nor in the pre-session baseline snapshot is excluded from scored `changed`/`unrelated`; it is reported in `changedFiles.toolStateChanges` (path and sha256) and stays in the raw `changedFiles.inventory`. Tracked or preexisting `.serena/` files, `.serena2/`, nested `.serena/` and every other path (for example `.h4-checks/`, `parse.out`) still fail as unrelated. `compare` is INCONCLUSIVE when the policies differ or one side lacks it.
- `roundSettleTimeoutMs` (default 1200000) and `shutdownGraceMs` (default 60000): whole milliseconds >= 1, the `general-worker` role keys in `agent/roles.json`.
  Precedence for the settlement timeout: manifest task `roundSettleTimeoutMs` > run flag `--round-timeout-ms` > roles.json default; the shutdown grace takes
  `--shutdown-grace-ms` > roles.json. Every task records the winning `{value, source}`. A bare, zero, signed or fractional flag refuses the run; there is no literal fallback.
- Round lifecycle. Pi runs background workers by default, so a subagent call returns a receipt (`background` and `jobId`) and the worker result arrives later as a
  completion notice. The adapter keeps `isError`, the (redacted, bounded) text and the `background`, `jobId` and `mode` marks of every subagent call, so four things stay
  distinct: a pending receipt, a refused call (an error with nothing launched: a recorded main tool error, recoverable by a later valid launch), an unreported result
  (a bare empty result with no error: infrastructure), and a measured terminal child. Worker usage comes from the completion's per-result metadata
  (non-model-visible `details.results`; the notice text is untouched, 4000 code unit cap) and is counted exactly once per job (a duplicate event, a later
  `subagent_control result`, or a retry never counts twice). After each prompt the adapter waits event-driven (no polling) until Pi is idle and no job is pending, repeating
  while a completion turn launches another job; only then is the workspace snapshotted, accepted or reviewed. A receipt that never completes, or a timeout, stops the
  run as infrastructure `background_unsettled` (the pending cost is unknown, never zero); a failed or aborted job is a terminal worker failure (infrastructure), except a job the main itself cancelled (see Main-cancel label below); a worker
  that finished with a failing acceptance is a scoreable quality failure.
- Lifecycle. The adapter binds each session through `bindExtensions()` (the only `session_start` emitter) and closes it through `AgentSessionRuntime.dispose()`, which emits
  `session_shutdown` before disposing; the subagent extension awaits every owning background worker there. `closeSession` returns `{confirmed, ms, pendingJobs}`; an
  unconfirmed shutdown is never a valid task, and a stopped round closes its session before the workspace can be reused. Foreground (non-background) child processes of an
  aborted run are stopped through the run's abort signal, not tracked separately.
- Main controls: the main has `read, grep, find, ls, subagent, subagent_control`; both native controls must be active at open (no edit or write).
- `--task H1,H2` runs only the named tasks in manifest order (an unknown id is refused before any run).
- Task count follows the manifest; the 8-10 contract is a validation check only.
- Resources (`mode: profile-installed`). The supported Pi loaders read `AGENTS.md`, skills and same-named role prompts from the profile agent directory, with no
  candidate-root override, so the candidate's copies are measured only when byte-identical. A live `run` and `preflight` compare the candidate's `agent/AGENTS.md`,
  `agent/skills/**/*.md` and `agent/agents/*.md` with the profile's and REFUSE on any difference or a missing skill (a Phase 2 measurement blocker: install the
  candidate resources into the profile, then rerun; the benchmark copies nothing and never writes the profile). The main session open also verifies the loader's actually
  loaded AGENTS.md and skill bytes, and records them (`models.main.opened.resources`). `roles.json` is the exception: the user's overlay is legitimate and carried with its source.

## Harness-only scope and exclusions
- Replays use only the harness roots: `agent/`, `docs/`, `tests/`, `scripts/`, `package.json`, `README.md`. Commits are read with
  `git cat-file`; there is no checkout, index or work-tree write in the candidate. Every write target must be under the assigned scratch root.
- RFID-named paths are excluded from every replay by name (never read or written). Ten exist in the 5ed9fe3 ancestry: one test file
  (`agent/extensions/subagent/tests/rfid-role-overlay.test.ts`) and nine files under `agent/skills/rfid-attendance/`. None exist at HEAD.
  The per-task exclusion list is recorded in each `validate-history` report (`excludedRfidNamed`).
- Commit bodies are not used as prompts. Each task has an explicit `brief`, the prompt goal: a reconstructed contract written from the commit's held-out acceptance behavior
  (`briefProvenance`), NOT the original user request, with no implementation. H10 and H12 describe implementing and testing harness behavior only (no real knowledge is
  saved, nothing is released or published). The held-out tests are unchanged objective checks.
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
- `lib/topology.mjs` pure agent topology check (injected discovery and tier resolution); `lib/topology-loader.mjs` loads the candidate's own native `agents.ts`/`model-routing.ts` with the installed SDK
- `lib/reviewer-contract.mjs` reviewer role contract (candidate `agent/agents/reviewer.md`: body, digests); no Pi import
- `lib/compare.mjs` regression comparison; `cli.mjs` entry point; `*.test.mjs` offline contract tests; `fixtures/` fakes

## Task deadline (schema harness-benchmark-result/6)

`taskTimeoutMs` (general-worker role default 1200000, `--task-timeout-ms`, manifest task override; source recorded) is one monotonic benchmark-task budget started before setup (including between-task compaction), not a native worker turn budget. The existing `shutdownGraceMs` is reserved inside it: work cutoff = deadline - grace. Main prompt, acceptance (owned async process, killed at the cutoff), reviewer and compaction are cut by that clock; the owning session is then aborted and drained. An expired task is `budget_exhausted`, `accepted:false`, with the stage recorded and an unavailable review recorded as unknown; the run is `unfinished` and never compares as NO_REGRESSION. Fresh mode continues only after a confirmed drain; long modes stop with the rest not run. Ownership: every stage (prepare, session open, start context, main prompt, held-out write, acceptance, reviewer open/prompt/close, between-task compaction) gets the task `AbortSignal`, and an operation that outlives the cutoff is owned by the task, never merely dropped from a `Promise.race`. At the cutoff the signal fires; a session an open returns late is closed through the lifecycle owner and never bound or prompted; a late prompt or compaction keeps its reported usage but is never scored; the owned operations are drained until the task deadline. `rec.shutdown` = `{confirmed, ms, pendingJobs, pendingOperations}`: it is confirmed only when the session closed and nothing is pending, otherwise the run stops (even fresh mode) as `unfinished` with `shutdownUnconfirmed` and no later task starts. What Pi 1.4.0 supports: `session.abort()` (awaits idle), `session.abortCompaction()` and `AgentSessionRuntime.dispose()` cancel real work; `createAgentSession` and `loader.reload()` take no signal, so an open is only checked at its await boundaries and its late result disposed. Limits: workspace git reads are bounded with the remaining time but synchronous file writes and snapshots cannot be interrupted (their overrun is detected after the fact: each snapshot is a `workspace_snapshot` stage that also checks the cutoff between files, so a single blocked read still runs to completion); a factory that never resolves leaves the shutdown unconfirmed, not closed; OS-level uninterruptible blocks are not covered. Comparison follows contract `bounded-budget-comparison/1` (see "Bounded-budget comparison" at the end of this file).

### Observability and terminal accounting (same schema; no new limits)

- **Timeline:** native receipts, completions, control calls, decision notices, hidden audits and delivery diagnostics carry `atMs`, an offset on the injected monotonic task clock (`null` = not recorded, never 0). `delegation.timeline` lists them per round; each settlement records `startedAtMs`, `endedAtMs`, `snapshotAtMs`, the last wait phase (`idle` = main run working, `completion` = idle and waiting for a worker) and `pending` (job id, structured requested `roles`, receipt offset, last event) taken BEFORE the abort. `budget.pendingAtAbort` holds the same snapshot when the task signal aborted the run. `result.progress` (task, round, stage, last event) is rewritten at stage starts and at those native events, never on a timer.
- **Structured roles:** `delegation.receipts[].roles` is the native `details.roles` (requested agent names, duplicates kept); launch records keep the roles actually served. Nothing parses the notice text.
- **Controls and decisions:** only the `subagent_control` action enum and a safe id; a decision notice yields state, request id and job id. Steer/answer/question text, authorization material and tool arguments are never recorded.
- **Cost:** `cost.total` is `null` whenever any part is unknown; `cost.knownPricedSubtotal` keeps every finite SDK-reported priced turn and `cost.unresolved` lists `{id, reason}` (`completion_not_received`, `no_usage_reported`, `unpriced`, `no_child_turn`, `aborted_in_flight_usage_unknown`, `no_results_in_audit`). A worker is `session id / job id` plus its result position, so duplicate roles and reused job ids stay distinct, and a completion, its terminal audit, a control result and repeated cumulative snapshots are counted once (first record of a job wins). An aborted stream's unreported usage is never estimated.
- **Hidden terminal audit:** the extension appends one `custom` entry (`pi.appendEntry`, `customType` `subagent-terminal-audit`) per finished or cancelled background job, including when a shutdown generation suppresses the model completion, plus `subagent-delivery-diagnostic` (`completion_delivery_failed`) when handing over the completion threw synchronously. `pi.sendMessage` returns void, so an audit says `completion: submitted` (an attempt), never delivered; `delegation.audits[].completionObserved` is true only when the consumer's completion for that job was seen, and async send errors are counted per task as `uncorrelatedSendErrors` (no text, no job id).
- **Ownership:** a background job belongs to the task whose round first showed it (receipt or completion), for the whole run and any shared session. Each job is reconciled per child position (richer data fills a missing child or price; a conflicting report of one child stays unknown; duplicate cumulative snapshots are never summed). A late completion, audit or close record is merged into its owner task (whose record is refreshed) and never counted as another task's usage or writer launch. A record no task can be proven to own is an explicit `owner_unattributed` unknown in the run totals (`result.unattributed`), never the current task's. A child with `phase1.unpricedTurns > 0` is a known priced subtotal with an unknown total, not a measured zero. Pi 1.4 writes these as session metadata that `buildSessionContext` never converts to a message, so there is no model turn or wake-up. The adapter collects them after the awaited shutdown drain (live subscription plus a final read of the session's entries) and the runner folds them into the task ledger before totals are computed, including for `budget_exhausted` tasks. An audit whose `ownerSession` differs from the session being closed is reported under `delegation.ignoredAudits` and never counted.
- **Phase 1 numbers:** each worker result carries `phase1` (first and peak prompt tokens, attempts) from the existing task ledger when reported, else `null`; no new provider instrumentation.

Limits: the audit exists only where the extension runs with a live owning session; a job whose process died without any record stays an unknown (`completion_not_received`), not a cost. Only a mismatch of the recorded session id identifies an old owner. In a long (shared) session a completion and its audit that land in different tasks are reconciled by originating session and job to the task that first showed the job, never counted twice or charged to the current task; an observation whose owner cannot be proven stays an explicit `owner_unattributed` unknown in the run totals. v5 results are not comparable.

## Agent topology guard (method proof; label and guard only)

Native `discoverAgents` treats an agent-directory definition that is a physically separate file as a USER override of the package role, even when it is byte-identical, and `resolveModelTier` then refuses every explicit `modelTier` ("only supported for canonical package roles"). The older content-hash resource check cannot see this. `lib/topology.mjs` therefore asks the REAL native `discoverAgents` and `resolveModelTier` (loaded by `lib/topology-loader.mjs` from the exact extension directory the session loads, with the installed SDK as `--pi-package-root`; no `ModelRuntime`, credential, session or model call, no environment change) and requires, in scope `user` and `both` at the cwd: every canonical role (names from the candidate's `agent/roles.json`) resolves with source `package` from `agent/agents/<name>.md` of the candidate, and the default and every configured tier resolve to the configured model and thinking. A non-canonical user role is ignored. The result (`harness-benchmark-result/6`, `config.topology`, method `agent-topology/1`) is an allowlist: problem kinds `agent_source_shadowed`, `agent_source_project_override`, `agent_missing`, `tier_unresolved`, `discovery_error`, `topology_unproven`; roles, scopes, tiers, sources and file paths; env override presence only (never a value); a fingerprint of the proven content (not of cwd or directory spelling). Prompts, arguments and raw errors are never recorded.

- `run` and `preflight` run it before any workspace, session, provider or prompt; a blocked or unprovable topology ends as a structured `agent_topology` blocker with the diagnostic persisted (`run`: `status: blocked`, no task record; `preflight`: no session is opened, so no shutdown is claimed). The adapter's main `openSession` re-proves it at the actual replay cwd (a nearer project agents directory can override a canonical role) before the loader or factory. There is no skip flag.
- `runBenchmark` requires `config.topology` of this method with `ok: true` for any non-synthetic adapter, before preparing a workspace (missing proof: `methodinvalid` `agent_topology_missing`; `ok: false`: `infrastructure` `agent_topology_blocked`), so a library caller cannot bypass the CLI. A synthetic run is not applicable and records none.
- `compare` is INCONCLUSIVE when either side lacks a passing proof of the same method (an older v6 run has none); per-run cwd, ids and fingerprints are not compared, so intentional prompt or resource changes stay comparable. Old v6 outputs are not rewritten or migrated.
- The check does not change the profile, the environment, roles, tiers, models or guards, and never loosens them: with physically separate profile copies it is expected to BLOCK. Whether the live profile links to the package definitions or the operator uses a separate profile is an operator decision outside this guard.

## Main-cancel label (label only)

A background job the main itself cancelled successfully is no longer labelled infrastructure `launch_failed`. Exempt only when ALL hold: the job's background receipt came first, then a `subagent_control` cancel that named that job's id and whose source `isError` is exactly `false` (an explicit successful ACK; `true` is a failure, and a missing, null or otherwise malformed outcome is normalised to unknown, never to `false`, and its raw value is not kept), and only then the job's completion, which is `aborted` with the abort-kill child shape (exit 1, stop reason `aborted`, turns > 0) and the native producer's per-attempt proof `abort: { running: true, priorFailure: false }` (two strict booleans, both own properties; the child was still running when killed and no failure of that attempt was seen before the kill). Missing, malformed or legacy abort proof is not clean. The error message and `isError` of the child are not read. The proof is per attempt: a recovered earlier fallback attempt does not make it false, but a failure in the killed attempt stays `priorFailure: true` and the launch fails; it does not claim the whole job was error free. The launch is recorded as `cancelled-by-main`; it is never a measured writer, so a cancelled writer is still `methodinvalid` `missing_delegation` and the run still stops. A failed state, an errored child, a never-started child, no cancel, an errored, unknown-outcome, early or late cancel, or another job's cancel stays `launch_failed`. Cost is unchanged (`cost.total` stays `null`, `aborted_in_flight_usage_unknown`). This corrects a label only: the H9 baseline is not made valid, and why the main cancelled is unknown (arguments and reasoning are never stored).

## Bounded-budget comparison (`bounded-budget-comparison/1`)
`compare` separates two questions and reports both (`contract`, `appliedPolicy`, `baselineEligible`, `attemptCoverage`, `quality`; existing fields are unchanged). The comparator applies the contract to existing schema-6 results: no input file is rewritten and no new run marker is required.
- **Baseline eligibility** (`baselineEligible`, `attemptCoverage.{baseline,candidate}`): every ordered task has exactly one record; each is a `completed` attempt or a STRUCTURED deadline cut (`status: budget_exhausted`, `budget.exhausted: true`, a recorded `budget.stage`, `accepted: false`); a run with cuts is `unfinished` with a matching `budgetExhausted` list; and each task's final `shutdown.confirmed` is true with no `pendingOperations` (`shutdown.pendingJobs` may list the jobs pending when the close started: confirmed means they were aborted and drained). A cut task is a FAILED attempt in the acceptance denominator and is never accepted, even if an earlier round passed. Error text is never parsed; unknown provider failures, tasks not started or not recorded, duplicate records, invalid/infrastructure/failed runs and unconfirmed shutdown are not eligible. Workload, mode, topology proof, measurement policy, rework cap and the effective per-run and per-task limits must still match. `baselineEligible` is not a verdict and not a full 8-task baseline: `attemptCoverage.*.fullTaskSet` is false for a subset such as the two-task pilot.
- **Quality**: a missing review cycle, a cut task's missing review, an unavailable cycle or a null high-severity total makes `quality.status` `unknown` (counts stay `null`, never 0; a model self-report is not a review). High-severity counts are recomputed from the per-task review cycles (integer counts that equal their critical/high findings); cached `totals.highFindings` must equal that rollup, otherwise quality is `unknown` (never zero-filled, never a pass). Unknown quality never yields NO_REGRESSION: with otherwise equal acceptance the verdict is INCONCLUSIVE. A proven acceptance drop stays REGRESSION, and a high-severity rise stays REGRESSION when both sides' review quality is fully known. Reviewer-evaluator mismatches on fully reviewed tasks remain INCONCLUSIVE.
- Cost is unchanged: a null total stays unknown (its known subtotal is kept); nothing is inferred from prices, elapsed time or accepted-task rates, and no savings claim follows.
- Phase 2 still requires the matched full eight-task fresh / long-fixed / long-compacted baselines, each with complete review evidence for a quality verdict; capturing eligible deadline-censored data does not declare missing reviews safe or an optimization accepted.
