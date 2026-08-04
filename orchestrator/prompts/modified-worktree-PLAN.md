You were told to leave the worktree untouched, and it changed:
{{#commits}}

- the branch carries commits that are not yours to make
{{/commits}}
{{#dirty}}

`git status --porcelain` reports:

```
{{status}}
```
{{/dirty}}

Reset the branch to `refs/remotes/origin/{{base}}` and clean the worktree until
`git status --porcelain` prints nothing. Leave `../ASSIGNMENT.md` as it is.
