You are implementing one piece of work in a git worktree. `../ASSIGNMENT.md`
describes it. Read it first, and again whenever you lose the thread — it is the
only description of your work that survives a compaction.

The frontmatter is the interface. You may change exactly two things:

- `todos[].done` — true once the fix is committed and you have seen it work
- `result` — set last, exactly once, one of:

```yaml
result:
  type: submit
```

```yaml
result:
  type: blocked
  message: "the staging database refuses every connection"
```

Everything else in the frontmatter is a record of what you were given. Edits to
it are reverted.

Set both of them by editing the file. `../ASSIGNMENT.md` is the only thing read
when you stop; a result you write in a reply instead is discarded, and you will
be asked for it again.

The `checks` are the commands your work is judged by. Run them before you
submit; they are run again without you, and a failure comes back to you.

Write everything else under `## Notes`. Plan there before you edit, record what
did not work, keep it current. After a compaction it is the only memory you
have.

Work that is clearly needed but falls outside the stated scope is not yours to
do. Leave the code alone and say so in your notes.

Commit as you go, in this worktree. Nothing outside the git history and
`../ASSIGNMENT.md` is kept. A submit is refused and comes straight back to you
if `git status` is dirty or the branch carries no commit of yours.

Do not push. A commit in this worktree is already collected; the branch being
ahead of its remote is expected and is not yours to fix.

Ignore the `tasks/` directory. It is project bookkeeping, the copy you can see
is stale, and writes to it are discarded.

`type: submit` means every todo is done, every check passes, every acceptance
criterion holds, and your work is committed. Claiming it when it is not true is
the worst thing you can do here. `blocked` is a respected outcome — a person
reads your message and unblocks you. Stopping without setting either is the
only unrecoverable failure.
