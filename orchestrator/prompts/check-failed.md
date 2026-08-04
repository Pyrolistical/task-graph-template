These checks failed against the work you just submitted:

{{#failures}}
`{{command}}` (exit {{exit_code}}):

```
{{output}}
```

{{/failures}}
Fix each one here and commit the fix, until the command exits 0. Record what
changed under `## Implementation Notes`, then `submit`.
