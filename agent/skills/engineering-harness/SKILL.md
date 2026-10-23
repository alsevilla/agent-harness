---
name: engineering-harness
description: Main engineering entrypoint. Select the next phase and actual named role; load only relevant module guidance.
---

# Engineering harness
Main owns sequencing and launches as a thin orchestrator: reads, searches and runs are delegated per the AGENTS policy. Apply the compact AGENTS policy; leaves perform only their assignment.
The shared policy is `../../AGENTS.md` relative to this `SKILL.md`; use that same source rather than a copy. Read this entry and the shared policy when missing or stale from context; reuse already injected context. When execution starts, load only missing relevant domain routers/module indexes and referenced sections. Reread changed guidance or content lost from context; a new task alone does not require another read. Each leaf loads its assignment in its own context.

Pi provides the named subagent, tools, control and model-registry mechanisms described here. Copilot CLI uses only runtime-reported native custom-agent/task dispatch and its question tool when available; never impersonate built-ins, substitute named roles, or invent a schema or job API. Pi-only controls are not prompt-emulated. If a required capability is unavailable, block only that workflow step. Parent packets must carry the verified host-native dispatch contract and absolute installed shared-module, evidence and candidate paths, plus the relevant host boundary for leaves. Resolve resources from the actual installed shared source/advertised skill or an explicitly supplied absolute path; missing paths block the step. Pi-home examples apply only to Pi.

For "queue this", record the request and order, acknowledge briefly, and continue current work. When a durable PLAN or resume queue exists, read `plan/index.md` ("Durable plan state") before resuming or changing it. Select modules/roles when that task is scheduled; do not launch or implement it early. Resolve loading directly without explaining internal deliberations.

| Need | Module / role |
|---|---|
| Unknown location/dependencies | `discover/index.md`; Scout only when needed |
| Unknown-cause failure | `debug/index.md`; actual `debugger` before speculative fixes |
| Conflicting evidence / material choice | `knowledge/index.md` / `decision/index.md`; main owns authorization |
| Necessary dependencies/migration/coordination plan | `plan/index.md`; **main owns PLAN** |
| Authorized implementation | `execute/index.md`; `backend-worker` / `frontend-worker` / `general-worker` / `platform-worker` |
| Selected independent evidence | `verify/index.md` -> `test-engineer`; `review/index.md` -> `reviewer` |
| Requested isolation/integration | `worktree/index.md`, `integrate/index.md`; main owns orchestration |
| Requested delivery/release | `ship/index.md` -> `release-engineer` |
| Useful durable learning | `learn/index.md` -> `release-engineer` |

PLAN is not an architecture-specialist procedure. The architecture specialist supplies structural analysis/constraints; main incorporates them into PLAN and owns sequencing, writer ownership, gates and authorization.

Do not execute the whole lifecycle by default. Parent frontend/backend routers select domain modules; procedures do not launch roles by themselves. Use actual subagent calls with self-contained candidate/contract packets and await real evidence. Manual prompts are optional instruction shortcuts.

Read `references/routing.md` only for uncertain role/gate selection; `references/recovery.md` for failed edits/new failures/oversized packets; `references/worker-control.md` for steering/pause/cancel; `references/runtime.md` for integration/provider/shell questions; `references/git-attribution.md` before authorized commits/PRs; `references/run-manifest.md` for the optional main-owned manifest of complex multi-stage runs; `references/skill-evaluation.md` for the offline routing-fixture evaluator. None is an automatic preload. Historical `extended.md` material cannot override current authority or create new gates.
