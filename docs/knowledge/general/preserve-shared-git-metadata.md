# Preserve shared Git metadata before primary removal

- Claim: Deleting a primary repository's shared `.git` strands linked worktrees whose `.git` files point into it; preserve or migrate that metadata first, and remove ordinary worktrees only with clean, integrated, idle, task-owned proof.
- Source: [Git worktree documentation — DETAILS](https://git-scm.com/docs/git-worktree#_details); [`WORKTREE` procedure](../../../agent/skills/engineering-harness/worktree/index.md).
- Evidence status: Verified dangling-pointer diagnosis in external evidence artifact copilot-cli/MODEL-DEFAULTS-GIT-DEBUG-REPORT.md, corroborated by external evidence artifact copilot-cli-recovery/RECOVERY-REPORT.md; deletion versus relocation and actor remain unknown. Safe primary removal/migration was not tested. No new test execution for this migration.
- Context and date: Linked-worktree recovery; 2026-10-14. Migrated to a focused record on 2026-10-15.
- Revalidate when: Git's shared-metadata layout or the authoritative cleanup procedure changes.
