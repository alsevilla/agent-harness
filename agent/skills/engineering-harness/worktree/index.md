## WORKTREE procedure
Use only when isolation is already justified. Main owns placement and disposition.

Before mutation, confirm primary repository, accepted base, candidate, ownership
and active workers. Preserve user work and reuse a suitable existing checkout.

### Placement
Resolve the primary checkout from Git's common directory. Unless the user/project
explicitly selects another location, use `<primary-parent>/worktrees/<repo>/<task>`.
Example: `D:/src/worktrees/example-repo/<task>`.
Keep temporary copies, QA fixtures and logs in `_scratch/<task>` beneath that same
repo worktree folder; captured evidence/backups belong in `_evidence/<task>`.
Do not scatter new checkouts, copies or build targets beside the primary checkout.
For any task that may produce external artifacts, main supplies the exact absolute
`_scratch/<task>` and `_evidence/<task>` paths in its dispatch packet, including
when source work uses the primary checkout. Leaves do not invent sibling folders;
if required paths are missing, they return that scope to main before writing.
Use `git worktree add` for Git checkouts and record their absolute paths in packets.
At handoff, compare output paths against the packet and pre-task root inventory.
Move only idle, task-owned misplaced artifacts to their assigned directory and
verify preservation; retain and report live or unknown data instead of cleaning it.
Do not move an existing checkout while a running/paused worker or server uses it.

### Live artifact relocation
For existing database or build-output directories, identify owning processes,
ports and probable data paths. If owners are active, obtain explicit downtime
authority, quiesce and stop them, and verify they exited. Never move a running
executable or live SQLite database. Back up a live SQLite database through its backup API when
needed, and verify the backup.
Unknown restart configuration does not block authorized relocation; leave
services stopped if restart requirements cannot be established. Move each
database directory separately with its `.db`, `-wal` and `-shm` files intact;
do not merge databases, delete sidecars or overwrite a destination. Verify
file counts/hashes after moving whole directories. Path-bound tools such as
virtualenv launchers may need recreation; check them before claiming they work.
Restart only with a verified executable, environment and DB path (for example
`DB_PATH`); otherwise leave services stopped and report the required handoff.

### Completion and cleanup
Two distinct modes exist: routine post-merge cleanup (this section, unchanged) and the explicit, narrow Authorized retirement mode below. A merge, readiness or a general cleanup request never selects retirement.
After a verified merge/delivery (including squash/rebase), release engineer owns
safe cleanup of explicitly named task-owned worktrees. Main retains
scheduling, exact candidate/target identity, approvals, terminal-owner/quiescence
evidence and coordination. Main supplies the exact candidate/primary and owned
checkout list; never sweep all registered worktrees. PR-only delivery does not
trigger removal of an unmerged candidate.

The cleanup release engineer must run outside the target checkout and only after
its delivery worker is terminal. If delivery ran inside the candidate, return
MERGED with CLEANUP_PENDING; main schedules a cleanup release engineer from the
primary/outside target after terminal confirmation. A checkout used by any
running/paused worker or server must be retained. Missing terminal or quiescence
evidence means RETAINED / CLEANUP_PENDING, never inferred approval.

Before removal, establish intended merge/integration (committed-only is not
merged), inspect tracked, untracked and ignored state, and preserve unique
evidence outside the checkout. Remove only clean, integrated, idle, task-owned
checkouts with `git worktree remove` using the exact absolute path and no
`--force`; verify both folder and registration are gone. Report each checkout as
REMOVED or RETAINED with a concrete reason. Routine cleanup never resets/cleans, force-removes, deletes branches or deletes arbitrary directories; only the separate Authorized retirement mode below may force-remove, and only as stated there. Do not prune missing
registrations as part of this procedure. This is a workflow step, not a watcher;
abandoning a task still requires disposition. Readiness or role guidance is not
operation authority.

The cleanup set is exactly three targets, each named in the parent packet by exact absolute path: (1) the clean, integrated, idle, task-owned checkout, removed with `git worktree remove <exact absolute path>` (no `--force`); (2) the exact `_evidence/<task>` directory; (3) the exact `_scratch/<task>` directory. The parent packet supplies the exact host-appropriate removal operation for each artifact directory, applied one exact path at a time. Forbidden: no archive-by-default, no bulk copy, no sweep, no wildcard, no shared-parent removal, no parent-directory removal, no prune, no branch deletion, no force, reset or clean. A target holding unique or unreproduced required evidence or user data whose preservation requirement is not met is RETAINED and reported; it is not copied or archived by default.
Retain and report RETAINED with a concrete reason for any target that is dirty, unmerged, unknown, under explicit retention or missing authority, or that has an active or paused job, a running service, a database with live -wal or -shm sidecars, shared or uniquely owned data, user data, or a BLOCKED knowledge checkpoint. Unmerged or PR-only candidates are retained.
Cleanup worker temp, log and report destinations lie outside all three deletion targets: use inline or approved external report paths only, and no file is recreated in a removed target after delete.
Knowledge gate before cleanup: LEARN completes before the final commit or PR (canonical checkpoint in `../learn/index.md`). Cleanup after a verified merge runs once the knowledge checkpoint is SAVED (local: exact record and index paths with readback, outside all three deletion targets) or after a NO LESSON checkpoint. A destination inside any of the three deletion targets is not durable. Shared publication, when separately authorized, is verified read-only from a freshly fetched remote base: `git fetch <remote> <base>`; take the merged SHA from `git rev-parse <remote>/<base>`, not commit ancestry, because squash merges do not keep the feature commits; for each exact record and index path, `git rev-parse <merged-sha>:<path>` must equal the `git -C <exact checkout path> hash-object -- <path>` output for the local readback file, run before any removal. A BLOCKED knowledge checkpoint retains the affected targets and reports the concrete gap; it never rolls back the merge. A lesson verified only after merge may be saved locally outside the deletion targets; a shared copy needs an authorized follow-up PR and cannot be claimed as already published.
Before the final commit or PR, main selects LEARN when warranted. The knowledge-disposition checkpoint (SAVED, NO LESSON or BLOCKED) is canonical in `../learn/index.md`, which keeps LOCAL-ONLY storage; saving grants no implicit staging, commit, push, publication or QMD index or refresh. Shared publication is separate explicit authority, not a default completion gate. Archiving a report or fixture is evidence, not learning completion.
### Authorized retirement (explicit exception)
Use only when the parent packet carries user-disposition authority that names each exact absolute path or data item and the exact operation for it; readiness or role guidance grants nothing and parent approval is never implied. The current retirement case is an example, not a hardcoded path set.
- Discard consent: a dirty, unmerged or draft checkout is disposable only with explicit discard consent for that exact path; consent to merge or to general cleanup is not discard consent.
- Operations: `git worktree remove --force <exact absolute path>` for only the listed discarded checkouts, then removal of the exact approved retired parent directory (even if historically shared) with the packet's exact host-appropriate operation. The parent is removed only after all nested registrations are removed and confirmed gone. Hard limits: no sweep, wildcard or arbitrary parent; no branch deletion, no reset, no clean, no prune, no history rewrite.
- Protected: the primary checkout, every path outside the listed targets and artifacts outside the targets are never touched. Reject and retain on an active or paused worker, running service, live database (`-wal`/`-shm`), unknown actual ownership, new ongoing data under a target, or the cleanup worker's own cwd. Evidence of idleness is terminal known owners, fresh process, lock and link checks, and the explicit user statement that nothing ongoing is in a target; no global handle proof is required.
- Knowledge: a local SAVED or NO LESSON checkpoint (see above) exists outside every target before any removal; no fabricated lesson and no automatic archive.
- Links: inspect actual links and junctions without following links; use only an operation with proven link behavior on this host, so a link is removed, never its target.
- Authority: existing guard refusal and exact operator grant remain required; no guard bypass and no ungated Node deletion. Reports and temp files stay outside every target.
- Order: preflight every target (identity, ownership, idleness, links, registrations, protected data); require the SAVED or NO LESSON checkpoint; force-remove each listed discarded checkout; continue only after all nested registrations are removed and confirmed; remove the exact approved retired parent; then verify exact target absence, registration absence and protected data readback. Any failed preflight or command must stop all remaining operations with a partial report.
Load `references/extended.md` only for recovery or multi-worktree complexity.

Resolve relative references from this module folder. This procedure supplies guidance; the selected named role still must actually run.
