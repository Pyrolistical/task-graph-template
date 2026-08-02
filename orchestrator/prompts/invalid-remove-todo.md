Your `removeTodos` list names indices that are not in the frontmatter — out of
range, or the same index twice. The todos shown there are the only ones that
exist, numbered from 0.

Edit `../ASSIGNMENT.md` and replace the `result` block with:

```yaml
result:
  type: submit
  addTodos:
    - "the first concrete, verifiable step"
  removeTodos: []
```

— with `removeTodos` naming each todo at most once and only within the list
shown, or `type: blocked` with a message if you cannot plan this task.

Make the edit in the file with your edit tool — the file is the only thing
read; what you write in your reply is discarded.
