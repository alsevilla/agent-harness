# Harness knowledge

Pi-specific decisions and procedures: profile routing, worker roles, extension behavior and runtime setup. Authoritative definitions stay in repo-relative `agent/AGENTS.md`, `agent/skills/` and `agent/extensions/`; records here point to them and do not duplicate them. Each record uses the inline fields in `../README.md`.

## Explicit post-merge knowledge disposition
- Claim: Archiving reports or fixtures is evidence, not LEARN persistence; post-merge knowledge disposition is SAVED (actual authorized write verified by readback), NO LESSON (reason), or BLOCKED (specific gap).
- Source: [`LEARN` procedure](../../../agent/skills/engineering-harness/learn/index.md) and [`WORKTREE` procedure](../../../agent/skills/engineering-harness/worktree/index.md); those procedures remain authoritative.
- Evidence status: Verified accepted workflow decision and static-policy coverage in external evidence artifact post-merge-cleanup/REPORT.md: 11 contract tests and 21 registry tests passed (registry rerun with extended timeout); live post-merge cleanup was not tested.
- Context and date: Post-merge artifact and knowledge disposition; 2026-10-14.
- Revalidate when: LEARN/WORKTREE ownership, terminal dispositions or supporting contract tests change.

## Omitted task tier preserves the role default
- Claim: Omitted `modelTier` can run economy; consequential work on an economy-default role needs configured `capable` selected before launch, or unresolved selection returned to main.
- Source: [`routing.md` — Explicit Pi model tier](../../../agent/skills/engineering-harness/references/routing.md#explicit-pi-model-tier), [`runtime.md` — Models](../../../agent/skills/engineering-harness/references/runtime.md#models), [`resolveModelTier`](../../../agent/extensions/subagent/model-routing.ts) and [real-registry scenarios](../../../agent/extensions/subagent/tests/role-registry.test.ts).
- Evidence status: Verified policy and static resolver/real-registry regression coverage in external evidence artifacts pr2-review-fixes/IMPLEMENTATION.md and pr2-review-fixes/REVIEW.md; 33 registry tests passed with a 60-second timeout, while default-5-second runs had pre-existing timeout failures. Not live LLM tier-selection compliance or measured savings; Pi-only, not Copilot model selection.
- Context and date: Per-task tier selection without changing stored role defaults; 2026-10-14.
- Revalidate when: Routing policy, model-tier schema, resolver or role defaults/capabilities change.

## Exact-operation grants bind tool cwd and command
- Claim: Exact-operation grants require matching recorded tool cwd and command; `git -C` does not rebind cwd, so an authorized worker must match issuer cwd while preserving the approved target command.
- Source: [`runtime.md` — Pi runtime](../../../agent/skills/engineering-harness/references/runtime.md#pi-runtime) and [`safety-core.ts` — keyOf, claimChildGuard and guardToolCall](../../../agent/extensions/subagent/safety-core.ts).
- Evidence status: Verified cwd mismatch root cause and in-memory claim/consume proof in external evidence artifact task-model-tiers/TIER-ONLY-AUTHORIZATION-DEBUG-REPORT.md; real commit/push succeeded with matching issuer cwd and unchanged approved commands in task-model-tiers/TIER-ONLY-DELIVERY-FINAL-REPORT.md. Applies to exact-operation grants, not a bypass or general delivery prerequisite; internal read-only neutral-cwd lookups and explicit candidate-boundary leases are distinct.
- Context and date: Exact-command authorization across issuer/worker contexts; 2026-10-14.
- Revalidate when: Authorization policy, grant schema, cwd canonicalization, claim/consume matching or lease semantics change.
