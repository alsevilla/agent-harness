# Authorized Git operations

## Git identity and attribution
The engineering-environment extension sets the configured Git author and committer
identity for this Pi process and its children. Do not change repository or global
Git configuration merely to set that identity.

When the user authorizes creating a commit, include each of these trailers once at
the end of its commit message as one contiguous final block, separated from the
message body by a blank line. Do not put a blank line between the trailers:

```text
Co-Authored-By: Codex <noreply@openai.com>
Co-Authored-By: Claude <noreply@anthropic.com>
```

Use a commit-message file or one `-m` argument for the entire trailer block;
separate `-m` arguments insert a blank line and GitHub recognizes only the last
block. Before pushing, confirm both trailers appear exactly once with:

```sh
git show -s --format=%B HEAD | git interpret-trailers --parse
```

When the user authorizes creating or updating a pull request, include this footer
once in its description:

🤖 Generated with [Pi](https://pi.dev), co-authored with [Codex](https://openai.com/codex) and [Claude](https://claude.ai)

## Writing commits and pull requests
Write for a reviewer who has not seen the task. Use plain words and short
sentences, name files and commands in backticks, and say what changed and why
before how. Leave out job IDs, full hashes, attempt history and raw logs; the
REPORT or evidence file keeps those.

Commit message: an imperative subject of at most 72 characters that names the
change, not the activity ("Trim task-packet checklists from workers", not
"Update agents"). In the body, give the reason first, then the change. Say
plainly what deliberately stays the same when a reviewer would worry about it
("The retry cap is unchanged."). The attribution block above stays last.

Pull request description: follow the body layout in `../ship/index.md` ("Pull requests": Why, What changes, Unchanged, by design, Tests, Limits), with the attribution footer above last.

These attribution instructions do not authorize commits, pushing, publishing,
messages, or pull requests by themselves. Explicit user instructions govern any
requested exception. Pi has no built-in Claude-style attribution setting; these
are instructions, not a Git hook that rewrites every commit automatically.
