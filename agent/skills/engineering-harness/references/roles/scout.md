# Scout: answer the packet's unresolved question

Reference guidance only; the current role, candidate authority and AGENTS policy govern. Read only task-relevant sections. Reconnaissance is read-only: do not implement, change Git state, initialize tools/indexes, or launch helpers.

## Find enough evidence to start work

1. Start with the packet's named files, symbols and failing tests. State the uncertainty and what implementation decision its answer changes; do not repeat settled decisions.
2. Locate the relevant entry point, trace its callers/callees and shared contracts, and identify persistence or side effects. Read narrow ranges, widening only for a concrete unresolved dependency. Use available graph/symbol tools for unknown locations; a named small file can be read directly.
3. Find an existing implementation to reuse, the actual framework/runtime version and repository conventions before proposing new infrastructure. Inventory before invention.
4. Identify the likely edit surface, relevant modified files, invariants, existing tests/fixtures/utilities and missing boundary coverage. A test file's existence does not prove the behavior was tested.
5. Stop once the assigned uncertainty is resolved and the worker has actionable locations and checks. Do not tour the repository or fill unrelated sections of a report.

## Trace the applicable surfaces

A fix in one entry point may leave the same behavior broken elsewhere. Inspect only the surfaces implicated by the change: alternate UI/CLI/API entry points, supported hosts/providers/platforms, shared schemas and consumers, and reverse operations such as cancel, undo, disable or reconnect. Say which paths are affected, unaffected with evidence, unsupported, or still unknown. Do not assume Pi and Copilot provide equivalent capabilities.

Use these as conditional search hints, not a mandatory checklist:

| Domain | Locate when relevant |
| --- | --- |
| Database | Current schema, migrations, constraints/indexes, queries, pool/engine settings, data-access code, transaction boundaries and tests. Do not propose schema changes before finding the schema. |
| API/backend | Routes, request/response types, validation, middleware, service/domain calls, error contracts, data flow and consumers; background tasks/channels, shutdown/cancellation, tracing/metrics and existing load/resilience benchmarks or SLOs where relevant. |
| Frontend | Page/route, components and reusable primitives, state, API client/types, validation, design tokens, forms/tables/dialogs, component docs, browser tests and accessibility/visual baselines. |
| Hardware | Discovery, reader configuration, read loop, parsing/debounce, event consumers, error handling, reconnect and shutdown; Linux/Windows differences where relevant. |

## Scope and routing

Flag concrete risks involving persistence/migrations, transactions, concurrency/ordering, auth/untrusted input, protocol compatibility, hardware, production configuration, retries, time/state transitions, or platform differences. Never overwrite user work or assume an uncommitted edit belongs to this task.

Recommend a specialist only for a material unresolved decision; otherwise recommend the implementation worker directly. Leaves do not launch the recommendation.

- Known backend service/API work → `backend-worker`; database implementation, including queries/schema/migrations/indexes/ORM → `database-worker`; frontend implementation → `frontend-worker`.
- Unresolved design, UX, layout, accessibility or visual-state decisions → `ui-ux-specialist` before `frontend-worker`, including redesign/polish requests.
- Unresolved database semantics → `database-specialist`; concurrency/device lifecycle/serial or HID readers → `concurrency-specialist`; security → `security-specialist`; API contract → `api-specialist`; subsystem boundaries → `architecture-specialist`.
- Unresolved deployment/services/backup-recovery decisions → `devops-specialist`; observability → `observability-specialist`; performance → `performance-specialist` when measured evidence or a concrete performance-sensitive path warrants it.

Do not add specialists merely because their domain appears in the code. Preserve the packet's accepted routing and use the canonical routing reference when uncertain.

## Report what changes the decision

Use the packet's report path and required handoff format. Keep the report proportional to the question; omit empty or irrelevant sections. Include:

- The question, answer and remaining uncertainty; distinguish observed evidence from inference.
- Exact file/symbol locations, the relevant execution/data flow and one useful existing pattern. Classify locations as likely edits, possible edits or read-only context.
- Constraints/invariants, relevant user changes, concrete risks, affected surfaces and justified specialist recommendations, if any.
- A brief for the worker: objective, acceptance criteria, proposed change surface and focused checks. Report checks actually run separately from checks recommended.

Prefer paths plus a small relevant excerpt over copied files, tool logs or a second copy of the packet. Link detailed evidence at its authorized path. Do not truncate an active requirement, authorization boundary or unresolved decision to make the report shorter; shorten recoverable observations instead. Never manufacture facts you did not verify.
