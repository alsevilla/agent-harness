---
name: serena
description: Symbol lookup through Serena (the language server) without pi-serena - outline a source file with line ranges, find where a symbol is defined (with its body) and list the code that references it, with one shell command. Use it before reading a large source file whole and before grep or find when the packet does not locate the code.
---

# serena

`scripts/serena.mjs` in this folder, run with the shell from the candidate root. It needs Serena installed once on the machine (`uv tool install serena-agent`) and adds no tool schemas to a launch.

```
node "<this folder>/scripts/serena.mjs" outline <file>...
node "<this folder>/scripts/serena.mjs" find <Name or Owner/name> [path] [--body] [--kind <kind>]
node "<this folder>/scripts/serena.mjs" refs <name or Owner/name> [path]
node "<this folder>/scripts/serena.mjs" status
```

- `outline`: the file's symbols with kinds and 1-based line ranges; then read only the range you need with `read` offset/limit.
- `find`: where a name is defined (`file:start-end kind name/path`). `Owner/name` narrows to a method or nested item, for example `ScanResult/response` (Rust methods appear as `impl ScanResult/response`). `--body` prints the numbered body of the first five matches. `--kind function` keeps one kind.
- `refs`: the code that references a symbol, each line with its enclosing symbol (`[recompute_open_day_in_tx]`). When the name is defined more than once, it lists the definitions; pass the file or `Owner/name`.
- `status`: whether Serena is installed, its server is running and this checkout is set up.

How it works: the first query starts a small read-only server (`scripts/serena_server.py`, Serena's own project server run with the installed Serena's Python), which serves every project on the machine and exits after 30 idle minutes. The first query of a project waits while its language servers start (up to a minute or two for a large Rust project); later queries take well under a second. Only Serena's read-only tools can run through it. Your global Serena configuration is not changed.

Project setup: Serena serves a checkout that has `.serena/project.yml`. On first use in a primary checkout whose `.gitignore` already ignores `.serena/`, the skill creates that file (`serena project create`, languages from the tracked files). It never creates one in a linked worktree or in a checkout that does not ignore it, so the candidate never gains an untracked file.

Fallback: when Serena is not installed, cannot serve the checkout (a worktree without `.serena`, for example) or does not answer, a built-in heuristic parser (`scripts/symbols.mjs`: Rust, TypeScript/JavaScript, Python) answers instead, and the output starts with `[heuristic parser, not Serena: <reason>]`. Treat that answer as a hint and confirm with read or grep.

When not to use it: small files and exact ranges the packet names (read them), literal text, strings, comments, config, docs and renames (grep finds every textual occurrence).

Settings (environment): `HARNESS_SERENA_PYTHON` (the Serena Python, when not found under `uv tool dir`), `HARNESS_SERENA_PORT` (default 24227), `HARNESS_SERENA_TIMEOUT_SECONDS` (per query, default 300), `HARNESS_SERENA_IDLE_SECONDS` (server idle exit, default 1800), `SERENA_HOME` (default `~/.serena`).
