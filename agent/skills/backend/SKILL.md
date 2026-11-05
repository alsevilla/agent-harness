---
name: backend
description: Select the load/resilience module when it is justified. Known contracts go to backend-worker; material unresolved domain decisions go to justified specialists.
---

# Backend
Known backend service/API contract (any stack) -> backend-worker; database implementation -> database-worker. Unknown-cause defects follow harness DEBUG.
Touching a domain alone does not require a specialist. For material unresolved decisions:
Database implementation -> database-worker; unresolved material database semantics -> database-specialist; concurrency -> concurrency-specialist; security -> security-specialist;
API -> api-specialist; subsystem boundaries -> architecture-specialist; measured capacity
-> performance-specialist; deployment -> devops-specialist;
runtime signals -> observability-specialist. Prefer one relevant specialist and one writer.

## Go straight to the module guide
- Selected bounded load/failure evidence: the chosen test-engineer or performance-specialist owns bounded load evidence for the exact candidate; settle the authorized environment, invariants, workload and acceptance limits first; it grants no production-load or implementation authority. Read the matching sections of `load-resilience-testing/guide.md` (arrival rate, overload/backpressure, database contention, dependency failure, shutdown/recovery, reporting) and report measured correctness and limits with reproducible settings. Its `index.md` holds the same pointer for roles and prompts that name it.

Modules are reference procedures. Relative resources belong to their module folder.
Read only the matching guide sections; reuse loaded guidance. No default full
catalog, pool tuning, extra specialist or production-load authority. For other stacks use
the project's actual writer. Main owns named launches and explicit global packets; leaf
agents return handoff needs. Apply independent gates under current global policy only.
