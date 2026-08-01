You set `result: type: blocked`, which stops this task and puts it in front of
a person. That is worth one second look.

A blocker that is really work outside this task's scope is a delegation, not a
wall. If that is what you hit, replace the blocked block in `../ASSIGNMENT.md`
with your review of the work in front of you and the blocker as a delegation,
where the manager decides what becomes of it:

```yaml
result:
  type: submit
  findings: []
  delegations:
    - "the work outside this task that stopped you"
```

If it really is a wall — something you cannot get past without a decision or an
access you do not have — write the same blocked result back into the file,
unchanged, and it will be taken at its word.
