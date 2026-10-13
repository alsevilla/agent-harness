## LEARN procedure
This procedure belongs to the `release-engineer` role when LEARN is selected by main.

Run only when durable knowledge is worth preserving.

Capture only stable, reusable truth:
- accepted architectural/project/release decision;
- confirmed domain or operational invariant;
- recurring debugging/testing/production lesson;
- durable navigation/recovery/operational knowledge.

Do not summarize the session or store temporary state. Reconcile existing authoritative knowledge when needed, and use the narrowest authoritative destination.

Writing durable knowledge requires explicit destination/mutation authority. `release-engineer` may make precise edits only to the authorized knowledge/release-owned artifact; it must not use LEARN to change product implementation or tests.

## Record, dedupe and destination
Record fields follow `docs/knowledge/README.md`: Title and one-line claim; Source (repo-relative path or commit; do not duplicate the authoritative doc); Evidence status (verified or provisional); Context and date; Revalidate when (the condition that makes the record stale).

Dedupe before writing: check existing records for the same claim, and whether the new lesson refines, contradicts or repeats them. QMD results are prior evidence, not authority; the authoritative doc stays the source of truth. A new document creation requires an explicit path granted in the packet; otherwise report BLOCKED. Index links are added only within the authorized scope. Saving and QMD indexing are separate; nothing here refreshes or embeds the index.

Before recording, review the Verify evidence and root cause; record only what the evidence confirms. A lesson never substitutes for a root-cause fix or regression test: the fix and its test come first.

Retrieve selectively: open only the QMD hits or files the decision needs. When an existing record covers the claim, update the canonical record (refine, correct or revalidate it) and do not add a duplicate. Keep each claim to one concise, actionable line with its source, verification, date and revalidation condition.

Saving remains an explicitly authorized release-engineer action; main verifies the actual destination content after the child returns.

## Optional retrospective triggers
Main may consider a LEARN review when a durable lesson may exist, for example:
- the same correction was requested at least twice;
- the same worker or failure repeats: count its incidents by the three-incident rule below;
- the user bypasses main to do the task manually (manual bypass or workaround).

Three-incident rule: three distinct completed incidents sharing a confirmed root cause: trigger main LEARN review. Count distinct incidents, each backed by a completed Debug, Verify or worker REPORT that states the root cause as confirmed. Retries or attempts of the same task are one incident. Similar error symptoms alone do not establish recurrence; the root causes must match. Main notices recurrence from evidence already relevant to the current work; there is no mandatory history scan, and no counter, ledger or background pipeline. Three is a trigger for review, not a minimum: one critical, verified security or data-loss lesson may warrant preservation on its own.

A trigger only prompts main to review whether a stable, confirmed lesson exists. It is not automatic logging, session dumping, helper invocation or a universal gate, and it is not run after every task. Record only a durable root cause or confirmed lesson with explicit destination authority. Only the `release-engineer` LEARN role, under existing policy, writes; general workers do not run LEARN automatically. User choices and task requirements take precedence.

Load `references/extended.md` only for complex knowledge reconciliation.

Resolve relative references from this module folder. This procedure supplies guidance; the selected `release-engineer` role still must actually run.
