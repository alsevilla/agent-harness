# Pi agent harness

#ai #coding #ai-agents #pi #developer-tools #agent-orchestration

An independent, unofficial harness profile for [Pi](https://github.com/earendil-works/pi), the minimal extensible coding agent by Mario Zechner. It is not an official Pi project and is not endorsed by its authors.

- Tested baseline: Pi 1.1.0 on Windows with Node 24.20.0 (targeted checks; see [Status and limits](#status-and-limits)).
- Source release: v1.3.0.
- The npm package `@alsevilla/pi-engineering-harness` is **UNPUBLISHED** until explicit approval. Install the profile manually as described in [Quickstart](#quickstart) and [Install](#install).

## What it does

The profile provides:

- 23 named agent roles with explicit models, thinking levels and delegation boundaries (`agent/agents/`, `agent/roles.json`), including four read-only RFID attendance-domain specialists and a scoped release engineer. The npm package ships 18 generic defaults.
- Engineering, frontend, backend and RFID attendance skills, loaded selectively (`agent/skills/`).
- A subagent extension ([details](agent/extensions/subagent/README.md)): DAG launches of up to 8 nodes (at most 4 running at once); a process-local workspace admission queue; background jobs with steering, pause, resume and cancel, plus a live inspector; compact handoff reports (background completion notices are capped at 4,000 characters; `subagent_control` `result` returns the full retained report while the job is among the last 64 finished); completed workers stay inspectable in history; and a provider cooldown shared across the whole Pi host session (not only subagent children) for Anthropic and OpenAI Codex HTTP calls.
- `/subagent roles`, which edits one role's primary model, fallbacks and thinking level through native dialogs.
- Optional read-only Serena, Graphify and QMD integrations for code workers ([setup](#code-navigation-setup-optional)). Core orchestration works without them only in the installed npm package. In the live profile, the 23 configured roles list integrations: Ponytail is required for every role except `reviewer` (optional there), and QMD, Serena and Graphify are optional, so a missing one is skipped with a launch note instead of blocking the launch.

- Prompt shortcuts and native commands, listed in [Commands](#commands).
- A Git identity environment extension, and the Claude subscription guard correction for obsolete inline tool references.

## How it works

Routing is risk-based and conditional. The model is asked to follow this policy; the runtime enforces only the controls listed in [Status and limits](#status-and-limits). Not every task runs every phase, and no fixed context size is assumed.

1. **Classify** the task T0–T4 by uncertainty and consequence.
2. **Load only what the task needs.** Main reads the engineering-harness router once per session; modules load only their relevant sections (`agent/skills/engineering-harness/`).
3. **Route to one named role** with an explicit packet: a direct edit for T0 mechanical work, one implementation worker with focused checks for T1, a `debugger` before any unknown-cause fix (T2), and specialist, independent verification or review only where risk warrants it (T3–T4).
4. **Check with evidence.** Meaningful behavior gets a focused RED check before the change and GREEN after it, or an explained exception with replacement evidence.
5. **Keep humans in control.** Commit, push, merge, publish, deploy and destructive operations need explicit approval. Material missing decisions go to you through `ask_user`; cancellation, timeout or missing UI never counts as approval.

The full policy is [agent/AGENTS.md](agent/AGENTS.md). Routing criteria and procedures are in [agent/skills/engineering-harness/](agent/skills/engineering-harness/).

## Quickstart

Prerequisites: Pi 1.1.0, Node 24.20.0 (the tested Windows baseline), and your own Claude subscription or ChatGPT/Codex sign-in. No credentials are included.

1. Back up your current `~/.pi/agent`.
2. Copy `agent/AGENTS.md`, `agent/roles.json`, `agent/agents/`, `agent/extensions/`, `agent/prompts/` and `agent/skills/` into that profile, keeping your existing authentication and local configuration. Details: [Install](#install).
3. Install the listed npm packages through Pi and create local configuration from the examples.
4. Restart Pi and sign in with `/login anthropic` and `/login openai-codex`.
5. Run Pi from your project and open the worker inspector with `/subagent`.

Example, described and not executed here: type `/debug the save button ignores a second click`. The `/debug` prompt asks main to dispatch the `debugger` role with your request as its assignment packet; main does not diagnose the problem itself. After a fix, `/verify <what to check>` asks the `test-engineer` role for an independent check.

## Commands

Two kinds of command exist:

- **Prompt shortcuts** are Markdown files in `agent/prompts/`. The filename becomes the `/` command. Pi expands the template text and sends it to the model; a template is not executable behavior. Edit a template and run `/reload` in an active session at a safe point, after active workers finish (user guidance; the profile adds no automatic reload wait). An extension command with the same name is handled by the extension first.
- **Native commands** are handled by an extension or by Pi. They run without a model dispatch unless the row says otherwise.

### Workflow prompts (AI workflow)

These send a packet to the model. The workflow commands load a procedure; only `/debug`, `/verify` and `/review` dispatch a named subagent. Provider or model availability failures retry once with the agent's configured GitHub Copilot fallback, only before any tool call.

| Command | What it does | Source |
| --- | --- | --- |
| `/discover <packet>` | Applies the engineering-harness discover module to your assignment. Does not dispatch a role by itself. | [prompt](agent/prompts/discover.md) |
| `/plan <packet>` | Applies the plan module to the assignment. | [prompt](agent/prompts/plan.md) |
| `/execute <packet>` | Applies the execute module. Main still routes writes through a named worker. | [prompt](agent/prompts/execute.md) |
| `/debug <request>` | Dispatches the `debugger` subagent with a packet built from your request. The orchestrator does not diagnose. | [prompt](agent/prompts/debug.md) |
| `/verify <request>` | Dispatches the `test-engineer` subagent for independent verification. | [prompt](agent/prompts/verify.md) |
| `/review <request>` | Dispatches the `reviewer` subagent for review. | [prompt](agent/prompts/review.md) |
| `/ship <packet>` | Applies the ship module. Commit, push and PR actions still need explicit authorization under the policy. | [prompt](agent/prompts/ship.md) |
| `/learn <packet>` | Applies the learn module. | [prompt](agent/prompts/learn.md) |
| `/worktree <packet>` | Applies the worktree module for checkout placement and disposition. | [prompt](agent/prompts/worktree.md) |
| `/integrate <packet>` | Applies the integrate module. | [prompt](agent/prompts/integrate.md) |
| `/knowledge <packet>` | Applies the knowledge module. | [prompt](agent/prompts/knowledge.md) |
| `/decision <packet>` | Applies the decision module. | [prompt](agent/prompts/decision.md) |

### Domain capability prompts (guidance only)

These load one skill module as guidance. They do not dispatch a worker or choose a design. Unresolved, material frontend design or UX choices go to `ui-ux-specialist` before `frontend-worker`; accepted designs need no extra UX phase. `/rust-axum-engineering` applies only when the stack matches.

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

| Command | What it does | Source |
| --- | --- | --- |
| `/subagent` | With a UI, opens the live worker inspector or a menu (Inspect workers, Edit roles, Create agent). Without a UI it prints the command hint. | [subagent README](agent/extensions/subagent/README.md) |
| `/subagent list`, `steer #N <message>`, `pause bg-N`, `resume bg-N`, `stop #N`, `result bg-N` | Controls running or retained workers. These controls make no model call. `result` returns the full retained report for recent finished jobs. | [subagent README](agent/extensions/subagent/README.md#steering-pause-and-cancellation) |
| `/subagent usage` | Prints counts of settled agent tasks in this Pi run. Costs are reported figures, not a bill. | [subagent README](agent/extensions/subagent/README.md) |
| `/subagent roles` | Opens native dialogs to change one user role's primary model, fallbacks and thinking level. Nothing is written until you confirm Save. | [subagent README](agent/extensions/subagent/README.md) |
| `/subagent create` | Operator-only. Previews project-local agent files and writes them only after you choose CREATE. It is not a model tool. | [subagent README](agent/extensions/subagent/README.md) |
| `Ctrl+Shift+W` | Shortcut that opens the live subagent inspector directly. | [subagent README](agent/extensions/subagent/README.md) |
| `/refresh graph [absolute checkout]` | Updates the existing `graphify-out/graph.json` for the current Git checkout or an explicit one. It never initializes a graph. | [refresh README](agent/extensions/refresh/README.md) |
| `/refresh qmd` | Updates every collection in the QMD extension's named index. No embeddings or hooks. | [refresh README](agent/extensions/refresh/README.md) |
| `/refresh serena` | Asks the loaded Serena package's `/serena-restart` command (not registered by this profile) to restart the existing Serena worker; it errors if that command is not loaded. | [refresh README](agent/extensions/refresh/README.md) |
| `/revoke-authorization` | Withdraws session authorizations (single-use grants and release-engineer push leases). Running children keep their copies until they exit. | [subagent README](agent/extensions/subagent/README.md) |
| `/provider-cooldown` | Shows the provider cooldown state, or refreshes one provider's auth after you re-authenticate. | [subagent README](agent/extensions/subagent/README.md) |
| `/engineering-harness`, `/agent-creation` | Bare aliases that queue the native `/skill:engineering-harness` or `/skill:agent-creation` command with your arguments. They create nothing. If another command owns the name, the alias is disabled and the `/skill:` form still works. | [subagent README](agent/extensions/subagent/README.md) |

Other native features: `ask_user` is a tool for asking you a question with Pi's native dialogs (see [Interactive user questions](#interactive-user-questions-ask_user)). Browser and Graphify guidance are skills (see [Canonical browser and graph skills](#canonical-browser-and-graph-skills)).

## Documentation

Human-facing guides, grouped by purpose:

**Tutorials**
- [Quickstart](#quickstart): first manual install and first commands.

**How-to**
- [Install](#install): manual profile installation, packages, configuration and login.
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
- Skills: [engineering-harness](agent/skills/engineering-harness/SKILL.md), plus the frontend, backend, RFID attendance, [browser](agent/skills/browser/SKILL.md) and [graphify](agent/skills/graphify/SKILL.md) catalogs under `agent/skills/`.
- [pi-package/README.md](pi-package/README.md): readme for the separately built npm package. It is a distinct component document, not a second entrypoint.
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
- **Human control, fail closed.** Material missing decisions go to you through `ask_user`; cancellation, timeout or missing UI never counts as approval. Policy asks that nothing publishes, commits, pushes, reloads or deletes without explicit approval. A bounded lexical runtime guard blocks listed risky operations; no OS sandbox enforces this.
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
| Workers could run risky shell operations or touch secret files | A `tool_call` guard on main and children blocks listed risky operations and fails closed if a child's guard is missing. TUI `request_authorization` mints exact, single-use, expiring grants, or one session-only release-engineer PR-branch push lease (`push_branch`). Bounded lexical matcher, not an OS sandbox; unsupported forms are listed. | Runtime with disclosed limits |

Verified scope: the live check covered background batching and `/subagent usage` only. General live TTY, the `/subagent roles` wizard, platform parity and invoice reconciliation are not verified.

## Status and limits

- Install steps below name Pi 1.1.0 as the tested baseline; Pi 1.0.4 is historical. Targeted local checks ran on Windows with Node 24.20.0 and Pi 1.1.0 (subagent package defaults, roles editor and agent-creation collision guard). Public `pi-ai/compat` imports were verified on Pi 1.1.0 only; no minimum historical Pi version is claimed. Historical targeted Node 22.19 and Node 24.20 Windows checks for the subagent push-authorization fix (guard, unit and runtime suites; see [safety-core tests](agent/extensions/subagent/tests/safety-core.test.ts) and [guard runtime tests](agent/extensions/subagent/tests/safety-guard-runtime.node.ts)) are not full-stack Node 22 compatibility. Native macOS and Linux runs, live TTY behaviour, a clean host and interactive TTY behaviour are also unverified. These are not a blanket compatibility claim.
- Roles use Anthropic (Claude) and OpenAI Codex (GPT) models. The profile uses direct Claude subscription and ChatGPT/Codex sign-in; CLIProxyAPI is not required. You need your own sign-in or API key; no credentials are included.
- Role discovery covers the profile's user roles in `agent/agents/`. Project roles in `.pi/agents/` use their own frontmatter.
- Changes to subagent extension files take effect only after a Pi reload or restart at a safe point, once active workers finish.
- `/subagent create` is an operator-only native command in interactive sessions. It previews the files and writes a project-local agent only after you choose CREATE. A created agent is not active until used with `agentScope` `project` or `both`; creation is not trust, reload or launch.
- Admission, DAG state and background capacity are per Pi process. They do not coordinate separate processes or machines. The cooldown does not cover Codex WebSocket transport.
- Workers are not an OS sandbox. Role permissions and `readOnly` declarations are policy, not isolation.
- Policy versus runtime: the routing, evidence, authority and reporting rules (T0–T4, TDD, handoff format, approval) are instructions the model is asked to follow, not runtime guarantees. The runtime enforces: the provider guard, package discovery fail-closed, `ask_user` no-UI, cancel and timeout (never treated as approval), the DAG bounds (8 nodes, at most 4 running), the 4,000-character background notice cap, the `/subagent create` CREATE gate, and the `tool_call` safety guard with TUI `request_authorization` grants. The safety guard is a bounded lexical matcher with disclosed limits (see the subagent README); its approval dialog was checked only in a simulated TUI, not a live terminal.
- Models and providers depend on your account and catalog.
- The repository starts from a fresh source snapshot without the previous repository's history. The older root-level GSD/skills/extensions stack is retired; do not reinstall it alongside the current profile.

## Install

Manual installation. There is no automatic installer or launcher, and the npm package is not published.

Back up your current `~/.pi/agent` first. Copy `agent/AGENTS.md`, `agent/roles.json`, `agent/agents/`, `agent/extensions/`, `agent/prompts/` and `agent/skills/` into that profile. Preserve existing authentication and unrelated local configuration. Remove conflicting old skill or extension copies deliberately rather than merging two stacks blindly.

For a fresh profile, copy `agent/settings.example.json` to `settings.json`. For an existing profile, merge the example's package and extension settings into your current settings. Install the listed packages through Pi. The code workers expect these packages under `~/.pi/agent/npm/node_modules`:

```text
pi install npm:pi-claude-subscription-connector
pi install npm:pi-mcp-adapter
pi install npm:@bacnh85/pi-serena
pi install npm:graphify-pi
pi install npm:@dietrichgebert/ponytail
```

Copy each extension's `config.example.json` to `config.json`. Set your own Git identity in engineering-environment. In qmd, set the absolute Node executable and installed QMD CLI paths for your machine, plus the existing shared index name (default `index`). The example Windows paths must be changed on other machines. Install QMD separately and configure collections before using its retrieval tools; this profile does not ship a search database or rebuild indexes during retrieval.

Apply the optional connector correction as described in [patches/claude-subscription-connector](agent/patches/claude-subscription-connector/README.md). Restart Pi (after updating, cancel and relaunch any old workers), then sign in with `/login anthropic` using the connector's offered OAuth flow and `/login openai-codex`. Model availability depends on your provider and catalog; inspect agent frontmatter and `agent/roles.json` before using the profile. Configured availability fallbacks require a separate GitHub Copilot sign-in.

Run Pi from your project. `/subagent` opens worker history and live activity; its command controls and the orchestrator's `subagent_control` tool support steering and pause/resume. See the [subagent documentation](agent/extensions/subagent/README.md). The inspector's outside-click compatibility path depends on Pi TUI internals and should be rechecked after a Pi upgrade. Changes to subagent extension files take effect only after a Pi reload or restart at a safe point, once active workers finish.

To update a clean local checkout (fast-forward only, on `master`):

```bash
git -C ~/.pi pull --ff-only
```

## Interactive user questions (ask_user)

The main profile loads its own [ask-user extension](agent/extensions/ask-user/README.md). The `ask_user` tool uses Pi's native selection and text-input dialogs for choices, typed answers and sequential batches. No `pi-ask-user` npm package, custom overlay or extra decision-gating skill is required. Restart or reload Pi after updating. Background leaves return missing decisions to the orchestrator rather than opening prompts. The extension preserves the essential question, options, context and batch fields; old package-specific rendering and toggle settings are not used.

Questions remain for material missing requirements, preferences or authority. Existing authorization is reused. Cancellation, timeout, blank answers and unavailable UI are unanswered states, never approval. Subagent worker decisions (`request_decision`) are not shown through this tool; main answers them with `subagent_control` decisions, answer or decline actions.

## Selective instruction loading

`agent/AGENTS.md` keeps routing, authority, recovery ownership, pause controls, evidence and runtime boundaries. Detailed role-selection criteria, recovery, worker controls, integration behavior and Git attribution live under `agent/skills/engineering-harness/references/` and load only when relevant. The harness entry selects a phase; it does not preload those references.

Main loads the harness once per session, reuses available guidance across tasks and reads only missing relevant sections. Queue-only requests record work for later without starting domain reads or workers. Changed or lost guidance is reread when needed.

Implementation workers use precise `edit` with read-only Serena navigation; bulk `write` and Serena mutation tools are excluded. Workers report RED and GREEN commands and results for meaningful behavior, or an explained exception with replacement evidence. These are prompt requirements; the runtime does not enforce test-first order. Review checks that evidence without duplicating worker implementation. Scout, DevOps and UI/UX retain short role contracts with optional topic references. Applying a harness upgrade follows the [upgrade checklist](agent/skills/engineering-harness/references/upgrade-checklist.md).

## Canonical browser and graph skills

Six profile skills are discoverable: engineering-harness, frontend, backend, RFID attendance, browser and graphify. Frontend and backend modules remain references, with SolidJS guards around cross-framework examples; do not delete useful framework-independent design modules merely because some examples use another framework.

The profile registers one browser skill at [agent/skills/browser/SKILL.md](agent/skills/browser/SKILL.md). The skills filter excludes the duplicate inherited `~/.agents` browser guide from this Pi profile without changing that shared file. graphify-pi remains an always-loaded native extension, with its package skill disabled; both main and code workers load [agent/skills/graphify/SKILL.md](agent/skills/graphify/SKILL.md). Ordinary graph queries use the bounded, standard-library `read_graph.py` helper and write no query stamps, vocabulary sidecars or feedback records. Build and update procedures require an actual authorized artifact-write assignment. Unused upstream Graphify pipeline references and their obsolete version marker were removed; read-only query and explicit build procedures remain.

## Manual data refresh

Main provides `/refresh graph`, `/refresh qmd` and `/refresh serena` as direct extension commands. They run maintenance without an orchestrator model request and do not add another skill or agent. See the [refresh documentation](agent/extensions/refresh/README.md) for targets, configuration and verification.

- Graph: updates existing code artifacts for the current repository or an explicit absolute target. A primary or global graph is never chosen automatically as a write destination.
- QMD: refreshes existing collections in the configured shared index without embeddings, git pulls or configured update hooks.
- Serena: hands the request to the installed native restart command; its status and errors remain visible in Pi. Existing background workers have separate Serena bridges.

These commands refresh data or runtime state, not npm or Python packages. Use them after a meaningful batch of changes rather than after every edit.

## Worktree placement and disposition

New task checkouts use `<primary-parent>/worktrees/<repo>/<task>` unless the user or project explicitly chooses another location. Task scratch copies, fixtures and logs go in `_scratch/<task>` under that repo folder; durable evidence and backups go in `_evidence/<task>`. For artifact-producing assignments, main supplies exact absolute scratch and evidence directories in the task packet, and code leaves return missing paths instead of choosing sibling folders. Main performs disposition after confirmed merge or delivery: it removes idle, integrated, clean task-owned checkouts and reports why others remain. Dirty, unmerged, paused or active and user-owned environments are retained; no watcher deletes them automatically.

Moving live SQLite or build-output directories requires authorized downtime, stopped owners and intact sidecars (`-wal`, `-shm`). Unknown restart configuration does not block authorized relocation; leave services stopped until the executable, environment and DB path are verified. See the [worktree procedure](agent/skills/engineering-harness/worktree/index.md).

## Betterwright artifacts and Windows launchers

Screenshots continue to save under `~/.betterwright/artifacts/<session-id-hash>/`. A local test screenshot was created and inspected on October 7, 2026. For an isolated one-shot task, use `run ... --no-daemon --close`; for multi-step browsing, keep the named session and close it when finished.

The local Windows launcher correction hides background daemon and worker consoles and routes the existing shims through installed source. See [the patch instructions](agent/patches/betterwright-windows/README.md). Package updates can overwrite local corrections. Direct calls to a separately compiled Betterwright executable can bypass the source-launcher patch.

## Verification record

Before publication, the profile's dispatch, worker controls and inspector were checked with local mock and native-TUI tests; QMD retrieval and Serena candidate navigation were checked against local backends. Those checks do not establish subscription billing, token savings, live model reliability or compatibility with later Pi versions. Compatibility was checked against the installed Pi 1.1.0 resource loader (1.0.4 historical), all 23 role definitions, registry/frontmatter agreement, referenced module paths and explicit worker integrations. Smaller instruction text does not prove a measured reduction in billed tokens. The [validation record](agent/VALIDATION.md) lists the October 7, 2026 regression pass, including live Serena and QMD checks and the difference between mock-worker verification and provider reliability.

## Code navigation setup (optional)

In the installed npm package, core orchestration works without any of the three integrations below: routing, named roles, DAG and background subagents, handoffs, `/subagent roles`, `ask_user` and agent creation. In the live profile, the 23 configured roles list these integrations as required, and a missing listed integration blocks that role's launch (see Current behavior below).

The full code-navigation experience needs three separately installed components. Each needs its own CLI, extension or index, and configuration. This package and profile bundle or auto-install none of them.

- **Serena** (symbol and reference navigation): `pi install npm:@bacnh85/pi-serena`, plus its own Python/backend requirements. Bridge health and project activation are not verified by configuration checks.
- **Graphify** (architecture graph references): `pi install npm:graphify-pi` and an existing Graphify Python interpreter. Reads an existing `graphify-out/graph.json`; no graph is built here, and you maintain it (`/refresh graph` updates an existing one).
- **QMD** (BM25 search over indexed local notes): install the QMD CLI, copy `agent/extensions/qmd/config.example.json` to `config.json`, set the Node and CLI paths and the existing index name, and create your own collections. No index is shipped or rebuilt by retrieval.

The code workers also load Ponytail (`npm:@dietrichgebert/ponytail`). Setup steps are in the [install section](#install), with details in the [refresh](agent/extensions/refresh/README.md), [QMD](agent/extensions/qmd/README.md) and [engineering environment](agent/extensions/engineering-environment/README.md) READMEs.

Current behavior: code roles are listed in `agent/extensions/subagent/integrations.json`. Ponytail is required for every listed role except `reviewer`; a missing Ponytail extension fails that launch with a `Code integration missing` error that names the package to install, and no configuration overrides that. QMD, Serena and Graphify are optional: a missing one is skipped, its integration-only tools are not granted, and the launch note names it so the worker uses permitted read/grep/find navigation. Launch checks detect missing files only; a present but unhealthy backend is not detected, and a failing tool is reported rather than retried. Packaged installs list no code roles and need none of these components.

## Privacy and local files

Authentication (`auth.json`), sessions, installed packages, caches, search indexes, generated graphs, binaries and machine-local settings are ignored by Git. Commit configuration examples only. Do not put credentials, tokens or machine-specific paths in shared files. Existing graphs and indexed notes are reference material; candidate source reads, edits and tests target the assigned checkout.

## Contributing

Create a feature branch and open a pull request against `master`. Do not push directly to `master`. Community expectations are in [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).

## Licenses and notices

- Original work in this repository: [MIT](LICENSE), Copyright (c) 2026 Pi agent harness contributors.
- Pi (earendil-works/pi, MIT, Copyright (c) 2025 Mario Zechner) and bundled third-party files keep their own notices. See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
- Pi example-derived code is covered by [PI-LICENSE](agent/PI-LICENSE); the connector correction retains its MIT license. Skill-specific licenses remain with their modules.
- Runtime dependencies are installed separately and are not bundled here.
