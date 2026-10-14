# Untrusted hook JSON diagnostics

- Claim: Catch untrusted hook JSON parsing separately and emit a fixed diagnostic instead of forwarding parser exception text that can echo input secrets.
- Source: [Dedicated parsing catch](../../../.github/plugin/session-start.mjs) (lines 23–28: `fail("malformed hook input JSON")`) and [secret-marker negatives](../../../tests/copilot-bootstrap.test.ts) (lines 117–126), inspected at commit `4ceb4d4dbf7cc35ab0130133413919c0ef9ffd47`.
- Evidence status: Verified current source/test inspection checks nonzero status, empty stdout and absence of two marker prefixes in stderr. Historical bootstrap REVIEW-REPAIR-REPORT and FINAL-SOURCE-REVIEW-REPORT evidence reports RED 3 pass/2 fail to GREEN 5/5 and independent 20 offline assertions. No current test rerun or live-native claim.
- Context: SessionStart JSON is untrusted and parser messages may contain its contents. Trusted installed-file ENOENT diagnostics remain separate and actionable; do not blanket-strip all errors or infer that all outputs are secret-free.
- Date: 2026-10-15 (persistence and source inspection).
- Revalidate when: Hook parsing/diagnostics, input trust boundaries, JSON-engine error text or secret-marker negatives change.
