import { describe, expect, test } from "bun:test";
import { git, gitOrThrow } from "./git.ts";

describe("Feature: running git subprocesses", () => {
  test("a failing git command reports its stderr", async () => {
    // Given a git command that names a ref no repository has
    // When the command is run
    const result = await git(process.cwd(), [
      "rev-parse",
      "--verify",
      "definitely-not-a-ref",
    ]);

    // Then it fails and the failure carries git's own words
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("fatal:");
  });

  test("gitOrThrow names the failure and its stderr", async () => {
    // Given a git command that fails
    const attempt = () =>
      gitOrThrow(process.cwd(), [
        "rev-parse",
        "--verify",
        "definitely-not-a-ref",
      ]);

    // When it is run through gitOrThrow
    // Then the error says which exit and what git reported
    await expect(attempt()).rejects.toThrow(/\(exit \d+\): fatal:/);
  });
});
