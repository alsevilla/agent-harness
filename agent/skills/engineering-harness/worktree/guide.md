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
REMOVED or RETAINED with a concrete reason. Never reset/clean, force-remove,
delete branches, or delete arbitrary directories. Do not prune missing
registrations as part of this procedure. This is a workflow step, not a watcher;
abandoning a task still requires disposition.

After successful merge and task-owned artifact disposition, main evaluates
verified reusable lessons with bounded dedup. Main selects and coordinates any
LEARN work; only the release engineer performs authorized persistence to the
exact named canonical knowledge destination and verifies its content before
reporting SAVED. The terminal knowledge-disposition checkpoint is SAVED (exact
path/evidence), NO LESSON (reason), or BLOCKED (specific evidence, destination,
or authority gap). Archiving a report or fixture is evidence, not learning
completion. If learning is BLOCKED after merge, report that gap without implying
rollback of the completed merge.

Load `references/extended.md` only for recovery or multi-worktree complexity.
