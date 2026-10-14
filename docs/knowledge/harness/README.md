# Harness knowledge

Pi-specific decisions and procedures: profile routing, worker roles, extension behavior and runtime setup. Authoritative definitions stay in repo-relative `agent/AGENTS.md`, `agent/skills/` and `agent/extensions/`; records here point to them and do not duplicate them. Each record uses the inline fields in `../README.md`.

- [Portable profile byte pins](portable-profile-byte-pins.md)
- [Stateful UTF-8 decoding for RPC streams](rpc-stream-utf8-decoding.md)
- [Semantic frontmatter regression checks](frontmatter-semantic-regression-checks.md)

- [Literal chain context substitution](literal-chain-context-substitution.md)
- [Offline tests deny ambient egress](offline-tests-deny-ambient-egress.md)
- [Uncertain cooldown success publishes no clear](uncertain-cooldown-success-no-clear.md)
- [Untrusted hook JSON diagnostics](untrusted-hook-json-diagnostics.md)
- [Configured hook relocation regression](configured-hook-relocation-regression.md)
- [Explicit SDK selection fails closed](explicit-sdk-selection-fail-closed.md)
- [Explicit durable knowledge disposition](knowledge-disposition.md)
- [Omitted task tier preserves the role default](omitted-task-tier-default.md)
- [Exact-operation grants bind tool cwd and command](exact-operation-grant-cwd.md)
