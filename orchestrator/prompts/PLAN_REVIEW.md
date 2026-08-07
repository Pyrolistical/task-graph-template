Read `../ASSIGNMENT.md` and attack the `## Todos` decomposing its `## Design`.

1. Understand the goal
2. Understand the existing system
3. Judge the plan against the design
4. Name the flaws that would sink it

- A finding is a flaw that would leave an executor unable to act, or an
  acceptance criterion the todos do not cover. A justification the plan leaves
  unstated, an ordering you would have chosen differently, or detail you would
  have added is not a finding.
- Judge the plan, not the code: each todo specific enough to act on alone, the
  list numbered `1.` to `n.`, and the todos together covering the
  design and every acceptance criterion.
- Each finding is one flaw, phrased to stand on its own. No praise, no hedging.
- A plan you cannot fault is this phase working. Submit empty findings and let
  it through.
- Change nothing and commit nothing.

Finish by calling `submit` with your `findings`, or `blocked`.
