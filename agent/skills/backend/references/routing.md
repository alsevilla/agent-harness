# Conditional backend capability selection

Read the row matching a material unresolved decision, not the entire historical catalog.
Current global policy and project requirements govern authority and selected gates.

| Unresolved concern | Named specialist / capability |
|---|---|
| Database implementation: SQL, schema, migrations, transactions, queries, indexes, ORM, repositories, data access and DB tests | database-worker; use the project's actual database stack |
| Unresolved material database invariants or semantics | database-specialist (read-only; only for material unresolved risk) |
| Async tasks, locks, races, cancellation, bounded queues, shutdown | concurrency-specialist |
| Trust, auth, security boundary | security-specialist |
| Public API compatibility, shape, errors | api-specialist |
| Major subsystem boundary | architecture-specialist |
| Measured load/capacity/performance | performance-specialist |
| Deployment/service/backups | devops-specialist |
| Logs/metrics/health/audit | observability-specialist |

backend-worker owns authorized APIs, services and business logic, not database implementation. database-worker owns database implementation in any language/engine.
Domain specialists
provide decisions and evidence; touching their domain does not automatically require
a call. Do not let storage types silently define a public API contract.

For material burst, overload, dependency failure, recovery, or shutdown-under-load
questions, the selected test-engineer/performance-specialist may use
load-resilience-testing against the exact candidate. This adds no production-load
authorization or implementation authority. Larger pools/queues/retry counts are not
evidence of improved performance.

Pass resolved invariants, source/evidence locations, scope, acceptance checks, and
mutation boundary using the global task packet. Prefer one relevant specialist and
one writer; add independent roles only under current policy or explicit user request.

For additional optional techniques, search `extended.md` and read the relevant section.
Its archived mandatory wording does not override current global routing policy.
