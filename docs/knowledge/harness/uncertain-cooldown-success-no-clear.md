# Uncertain cooldown success publishes no clear

- Claim: Do not publish a success clear from an uncertain cooldown snapshot; drop that success observation until a readable snapshot can support clearing.
- Source: [Success publication guard](../../../agent/extensions/subagent/provider-cooldown.ts) (lines 436–446: `if (!seen.ok) return;`) and [malformed/unreadable and repeated-success controls](../../../agent/extensions/subagent/tests/provider-cooldown.test.ts) (lines 364–391), inspected at commit `4ceb4d4dbf7cc35ab0130133413919c0ef9ffd47`.
- Evidence status: Verified current source/test inspection confirms no clear files on uncertainty and no manufactured permanent overflow from repeated successes. Historical shared-provider-cooldown-retention-review and provider-cooldown-failed-read-repair evidence supplied by the curator confirms the defect and focused Bun/Node/race checks. No current test rerun.
- Context: Publishing clears without a trustworthy snapshot can hide unresolved failures or create accumulating state. Dropping uncertain success observations permits later reprobes; it does not promise auto-healing, zero availability impact or strict churn bounds.
- Date: 2026-10-15 (persistence and source inspection).
- Revalidate when: Snapshot validity, clear publication, probe lifecycle, state-entry limits or malformed/unreadable regression controls change.
