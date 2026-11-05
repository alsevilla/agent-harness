# Claude settings mapped to Pi

| Claude setting | Pi equivalent in this profile |
|---|---|
| Serena hooks (remind, auto-approve, activate, cleanup) | Not mapped. Workers reach Serena through the harness's `serena` skill (`agent/skills/serena`): its server starts on the first query and exits after 30 idle minutes, so no session hook is needed. pi-serena is no longer part of this profile; `SERENA_EAGER_STARTUP` in an older config.json is accepted and ignored. |
| Four GIT_AUTHOR/GIT_COMMITTER variables | Local index.ts sets them before tools run. Child processes inherit them. No global Git config changes. |
| CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH=1 | This Claude-specific variable is not copied. The custom subprocess subagent runner disables extension discovery in children and only loads the Claude subscription guard for Anthropic children; it does not load its own subagent extension. Other agent extensions have their own nesting rules. |
| attribution.commit | Global AGENTS.md instructs authorized commits to include the two requested coauthor trailers once. This is guidance, not automatic commit-message enforcement. |
| attribution.pr | Global AGENTS.md adds the requested coauthor links and identifies Pi as the generating client. This is guidance, not a PR publication hook. |

Use ordinary pi with normal extension discovery. After changing these files, restart Pi or use /reload.

Code subprocess leaves load the serena and Graphify skills through subagent/code-integrations.ts and receive role-specific tool allowlists; the environment variables alone do not add tools. Serena's health depends on its installed Python and language servers (`node agent/skills/serena/scripts/serena.mjs status` reports them).

No credentials or Claude subscription tokens are in these files. Existing model settings, installed packages, MCP choices and Claude settings are preserved.


## Folder layout

This extension is self-contained in extensions/engineering-environment/: index.ts is the Pi entrypoint, config.json contains environment values, and README.md documents the mapping. Attribution rules remain in the global AGENTS.md so Pi and its isolated children discover them. Edit config.json, then restart Pi or run /reload.
