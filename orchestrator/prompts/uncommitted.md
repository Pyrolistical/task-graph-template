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

That last `git status --porcelain` has to print nothing. Only what is committed
survives this worktree. Once it does, submit again by calling the `submit`
tool.
