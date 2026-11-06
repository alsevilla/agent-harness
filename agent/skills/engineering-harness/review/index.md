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

### Finding discipline

- For a change review, establish the comparison base and inspect the diff plus the callers or contracts needed to assess it. Use history or a baseline run only when needed to distinguish a regression from an existing problem; label uncertain attribution explicitly. Report unrelated existing defects separately. A pre-existing issue still matters when it blocks safe delivery or invalidates evidence; repository audits may cover existing defects within their assigned scope.
- Flag discrete, actionable defects with a concrete trigger, affected behavior and causal path supported by code or a reproduction. For cross-component claims, identify the affected caller or contract. An unproven assumption is an open question or evidence limit, not a confirmed bug; passing tests alone do not disprove a code-supported finding.
- Respect accepted behavior changes and the repository's level of rigor. Omit personal style preferences and speculative redesigns; documented standards or a concrete correctness/maintenance impact can justify a finding. Return no findings when none meet this bar.
- Use one concise paragraph per distinct defect, with severity, the smallest useful file/line range, triggering conditions, consequence and a focused correction. Deduplicate the same defect across symptoms; severity must reflect the stated conditions. Keep the existing verdict and handoff format.

Adapted from [Codex's review rubric](https://github.com/openai/codex/blob/4980f9585a0a2dea0cdc4bb0cee4e631b75fcf5c/codex-rs/prompts/templates/review/rubric.md). This is local guidance; reviewing a candidate does not require fetching that source or loading another procedure.

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
