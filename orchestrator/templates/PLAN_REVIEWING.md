---
assignment: "{{id}}"
todos:
  {{#todos}}
  - message: "{{message}}"
    done: false
  {{/todos}}
checks:
  {{#checks}}
  - "{{command}}"
  {{/checks}}
result: null
---

# {{title}}

{{body}}

## What you are reviewing (the plan)

The `todos` above are the plan an implementer will work through. Check each
todo step one by one and see whether it would accomplish the assignment in
the body. Where a step would not — or the steps together still fall short —
that is a mistake: point it out and produce a list of findings for the
planner to address. You change nothing in this worktree and you do not
commit.

## Notes
