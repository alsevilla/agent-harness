# Token-efficient handoff and routing reference

Read only when investigating token consumption, oversized results, repetitive routing or chain prompt growth. This reference adds no mandatory role or lifecycle gate.

## Orchestrator
- Keep task goal, acceptance criteria, exact candidate and authority boundaries.
- Choose a narrow role once; reuse the decision until new evidence changes risk.
- Main reads at most 3 named files and runs only read-only `git status`/`rev-parse`/`diff --stat`/`log -1` itself (a known file goes straight to one worker, no scout; a HEAD SHA question is answered by main). Every other read, search and code/test run is delegated to the narrowest read-only role as one question-driven read packet per decision point; the leaf reads the referenced evidence. Do not re-read full code, worker logs or the skill catalog after a successful handoff.
- Scout and digest replies carry verbatim snippets and path:line for failures, blockers, security/data risks and PASS claims; main never accepts PASS from a digest, mandatory VERIFY/REVIEW read REPORTs themselves, and evidence reuse stays hash-based.
- Skip `scout` when exact source scope is already known; avoid routine `oracle` or reviewer calls.
- Let implementation workers run focused relevant checks; reserve independent roles for critical risks per existing policy. Never skip justified independent checks.
- Keep PLAN, DECISION, INTEGRATE sequencing with main.
- Before dispatch, preflight each packet once: task, role scope, exact candidate, authority boundary, acceptance checks and scratch/evidence paths. For an optional role, state the unresolved question and the decision its answer changes; omit the role if neither exists. Required independent checks stay required. Drop anything outside that role.
- Reference a shared governing contract or evidence path instead of pasting history or full prior reports into several packets. Put reusable common context in one artifact and send only the role-specific delta.
- State only deviations from leaf, local-only and native-tool boilerplate; name a module only when it differs from the role default; omit instructions meant for other roles.
- Guidance only, not a runtime-enforced budget or token measurement. Never drop a critical risk, failed check or blocker to meet a length target.

## Bounded checklist and evidence reuse
- Before dispatch and at completion, list each required check once: acceptance checks, RED/GREEN focus checks, and UI focus/browser only when UI is affected or assigned (not universal). Each item ends as a result (command, exit code, outcome), NOT RUN with its reason, or a justified not-applicable with its reason. No item is dropped silently.
- Reuse a prior PASS or RED/GREEN result only for unchanged tested bytes (HEAD plus a scoped diff hash or changed-file content hashes), the same relevant environment (runtime, dependencies and configuration the check reads) and the same contract. Otherwise rerun the affected checks, not the whole suite.
- Cite the canonical REPORT path for earlier results instead of copying them into new packets.

## Compaction batching
- Compact only ranges the reply or a finished step has consumed (tool output, resolved threads). Batch consumed ranges into one batched compaction call instead of folding after every reply.
- Each summary keeps open goals, active holds (user pause, stop, no-publication restriction), live job IDs and candidate identity. Split an oversized range into several smaller summaries in the same call.
- Do not fold a range that still holds an unresolved decision or an unconfirmed result.

## Main-session compaction
If a context-compaction call fails on a reference mismatch, first use host-provided reference or range discovery, then retry with those values. Do not guess references, reuse invalid ones, or repeat the unchanged failed call. If discovery is unavailable, pause compression and keep the current state (goal, holds, open objectives, candidate identity) in context. Reference management belongs to the host/provider layer; this repository implements none. This is a safer retry rule only; it does not establish or fix any external proxy or model-output cause.

## Child final report
Child system prompts for roles with a prompt body get the final-handoff format from `agent/extensions/subagent/compact-handoff.ts` (`COMPACT_HANDOFF_INSTRUCTIONS`). That constant is the only copy of the four-line format: normally `STATUS` (outcome; failed or required NOT RUN checks named here), `NEXT`, `RISKS` and `EVIDENCE` (one primary absolute REPORT path), not a strict ceiling.

This is prompt guidance, not proof of obedience. Failed or required NOT RUN checks, blockers, material security/data risks, material UNKNOWN and pending decisions stay in the reply even when it exceeds the budget; unassigned checks are listed only when material to interpreting the result. Changed files, commands, hashes and logs go to the REPORT.

## Role prompt restatement dedup
Live role bodies (`agent/agents/*.md`) do not repeat "Never spawn another agent." or "Never spawn helpers.": the Leaf boundary already forbids launching helpers. Packaged defaults drop the same two phrases at build time (`ROLE_BODY_DEDUP` in `scripts/build-pi-package.mjs`) from the pinned baseline bodies; `agents_sha256` in `defaults/baseline.json` hashes those packaged bytes. Graph guidance states the write-authority limit without repeating the artifact-placement candidate rule. Role-specific rules, frontmatter and headings are unchanged.

## Compact child context (first slice)
Integration-enabled, non-project, non-`release-engineer` children load `child-context-entry.ts` through one extra `--extension` pair (inserted before the integration extensions, because Graphify forces the rendered prompt). On `before_agent_start` it replaces only the context entry whose path is the public agent-dir resolver's `AGENTS.md` AND whose CRLF->LF content digest equals the reviewed canonical policy with `COMPACT_LEAF_CONTRACT` (`child-context.ts`). Project/ancestor files (even with identical bytes), edited or custom globals, duplicates, odd shapes and handler errors keep the full context; the main session never loads the entry. Maintenance: any `agent/AGENTS.md` edit changes the digest, so update `REVIEWED_POLICY_SHA256`, the contract and the line manifest in `tests/child-context.test.ts` together; until then children simply keep the full policy. The saving is a character count of instructions, not a measured token, cost or latency effect.

## Runtime result handling (current implementation)
- Foreground runs: not capped by this change. The visible text keeps the existing extraction (`getFinalOutput` in `index.ts` → `extractFinalText` in `compact-handoff.ts`: every text block of the latest text-bearing assistant message, joined by newlines).
- Background automatic completion: every notice, short or long, is one parseable JSON object (`pi.subagent.completion.v1`) whose total serialized length is at most 4,000 UTF-16 units by default; a root `noticeLimit` (safe integer, background only, at least the derived minimum 868, from the worst skeleton) changes it per job. Runtime fields (job, state, workers, `availableAtEmission`, the `bg-N@epoch` target and structured `retrieve` call) are separate from the quoted child strings in `untrusted` (`priorityLines`: failure, blocker, check and verdict lines kept first; `excerpt`: head text). Execution state is not task acceptance; never infer PASS from the notice. A small notice grows by about 435 characters of fixed fields (compact tags `mem64`, `evicted-no-outcome`; a partial note carries the legacy `INCOMPLETE HANDOFF` marker inside the JSON); no token, cost or speed gain is claimed or measured. `availableAtEmission` is a snapshot at emission only.
- Explicit `subagent_control` `result` for a retained job: lossless and unbounded. Each child gets a heading `### <agent> — completed` or `### <agent> — FAILED/STOPPED` (with `ERROR:` from `errorMessage` or `stderr`), then all text blocks of its latest text-bearing assistant message. Children are separated by `---`. A job without retained child details returns its stored result unchanged.
- Chain `{previous}`: the complete final text of the previous step (all text blocks joined), not an excerpt. Existing error and abort flags stay authoritative.
- Retention: the runtime keeps at most 64 finished background jobs for recovery (earliest-started evicted first, applied before the notice), in memory only until new/resume/fork/reload. This is not a durable archive or the SDK transcript; older results are not recoverable and evidence belongs in `_evidence`. A missing, evicted, reset or other-epoch target is an explicit unavailable error with no outcome implied and no automatic rerun.
- Child output is not redacted. The 4,000-character bound is a size control, not a secret or PII control.

## Measurement
Measure orchestrator input/output tokens separately from child tokens and provider cached tokens. Compare equal-complexity tasks and review quality, not only request counts. Reduced orchestrator input can increase total cost when unnecessary agents are spawned. No measured token or cost saving is established by this change; use actual observations.

### Usage record accounting
- Total: sum unique model attempts from existing usage records across main, worker, specialist, verify and retries; report the total as partial when a record is missing and name the missing attempt; do not estimate it.
- Reasoning: reasoning tokens already included in reported output tokens are not added again.
- Cache: cached input usage and cost are reported separately from uncached input and output.
- Scope: guidance only: no collector, recorder, schema or budget is added; read the records that already exist.

### Static prompt size (characters, not tokens)
`node --experimental-strip-types scripts/measure-child-prompt.mjs --label <name> --out <absolute dir outside the repository> [--agent-dir <empty absolute dir outside the repository>]` writes `measure-<name>.json` and each assembled prompt for five roles, in live and package shapes. `--agent-dir` measures the missing-integration profile; a non-reviewer launch is refused when Ponytail is absent, as in `index.ts`. The script reports characters and hashes only; it does not count tokens.

### Benchmark procedure (only when authorized; paid runs are not part of this repository)
Use cost per successfully solved task: total billed cost of all attempts, including failures and retries, divided by the number that pass the same acceptance checks. Report success rate alongside it; when none succeed, report cost and zero successes rather than a ratio.

1. Freeze task fixtures, acceptance checks, starting commit, tools, model, thinking level, fallback policy, run/time limits and integration availability. Use the same model for main and workers in the initial comparison so role/model differences do not confound delegation. Record cold/warm cache conditions and actual serving models.
2. Compare these arms under those conditions:

   | Configuration | Question |
   |---|---|
   | Strong single agent with the same model and tools | Does delegation improve success enough to pay for itself? |
   | Harness with request shaping disabled | What does delegation itself cost? |
   | Current full Pi harness | What do the shaping mechanisms save together? |
   | Full harness with one mechanism disabled per arm | Which mechanisms contribute? |

   Record the exact revision and settings for every arm. Disabling shaping includes handoff masking, worker masking, duplicate-read suppression, ledger, output caps and main folds; use documented controls where available and record any experimental patch for mechanisms without an off switch. This procedure adds no global toggle.
3. Test mechanical fixes, debugging, multi-file features and long sessions separately. Repeat each task/arm the same predeclared number of times and vary run order. Long-session checks place requirements and authorization limits at the beginning, middle and end of long user messages, then check them after repeated folds.
4. Measure mandatory T0 delegation separately against a narrowly scoped experimental direct T0 route; if retaining the orchestrator boundary, compare several related mechanical actions batched into one worker launch. Record worker startup/packet/handoff overhead. These are experimental arms, not changes to the shipped routing policy.
5. Record per run: success/acceptance evidence, requirement violations, main and child input/output/cache-read/cache-write tokens, billed cost including all failed attempts and retries, elapsed time, and missing usage records. Keep static characters or tokenizer estimates separate from provider usage and billing.
6. Report success rate, total cost per success, medians and spread with run count, failures and retries, plus the fixed-condition table. Differences within run-to-run variation are not demonstrated savings. Missing usage makes cost accounting partial.
7. Benchmark Pi and Copilot separately. Request shaping is Pi-only; Copilot constructs its own requests. Shared guidance and hooks establish no equivalent token or billed saving. Keep model-inference results distinct from runtime/mock tests and static prompt-size measurements.
