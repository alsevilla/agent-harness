# Configured hook relocation regression

- Claim: Test the manifest's actual hook command from an unrelated cwd and a relocated Unicode/spaced installation root, not only the reader function.
- Source: [Configured shell commands](../../../.github/plugin/hooks.json) (lines 7–8: Bash PLUGIN_ROOT, PowerShell `$env:COPILOT_PLUGIN_ROOT` and exit propagation) and [actual-command relocation tests](../../../tests/copilot-bootstrap.test.ts) (lines 51–115), inspected at commit `4ceb4d4dbf7cc35ab0130133413919c0ef9ffd47`.
- Evidence status: Verified current source/test inspection. Historical bootstrap evidence shows a PowerShell entrypoint failure while reader checks passed; FINAL-SOURCE-REVIEW-REPORT independently verifies configured Bash and PowerShell commands offline. No current test rerun.
- Context: Shell quoting, root-variable syntax and exit propagation are part of installed-hook behavior. Historical Windows offline fixtures do not certify marketplace installation, live host rewriting/precedence, native control/model parity, Linux/Raspberry Pi or Windows NUC deployment.
- Date: 2026-10-15 (persistence and source inspection).
- Revalidate when: Manifest commands, installation-root conventions, quoting, reader location or supported shells/platforms change.
