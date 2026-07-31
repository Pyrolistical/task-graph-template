Edit `../ASSIGNMENT.md` and replace the `result: null` line in its frontmatter —
everything between the first two `---` lines — with one of these two blocks:

```yaml
result:
  type: submit
  findings:
    - "a defect in this work, one entry each"
  delegations:
    - "a defect outside it, one entry each"
```

```yaml
result:
  type: blocked
  message: "the one thing that stopped you reviewing, on one line"
```

With `submit`, both lists have to be there: write `findings: []` when the work is
sound and `delegations: []` when you found nothing outside it.

Make the edit in the file with your edit tool. The file is the only thing read;
what you write in your reply is discarded. Change nothing else in the
frontmatter, fix nothing and commit nothing.
