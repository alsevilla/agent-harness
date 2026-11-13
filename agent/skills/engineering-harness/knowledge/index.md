## KNOWLEDGE procedure
Retrieve/reconcile project truth only when another phase needs it.

For past decisions/notes/specs, QMD is optional prior evidence: use bounded qmd_search then selected qmd_get evidence from the existing shared index when it is available; do not initialize/rebuild it. Saved lessons are one file each in the project's `docs/knowledge/` (see `../learn/index.md`), and each worker's prompt lists their titles at launch: read the file whose title names the area at hand before diagnosing or deciding there; without QMD, give them a bounded targeted read (`find`/`grep`, selected files only) when the decision needs them. Do not index, embed or refresh anything. Treat notes as prior evidence, never mutation authority.

Prefer authoritative current sources. Identify conflicts rather than silently resolving
them. Return the smallest relevant evidence and source locations.

Do not load large histories when a targeted file/decision answers the question.
Load `references/extended.md` only for genuine source conflicts.

Resolve relative references from this module folder. This procedure supplies guidance; the selected named role still must actually run.
