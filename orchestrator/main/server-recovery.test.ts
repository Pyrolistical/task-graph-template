import { describe, expect } from "bun:test";
import { testInTempDirs } from "../testing/temp-dirs.ts";
import fs from "node:fs/promises";
import path from "node:path";
import { takeClaim } from "../adapters/task-documents.ts";
import { branchName } from "../domain/workspace.ts";
import { activeTaskPath, graphLock, lockPath } from "../adapters/task-store.ts";
import * as git from "../adapters/git.ts";
import {
  type Fixture,
  makeFixture,
  readyTask,
  setPlan,
  steersTo,
  unplannedTask,
} from "../testing/fixture.ts";
import type { App } from "../main/compose.ts";
import {
  claimed,
  editTaskFile,
  transitionsOf,
  pathsOf,
  promptsOf,
  reaches,
  serverFor,
  settleTo,
  settleUntil,
  stateOf,
  unclaimed,
  until,
  walkTo,
  taskOf,
} from "../testing/server-jig.ts";
import { at } from "../testing/present.ts";

describe("Feature: picking a project back up at startup", () => {
  testInTempDirs(
    "a graph another server holds keeps a new server out",
    async () => {
      // Given a task graph a live server elsewhere already holds
      const fixture = await makeFixture();
      await fs.writeFile(lockPath(fixture.tasksDir), `${process.pid}`);

      // When a server starts against that graph
      const attempt = async () => await serverFor(fixture);

      // Then it is refused, and leaves no runtime lock behind to wedge a retry
      await expect(attempt()).rejects.toThrow(/already in use by server/);
      expect(await fixture.runtime.lockHolder()).toBeUndefined();
    },
    30000,
  );
  testInTempDirs(
    "a server gives the graph back when it shuts down",
    async () => {
      // Given a running server holding the graph it writes
      const fixture = await makeFixture();
      const app = await serverFor(fixture);
      expect(await graphLock(fixture.tasksDir).holder()).toBe(process.pid);

      // When the server shuts down
      await app.server.shutdown();

      // Then the graph is free again for the next server to take
      expect(await graphLock(fixture.tasksDir).holder()).toBeUndefined();
    },
    30000,
  );
  testInTempDirs(
    "a worktree lost to a cleared /tmp is recreated from its branch",
    async () => {
      const fixture = await makeFixture();
      const id = await readyTask(fixture, "Do a thing");
      await setPlan(fixture, { [id]: { WORK: [{ notes: "working" }] } });

      // Given a task whose worktree was cloned and then removed from disk
      const first = await serverFor(fixture);
      await first.dispatcher.setEnabled(true);
      await first.server.tick();
      await first.server.drain();
      await first.server.shutdown();
      const worktree = pathsOf(first).worktree(id);
      expect(await fs.exists(worktree)).toBe(true);
      await fs.rm(worktree, { recursive: true, force: true });

      // When a new server starts against the same project
      const second = await serverFor(fixture);

      // Then the worktree is cloned again from the branch that survived
      expect(await fs.exists(worktree)).toBe(true);
      expect(await fs.exists(path.join(worktree, ".git"))).toBe(true);

      await second.server.shutdown();
    },
    30000,
  );

  testInTempDirs(
    "a second server against a live one refuses to start",
    async () => {
      const fixture = await makeFixture();

      // Given a server already running against a project
      const first = await serverFor(fixture);

      // When another server starts against the same project
      const attempt = serverFor(fixture);

      // Then it refuses, naming the server that holds the runtime directory
      await expect(attempt).rejects.toThrow(
        `already in use by server ${process.pid}`,
      );

      await first.server.shutdown();
    },
    30000,
  );

  testInTempDirs(
    "a second server continues the transition log rather than restarting it",
    async () => {
      const fixture = await makeFixture();
      const id = await readyTask(fixture, "Do a thing");

      // Given a server that has applied a transition and then exited
      const first = await serverFor(fixture);
      await first.graph.transition(
        id,
        "hold",
        { reason: "waiting on a person" },
        "test",
      );
      const cursor = (await transitionsOf(first)).cursor;
      await first.server.shutdown();

      // When a new server starts against the same project
      const second = await serverFor(fixture);

      // Then it carries on the sequence, so the manager's cursor still means something
      expect((await transitionsOf(second)).cursor).toBe(cursor);

      await second.server.shutdown();
    },
    30000,
  );
});

describe("Feature: reaping a claim whose agent is gone", () => {
  testInTempDirs(
    "a claim whose process is gone is cleared",
    async () => {
      const fixture = await makeFixture();
      const id = await readyTask(fixture, "A task");

      const dead = Bun.spawn(["true"]);
      await dead.exited;

      await takeClaim(fixture.tasksDir, id, {
        slotName: "pi-fake-fake-1",
        pid: dead.pid,
        branch: branchName(id),
        worktree: "/tmp/gone",
      });

      // Given a task claimed by an agent whose process has since exited
      const app = await serverFor(fixture);
      expect(await stateOf(app, id)).toBe("WORK");

      // When the server ticks over the graph
      await app.server.tick();

      // Then the claim is dropped, the stage is kept and the workspace survives
      expect(await stateOf(app, id)).toBe("WORK");
      expect((await taskOf(app, id)).claimed_by).toBeUndefined();
      expect((await taskOf(app, id)).workspace).not.toBeUndefined();

      await app.server.shutdown();
    },
    30000,
  );

  testInTempDirs(
    "an agent that dies mid-task frees its slot and releases the task",
    async () => {
      const fixture = await makeFixture();
      const id = await readyTask(fixture, "A task the agent dies on");
      await setPlan(fixture, { [id]: { WORK: [{ die: true }] } });

      // Given a task dispatched to an agent that will exit without settling
      const app = await serverFor(fixture);
      await app.dispatcher.setEnabled(true);
      await claimed(app, id);

      // Given a server with its scheduler stopped, so the reaper must find it
      await app.dispatcher.setEnabled(false);

      // When the agent dies and the server ticks on
      await unclaimed(app, id);

      // Then the slot is idle and the task is back in the queue where it stood
      const row = at(app.pool.rows(), 0);
      expect(row.state).toBe("IDLE");
      expect(row.task_id).toBeUndefined();
      expect((await taskOf(app, id)).claimed_by).toBeUndefined();

      await app.server.shutdown();
    },
    30000,
  );

  testInTempDirs(
    "a slot whose process died no longer shields the task from the reaper",
    async () => {
      const fixture = await makeFixture();
      const id = await readyTask(fixture, "A task the agent dies on");
      await setPlan(fixture, { [id]: { WORK: [{ die: true }] } });

      // Given a task dispatched to an agent that will exit without settling
      const app = await serverFor(fixture);
      await app.dispatcher.setEnabled(true);
      await claimed(app, id);
      await app.dispatcher.setEnabled(false);

      // When the reaper runs over the graph
      await unclaimed(app, id);

      // Then the dead slot does not shield the task, and is released with it
      expect(at(app.pool.rows(), 0).state).toBe("IDLE");

      await app.server.shutdown();
    },
    30000,
  );

  testInTempDirs(
    "a check running for a merge is left alone by the reaper",
    async () => {
      const fixture = await makeFixture();
      const id = await readyTask(fixture, "A task being merged", ["true"]);
      await setPlan(fixture, {
        [id]: {
          WORK: [
            {
              submit: true,
              notes: "did the work",
              commit: { path: "a.txt", contents: "a\n" },
            },
          ],
          WORK_REVIEW: [{ submit: true }],
        },
      });

      const app = await serverFor(fixture);
      await app.dispatcher.setEnabled(true);
      await reaches(app, id, "MANAGER_REVIEW");
      await app.dispatcher.setEnabled(false);

      // Given a merge whose re-run checks are still going
      await editTaskFile(fixture, id, (meta) => {
        meta.checks.push("sleep 2");
      });
      expect(await stateOf(app, id)).toBe("MANAGER_REVIEW");
      const merging = app.lander.merge(id);
      await until(app, () => app.checker.isRunning(id), 60);

      // When the server ticks while the check is running
      await app.server.tick();

      // Then the task is left where it is, and the merge runs to completion
      expect(await stateOf(app, id)).toBe("MANAGER_REVIEW");
      expect((await merging).to).toBe("CLOSED");

      await app.server.shutdown();
    },
    30000,
  );

  testInTempDirs(
    "a live claim is left alone",
    async () => {
      const fixture = await makeFixture();
      const id = await readyTask(fixture, "A task");
      await takeClaim(fixture.tasksDir, id, {
        slotName: "pi-fake-fake-1",
        pid: process.pid,
      });

      // Given a task claimed by a process that is still running
      const app = await serverFor(fixture);

      // When the server ticks over the graph
      await app.server.tick();

      // Then the claim is left alone, because the agent is still working
      expect(await stateOf(app, id)).toBe("WORK");

      await app.server.shutdown();
    },
    30000,
  );
});

describe("Feature: an abort that races a dispatch", () => {
  async function abortable(app: App, id: string): Promise<void> {
    await app.graph.transition(id, "hold", { reason: "abandoning" }, "manager");
    await app.lander.abort(id);
  }

  testInTempDirs(
    "a task aborted while its agent is spawning is closed and never claimed",
    async () => {
      const fixture = await makeFixture();
      const id = await readyTask(fixture, "A task the manager throws away");
      await setPlan(fixture, {
        [id]: { WORK: [{ new_session_delay_ms: 500, submit: true }] },
      });

      // Given a dispatch that is part way through opening its session
      const app = await serverFor(fixture);
      await app.dispatcher.setEnabled(true);
      const ticking = app.server.tick();
      await Bun.sleep(150);
      expect(await stateOf(app, id)).toBe("WORK");

      // When the manager holds and aborts the task before the claim lands
      await abortable(app, id);

      // Then the task is closed, and the dispatch never claimed it
      await ticking;
      await app.server.drain();
      expect(await stateOf(app, id)).toBe("CLOSED");
      expect((await app.graph.list()).get(id)).toBeUndefined();
      expect(at(app.pool.rows(), 0).state).toBe("IDLE");

      await app.server.shutdown();
    },
    30000,
  );

  testInTempDirs(
    "the slot a lost dispatch was using is released, not stranded",
    async () => {
      const fixture = await makeFixture();
      const id = await readyTask(fixture, "A task the manager throws away");
      await setPlan(fixture, {
        [id]: { WORK: [{ new_session_delay_ms: 500, submit: true }] },
      });

      // Given a dispatch that is part way through opening its session
      const app = await serverFor(fixture);
      await app.dispatcher.setEnabled(true);
      const ticking = app.server.tick();
      await Bun.sleep(150);

      // When the manager holds and aborts the task before the claim lands
      await abortable(app, id);

      // Then the slot goes back to idle, and the lost dispatch is logged
      await ticking;
      await app.server.drain();
      const row = at(app.pool.rows(), 0);
      expect(row.state).toBe("IDLE");
      expect(row.task_id).toBeUndefined();
      expect(
        (await fs.readFile(pathsOf(app).serverLog, "utf-8")).includes(
          `dispatch of ${id} to pi-fake-fake-1 failed`,
        ),
      ).toBe(true);

      await app.server.shutdown();
    },
    30000,
  );

  testInTempDirs(
    "a dispatch that wins the race claims the task as normal",
    async () => {
      const fixture = await makeFixture();
      const id = await readyTask(fixture, "A task nobody aborts");
      await setPlan(fixture, {
        [id]: { WORK: [{ new_session_delay_ms: 200, submit: true }] },
      });

      // Given a task the scheduler is about to dispatch
      const app = await serverFor(fixture);
      await app.dispatcher.setEnabled(true);

      // When the dispatch completes before anything aborts it
      await app.server.tick();

      // Then the agent holds the task, and the manager can no longer abort it
      expect(await stateOf(app, id)).toBe("WORK");
      expect((await taskOf(app, id)).claimed_by).toBe("pi-fake-fake-1");
      await expect(app.lander.abort(id)).rejects.toThrow(/not in/);

      await app.server.shutdown();
      await app.server.drain();
    },
    30000,
  );
});

describe("Feature: a task document that does not parse", () => {
  async function corrupt(fixture: Fixture, id: string): Promise<void> {
    const filePath = activeTaskPath(fixture.tasksDir, id);
    await fs.writeFile(
      filePath,
      (await fs.readFile(filePath, "utf-8")).replace(
        /^depends_on: .*$/m,
        "depends_on: null",
      ),
    );
  }

  testInTempDirs(
    "one unreadable task does not stop the others being dispatched",
    async () => {
      const fixture = await makeFixture();
      const broken = await readyTask(fixture, "A task with bad frontmatter");
      const fine = await readyTask(fixture, "A task that is fine", ["true"]);
      await setPlan(fixture, {
        [fine]: {
          WORK: [
            {
              submit: true,
              notes: "did the work",
              commit: { path: "a.txt", contents: "a\n" },
            },
          ],
          WORK_REVIEW: [{ submit: true }],
        },
      });
      await corrupt(fixture, broken);

      // Given a graph with one unreadable task and one good one
      const app = await serverFor(fixture);

      // When the scheduler runs over the graph
      await walkTo(app, fine, "MANAGER_REVIEW");

      // Then the good task is worked to completion and the broken one ignored
      expect((await app.graph.list()).has(broken)).toBe(false);

      await app.server.shutdown();
    },
    30000,
  );

  testInTempDirs(
    "one unreadable task does not stop the reaper",
    async () => {
      const fixture = await makeFixture();
      const broken = await readyTask(fixture, "A task with bad frontmatter");
      const claimed = await readyTask(fixture, "A task whose agent is gone");

      const dead = Bun.spawn(["true"]);
      await dead.exited;

      await takeClaim(fixture.tasksDir, claimed, {
        slotName: "pi-fake-fake-1",
        pid: dead.pid,
        branch: branchName(claimed),
        worktree: "/tmp/gone",
      });
      await corrupt(fixture, broken);

      // Given a graph with one unreadable task and one dead claim
      const app = await serverFor(fixture);
      expect(await stateOf(app, claimed)).toBe("WORK");

      // When the server ticks over the graph
      await app.server.tick();

      // Then the reaper still runs over the tasks it could read
      expect(await stateOf(app, claimed)).toBe("WORK");

      await app.server.shutdown();
    },
    30000,
  );

  testInTempDirs(
    "the file is logged once when it breaks and once when it is repaired",
    async () => {
      const fixture = await makeFixture();
      const broken = await readyTask(fixture, "A task with bad frontmatter");
      const good = await fs.readFile(
        activeTaskPath(fixture.tasksDir, broken),
        "utf-8",
      );
      await corrupt(fixture, broken);

      const app = await serverFor(fixture);
      const logLines = async () =>
        (await fs.readFile(pathsOf(app).serverLog, "utf-8"))
          .split("\n")
          .filter((line) => line.includes(`${broken}.md`));

      // Given a server that has ticked five times over an unreadable task
      for (let i = 0; i < 5; i++) {
        await app.server.tick();
      }
      expect(
        (await logLines()).filter((line) => line.includes("ignoring")),
      ).toHaveLength(1);

      // Given the document is repaired
      await fs.writeFile(activeTaskPath(fixture.tasksDir, broken), good);

      // When the server ticks five times more
      for (let i = 0; i < 5; i++) await app.server.tick();

      // Then the repair is logged once, and the task is back in the graph
      expect(
        (await logLines()).filter((line) => line.includes("parses again")),
      ).toHaveLength(1);
      expect((await app.graph.list()).has(broken)).toBe(true);

      await app.server.shutdown();
    },
    30000,
  );
});

describe("Feature: an agent that compacts mid-turn", () => {
  testInTempDirs(
    "a designer's scribbles are thrown away and the dispatch is steered back",
    async () => {
      const fixture = await makeFixture();
      const id = await unplannedTask(fixture, "Add a greeting");
      await setPlan(fixture, {
        [id]: {
          DESIGN: [
            {
              compact: "overflow",
              busy_ms: 2000,
              write: { path: "stray.txt", contents: "scribble" },
              design: "the design",
              submit: true,
            },
          ],
        },
      });

      // Given a designer that scribbles in its worktree and then compacts
      const app = await serverFor(fixture);

      // When it runs to its submit
      await settleTo(app, id, "DESIGN_REVIEW");

      // Then the worktree is reset and the agent steered back to its assignment
      expect(
        await fs.exists(path.join(pathsOf(app).worktree(id), "stray.txt")),
      ).toBe(false);
      expect(await git.uncommitted(pathsOf(app).worktree(id))).toEqual([]);
      expect(await steersTo(pathsOf(app).sessionDir(id, "designer"))).toEqual([
        promptsOf(app).fragment("DESIGN"),
      ]);
      expect(await fs.readFile(pathsOf(app).serverLog, "utf-8")).toContain(
        "compacted: worktree reset, steered back to the assignment",
      );

      await app.server.shutdown();
    },
    30000,
  );

  testInTempDirs(
    "a worker keeps its worktree and is steered back to the assignment",
    async () => {
      const fixture = await makeFixture();
      const id = await readyTask(fixture, "Do a thing");
      await setPlan(fixture, {
        [id]: {
          WORK: [
            {
              compact: "overflow",
              busy_ms: 2000,
              commit: { path: "a.txt", contents: "a" },
              notes: "did the work",
              submit: true,
            },
          ],
        },
      });

      // Given a worker that commits its work and then compacts
      const app = await serverFor(fixture);

      // When it runs to its submit
      await settleUntil(
        app,
        async () => (await stateOf(app, id)) !== "WORK",
        20,
      );

      // Then its work is kept, and it is only steered back to the assignment
      expect(
        await fs.exists(path.join(pathsOf(app).worktree(id), "a.txt")),
      ).toBe(true);
      expect(await steersTo(pathsOf(app).sessionDir(id, "worker"))).toEqual([
        promptsOf(app).fragment("WORK"),
      ]);
      const log = await fs.readFile(pathsOf(app).serverLog, "utf-8");
      expect(log).toContain("compacted: steered back to the assignment");
      expect(log).not.toContain("worktree reset");

      await app.server.shutdown();
    },
    30000,
  );

  testInTempDirs(
    "a reviewer that compacts right after submitting keeps its result",
    async () => {
      const fixture = await makeFixture();
      const id = await unplannedTask(fixture, "Add a greeting");
      await setPlan(fixture, {
        [id]: {
          DESIGN: [{ design: "the design", submit: true }],
          DESIGN_REVIEW: [
            { submit: true, findings: [], compact_after_result: "overflow" },
          ],
        },
      });

      // Given a reviewer that compacts after it has already called its result
      const app = await serverFor(fixture);

      // When it runs to its submit
      await settleTo(app, id, "PLAN");

      // Then it is left alone to settle, rather than steered off its result
      expect(await steersTo(pathsOf(app).sessionDir(id, "reviewer"))).toEqual(
        [],
      );
      expect(await fs.readFile(pathsOf(app).serverLog, "utf-8")).toContain(
        "compacted after its result: left alone to settle",
      );

      await app.server.shutdown();
    },
    30000,
  );
});

describe("Feature: a dependency that can never be satisfied", () => {
  testInTempDirs(
    "a task that can never unblock is logged once, not every tick",
    async () => {
      const fixture = await makeFixture();
      const first = await readyTask(fixture, "The first half");
      const second = await readyTask(fixture, "The second half");

      await editTaskFile(fixture, first, (meta) => {
        meta.depends_on = [second];
      });
      await editTaskFile(fixture, second, (meta) => {
        meta.depends_on = [first];
      });

      // Given two tasks that depend on each other
      const app = await serverFor(fixture);

      // When the server ticks five times over them
      for (let i = 0; i < 5; i++) await app.server.tick();

      // Then each is reported once, rather than on every tick forever
      const cycles = (await fs.readFile(pathsOf(app).serverLog, "utf-8"))
        .split("\n")
        .filter((line) => line.includes("depends on itself"));

      expect(cycles).toHaveLength(2);
      expect(cycles[0]).toContain(first);
      expect(cycles[1]).toContain(second);

      await app.server.shutdown();
    },
    30000,
  );
});
