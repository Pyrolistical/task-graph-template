Your last plan was rejected. Address every finding:

{{#findings}}
- {{finding}}
{{/findings}}

Read `../ASSIGNMENT.md` and decompose its `## Design` into a plan again.

1. Understand the goal
2. Understand the existing system
3. Understand the design
4. Order the steps that build it

- The plan should be written under a `## Todos` heading at the end of
  `../ASSIGNMENT.md`, a numbered list `1.` to `n.`. The section is empty again
  — the rejected plan is not in it.
- Each todo is specific and verifiable, carrying everything needed to act on
  it, and together they cover the design, every acceptance criterion, and every
  finding above.
- Write no code and commit nothing.

Finish by calling `submit`, or `blocked`.
