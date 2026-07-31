Commit your work in this worktree, then submit again:

```
git add -A
git commit -m "<what you did>"
git status --porcelain
```

{{#empty}}

There is no commit of yours on this branch yet, so the branch as it stands
carries none of this work.
{{/empty}}
{{#dirty}}

`git status --porcelain` reports:

```
{{status}}
```

{{/dirty}}

That last `git status --porcelain` has to print nothing. Leave
`result: type: submit` in `../ASSIGNMENT.md` as it is once it does — the file is
already right, the git history is what is missing. Only what is committed
survives this worktree.
