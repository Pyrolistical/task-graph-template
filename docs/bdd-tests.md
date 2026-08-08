# Behavior Tests in Bun

Write Bun tests using **Given / When / Then** comments. Each comment must be a complete sentence describing the behavior being tested.

## Rules

1. Every test must have **Given, When, and Then** comments.
2. Each comment must be a complete sentence.
3. Describe behavior, not implementation details.
4. There can be **only one `When` per test**. The `When` represents the single behavior being tested. It is an anti-pattern if the When isn't a single line of code. It probably means it is doing some state setup.
5. Multiple `Given` and `Then` statements are allowed. Write one Given per state setup.
6. Use domain language that describes what the system does.
7. Each Given/When/Then should be self consistent. Everything When/Then refers should be defined in the Givens.
8. Given/When/Then should read like a story that explains a part of the system to the reader. The Then should be explict on what the values are not some vague notion of correctness.
9. A `Then` describes the system, never the test, the suite or the rig.
10. No `or` in a `Given`, `When` or `Then`. Alternatives are separate tests.
11. **No conditionals in a test**, conditionals means they are separate tests.
12. **No `test.each`**. A table hides its values behind placeholders, leaving the Given/When/Then abstract. Also no .map in When as it yields the same issue.
13. If a test needs a second `When`, it means it either is two tests or the first When is setting up state, in which case the test jig should be created to turn it into a Given.

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
