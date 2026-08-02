You were told to change nothing but `../ASSIGNMENT.md`. The server verifies
the worktree after every stop, and it changed:

{{#commits}}

The branch carries commits that are not yours to make.
{{/commits}}
{{#dirty}}

`git status --porcelain` reports:

```
{{status}}
```

{{/dirty}}

Undo it all — your work lives only in `../ASSIGNMENT.md`:

```
git reset --hard refs/remotes/origin/{{base}}
git clean -fd
git status --porcelain
```

That last `git status --porcelain` has to print nothing. Leave `result` in
`../ASSIGNMENT.md` as it is — the file is already right, the worktree is what
was wrong.
