# Synchronous child launch errors

- Claim: A Promise wrapper around execFile must catch synchronous launch throws as well as callback errors and preserve spawn, numeric exit, overflow and killed classifications.
- Source: [runProcess](../../../agent/extensions/subagent/agent-create.ts) (lines 35–49) and [non-executable interpreter regression](../../../agent/extensions/subagent/tests/agent-create.test.ts) (lines 441–446; prompt regression near line 354), inspected at commit `4ceb4d4dbf7cc35ab0130133413919c0ef9ffd47`.
- Evidence status: Verified current source/test inspection: the outer catch resolves a spawn result instead of rejecting; callback handling retains its distinct outcomes. Historical Windows synchronous-spawn EFTYPE debugging and independent verification supplied by the curator includes a failing catch-removal control. No current test rerun or current POSIX rerun.
- Context: Some Node launch failures, including Windows EFTYPE for a non-executable absolute interpreter, throw before the callback. Promise rejection must not bypass the wrapper's typed launch-error contract.
- Date: 2026-10-15 (persistence and source inspection).
- Revalidate when: Node child-process behavior, wrapper result types, error classification or interpreter-launch regression coverage changes.
