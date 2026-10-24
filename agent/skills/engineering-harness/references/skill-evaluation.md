# Routing and skill-selection evaluation (offline)

Read only when measuring or changing routing/skill-selection guidance. This is an optional offline check: it is not a gate, not a runtime hook and not a model caller.

## Components
- Fixture: `examples/routing-cases.json` (schema `engineering-harness/routing-cases/v1`): 36 synthetic cases, 22 positive and 14 near-miss. Expected labels come from the current policy in `agent/AGENTS.md`, `SKILL.md`, `references/routing.md`, and the frontend and backend routers when relevant.
- Evaluator: `scripts/evaluate-routing.mjs` (Node built-ins only, no dependency and no interpreter other than Node; no network, no model calls). Importing it runs nothing; the CLI starts only when the file is executed.
- Tests: `tests/evaluate-routing.test.mjs` (`node:test`, deterministic unit checks; found by the canonical runner `scripts/run-node-tests.mjs`).

## Field meanings
- `route`: the orchestrator's main route label (`T0_MAIN` (only the no-usable-dispatch fallback; standalone T0 otherwise routes to `T1_WORKER` with `general-worker`), `T1_WORKER`, `T2_DEBUG_WORKER`, `T3_SPECIALIST_FIRST`, `T4_ORACLE_ESCALATION`, `DISCOVER_SCOUT_FIRST`, `LOCAL_DONE`, `VERIFY_INDEPENDENT`, `REVIEW`, `SHIP_AUTHORIZED`, `BLOCKED_NO_AUTHORITY`, `STOP_NO_LAUNCH`, `QUEUE_NO_LAUNCH`). It is not a role name.
- `roles`: actual named roles launched. Without `calls` the list order is the legacy order evidence; with `calls` it is only a multiset cross-check against the calls' agents and never runtime order.
- `skills`: skills or modules selected for the case, including guidance already loaded earlier in the session. Selection is not a read: the evaluator cannot verify that a skill was read or activated, and a correctly formatted name does not prove activation.
- `expect.routes`: accepted route labels. Policy-valid alternatives are listed explicitly.
- `expect.roles_required`: ordered subsequence that must appear. Order matters (for example `debugger` before `backend-worker`). For predictions without `calls` the `roles` list order is compared (legacy). With `calls`, order must be established by the calls themselves: a `chain` step precedes later steps, and a `dag` node's transitive `dependsOn` ancestors precede it (guaranteed within that one call, if the earlier steps are accepted). `tasks` entries, `dag` array position, several separate calls and background launches establish nothing: that is `order_unobserved` (not a match), while ancestry proving the reverse is `role_order`. Every dispatch of the later role needs an earlier-role ancestor. For unresolved decisions the required role is the specialist only (R02 `database-specialist`, R04 `ui-ux-specialist`); the worker stays in `roles_allowed` for after the decision. Order of allowed-but-not-required roles is not checked, so this does not prove that no write precedes the decision.
- `expect.roles_allowed`: closed set. Any other role is `role_unexpected`.
- `expect.skills_required` / `expect.skills_forbidden`: required and forbidden skill selections. Required names match exactly. A forbidden name also covers its children at a path-component boundary: `frontend` covers `frontend/solidjs-engineering`, not `frontend-tools`. A skill may not be both required and covered by a forbidden name.
- `expect.model_tiers` (optional): role -> accepted tiers (`capable`, `economy`, `omitted`; `omitted` means `modelTier` absent, so the role's configured default runs). Every dispatched entry of that role must use an accepted tier, and the role must be in `roles_required`. Cases without it are scored exactly as before. The shipped role presets are 19 `economy` and 1 `capable` (`oracle`); none of the six selected high-risk roles defaults to `capable`, so those six unambiguous high-risk cases (R02 `database-specialist`, R05 `debugger`, R09 `test-engineer`, R10 `reviewer`, R17 `concurrency-specialist`, R18 `security-specialist`) accept only explicit `capable`; omission or `economy` fails. Controls (R01, R03, R08, R15: bounded, known contract) accept `economy` or `omitted` and fail on `capable`, so universal `capable` is penalized too. This scores observed arguments; it never calls `resolveModelTier`, never supplies a tier and never guesses a model.
- `expect.max_dispatches` (optional): role -> maximum number of dispatches of that role, counted from the actual recorded `calls` across every supported mode (single, `tasks`, `chain`, `dag`, and several separate calls); the role must be in `roles_allowed`. Exceeding it is `dispatch_over`. A case that carries it but has no `calls` is `dispatch_unobserved`: absent observations are never a pass. Three near-miss cases use it (R33 one `debugger` for several symptoms of one suspected cause, R34 one `general-worker` for a one-file edit, R35 one same-role continuation after a partial REPORT). A count is not a sequence: it proves neither order nor completion and no causal link between dispatches (the existing chain/`dependsOn` rules alone establish order).
- `expect.required_reads` (optional): explicit repo-relative paths of files a case's selected skills should have been fully read from (two shipped cases: R01 and R21). It is used only by the non-scoring read diagnostics below and never by accuracy, `ok` or `critical`.
- `critical`: any mismatch in a critical case fails the run even when aggregate accuracy is high. Any forbidden skill selection is critical regardless of the flag.

## Predictions format (JSONL)
One object per fixture case with these four fields, plus the optional `calls`/`calls_provenance` pair (given together) and the optional `read_observations` object described below:

```json
{"id": "R05", "route": "T2_DEBUG_WORKER", "roles": ["debugger", "backend-worker"], "skills": [],
 "calls": [{"agent": "debugger", "task": "...", "modelTier": "capable"}, {"agent": "backend-worker", "task": "..."}],
 "calls_provenance": "session <id>, tool calls #12-#13, captured <date>"}
```

`calls` is the recorded argument object of each native `subagent` call, in the native shapes: single (`agent` + `task`, optional `modelTier`, `cwd`, `readOnly`), or exactly one of `tasks`, `chain` or `dag` whose entries carry their own `modelTier`, `cwd`, `readOnly` (a root `modelTier`, `cwd` or `readOnly` with a batch is refused or ignored by the runtime and is invalid here). Each call is validated against the native contract before any dispatch is recorded, and a call the native tool would refuse exits 2 with context and no `RESULT:`: keys (dag nodes reject unknown keys), types (`background`, `readOnly`, `confirmProjectAgents` boolean; `cwd` non-blank string; `agentScope` `user`/`project`/`both`; `modelTier` `economy`/`capable` only, so `null`, containers, numbers and unknown strings are errors), `tasks` at most 8 entries, `dag` 1-8 nodes with unique ids matching `[A-Za-z][A-Za-z0-9_-]{0,31}`, `dependsOn` a list of existing node ids with no self edge, duplicate parent or cycle. The native `chain` schema has no item limit, so none is applied. Under `agentScope` `project`, an explicit `modelTier` on the call or any batch entry is refused the same way (exit 2, `calls[N].agentScope`): project-only discovery has no canonical package roles, so the tier cannot resolve. The checks mirror the pure `validateDag` rules and the TypeBox schema in `agent/extensions/subagent/index.ts` and `dag.ts`; the tests compare the constants with that source, but the evaluator is not the native validator and does not check the agent registry beyond the known role names. The evaluator derives the dispatched agents from `calls`, so `roles` must equal them as a multiset (otherwise exit 2); only recorded calls count as tier evidence, never claimed intent. Valid arguments are not evidence that anything launched or finished: they do not prove completion, success or runtime order. `calls_provenance` is required free text saying where the capture came from; the evaluator cannot verify it. A case with `expect.model_tiers` but no `calls` scores `tier_unobserved` (critical if the case is critical), and the violations `tier_omitted` and `tier_wrong` count each failing role per case. Normalizing a raw capture into `calls` is manual and must keep its provenance; hand-written `calls` are hand-written predictions, not measurements.

### Optional read observations (non-scoring diagnostics)
A prediction may also carry `read_observations`, an object with `provenance` (required free text), `complete` (boolean) and `events` (a list of `{"path": ..., "status": ...}`). `status` is one of `full` (a successful read of the whole file), `partial` (offset/limit read), `truncated` (output cut by a limit), `failed` (attempted but errored), `injected` (context supplied, not a read call) or `retained` (context kept after compaction, not a read call). Only `full` counts as a read of a required path, and paths match by exact string equality with the fixture's `required_reads` (no normalization).

```json
{"id": "R21", "route": "SHIP_AUTHORIZED", "roles": ["release-engineer"], "skills": ["engineering-harness/ship"],
 "read_observations": {"provenance": "session <id>, main-session read tool calls #3-#5", "complete": true,
                       "events": [{"path": "agent/skills/engineering-harness/ship/index.md", "status": "full"}]}}
```

The report line `read_diagnostics` is separate from `matched`, `accuracy`, `critical_failures` and `RESULT`, and never changes them. For cases that have `required_reads`: a case with `complete: true` is measured; `required_full_read_recall` is the full-read share of required paths over measured cases and `zero_observed_read_rate` is the share of measured cases with no full read of any required path. A case with no observation, or `complete: false`, is UNKNOWN and is never counted as zero; with no measured case both rates print `UNKNOWN`. `complete: true` is the operator's statement that the trace lists every read attempt for that session scope; the evaluator cannot verify it. Subagent children run with `--no-session`, so their reads are not capturable this way, and the evaluator never reads session files or captures anything. Per-status tallies cover every provided observation. A full read is not use or activation: the diagnostics measure observed reads only, and manual labels or synthetic fixtures are never measured activation. `--self-check` synthesizes no reads.

Every case id appears exactly once. Predictions without the optional fields stay valid for fixtures without `model_tiers` or `max_dispatches`. Blank lines, unknown fields, unknown ids or roles, duplicate JSON keys and `NaN`/`Infinity` are rejected. Ids and skill names are matched in full: a trailing newline, carriage return, leading space or uppercase letter is malformed (exit 2), never stripped. Syntax-valid skill names outside the installed set are accepted as generic vocabulary. The file is never rewritten.

## Commands (run from the candidate root `~/.pi`)
- Fixture consistency: `node agent/skills/engineering-harness/scripts/evaluate-routing.mjs --cases agent/skills/engineering-harness/examples/routing-cases.json --self-check`
- Recorded predictions: `node agent/skills/engineering-harness/scripts/evaluate-routing.mjs --cases agent/skills/engineering-harness/examples/routing-cases.json --predictions <absolute path to .jsonl>`
- Unit checks: `node scripts/run-node-tests.mjs agent/skills/engineering-harness/tests/evaluate-routing.test.mjs` (or `npm test` for the whole suite).

Exit codes: `0` all matched and no critical failure; `1` mismatch or critical failure; `2` invalid input or usage. The report prints a provenance line that separates self-check output from recorded predictions. Its `sha256` is computed over the predictions file's raw bytes (CRLF files included). A UTF-8 BOM or invalid UTF-8 exits 2. JSON nested deeper than 1000 levels exits 2 with `error:` and no stack trace. Usage mistakes (missing `--cases`, both or neither of `--predictions`/`--self-check`, unknown options) also exit 2; `-h`/`--help` exits 0. Unique option prefixes (`--self`) and `--option=value` are accepted.

## What each result proves
| Input | Proves | Does NOT prove |
|---|---|---|
| `--self-check` | The fixture is internally consistent and the scorer runs | Any model or harness accuracy |
| `--self-check` tier checks | Synthetic calls mirror the expectations (labelled synthetic) | That any run requested the tier |
| Hand-written predictions | The scorer's arithmetic and labels as given | That a runtime chose those routes or skills |
| Recorded runtime observations | Agreement between recorded decisions and policy labels for those cases | Activation in other sessions, representativeness, cost or latency |
| Unit tests | Evaluator branches behave as specified | Harness accuracy |

Never report self-check or hand-written results as measured skill-activation accuracy.

## Collecting recorded routing observations (manual, when measuring)
This guide does not run models. An operator runs the fixture questions manually, in their own sessions, and records what was actually observed:
1. Freeze the fixture before running. Do not add or edit cases after seeing results.
2. For each case, record the orchestrator's chosen route, the roles actually launched, and the native `subagent` call arguments (including `modelTier` per entry) copied from the real launch calls, not intent, and the skills actually read (from tool reads of skill or module paths). A skill already loaded earlier in the same session will not appear as a read; say so rather than counting it as unselected.
3. Record provenance per case: session id, date, model, harness commit, and whether the session was fresh.
4. Write one JSONL predictions file to the assigned `_evidence` path, score it, and keep both the file and the printed report.
5. Report measured results separately from `--self-check` output.

If an operator wants repeated or paid runs, that is an explicit operator action. The evaluator, the tests and this guide never start them.

## Relation to the upstream manual check
The comparison evidence (`_evidence/baryonlabs-harness-comparison/REPORT.md`, row 3) describes an upstream manual skill-trigger guide with 20 queries (10 should-trigger, 10 should-not, near-miss emphasis). That is a human checklist and an optional optimizer concept. Its query set is not this fixture. The 36-case fixture here is derived from this repository's current policy, so the two results are not interchangeable. The upstream optimizer was not adopted, and no upstream text or code was copied.

## Node runtime notes (deliberate differences from the former Python evaluator)
Behavior, flags, report text and exit codes are unchanged; these runtime differences are intentional and pinned by `NodeRuntimeDifferenceTests` in `tests/evaluate-routing.test.mjs`:
- JSON is read by a strict built-in reader, not `JSON.parse`, so duplicate keys, `NaN`/`Infinity` and the int/float distinction stay errors exactly as before: `12.0`, `1e1` and `1.5` are floats (a float `pr` or `max_dispatches` is refused) and integers beyond 2^53 stay integers (range-checked). `__proto__` is an ordinary key.
- Nesting deeper than 1000 levels is an explicit input error (`JSON nesting too deep`, exit 2); Python relied on its recursion limit.
- "Blank" text uses Python's whitespace set (U+001C-U+001F and U+0085 are blank, U+FEFF is not), and sorted lists in error text use code-point order, so messages match the former output. Values in messages use Python-style `repr` (`'x'`, `True`, `None`, `[...]`); floats print as `1.0`.
- `accuracy` and `required_full_read_recall` use round-half-to-even at four decimals like Python's `:.4f`.
- Operating-system errors report Node's message text (the exit code is still 2), and file paths are printed as given, not normalized.
- ES module exports are read-only, so the native-parity test drifts copies of the exported `NATIVE` constant set instead of monkey-patching, and the "internal errors are not masked" test uses a throwing getter instead of a mock.

## Limits
- Expected labels are policy expectations, not ground truth from measurement.
- The case count is small; per-case results are more informative than the aggregate.
- Single-turn questions only; multi-turn routing is not covered.
- LOW, retained: route and roles are scored independently. Route/role consistency is not validated, so `T2_DEBUG_WORKER` without `debugger` (R06) or `T1_WORKER` without `backend-worker` (R07) can still pass. Consistency is a reviewer check; no policy engine was added.
- LOW, retained: predicted skill names are not checked against installed skills (intentional generic vocabulary). The test suite checks only that fixture skill names resolve to an installed `SKILL.md` or `index.md`.
- Order of allowed-but-not-required roles is not checked (see `roles_required`).
- LOW, retained: prediction lines are split on the same boundaries as Python's `str.splitlines()` (`\n`, `\r`, `\r\n`, `\v`, `\f`, U+001C-U+001E, U+0085, U+2028, U+2029), so a raw U+2028 (or similar line separator) inside a JSON string makes that line malformed. This fails closed (exit 2), never as a false PASS.
- `calls_provenance` is free text: it is not proof that a capture is authentic. The synthetic `--self-check` calls and hand-written calls are not measurements of actual main-orchestrator accuracy.
- Native call validation is a scoring input check, not a runtime permission engine; it models no tool permissions, guard or agent registry, and a call that passes still proves no launch.
- Dispatch limits cover only the three cases that carry `max_dispatches`, and read diagnostics only the two cases that carry `required_reads`; none of this measures orchestration accuracy, cost or whether a read influenced the answer.
- Tier expectations cover only the ten cases that carry `model_tiers`; they do not prove the resolved model, fallback or thinking, only that the call requested the tier.
- No cost, latency or token measurement.
