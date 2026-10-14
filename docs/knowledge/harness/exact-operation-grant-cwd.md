# Exact-operation grants bind tool cwd and command

- Claim: Exact-operation grants require matching recorded tool cwd and command; `git -C` does not rebind cwd, so an authorized worker must match issuer cwd while preserving the approved target command.
- Source: [`runtime.md` — Pi runtime](../../../agent/skills/engineering-harness/references/runtime.md#pi-runtime) and [`safety-core.ts` — keyOf, claimChildGuard and guardToolCall](../../../agent/extensions/subagent/safety-core.ts).
- Evidence status: Verified cwd mismatch root cause and in-memory claim/consume proof in external evidence artifact task-model-tiers/TIER-ONLY-AUTHORIZATION-DEBUG-REPORT.md; real commit/push succeeded with matching issuer cwd and unchanged approved commands in task-model-tiers/TIER-ONLY-DELIVERY-FINAL-REPORT.md. Applies to exact-operation grants, not a bypass or general delivery prerequisite; internal read-only neutral-cwd lookups and explicit candidate-boundary leases are distinct. No new test execution for this migration.
- Context and date: Exact-command authorization across issuer/worker contexts; 2026-10-14. Migrated to a focused record on 2026-10-15.
- Revalidate when: Authorization policy, grant schema, cwd canonicalization, claim/consume matching or lease semantics change.
