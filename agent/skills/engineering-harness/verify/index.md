## Task packet
Use the dispatch packet or user shortcut arguments; never assume main-session history.

Require the task, absolute repository/candidate path, symptom/requirements, evidence
references, scope/authority, mutation boundary, and requested result. Verify/Review
also require candidate identity and the accepted contract. Do not assume access to
the main conversation history. Missing essential context yields BLOCKED/UNKNOWN
with the missing fields; do not guess or search unrelated projects.

Remain read-only toward candidate production code and tests. Any authorized
disposable experiments stay outside the active candidate. Record the named role,
checks and outcomes, candidate identity where relevant, disposition, confidence and
unresolved limits in the assigned REPORT file; no unsupported completion or downstream claims.

## VERIFY procedure
This procedure belongs to `qa-engineer`.

Verify the exact candidate against the approved contract. Do not modify production code.

Return one disposition:
- PASS: evidence supports required behavior.
- FAIL: provide concrete failing evidence and scope.
- INCONCLUSIVE: explain what could not be established.

Prefer focused, high-value checks before broad suites.
Match evidence to the claim: compilation/type checks establish different facts from
runtime behavior, and mocked tests do not establish live integration success. Check
the changed contract's relevant failure and boundary cases as well as its happy path.
When attributing a failure to the baseline, use existing comparable baseline evidence
or an authorized isolated check; otherwise mark the attribution unknown. Do not fix
unrelated failures or waive a required gate because a failure appears pre-existing.
Do not rerun expensive suites without a reason.
Mark each required check as a result, NOT RUN with reason, or justified not-applicable with reason; UI focus/browser checks only when UI is affected or assigned. Reuse an earlier result only for unchanged tested bytes, the same relevant environment and the same contract; otherwise rerun the affected check (`references/token-efficiency.md`, "Bounded checklist and evidence reuse").
Record commands actually run and relevant results in the assigned REPORT file; the reply follows the child handoff format.

Load `references/extended.md` only for complex verification strategy or critical logic.

Resolve relative references from this module folder. This procedure supplies guidance; the selected named role still must actually run.

## Candidate fingerprint
Fingerprint a candidate only this way, so every worker and shell gets the same digest for the same diff. Git writes the diff bytes to a file and hashes that file itself; no shell pipe touches the bytes (PowerShell re-encodes piped text and adds CRLF, so `git diff | sha256sum`, `Get-FileHash` on piped output and editor saves all differ).
1. The diff scope covers committed work only: `git status --porcelain -- <paths>` must be empty. If it isn't, report the candidate as dirty and don't fingerprint it.
2. `git diff --binary --no-color --no-ext-diff --no-textconv --full-index --output="<absolute _scratch/<task>/candidate.diff>" <base>...HEAD -- <paths>` (`--output` goes before `--`).
3. `git hash-object --no-filters "<absolute _scratch/<task>/candidate.diff>"` prints the digest.

Report all four: the candidate HEAD (`git rev-parse HEAD`), the diff scope (`<base>...HEAD -- <paths>`), the exact commands, and the full 40-character digest, never a prefix. A mismatch with an earlier fingerprint is a finding only when both used this procedure and the same scope.

## Refusal and failure routing
If an assigned baseline or verification scope is too broad, return the specific missing input or bounded targets needed for a smaller packet; the orchestrator narrows and redispatches rather than assuming this role. New failing tests/panics are FAIL evidence with exact target, candidate, command, and full error details; return them for diagnostic-engineer diagnosis. Do not weaken tests, patch the candidate, or treat a shell pipeline's zero exit as PASS when captured output reports failure.
