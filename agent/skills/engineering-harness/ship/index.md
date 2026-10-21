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

Ordinary delivery (task-owned commit, non-force feature push, PR create and same-owned PR edit) runs automatically through the structural trusted `release-engineer` context once main has confirmed every required check passed on the exact candidate and no local-only/no-publication instruction applies; no extra approval prompt. Do not call `request_authorization`, and do not mint a push lease or any delivery grant for PR-only intent. Automatic PR edit is limited to `--title`/`--body`/`--body-file` on an open PR of the task feature branch in the origin repo (live view: same-repo, not cross-repository); it never changes the base, reviewers, labels or state. The runtime cannot check required checks or local-only intent: they are main's launch gate, and a failed/blocked check or local-only task returns the local result with no release-engineer launch. The trusted context is fixed from HEAD at spawn, so create or switch the candidate to the feature branch before launching the child and give it the candidate root as cwd. Commit text uses `git commit -m "<ASCII text>"` or `git commit -F "<abs .md/.txt file>"` with double quotes. Packets name exact artifact paths `<primary-parent>/worktrees/<origin repo name>/_evidence/<task>` (or `_scratch`; the legacy primary-checkout-basename group is also accepted). Merge and release each need their own explicit user approval and their own `request_authorization` `delivery` grant (`action: "merge"` or `"release"`): merge names the exact PR and the approved candidate HEAD SHA and is bound to the verified candidate fingerprint (`bind.expect`); release names the exact PR, version and target SHA (the merge commit) and is refused when the tag already exists. A merge approval never authorizes a release and vice versa, neither is inferred from commit, push, PR, an earlier approval or each other, and single-use `operations` grants are refused for both. Legacy combined delivery grants are rejected. `request_authorization` is only for a command the guard genuinely blocked or other risky operations.

After a verified merge (including squash/rebase), release engineer owns safe cleanup of explicitly named task-owned worktrees under `../worktree/index.md`. Main retains scheduling, exact candidate/target identity, approvals, terminal-owner/quiescence evidence and coordination. If the delivery worker ran inside the candidate, return MERGED with CLEANUP_PENDING; main schedules a cleanup release engineer from outside the target only after that worker is terminal. PR-only delivery never triggers removal of its unmerged candidate. Readiness does not authorize cleanup. Explicit user-authorized disposal of dirty or retired checkouts is the separate Authorized retirement mode in `../worktree/index.md`, never part of routine post-merge cleanup.

Before the final commit or PR, main selects LEARN when warranted. The knowledge-disposition checkpoint (SAVED, NO LESSON or BLOCKED) is canonical in `../learn/index.md`. Post-merge cleanup follows the knowledge gate in `../worktree/index.md`: a local SAVED checkpoint outside every deletion target, or a NO LESSON checkpoint; shared publication is verified only when separately authorized. Archiving a report or fixture is evidence, not learning completion.

Do not repair product source in SHIP. Return implementation defects to main for the appropriate writer. Do not run SHIP for ordinary coding completion.
Load `references/extended.md` for release-critical workflows.

Resolve relative references from this module folder. This procedure supplies guidance; the selected `release-engineer` role still must actually run.
