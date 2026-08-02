---
assignment: "{{id}}"
todos:
  {{#todos}}
  - message: "{{message}}"
    done: {{done}}
  {{/todos}}
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

## What you are reviewing (todos)

Check every todo in the frontmatter, one by one: has it actually been
completed in the commits? Do the commits accomplish the task in the body? Be
critical — is there any slop that needs to be fixed, and can the code be
written more simply? Point out what you find in a list of findings for the
worker to fix.

You do not fix anything and you do not commit.

## Notes
