## DISCOVER procedure
Use only when requirements, existing behavior, or change surface are not sufficiently known.

Produce a compact Discovery Brief:
- goal and confirmed requirements;
- relevant components/files;
- existing behavior/invariants;
- key unknowns/risks;
- recommended next phase.

Do not implement. Do not turn discovery into a repository-wide survey.
Within the existing lookup order, start from the supplied path or symbol and the
smallest plausible subsystem. For text-search fallback, locate filenames first when
the location is unknown, then read matching ranges; narrow a truncated query rather
than requesting a larger dump. Follow the relevant caller, contract and nearby tests.
For each lookup, name the question the result must answer. Prefer a symbol body or
matching range with its path and line numbers; expand to imports, callers and tests
when the contract depends on them. A truncated result is incomplete evidence.
Graphify and QMD locate candidates; confirm their claims against current source.
Expand to a whole file only when the question needs it; a narrow view must still
include the dependencies needed to reason about the change.
Use history only to resolve a specific question about intent or past behavior.
Stop when the worker has the entry point, affected callers, reusable pattern and
relevant checks; name remaining unknowns instead of expanding into unrelated code.
Use Scout only when repository reconnaissance is genuinely needed. Scout is a read-only role: main delegates discovery reads to it, batched as one question-driven packet, instead of reading itself.
Load `references/extended.md` only for broad/cross-system discovery.

Resolve relative references from this module folder. This procedure supplies guidance; the selected named role still must actually run.
