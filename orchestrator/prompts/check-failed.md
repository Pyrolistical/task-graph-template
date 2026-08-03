The checks were run against the work you just submitted, and these failed:

{{#failures}}
`{{command}}` (exit {{exit_code}}):

```
{{output}}
```

{{/failures}}
Fix each one in this worktree, commit the fix, and run the command yourself until
it exits 0. Record what you changed in your `## Implementation Notes`.

Once every check above passes, submit again by calling the `submit` tool. If
you cannot get there, call `blocked` with a `message` naming what stands in
the way.
