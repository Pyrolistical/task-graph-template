You set `result: type: blocked`, which stops this task and puts it in front of
a person. That is worth one second look.

A review you can still write is not a wall. If you can judge the plan despite
whatever stopped you, do that: replace the blocked block in `../ASSIGNMENT.md`
with

```yaml
result:
  type: submit
  findings:
    - "the gap between the plan and the acceptance criteria"
```

— an empty `findings: []` when the plan is complete — and the task moves on.

If it really is a wall — something you cannot get past without a decision or an
access you do not have — write the same blocked result back into the file,
unchanged, and it will be taken at its word.
