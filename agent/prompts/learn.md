---
description: Manual LEARN shortcut; records one verified reusable lesson through release-engineer only with explicit destination authority.
---

Task packet:

$ARGUMENTS

Resolve the installed module first: the engineering-harness `SKILL.md` path is advertised (absolute) in the system prompt's skills list. Read `learn/index.md` in that same folder; if no engineering-harness path is advertised, report BLOCKED and do not guess a path. Apply that module to this assignment and resolve its relative files from its folder. Preserve global role routing and authority; loading a procedure does not complete an agent role.

Procedure, as main (run before the final commit or PR, so the record joins the same commit/PR set):

1. Establish the lesson. It must be stable, verified and reusable per the module. If there is none, report NO LESSON with the reason. Do not summarize the session.
2. Dedupe. Run `qmd_search` (maxResults at most 5) in collection `knowledge-general` or `knowledge-harness`. If QMD is unavailable or fails, use a bounded `find`/`grep` over `docs/knowledge/` in the candidate and say which fallback ran. Hits are prior evidence, not authority. No automatic QMD refresh: do not update or embed; saving and indexing are separate.
3. Select the destination: by default one small focused record file in the selected project's existing authoritative knowledge directory (project facts: the project's `docs/knowledge/`; or an existing scope such as `docs/knowledge/general/` or `docs/knowledge/harness/`), for example `docs/knowledge/harness/<descriptive-slug>.md`), or the existing focused canonical record for the same or refined claim. A new document or record needs its explicit path in the packet; the packet must also name the index path when an index link is in scope, plus mutation authority for each. A missing path or authority is BLOCKED. Do not append a new lesson into the scope README, which is a link index.
4. Dispatch one `subagent` call with `agent: "release-engineer"` and `background: false`. The task packet gives the absolute module path (`learn/index.md`), absolute candidate, evidence path, absolute destination, scope (record fields from `docs/knowledge/README.md`: Title and one-line claim, Source, Evidence status, Context and date, Revalidate when; exact record path, index path only when authorized, and mutation authority) and checks. The child runs with --no-skills, so the module path is the only way it reads the procedure.
5. Verify. After the child returns, read back the exact record file and, when authorized, the index entry, and confirm the record fields are present, that each path is not git-ignored, and that both are named in the commit/PR set main supplies. Report SAVED with the destination paths only after that verification; SAVED is local file plus readback with no implicit staging, and is not proof of remote commit, merge or publication. Main confirms Git tracking when it makes the commit or PR. Otherwise report the child's BLOCKED or the missing content.

Outcomes: SAVED (verified destination content), NO LESSON (reason), BLOCKED (the specific missing requirement).
