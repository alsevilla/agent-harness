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
Record fields follow `docs/knowledge/README.md` (fields only; the LOCAL-ONLY storage default below overrides its storage text): Title and one-line claim; Source (repo-relative path or commit; do not duplicate the authoritative doc); Evidence status (verified or provisional); Context and date; Revalidate when (the condition that makes the record stale).

Storage default (LOCAL-ONLY): each new distinct verified lesson becomes one small focused Markdown record in the explicitly selected primary's existing gitignored store `docs/knowledge/local/` (a scope such as `docs/knowledge/local/general/` or `docs/knowledge/local/harness/` only where it exists and fits), for example `docs/knowledge/local/harness/<descriptive-slug>.md` (a shared record, only under separately authorized publication, uses the tracked scope `docs/knowledge/harness/<descriptive-slug>.md`). Do not assume a profile path, never create a store by guess and never edit `.gitignore`; a missing destination or authority is BLOCKED with the exact gap. The local record lies outside all three packet deletion targets (candidate, `_evidence` and `_scratch`), so it survives their cleanup; a primary-checkout candidate is retained, not deleted, so a store inside it is not a deletion target. The scope `README.md` is a link index to those records, not the default prose bucket; do not append a new lesson into a README or another broad multi-topic file. Existing historical prose stays as written unless a precise correction is authorized. For a same or refined claim, update the canonical record instead of creating a second record.

Dedupe before writing: check existing records for the same claim, and whether the new lesson refines, contradicts or repeats them. QMD results are prior evidence, not authority; the authoritative doc stays the source of truth. A new document creation requires an explicit path granted in the packet; otherwise report BLOCKED. Index links are added only within the authorized scope. Saving and QMD indexing are separate; nothing here refreshes or embeds the index.

Packet authority: the packet must name the exact new record path, the index path when an index link is in scope, and the mutation authority for each. A missing path or authority is BLOCKED with the exact gap; nothing is created or indexed by guess. Each record keeps only: Title and one-line claim, Source, Evidence status, Context and date, Revalidate when. No transcripts, session summaries, no automatic counters, no ledgers and no memory pipeline.

Readback and SAVED: after writing, the release engineer reads back the exact record file and the authorized index entry and confirms the record fields. SAVED is reported only after that readback, with both paths. QMD refresh or embedding is separate and is not part of SAVED.

Before recording, review the Verify evidence and root cause; record only what the evidence confirms. A lesson never substitutes for a root-cause fix or regression test: the fix and its test come first.

Retrieve selectively: open only the QMD hits or files the decision needs. When an existing record covers the claim, update the canonical record (refine, correct or revalidate it) and do not add a duplicate. Keep each claim to one concise, actionable line with its source, verification, date and revalidation condition.

Before the final commit or PR, main evaluates verified reusable lessons with bounded dedup and selects LEARN when warranted; this is a workflow checkpoint, not automatic logging. Only the release engineer performs authorized persistence to the exact named canonical record and index entry under LOCAL-ONLY policy, reads both back, and confirms the record fields and that each path lies outside all three packet deletion targets (candidate, `_evidence` and `_scratch`). Saving grants no implicit staging, commit, push, publication or QMD index or refresh. Shared publication is separate explicit authority, not a default completion gate. The terminal knowledge-disposition checkpoint is SAVED (local: exact record and index paths with readback evidence), NO LESSON (reason), or BLOCKED (specific evidence, destination, or authority gap). Archiving a report or fixture is evidence, not learning completion: record the focused lesson, not an archive; permanent raw logs are not a universal requirement. SAVED means the file and readback exist; it is not proof of remote commit, merge or publication. A BLOCKED checkpoint before the PR is an open gap for main, never reported as SAVED.
Tracked and sources: `docs/knowledge/private/` and `docs/knowledge/local/` remain ignored by the existing `.gitignore` rule and unindexed and never receive exported private, secret or unconfirmed notes; the release engineer checks the ignore rule read-only with `git check-ignore` and never edits `.gitignore`. A LOCAL-ONLY destination that is not ignored is BLOCKED with the exact gap before SAVED; nothing is published. A shared record under separately authorized publication is not blocked by the local ignore check. Source fields cite repo-relative files or commits, which survive artifact disposal; _scratch and _evidence are never the only proof.
Late lesson and merge: a lesson verified only after merge may be saved locally outside the deletion targets; a shared copy needs an authorized follow-up PR and cannot be claimed as already published. A BLOCKED checkpoint after merge reports the concrete gap and retains the affected targets; it never rolls back the merge.

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
