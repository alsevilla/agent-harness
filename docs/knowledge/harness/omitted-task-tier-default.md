# Omitted task tier preserves the role default

- Claim: Omitted `modelTier` can run economy; consequential work on an economy-default role needs configured `capable` selected before launch, or unresolved selection returned to main.
- Source: [`routing.md` — Explicit Pi model tier](../../../agent/skills/engineering-harness/references/routing.md#explicit-pi-model-tier), [`runtime.md` — Models](../../../agent/skills/engineering-harness/references/runtime.md#models), [`resolveModelTier`](../../../agent/extensions/subagent/model-routing.ts) and [real-registry scenarios](../../../agent/extensions/subagent/tests/role-registry.test.ts).
- Evidence status: Verified policy and static resolver/real-registry regression coverage in external evidence artifacts pr2-review-fixes/IMPLEMENTATION.md and pr2-review-fixes/REVIEW.md; 33 registry tests passed with a 60-second timeout, while default-5-second runs had pre-existing timeout failures. Not live LLM tier-selection compliance or measured savings; Pi-only, not Copilot model selection. No new test execution for this migration.
- Context and date: Per-task tier selection without changing stored role defaults; 2026-10-14. Migrated to a focused record on 2026-10-15.
- Revalidate when: Routing policy, model-tier schema, resolver or role defaults/capabilities change.
