# Engineering Harness

A skill, a Pi extension and a GitHub Copilot CLI plugin that turn one coding agent into a small engineering team. A thin orchestrator (main) classifies each task, delegates it to named roles with a compact packet, accepts work only on reported evidence, and delivers through a trusted release role. A runtime safety guard and a few deterministic context rules keep long sessions cheap and safe.

## Table of contents

- [What you get](#what-you-get)
- [How it works](#how-it-works)
- [Install](#install)
  - [Pi](#pi)
  - [GitHub Copilot CLI](#github-copilot-cli)
- [Use it](#use-it)
- [Roles](#roles)
- [Safety and delivery](#safety-and-delivery)
- [Context and cost](#context-and-cost)
- [Optional components](#optional-components)
- [Copilot CLI limits](#copilot-cli-limits)
- [Limits](#limits)
- [Documentation map](#documentation-map)
- [Contributing](#contributing)
- [Licenses](#licenses)

## What you get

| Part | Path | What it does |
| --- | --- | --- |
| Policy | [`agent/AGENTS.md`](agent/AGENTS.md) | The 7-step protocol main follows on every task, plus a short Never list |
| Skill: `engineering-harness` | [`agent/skills/engineering-harness/`](agent/skills/engineering-harness/SKILL.md) | Routing criteria and phase procedures (discover, plan, execute, verify, review, ship, learn, worktree), loaded only when needed |
| Skill: `agent-creation` | [`agent/skills/agent-creation/`](agent/skills/agent-creation/SKILL.md) | Creating project-local roles |
| Roles | [`agent/roles.json`](agent/roles.json), [`agent/agents/`](agent/agents/) | 21 named roles with models, tiers, tools and boundaries |
| Extension: `subagent` | [`agent/extensions/subagent/`](agent/extensions/subagent/README.md) | Launching and controlling workers, handoffs, the safety guard, cleanup, usage |
| Extension: `ask-user` | [`agent/extensions/ask-user/`](agent/extensions/ask-user/README.md) | `ask_user` questions through Pi's native dialogs |
| Copilot plugin | [`.github/plugin/`](.github/plugin/) | The same agents, skills and startup context for Copilot CLI (preview) |

The native Pi package exports the two extensions, the two skills and one prompt template, `/learn`.

## How it works

Main follows a fixed protocol (full text: [`agent/AGENTS.md`](agent/AGENTS.md)):

1. **Classify** the task: T0 mechanical, T1 known and localized, T2 unknown cause, T3 material domain risk, T4 severe risk or disagreement.
2. **Gather** at most three named files plus read-only git status; every other read goes to a read-only role.
3. **Pick roles** by name (see [Roles](#roles)).
4. **Write one packet:** task, candidate, contract, evidence paths, scope, checks. By default the candidate is a feature branch in your main checkout; a worktree is used only for parallel writers, uncommitted user work, a live process on the main checkout, or when main must stay on the base branch.
5. **Delegate and wait.** Common sequences run as one fixed shape: T1 worker; T2 debugger → worker; T3 optional planner → optional specialist → worker → test-engineer, with an optional reviewer. A step that doesn't report `STATUS: PASS` stops the shape and returns to main.
6. **Accept on STATUS and EVIDENCE**, never by re-reading code; at most two fix rounds per task.
7. **Finish:** report changes, checks and residual risk, or deliver through `release-engineer`.

Workers reply in four lines (STATUS, NEXT, RISKS, EVIDENCE) and put detail in a REPORT file. Routing and evidence rules are instructions the model follows; the runtime enforces only what [Safety and delivery](#safety-and-delivery) and [Context and cost](#context-and-cost) describe.

## Install

Prerequisites: the latest Pi release (or GitHub Copilot CLI for the preview), Node.js 22.19.0 or newer, and your own Claude and/or ChatGPT/Codex sign-in. No credentials are included.

### Pi

Install the native package from its Git source:

```text
pi install git:github.com/alsevilla/agent-harness
```

The unqualified source is not pinned: it follows the default branch (`master`) and moves on `pi update`. Pin a version with `@<tag-or-commit>`. Restart Pi, sign in with `/login anthropic` and `/login openai-codex`, and run Pi from your project.

```text
pi update git:github.com/alsevilla/agent-harness
pi remove git:github.com/alsevilla/agent-harness
```

Optional development alternative: install a local checkout by absolute path, for example `pi install C:/path/to/agent-harness`. Pi loads it in place, so you update the checkout yourself.

[`agent/settings.example.json`](agent/settings.example.json) is an example profile. Do not overwrite your live `settings.json` with it; copy only the entries you want.

### GitHub Copilot CLI

Limited preview, installed separately from the Pi package:

```text
copilot plugin marketplace add alsevilla/agent-harness
copilot plugin install agent-harness@alsevilla
```

To try a local checkout without installing it: `copilot --plugin-dir C:/path/to/agent-harness`. See [Copilot CLI limits](#copilot-cli-limits).

## Use it

Describe the task to main as usual; it routes the work. Useful commands:

| Command | What it does |
| --- | --- |
| `/subagent` | Live worker inspector (also `Alt+I`; it was `Ctrl+Shift+W`, which Windows Terminal uses to close the tab) |
| `/subagent changes [#n or role]` | The files a worker changed, their git state, and the commands that would undo them (shown, never run) |
| `/subagent trace [#n or role]` | One worker's tool calls as plain text to paste for a cost review: target, output size, repeats, whole reads of large files, errors, and the outputs carried longest (no argument lists the workers) |
| `/subagent list`, `steer #N <message>`, `pause bg-N`, `resume bg-N`, `stop #N`, `result bg-N` | Control running or finished workers without a model call |
| `/subagent usage` | Usage per role, cost per completed task and main's context size |
| `/subagent roles` | Edit one role's default model, fallbacks and thinking level |
| `/subagent create` | Preview and create a project-local role (operator only) |
| `/authorization`, `/revoke-authorization` | Show or withdraw session approvals |
| `/learn <packet>` | Save one verified lesson to the ignored local knowledge store |

The other prompts in [`agent/prompts/`](agent/prompts/) (`/debug`, `/verify`, `/review`, `/plan` and the domain guides) are optional files you load yourself; they are not exported by the package.

## Roles

The native package exposes these 21 generic roles:

| Kind | Roles |
| --- | --- |
| Implementation (write code) | `backend-worker`, `frontend-worker`, `database-worker`, `platform-worker`, `general-worker` |
| Diagnosis and checks (read-only) | `debugger`, `test-engineer`, `reviewer`, `scout`, `planner` |
| Specialists (read-only advice) | `api-specialist`, `architecture-specialist`, `concurrency-specialist`, `database-specialist`, `devops-specialist`, `observability-specialist`, `performance-specialist`, `security-specialist`, `ui-ux-specialist` |
| Escalation | `oracle` |
| Delivery | `release-engineer` |

Each role's model, `economy`/`capable` tiers and tools live in `agent/roles.json`; its prompt uses the same five sections (Knows/loads, Before starting, Workflow, Where to look, Common failures). User roles in your Pi agent directory and project roles in `.pi/agents/` override bundled ones (package < user < project).

## Safety and delivery

A `tool_call` guard runs on main and every worker. It blocks risky shell operations (publish, destructive git, forced deletes, links, privilege changes, process kills, launching a Pi agent, changing installed Pi packages, curl-to-shell, unparseable commands) and any read, write or mention of secret files. Read-only roles (no `edit`/`write` tool, or a `readOnly` launch) also cannot change their candidate checkout through the shell: redirections, file-writing commands, in-place edits, and mutating git or package commands into it are refused, while their REPORT and evidence files go to the packet's `_evidence`/`_scratch` paths. Two rules follow Claude Code practice: a worker edits or overwrites an existing file only after reading it in that run, and a delete whose target is a variable, substitution, root, home, `.` or bare glob (`rm -rf $DIR/`) can never be approved. A block message names the rule, the program, whether an approval can ever help, and the next step; it never echoes command arguments. The guard is lexical and best-effort, not an OS sandbox.

| Risk | What happens |
| --- | --- |
| Ordinary delivery and risky operations | Trusted `release-engineer` delivery (commit, feature push, PR create, and title/body edit of the task's own open PR) needs no `request_authorization`, grant or `push_branch` lease after main confirms the checks passed; merge and release each need their own delivery approval, which lasts for the session until `/revoke-authorization` (running children keep their copies until they exit), and other risky operations need an exact single-use grant. |
| Merge | One approval names the exact PR and head SHA; the runtime computes and shows the candidate fingerprint itself. That one approval covers the merge, the knowledge checkpoint and the post-merge cleanup. |
| Release | Its own approval, naming version and target SHA; refused if the tag exists. |
| Cleanup after merge | The task's worktree (if any), then its `_scratch/<task>` and `_evidence/<task>` folders, each removed once after live checks that the PR merged as approved and nothing still uses them. |
| Your own rules | `harness-permissions.json` in your Pi agent directory: `{ "allow": ["Stop-Process -Id *"], "deny": ["git push --force*"] }`. Exact commands, or prefixes ending in `*`. Allow covers only what you could approve anyway (never secrets, unresolvable deletes, merge or release); deny blocks main and every worker. Agents cannot write the file. |
| Secrets | `.env*`, keys and credentials are never read or written. `node "<extension folder>/read-env-redacted.mjs" "<absolute .env path>"` shows settings with secret-like values hidden. |

**Optional OS sandbox (Linux and macOS).** Set `PI_SUBAGENT_SANDBOX=on` (or `require`, which refuses to launch without it) to run each worker under bubblewrap (`bwrap`) on Linux or Seatbelt (`sandbox-exec`) on macOS: the filesystem is read-only except the worker's checkout (writing roles only), the task's `_evidence`/`_scratch` folders, the temp folder and a few state folders; add more with `PI_SUBAGENT_SANDBOX_WRITABLE`. Network stays on, because the worker must reach the model. It is off by default; Windows has no equivalent here (use WSL2 for it).

Details, limits and every check: [subagent README](agent/extensions/subagent/README.md#safety-guard).

## Context and cost

- **Old results collapse.** In main's requests, the newest five subagent results stay word for word and older settled PASS results become one line each, in batches, so the cached prefix rarely changes. Main's own old large file and command outputs are masked the same way. `PI_SUBAGENT_HANDOFF_WINDOW=0` turns both off.
- **Runtime state card.** When the running jobs or waiting worker decisions change, main's request gets one hidden line naming them (and a cleared line when they end), so a compacted conversation still knows what is in flight. Each line stays where it first appeared, so later requests extend the cached prefix instead of rewriting it.
- **Shared text first.** Every worker prompt starts with the same shared guidance, so roles with the same model and tools can reuse one cached prefix.
- **Handoff check.** A worker that finishes without its STATUS line is asked once for the four-line handoff before it closes, so main doesn't have to re-ask.
- **Usage report.** `/subagent usage` shows cost per completed task and each role's peak request, and its Main context line suggests `/new` once main's context reaches 100k tokens.
- **Keep main lean.** Main's own history is what dulls an orchestrator, so run main at `medium` thinking and start a `/new` session after each merged task; `/reload` loads new harness code but keeps the conversation. Strong reasoning models can make weaker orchestrators as their context fills, and orchestrators kept to short per-worker status lines steered far more accurately than ones holding every worker's full context.
- **Lookup tools first.** Workers look up code the packet does not locate in this order: the graph to orient (when Graphify is installed), `qmd_search` for prior decisions (when QMD is), then Serena through the harness's own [`serena`](agent/skills/serena/SKILL.md) skill for definitions and callers, before broad `grep`/`find`. A small named file or symbol is read directly; a large source file goes through `outline` first; `grep` stays the tool for renames and literal text. The first broad `grep`/`find` of a worker run that has used none of them, and the first whole read of a large source file, each get one appended line pointing at them (nothing is blocked). The live view counts `serena`, `qmd` and `graphify` calls, including graph queries through the skill's `read_graph.py` helper.
- **Bounded packets.** Main names known locations (files, symbols, failing tests) and a stop condition; workers start there, stop there, and send long test, build or install output to a log in their `_scratch` folder.
- **Tool discipline.** Workers follow Claude Code's working rules: independent calls in one turn, partial reads with offset and limit, the read/grep/find tools instead of shell `cat`/`grep`, no `sleep` polling, no interactive commands, and no files the task does not need.
- **Threshold-triggered masking in workers.** Claude Haiku 5.5 charges 5x for a request over 100k input tokens. From about 80k tokens (system prompt included, and calibrated against the provider-reported size of the worker's previous request, since characters / 4 undercounts code) a worker's request is shortened step by step until it fits a 95k budget: main's stable batching, then every older large output, then every older output of 500 characters or more, then bounded large outputs except the latest, then (last resort) only the latest output kept and bounded to its first and last 8,000 characters; if it is still over, the host is asked to compact once. Best effort, not a hard bound: the estimate is approximate and compaction is asynchronous. `PI_SUBAGENT_WORKER_MASK_TOKENS` (`0` off) and `PI_SUBAGENT_WORKER_TOKEN_BUDGET` tune it, and `/subagent usage` shows each role's peak request and requests over 100k so you can check it.
- **No duplicate reads.** When a worker reads the same file and range again and gets exactly the same text, the result is a one-line note pointing at its earlier copy. Changed files, other ranges, images and errors pass through.
- **Execution ledger.** Every few calls, when it has changed, a worker's tool result ends with a short state view (kept in the history, so the cached prefix stays stable): files changed, reads still current or stale, the checks the packet names that have not run yet, and the latest result of each check. An identical repeated inspection becomes a one-line note. `PI_SUBAGENT_LEDGER=0` turns it off.
- **Long shell output capped.** A worker's shell output over 16,000 characters keeps its first 2,000 and last 8,000, and the full text goes to a file the worker can read. `PI_SUBAGENT_OUTPUT_CAP` sets the limit (`0` off).
- **Keep project `AGENTS.md` short.** Studies of context files found that repository overviews raise cost without improving results, while instructions are followed. Put rules and guardrails in a project's `AGENTS.md`, and move detail (architecture, routes, build notes) into project skills under `.agents/skills/` that agents read only when a task needs them.
- **Measure by cost per completed task.** `/subagent usage` shows it per role. Cache reads and writes dominate the bill, so fewer tokens alone is not a saving.

## Optional components

Not exported by the package; install or load them yourself.

- **Code navigation:** Serena (`uv tool install serena-agent`) is reached through the bundled [`serena`](agent/skills/serena/SKILL.md) skill: one shell command (`outline`, `find`, `refs`) and a small local server, with no tool schemas in the worker launch. Without Serena, or in a worktree it cannot serve, the skill answers with a heuristic parser and says so. Graphify (`uv tool install graphifyy`; the bundled Graphify skill and its read-only `read_graph.py` query the graph) and QMD (local search; [guide](agent/extensions/qmd/README.md)) are optional. Neither the pi-serena nor the graphify-pi extension is used: pi-serena added 11 tool definitions to every worker launch and was never called, and graphify-pi appended its own per-turn instructions that told workers to run graph updates. Installs: `serena-agent` and `graphifyy` (uv) and QMD. Ponytail (`npm:@dietrichgebert/ponytail`) is required for code roles except `reviewer`.
- **Skill catalogs:** backend, frontend, browser and graphify under `agent/skills/`. Load one by path in your `skills` settings when it isn't already in your agent directory.
- **Public web pages:** `defuddle parse <url> --md` when the external Defuddle skill is installed ([guidance](agent/skills/engineering-harness/references/runtime.md#public-web-content-optional-defuddle)).
- **Extras:** [`engineering-environment`](agent/extensions/engineering-environment/README.md) (Git identity), [`refresh`](agent/extensions/refresh/README.md) (`/refresh graph|qmd|serena`), and patches for the [Claude connector](agent/patches/claude-subscription-connector/README.md) and [Betterwright on Windows](agent/patches/betterwright-windows/README.md).

## Copilot CLI limits

The plugin shares agents, skills and startup context with Pi. It is a preview with these limits (full matrix: [docs/copilot-acceptance.md](docs/copilot-acceptance.md)):

| Asset | Status |
| --- | --- |
| Source release | v1.15.1 ([alsevilla/agent-harness](https://github.com/alsevilla/agent-harness)) |
| Copilot CLI | Latest release only; no older version is supported |
| Agents and skills | Shared from `agent/`; Pi tiers and job controls are not emulated |
| Delivery | Merge and release are unsupported on Copilot; an `ask_user` answer is not authorization |
| Guard | A deny-only, best-effort `preToolUse` hook: merge and release, plus the harness guard's never-run rules (secret files, unparseable commands, curl-to-shell, privilege, config writes, package auth); other risky commands go to Copilot's own approval. It is not OS isolation, so keep branch protection or rulesets and least-privilege tokens |
| Prompts | Not exported; `/learn` and the manual prompts are Pi-only |

## Limits

- Paths are compared case-insensitively on Windows and macOS, as their file systems are, and case-sensitively on Linux.
- Without the opt-in OS sandbox (Linux, macOS), workers are not OS-isolated: the guard's read-only and secret rules are lexical and best-effort. The sandbox enforces writes only, not network.
- Background admission, job ids and the DAG run per Pi process and in memory; after a reload or new session, old job ids are gone.
- Only the latest Pi release is supported. The package is not published to npm.
- Costs in `/subagent usage` are provider or catalog estimates, not a bill.

## Documentation map

| Document | For |
| --- | --- |
| [`agent/AGENTS.md`](agent/AGENTS.md) | The policy main follows |
| [`agent/skills/engineering-harness/`](agent/skills/engineering-harness/SKILL.md) | Routing and phase procedures |
| [Subagent README](agent/extensions/subagent/README.md) | Launch modes, handoffs, guard, grants, cleanup, usage: the technical reference |
| [docs/copilot-acceptance.md](docs/copilot-acceptance.md) | Copilot CLI acceptance matrix |
| [agent/VALIDATION.md](agent/VALIDATION.md) | Historical validation record |
| [docs/knowledge](docs/knowledge/README.md) | Decision and knowledge records |

## Contributing

Work on a feature branch and open a pull request against `master`. Tests are Node-only:

```text
npm test
```

Suites that need an installed Pi host are skipped, by name, when none is found; set `NATIVE_PROBE_HOST_MODULES` or install Pi to run them.

## Licenses

Original work: [MIT](LICENSE). Pi (earendil-works/pi, MIT) and bundled third-party files keep their own notices: [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md), [PI-LICENSE](agent/PI-LICENSE).
