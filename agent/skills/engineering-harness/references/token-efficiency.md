# Token-efficient handoff and routing reference

Read only when investigating token consumption, oversized results, repetitive routing or chain prompt growth. This reference adds no mandatory role or lifecycle gate.

## Orchestrator
- Keep task goal, acceptance criteria, exact candidate and authority boundaries.
- Choose a narrow role once; reuse the decision until new evidence changes risk.
- Do not re-read full code, worker logs or the skill catalog after a successful handoff.
- Skip `scout` when exact source scope is already known; avoid routine `oracle` or reviewer calls.
- Let implementation workers run focused relevant checks; reserve independent roles for critical risks per existing policy. Never skip justified independent checks.
- Keep PLAN, DECISION, INTEGRATE sequencing with main.
- Before dispatch, preflight each packet once: task, role scope, exact candidate, authority boundary, acceptance checks and scratch/evidence paths. Drop anything outside that role.
- Reference a shared governing contract or evidence path instead of pasting history or full prior reports into several packets. Put reusable common context in one artifact and send only the role-specific delta.
- Do not repeat fixed policy already in the child prompt, and omit instructions meant for other roles.
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

## Runtime result handling (current implementation)
- Foreground runs: not capped by this change. The visible text keeps the existing extraction (`getFinalOutput` in `index.ts` → `extractFinalText` in `compact-handoff.ts`: every text block of the latest text-bearing assistant message, joined by newlines).
- Background automatic completion: the follow-up message is at most 4,000 characters. Longer output begins with `INCOMPLETE HANDOFF: job <id> output exceeds 4000 chars ...` and the exact recovery call `subagent_control action "result" target "<id>"`, then up to 8 priority lines (STATUS, RISKS, WARNINGS, BLOCKERS, ERROR(S), CHECKS, NEXT, and failure keywords), an excerpt, and `[TRUNCATED: do not infer PASS from this excerpt.]`. Never infer PASS from the excerpt.
- Explicit `subagent_control` `result` for a retained job: lossless and unbounded. Each child gets a heading `### <agent> — completed` or `### <agent> — FAILED/STOPPED` (with `ERROR:` from `errorMessage` or `stderr`), then all text blocks of its latest text-bearing assistant message. Children are separated by `---`. A job without retained child details returns its stored result unchanged.
- Chain `{previous}`: the complete final text of the previous step (all text blocks joined), not an excerpt. Existing error and abort flags stay authoritative.
- Retention: the runtime keeps at most 64 finished background jobs for recovery. This is not a durable archive; older results are not recoverable and evidence belongs in `_evidence`.
- Child output is not redacted. The 4,000-character bound is a size control, not a secret or PII control.

## Measurement
Measure orchestrator input/output tokens separately from child tokens and provider cached tokens. Compare equal-complexity tasks and review quality, not only request counts. Reduced orchestrator input can increase total cost when unnecessary agents are spawned. No measured token or cost saving is established by this change; use actual observations.
