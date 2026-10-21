# Agent Harness

## Table of contents

- [Copilot CLI preview boundary](#copilot-cli-preview-boundary)
- [What it does](#what-it-does)
- [How it works](#how-it-works)
- [Quickstart](#quickstart)
- [Commands](#commands)
  - [Workflow prompts (AI workflow)](#workflow-prompts-ai-workflow)
  - [Domain capability prompts (guidance only)](#domain-capability-prompts-guidance-only)
  - [Native and subagent commands (no model dispatch)](#native-and-subagent-commands-no-model-dispatch)
- [Documentation](#documentation)
- [Why this harness](#why-this-harness)
  - [Practices we draw on](#practices-we-draw-on)
- [Orchestrator and subagent problems solved](#orchestrator-and-subagent-problems-solved)
- [Status and limits](#status-and-limits)
- [Installation](#installation)
- [Interactive user questions (ask_user)](#interactive-user-questions-ask_user)
- [Selective instruction loading](#selective-instruction-loading)
- [Optional skill catalogs](#optional-skill-catalogs)
  - [Load a catalog by path](#load-a-catalog-by-path)
  - [Duplicates and exclusions](#duplicates-and-exclusions)
  - [Parent sessions and subagents](#parent-sessions-and-subagents)
  - [Graphify and browser](#graphify-and-browser)
  - [Skills and tools](#skills-and-tools)
  - [Limits](#limits)
- [Manual data refresh](#manual-data-refresh)
- [Worktree placement and disposition](#worktree-placement-and-disposition)
- [Betterwright artifacts and Windows launchers](#betterwright-artifacts-and-windows-launchers)
- [Verification record](#verification-record)
- [Code navigation setup (optional)](#code-navigation-setup-optional)
- [Privacy and local files](#privacy-and-local-files)
- [Contributing](#contributing)
- [Licenses and notices](#licenses-and-notices)


## Copilot CLI preview boundary

| Asset or capability | Copilot CLI preview status |
| --- | --- |
| Source release | v1.9.1 (GitHub repository: [alsevilla/agent-harness](https://github.com/alsevilla/agent-harness); migrated with preserved history). |
| Agents and skills | The native plugin displayed all 20 canonical agents and six shared skills. One `backend-worker` read-only delegation and an `engineering-harness` skill invocation were observed; this does not establish execution of every role or skill, model inheritance across roles, or every module path. Native Copilot agent headers carry no `model:`, so Copilot uses the outer session model (an approved tradeoff); `agent/roles.json` tiers are Pi-only and never resolved by Copilot. Native `tools:` aliases stay in each header and are deliberately not mapped to Pi tools. The canonical `agent/AGENTS.md` is shared source, not an automatic Copilot-global policy. |
| Session startup context | The native SessionStart hook loads the same installed canonical `agent/AGENTS.md` and `agent/skills/SKILLS.md` from `COPILOT_PLUGIN_ROOT`; relevant skill modules remain lazy-loaded. This reuses canonical context without duplicating policy, index or role trees. Five focused hook cases and two bounded native fixture prompts (with no available tools) verified injection; this does not establish global marketplace installation, resume variants, all roles, or Pi lifecycle/job/grant/extension/patch parity. The hook reads only those two policy files, never `agent/roles.json` or tier presets; it is a native preview, not Pi TypeScript runtime parity. |
| Pi-specific runtime assets | Pi extensions, patches, `agent/roles.json` and `settings.example` remain Pi-specific; no Pi prompt export or Copilot emulation of Pi controls is claimed. Agent headers carry no Pi metadata; roles.json is the single source of Pi settings. The `unknown field ignored: metadata` warning was observed on the earlier headers that carried Pi-only metadata and was accepted, not suppressed. The observed CLI was Copilot v1.0.97; this is historical evidence, not a pinned minimum or SDK-loader compatibility claim. |
| Prompts and commands | Shared prompt files are not exported to Copilot; Pi's `/learn` export is unchanged. Native question evidence covered choices and freeform input only, not Pi job/grant/control parity. |
| Verification and availability | Initial native validation confirmed the 20-agent/six-skill inventory, one worker read, choice/freeform questions, and bounded SessionStart context injection. Preview with the tested local `copilot --plugin-dir .` path; marketplace install commands are unpublished-preview instructions, not verified installation steps until a future merge/remote test. For that initial validation, no authentication, global activation, commit, push, merge or release was performed. |

## What it does

The profile provides:

- 20 named agent roles with explicit models, thinking levels and delegation boundaries (`agent/agents/`, `agent/roles.json`), including a read-only database-specialist for material unresolved cross-engine semantics and a database-worker for all database implementation across SQL, NoSQL, ORM, and repository access; backend-worker owns APIs/services/business logic, and mixed work is split by main with one writer. SQLite/SQLx guidance applies only to that actual engine. Also including a scoped release engineer and a platform-worker for accepted Terraform, Kubernetes, Helm, Azure CLI, FluxCD and GitHub Actions workflow file changes (editing only; it never triggers runs, publishes or deploys). It also wires CI gates for Snyk, SonarQube and Prisma Cloud (Prisma Cloud, not Prisma ORM) and implements approved Grafana or Kiali provisioning; policy and gate thresholds come from the repository or user, and `security-specialist` advises on vulnerability, IAM and compliance policy. Domain-specific roles belong to each project, not this generic profile. The native package exposes these 20 generic roles, including database-specialist for read-only material unresolved cross-engine semantics and database-worker for all database implementation. backend-worker owns APIs/services/business logic; main splits mixed tasks with one writer. SQLite/SQLx guidance applies only to that actual stack.
- Two native skills (`engineering-harness`, `agent-creation`). The backend, frontend, browser and graphify catalogs under `agent/skills/` are optional: Pi discovers them when `agent/` is your agent directory, and otherwise you load one by path ([optional skill catalogs](#optional-skill-catalogs)).
- Two native extensions: subagent ([details](agent/extensions/subagent/README.md)) and ask-user.
- A subagent extension ([details](agent/extensions/subagent/README.md)): model lookup resolves the latest complete installed SDK release. DAG launches of up to 8 nodes (at most 4 running at once); optional Pi-only `economy`/`capable` task tiers when configured for a canonical package role (omitted tasks run the role's `defaultModelTier`; per-task selection across single, parallel, chain and DAG dispatch, plus an explicit `modelSlot: "fallback"` start on a tier's first configured fallback; see the [subagent guide](agent/extensions/subagent/README.md#optional-pi-task-model-tiers)); a process-local workspace admission queue; background jobs with steering, pause, resume and cancel, plus a live inspector; compact handoff reports (background completion notices are capped at 4,000 characters; `subagent_control` `result` returns the full retained report while the job is among the last 64 finished); completed workers stay inspectable in history; and a provider cooldown shared across the whole Pi host session (not only subagent children) for Anthropic and OpenAI Codex HTTP calls.
- `/subagent roles`, which edits one role's default tier model, fallbacks and thinking level through native dialogs; other tiers are kept. `/subagent usage` estimates provider-reported usage and cost; it is not billing. For tiered roles, foreground task diagnostics show the resolved tier and actual model, whether the tier was explicit or the role's default (the label does not say which); estimates remain based on existing usage/cost reporting.
- Optional read-only Serena, Graphify and QMD integrations for code workers ([setup](#code-navigation-setup-optional)). Core orchestration works without them. Code roles listed in `agent/extensions/subagent/integrations.json` use integrations: Ponytail is required for every listed role except `reviewer` (optional there), and QMD, Serena and Graphify are optional, so a missing one is skipped with a launch note instead of blocking the launch.

- Prompt shortcuts (`/learn` is exported by the native package; the other ones are manual, optional files) and native commands, listed in [Commands](#commands).
- Optional components that the native manifest does not export; load them separately: a Git identity environment extension (`engineering-environment`) and the Claude subscription guard correction for obsolete inline tool references.

## How it works

Routing is risk-based and conditional. The model is asked to follow this policy; the runtime enforces only the controls listed in [Status and limits](#status-and-limits). Not every task runs every phase, and no fixed context size is assumed.

1. **Classify** the task T0–T4 by uncertainty and consequence.
2. **Load only what the task needs.** Main reads the engineering-harness router once per session; modules load only their relevant sections (`agent/skills/engineering-harness/`).
3. **Route to one named role** with an explicit packet: a direct edit for T0 mechanical work, one implementation worker with focused checks for T1, a `debugger` before any unknown-cause fix (T2), and specialist, independent verification or review only where risk warrants it (T3–T4).
4. **Check with evidence.** Meaningful behavior gets a focused RED check before the change and GREEN after it, or an explained exception with replacement evidence.
5. **Keep humans in control.** After the required checks pass, a task that includes PR delivery is delivered automatically by the trusted `release-engineer` (task-owned commit, non-force feature push, create or update of the task's own open same-repo PR) with no extra approval prompt, grant, lease or `request_authorization` call; a local-only/no-publication instruction or a failed or blocked check suppresses it (an orchestration gate, not a runtime check). PR merge and release creation have no automatic path: each needs its own explicit approval (merge: exact PR plus the approved candidate HEAD SHA, fingerprint-bound; release: version plus target SHA), one never authorizes the other, and neither is inferred. Dangerous or unsupported operations remain protected. Material missing decisions go to you through `ask_user`; cancellation, timeout or missing UI never counts as approval.

The full policy is [agent/AGENTS.md](agent/AGENTS.md). Routing criteria and procedures are in [agent/skills/engineering-harness/](agent/skills/engineering-harness/).

## Quickstart

Prerequisites: a current Pi installation, Node.js 22.19.0 or newer, and your own Claude subscription or ChatGPT/Codex sign-in. No credentials are included.

1. Check out this repository at a path you control, for example `C:/path/to/agent-harness`.
2. Install it as a native package with `pi install git:github.com/alsevilla/agent-harness`. Details, including the default-branch note and the optional local checkout: [Installation](#installation).
3. Optionally install the third-party integrations and create local configuration from the examples (`engineering-environment`, `qmd` and `refresh` only if you load them separately). Core orchestration does not need them.
4. Restart Pi and sign in with `/login anthropic` and `/login openai-codex`.
5. Run Pi from your project and open the worker inspector with `/subagent`.

Example, described and not executed here (it needs the manual `/debug` and `/verify` prompt files, which the native package does not export): type `/debug the save button ignores a second click`. The `/debug` prompt asks main to dispatch the `debugger` role with your request as its assignment packet; main does not diagnose the problem itself. After a fix, `/verify <what to check>` asks the `test-engineer` role for an independent check.

## Commands

Two kinds of command exist:

- **Prompt shortcuts** are Markdown files in `agent/prompts/`. The filename becomes the `/` command. The native package exports one prompt template, `/learn`, through its manifest; installing it adds no other workflow or domain command below. The other workflow and domain prompts are manual, optional files: they appear only if you load `agent/prompts/` yourself. Pi expands the template text and sends it to the model; a template is not executable behavior. Edit a template and run `/reload` in an active session at a safe point, after active workers finish (user guidance; the profile adds no automatic reload wait). An extension command with the same name is handled by the extension first.
- **Native commands** are handled by a native extension (for example `subagent`) or by Pi. They run without a model dispatch unless the row says otherwise.

### Workflow prompts (AI workflow)

Prompt templates: `/learn` is exported by the native package; the other workflow templates are manual, optional files. They send a packet to the model when loaded. The workflow commands load a procedure; only `/debug`, `/verify` and `/review` dispatch a named subagent. Provider or model availability failures retry once with an available configured fallback, only before any tool call. Copilot CLI integration is a limited native preview: SessionStart loads canonical startup context as described above; marketplace installation remains unverified. This does not remove Pi's built-in GitHub Copilot model provider.

| Command | What it does | Source |
| --- | --- | --- |
| `/discover <packet>` | Applies the engineering-harness discover module to your assignment. Does not dispatch a role by itself. | [prompt](agent/prompts/discover.md) |
| `/plan <packet>` | Applies the plan module to the assignment. | [prompt](agent/prompts/plan.md) |
| `/execute <packet>` | Applies the execute module. Main still routes writes through a named worker. | [prompt](agent/prompts/execute.md) |
| `/debug <request>` | Dispatches the `debugger` subagent with a packet built from your request. The orchestrator does not diagnose. | [prompt](agent/prompts/debug.md) |
| `/verify <request>` | Dispatches the `test-engineer` subagent for independent verification. | [prompt](agent/prompts/verify.md) |
| `/review <request>` | Dispatches the `reviewer` subagent for review. | [prompt](agent/prompts/review.md) |
| `/ship <packet>` | Applies the ship module. The task packet must explicitly authorize the delivery stage and scope; normal delivery does not require a separate runtime grant or lease. | [prompt](agent/prompts/ship.md) |
| `/learn <packet>` | Applies the learn module: dedupes, then dispatches `release-engineer` to save one verified lesson only with explicit destination authority; the default LOCAL-ONLY destination is the ignored `docs/knowledge/local/` store, with no commit, push or publication. | [prompt](agent/prompts/learn.md) |
| `/worktree <packet>` | Applies the worktree module for checkout placement and disposition. | [prompt](agent/prompts/worktree.md) |
| `/integrate <packet>` | Applies the integrate module. | [prompt](agent/prompts/integrate.md) |
| `/knowledge <packet>` | Applies the knowledge module. | [prompt](agent/prompts/knowledge.md) |
| `/decision <packet>` | Applies the decision module. | [prompt](agent/prompts/decision.md) |

### Domain capability prompts (guidance only)

Manual, optional prompt templates (not exported by the native package): each loads one skill module as guidance. They do not dispatch a worker or choose a design. Unresolved, material frontend design or UX choices go to `ui-ux-specialist` before `frontend-worker`; accepted designs need no extra UX phase. `/rust-axum-engineering` applies only when the stack matches.

| Command | Loads | Source |
| --- | --- | --- |
| `/accessible-ui-patterns` | Frontend accessible UI patterns (`agent/skills/frontend/accessible-ui-patterns/index.md`) | [prompt](agent/prompts/accessible-ui-patterns.md) |
| `/design-dashboards` | Frontend dashboard design (`agent/skills/frontend/design-dashboards/index.md`) | [prompt](agent/prompts/design-dashboards.md) |
| `/design-motion-principles` | Frontend motion principles (`agent/skills/frontend/design-motion-principles/index.md`) | [prompt](agent/prompts/design-motion-principles.md) |
| `/frontend-design` | Frontend design guidance (`agent/skills/frontend/frontend-design/index.md`) | [prompt](agent/prompts/frontend-design.md) |
| `/solidjs-engineering` | SolidJS engineering (`agent/skills/frontend/solidjs-engineering/index.md`) | [prompt](agent/prompts/solidjs-engineering.md) |
| `/typescript-advanced-types` | TypeScript advanced types (`agent/skills/frontend/typescript-advanced-types/index.md`) | [prompt](agent/prompts/typescript-advanced-types.md) |
| `/ui-ux-pro-max` | UI/UX pro-max guidance (`agent/skills/frontend/ui-ux-pro-max/index.md`) | [prompt](agent/prompts/ui-ux-pro-max.md) |
| `/ux-flow-wireframer` | UX flow wireframing (`agent/skills/frontend/ux-flow-wireframer/index.md`) | [prompt](agent/prompts/ux-flow-wireframer.md) |
| `/web-design-guidelines` | Web design guidelines (`agent/skills/frontend/web-design-guidelines/index.md`) | [prompt](agent/prompts/web-design-guidelines.md) |
| `/load-resilience-testing` | Backend load and resilience testing (`agent/skills/backend/load-resilience-testing/index.md`) | [prompt](agent/prompts/load-resilience-testing.md) |
| `/rust-axum-engineering` | Rust and Axum backend guidance (`agent/skills/backend/rust-axum-engineering/index.md`) | [prompt](agent/prompts/rust-axum-engineering.md) |
| `/sqlite-sqlx-engineering` | SQLite and SQLx backend guidance (`agent/skills/backend/sqlite-sqlx-engineering/index.md`) | [prompt](agent/prompts/sqlite-sqlx-engineering.md) |

### Native and subagent commands (no model dispatch)

The `/refresh` rows apply only when the optional `agent/extensions/refresh` component is loaded separately; the native package does not register them.

| Command | What it does | Source |
| --- | --- | --- |
| `/subagent` | With a UI, opens the live worker inspector or a menu (Inspect workers, Edit roles, Create agent). Without a UI it prints the command hint. | [subagent README](agent/extensions/subagent/README.md) |
| `/subagent list`, `steer #N <message>`, `pause bg-N`, `resume bg-N`, `stop #N`, `result bg-N` | Controls running or retained workers. These controls make no model call. `result` returns the full retained report for recent finished jobs. | [subagent README](agent/extensions/subagent/README.md#steering-pause-and-cancellation) |
| `/subagent usage` | Prints counts of settled agent tasks in this Pi run. Costs are reported figures, not a bill. | [subagent README](agent/extensions/subagent/README.md) |
| `/subagent roles` | Opens native dialogs to change one user role's default tier model, fallbacks and thinking level; other tiers are kept. Nothing is written until you confirm Save. | [subagent README](agent/extensions/subagent/README.md) |
| `/subagent create` | Operator-only. Previews project-local agent files and writes them only after you choose CREATE. It is not a model tool. | [subagent README](agent/extensions/subagent/README.md) |
| `Ctrl+Shift+W` | Shortcut that opens the live subagent inspector directly. | [subagent README](agent/extensions/subagent/README.md) |
| `/refresh graph [absolute checkout]` | Updates the existing `graphify-out/graph.json` for the current Git checkout or an explicit one. It never initializes a graph. | [refresh README](agent/extensions/refresh/README.md) |
| `/refresh qmd` | Updates every collection in the QMD extension's named index. No embeddings or hooks. | [refresh README](agent/extensions/refresh/README.md) |
| `/refresh serena` | Asks the loaded Serena package's `/serena-restart` command (not registered by this profile) to restart the existing Serena worker; it errors if that command is not loaded. | [refresh README](agent/extensions/refresh/README.md) |
| `/authorization` | Read-only, secret-free status of live single-use grants, push and push+commit leases, and merge/release grants (scope, validity and bounded reasons). Mutates nothing; no dialog. | [subagent README](agent/extensions/subagent/README.md) |
| `/revoke-authorization` | Withdraws session authorizations (single-use grants, release-engineer push leases and merge/release grants). Running children keep their copies until they exit or expire; pause or cancel them separately. | [subagent README](agent/extensions/subagent/README.md) |
| `/provider-cooldown` | Shows the provider cooldown state, or refreshes one provider's auth after you re-authenticate. | [subagent README](agent/extensions/subagent/README.md) |
| `/engineering-harness`, `/agent-creation` | Bare aliases that queue the native `/skill:engineering-harness` or `/skill:agent-creation` command with your arguments. They create nothing. If another command owns the name, the alias is disabled and the `/skill:` form still works. | [subagent README](agent/extensions/subagent/README.md) |

Other native features: `ask_user` is a tool for asking you a question with Pi's native dialogs (see [Interactive user questions](#interactive-user-questions-ask_user)). Browser and Graphify guidance are optional skill catalogs (see [Optional skill catalogs](#optional-skill-catalogs)).

## Documentation

Human-facing guides, grouped by purpose:

**Tutorials**
- [Quickstart](#quickstart): first native install and first commands.

**How-to**
- [Installation](#installation): Pi and GitHub Copilot CLI installation, optional packages, configuration and login.
- [Code navigation setup (optional)](#code-navigation-setup-optional): Serena, Graphify and QMD.
- [Manual data refresh](#manual-data-refresh) and the [refresh guide](agent/extensions/refresh/README.md).
- [Worktree placement and disposition](#worktree-placement-and-disposition).
- [Betterwright artifacts and Windows launchers](#betterwright-artifacts-and-windows-launchers).
- Component guides: [subagent](agent/extensions/subagent/README.md), [QMD](agent/extensions/qmd/README.md), [engineering environment](agent/extensions/engineering-environment/README.md), [ask-user](agent/extensions/ask-user/README.md), [Claude connector patch](agent/patches/claude-subscription-connector/README.md), [Betterwright patch](agent/patches/betterwright-windows/README.md).

**Reference**
- [agent/AGENTS.md](agent/AGENTS.md): the policy the model follows. It is the only repository and profile instruction file.
- [Commands](#commands) (this README).
- [Subagent README](agent/extensions/subagent/README.md): limits, controls, history and safety guard.
- [Validation record](agent/VALIDATION.md): historical October 7, 2026 regression pass.
- Skills: [engineering-harness](agent/skills/engineering-harness/SKILL.md) and [agent-creation](agent/skills/agent-creation/SKILL.md) are native exports. The backend, frontend, [browser](agent/skills/browser/SKILL.md) and [graphify](agent/skills/graphify/SKILL.md) catalogs under `agent/skills/` are optional ([setup](#optional-skill-catalogs)); they are not exported by the native package.
- [docs/knowledge](docs/knowledge/README.md): Pi-specific decision and knowledge records.

**Explanation**
- [Why this harness](#why-this-harness) and [Status and limits](#status-and-limits).

| Instruction surface | Audience | Authority |
| --- | --- | --- |
| This README | Humans | Overview and commands; does not override policy |
| `agent/AGENTS.md` | Model and maintainers | The sole repository and profile instruction file |
| `agent/skills/` | Model, loaded on demand | Procedures for named tasks |
| `agent/prompts/` | You, as typed shortcuts | Expanded text only; not executable behavior |
| Component READMEs | Maintainers of one extension, patch or package | Specialized guides; they do not repeat the policy |

## Why this harness

The following engineering rules are model-followed policy; only the explicitly described runtime controls are enforced by code. Workers are not an OS sandbox.

- **One orchestrator, cheapest sufficient route.** Policy: main classifies each task T0–T4 and takes the smallest route that fits: a direct edit for mechanical work, one worker with focused checks for known localized behavior, a debugger before any unknown-cause fix, and independent verification or review only when the risk warrants it.
- **Selective guidance.** Routers and modules load only the sections a task needs, so the orchestrator context stays focused.
- **Named role ownership.** Each role has an explicit model, thinking level and boundary. One writer owns each candidate checkout. Background and DAG launches are bounded (up to 8 nodes, at most 4 running) and share workspace admission within one Pi process.
- **Evidence before claims.** Meaningful behavior gets a focused RED check before the production change and GREEN after it. Policy: a failed required gate blocks delivery.
- **Human control, fail closed.** Material missing decisions go to you through `ask_user`; cancellation, timeout or missing UI never counts as approval. Explicit task-stage authorization remains required. Redundant normal-delivery gates have been removed for trusted `release-engineer` delivery (commit, feature push, PR create/update) after required checks pass; merge and release creation each need their own explicit grant; dangerous or unsupported operations remain protected by the bounded lexical runtime guard. No OS sandbox enforces this.
- **Bounded handoffs, lossless recovery.** Workers return compact reports, and the full retained child report stays available through `subagent_control` `result`. No measured token savings are claimed.
- **Native Pi controls.** `ask_user`; the `/subagent roles` editor, which saves only a user override; and `/subagent create`, an operator-only preview that writes project-local agents only after you choose CREATE.

Status: targeted offline checks on Windows with Node 24.20.0 and Pi 1.1.0, plus a post-reload live check of background completion batching and `/subagent usage` using two probe jobs. Historical targeted Node 22.19 and Node 24.20 Windows checks for the subagent push-authorization fix are not full-stack Node 22 compatibility. General live TTY or interactive dialog runs (including `/subagent create`), platform parity and invoice reconciliation were not verified, so no blanket verification is claimed. The npm package `@alsevilla/pi-engineering-harness` is **UNPUBLISHED** until explicit approval.

### Practices we draw on

These practices are reflected in this profile. The projects below are not bundled, and this does not imply their endorsement, command compatibility or parity.

| Project | Practice reflected here |
| --- | --- |
| GSD | Scope definition and checkpoints before implementation |
| Superpowers | Systematic debugging, TDD and verification before completion |
| Compound Engineering | Plan, work and review phases, with an optional learn step |
| gstack | Risk-based specialists, QA and release gating |
| ECC (Everything Claude Code) | Specialized roles, modular guidance, safety checks, config scanning and delegated usage reporting; full ECC coverage has not been audited |

## Orchestrator and subagent problems solved

Each row is marked as model-followed **policy** or **runtime** code. Limits are in the [subagent README](agent/extensions/subagent/README.md).

| Problem | Solution | Kind |
| --- | --- | --- |
| Orchestrator packets repeat long policy text for every worker | Short role-specific packets; shared contracts and evidence are referenced by path; common context is stated once, with a role delta. Guidance only, not a runtime cap; no token savings are measured. | Policy ([token efficiency](agent/skills/engineering-harness/references/token-efficiency.md)) |
| Every task loads all skill text | Routers and modules load only the sections a task needs; role bodies stay self-contained. | Policy |
| Each queued background completion could trigger its own orchestrator turn | Opt-in Pi `followUpMode` `all` (default `one-at-a-time`, set in your local Pi settings). Live check: two queued completions reached the next assistant turn together. | Pi setting; live-checked |
| Long child reports flood the parent context | Automatic completion notices are capped at 4,000 characters. A longer one starts `INCOMPLETE HANDOFF` and must not be accepted from its excerpt; the full retained report comes from `subagent_control` `result`. | Runtime |
| A job could report completion more than once | One completion per logical job, with regression tests for late per-node and per-child duplicates. No duplicate bug was confirmed or fixed. | Runtime regression guard |
| Fan-out usage and cost were unclear | `/subagent usage` (command-only) counts settled agent tasks per Pi run (single runs, chain steps, parallel tasks, DAG nodes), counts each fallback attempt once, keeps partial failures and aborts, and resets on reload or session change. Costs are reported figures, not a bill. | Runtime; live-checked against two child results |
| Workers could run risky shell operations or touch secret files | A `tool_call` guard on main and children blocks listed risky operations and fails closed if a child's guard is missing. Ordinary delivery by the trusted `release-engineer` (commit, feature push, PR create, and edit of the task's own open same-repo PR limited to title/body) is bound to that trusted actor and does not require a grant, lease or `request_authorization`; the orchestrator applies the required-checks and local-only gates before launching it. PR merge and release creation have no automatic path: each needs its own delivery action grant (merge: exact PR, approved HEAD SHA and verified candidate fingerprint; release: exact PR, version and target SHA, tag absent); single-use operation grants are refused for both and the former combined delivery grant shape is rejected. File-backed commit messages (double-quoted `-F`) and PR bodies use existing safe `_scratch/<task>` or `_evidence/<task>` directories under `worktrees/<origin repo name>` (the legacy primary-checkout-basename group is also accepted). `push_branch` leases remain compatible and optional for normal delivery; leases and merge/release grants are session-scoped and withdrawn by `/revoke-authorization` or session end, while running children keep their copies until they exit or expire. Dangerous and unsupported operations remain guarded. The bounded lexical matcher is not an OS sandbox; unsupported forms are listed. | Runtime with disclosed limits |

Verified scope: the live check covered background batching and `/subagent usage` only. General live TTY, the `/subagent roles` wizard, platform parity and invoice reconciliation are not verified.

## Status and limits

- Current support target is the current Pi release on Node.js 22.19.0 or newer; no minimum historical Pi version is claimed. Historical targeted local checks ran on Windows with Node 24.20.0 and Pi 1.1.0 (subagent package defaults, roles editor and agent-creation collision guard). Public `pi-ai/compat` imports were verified on Pi 1.1.0 only. Historical targeted Node 22.19 and Node 24.20 Windows checks for the subagent push-authorization fix (guard, unit and runtime suites; see [safety-core tests](agent/extensions/subagent/tests/safety-core.test.ts) and [guard runtime tests](agent/extensions/subagent/tests/safety-guard-runtime.node.ts)) are not full-stack Node 22 compatibility. Native macOS and Linux runs, live TTY behaviour, a clean host and interactive TTY behaviour are also unverified. These are not a blanket compatibility claim.
- Roles use Anthropic (Claude) and OpenAI Codex (GPT) models. The profile uses direct Claude subscription and ChatGPT/Codex sign-in; CLIProxyAPI is not required. You need your own sign-in or API key; no credentials are included.
- Role discovery covers the bundled generic roles (`agent/roles.json` and `agent/agents/*.md` in the native package), your user roles in the Pi agent directory's `agents/` folder (`~/.pi/agent/agents/` by default; user `roles.json` fields override a bundled role's fields), and project roles in `.pi/agents/`, which use their own frontmatter. Precedence: package < user < project.
- Changes to subagent extension files take effect only after a Pi reload or restart at a safe point, once active workers finish.
- `/subagent create` is an operator-only native command in interactive sessions. It previews the files and writes a project-local agent only after you choose CREATE. A created agent is not active until used with `agentScope` `project` or `both`; creation is not trust, reload or launch.
- Admission, DAG state and background capacity are per Pi process. They do not coordinate separate processes or machines. The cooldown does not cover Codex WebSocket transport.
- Workers are not an OS sandbox. Role permissions and `readOnly` declarations are policy, not isolation.
- Policy versus runtime: the routing, evidence, task-stage authority and reporting rules (T0–T4, TDD, handoff format) are instructions the model is asked to follow, not runtime guarantees. The runtime enforces: the provider guard, package discovery fail-closed, `ask_user` no-UI, cancel and timeout (never treated as approval), the DAG bounds (8 nodes, at most 4 running), the 4,000-character background notice cap, the `/subagent create` CREATE gate, and the `tool_call` safety guard. Trusted normal delivery does not require TUI `request_authorization` grants or leases; legacy authorization remains optional. Dangerous and unsupported operations remain guarded. The safety guard is a bounded lexical matcher with disclosed limits (see the subagent README); its approval dialog was checked only in a simulated TUI, not a live terminal.
- Models and providers depend on your account and catalog.
- Repository history was migrated and preserved at [alsevilla/agent-harness](https://github.com/alsevilla/agent-harness). The older root-level GSD/skills/extensions stack is retired; do not reinstall it alongside the current profile.

## Installation

Install each supported harness separately. This repository declares two: Pi (the native package) and GitHub Copilot CLI (limited native preview). Other harnesses are not declared or supported here.

### Pi

Native installation from the Git source. There is no automatic installer, and the package is not published to npm. Installing adds one package entry to `~/.pi/agent/settings.json`; `--local` or `-l` writes it to `.pi/settings.json` instead, which Pi reads only after project trust.

```text
pi install git:github.com/alsevilla/agent-harness
```

Pi treats a `git:` source as a Git package: it clones the repository and reconciles the checkout to the selected ref (`docs/packages.md`). Only a tag or commit ref is pinned, for example `git:github.com/alsevilla/agent-harness@<tag-or-commit>`. The unqualified source is not pinned: it follows the repository's default branch (`master`) and can move to newer commits when you run `pi update`; use a tag or commit ref when you need a pinned version.

**Optional development alternative: local checkout.** To run a working copy, install its absolute path. Pi loads the root `package.json` in place: the checkout is not copied into `~/.pi/agent`, and you update that checkout yourself.

```text
pi install C:/path/to/agent-harness
```

Use an absolute path for a local checkout. The install, remove and update commands in this section are standard Pi commands from Pi's package documentation (`docs/packages.md`, `docs/cli.md`); they were not executed in this verification. The package declares two default extensions (`agent/extensions/subagent`, `agent/extensions/ask-user`) and two skills (`agent/skills/engineering-harness`, `agent/skills/agent-creation`). The 20 generic roles are read from `agent/roles.json` and `agent/agents/`. `engineering-environment`, `qmd` and `refresh` are not in the default exports: they stay in the repository, and the sections below that describe them apply only if you load them separately.

Host Pi packages (`@earendil-works/*`, `typebox`) are `peerDependencies` supplied by Pi, not bundled. Restart Pi after installing. `/subagent roles` should then list the bundled roles; this live check is not part of the repository tests.

Settings: `agent/settings.example.json` is a broad example of a profile settings file, not a package-only list. It sets model defaults (`defaultProvider`, `defaultModel`, `defaultThinkingLevel`), `defaultTools`, `cacheWarming`, `quietStartup`, `lastChangelogVersion`, `extensions` and `skills` filters, and the optional third-party `packages`. Do not overwrite your live `~/.pi/agent/settings.json` with it. Copy only the entries you want into your existing settings, keeping existing authentication and unrelated local configuration, and check the model and tool defaults against your own setup. The native install itself adds only its package entry (see above).

Optional third-party integrations (not part of this package) are installed through Pi. The code workers expect these packages under `~/.pi/agent/npm/node_modules`:

```text
pi install npm:pi-claude-subscription-connector
pi install npm:pi-mcp-adapter
pi install npm:@bacnh85/pi-serena
pi install npm:graphify-pi
pi install npm:@dietrichgebert/ponytail
```

For each optional extension you load separately (`engineering-environment`, `qmd`, `refresh`), copy its `config.example.json` to `config.json`. In engineering-environment, set your own Git identity. In qmd, set the absolute Node executable and installed QMD CLI paths for your machine, plus the existing shared index name (default `index`). The example Windows paths must be changed on other machines. Install QMD separately and configure collections before using its retrieval tools; this profile does not ship a search database or rebuild indexes during retrieval.

Apply the optional connector correction as described in [patches/claude-subscription-connector](agent/patches/claude-subscription-connector/README.md). Restart Pi (after updating, cancel and relaunch any old workers), then sign in with `/login anthropic` using the connector's offered OAuth flow and `/login openai-codex`. Model availability depends on your provider and catalog; inspect agent frontmatter and `agent/roles.json` before using the profile. Configured availability fallbacks require a separate GitHub Copilot sign-in.

Run Pi from your project. `/subagent` opens worker history and live activity; its command controls and the orchestrator's `subagent_control` tool support steering and pause/resume. See the [subagent documentation](agent/extensions/subagent/README.md). The inspector's outside-click compatibility path depends on Pi TUI internals and should be rechecked after a Pi upgrade. Changes to subagent extension files take effect only after a Pi reload or restart at a safe point, once active workers finish.

**Update.** `pi update git:github.com/alsevilla/agent-harness` reconciles this package (`pi update --extensions` reconciles all installed packages; `pi update` alone updates Pi itself). Then restart Pi, or reload at a safe point after active workers finish. A local checkout is updated by you, not by Pi. The update command was not run in this verification, and this repository does not test the update flow.

**Remove.** `pi remove git:github.com/alsevilla/agent-harness` removes the package and its settings entry (`pi uninstall` is an alias), then restart Pi. Pi identifies git packages by repository URL without the ref. For a local checkout, use `pi remove C:/path/to/agent-harness`. The removal command was not run in this verification.

**Old manual copies (double-load).** Earlier installs copied `agent/` files into `~/.pi/agent`. Those copies and the native package can both load the same extensions and skills. Migrating them is a separate, coordinated step: this change does not remove, edit or reload any live copy. Back up `~/.pi/agent` before removing old copies, and remove them deliberately.

**Skill name collisions.** Pi discovers skills from several locations. When two skills share a name, Pi keeps the first one discovered and warns; the other is ignored. This package sets no priority between its skills and your user or project skills, so rename or remove a duplicate to get a predictable result.

**Local overrides.** Project-local roles under `.pi/agents/` stay project-scoped. A project role with the same name as a bundled role overrides it only in that project (covered by the isolated-profile tests).

### GitHub Copilot CLI

Limited native preview. This plugin is installed separately from the Pi package above; installing one does not install or change the other. Scope and limits: [Copilot CLI preview boundary](#copilot-cli-preview-boundary).

1. Register the marketplace (`alsevilla` is the marketplace name in `.github/plugin/marketplace.json`):

```text
copilot plugin marketplace add alsevilla/agent-harness
```

2. Install the plugin (`agent-harness` is the plugin name in `.github/plugin/plugin.json`):

```text
copilot plugin install agent-harness@alsevilla
```

3. Check discovery: `copilot plugin list` should list `agent-harness`. Start a Copilot session in your project; the plugin's SessionStart hook then loads the canonical policy context. This is a preview check, not a full activation test.

For a local checkout (the tested preview path), load the directory without installing it and confirm it is listed:

```text
copilot --plugin-dir C:/path/to/agent-harness plugin list
copilot --plugin-dir C:/path/to/agent-harness
```

Limits:

- The marketplace commands read the GitHub repository's default branch. Until this change is merged there, they do not install it. The remote add and install commands were not executed in this verification.
- Only the `copilot plugin` subcommands above were checked against the installed CLI help (version 1.0.97). The in-session `/plugin` form is not verified here.
- The plugin supplies agents, skills and SessionStart context. Pi-only parts are not part of the Copilot preview: shared prompt files are not exported, so `/learn` and the manual workflow prompts (such as `/debug`, `/verify`, `/review`) are Pi-only; the subagent and ask-user extensions, the QMD, Serena, Graphify and Ponytail integrations, `agent/roles.json` tiers and job/grant controls stay on the Pi side.

## Interactive user questions (ask_user)

The main profile loads its own [ask-user extension](agent/extensions/ask-user/README.md). The `ask_user` tool uses Pi's native selection and text-input dialogs for choices, typed answers and sequential batches. No `pi-ask-user` npm package, custom overlay or extra decision-gating skill is required. Restart or reload Pi after updating. Background leaves return missing decisions to the orchestrator rather than opening prompts. The extension preserves the essential question, options, context and batch fields; old package-specific rendering and toggle settings are not used.

Questions remain for material missing requirements, preferences or authority. Existing authorization is reused. Cancellation, timeout, blank answers and unavailable UI are unanswered states, never approval. Subagent worker decisions (`request_decision`) are not shown through this tool; main answers them with `subagent_control` decisions, answer or decline actions.

## Selective instruction loading

`agent/AGENTS.md` keeps routing, authority, recovery ownership, pause controls, evidence and runtime boundaries. Detailed role-selection criteria, recovery, worker controls, integration behavior and Git attribution live under `agent/skills/engineering-harness/references/` and load only when relevant. The harness entry selects a phase; it does not preload those references.

Main loads the harness once per session, reuses available guidance across tasks and reads only missing relevant sections. In the same active context, reuse already-read, unchanged guidance; selectively reread the required skill or module if compaction loses it or it has changed. Each new worker has an isolated context and loads its own applicable guidance once. The explicit `/engineering-harness` alias intentionally queues `/skill:engineering-harness`, which can expand the full entry again, so do not invoke it on every ordinary task as a cache. `/reload` refreshes resource and configuration catalogs; it is not a routine skill reread, and it revokes in-memory authorization grants, so settle active workers first. Native bundled-harness references resolve from the canonical installed package root; optional skill catalogs require their files/resources to be available. Native compact-policy recovery was SDK-tested through Pi's actual compaction API on 1.1.0 and 1.2.0; this does not guarantee the model retained every instruction or will comply. No persistent cache or runtime loaded-skill registry is claimed. Queue-only requests record work for later without starting domain reads or workers. Changed or lost guidance is reread when needed.

Automatic activation: when Pi loads this package natively (its root `package.json` is `@alsevilla/pi-engineering-harness`), the `subagent` extension adds the installed `agent/AGENTS.md` to the main session's system prompt as one `engineering_policy` section, followed by the absolute installed `engineering-harness/SKILL.md` path. The section is sent once per session and not replayed on later turns. It is never read from your profile or the working directory; if your profile `AGENTS.md` already contains the policy verbatim, the section is skipped to avoid a duplicate. If the installed policy cannot be read, the request gets a notice naming the file, and the session still answers. Use `/engineering-harness` (or `/skill:engineering-harness`) to load the full router explicitly. A live profile without this package root gets no injected policy, and subagent children are unchanged: they still start with `--no-skills` and do not load this extension.

Implementation workers use precise `edit` with read-only Serena navigation; bulk `write` and Serena mutation tools are excluded. Workers report RED and GREEN commands and results for meaningful behavior, or an explained exception with replacement evidence. These are prompt requirements; the runtime does not enforce test-first order. Review checks that evidence without duplicating worker implementation. Scout, DevOps and UI/UX retain short role contracts with optional topic references. Applying a harness upgrade follows the [upgrade checklist](agent/skills/engineering-harness/references/upgrade-checklist.md).

## Optional skill catalogs

The native package exports exactly two skills, `engineering-harness` and `agent-creation`, and two default extensions (`subagent`, `ask-user`). The backend, frontend, browser and graphify catalogs under `agent/skills/` are plain files: Pi discovers them when `agent/` is your agent directory, and otherwise you load one by path. Loading a catalog adds guidance only: it installs no CLI, MCP server, Python package or other tool.

| Catalog | Entry in this repository | Needs outside Pi (you install) |
| --- | --- | --- |
| backend | `agent/skills/backend/SKILL.md` | Rust toolchain, for Rust checks only |
| frontend | `agent/skills/frontend/SKILL.md` | Your project's test and runtime stack; Python 3.x for ui-ux-pro-max `search.py` |
| browser | `agent/skills/browser/SKILL.md` | `betterwright` CLI on `PATH` |
| graphify | `agent/skills/graphify/SKILL.md` | Python `graphify` CLI (package `graphifyy`), only for builds; queries use `scripts/read_graph.py` |

Other tools named in guidance (k6, oha, Vitest with `@solidjs/testing-library`, cargo) are optional and yours to install.

### Load a catalog by path

Your agent directory already discovers every catalog when the checkout's `agent/` folder is `<agent-dir>` (as in this profile, `~/.pi/agent`): each `SKILL.md` under `<agent-dir>/skills/` loads with no settings entry, and a path entry for it would be a second copy. Add a path entry only for a catalog outside your agent directory. Keep a local checkout and add the entry to the `skills` array of your existing `settings.json`, keeping the entries you already have:

```json
{
  "skills": [
    "!**/.agents/skills/browser/SKILL.md",
    "C:/path/to/agent-harness/agent/skills/backend/SKILL.md"
  ]
}
```

- `skills` takes files or directories; absolute and `~` paths are accepted. Pi reads a local path in place, so pull the checkout to update it.
- Run `/reload` after editing settings, and only after active workers finish ([Status and limits](#status-and-limits)).
- Do not add the whole checkout as a package to get one catalog: that also loads its two default extensions and both native skills.

### Duplicates and exclusions

- Pi discovers `<agent-dir>/skills/` recursively (`~/.pi/agent/skills/` by default). A second copy of a catalog is a skill with the same name: Pi keeps the first one found and warns about the other, so load each catalog from one path only.
- To stop a copy without deleting it, exclude it in the same `skills` array: `"!skills/backend"`. Pi's docs do not state the base for `!` patterns. `dist/core/package-manager.js` matches a user-settings pattern against the path relative to the agent directory, and for a `SKILL.md` also against its folder (`matchesAnyPattern`); auto-discovered `<agent-dir>/skills` entries are filtered by the same array (`addAutoDiscoveredResources`). This was read from the code and not verified by running Pi.
- Use the `skills/<catalog>` form. A bare `!backend` can also match unrelated folders with that name.

### Parent sessions and subagents

- Skills and `--skill` apply to the parent Pi session. Subagent children start with `--no-skills` (`agent/extensions/subagent/index.ts`), so they do not receive catalogs from your settings.
- For a worker to use a module, the task packet must give its absolute path, for example `C:/path/to/agent-harness/agent/skills/backend/rust-axum-engineering/index.md`, and say to read it.
- Role files and prompts refer to `~/.pi/agent/skills/...` literally (for example `agent/agents/frontend-worker.md`). Skill settings do not repoint those paths: keep the catalogs there or edit the references.
- The Graphify code integration passes `--skill <agent-dir>/skills/graphify/SKILL.md` when enabled ([code navigation setup](#code-navigation-setup-optional)).

### Graphify and browser

- **Graphify.** `graphify-pi` (npm) ships an extension and a skill both named `graphify`, which collides with the catalog. Keep one package entry with its skill disabled:

```json
{ "source": "npm:graphify-pi", "extensions": ["extensions/graphify.ts"], "skills": [] }
```

  The package provides `/graphify` and its hooks, with no LLM tools. The catalog answers questions about existing graphs through `scripts/read_graph.py`; builds and updates run only when explicitly assigned.
- **Browser.** The guide assumes `betterwright` is on `PATH`. If it is not, the guide says to use its verified launcher and not to reinstall or edit `PATH`. Install betterwright from its own project; this repository does not install it.

### Skills and tools

Skills add guidance only. Commands and tools come from extensions: the native extensions register their own (see [Installation](#installation)), and `graphify-pi` adds `/graphify`. Loading a catalog changes none of them.

### Limits

- This section documents the setup; it was not run against a live Pi profile. Run `/reload` and check the loaded skill list yourself.
- Catalog names are not separately published npm packages. Do not look for `npm:` entries for them.

## Manual data refresh

Not loaded by the native package (`refresh` is outside its default exports). When you load the optional component in `agent/extensions/refresh/` separately, it provides `/refresh graph`, `/refresh qmd` and `/refresh serena` as direct extension commands. They run maintenance without an orchestrator model request and do not add another skill or agent. See the [refresh documentation](agent/extensions/refresh/README.md) for targets, configuration and verification.

- Graph: updates existing code artifacts for the current repository or an explicit absolute target. A primary or global graph is never chosen automatically as a write destination.
- QMD: refreshes existing collections in the configured shared index without embeddings, git pulls or configured update hooks.
- Serena: hands the request to the installed native restart command; its status and errors remain visible in Pi. Existing background workers have separate Serena bridges.

These commands refresh data or runtime state, not npm or Python packages. Use them after a meaningful batch of changes rather than after every edit.

## Worktree placement and disposition

New task checkouts use `<primary-parent>/worktrees/<repo>/<task>` unless the user or project explicitly chooses another location. Task scratch copies, fixtures and logs go in `_scratch/<task>` under that repo folder; durable evidence and backups go in `_evidence/<task>`. For artifact-producing assignments, main supplies exact absolute scratch and evidence directories in the task packet, and code leaves return missing paths instead of choosing sibling folders. After a confirmed merge, the release engineer removes only the exact three targets the task packet names, while main schedules the cleanup: the idle, integrated, clean task-owned checkout (`git worktree remove`, no `--force`) and the exact `_evidence/<task>` and `_scratch/<task>` directories, each by the packet's exact removal operation; arbitrary directories are never deleted. Dirty, unmerged, paused, active, user-owned or unique-evidence targets are retained and reported; no watcher deletes them automatically. A separate Authorized retirement mode applies only when the user's authority names each exact path and operation and gives explicit discard consent for dirty or unmerged checkouts; it never follows from a merge or general cleanup, and still requires guard grants (see the [worktree procedure](agent/skills/engineering-harness/worktree/index.md)).

Moving live SQLite or build-output directories requires authorized downtime, stopped owners and intact sidecars (`-wal`, `-shm`). Unknown restart configuration does not block authorized relocation; leave services stopped until the executable, environment and DB path are verified. See the [worktree procedure](agent/skills/engineering-harness/worktree/index.md).

## Betterwright artifacts and Windows launchers

Screenshots continue to save under `~/.betterwright/artifacts/<session-id-hash>/`. A local test screenshot was created and inspected on October 7, 2026. For an isolated one-shot task, use `run ... --no-daemon --close`; for multi-step browsing, keep the named session and close it when finished.

The local Windows launcher correction hides background daemon and worker consoles and routes the existing shims through installed source. See [the patch instructions](agent/patches/betterwright-windows/README.md). Package updates can overwrite local corrections. Direct calls to a separately compiled Betterwright executable can bypass the source-launcher patch.

## Verification record

Before publication, the profile's dispatch, worker controls and inspector were checked with local mock and native-TUI tests; QMD retrieval and Serena candidate navigation were checked against local backends. Those checks do not establish subscription billing, token savings, live model reliability or compatibility with later Pi versions. Compatibility was checked against the installed Pi 1.1.0 resource loader (1.0.4 historical), all 18 role definitions, registry/frontmatter agreement, referenced module paths and explicit worker integrations. Smaller instruction text does not prove a measured reduction in billed tokens. The [validation record](agent/VALIDATION.md) lists the October 7, 2026 regression pass, including live Serena and QMD checks and the difference between mock-worker verification and provider reliability.

## Code navigation setup (optional)

Core orchestration works without any of the three integrations below: routing, named roles, DAG and background subagents, handoffs, `/subagent roles`, `ask_user` and agent creation. Code roles listed in `agent/extensions/subagent/integrations.json` use these integrations (see Current behavior below).

The full code-navigation experience needs three separately installed components. Each needs its own CLI, extension or index, and configuration. This package and profile bundle or auto-install none of them.

- **Serena** (symbol and reference navigation): `pi install npm:@bacnh85/pi-serena`, plus its own Python/backend requirements. Bridge health and project activation are not verified by configuration checks.
- **Graphify** (architecture graph references): `pi install npm:graphify-pi` and an existing Graphify Python interpreter. Reads an existing `graphify-out/graph.json`; no graph is built here, and you maintain it (`/refresh graph` updates an existing one).
- **QMD** (BM25 search over indexed local notes): install the QMD CLI, copy `agent/extensions/qmd/config.example.json` to `config.json`, set the Node and CLI paths and the existing index name, and create your own collections. No index is shipped or rebuilt by retrieval.

The code workers also load Ponytail (`npm:@dietrichgebert/ponytail`). Setup steps are in the [installation section](#installation), with details in the [refresh](agent/extensions/refresh/README.md), [QMD](agent/extensions/qmd/README.md) and [engineering environment](agent/extensions/engineering-environment/README.md) READMEs.

Current behavior: code roles are listed in `agent/extensions/subagent/integrations.json`. Ponytail is required for every listed role except `reviewer`; a missing Ponytail extension fails that launch with a `Code integration missing` error that names the package to install, and no configuration overrides that. QMD, Serena and Graphify are optional: a missing one is skipped, its integration-only tools are not granted, and the launch note names it so the worker uses permitted read/grep/find navigation. Launch checks detect missing files only; a present but unhealthy backend is not detected, and a failing tool is reported rather than retried. The native package lists code roles only through `integrations.json`; those roles still need Ponytail as described above.

## Privacy and local files

Authentication (`auth.json`), sessions, installed packages, caches, search indexes, generated graphs, binaries and machine-local settings are ignored by Git. Commit configuration examples only. Local learn notes stay in the ignored `docs/knowledge/local/` store and are not published or indexed unless shared publication is separately authorized. Do not put credentials, tokens or machine-specific paths in shared files. Existing graphs and indexed notes are reference material; candidate source reads, edits and tests target the assigned checkout.

## Contributing

Create a feature branch and open a pull request against `master`. Do not push directly to `master`. Community expectations are in [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).

## Licenses and notices

- Original work in this repository: [MIT](LICENSE), Copyright (c) 2026 Pi agent harness contributors.
- Pi (earendil-works/pi, MIT, Copyright (c) 2025 Mario Zechner) and bundled third-party files keep their own notices. See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
- Pi example-derived code is covered by [PI-LICENSE](agent/PI-LICENSE); the connector correction retains its MIT license. Skill-specific licenses remain with their modules.
- Runtime dependencies are installed separately and are not bundled here.
