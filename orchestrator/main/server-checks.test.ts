import { describe, expect } from "bun:test";
import { requireWorkspace } from "../vocabulary/task.ts";
import { testInTempDirs } from "../testing/temp-dirs.ts";
import fs from "node:fs/promises";
import path from "node:path";
import { takeClaim } from "../tasks/adapters/task-documents.ts";
import { branchName } from "../workspaces/domain/workspace.ts";
import { readView } from "../console/adapters/tui.ts";
import { activeTaskPath } from "../tasks/adapters/task-store.ts";
import * as git from "../workspaces/adapters/git.ts";
import {
  type Fixture,
  makeFixture,
  promptsTo,
  readyTask,
  setPlan,
} from "../testing/fixture.ts";
import type { App } from "./compose.ts";
import {
  dispatchOnce,
  transitionsOf,
  pathsOf,
  reaches,
  runOnce,
  serverFor,
  stateOf,
  until,
  walkTo,
  taskOf,
  workspaceOf,
  sessionOf,
} from "../testing/server-jig.ts";
import { at } from "../testing/present.ts";

describe("Feature: running a task's checks", () => {
  testInTempDirs(
    "a failing check records the failure and sends the work back",
    async () => {
      const fixture = await makeFixture();
      const id = await readyTask(fixture, "Do a thing", [
        "echo boom >&2; exit 3",
      ]);
      await setPlan(fixture, {
        [id]: {
          WORK: [
            {
              submit: true,
              notes: "did the work",
              commit: { path: "a.txt", contents: "a" },
            },
          ],
        },
      });

      // Given a task whose only check writes to stderr and fails
      const app = await serverFor(fixture);

      // When the work is done and the check runs against it
      await dispatchOnce(app);

      // Then the task goes back to work with the failure queued for the agent
      const task = await taskOf(app, id);
      expect(task.state).toBe("WORK");
      const queued = await fs.readFile(
        pathsOf(app).messageFile(id, "WORK"),
        "utf-8",
      );
      expect(queued).toContain("echo boom >&2; exit 3");
      expect(queued).toContain("boom");

      await app.server.shutdown();
    },
    30000,
  );

  testInTempDirs(
    "every failing check is recorded, not only the first",
    async () => {
      const fixture = await makeFixture();
      const id = await readyTask(fixture, "Do a thing", [
        "exit 1",
        "true",
        "exit 2",
      ]);
      await setPlan(fixture, {
        [id]: {
          WORK: [
            {
              submit: true,
              notes: "did the work",
              commit: { path: "a.txt", contents: "a" },
            },
          ],
        },
      });

      // Given a task with three checks, the first and last of which fail
      const app = await serverFor(fixture);

      // When the work is done and the checks run against it
      await dispatchOnce(app);

      // Then the agent is told about both failures, not only the first
      const queued = await fs.readFile(
        pathsOf(app).messageFile(id, "WORK"),
        "utf-8",
      );
      expect(queued).toContain("(exit 1)");
      expect(queued).toContain("(exit 2)");

      await app.server.shutdown();
    },
    30000,
  );

  testInTempDirs(
    "a passing check moves the task to the agent review",
    async () => {
      const fixture = await makeFixture();
      const id = await readyTask(fixture, "Do a thing", ["true", "test -d ."]);
      await setPlan(fixture, {
        [id]: {
          WORK: [
            {
              submit: true,
              notes: "did the work",
              commit: { path: "a.txt", contents: "a" },
            },
          ],
          WORK_REVIEW: [{ submit: true }],
        },
      });

      // Given a task with two checks that both pass
      const app = await serverFor(fixture);

      // When the work is done and the checks run against it
      await app.dispatcher.setEnabled(true);

      // Then the task moves on to the agent review
      await reaches(app, id, "WORK_REVIEW");

      await app.server.shutdown();
    },
    30000,
  );

  testInTempDirs(
    "the whole output of a check is written where a person can read it",
    async () => {
      const fixture = await makeFixture();
      const id = await readyTask(fixture, "Do a thing", [
        "echo written-to-the-log",
      ]);
      await setPlan(fixture, {
        [id]: {
          WORK: [
            {
              submit: true,
              notes: "did the work",
              commit: { path: "a.txt", contents: "a" },
            },
          ],
        },
      });

      // Given a task whose check writes to its output
      const app = await serverFor(fixture);

      // Given a server with its scheduler enabled
      await app.dispatcher.setEnabled(true);

      // When the work is done and the check runs against it
      await until(app, () => fs.exists(pathsOf(app).checkLog(id, 0)));

      // Then the output is on disk in the task's own directory
      expect(
        await fs.readFile(pathsOf(app).checkLog(id, 0), "utf-8"),
      ).toContain("written-to-the-log");

      await app.server.shutdown();
    },
    30000,
  );
});

describe("Feature: sending a task back to the agent that did it", () => {
  testInTempDirs(
    "the same session is reopened, the assignment is untouched and the result is cleared",
    async () => {
      const fixture = await makeFixture();
      const id = await readyTask(fixture, "Do a thing", ["test -f fixed.txt"]);
      await setPlan(fixture, {
        [id]: {
          WORK: [
            {
              submit: true,
              notes: "first attempt",
              commit: { path: "a.txt", contents: "a" },
            },
            {
              submit: true,
              notes: "first attempt\n\nthen I added fixed.txt",
              commit: { path: "fixed.txt", contents: "now it is here\n" },
            },
          ],
          WORK_REVIEW: [{ submit: true }],
        },
      });

      // Given a task whose check failed once and whose session was kept
      const app = await serverFor(fixture);
      await dispatchOnce(app);
      const afterFailure = await taskOf(app, id);
      expect(afterFailure.state).toBe("WORK");
      expect(requireWorkspace(afterFailure).session).not.toBeUndefined();

      // When the agent is dispatched again and finishes the work
      await walkTo(app, id, "MANAGER_REVIEW");

      // Then the assignment was never rotated, because the session was resumed
      const history = await fs.readdir(pathsOf(app).history(id));
      expect(history).toHaveLength(0);

      // Then the check failed exactly once, so the second attempt passed
      const failures = (await (await transitionsOf(app)).read()).filter(
        (e) => e.transition === "fail" && e.to === "WORK",
      );
      expect(failures).toHaveLength(1);

      await app.server.shutdown();
    },
    30000,
  );

  testInTempDirs(
    "a resumed session is billed once, however many turns it took",
    async () => {
      const fixture = await makeFixture();
      const id = await readyTask(fixture, "Do a thing", ["test -f fixed.txt"]);
      await setPlan(fixture, {
        [id]: {
          WORK: [
            {
              submit: true,
              notes: "first attempt",
              commit: { path: "a.txt", contents: "a" },
            },
            {
              submit: true,
              notes: "first attempt\n\nthen I added fixed.txt",
              commit: { path: "fixed.txt", contents: "now it is here\n" },
            },
          ],
          WORK_REVIEW: [{ submit: true }],
        },
      });

      // Given a task whose check failed once, so its work session was resumed
      const app = await serverFor(fixture);
      await dispatchOnce(app);

      // When the resumed session finishes the work and the review passes
      await walkTo(app, id, "MANAGER_REVIEW");

      // Then the work is one entry at the session total, because a resume is not a second session
      expect((await taskOf(app, id)).costs).toEqual([
        {
          state: "WORK",
          slot: "pi-fake-fake-1",
          seconds: expect.any(Number),
          cost: 0.45,
        },
        {
          state: "WORK_REVIEW",
          slot: "pi-fake-fake-1",
          seconds: expect.any(Number),
          cost: 0.45,
        },
      ]);

      await app.server.shutdown();
    },
    30000,
  );

  testInTempDirs(
    "the resume prompt carries every failing command into the session",
    async () => {
      const fixture = await makeFixture();
      const id = await readyTask(fixture, "Do a thing", ["test -f fixed.txt"]);
      await setPlan(fixture, {
        [id]: {
          WORK: [
            {
              submit: true,
              notes: "did the work",
              commit: { path: "a.txt", contents: "a" },
            },
            {
              submit: true,
              notes: "added fixed.txt",
              commit: { path: "fixed.txt", contents: "now it is here\n" },
            },
          ],
          WORK_REVIEW: [{ submit: true }],
        },
      });

      // Given a task whose check failed after the first attempt
      const app = await serverFor(fixture);
      await dispatchOnce(app);

      // When the agent is dispatched again into the session it was using
      await runOnce(app);

      // Then its second prompt names the command that failed and how it failed
      const prompts = await promptsTo(pathsOf(app).sessionDir(id, "worker"));
      expect(prompts).toHaveLength(2);
      expect(prompts[1]).toContain("`test -f fixed.txt` (exit 1)");

      await app.server.shutdown();
    },
    30000,
  );

  testInTempDirs(
    "a session opened under an older role directory is reopened where it lies",
    async () => {
      const fixture = await makeFixture();
      const id = await readyTask(fixture, "Do a thing", ["test -f fixed.txt"]);
      await setPlan(fixture, {
        [id]: {
          WORK: [
            {
              submit: true,
              notes: "did the work",
              commit: { path: "a.txt", contents: "a" },
            },
            { busy_ms: 2000 },
          ],
        },
      });

      // Given a task whose session was opened where an older server put it
      const app = await serverFor(fixture);
      await dispatchOnce(app);
      const opened = await sessionOf(app, id);
      const legacyDir = path.join(pathsOf(app).taskRoot(id), "session", "work");
      const legacy = path.join(legacyDir, path.basename(opened));
      await fs.mkdir(legacyDir, { recursive: true });
      await fs.rename(opened, legacy);
      const taskFile = activeTaskPath(fixture.tasksDir, id);
      await fs.writeFile(
        taskFile,
        (await fs.readFile(taskFile, "utf-8")).replace(opened, legacy),
      );

      // Given a server with its scheduler enabled
      await app.dispatcher.setEnabled(true);

      // When the agent is dispatched again
      await app.server.tick();

      // Then the session is reopened where the document says it lies
      expect(await stateOf(app, id)).toBe("WORK");
      const view = await readView(fixture.runtime);
      expect(at(view.slots, 0).state).toBe("BUSY");
      expect(at(view.slots, 0).session).toBe(legacy);
      expect((await workspaceOf(app, id)).session).toBe(legacy);

      await app.server.shutdown();
    },
    30000,
  );
});

describe("Feature: landing or abandoning finished work", () => {
  testInTempDirs(
    "merged tears the worktree and the branch down",
    async () => {
      const fixture = await makeFixture();
      const id = await readyTask(fixture, "A task");
      await setPlan(fixture, {
        [id]: {
          WORK: [
            {
              submit: true,
              notes: "did the work",
              commit: { path: "a.txt", contents: "a" },
            },
          ],
          WORK_REVIEW: [{ submit: true }],
        },
      });

      // Given work that has been reviewed and is waiting on the manager
      const app = await serverFor(fixture);
      await app.dispatcher.setEnabled(true);
      await reaches(app, id, "MANAGER_REVIEW");
      await app.dispatcher.setEnabled(false);

      // When the manager merges it
      const result = await app.lander.merge(id);

      // Then the task closes, the work is on the base, and nothing is left over
      expect(result.to).toBe("CLOSED");
      expect(await fs.exists(pathsOf(app).worktree(id))).toBe(false);
      expect(await git.branchExists(fixture.repo, branchName(id))).toBe(false);
      expect(await fs.exists(path.join(fixture.repo, "a.txt"))).toBe(true);
    },
    30000,
  );

  async function atManagerReview(): Promise<{
    fixture: Fixture;
    app: App;
    id: string;
  }> {
    const fixture = await makeFixture();
    const id = await readyTask(fixture, "A task");
    await setPlan(fixture, {
      [id]: {
        WORK: [
          {
            submit: true,
            notes: "did the work",
            commit: { path: "a.txt", contents: "a" },
          },
        ],
        WORK_REVIEW: [{ submit: true }],
      },
    });

    const app = await serverFor(fixture);
    await app.dispatcher.setEnabled(true);
    await reaches(app, id, "MANAGER_REVIEW");
    await app.dispatcher.setEnabled(false);

    return { fixture, app, id };
  }

  testInTempDirs(
    "abort takes a branch that never landed, and tears it down at CLOSED",
    async () => {
      // Given work that has been reviewed and is waiting on the manager
      const { fixture, app, id } = await atManagerReview();

      // When the manager aborts it
      const result = await app.lander.abort(id);

      // Then it closes, and the work it did is thrown away with the branch
      expect(result.to).toBe("CLOSED");
      expect(await fs.exists(path.join(fixture.repo, "a.txt"))).toBe(false);
      expect(await git.branchExists(fixture.repo, branchName(id))).toBe(false);
      expect(await fs.exists(pathsOf(app).worktree(id))).toBe(false);
    },
    30000,
  );

  testInTempDirs(
    "abort takes a task still queued in WORK, via HELD_WORK",
    async () => {
      // Given a task held before any agent ever started it
      const fixture = await makeFixture();
      const id = await readyTask(fixture, "A task nobody should start");
      const app = await serverFor(fixture);
      await app.graph.transition(
        id,
        "hold",
        { reason: "abandoning" },
        "manager",
      );

      // When the manager aborts it
      const result = await app.lander.abort(id);

      // Then it closes, having left no branch behind at all
      expect(result.to).toBe("CLOSED");
      expect(await git.branchExists(fixture.repo, branchName(id))).toBe(false);
    },
    30000,
  );

  testInTempDirs(
    "abort refuses a task an agent is already working on",
    async () => {
      const fixture = await makeFixture();
      const id = await readyTask(fixture, "A task in flight");
      await takeClaim(fixture.tasksDir, id, {
        slotName: "pi-fake-fake-1",
        pid: process.pid,
        branch: branchName(id),
        worktree: "/tmp/gone",
      });

      // Given a task an agent is holding and working on
      const app = await serverFor(fixture);
      expect(await stateOf(app, id)).toBe("WORK");

      // When the manager aborts it
      const attempt = app.lander.abort(id);

      // Then it is refused, naming where a task must be to be abandoned
      await expect(attempt).rejects.toThrow(
        /is not in MANAGER_REVIEW or HELD_DESIGN or HELD_PLAN or HELD_WORK/,
      );
      expect(await stateOf(app, id)).toBe("WORK");
    },
    30000,
  );

  testInTempDirs(
    "closing a task deletes its runtime directory",
    async () => {
      const fixture = await makeFixture();
      const id = await readyTask(fixture, "A task");
      await setPlan(fixture, {
        [id]: {
          WORK: [
            {
              submit: true,
              notes: "did the work",
              commit: { path: "a.txt", contents: "a" },
            },
          ],
          WORK_REVIEW: [{ submit: true }],
        },
      });

      // Given work that has been reviewed and is waiting on the manager
      const app = await serverFor(fixture);
      await app.dispatcher.setEnabled(true);
      await reaches(app, id, "MANAGER_REVIEW");
      await app.dispatcher.setEnabled(false);
      expect(await fs.exists(pathsOf(app).taskRoot(id))).toBe(true);

      // When the manager merges it
      await app.lander.merge(id);

      // Then the runtime directory it worked in is removed with it
      expect(await stateOf(app, id)).toBe("CLOSED");
      expect(await fs.exists(pathsOf(app).taskRoot(id))).toBe(false);

      for (let i = 0; i < 101; i++) {
        const other = await readyTask(fixture, `filler ${i}`);
        await app.graph.claim(other, { slotName: "filler", pid: process.pid });
      }
      await app.reports.write();

      // Then it stays gone once it falls off the end of the recent list
      expect(await fs.exists(pathsOf(app).taskRoot(id))).toBe(false);
      const view = await readView(fixture.runtime);
      expect(view.tasks.some((task) => task.id === id)).toBe(false);
    },
    60000,
  );
});
