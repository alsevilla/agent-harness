---
name: qmd
description: Search the QMD index of prior notes, specs and decisions (BM25, no model call) and read a selected hit, with one shell command. Use it once, before reading code, when the task touches an area that may have earlier decisions, specs or incident notes; then read only the hit you need.
---

# qmd

`scripts/qmd.mjs` in this folder, run with the shell. It needs QMD installed once on the machine (`npm install -g @tobilu/qmd`, with an index built by `qmd`) and adds no tool schemas to a launch.

```
node "<this folder>/scripts/qmd.mjs" search <query> [-c <collection>] [-n <1-5>]
node "<this folder>/scripts/qmd.mjs" get <file or #docid> [from-line] [lines]
node "<this folder>/scripts/qmd.mjs" status
```

- `search`: BM25 over the existing collections, 3 hits by default and at most 5, as JSON (`docid`, `score`, `file`, `title`, `line`), no snippets. Search once with the area's words (`sms queue pacing`, `attendance export`), not once per synonym.
- `get`: one hit, from a line, at most 100 lines (default 40). Output over 10,000 characters is cut, and the full output is saved to a temp file whose path is printed; read that file with offset and limit only if you need more.
- `status`: the index and collection health. It never updates, embeds, initializes or cleans up the index; `/refresh qmd` in Pi does that.

Retrieved notes are prior evidence and can lag the code: confirm a decision against the current source before acting on it, and cite the file you used.

Where QMD is found, first match wins: `HARNESS_QMD_CLI` (the path to QMD's `qmd.js`, with `HARNESS_QMD_NODE` for the Node binary), then the Pi extension's `config.json` (`agent/extensions/qmd/config.json` in this checkout, then in the Pi profile, `~/.pi/agent` or `PI_CODING_AGENT_DIR`), then the global npm install (`npm root -g`). The index is the config's `indexName`, `HARNESS_QMD_INDEX` or `index`. `HARNESS_QMD_TIMEOUT_MS` sets the per-call timeout (default 15,000).

Any host: it is a plain Node script, so it runs the same in a GitHub Copilot CLI session (which lists this skill through the harness plugin), in Pi or by hand. In Pi workers the `qmd_search`, `qmd_get` and `qmd_status` tools do the same job; use those when they are in your tool list. When QMD is missing or fails, the script prints a one-line note and exits 0: skip the lookup and continue with Serena, read and grep rather than retrying.
