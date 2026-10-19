# Conditional routing and evidence

Read only when the next role or gate is uncertain. User requirements and the compact AGENTS policy govern authority; this reference adds no universal pipeline.

## Discovery
Use `scout` only when the relevant location, dependency surface, or existing behavior is not already sufficiently known. Scout reads the assigned `discover` module.

Skip Scout when the user, error, compiler, test, or previous evidence already identifies the relevant files/components.
Scout answers **where / what is affected**, not **why it fails**.

## Debugging
A request to fix an existing malfunction is a bug-fix incident.
If root cause is not established by evidence: `debugger -> worker`.
Add Scout first only when location/blast radius is unknown. Add a specialist only when debugging exposes a material unresolved domain decision. Add independent verification/review only when risk warrants it.
Debugger may be skipped when evidence already establishes the cause and the remaining work is implementation-only.
If a speculative fix fails or produces an unexplained regression, use debugger before another speculative patch.

## Specialists
Specialists are conditional. Do not summon a specialist merely because code touches that domain. Use one only when there is a material unresolved decision or risk that the worker should not decide alone.

Typical ownership:
- Database implementation (SQL/schema/migrations/transactions/queries/indexes/ORM/repositories/data access and DB tests) -> `database-worker`; unresolved material database invariants/semantics -> `database-specialist`
- Tokio/races/backpressure/shutdown -> `concurrency-specialist`
- auth/secrets/trust/privilege -> `security-specialist`
- public/typed API contract -> `api-specialist`
- subsystem boundaries/major tradeoffs -> `architecture-specialist`
- measured performance/overload -> `performance-specialist`
- device protocol/physical I/O, domain state machines, event ordering, provider delivery semantics or personal-data policy -> a project-local domain specialist when the project defines one (not part of this generic profile); otherwise return the decision to main
- deployment/service/backups -> `devops-specialist`
- logs/metrics/health/audit -> `observability-specialist`
- UX/design judgment -> `ui-ux-specialist`

One specialist is preferred. Multiple specialists require distinct unresolved questions.

Use project-local domain specialists, when the project defines them, only when a material business/event/provider/privacy decision is unresolved; skip them when the task is implementation against a confirmed contract or the uncertainty belongs to another discipline. Specialists are read-only advisors, not an automatic phase or implementation gate. Their self-contained packet should name the exact unresolved question, candidate/evidence paths, known constraints, relevant scope, forbidden assumptions and requested decision/evidence. The handoff should separate confirmed facts, options/tradeoffs, boundary examples, acceptance evidence and explicit open questions; return unresolved business, legal, privacy, consent, provider or retention policy to main rather than inventing it.

Keep adjacent ownership distinct: device protocol and physical I/O -> the project's device owner, when defined; database implementation -> `database-worker`, with unresolved material invariants/semantics analyzed by `database-specialist`; Tokio task/queue/race/shutdown behavior -> `concurrency-specialist`; auth, secrets and access control -> `security-specialist`; API/provider contract -> `api-specialist`; deployment, service and backup operations -> `devops-specialist`. A domain specialist may describe implications but does not decide those implementation/operational contracts. Main assigns file seams and one writer for mixed tasks; no automatic specialist/worker chain.

## Frontend
If the task requires a real design/UX decision, use `ui-ux-specialist` before `frontend-worker`.
Skip the design specialist when the design is already approved or the change is a localized implementation/presentation fix with no design judgment.

## Platform and infrastructure
Accepted Terraform, Kubernetes, kubectl, Azure CLI, Helm, FluxCD and GitHub Actions workflow file changes -> `platform-worker` (editing only; it never applies, triggers, publishes or deploys). Unresolved infrastructure design, topology or release timing -> `devops-specialist` first (read-only); release execution and delivery -> `release-engineer`.
Route by the named technology: FluxCD is GitOps; InfluxDB Flux is a query language and goes to the owning data role, not `platform-worker`, unless the task names both. Jira JQL, Confluence CQL and gh/curl automation -> `general-worker`; NRQL -> `observability-specialist`; REST contracts -> `api-specialist`.
Grafana dashboards, queries, alerts and Kiali mesh diagnosis -> `observability-specialist`; approved Grafana/Kiali provisioning and Snyk, SonarQube or Prisma Cloud CI gate wiring -> `platform-worker` (gate results enforced as set by policy; never suppressed); scanner vulnerability, IAM and compliance policy -> `security-specialist`. Prisma Cloud is the security platform, not Prisma ORM.

## Verification
Workers must run focused tests/checks appropriate to their implementation.
Use independent `test-engineer` only when one or more is true:
- business-critical/state-machine/data-integrity behavior changed;
- regression risk is material;
- implementation spans multiple modules/layers;
- concurrency/retry/queue behavior changed;
- migration/persistence semantics changed;
- user explicitly requests independent verification;
- worker evidence is incomplete or suspect.

A normal localized T1 change does not require a separate test agent if the worker provides credible focused test evidence.

## Review
Reviewer is **not automatic**.
Use `reviewer` for materially risky changes such as security/auth, concurrency, migrations, state machines, destructive behavior, data integrity, cross-module refactors, public API compatibility, disputed findings, or high-impact business logic.
Skip reviewer for routine localized changes that already have credible implementation and test evidence.

## Oracle
Use `oracle` only when:
- credible high-impact disagreement remains after normal review;
- data-loss/security/correctness risk is severe and unresolved;
- two reasonable fix attempts failed and root cause remains disputed.
Never use Oracle as routine second opinion.

## Release / SHIP / LEARN
Use `release-engineer` when the task actually enters SHIP or LEARN.

SHIP remains conditional: ordinary coding completion is not a release. `release-engineer` reads `engineering-harness/ship/index.md`, validates exact candidate/version, fresh evidence, migrations/config/artifacts, destination and explicit authority, and performs only authorized release operations.

LEARN is also conditional: `release-engineer` reads `engineering-harness/learn/index.md` only when stable reusable knowledge is worth preserving. Do not create session summaries as durable knowledge.

`devops-specialist` owns unresolved deployment/service/backup design. `release-engineer` owns release readiness/execution against the resolved operational contract. Distinct questions may justify both; neither may launch the other.

## Explicit Pi model tier
Pi-only, main-owned judgment. Set `modelTier: "economy"` on one task only for a bounded, known-contract backend or frontend implementation: the acceptance contract, file seam and focused checks are already declared, and no design, API, security, concurrency, persistence or cross-module decision remains open. The role must configure economy. Otherwise omit the field: the role's `defaultModelTier` runs unchanged, and omission never avoids economy when that default is economy. High-risk work on an economy-default role requests configured `capable` explicitly (omission would run economy); when that role does not configure `capable`, the selection is unresolved and goes to main, never economy by omission. Otherwise `capable` is chosen only when the task's own risk needs it; there is no automatic escalation or retry upgrade. Never economy for complex, unresolved, security-sensitive, concurrency, persistence or cross-layer work; that work stays on capable (the omitted default when it is capable, or explicit `capable` on an economy-default role) or a specialist route. Requests with unsupported tier names (for example `complex`, `fast` or `premium`) are refused before launch. This selection applies only the requested tier's configured model, fallback and thinking to that task; it changes no stored role default, preset or tools, and it measures no saving.

### Explicit Pi fallback slot
Pi-only, main-owned judgment. Add `modelSlot: "fallback"` to one entry (with an explicit `modelTier`) only when that task needs its existing role to run on that tier's configured fallback model, for example a selected independent inspection by a task-appropriate capable role. A fallback is not automatically cross-provider; it differs only relative to that role's primary, so inspect the actual provider/model in the result. Diversity is required only when explicitly selected as a gate; if it was not achieved, report the unmet gate instead of relabeling the run. The slot adds no role, router, loop or automatic challenge, never replays to the primary, and an invalid, unconfigured or unusable fallback is refused or fails before work and returns to main.

Scenarios:
- backend-worker: add one validated field to an existing endpoint whose schema and focused tests are named in the packet -> explicit economy.
- frontend-worker: adjust presentational state of an existing component whose design is already approved and whose focused tests are named -> explicit economy.
- backend-worker: auth, secrets, migration or concurrency change -> no explicit economy; explicit `capable` (its default is economy; omission would run economy), the owning specialist first when a decision is open.
- frontend-worker: UX or design choice without approved design -> ui-ux-specialist first, no explicit economy.
- database-worker: consequential migration or persistence change -> explicit `capable` (its default is economy; omission would run economy).
- platform-worker: consequential infrastructure change -> explicit `capable` (its default is economy).
- test-engineer: data-integrity verification -> explicit `capable` (its default is economy).
- scout (economy only): high-risk task -> unresolved, main decides or a specialist route; no capable tier exists and omission runs economy.

## Task shape
Shape is orthogonal to the T0-T4 uncertainty/risk tier: it chooses how independent or dependent work is sequenced, not whether a role, specialist, tester or gate is needed. Shape never overrides user authorization, leaf/no-helper rules or lossless chain facts.
- Enumerable independent batch (items, order and ownership known in advance; no back-and-forth): may run in parallel only within existing runtime limits (parallel <=8 tasks with <=4 concurrent; DAG <=8 nodes with <=4 running) and workspace admission, with disjoint ownership. A high-risk item keeps its tier; parallelism does not downgrade T3/T4 review or verification.
- Ordered pipeline (stages known in advance, each needing the parent's actual result): use chain or DAG dependencies. Never parallelize dependent facts.
- Feedback loop (the next step depends on the result): keep it bounded and main-owned: root cause -> focused check -> fresh worker packet. Unknown-cause failures go to `debugger` first. No automatic self-looping helpers, new modes or unbounded retries.

## Planning
Do not create a formal multi-step plan for trivial/localized work. Use `plan` when dependencies, sequencing, rollout, migration, or cross-layer coordination make an explicit execution contract materially useful.

PLAN is main-owned. `architecture-specialist` may supply architecture constraints/options before planning, but does not own worker sequencing, specialist gates, verification routing, or authorization. Use `decision` through main when an architectural choice itself requires explicit authorization.

## Lifecycle
Lifecycle: `DISCOVER -> PLAN -> EXECUTE -> VERIFY -> REVIEW -> INTEGRATE -> SHIP -> LEARN`
This is a state model, not a mandatory list of model calls. Skip phases that are not needed. A small task may legitimately be `EXECUTE -> local verification -> done`. DEBUG is inserted when cause is unknown. INTEGRATE/SHIP/LEARN run only when the task actually requires them.

When SHIP or LEARN is selected, the named owner is `release-engineer`.

## Critical correctness invariants
Preserve existing project invariants and user requirements.

For persistence/state machines/concurrency:
- prefer explicit constraints and idempotency;
- keep transactions short;
- do not perform external work inside DB transactions;
- avoid blocking work on async executors;
- avoid locks across `.await` unless deliberately justified;
- bound queues and define overload behavior;
- define task ownership/cancellation/shutdown;
- test state transitions and boundary conditions;
- treat migrations/destructive operations as high risk.

For security:
- validate at trust boundaries;
- do not expose secrets;
- preserve authorization and least privilege;
- escalate uncertain security-sensitive behavior to `security-specialist`.

## Agent failure
A failed/empty agent launch is not evidence. `0 tool uses` may still be valid only if the role received sufficient supplied evidence and returned substantive analysis; otherwise treat it as BLOCKED/UNKNOWN.
Do not repeatedly relaunch expensive agents with unchanged prompts. Fix the blocker or change the route.

## Context discipline
Keep task packets concise. Prefer file paths + relevant snippets/evidence over full files.
Default output targets:
- Scout/specialist/debugger: concise handoff, normally <= 700 words.
- Worker: concise completion + changed files + tests.
- Tester/reviewer/release-engineer: findings/evidence only, normally <= 700 words.
Longer output is justified only when the evidence itself requires it.
Do not load extended reference documents unless the compact skill says the task needs them.

## Packet discipline
Send task, absolute candidate, requirements/expected behavior, relevant evidence locations, authorized/forbidden scope and output/checks. VERIFY/REVIEW also need exact candidate identity and accepted contract. SHIP needs exact candidate/version, destination and operation authority. Leaves do not inherit main history. Role frontmatter is injected; assigned modules are read explicitly, not assumed preloaded. Missing essentials yield a specific missing-input handoff. Reuse loaded guidance and refresh only evidence affected by candidate changes.
