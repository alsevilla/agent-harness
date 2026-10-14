# Harness knowledge

Pi-specific decisions and procedures: profile routing, worker roles, extension behavior and runtime setup. Authoritative definitions stay in repo-relative `agent/AGENTS.md`, `agent/skills/` and `agent/extensions/`; records here point to them and do not duplicate them. Each record uses the inline fields in `../README.md`.

## Explicit post-merge knowledge disposition
- Claim: Archiving reports or fixtures is evidence, not LEARN persistence; post-merge knowledge disposition is SAVED (actual authorized write verified by readback), NO LESSON (reason), or BLOCKED (specific gap).
- Source: [`LEARN` procedure](../../../agent/skills/engineering-harness/learn/index.md) and [`WORKTREE` procedure](../../../agent/skills/engineering-harness/worktree/index.md); those procedures remain authoritative.
- Evidence status: Verified accepted workflow decision and static-policy coverage in external evidence artifact post-merge-cleanup/REPORT.md: 11 contract tests and 21 registry tests passed (registry rerun with extended timeout); live post-merge cleanup was not tested.
- Context and date: Post-merge artifact and knowledge disposition; 2026-10-14.
- Revalidate when: LEARN/WORKTREE ownership, terminal dispositions or supporting contract tests change.
