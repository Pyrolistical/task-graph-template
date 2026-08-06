import { describe, expect } from "bun:test";
import { testInTempDirs } from "../testing/temp-dirs.ts";
import fs from "node:fs";
import path from "node:path";
import { takeClaim } from "../adapters/claim.ts";
import * as git from "../adapters/git.ts";
import {
  type Fixture,
  makeFixture,
  promptsTo,
  readyTask,
  setPlan,
} from "../testing/fixture.ts";
import { Server } from "../app/server.ts";
import { reaches, serverFor, stateOf, until } from "../testing/server-jig.ts";

describe("Feature: running a task's checks", () => {
  testInTempDirs(
    "a failing check records the failure and sends the work back",
    async () => {
      const fixture = makeFixture();
      const id = readyTask(fixture, "Do a thing", ["echo boom >&2; exit 3"]);
      setPlan(fixture, {
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
      const server = await serverFor(fixture);

      // When the work is done and the check runs against it
      server.setSchedulerEnabled(true);
      await server.tick();
      server.setSchedulerEnabled(false);
      await server.drain();
      await server.tick();
      await server.drain();

      // Then the task goes back to work with the failure queued for the agent
      const task = server.tasks().get(id)!;
      expect(task.state).toBe("WORK");
      const queued = fs.readFileSync(
        path.join(server.runtime.queueDir(id), "WORK.md"),
        "utf-8",
      );
      expect(queued).toContain("echo boom >&2; exit 3");
      expect(queued).toContain("boom");

      server.shutdown();
    },
    30000,
  );

  testInTempDirs(
    "every failing check is recorded, not only the first",
    async () => {
      const fixture = makeFixture();
      const id = readyTask(fixture, "Do a thing", ["exit 1", "true", "exit 2"]);
      setPlan(fixture, {
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
      const server = await serverFor(fixture);

      // When the work is done and the checks run against it
      server.setSchedulerEnabled(true);
      await server.tick();
      server.setSchedulerEnabled(false);
      await server.drain();
      await server.tick();
      await server.drain();

      // Then the agent is told about both failures, not only the first
      const queued = fs.readFileSync(
        path.join(server.runtime.queueDir(id), "WORK.md"),
        "utf-8",
      );
      expect(queued).toContain("(exit 1)");
      expect(queued).toContain("(exit 2)");

      server.shutdown();
    },
    30000,
  );

  testInTempDirs(
    "a passing check moves the task to the agent review",
    async () => {
      const fixture = makeFixture();
      const id = readyTask(fixture, "Do a thing", ["true", "test -d ."]);
      setPlan(fixture, {
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
      const server = await serverFor(fixture);

      // When the work is done and the checks run against it
      server.setSchedulerEnabled(true);

      // Then the task moves on to the agent review
      await reaches(server, id, "WORK_REVIEW");

      server.shutdown();
    },
    30000,
  );

  testInTempDirs(
    "the whole output of a check is written where a person can read it",
    async () => {
      const fixture = makeFixture();
      const id = readyTask(fixture, "Do a thing", ["echo written-to-the-log"]);
      setPlan(fixture, {
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
      const server = await serverFor(fixture);

      // When the work is done and the check runs against it
      server.setSchedulerEnabled(true);
      await until(server, () => fs.existsSync(server.runtime.checkLog(id, 0)));

      // Then the output is on disk in the task's own directory
      expect(
        fs.readFileSync(server.runtime.checkLog(id, 0), "utf-8"),
      ).toContain("written-to-the-log");

      server.shutdown();
    },
    30000,
  );
});

describe("Feature: sending a task back to the agent that did it", () => {
  testInTempDirs(
    "the same session is reopened, the assignment is untouched and the result is cleared",
    async () => {
      const fixture = makeFixture();
      const id = readyTask(fixture, "Do a thing", ["test -f fixed.txt"]);
      setPlan(fixture, {
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
      const server = await serverFor(fixture);
      server.setSchedulerEnabled(true);
      await server.tick();
      server.setSchedulerEnabled(false);
      await server.drain();
      await server.tick();
      await server.drain();
      const afterFailure = server.tasks().get(id)!;
      expect(afterFailure.state).toBe("WORK");
      expect(afterFailure.workspace!.session).not.toBeNull();

      // When the agent is dispatched again and finishes the work
      server.setSchedulerEnabled(true);
      await reaches(server, id, "MANAGER_REVIEW");
      server.setSchedulerEnabled(false);

      // Then the assignment was never rotated, because the session was resumed
      const history = fs.readdirSync(server.runtime.history(id));
      expect(history).toHaveLength(0);

      // Then the check failed exactly once, so the second attempt passed
      const failures = server.transitions
        .read()
        .filter((e) => e.transition === "fail" && e.to === "WORK");
      expect(failures).toHaveLength(1);

      server.shutdown();
    },
    30000,
  );

  testInTempDirs(
    "the resume prompt carries every failing command into the session",
    async () => {
      const fixture = makeFixture();
      const id = readyTask(fixture, "Do a thing", ["test -f fixed.txt"]);
      setPlan(fixture, {
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
      const server = await serverFor(fixture);
      server.setSchedulerEnabled(true);
      await server.tick();
      server.setSchedulerEnabled(false);
      await server.drain();
      await server.tick();
      await server.drain();

      // When the agent is dispatched again into the session it was using
      server.setSchedulerEnabled(true);
      await server.tick();
      server.setSchedulerEnabled(false);
      await server.drain();

      // Then its second prompt names the command that failed and how it failed
      const prompts = promptsTo(server.runtime.sessionDir(id, "worker"));
      expect(prompts).toHaveLength(2);
      expect(prompts[1]).toContain("`test -f fixed.txt` (exit 1)");

      server.shutdown();
    },
    30000,
  );

  testInTempDirs(
    "a session opened under an older role directory is reopened where it lies",
    async () => {
      const fixture = makeFixture();
      const id = readyTask(fixture, "Do a thing", ["test -f fixed.txt"]);
      setPlan(fixture, {
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
      const server = await serverFor(fixture);
      server.setSchedulerEnabled(true);
      await server.tick();
      server.setSchedulerEnabled(false);
      await server.drain();
      await server.tick();
      await server.drain();
      const opened = server.tasks().get(id)!.workspace!.session!;
      const legacyDir = path.join(
        server.runtime.taskDir(id),
        "session",
        "work",
      );
      const legacy = path.join(legacyDir, path.basename(opened));
      fs.mkdirSync(legacyDir, { recursive: true });
      fs.renameSync(opened, legacy);
      const taskFile = path.join(fixture.tasksDir, `${id}.md`);
      fs.writeFileSync(
        taskFile,
        fs.readFileSync(taskFile, "utf-8").replace(opened, legacy),
      );

      // When the agent is dispatched again
      server.setSchedulerEnabled(true);
      await server.tick();
      server.setSchedulerEnabled(false);

      // Then the session is reopened where the document says it lies
      expect(stateOf(server, id)).toBe("WORK");
      const view = JSON.parse(
        fs.readFileSync(server.runtime.agentsView, "utf-8"),
      );
      expect(view.agents[0].state).toBe("BUSY");
      expect(view.agents[0].session).toBe(legacy);
      expect(server.tasks().get(id)!.workspace!.session).toBe(legacy);

      server.shutdown();
    },
    30000,
  );
});

describe("Feature: landing or abandoning finished work", () => {
  testInTempDirs(
    "merged tears the worktree and the branch down",
    async () => {
      const fixture = makeFixture();
      const id = readyTask(fixture, "A task");
      setPlan(fixture, {
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
      const server = await serverFor(fixture);
      server.setSchedulerEnabled(true);
      await reaches(server, id, "MANAGER_REVIEW");
      server.setSchedulerEnabled(false);

      // When the manager merges it
      const result = await server.attemptMerge(id);

      // Then the task closes, the work is on the base, and nothing is left over
      expect(result.to).toBe("CLOSED");
      expect(fs.existsSync(server.runtime.worktree(id))).toBe(false);
      expect(git.branchExists(fixture.repo, `task/${id}`)).toBe(false);
      expect(fs.existsSync(path.join(fixture.repo, "a.txt"))).toBe(true);
    },
    30000,
  );

  async function atManagerReview(): Promise<{
    fixture: Fixture;
    server: Server;
    id: string;
  }> {
    const fixture = makeFixture();
    const id = readyTask(fixture, "A task");
    setPlan(fixture, {
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

    const server = await serverFor(fixture);
    server.setSchedulerEnabled(true);
    await reaches(server, id, "MANAGER_REVIEW");
    server.setSchedulerEnabled(false);

    return { fixture, server, id };
  }

  testInTempDirs(
    "abort takes a branch that never landed, and tears it down at CLOSED",
    async () => {
      // Given work that has been reviewed and is waiting on the manager
      const { fixture, server, id } = await atManagerReview();

      // When the manager aborts it
      const result = server.attemptAbort(id);

      // Then it closes, and the work it did is thrown away with the branch
      expect(result.to).toBe("CLOSED");
      expect(fs.existsSync(path.join(fixture.repo, "a.txt"))).toBe(false);
      expect(git.branchExists(fixture.repo, `task/${id}`)).toBe(false);
      expect(fs.existsSync(server.runtime.worktree(id))).toBe(false);
    },
    30000,
  );

  testInTempDirs(
    "abort takes a task still queued in WORK, via HELD_WORK",
    async () => {
      // Given a task held before any agent ever started it
      const fixture = makeFixture();
      const id = readyTask(fixture, "A task nobody should start");
      const server = await serverFor(fixture);
      server.transition(id, "hold", { reason: "abandoning" }, "manager");

      // When the manager aborts it
      const result = server.attemptAbort(id);

      // Then it closes, having left no branch behind at all
      expect(result.to).toBe("CLOSED");
      expect(git.branchExists(fixture.repo, `task/${id}`)).toBe(false);
    },
    30000,
  );

  testInTempDirs(
    "abort refuses a task an agent is already working on",
    async () => {
      const fixture = makeFixture();
      const id = readyTask(fixture, "A task in flight");
      takeClaim(fixture.tasksDir, id, {
        agentName: "pi-fake-fake-1",
        pid: process.pid,
        branch: `task/${id}`,
        worktree: "/tmp/gone",
      });

      // Given a task an agent is holding and working on
      const server = await serverFor(fixture);
      expect(stateOf(server, id)).toBe("WORK");

      // When the manager aborts it
      const attempt = () => server.attemptAbort(id);

      // Then it is refused, naming where a task must be to be abandoned
      expect(attempt).toThrow(
        /is not in MANAGER_REVIEW or HELD_DESIGN or HELD_PLAN or HELD_WORK/,
      );
      expect(stateOf(server, id)).toBe("WORK");
    },
    30000,
  );

  testInTempDirs(
    "abort refuses a branch that already landed",
    async () => {
      // Given work whose branch has already been merged into the base
      const { fixture, server, id } = await atManagerReview();
      git.gitOrThrow(fixture.repo, ["merge", "--ff-only", `task/${id}`]);

      // When the manager aborts it
      const attempt = () => server.attemptAbort(id);

      // Then it is refused, because there is no longer work to throw away
      expect(attempt).toThrow(/already part of master/);
      expect(stateOf(server, id)).toBe("MANAGER_REVIEW");
    },
    30000,
  );

  testInTempDirs(
    "closing a task deletes its runtime directory",
    async () => {
      const fixture = makeFixture();
      const id = readyTask(fixture, "A task");
      setPlan(fixture, {
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
      const server = await serverFor(fixture);
      server.setSchedulerEnabled(true);
      await reaches(server, id, "MANAGER_REVIEW");
      server.setSchedulerEnabled(false);
      expect(fs.existsSync(server.runtime.taskDir(id))).toBe(true);

      // When the manager merges it
      await server.attemptMerge(id);

      // Then the runtime directory it worked in is removed with it
      expect(stateOf(server, id)).toBe("CLOSED");
      expect(fs.existsSync(server.runtime.taskDir(id))).toBe(false);

      for (let i = 0; i < 101; i++) {
        const other = readyTask(fixture, `filler ${i}`);
        server.claim(other, { agentName: "filler", pid: process.pid });
      }
      await server.writeViews();

      // Then it stays gone once it falls off the end of the recent list
      expect(fs.existsSync(server.runtime.taskDir(id))).toBe(false);
      const view = JSON.parse(
        fs.readFileSync(server.runtime.tasksView, "utf-8"),
      );
      expect(view.tasks.some((t: { id: string }) => t.id === id)).toBe(false);
    },
    60000,
  );
});
