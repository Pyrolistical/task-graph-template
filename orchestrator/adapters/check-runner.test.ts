import { describe, expect } from "bun:test";
import { tempDir, testInTempDirs } from "../testing/temp-dirs.ts";
import fs from "node:fs";
import path from "node:path";
import { CheckRunner } from "./check-runner.ts";
import { tailOf } from "../domain/checks.ts";
import { at } from "../testing/present.ts";

describe("Feature: running a task's declared checks", () => {
  testInTempDirs(
    "a check that fails comes back with its code and both its streams",
    async () => {
      // Given a check that writes to stdout and stderr and then fails
      const dir = tempDir("orchestrator-");
      const log = path.join(dir, "check-0.log");
      const runner = new CheckRunner();

      // When the check is run against the task's worktree
      const result = await runner.start(
        "000042",
        0,
        "echo hello; echo bad >&2; exit 2",
        dir,
        log,
      );

      // Then the exit code comes back, so the server knows the check failed
      expect(result.code).toBe(2);

      // Then the tail carries both streams, which is what the agent is shown
      expect(result.tail).toContain("hello");
      expect(result.tail).toContain("bad");

      // Then the whole output is on disk, for a person to read afterwards
      expect(fs.readFileSync(log, "utf-8")).toContain("hello");
    },
  );

  testInTempDirs(
    "a check appears in the view while it runs and leaves it when it ends",
    async () => {
      // Given a check that takes long enough to be seen running
      const dir = tempDir("orchestrator-");
      const runner = new CheckRunner();

      // When the check is started
      const running = runner.start(
        "000042",
        1,
        "sleep 0.2",
        dir,
        path.join(dir, "c.log"),
      );

      // Then the console can see what is running and under which process
      expect(runner.view).toHaveLength(1);
      expect(at(runner.view, 0).command).toBe("sleep 0.2");
      expect(at(runner.view, 0).pid).toBeGreaterThan(0);
      expect(runner.isRunning("000042")).toBe(true);

      // Then the view empties again once the check is done
      await running;
      expect(runner.view).toEqual([]);
    },
  );

  testInTempDirs("the output kept is the end of it, not the start", () => {
    // Given a check that wrote far more output than an agent can be shown
    const output = Array.from({ length: 100 }, (_, i) => `line ${i}`).join(
      "\n",
    );

    // When the output is cut down to what the agent will read
    const tail = tailOf(output, 3);

    // Then it is the last lines, which is where a failure is reported
    expect(tail).toBe("line 97\nline 98\nline 99");
  });
});
