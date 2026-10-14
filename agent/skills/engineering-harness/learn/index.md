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

Storage default: each new distinct verified lesson becomes one small focused Markdown record in the selected project's existing authoritative knowledge directory (project facts: that project's `docs/knowledge/`; a scope such as `docs/knowledge/general/` or `docs/knowledge/harness/` only where it exists and fits), for example `docs/knowledge/harness/<descriptive-slug>.md`. The scope `README.md` is a link index to those records, not the default prose bucket; do not append a new lesson into a README or another broad multi-topic file. Existing historical prose stays as written unless a precise correction is authorized. For a same or refined claim, update the canonical record instead of creating a second record.

Dedupe before writing: check existing records for the same claim, and whether the new lesson refines, contradicts or repeats them. QMD results are prior evidence, not authority; the authoritative doc stays the source of truth. A new document creation requires an explicit path granted in the packet; otherwise report BLOCKED. Index links are added only within the authorized scope. Saving and QMD indexing are separate; nothing here refreshes or embeds the index.

Packet authority: the packet must name the exact new record path, the index path when an index link is in scope, and the mutation authority for each. A missing path or authority is BLOCKED with the exact gap; nothing is created or indexed by guess. Each record keeps only: Title and one-line claim, Source, Evidence status, Context and date, Revalidate when. No transcripts, session summaries, no automatic counters, no ledgers and no memory pipeline.

Readback and SAVED: after writing, the release engineer reads back the exact record file and the authorized index entry and confirms the record fields. SAVED is reported only after that readback, with both paths. QMD refresh or embedding is separate and is not part of SAVED.

Before recording, review the Verify evidence and root cause; record only what the evidence confirms. A lesson never substitutes for a root-cause fix or regression test: the fix and its test come first.

Retrieve selectively: open only the QMD hits or files the decision needs. When an existing record covers the claim, update the canonical record (refine, correct or revalidate it) and do not add a duplicate. Keep each claim to one concise, actionable line with its source, verification, date and revalidation condition.

Before the final commit or PR, main evaluates verified reusable lessons with bounded dedup and selects LEARN when warranted; this is a workflow checkpoint, not automatic logging. Only the release engineer performs authorized persistence to the exact named canonical record and index entry, reads both back, and confirms the record fields and that each path is not git-ignored (`git check-ignore` reports no match). Both paths must be named in the commit/PR set main supplies. A new record is untracked until that commit exists, which is expected: saving grants no staging, commit, push or PR authority, and there is no implicit staging. Main confirms tracking when it makes the commit or PR. The terminal knowledge-disposition checkpoint is SAVED (local: exact record and index paths with readback evidence), NO LESSON (reason), or BLOCKED (specific evidence, destination, or authority gap). Archiving a report or fixture is evidence, not learning completion: record the focused lesson, not an archive; permanent raw logs are not a universal requirement. SAVED means the file and readback exist; it is not proof of remote commit, merge or publication. Remote integration is verified only by the cleanup gate in `../worktree/index.md`. A BLOCKED checkpoint before the PR is an open gap for main, never reported as SAVED.
Tracked and sources: `docs/knowledge/private/` and `docs/knowledge/local/` stay git-ignored and unindexed and never receive exported private, secret or unconfirmed notes. Source fields cite repo-relative files or commits, which survive artifact disposal; _scratch and _evidence are never the only proof.
Late lesson and merge: a lesson verified only after merge needs an authorized follow-up PR before cleanup of the affected artifacts; it cannot be claimed as already published. A BLOCKED checkpoint after merge reports the concrete gap and retains the affected targets; it never rolls back the merge.

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
