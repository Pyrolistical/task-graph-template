`../ASSIGNMENT.md` has `result: type: submit` with {{open}} todo(s) still
`done: false`. Every todo ends at `done: true`, or the result is `blocked`. In
that file:

- For a todo whose fix is committed and which you have seen work, set its
  `done: true`.
- For one that is not finished, finish it, commit it, then set its `done: true`.
- If you cannot finish it, replace the `result` block with

  ```yaml
  result:
    type: blocked
    message: "the one thing that stands in the way, on one line"
  ```

Leave the todo messages, the checks and everything else in the frontmatter as
they are.
