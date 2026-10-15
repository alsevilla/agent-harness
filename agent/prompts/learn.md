---
description: Manual LEARN shortcut; records one verified reusable lesson through release-engineer only with explicit destination authority.
---

Task packet:

$ARGUMENTS

Resolve the installed module first: the engineering-harness `SKILL.md` path is advertised (absolute) in the system prompt's skills list. Read `learn/index.md` in that same folder; if no engineering-harness path is advertised, report BLOCKED and do not guess a path. Apply that module to this assignment and resolve its relative files from its folder. Preserve global role routing and authority; loading a procedure does not complete an agent role.

Procedure, as main (run before the final commit or PR; LOCAL-ONLY saves do not stage, commit, push or publish):

1. Establish the lesson. It must be stable, verified and reusable per the module. If there is none, report NO LESSON with the reason. Do not summarize the session.
2. Dedupe. Run `qmd_search` (maxResults at most 5) in collection `knowledge-general` or `knowledge-harness` as optional prior evidence. If QMD is unavailable, fails or is not needed, use a bounded `find`/`grep` over the explicitly selected primary's `docs/knowledge/local/` and the candidate `docs/knowledge/`, and say which fallback ran. Hits are prior evidence, not authority. No automatic QMD refresh: do not update, index or embed; saving and indexing are separate.
3. Select the destination. LOCAL-ONLY default: one small focused record file in the explicitly selected primary's existing ignored store `docs/knowledge/local/` (a scope such as `docs/knowledge/local/general/` or `docs/knowledge/local/harness/`, for example `docs/knowledge/local/harness/<descriptive-slug>.md`), or the existing focused canonical record for the same or refined claim. Do not assume a profile path, never create a store by guess and never edit `.gitignore`. A new document or record needs its explicit path in the packet plus mutation authority; a missing destination or authority is BLOCKED. Do not append a new lesson into the scope README, which is a link index.
4. Dispatch one `subagent` call with `agent: "release-engineer"` and `background: false`. The task packet gives the absolute module path (`learn/index.md`), absolute candidate, evidence path, absolute destination, scope (record fields from `docs/knowledge/README.md`: Title and one-line claim, Source, Evidence status, Context and date, Revalidate when; exact record path, index path only when authorized, and mutation authority) and checks. The child runs with --no-skills, so the module path is the only way it reads the procedure.
5. Verify. After the child returns, read back the exact record file and, when authorized, the index entry, and confirm the record fields are present and, for a LOCAL-ONLY destination, that the path is ignored by the existing ignore rule (`.gitignore`, checked read-only with `git check-ignore`); a LOCAL-ONLY destination that is not ignored is BLOCKED with the exact gap before SAVED, and `.gitignore` is never edited. A shared record under separately authorized publication is not blocked by the local ignore check. Report SAVED with the destination paths only after that verification; SAVED is a local file plus readback, with no implicit staging, commit, push, publication or QMD index or refresh, and is not proof of remote commit, merge or publication. Confirm the destination lies outside all three packet deletion targets (candidate, `_evidence` and `_scratch`). Otherwise report the child's BLOCKED or the missing content.

Outcomes: SAVED (verified destination content), NO LESSON (reason), BLOCKED (the specific missing requirement).
