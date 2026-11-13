# Merge and release (release-engineer, named grant only)

Read this only when the task names an existing explicit merge or release delivery action grant. PR merge and release creation have no automatic path; without such a grant, stop and return BLOCKED to main.

- `merge`: exact PR, approved at a head SHA and bound to the candidate fingerprint the runtime showed at approval. One approval covers the merge, the LEARN checkpoint and the post-merge cleanup that follow, and later commits pushed on top of the approved SHA. Before merging, read the live PR head (`gh pr view <n> --repo <o/r> --json headRefOid`); `--match-head-commit` names that head, which must equal the clean candidate HEAD, and no check may have failed or still be running.
- `release`: exact PR and version; the tag must not exist. When the release was approved with the merge, the target is the PR's merge commit (read it after the merge with `gh pr view <n> --repo <o/r> --json mergeCommit`); otherwise it is the approved target SHA. Only the approved release version is tagged.
- A release needs the version named in an approval; a merge approval without one never authorizes it, and nothing is inferred from commit, push, PR or merge. Single-use operation grants are not accepted for them. Task authority and guard refusal protections still apply.
- A named grant has no time expiry: it lasts until `/revoke-authorization` or session end; pause and abort do not clear it.

Run only these shapes, one command per call, standalone from the candidate cwd (no `cd`, `&&`, pipes or other compounds). Use the approved repo, PR number and version; flags may come in any order, each once.

```
gh pr merge 12 --repo acme/widgets --squash --match-head-commit 0123456789abcdef0123456789abcdef01234567 --subject "Add delivery grant" --body-file "D:/work/worktrees/app/_evidence/task/pr.md"
gh release create v1.2.3 --repo acme/widgets --target 0123456789abcdef0123456789abcdef01234567 --title "v1.2.3" --notes-file "D:/work/worktrees/app/_evidence/task/notes.md" --latest
```

Subjects, titles and inline text: double-quoted ASCII letters, digits, space and `. , : _ / # ( ) + -` (a colon is allowed: `fix(db): Schedule backups`). A refusal that says "not an accepted command form" names the argument to correct; fix the command and run it again, the approval still applies. `--body-file` and `--notes-file` take double-quoted absolute forward-slash paths to `.md` or `.txt` regular files directly inside the approved artifact directory. Never use another tag, force push, branch deletion, another ref, npm, deploy or API calls. If the guard actually refuses a command, stop and return BLOCKED to main; do not retry around the guard.
