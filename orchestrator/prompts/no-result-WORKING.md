Edit `../ASSIGNMENT.md` and replace the `result: null` line in its frontmatter —
everything between the first two `---` lines — with one of these two blocks:

```yaml
result:
  type: submit
```

```yaml
result:
  type: blocked
  message: "the one thing that stands in the way, on one line"
```

Write `submit` when every todo in that file is `done: true`, every check passes
and every change is committed in this worktree. Write `blocked` when one of
those is not true and you cannot get there.

Make the edit in the file with your edit tool. The file is the only thing read;
what you write in your reply is discarded. Change nothing else in the
frontmatter and start no new work.
