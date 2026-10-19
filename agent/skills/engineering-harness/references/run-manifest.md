# Run manifest (main-owned, complex runs only)

Read only when a complex multi-stage run needs a durable record. Optional: simple, localized or single-stage tasks do not need one. This adds no universal gate, no runtime persistence and no automatic generation.

## Role and boundaries
- Main owns and writes the manifest. Leaves never write it.
- Location: `_evidence/<task>/MANIFEST.md` in the assigned evidence root (absolute path from the task packet). Do not place it in the candidate source tree unless explicitly authorized.
- It is a durable record, not a running-job archive, scheduler, database, lock or Git permission. Writing it grants no commit, push, merge, publish or deploy authority.
- Exclude secrets, credentials, tokens, personal data (end-user or account data), raw provider payloads and full logs. Reference evidence paths instead.

## Required content
1. Goal: the user's acceptance criteria in one or two sentences.
2. Candidate: absolute path, branch, full HEAD SHA and a content fingerprint recorded at write time, following the recipe below (method, exclusions and value).
3. Authority boundaries: what is authorized, what is not, and the message reference or decision record that grants each item.
4. Accepted plan: plan path or `none (localized change)`, with acceptance date and version.
5. Current phase: DISCOVER, PLAN, EXECUTE, DEBUG, VERIFY, REVIEW, INTEGRATE, SHIP or LEARN, plus any hold (PAUSED or BLOCKED, with reason).
6. Stages: one row per job with stage id, job or task, actual named role, status, check result and evidence path.
7. Open items: every FAILED, BLOCKED, PAUSED or UNKNOWN stage, and every pending decision with owner and the decision needed.
8. Next authorized action: one action, its owner and the authority it relies on.
9. Change log: dated entries; any write marks affected checks STALE.

## Candidate fingerprint recipe
A documented recipe, not a runtime subsystem: no script or hook enforces it, and recording one proves no consumer checks freshness. Keep the detailed records in MANIFEST/REPORT evidence, not the compact PLAN, and reuse them for unchanged inputs instead of rehashing the repository for every task.
1. Bind the record to the candidate path and the full HEAD SHA.
2. List relevant paths with `git status --porcelain=v1 -z --no-renames --untracked-files=all`. It is NUL-safe, covers staged, unstaged and untracked paths, and `--no-renames` records a rename as a delete plus an add.
3. Write one sorted record per path from the actual working bytes: a regular file as `file <path> <digest>` using `git hash-object --no-filters` (raw bytes, no EOL normalization); a symlink as `link <path> <digest of the link text>`, never followed; a path whose absence is confirmed (ENOENT/ENOTDIR) as `deleted <path>`. Any other inspection failure (EACCES, EIO, unknown) is not absence: record it `UNSUPPORTED`, never `deleted`.
   Encoding: the digest input is a JSON array of typed arrays of strings (`["HEAD",sha]`, `["file",path,digest]`, `["deleted",path]`, `["UNSUPPORTED",path,reason]`, `["staged",digest]`, `["exclude",prefix]`), never newline- or space-joined text, so a pathname (even one containing a newline) cannot impersonate a record or field boundary. Pathnames are kept verbatim; a pathname that is not valid UTF-8 cannot be represented without folding, so record it `UNSUPPORTED` (by raw-byte hex) rather than altering it.
4. Also record a digest of `git diff --cached --binary --no-renames`: staged content can differ from the working bytes while `git status --short` and the diff stat stay identical.
5. A directory, submodule, unreadable entry or anything else not listed above is recorded as `UNSUPPORTED <path>`. Unsupported input cannot support a fresh PASS: treat the affected evidence as unknown until it is inspected explicitly.
6. Name excluded artifact paths (evidence, scratch, build output) in the record and include that list in the digest input. Do not read private, ignored or generated inputs, or symlink targets, merely to build a fingerprint.
Two same-size edits to one file keep status and the diff stat identical but produce different digests under this recipe. `agent/extensions/subagent/tests/candidate-fingerprint.test.ts` demonstrates same-size, staged-only, index-only, untracked, deleted, renamed, exclusion, unsupported, inspection-failure (fault-injected), newline-pathname boundary and link cases on a disposable repository (the link case is skipped where symlink creation is not permitted). A later relevant change invalidates the affected evidence.

## Status vocabulary
- `PLANNED`: not launched.
- `LAUNCHED`: launch receipt only. A receipt is not completion.
- `PASS` / `FAIL` / `BLOCKED` / `ESCALATE`: from an actual recovered result with its check evidence.
- `PAUSED`: held by the user or main; do not resume without an explicit release.
- `UNKNOWN`: no actual result was recovered. Investigate; never treat as PASS.
- `NOT RUN`: intentionally not executed, with the reason. Distinct from UNKNOWN.

## Rules
- Aggregate readiness cannot be PASS while any affected stage is FAIL, BLOCKED, UNKNOWN or PAUSED. An unrelated passing stage does not clear a failed one.
- A failed affected stage returns to PASS only after it is actually repaired and re-verified, with new evidence paths.
- Any new write invalidates the affected checks: mark them STALE and rerun them before PASS.
- Job IDs from earlier sessions are historical references only. Never resume a job by its old ID after a reload.

## Usage summary (optional, complex runs)
- Record the total under the token-efficiency.md "Usage record accounting" rule: unique attempts, partial when a record is missing, and cached usage and cost stay separate from uncached input and output. Do not estimate a missing attempt.

## Resuming after a reload
1. Inspect the actual candidate: branch, HEAD and fingerprint against the manifest.
2. Inspect the evidence files named in the stage rows.
3. Inspect live process owners, if any. Do not assume a running job still exists.
4. Keep every ACTIVE hold (user stop, pause, queued item, pending decision) unchanged. Do not clear it to continue. A hold moves to satisfied only on a documented accepted disposition or authorized transition, recorded with its reference; a worker PASS is not acceptance, and a user pause, stop, security or no-publication restriction is never cleared automatically.
5. Record what was verified and update the change log before the next action.

## Template

````markdown
# Run manifest: <task-slug>

## Goal
<one or two sentences; user acceptance criteria>

## Candidate
- Path: <absolute candidate path>
- Branch: <branch>
- HEAD: <full SHA at record time>
- Fingerprint: <recipe, exclusions, UNSUPPORTED paths and value>
- Recorded: <YYYY-MM-DD HH:MM>

## Authority boundaries
- Authorized: <scope>
- Not authorized: <explicit list>
- Reference: <message ref or decision record path>

## Accepted plan
- Plan: <path or none (localized change)>
- Accepted: <date>, version <id>

## Current phase
- Phase: <phase>
- Hold: <none | PAUSED: reason | BLOCKED: reason>

## Stages
| Stage | Job / task | Role | Status | Check result | Evidence path |
|---|---|---|---|---|---|
| S1 | <task> | <actual role> | <status> | <command and result, or NOT RUN: reason> | <absolute path or none> |

## Open items
- <stage, status, owner, what is needed>
- Pending decisions: <question, owner, blocked scope>

## Next authorized action
- Action: <one action>
- Owner: <main or named role>
- Authority: <reference>

## Change log
- <YYYY-MM-DD HH:MM> <change; affected checks marked STALE>
````

## Filled example (synthetic task)
Task: add a header check to a fictional `sample-exporter` CLI. Paths and IDs are invented.

````markdown
# Run manifest: sample-exporter-header-check

## Goal
Reject CSV exports whose header row is missing the `record_id` column. Acceptance: unit test passes and an independent verifier confirms.

## Candidate
- Path: C:/synthetic/worktrees/sample-app
- Branch: feat/sample-exporter-header
- HEAD: 0123456789abcdef0123456789abcdef01234567
- Fingerprint: sha256 over HEAD, per-path content digests and the staged-patch digest = 9f2c...e1 (synthetic); exclusions: _evidence/, _scratch/
- Recorded: 2026-01-10 09:00

## Authority boundaries
- Authorized: edits inside the candidate; focused tests.
- Not authorized: commit, push, merge, publish.
- Reference: user message ref m00012 (synthetic).

## Accepted plan
- Plan: none (localized change)

## Current phase
- Phase: VERIFY
- Hold: none

## Stages
| Stage | Job / task | Role | Status | Check result | Evidence path |
|---|---|---|---|---|---|
| S1 | header check in exporter | general-worker | PASS | unit test: 1 passed (synthetic) | C:/synthetic/worktrees/_evidence/sample/S1.txt |
| S2 | independent verify | test-engineer | FAIL | edge case: header with BOM is rejected (synthetic) | C:/synthetic/worktrees/_evidence/sample/S2.txt |
| S3 | repair BOM handling | general-worker | PASS | unit test: 2 passed (synthetic) | C:/synthetic/worktrees/_evidence/sample/S3.txt |
| S4 | re-verify after repair | test-engineer | LAUNCHED | receipt only; no result yet | none |

## Open items
- S4 LAUNCHED: no result recovered. Aggregate is not PASS until its real result is read.
- S1 PASS does not clear S2 FAIL; S2 is cleared only by S4 evidence.

## Next authorized action
- Action: read the actual S4 result from its evidence path.
- Owner: main
- Authority: task authorization for focused verification.

## Change log
- 2026-01-10 09:40 S3 repair changed the candidate; S1 and S2 checks marked STALE.
````

The example shows the aggregate rule: S1 passed, S2 failed, and the run is not PASS until S3 is repaired and S4 yields a real result.
