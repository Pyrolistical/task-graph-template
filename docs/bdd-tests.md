# Behaviour tests

Bun tests written as Given / When / Then comments, each a complete sentence. Enforced by `bdd.test.ts`, which also fails on a suite it cannot parse; [`docs/bdd.md`](bdd.md) is generated from them.

1. Every test has Given, When and Then comments, in domain language, describing behaviour rather than implementation.
2. **One `When`** — the single behaviour under test. A `When` that is not one line of code is state setup pretending to be a behaviour; a test needing a second is two tests, or its first belongs in a jig as a Given.
3. Use multiple Givens and Thens; one Given per state setup; one Then per assertion.
4. Self-consistent: everything the When and Then refer to is defined in the Givens.
5. It reads as a story. A Then states actual values, and describes the system rather than the test, the suite or the rig.
6. No `or`, no conditionals, no `test.each` and no `.map` in a When — alternatives are separate tests, and a table hides its values behind placeholders.
7. Every `describe` is named `Feature: …`.
