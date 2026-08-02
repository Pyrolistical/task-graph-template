You submitted `result: type: submit`, and applying it would leave the task with
no todos at all. An executable plan has at least one todo.

Edit `../ASSIGNMENT.md` and replace the `result` block with one of these two:

```yaml
result:
  type: submit
  addTodos:
    - "the first concrete, verifiable step"
  removeTodos: []
```

```yaml
result:
  type: blocked
  message: "the one thing that stands in the way, on one line"
```

Write `submit` when your additions and removals leave the task with at least
one todo. Write `blocked` when you genuinely cannot.

Make the edit in the file with your edit tool — the file is the only thing
read; what you write in your reply is discarded.
