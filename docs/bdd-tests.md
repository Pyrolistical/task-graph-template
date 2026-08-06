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

If a test needs a second `When`, it is usually testing **two behaviors** and should be split into separate tests. If a second `When` is used to setup state, then better test infrastructure needs to be created to turn that into a Given.
