# Literal chain context substitution

- Claim: Insert prior output with a String.replace callback so replacement-pattern text remains literal at every `{previous}` placeholder.
- Source: [Chain substitution](../../../agent/extensions/subagent/index.ts) (line 956: `step.task.replace(/\{previous\}/g, () => previousOutput)`) and [literal-output regression](../../../agent/extensions/subagent/tests/compact-handoff-runtime.node.ts) (lines 148–160), inspected at commit `4ceb4d4dbf7cc35ab0130133413919c0ef9ffd47`.
- Evidence status: Verified current source/test inspection covers `$&`, `$$`, dollar-backtick and `$'`, repeated placeholders and an intact >50KB tail. Historical chain-previous-literal-verify evidence supplied by the curator reports PASS with failing revert controls for foreground/background. No current test rerun.
- Context: A string replacement argument interprets dollar patterns inside prior output; a callback returns that output literally. This preserves text, not prompt trust or authority.
- Date: 2026-10-15 (persistence and source inspection).
- Revalidate when: Chain substitution, placeholder syntax, output retention or literal-output regression coverage changes.
