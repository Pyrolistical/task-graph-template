Edit `../ASSIGNMENT.md` and replace the `result: null` line in its frontmatter —
everything between the first two `---` lines — with one of these two blocks:

```yaml
result:
  type: submit
  findings:
    - "the gap between the plan and the acceptance criteria"
```

(an empty `findings: []` approves the plan)

```yaml
result:
  type: blocked
  message: "the one thing that stands in the way, on one line"
```

Write `submit` with the findings from your review of the plan. Write `blocked`
when you cannot review it.

Make the edit in the file with your edit tool. The file is the only thing read;
what you write in your reply is discarded. Change nothing else in the
frontmatter and start no new work.
