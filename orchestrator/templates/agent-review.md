---
assignment: "{{id}}"
todos: []
checks:
  {{#checks}}
  - "{{command}}"
  {{/checks}}
result: null
---

# {{title}}

{{body}}

## What you are reviewing (given)

The work is the commit range `{{range}}` in the worktree you are running in,
`{{worktree}}`. Read it however you like — `git log`, `git show`, the files
themselves — and read the tree around it, not only the lines that changed.

Every check above was run against this range and passed.

You do not fix anything and you do not commit.

## Notes
