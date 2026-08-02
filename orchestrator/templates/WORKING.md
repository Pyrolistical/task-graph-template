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

## Your work

Follow the todos to complete the assignment. If the todos
are incomplete, go beyond them and complete the assignment.

## Notes
