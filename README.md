# Engineering Harness

A skill, a Pi extension and a GitHub Copilot CLI plugin that turn one coding agent into a small engineering team. A thin orchestrator (main) classifies each task, delegates it to named roles with a compact packet, accepts work only on reported evidence, and delivers through a trusted release role. A runtime safety guard and a few deterministic context rules keep long sessions cheap and safe: in our simulations a heavy worker task sends 49% fewer tokens and costs 73% less on Claude Haiku 5.5, a long main session costs up to 63% less, and a ten-task session costs 58% less with Claude Fable 5.1 as main, 44% less with Claude Opus 5.5, 66% less with GPT-6 Astra, and 27% less with GPT-6.1 Sol than one agent on the corresponding model working alone in fresh sessions per task ([Token savings](#token-savings)).

These are offline Pi simulation estimates using cheaper workers for non-complex tasks, not live billing or task-quality benchmarks. Savings depend on workload and routing; the ten-task harness costs more with Terra or Luna as main. Copilot is measured separately.

## Table of contents

- [What you get](#what-you-get)
- [How it works](#how-it-works)
- [Install](#install)
  - [Pi](#pi)
  - [GitHub Copilot CLI](#github-copilot-cli)
- [Use it](#use-it)
- [Roles](#roles)
- [Safety and delivery](#safety-and-delivery)
- [Token savings](#token-savings)
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

Lookup helpers outside the working directory also need Copilot directory access. For example: `copilot --plugin-dir /path/to/agent-harness --add-dir /path/to/agent-harness --add-dir /path/to/lookup-backends`. Use your actual plugin and backend installation directories; add an external index directory if needed. `--plugin-dir` loads the plugin but does not grant access to its helper scripts. Approve the lookup shell commands interactively, or configure narrowly scoped tool permissions for a noninteractive run; `--add-dir` grants directory access, not tool approval. A permission denial means the lookup did not run. [Real-backend smoke check](docs/copilot-acceptance.md#installed-lookup-backends).


## Use it

Describe the task to main as usual; it routes the work. Useful commands:

| Command | What it does |
| --- | --- |
| `/subagent` | Live worker inspector (also `Alt+I`) |
| `/subagent changes [#n or role]` | The files a worker changed, their git state, and the commands that would undo them (shown, never run) |
| `/subagent trace [#n or role]` | One worker's tool calls as plain text to paste for a cost review: target, output size, repeats, whole reads of large files, errors, and the outputs carried longest (no argument lists the workers) |
| Saved worker traces | Every worker's launch, tool calls (with arguments), results and guard refusals, kept 14 days in `run-state/worker-traces/` under your Pi agent directory, one JSON-lines file per worker, and named in the result as `traceLog`. Use it to establish what a worker ran after a reload. `PI_SUBAGENT_TRACE_LOG=0` turns it off ([details](agent/extensions/subagent/README.md#saved-worker-traces)) |
| `/subagent list`, `steer #N <message>`, `pause bg-N`, `resume bg-N`, `stop #N`, `result bg-N` | Control running or finished workers without a model call |
| `/subagent usage` | Usage per role, cost per completed task and main's context size |
| `/subagent fold` | Fold main's earlier turns into a checkpoint at your next message, whatever the size (main also folds by itself from 50k tokens when idle; see [Main checkpoints](#context-and-cost)) |
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

Roles that check work run on a different model family from the roles that write it, so they are less likely to share its blind spots: implementation workers run Claude first, `reviewer` and `test-engineer` run GPT first, and `oracle` uses both. On Pi, `oracle` runs two passes on every launch: GPT-6.1 Sol answers, then Claude Opus 5.5 reviews that answer independently and gives the final one ([how](agent/extensions/subagent/README.md#two-pass-oracle)). Each role's model, `economy`/`capable` tiers and tools live in `agent/roles.json`; its prompt uses the same five sections (Knows/loads, Before starting, Workflow, Where to look, Common failures). User roles in your Pi agent directory and project roles in `.pi/agents/` override bundled ones (package < user < project).

## Safety and delivery

A `tool_call` guard runs on main and every worker. It blocks risky shell operations (publish, destructive git, forced deletes, links, privilege changes, process kills, launching a Pi agent, changing installed Pi packages, curl-to-shell, unparseable commands) and any read, write or mention of secret files. Read-only roles (no `edit`/`write` tool, or a `readOnly` launch) also cannot change their candidate checkout through the shell: redirections, file-writing commands (including moves out of it, `Tee-Object`, `Export-Csv` and .NET file methods), in-place edits, file writes in inline interpreter code (`python -c`, `python - <<EOF`, `node -e`), and mutating git or package commands into it are refused, while their REPORT and evidence files go to the packet's `_evidence`/`_scratch` paths; the refusal names that folder for the current checkout. Code run from a script file is not inspected; the opt-in OS sandbox below covers it. Two rules follow Claude Code practice: a worker edits or overwrites an existing file only after reading it in that run, and a delete whose target is a variable, substitution, root, home, `.` or bare glob (`rm -rf $DIR/`) can never be approved. A block message names the rule, the program, whether an approval can ever help, and the next step; it never echoes command arguments. The guard is lexical and best-effort, not an OS sandbox.

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

## Token savings

Six experiments examine what the harness saves. Four compare the same work with and without Pi request shaping (recorded Pi runs, long main sessions, and an offline replay at Claude and at OpenAI prices); the fifth compares the whole Pi harness with one agent working alone; the sixth records Copilot's native request sizes with a scripted local provider. Scripts, fixtures, cache models and full results are in [`docs/simulations/`](docs/simulations/), and each one reruns with a single command.

### Recorded Pi runs

The real Pi CLI drives a scripted stand-in model that records every request Pi sends it ([method](docs/simulations/pi-shaping.md)). Cost is input-token equivalents at Anthropic prompt-cache prices (cache read 0.1x, cache write 1.25x of the input price); sizes are characters / 4.

| Scenario | Without shaping | With the harness | Saving |
| --- | --- | --- | --- |
| Long worker task: 30 tool calls over large files and logs | 2.81M tokens sent, peak request 164k, 15 of 31 requests over 100k | 1.43M sent, peak 79k, none over 100k | **49% fewer tokens**, peak halved. Cost: **73% lower (3.7x cheaper) on Claude Haiku 5.5**, which charges 5x for a request over 100k; 9% lower on models without that surcharge |
| Worker re-reading the same files | 353k sent | 232k sent | **34% fewer tokens, 36% lower cost** |
| Main session: 10 user turns of file reads and shell output | 1.37M sent, peak 84k | 862k sent, peak 61k | **37% fewer tokens, 21% lower cost** |
| Ordinary worker task: few large or repeated outputs | 643k sent | 619k sent | 4% fewer tokens, 4% lower cost: shaping stays out of the way when there is little to save |

**Cache-safe.** Shortening that rewrote the cached prefix every request would cost more than it saves, so every rule keeps the prefix stable: in all 232 recorded requests the system prompt and tool definitions stayed identical within each run, and older outputs are shortened in batches, so the cache is rewritten rarely. Masking has a price: on the long worker task the cache hit rate falls from 94% to 83%, which is why its saving at flat prices is 9% rather than 49%. That masking is also what keeps every request under Haiku's 100k surcharge.

### Long main sessions

The longer main runs, the more it saves, because its history otherwise grows with every request. A seeded synthetic session of user messages, subagent results with long reports and main's own reads, through the production context hook, under the same cache model at Opus 5.5 cache prices ([method](docs/simulations/pi-shaping.md#long-main-sessions)):

| Main requests | Input tokens | Cost | Main's request at the end |
| --- | --- | --- | --- |
| 150 | 54% fewer | 14% lower | 190k -> 38k tokens |
| 300 | 73% fewer | 42% lower | 381k -> 82k tokens |
| 480 | 82% fewer | 63% lower | 601k -> 84k tokens |

Shortening older results alone costs more than no shaping until about 480 requests (35% more at 150): each batch rewrites the cache from the first shortened result. Checkpoint folding is what turns it into a saving, because it rewrites the cache once and leaves a far smaller history to read on every later request.

### The harness against a single agent

The same ten-task session (four small fixes, three bug hunts, three features, two of them needing a second fix round), done by one model alone in plain Pi and by the harness ([method](docs/simulations/delegation.md)). In the harness, main runs on the single agent's model and delegates each step to a role in its own context, with the production shaping in every context. Main picks each implementation's tier when it plans, as the [routing rules](agent/skills/engineering-harness/references/routing.md) say: the three features go to the capable tier, the simple fixes and retries to the economy tier, and debugging, planning and test runs stay on their economy defaults. On Anthropic that is Claude Sonnet 5.5 and Claude Haiku 5.5; on OpenAI, the `roles.json` fallbacks GPT-6.1 Sol and GPT-6 Luna. List prices for each provider; the cache model is Anthropic's as above, or an idealized warm cache for OpenAI.

| Main / single-agent model | One agent, one session | One agent, a new session per task | Harness | Harness against one agent with a new session per task |
| --- | --- | --- | --- | --- |
| Claude Fable 5.1 | $20.73 | $11.20 | $4.69 | **58% cheaper** |
| Claude Opus 5.5 | $12.98 | $5.21 | $2.93 | **44% cheaper** |
| Claude Sonnet 5.5 | $11.18 | $3.34 | $2.37 | **29% cheaper** |
| Claude Haiku 5.5 | $2.64 | $0.17 | $1.52 | 9.1x the cost |
| GPT-6 Astra | $87.65 | $16.69 | $5.64 | **66% cheaper** |
| GPT-6.1 Sol | $9.93 | $2.61 | $1.89 | **27% cheaper** |
| GPT-6.1 Terra | $4.97 | $1.30 | $1.53 | 17% more expensive |
| GPT-6 Luna | $0.88 | $0.17 | $1.21 | 7.3x the cost |

Every model sends the same tokens: 47.3M (peak request 428k) for one agent in one session, 7.8M (peak 82k) with a new session per task, and 8.9M (peak 62k) for the harness, in 294 requests instead of 211. Against one agent kept in one long session, the more common habit, the harness is cheaper on every model except Luna (Haiku's long session pays its 5x price above 100k tokens).

Where the saving comes from: delegation itself is not cheaper. With every role on main's model, the harness costs 41-57% more than a single agent with a new session per task, because 22 contexts each send their own system prompt, main reads files to write each packet, and every worker writes a report. The saving comes from what delegation allows: most of the reading and editing runs on cheaper models in small contexts. So it pays when main runs on a strong model. On a model as cheap as the economy tier (Haiku, Terra, Luna), there is nothing cheaper to delegate to, and sending the three features up to Sonnet or Sol buys capability, not savings.

The break-even is how much a worker has to re-read to get its bearings, which the single agent already has in context; the table assumes one extra read per worker. Under Fable 5.1, Opus 5.5 and Astra the harness is still cheaper at twelve extra reads (46%, 17% and 60%); under Sonnet 5.5 and Sol it is cheaper up to eight (4% and 3%) and more expensive at twelve (13% and 15%). Under Haiku, Terra and Luna it is more expensive across the whole range. Three times the reads and checks on every economy-tier worker still leaves it cheaper: 56% under Fable, 39% under Opus, 22% under Sonnet, 65% under Astra, 19% under Sol. Not modelled: whether each approach finishes the task correctly (an economy-tier worker on a simple fix included), which is what cost per completed task depends on and what only a [live benchmark](agent/skills/engineering-harness/references/token-efficiency.md#benchmark-procedure-only-when-authorized-paid-runs-are-not-part-of-this-repository) can measure.

### Offline replay at Claude prices

An offline replay runs the current shaping functions over seven fixed workloads and prices them for four Claude models ([script, workloads, cache assumptions and results](docs/simulations/openai-shaping.md#claude-prices)). It does not run live models or the Pi CLI, and its fixtures differ from the recorded Pi runs above. Both arms run the same scripted actions, and token counts are totals over every request of a run. Costs cover input only, at Anthropic list prices with an idealized warm cache and 5-minute writes: not subscription billing or total task cost.

| Scenario | Without shaping | With the harness | Saving |
| --- | --- | --- | --- |
| Long worker task: 30 tool calls over large files and logs | 3.86M tokens sent, peak request 238k | Fable, Opus, Sonnet: 2.57M sent, peak 152k. Haiku: 1.57M sent, peak 93k | Fable, Opus, Sonnet: **33% fewer tokens, input cost 35% lower**. Haiku: **59% fewer tokens, input cost 83% lower** |
| Worker re-reading the same files | 1.90M tokens sent | 909k sent | **52% fewer tokens**. Input cost: 65% lower on Fable 5.1, 62% on Opus 5.5, 59% on Sonnet 5.5, 76% on Haiku 5.5 |
| Ordinary worker task: small, unique reads | 565k tokens sent | 565k sent | No change in tokens or input cost: the small-task guards avoid added overhead |
| Main session: 10 user turns of subagent results | 646k tokens sent | 646k sent | No change in tokens or input cost: the small-task guards avoid added overhead |
| Main session: 150 requests | 8.35M tokens sent | 5.25M sent | **37% fewer tokens**. Input cost: 11% lower on Opus 5.5, 23% lower on Sonnet 5.5 and Haiku 5.5, **7% higher on Fable 5.1** |
| Main session: 300 requests | 29.84M tokens sent | 15.17M sent | **49% fewer tokens**. Input cost: 14% lower on Fable 5.1, 29% on Opus 5.5, 39% on Sonnet 5.5, 84% on Haiku 5.5 |
| Main session: 480 requests | 72.94M tokens sent | 25.02M sent | **66% fewer tokens**. Input cost: 36% lower on Fable 5.1, 50% on Opus 5.5, 58% on Sonnet 5.5, 91% on Haiku 5.5 |

Prices per million input tokens: Fable 5.1 $10 (cache read $0.25), Opus 5.5 $4 ($0.20), Sonnet 5.5 $2 ($0.20), Haiku 5.5 $0.10 ($0.01, assumed), with cache writes at 1.25x input. Two things explain the spread. Haiku 5.5 charges 5x for a request over 100k tokens, so workers on it are masked from 90k and its long sessions gain most from staying small; the other three have no such surcharge, so their workers are masked only from 200k. And the cheaper a model's cache reads are against its writes, the less shortening pays, because each shortening rewrites part of the cache: Fable 5.1 reads at 2.5% of its input price, so a 150-request main session costs 7% more with shaping there, and the saving appears in longer sessions.

### Offline replay at OpenAI prices

An independent offline replay exercises the current shaping functions with seven fixed workloads and four OpenAI pricing profiles ([script, workloads, cache assumptions and results](docs/simulations/openai-shaping.md)). It does not run live models or the Pi CLI, and its fixtures differ from the recorded Pi runs above. Both arms run the same scripted actions, and token counts are totals over every request of a run. Costs cover input only, using Standard API rates with an idealized warm cache and 30-minute writes: not Codex subscription billing or total task cost.

| Scenario | Without shaping | With the harness | Saving |
| --- | --- | --- | --- |
| Long worker task: 30 tool calls over large files and logs | 3.86M tokens sent, peak request 238k | 1.48M sent, peak 84k | **62% fewer tokens**. Input cost: **25% lower on GPT-6.1 Sol / Terra**, 36% lower on GPT-6 Astra / Luna |
| Worker re-reading the same files | 1.90M tokens sent | 909k sent | **52% fewer tokens**. Input cost: **62% lower on GPT-6.1 Sol / Terra**, 59% lower on GPT-6 Astra / Luna |
| Ordinary worker task: small, unique reads | 565k tokens sent | 565k sent | No change in tokens or input cost: the small-task guards avoid added overhead |
| Main session: 10 user turns of subagent results | 646k tokens sent | 646k sent | No change in tokens or input cost: the small-task guards avoid added overhead |
| Main session: 150 requests | 8.35M tokens sent | 5.25M sent | **37% fewer tokens**. Input cost: **11% lower on GPT-6.1 Sol / Terra**, 23% lower on GPT-6 Astra / Luna |
| Main session: 300 requests | 29.84M tokens sent | 15.17M sent | **49% fewer tokens**. Input cost: **29% lower on GPT-6.1 Sol / Terra**, 39% lower on GPT-6 Astra / Luna |
| Main session: 480 requests | 72.94M tokens sent | 25.02M sent | **66% fewer tokens**. Input cost: **56% lower on GPT-6.1 Sol / Terra**, 63% lower on GPT-6 Astra / Luna |

Sol and Terra price cached reads at 5% of ordinary input; Astra and Luna use 10%. All four price 30-minute writes at 1.25x; requests above 272k input tokens use 2x input/cache rates ([official pricing](https://developers.openai.com/api/docs/pricing)). The 480-request baseline crosses that boundary; its shaped counterpart does not.

This replay found two small-task costs, now guarded: the ordinary worker cost 3% more and the short main run 13-23% more. Main now leaves its history unshortened below 25k estimated tokens, and a read-only worker defers the ledger's state view until it has read 80k characters (an edit, command or packet-required check shows it sooner); both fixtures now match their unshaped baseline. These are conservative heuristics, not a guarantee for every workload; the [before-and-after comparison](docs/simulations/openai-shaping.md#before-and-after) shows the longer-run trade-offs. The recorded Pi runs and long main sessions above give the same results with and without the guards.

### Copilot CLI request-size estimate

The real Copilot CLI 1.0.107, using a scripted localhost provider, ran the same read-only fixtures with and without the plugin ([method and runnable script](docs/simulations/copilot-input.md), [results](docs/simulations/copilot-input-results.json)). **No model inference:** `gpt-6.1-sol` was the configured model ID only; Sol, Astra, Terra and Luna were not benchmarked. These are estimated input tokens across all requests (messages and tool schemas, characters / 4), not billed usage.

| Workload | Plain session | Harness, one worker | Input-token change |
| --- | --- | --- | --- |
| Small: 4 file reads | 92k | 133k | **46% more** |
| Repeated: 12 reads | 383k | 351k | **8% fewer** |
| Large: 30 reads | 3.04M | 2.85M | **6% fewer** |

With three workers, the large fixture uses 1.29M tokens: **58% fewer than one continuous plain session**, but only **10% fewer than three fresh plain sessions** (1.43M). Against three fresh sessions, the small fixture costs 60% more input tokens and repeated reads are effectively unchanged (0.3% more). All 12 configurations reproduced identical estimates across two runs. Copilot's native child contexts and tool schemas differ from main; Pi's request shaping does not run here. Cache billing, output/reasoning tokens and task success were not measured, so these figures are not a projection of Copilot billing savings.

### What these numbers are not

Scripted runs and size estimates, not a billing benchmark of live models. A real model may choose different calls once it sees shortened output, and your tasks set the mix. `/subagent usage` shows your own cost per completed task and each role's cache hit share.

## Context and cost

For Copilot, the [native request-size estimate](#copilot-cli-request-size-estimate) shows modest input-token savings on the read-heavy fixtures and increased input on small tasks; no billing savings are established.

Request shaping below runs in Pi, including workers served through its OpenAI/Codex connector. It applies to Claude and OpenAI models; it does not establish equivalent behavior or savings in the standalone Codex app/CLI or Copilot CLI, which construct their own requests.

- **OpenAI models and routing.** GPT-6 Astra, GPT-6.1 Sol, GPT-6.1 Terra and GPT-6 Luna use the default 80k worker masking trigger and 95k budget. These are conservative context limits, not the API's 272k long-request pricing boundary. Non-complex implementation uses the economy tier (Luna); complex implementation uses the capable tier (Sol). In the [ten-task simulation](#the-harness-against-a-single-agent), this saves 66% with Astra main and 27% with Sol versus fresh single-agent task sessions, but costs 17% more with Terra and 7.3x as much with Luna. These are offline API estimates, not Codex subscription charges or measured task quality.
- **Provider cache versus local files.** OpenAI and Anthropic prompt caches are provider-side; they do not fill your PC's disk. Local shell-output logs have a separate retention policy described below. Cache reuse matters on both providers: shortening a small context can cost more when it rewrites a cached prefix.
- **Old results collapse.** Below 25k estimated history tokens, main leaves old results intact to preserve cache reuse. Above that floor, in main's requests, the newest ten subagent results stay word for word and older settled PASS results become one line each, in batches of ten, so the cached prefix rarely changes. Main's own old large file and command outputs are masked the same way. `PI_SUBAGENT_HANDOFF_WINDOW=0` turns both off.
- **Main checkpoints.** A long main session slows down and steers worse, because every request carries the whole history. At an idle task boundary (no job running, no decision waiting, a new user message) once main's request passes `PI_SUBAGENT_MAIN_FOLD_TOKENS` (default 50k; `0` off), earlier observations become capped checkpoint notes built from the messages themselves, without a model call: each subagent result as its STATUS/NEXT/EVIDENCE line, and main's last reply per turn. User messages stay separately in the request, in order and outside the notes' size cap. Earlier messages with up to 3,000 text characters stay whole; longer text keeps its first 2,000 and last 800 characters plus a saved-session note. Images and the newest user message are never cut. Pi's selected session branch supplies missing user messages after native compaction or reload; a fork uses only its own branch. Restored messages use the same limit. A requirement in the omitted middle of a long paste can be lost; the guard bounds individual pastes, not total user history. Assistant notes still shorten; keep unresolved decisions in the PLAN. The fold point stays fixed between folds, and the saved transcript is not changed. `/subagent fold` folds at your next message whatever the size, for example right after a merge.
- **Runtime state card.** When the running jobs or waiting worker decisions change, main's request gets one hidden line naming them (and a cleared line when they end), so a compacted conversation still knows what is in flight. Each line stays where it first appeared, so later requests extend the cached prefix instead of rewriting it.
- **Shared text first.** Every worker prompt starts with the same shared guidance, so roles with the same model and tools can reuse one cached prefix.
- **Handoff check.** A worker that finishes without its STATUS line is asked once for the four-line handoff before it closes, so main doesn't have to re-ask.
- **Usage report.** `/subagent usage` shows cost per completed task and each role's peak request, and its Main context line suggests `/new` once main's context reaches 100k tokens.
- **Keep main lean.** Main's own history is what dulls an orchestrator, so run main at `medium` thinking and start a `/new` session after each merged task; `/reload` loads new harness code but keeps the conversation. Strong reasoning models can make weaker orchestrators as their context fills, and orchestrators kept to short per-worker status lines steered far more accurately than ones holding every worker's full context.
- **Lookup tools first.** Workers look up code the packet does not locate in this order: the graph to orient (when the project has a Graphify graph), `qmd_search` for prior decisions (when QMD is), then Serena through the harness's own [`serena`](agent/skills/serena/SKILL.md) skill for definitions and callers, before broad `grep`/`find`. A small named file or symbol is read directly; a large source file goes through `outline` first; `grep` stays the tool for renames and literal text. The first broad `grep`/`find` of a worker run that has used none of them, and the first whole read of a large source file, each get one appended line pointing at them (nothing is blocked). The live view counts `serena`, `qmd` and `graphify` calls, including graph queries through the skill's `read_graph.py` helper, and shows `not loaded` for one the launch does not have. The Graphify skill loads only when the worker's checkout (or its primary checkout) has a `graphify-out` graph; build one with `/refresh graph --init`.
- **Bounded packets.** Main names known locations (files, symbols, failing tests) and a stop condition; workers start there, stop there, and send long test, build or install output to a log in their `_scratch` folder.
- **Tool discipline.** Workers use shared Codex and Claude Code practices: independent calls in one turn, partial reads with offset and limit, the read/grep/find tools instead of shell `cat`/`grep`, no `sleep` polling, no interactive commands, and no files the task does not need.
- **Threshold-triggered masking in workers.** Claude Haiku 5.5 charges 5x for a request over 100k input tokens. Once a worker's request reaches a threshold set by the model serving it (90k on Claude Haiku 5.5; 200k on Anthropic Sonnet, Opus, Fable and Mythos, which have no long-request surcharge, so masking there would only rewrite the cache; 80k on OpenAI Astra, Sol, Terra and Luna, and other or unknown models), measured with the system prompt and calibrated against the provider-reported size of the worker's previous request (characters / 4 undercounts code), it is shortened step by step until it fits the budget (95k, or the threshold if higher): main's stable batching, then every older large output, then every older output of 500 characters or more, then bounded large outputs except the latest, then (last resort) only the latest output kept and bounded to its first and last 8,000 characters; if it is still over, the host is asked to compact once. Best effort, not a hard bound: the estimate is approximate and compaction is asynchronous. `PI_SUBAGENT_WORKER_MASK_TOKENS` (`0` off) and `PI_SUBAGENT_WORKER_TOKEN_BUDGET` tune it, and `/subagent usage` shows each role's peak request and requests over 100k so you can check it.
- **No duplicate reads.** When a worker reads the same file and range again and gets exactly the same text, the result is a one-line note pointing at its earlier copy. Changed files, other ranges, images and errors pass through.
- **Execution ledger.** Small read-only runs defer inventory text until 80k read characters have accumulated; an edit, command or packet-required check makes it eligible sooner. Every few calls, when it has changed, a worker's tool result ends with a short state view (kept in the history, so the cached prefix stays stable): files changed, reads still current or stale, the checks the packet names that have not run yet, and the latest result of each check. An identical repeated inspection becomes a one-line note. `PI_SUBAGENT_LEDGER=0` turns it off.
- **Long shell output capped and retained temporarily.** A worker's shell output over 16,000 characters keeps its first 2,000 and last 8,000. Harness-owned full logs go to `<system temp>/pi-worker-output/<worker PID>/`. On new log writes, at most hourly per worker, recognised logs older than seven days are removed only when their owner process has exited; live/unknown owners and recent logs are retained. This is cleanup on activity, not a hard disk quota. Pi-owned output files and legacy logs directly in `pi-worker-output` are left alone; see [retention and legacy cleanup](agent/extensions/subagent/README.md#temporary-shell-output-logs). `PI_SUBAGENT_OUTPUT_CAP` sets the context limit (`0` off).
- **Keep project `AGENTS.md` short.** Studies of context files found that repository overviews raise cost without improving results, while instructions are followed. Put rules and guardrails in a project's `AGENTS.md`, and move detail (architecture, routes, build notes) into project skills under `.agents/skills/` that agents read only when a task needs them.
- **Measure by cost per completed task.** `/subagent usage` shows it per role. Cache reads and writes dominate the bill, so fewer tokens alone is not a saving. The [controlled benchmark procedure](agent/skills/engineering-harness/references/token-efficiency.md#benchmark-procedure-only-when-authorized-paid-runs-are-not-part-of-this-repository) compares a strong single agent, delegation and request shaping separately; Pi and Copilot need separate results. No live efficiency benchmark is included here.

## Optional components

Install the external backends separately; the harness provides their integration helpers. **Serena and Graphify are Python packages installed with `uv`; QMD is a Node.js package installed with `npm`.** Choose the package manager shown for each component.

| Component | Purpose | Install / load | Setup after installation |
| --- | --- | --- | --- |
| [Serena](agent/skills/serena/SKILL.md) | Symbol definitions, outlines and references | **uv:** `uv tool install serena-agent` | The bundled skill starts its local server on the first lookup. For a custom installation, set `HARNESS_SERENA_PYTHON` to its Python executable. Unavailable backends return an explicitly labelled heuristic fallback. |
| [Graphify](agent/skills/graphify/SKILL.md) | Code relationships and project orientation | **uv:** `uv tool install graphifyy` | For Pi workers, copy the bundled `agent/skills/graphify/` folder into your Pi profile's `skills/graphify/`. Load the refresh extension below, then run `/refresh graph --init` in the primary checkout. Run `/refresh graph` to update it without dated backups. Workers can use the primary checkout's graph from worktrees; without a graph they skip this lookup. |
| [QMD](agent/extensions/qmd/README.md) | Search prior notes, specs and decisions | **npm:** `npm install -g @tobilu/qmd` | Index your notes, for example `qmd collection add /path/to/notes --name notes`. Pi workers use native QMD tools; Copilot uses the bundled [shell skill](agent/skills/qmd/SKILL.md). Both discover a global install, profile config or `HARNESS_QMD_CLI` override. BM25 search needs no embeddings. |
| [Ponytail](https://github.com/DietrichGebert/ponytail/blob/main/INSTALL.md) | Coding guidance for Pi and Copilot CLI | **Pi:** `pi install npm:@dietrichgebert/ponytail`<br>**Copilot CLI:** `copilot plugin marketplace add DietrichGebert/ponytail`, then `copilot plugin install ponytail@ponytail` | Required for Pi code roles except `reviewer`. On Copilot, install its native plugin separately; see the [Copilot setup guide](https://github.com/DietrichGebert/ponytail/blob/main/INSTALL.md#github-copilot-cli). |

The items below are separate from the lookup tools above. **You do not need to install all of them.** Some are files already included in this repository; others are maintenance tools or fixes for specific older dependencies.

| Item | When you need it | What to do |
| --- | --- | --- |
| Bundled guidance: [backend](agent/skills/backend/SKILL.md), [frontend](agent/skills/frontend/SKILL.md), [browser](agent/skills/browser/SKILL.md), [Graphify](agent/skills/graphify/SKILL.md) | You want to inspect or customize the instructions agents use. | **Already included; no npm or uv install.** Assigned roles read their module files from the installed harness. Copilot exposes the bundled skills through its plugin. For Pi Graphify workers, follow the profile-folder setup in the Graphify row above. |
| [Defuddle CLI](https://github.com/kepano/defuddle#cli) | You want to extract readable text from a public web page. Works from either host's shell. | Install with `npm install -g defuddle`, then run `defuddle parse https://example.com --md`. This installs the CLI, not an agent skill. Automatic harness use additionally requires an installed Defuddle skill advertised by your host; otherwise the agent uses its normal fetch/search tools. See [harness guidance](agent/skills/engineering-harness/references/runtime.md#public-web-content-optional-defuddle). |
| [Refresh extension](agent/extensions/refresh/README.md) — **Pi only** | You want Pi commands to build/update a Graphify graph, update QMD collections, or restart Serena. | Load `agent/extensions/refresh/index.ts` using the settings example below, then run `/reload`. Use `/refresh graph --init` for the first graph, `/refresh graph` for updates, `/refresh qmd` for indexed notes, or `/refresh serena` to restart Serena. Install each backend before using its command. These slash commands are not available in Copilot. |
| [Git identity extension](agent/extensions/engineering-environment/README.md) — **Pi only** | You want Pi and its workers to use a specific commit author/committer. Skip it if your existing Git identity is correct. | Copy `agent/extensions/engineering-environment/config.example.json` to `config.json` in the same folder. Replace **all four example values** with your own name/email. Load its `index.ts` as shown below, then `/reload`. It sets process environment variables; it does not change global Git config. |
| [Claude connector patch](agent/patches/claude-subscription-connector/README.md) — **Pi only** | You use `pi-claude-subscription-connector` and encounter the tool-list issue described in the patch guide. | This is a manual file replacement, not another extension to enable. Follow the backup/replacement steps in the guide. It was validated against connector **1.0.1**; compare newer versions before applying. Skip it if you do not have that issue. |
| [Betterwright patch](agent/patches/betterwright-windows/README.md) — **Windows only** | You use Betterwright and its background processes open unwanted console windows. | Follow the source/launcher changes in the guide only if your installation matches the affected code. Tested with Betterwright **2.8.7**. Skip it on other platforms or when the issue is already fixed. |

For the two optional Pi extensions, add only the entries you need to the existing `extensions` array in `~/.pi/agent/settings.json` (or your custom `PI_CODING_AGENT_DIR/settings.json`). Replace `/path/to/agent-harness` with your checkout's absolute path; on Windows, use a path such as `C:/src/agent-harness`. Keep your other settings and extension entries.

```json
{
  "extensions": [
    "/path/to/agent-harness/agent/extensions/refresh/index.ts",
    "/path/to/agent-harness/agent/extensions/engineering-environment/index.ts"
  ]
}
```

Prepare the Git identity extension's `config.json` before loading it. If you only want `/refresh`, add only the first entry.

Copilot also needs directory access and shell approval for external helpers; see [GitHub Copilot CLI](#github-copilot-cli).

## Copilot CLI limits

The plugin shares agents, skills and startup context with Pi. Copilot CLI 1.0.107 passed a native offline smoke check for plugin loading, startup/child hooks, named scout dispatch and dummy-secret denial; hosted inference was blocked by authentication. This is not a model-quality test. It remains a preview with these limits (full matrix and receipts: [docs/copilot-acceptance.md](docs/copilot-acceptance.md)):

| Asset | Status |
| --- | --- |
| Source release | v1.18.4 ([alsevilla/agent-harness](https://github.com/alsevilla/agent-harness)) |
| Copilot CLI | Latest release only; no older version is supported |
| Agents and skills | Shared from `agent/`; Pi tiers and job controls are not emulated. Serena, Graphify and QMD work through their skills' shell commands |
| Token and turn savings | Pi's request shaping (execution ledger, output cap, worker masking, duplicate-read notes, main checkpoints, cache health) is Pi-only: Copilot builds its own requests. Both Copilot hooks add the working rules that cut turns: the lookup order with the three helpers by path, calls batched in one turn, no retry of a repeated failure or guard refusal, and small diffs |
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
| [docs/knowledge](docs/knowledge/README.md) | Decision and knowledge records |
| [docs/simulations](docs/simulations/pi-shaping.md) | Token-saving simulations: method, fixtures and results |

## Contributing

Work on a feature branch and open a pull request against `master`. Tests are Node-only:

```text
npm test
```

Suites that need an installed Pi host are skipped, by name, when none is found; set `NATIVE_PROBE_HOST_MODULES` or install Pi to run them.

After a change to request shaping, rerun the [token-saving simulations](docs/simulations/pi-shaping.md) and update the README's [Token savings](#token-savings) tables: `npm run simulate:pi` (needs Pi, like the host suites), `npm run simulate:main`, `npm run simulate:delegation`, `npm run simulate:delegation:openai`, `npm run simulate:claude` and `npm run simulate:openai`, each written to its results file in `docs/simulations/`.

## Licenses

Original work: [MIT](LICENSE). Pi (earendil-works/pi, MIT) and bundled third-party files keep their own notices: [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md), [PI-LICENSE](agent/PI-LICENSE).
