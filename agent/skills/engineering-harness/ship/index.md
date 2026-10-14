## SHIP procedure
This procedure belongs to the `release-engineer` role when SHIP is selected by main.

Use only when the user/task requires delivery, release, merge/push/tag/package/publish/deploy readiness or another explicit shipping operation.

Require a task packet with:
- exact candidate and version;
- destination/release target;
- required fresh-enough verification/review evidence;
- migrations/config/artifacts that must be accounted for;
- rollback/recovery prerequisites;
- exact operation authority.

Confirm:
- candidate/version identity;
- required tests/review are fresh enough;
- migrations/config/artifacts are accounted for;
- release target/platform is correct;
- rollback/recovery is viable for the approved scope;
- destination and authority are explicit.

Before an authorized commit or PR, read `../references/git-attribution.md`. Readiness supplies no operation authority.

After a verified merge (including squash/rebase), release engineer owns safe cleanup of explicitly named task-owned worktrees under `../worktree/index.md`. Main retains scheduling, exact candidate/target identity, approvals, terminal-owner/quiescence evidence and coordination. If the delivery worker ran inside the candidate, return MERGED with CLEANUP_PENDING; main schedules a cleanup release engineer from outside the target only after that worker is terminal. PR-only delivery never triggers removal of its unmerged candidate. Readiness does not authorize cleanup.

After successful merge and task-owned artifact disposition, main evaluates verified reusable lessons with bounded dedup. Main selects and coordinates any LEARN work; only the release engineer performs authorized persistence to the exact named canonical knowledge destination and verifies its content before reporting SAVED. The terminal knowledge-disposition checkpoint is SAVED (exact path/evidence), NO LESSON (reason), or BLOCKED (specific evidence, destination, or authority gap). Archiving a report or fixture is evidence, not learning completion. If learning is BLOCKED after merge, report that gap without implying rollback of the completed merge.

Do not repair product source in SHIP. Return implementation defects to main for the appropriate writer. Do not run SHIP for ordinary coding completion.
Load `references/extended.md` for release-critical workflows.

Resolve relative references from this module folder. This procedure supplies guidance; the selected `release-engineer` role still must actually run.
