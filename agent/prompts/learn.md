---
description: Manual LEARN shortcut; records one verified reusable lesson through release-engineer only with explicit destination authority.
---

Task packet:

$ARGUMENTS

Resolve the installed module first: the engineering-harness `SKILL.md` path is advertised (absolute) in the system prompt's skills list. Read `learn/index.md` in that same folder; if no engineering-harness path is advertised, report BLOCKED and do not guess a path. Apply that module to this assignment and resolve its relative files from its folder. Preserve global role routing and authority; loading a procedure does not complete an agent role.

Procedure, as main:

1. Establish the lesson. It must be stable, verified and reusable per the module. If there is none, report NO LESSON with the reason. Do not summarize the session.
2. Dedupe. Run `qmd_search` (maxResults at most 5) in collection `knowledge-general` or `knowledge-harness`. If QMD is unavailable or fails, use a bounded `find`/`grep` over `docs/knowledge/` in the candidate and say which fallback ran. Hits are prior evidence, not authority. No automatic QMD refresh: do not update or embed; saving and indexing are separate.
3. Select the destination: the narrowest existing authoritative document under `docs/knowledge/general/` or `docs/knowledge/harness/`, or the one the packet names. A new document needs its explicit path in the packet; otherwise report BLOCKED. Writing needs explicit mutation authority for that path in the packet; without it report BLOCKED.
4. Dispatch one `subagent` call with `agent: "release-engineer"` and `background: false`. The task packet gives the absolute module path (`learn/index.md`), absolute candidate, evidence path, absolute destination, scope (record fields from `docs/knowledge/README.md`: Title and one-line claim, Source, Evidence status, Context and date, Revalidate when; index links only when authorized) and checks. The child runs with --no-skills, so the module path is the only way it reads the procedure.
5. Verify. After the child returns, read the changed destination and confirm the record fields are present. Report SAVED with the destination path only after that verification. Otherwise report the child's BLOCKED or the missing content.

Outcomes: SAVED (verified destination content), NO LESSON (reason), BLOCKED (the specific missing requirement).
