# Behavior Tests in Bun

Write Bun tests using **Given / When / Then** comments. Each comment must be a complete sentence describing the behavior being tested.

## Rules

1. Every test must have **Given, When, and Then** comments.
2. Each comment must be a complete sentence.
3. Describe behavior, not implementation details.
4. Keep each test focused on **one behavior**.
5. There can be **only one `When` per test**. The `When` represents the single behavior being tested.
6. Multiple `Given` and `Then` statements are allowed.
7. Use domain language that describes what the system does.
8. Every actor a `Then` names has a `Given` that put it there. Two agents in the
   `Then` means two `Given`s.
9. A `Then` says what the value **is**, not that it is what something needs. Say
   "the write path defaults to the zig cache", never "the cache it is given".
10. A `Then` describes the system, never the test, the suite or the rig.
11. No `or` in a `Given`, `When` or `Then`. Alternatives are separate tests.
12. **No conditionals in a test** — no `if`, no ternary, no branch in an
    expectation. A test that branches is a test that is sometimes not run.
    Branching belongs in a jig under `orchestrator/testing/`.
13. A table of examples is `test.each` — one row per case, so each is its own
    named test. Never `map` a literal list inside the `When`. Mapping is for a
    list the system itself defines (every state, every transition), or for a
    `Then` that is a relation between the rows.

## Example

```ts
import { describe, expect, test } from "bun:test";

describe("Feature: Account withdrawal", () => {
  test("users cannot withdraw more than their balance", () => {
    // Given the user's balance is $100
    const account = createAccount({ balance: 100 });

    // Given the withdrawal limit is $100
    account.setWithdrawalLimit(100);

    // When the user withdraws $150
    const result = account.withdraw(150);

    // Then the withdrawal is rejected
    expect(result).toBe(false);

    // Then the user's balance remains $100
    expect(account.balance).toBe(100);
  });
});
```

A table reads the same way, once per row. `testInTempDirs.each` is the same
thing for a test that needs temporary directories.

```ts
test.each([
  [999, "999"],
  [12_345, "12.3k"],
])("a count of %p tokens reads as %p", (count, reads) => {
  // Given a count of tokens measured for a header
  const used = count;

  // When it is written for a header
  const written = thousands(used);

  // Then it is written as the console shows it
  expect(written).toBe(reads);
});
```

If a test needs a second `When`, it is usually testing **two behaviors** and should be split into separate tests. If a second `When` is used to setup state, then better test infrastructure needs to be created to turn that into a Given.
