## PLAN procedure
This lifecycle procedure is owned by the **main orchestrator**, not by a leaf specialist.

Use only when sequencing/dependencies/risk justify an explicit execution plan.

Produce:
- scope + acceptance criteria;
- ordered implementation steps;
- writer ownership;
- specialist gates only where justified;
- focused verification;
- rollout/rollback/recovery concerns if relevant.

Architecture analysis may feed PLAN, but `architecture-specialist` does not own PLAN and must not sequence or launch other agents. Main incorporates accepted architectural constraints into the execution plan.

For localized work, skip formal PLAN and send a compact worker packet instead.
Load `references/extended.md` only for complex plans.

## Durable plan state
A PLAN written to a file, or a multi-job resume queue, is the current governing state, not a transcript of the job history. Keep it concise: user goal, queued order, critical scope and acceptance constraints, remaining gaps; per entry, status, current owner/job, next action, ACTIVE holds, and absolute pointers to existing task reports or evidence. Put per-job hashes, metrics and history in the task report or evidence file, not in the current plan paragraph.

Update main-authored state in place: replace or remove superseded statuses instead of appending conflicting ones. Before condensing history, confirm that its durable evidence has a verified pointer; if not, preserve it elsewhere first. Never delete user-written content and do not invent reports. An append-only changelog may sit beside the plan but is not the primary next action.

Resolve a dependent hold only on a documented accepted disposition or authorized transition. A worker PASS is not acceptance. A user pause, stop, security or no-publication restriction is not cleared automatically. Keep active UNKNOWN or BLOCKED evidence gaps explicit. Synthetic example: `PAUSED by user (ref m00042)` stays ACTIVE until the user releases it; `reviewer acceptance pending` becomes satisfied only when its accepted disposition is recorded.

Read cadence: the orchestrator reads the relevant PLAN state when it resumes, schedules or transitions work, and when an entry looks stale. It does not reread the full plan every turn. An initial resume reads the shared constraints, queue order and global holds first; later steps use the current entry, its dependencies and the global holds. A bounded read never excuses missing a stop, privacy, no-publication or UNKNOWN item.

A synthetic current-state entry (fictional paths and job IDs, pointing at no real run) is a sketch, not a schema; localized tasks still skip a formal PLAN:

```text
- Entry: synthetic-task-A (fictional)
  - Status: current phase VERIFY; PAUSED
  - Owner: test-engineer, job synthetic-job-0042 (fictional), PAUSED by user, tracked in the current session registry
  - Completed: schema draft reviewer-accepted; brief outcome only
  - Gap/hold: `PAUSED by user (ref m00042)` stays ACTIVE until released; export-path security review UNKNOWN
  - Next: resume the verify job once the user releases the pause; no other action is authorized
  - Scope/acceptance: C:/synthetic/plan-example/acceptance.md (fixed criteria, not copied here)
  - Evidence: C:/synthetic/evidence/synthetic-task-A/verify-report.md
```

Updating an entry replaces the obsolete owner or status in place; do not append a second status line or a duplicate history block. A launch receipt means launched only, not running or done. A paused owner stays current while the current session registry tracks its job; it is ACTIVE or running only when the registry lists it so, and resumes only after explicit user release. An old job ID is historic and not resumable. A worker PASS is not acceptance, browser verification or a cleared hold. Keep fixed acceptance criteria in one canonical linked document, and keep essential authority, security constraints and active holds visible in the entry. Hashes, test counts, old jobs and history stay in the evidence report; the entry keeps only a brief outcome.

Entry shape (current state only): a completed entry is STATUS + one brief outcome + canonical evidence link; an active entry is STATUS + current owner/job + one next action + ACTIVE holds + evidence link. Before writing, self-check that no superseded status, hash, test count, old job ID or detailed acceptance history was copied in, and replace the same entry instead of appending. If such history lacks a verified durable pointer, move it to the task report or archive first. Never delete preserved authority, security/privacy scope, unknowns, unsatisfied acceptance or holds to meet a length target.

Resolve relative references from this module folder. This procedure supplies guidance; main still owns lifecycle sequencing and actual named-agent launches.
