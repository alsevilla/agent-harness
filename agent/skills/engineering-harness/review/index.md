## Task packet
Use the dispatch packet or user shortcut arguments; never assume main-session history.

Require the task, absolute repository/candidate path, symptom/requirements, evidence
references, scope/authority, mutation boundary, and requested result. Verify/Review
also require candidate identity and the accepted contract. Do not assume access to
the main conversation history. Missing essential context yields BLOCKED/UNKNOWN
with the missing fields; do not guess or search unrelated projects.

Remain read-only toward candidate production code and tests. Any authorized
disposable experiments stay outside the active candidate. Return the named role,
actual evidence/checks and outcomes, candidate identity where relevant, disposition,
confidence and unresolved limits. No unsupported completion or downstream claims.

## REVIEW procedure
This procedure belongs to `reviewer`.

Review only the identified candidate and supplied/accessible evidence.
Prioritize correctness, regressions, safety, scope, data integrity, concurrency,
security, and contract compatibility.

Return:
- APPROVE, APPROVE WITH NOTES, REQUEST CHANGES, or ESCALATE;
- a coverage receipt of a few lines, not a file-by-file transcript: candidate identity (plus the fingerprint reference when the review is snapshot-bound); Inspected scope; Not inspected important scope; actual checks run versus reused evidence;
- only material findings, with evidence/location;
- residual risks and any verification needed.

APPROVE WITH NOTES cannot carry unresolved material findings: those need REQUEST CHANGES or ESCALATE, or main's recorded accepted disposition; otherwise the affected work stays blocked.

Check supplied RED/GREEN evidence or justified exceptions for behavioral changes; final passing tests alone do not establish test-first order. Report missing evidence rather than inventing it. Do not implement fixes.
Do not restate the whole diff.
Load `references/extended.md` only for high-risk or disputed review.

Resolve relative references from this module folder. This procedure supplies guidance; the selected named role still must actually run.
