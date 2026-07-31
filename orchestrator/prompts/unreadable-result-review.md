The frontmatter of `../ASSIGNMENT.md` could not be read:

```
{{#issues}}
{{message}}
{{/issues}}
```

Rewrite everything between the first two `---` lines of that file so it reads
exactly like this, with the `assignment` and `checks` values you were given:

```yaml
---
assignment: "000042"
todos: []
checks:
  - "bun test"
result:
  type: submit
  findings:
    - "parseHeader returns null on an empty body and every caller dereferences it"
  delegations: []
---
```

Two spaces per level of indentation, no tabs, every string double-quoted, and
`findings: []` or `delegations: []` when a list has no entries. Both lists have
to be there. `result` is either the block above or `type: blocked` with a
`message`.

Read the file back afterwards and compare it to that shape. Nothing you recorded
there has been applied yet, so this is the only copy.
