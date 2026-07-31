The checks were run against the work you just submitted, and these failed:

{{#failures}}
`{{command}}` (exit {{exit_code}}):

```
{{output}}
```

{{/failures}}
Fix each one in this worktree, commit the fix, and run the command yourself until
it exits 0. Record what you changed under `## Notes`.

Your `result` was reset to null. Once every check above passes, set it in
`../ASSIGNMENT.md` to

```yaml
result:
  type: submit
```

If you cannot get there, set it to `type: blocked` with a `message` naming what
stands in the way.
