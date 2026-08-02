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

## Plan

Write down what you would do to complete the assignment: a step by step todo
list, one step per todo, in the order you would take them. Submit it as
`result: type: submit` with an `addTodos` list.
The todos in the frontmatter above are already decided — keep every one, or
name one in `removeTodos` by the index it appears at here (removals apply
before additions). Each todo you add must be as specific as possible: name
the file and the line numbers the work lands at. Together the todos must
also cover the refactorings you will do to keep the commits easy to review,
the new tests you will add, and the dead code you will delete. They must be
ordered and verifiable — a piece of work an implementer can execute without
you present. No pseudo-todos.

{{#plan_feedback_head}}
The previous plan was rejected with these findings — address every one:
{{/plan_feedback_head}}

{{#plan_feedback}}
{{finding}}
{{/plan_feedback}}

## Notes
