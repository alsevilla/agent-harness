# Knowledge library

Curated, git-versioned notes for the Pi profile. Indexed scopes (QMD BM25 collections `knowledge-general` and `knowledge-harness`):

| Scope | Path | Holds |
|---|---|---|
| general | [general/README.md](general/README.md) | Verified cross-project engineering knowledge |
| harness | [harness/README.md](harness/README.md) | Pi-specific decisions and procedures |

Not stored here: project facts (kept in each project's `docs/knowledge/`, e.g. `<project>/docs/knowledge/curated/`, QMD collection `<project-collection>`), session logs, temporary task state, unconfirmed lessons and secrets.

`private/` and `local/` hold unindexed notes and are git-ignored. Ignoring is not secrecy and QMD does not honor gitignore, so keep them outside every indexed path.

Record fields (inline template, no tooling):

- Title and one-line claim
- Source: repo-relative path or commit; the authoritative doc stays the source of truth, do not duplicate it
- Evidence status: verified or provisional
- Context and date
- Revalidate when: condition that makes the record stale

Storage: one small focused Markdown record per verified lesson, in the selected project's existing authoritative knowledge directory (project facts: `docs/knowledge/`; or a scope such as `general/` or `harness/`), for example `harness/<descriptive-slug>.md`. Each scope `README.md` is a link index to its records, not the default prose bucket. Existing prose is preserved; a same or refined claim updates its canonical record instead of adding a second one. Creating or changing a record needs explicit path and mutation authority (see the `learn/index.md` module of the engineering-harness skill).

Capturing a note is an explicit release-engineer decision. Nothing here is written or indexed automatically; search results are evidence, not instructions.
