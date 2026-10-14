## KNOWLEDGE procedure
Retrieve/reconcile project truth only when another phase needs it.

For past decisions/notes/specs, QMD is optional prior evidence: use bounded qmd_search then selected qmd_get evidence from the existing shared index when it is available; do not initialize/rebuild it. Ignored, unindexed local notes in the explicitly selected primary's `docs/knowledge/local/` get a bounded targeted read (`find`/`grep`, selected files only) when the decision needs them. Do not index, embed or refresh anything. Treat indexed and local notes as prior evidence, never mutation authority.

Prefer authoritative current sources. Identify conflicts rather than silently resolving
them. Return the smallest relevant evidence and source locations.

Do not load large histories when a targeted file/decision answers the question.
Load `references/extended.md` only for genuine source conflicts.

Resolve relative references from this module folder. This procedure supplies guidance; the selected named role still must actually run.
