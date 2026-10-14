# Offline tests deny ambient egress

- Claim: Injected transport alone does not make a test offline; deny and count ambient fetch/WebSocket calls, assert zero attempts and restore the globals afterward.
- Source: [Transport fallback](../../../agent/extensions/subagent/provider-cooldown-guard.ts) (line 266: `(options?.fetch ?? globalThis.fetch)(input, init)`) and [ambient denial/count/restoration](../../../agent/extensions/subagent/tests/provider-cooldown-guard.test.ts) (lines 18–33), inspected at commit `4ceb4d4dbf7cc35ab0130133413919c0ef9ffd47`.
- Evidence status: Verified current source/test inspection. Historical guard offline incident evidence supplied by the curator confirms an omitted injected fetch caused an accidental unauthenticated request; subsequent verification included negative isolation and installed-SDK controls. No current test rerun.
- Context: Transport fall-through can reach global network APIs even in fixture-driven tests. These JavaScript guards are not an OS sandbox, coverage of all network/process surfaces, wire-level proof or real Codex AUTO coverage.
- Date: 2026-10-15 (persistence and source inspection).
- Revalidate when: Transport fallback, SDK network surfaces, global test isolation or teardown/zero-attempt assertions change.
