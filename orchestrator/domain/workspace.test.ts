import { describe, expect, test } from "bun:test";
import { branchName } from "./workspace.ts";

describe("Feature: the branch a task's work lands on", () => {
  test("a task's branch is named for the task it does", () => {
    // Given the id of a task
    const id = "000042";

    // When its branch name is worked out
    const branch = branchName(id);

    // Then it names the task, so the branch reads as work in the repository
    expect(branch).toBe("task/000042");
  });
});
