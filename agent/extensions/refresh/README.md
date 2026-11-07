# Manual refresh

Reload Pi, then use:

- `/refresh graph --init`: build the first code graph (`graphify-out/`) in the current Git checkout root (current directory outside Git). Run it in the primary checkout: it is refused in a linked worktree, whose graph would describe one branch and go with the worktree, and workers in every worktree already use the primary checkout's graph. It is refused where a graph already exists, and it reports when `graphify-out` is not in `.gitignore`.
- `/refresh graph`: update the current Git checkout root's existing `graphify-out/graph.json`.
- `/refresh graph [--init] "C:/absolute/project root"`: the same for an explicitly named checkout.
- `/refresh qmd`: update every collection in the QMD extension's named global index.
- `/refresh serena`: stop the serena skill's Serena server (`agent/skills/serena`); the next worker query starts a fresh one with new language servers.

These commands never ask the orchestrator model. Both graph commands run `graphify update`, which extracts code only, with no LLM; semantic document/image extraction is separate. A worktree without a graph must explicitly select the intended primary checkout; its graph still describes that checkout. Graphs are built only when you run `--init`: workers never build or update one, and no installs, global-graph rebuilds, QMD embedding, pull commands, or periodic maintenance run automatically.

Graph output is explicitly confined to the selected checkout's `graphify-out` rather than inherited `GRAPHIFY_OUT` overrides; output links outside that checkout are refused. This is a code graph refresh, not an LLM semantic extraction.

QMD uses `../qmd/config.json`, including `indexName`, and checks its effective global YAML. Configured collection update hooks are rejected because they can run arbitrary commands. Index writes refresh text/BM25 and may invalidate old embeddings; no replacement embeddings are generated.

Install Graphify with `uv tool install graphifyy`. The default interpreter is that install's: `%APPDATA%/uv/tools/graphifyy/Scripts/python.exe` on Windows, `~/.local/share/uv/tools/graphifyy/bin/python` on Linux and macOS. For another location, copy `config.example.json` to `config.json` and set `graphPythonPath`; the path is run as given, so a virtualenv's symlinked `python` keeps its environment. Both process launches use hidden Windows windows, no shell, a timeout (default 120 seconds, maximum 10 minutes), and bounded output. Only one process refresh runs at a time. Timeout can leave partial outputs; inspect them before repeating. Reload/extension shutdown does not cancel an already running refresh; let it finish first.

Checks: `node --test tests/core.test.ts`. Tests mock processes and do not refresh project graphs or indexes.
