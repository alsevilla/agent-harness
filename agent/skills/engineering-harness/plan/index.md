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

Resolve relative references from this module folder. This procedure supplies guidance; main still owns lifecycle sequencing and actual named-agent launches.
