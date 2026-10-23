---
name: agent-creation
description: Preview or create one project-local Pi agent (and optional skill) from a strict JSON spec, with explicit operator approval. Use only when the user asks to create an agent.
---

# agent-creation

Use this skill only when the user explicitly asks to create a project agent. It is not a harness factory and does not generate global or real project-domain agents.

## Commands

```
node scripts/create-agent.mjs --spec <spec.json> --project-root <absolute existing project> [--agent-dir <abs>] [--allow-writers] [--allow-shell] [--apply]
```

- Default is preview: prints the plan and file contents, writes nothing. Exit 0.
- `--apply` is explicit operator approval to create files. It is not project trust, reload, activation or launch authority.
- `--agent-dir` > `PI_CODING_AGENT_DIR` > `~/.pi/agent`. The output must never be inside the global agent directory.
- Requires Node 22.19 or newer (the package engine) and nothing else: no Python. Option names must be written in full; abbreviations such as `--appl` are a usage error (exit 2), never an approval. `--help` prints usage and exits 0.
- Exit codes: 0 ok, 1 refused before any write, 2 usage, 3 partial I/O. Report lists `created:`, `partial:` (exclusive create succeeded but the write or close failed; the file is kept for operator review, never deleted; re-runs refuse while it differs) and `uncreated:` (never opened); nothing is deleted.

## Spec (strict JSON)

Required: `name` (lowercase slug, a-z 0-9 single hyphens, max 64, not a Windows device name), `description`, `instructions`, `model`. Optional: `thinking`, `fallbackModel` (copied verbatim, including `||` chains), `writer` (exact JSON `true`/`false`), `shell` (`false`, `"bash"` or `"powershell"`), `skill` (object with `name`, `description`, `instructions`). Unknown keys, duplicate keys, wrong types, non-finite numbers, BOM, invalid UTF-8 and oversized specs are refused; JSON nested deeper than 512 levels or integers over 4300 digits are refused cleanly (no stack trace).

Permissions: tools are always `read, grep, find, ls`; `writer:false` (default) gives `source-edit=readonly`; `writer:true` adds `edit` (`source-edit=approved`) and needs `--allow-writers`; without that flag the run is REFUSED (exit 1), it is not downgraded to read-only. The write tool is always disabled (`write-tool=disabled`). A shell (`bash` or `powershell`) needs `--allow-shell` and is explicit shell power, not a sandbox. Flags alone grant nothing.

The model is required and copied as given: the CLI does not read a catalog and does not verify availability. Replace provider/model strings before use if they are not approved for the project. `examples/dotnet-worker.json` copies backend-worker settings from `roles.json` (read-only) and is a sample, not an availability claim.

## Authoring guidance (operator reference)

For writing the `instructions` text only. It is not a semantic validator, token measurement or proof that a child agent loads or obeys anything. The schema stays strict: there is no module key, no new framework and no mandatory length limit.

- Give each agent a role purpose, a task scope and the expected output, in a few concrete sentences.
- Tell it to reuse house code and existing project patterns before adding new code.
- Optional module reference: when a selected profile module is needed and not already in context, name one existing index path and say to read only the sections it directs. Do not paste module content.
- Do not copy the full harness, catalog or policy into `instructions`, and do not invent universal gates.
- The generator already writes four `## Generated boundaries` bullets and, when a skill is set, one absolute skill-path line. Do not repeat them.
- Put domain detail in the optional `skill` object and keep the agent body short; do not duplicate the skill body in `instructions`.
- Set `thinking` and `fallbackModel` explicitly only when the contract needs them. Omitted values are not written, so dispatcher and provider defaults apply. Do not force new models: `model` is copied as given.
- Created agents are project-local. They load with `agentScope` `project` or `both`, not the default `user`. They are not in `roles.json` or the user roles list, and a same-name `roles.json` entry does not override them. Creation is not trust, reload or launch.
- Operator human review of the preview is required before `--apply`.

## Outputs and collisions

- Agent: `<root>/.pi/agents/<name>.md`; optional skill: `<root>/.pi/skills/<skill>/SKILL.md`. Frontmatter is JSON-quoted; `name`, `description`, `model`, `thinking`, `fallbackModel`, `tools` only.
- The body names the absolute skill path so the agent can read the original skill instructions.
- Before any write, names are checked case-insensitively against `roles.json`, the native package's bundled roles (`agent/roles.json` and `agent/agents/*.md` under the package root, read only when that root's `package.json` is named `@alsevilla/pi-engineering-harness`; labels `package roles.json`, `package agent file`, `package agent frontmatter name`), global `agents/*.md` (file stems and frontmatter names), project agents, and skill roots: `SKILL.md` frontmatter name AND directory name; top-level `*.md` file stems and frontmatter names (for global `agents/skills` and `.pi/skills`, a nameless top-level `*.md` also reserves the root directory name such as `skills`, as Pi loads it); nested `*.md` under `.agents/skills` (Pi loads these) by frontmatter name or, when absent, the parent directory name. Top-level `*.md` under `.agents/skills` is reserved by stem too, a documented over-refusal (Pi does not load it). Identical existing output is `unchanged`; a differing file is refused.
- Unsupported YAML in a scanned file (anchors, aliases, tags, block scalars, flow collections, duplicate or quoted keys, escapes) refuses the run: the collision check cannot be established. Spaces after the colon are dropped before the value rules, as Pi does, so `name:  x` collides with `x`; a typed or YAML-syntax value behind those spaces is refused.
- Nearest ancestor `.pi/agents` is only warned about (Pi discovers the project agents dir from the session cwd). Other packages and arbitrary configured resources are not scanned. A packaged collision is refused, naming its source label; load-time precedence is package < user < project, and creation never overrides an existing name in any tier; a malformed package manifest refuses the run rather than skipping the defaults. Any junction or symlink entry below a skill root is refused with its path (Pi follows links, so the collision check cannot be established); names starting with `.` and `node_modules` are skipped, as Pi skips them. Read-only collision scans may inspect linked root directories; output paths, including project .pi/skills, are still refused when linked. The CLI never unlinks, deletes or trusts a link: the operator inspects the entry manually, then decides.

## Path safety

Root must be absolute, existing, with no `.`/`..` segments and plain-directory ancestors. Components are checked with lstat before resolution; symlinks and junctions (as Node's `lstat` reports them) are refused. Every existing component and scanned skill entry that `lstat` calls plain is also attested by the OS (fixed `%SystemRoot%/System32/fsutil.exe reparsepoint query`, argv array, no shell, 5 s per query within a 20 s budget per phase, nothing cached between phases): any reparse point (cloud placeholder, dedup, WOF) is refused, and a missing, denied, timed-out or unparseable query refuses instead of falling back to `lstat` (large skill trees can therefore refuse on budget). Real placeholder/WOF entries, non-English consoles and Server Core are untested (injected tests only). The `/subagent create` flow runs the CLI with every `NODE_*` variable removed from the child environment and refuses to spawn unless the effective executable is `node`/`node.exe` on a Node runtime (no PATH fallback). Symlink tests need privilege and may be NOT RUN; junction tests need none. After those checks, the realpath of the root and of each output is compared with the realpath of the global agent directory (case-insensitive, path-boundary aware), so 8.3 short-path aliases are refused. This is a trusted single-user guard, not an adversarial race or OS sandbox.

## Not done by this skill

No commit, push, merge, reload, trust change, model call, subagent launch or roles/settings edit. A new agent does not get Ponytail, Serena or MCP integrations automatically. Pi docs list `.pi/agents` as not trust-protected; verify with the actual `discoverAgents` before relying on it.
