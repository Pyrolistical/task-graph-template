import { describe, expect } from "bun:test";
import { test } from "./temp.ts";
import fs from "node:fs";
import path from "node:path";
import { applyTransition } from "./transition.ts";
import { takeClaim } from "./claim.ts";
import * as git from "./git.ts";
import {
  type Fixture,
  makeFixture,
  promptsTo,
  readyTask,
  setPlan,
} from "./fixture.ts";
import { Server } from "./server.ts";
import { reaches, serverFor, stateOf, until } from "./server-jig.ts";

describe("the server: checks", () => {
  test("a failing check records the failure and sends the work back", async () => {
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

    const server = await serverFor(fixture);
    server.setSchedulerEnabled(true);
    await server.tick();
    server.setSchedulerEnabled(false);
    await server.drain();
    await server.tick();
    await server.drain();

    const task = server.tasks().get(id)!;
    expect(task.state).toBe("WORK");
    const queued = fs.readFileSync(
      path.join(server.runtime.queueDir(id), "WORK.md"),
      "utf-8",
    );
    expect(queued).toContain("echo boom >&2; exit 3");
    expect(queued).toContain("boom");

    server.shutdown();
  }, 30000);

  test("every failing check is recorded, not only the first", async () => {
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

    const server = await serverFor(fixture);
    server.setSchedulerEnabled(true);
    await server.tick();
    server.setSchedulerEnabled(false);
    await server.drain();
    await server.tick();
    await server.drain();

    const queued = fs.readFileSync(
      path.join(server.runtime.queueDir(id), "WORK.md"),
      "utf-8",
    );
    expect(queued).toContain("(exit 1)");
    expect(queued).toContain("(exit 2)");

    server.shutdown();
  }, 30000);

  test("a passing check moves the task to the agent review", async () => {
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

    const server = await serverFor(fixture);
    server.setSchedulerEnabled(true);
    await reaches(server, id, "WORK_REVIEW");

    server.shutdown();
  }, 30000);

  test("the check log holds the output of the command", async () => {
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

    const server = await serverFor(fixture);
    server.setSchedulerEnabled(true);
    await until(server, () => fs.existsSync(server.runtime.checkLog(id, 0)));

    expect(fs.readFileSync(server.runtime.checkLog(id, 0), "utf-8")).toContain(
      "written-to-the-log",
    );

    server.shutdown();
  }, 30000);
});

describe("the server: resuming a failed check", () => {
  test("the same session is reopened, the assignment is untouched and the result is cleared", async () => {
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

    server.setSchedulerEnabled(true);
    await reaches(server, id, "MANAGER_REVIEW");
    server.setSchedulerEnabled(false);

    const history = fs.readdirSync(server.runtime.history(id));
    expect(history).toHaveLength(0);

    const failures = server.transitions
      .read()
      .filter((e) => e.transition === "fail" && e.to === "WORK");
    expect(failures).toHaveLength(1);

    server.shutdown();
  }, 30000);

  test("the resume prompt carries every failing command into the session", async () => {
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

    const server = await serverFor(fixture);
    server.setSchedulerEnabled(true);
    await server.tick();
    server.setSchedulerEnabled(false);
    await server.drain();
    await server.tick();
    await server.drain();
    server.setSchedulerEnabled(true);
    await server.tick();
    server.setSchedulerEnabled(false);
    await server.drain();

    const prompts = promptsTo(server.runtime.sessionDir(id, "worker"));
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain("`test -f fixed.txt` (exit 1)");

    server.shutdown();
  }, 30000);

  test("a session opened under an older role directory is reopened where it lies", async () => {
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

    const server = await serverFor(fixture);
    server.setSchedulerEnabled(true);
    await server.tick();
    server.setSchedulerEnabled(false);
    await server.drain();
    await server.tick();
    await server.drain();

    const opened = server.tasks().get(id)!.workspace!.session!;
    const legacyDir = path.join(server.runtime.taskDir(id), "session", "work");
    const legacy = path.join(legacyDir, path.basename(opened));
    fs.mkdirSync(legacyDir, { recursive: true });
    fs.renameSync(opened, legacy);
    const taskFile = path.join(fixture.tasksDir, `${id}.md`);
    fs.writeFileSync(
      taskFile,
      fs.readFileSync(taskFile, "utf-8").replace(opened, legacy),
    );

    server.setSchedulerEnabled(true);
    await server.tick();
    server.setSchedulerEnabled(false);

    expect(stateOf(server, id)).toBe("WORK");
    const view = JSON.parse(
      fs.readFileSync(server.runtime.agentsView, "utf-8"),
    );
    expect(view.agents[0].state).toBe("BUSY");
    expect(view.agents[0].session).toBe(legacy);
    expect(server.tasks().get(id)!.workspace!.session).toBe(legacy);

    server.shutdown();
  }, 30000);
});

describe("the server: closing", () => {
  test("merged tears the worktree and the branch down", async () => {
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

    expect((await server.attemptMerge(id)).to).toBe("CLOSED");

    expect(fs.existsSync(server.runtime.worktree(id))).toBe(false);
    expect(git.branchExists(fixture.repo, `task/${id}`)).toBe(false);
    expect(fs.existsSync(path.join(fixture.repo, "a.txt"))).toBe(true);
  }, 30000);

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

  test("abort takes a branch that never landed, and tears it down at CLOSED", async () => {
    const { fixture, server, id } = await atManagerReview();

    expect(server.attemptAbort(id).to).toBe("CLOSED");
    expect(fs.existsSync(path.join(fixture.repo, "a.txt"))).toBe(false);
    expect(git.branchExists(fixture.repo, `task/${id}`)).toBe(false);
    expect(fs.existsSync(server.runtime.worktree(id))).toBe(false);
  }, 30000);

  test("abort takes a task still queued in WORK, via HELD_WORK", async () => {
    const fixture = makeFixture();
    const id = readyTask(fixture, "A task nobody should start");
    const server = await serverFor(fixture);
    server.transition(id, "hold", { reason: "abandoning" }, "manager");

    expect(server.attemptAbort(id).to).toBe("CLOSED");
    expect(git.branchExists(fixture.repo, `task/${id}`)).toBe(false);
  }, 30000);

  test("abort refuses a task an agent is already working on", async () => {
    const fixture = makeFixture();
    const id = readyTask(fixture, "A task in flight");
    takeClaim(fixture.tasksDir, id, {
      agentName: "pi-fake-fake-1",
      pid: process.pid,
      branch: `task/${id}`,
      worktree: "/tmp/gone",
    });

    const server = await serverFor(fixture);
    expect(stateOf(server, id)).toBe("WORK");

    expect(() => server.attemptAbort(id)).toThrow(
      /is not in MANAGER_REVIEW or HELD_DESIGN or HELD_PLAN or HELD_WORK/,
    );
    expect(stateOf(server, id)).toBe("WORK");
  }, 30000);

  test("abort refuses a branch that already landed", async () => {
    const { fixture, server, id } = await atManagerReview();
    git.gitOrThrow(fixture.repo, ["merge", "--ff-only", `task/${id}`]);

    expect(() => server.attemptAbort(id)).toThrow(/already part of master/);
    expect(stateOf(server, id)).toBe("MANAGER_REVIEW");
  }, 30000);

  test("closing a task deletes its runtime directory", async () => {
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

    expect(fs.existsSync(server.runtime.taskDir(id))).toBe(true);
    await server.attemptMerge(id);
    expect(stateOf(server, id)).toBe("CLOSED");
    expect(fs.existsSync(server.runtime.taskDir(id))).toBe(false);

    for (let i = 0; i < 101; i++) {
      const other = readyTask(fixture, `filler ${i}`);
      server.claim(other, { agentName: "filler", pid: process.pid });
    }
    await server.writeViews();

    expect(fs.existsSync(server.runtime.taskDir(id))).toBe(false);
    const view = JSON.parse(fs.readFileSync(server.runtime.tasksView, "utf-8"));
    expect(view.tasks.some((t: { id: string }) => t.id === id)).toBe(false);
  }, 60000);
});
