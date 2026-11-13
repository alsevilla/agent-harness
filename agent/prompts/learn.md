---
description: Manual LEARN shortcut; records one verified reusable lesson through release-engineer only with explicit destination authority.
---

Task packet:

$ARGUMENTS

Resolve the installed module first: the engineering-harness `SKILL.md` path is advertised (absolute) in the system prompt's skills list. Read `learn/index.md` in that same folder; if no engineering-harness path is advertised, report BLOCKED and do not guess a path. Apply that module to this assignment and resolve its relative files from its folder. Preserve global role routing and authority; loading a procedure does not complete an agent role.

Procedure, as main (run before the final commit or PR, so the record is committed with it):

1. Establish the lesson. It must be stable, verified and reusable per the module. If there is none, report NO LESSON with the reason. Do not summarize the session.
2. Dedupe. Run a bounded `find`/`grep` over the candidate's `docs/knowledge/`, or `qmd_search` (maxResults at most 5) in the project's knowledge collection when one exists, as prior evidence. Hits are prior evidence, not authority. No automatic QMD refresh: do not update, index or embed; saving and indexing are separate.
3. Select the destination: one small focused Markdown file per lesson at `docs/knowledge/<descriptive-slug>.md` in the candidate, written before the final commit so it is committed and merged with the task's PR; `docs/knowledge/README.md` is a link index with one line per record. A project whose `AGENTS.md` names another knowledge folder uses that folder instead. For a same or refined claim, use the existing record. A new record needs its explicit path in the packet plus mutation authority; a missing destination or authority is BLOCKED. Nothing secret or private goes in a record. Do not append a lesson into the README, which is the link index.
4. Dispatch one `subagent` call with `agent: "release-engineer"` and `background: false`. The task packet gives the absolute module path (`learn/index.md`), absolute candidate, evidence path, absolute destination, scope (record fields from `docs/knowledge/README.md`: Title and one-line claim, Source, Evidence status, Context and date, Revalidate when; exact record path, the README index line, and mutation authority) and checks. The child runs with --no-skills, so the module path is the only way it reads the procedure.
5. Verify. After the child returns, read back the exact record file and its README index line and confirm the record fields are present. Report SAVED with both paths only after that verification; the record is then committed with the task's delivery commit. Never place a record under `_evidence` or `_scratch`. Otherwise report the child's BLOCKED or the missing content.

Outcomes: SAVED (verified destination content), NO LESSON (reason), BLOCKED (the specific missing requirement).
