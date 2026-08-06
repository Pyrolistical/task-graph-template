import { describe, expect } from "bun:test";
import { testInTempDirs } from "../testing/temp-dirs.ts";
import fs from "node:fs";
import path from "node:path";
import { takeClaim } from "../adapters/claim.ts";
import * as git from "../adapters/git.ts";
import {
  type Fixture,
  makeFixture,
  readyTask,
  setPlan,
  steersTo,
  unplannedTask,
} from "../testing/fixture.ts";
import { Server } from "../app/server.ts";
import {
  claimed,
  editTaskFile,
  reaches,
  serverFor,
  stateOf,
  unclaimed,
  until,
} from "../testing/server-jig.ts";

describe("Feature: picking a project back up at startup", () => {
  testInTempDirs(
    "a worktree lost to a cleared /tmp is recreated from its branch",
    async () => {
      const fixture = makeFixture();
      const id = readyTask(fixture, "Do a thing");
      setPlan(fixture, { [id]: { WORK: [{ notes: "working" }] } });

      // Given a task whose worktree was cloned and then removed from disk
      const first = await serverFor(fixture);
      first.setSchedulerEnabled(true);
      await first.tick();
      await first.drain();
      first.shutdown();
      const worktree = first.runtime.worktree(id);
      expect(fs.existsSync(worktree)).toBe(true);
      fs.rmSync(worktree, { recursive: true, force: true });

      // When a new server starts against the same project
      const second = await serverFor(fixture);

      // Then the worktree is cloned again from the branch that survived
      expect(fs.existsSync(worktree)).toBe(true);
      expect(fs.existsSync(path.join(worktree, ".git"))).toBe(true);

      second.shutdown();
    },
    30000,
  );

  testInTempDirs(
    "a second server continues the transition log rather than restarting it",
    async () => {
      const fixture = makeFixture();
      const id = readyTask(fixture, "Do a thing");

      // Given a server that has applied a transition and then exited
      const first = await serverFor(fixture);
      first.transition(id, "hold", { reason: "waiting on a person" }, "test");
      const cursor = first.transitions.cursor;
      first.shutdown();

      // When a new server starts against the same project
      const second = await serverFor(fixture);

      // Then it carries on the sequence, so the manager's cursor still means something
      expect(second.transitions.cursor).toBe(cursor);

      second.shutdown();
    },
    30000,
  );

  testInTempDirs(
    "a directory that is not a git repository is refused at startup",
    async () => {
      // Given a project directory that is not under version control
      const fixture = makeFixture();
      fs.rmSync(path.join(fixture.repo, ".git"), {
        recursive: true,
        force: true,
      });

      // When a server is started against it
      const attempt = () => serverFor(fixture);

      // Then it refuses at startup rather than on the first dispatch
      expect(attempt).toThrow(/not a git repository/);
    },
    30000,
  );
});

describe("Feature: reaping a claim whose agent is gone", () => {
  testInTempDirs(
    "a claim whose process is gone is cleared",
    async () => {
      const fixture = makeFixture();
      const id = readyTask(fixture, "A task");

      const dead = Bun.spawn(["true"]);
      await dead.exited;

      takeClaim(fixture.tasksDir, id, {
        agentName: "pi-fake-fake-1",
        pid: dead.pid,
        branch: `task/${id}`,
        worktree: "/tmp/gone",
      });

      // Given a task claimed by an agent whose process has since exited
      const server = await serverFor(fixture);
      expect(stateOf(server, id)).toBe("WORK");

      // When the server ticks over the graph
      await server.tick();

      // Then the claim is dropped, the stage is kept and the workspace survives
      expect(stateOf(server, id)).toBe("WORK");
      expect(server.tasks().get(id)!.claimed_by).toBeNull();
      expect(server.tasks().get(id)!.workspace).not.toBeNull();

      server.shutdown();
    },
    30000,
  );

  testInTempDirs(
    "an agent that dies mid-task frees its slot and releases the task",
    async () => {
      const fixture = makeFixture();
      const id = readyTask(fixture, "A task the agent dies on");
      setPlan(fixture, { [id]: { WORK: [{ die: true }] } });

      // Given a task dispatched to an agent that will exit without settling
      const server = await serverFor(fixture);
      server.setSchedulerEnabled(true);
      await claimed(server, id);

      // When the agent dies and the server ticks on
      server.setSchedulerEnabled(false);
      await unclaimed(server, id);

      // Then the slot is idle and the task is back in the queue where it stood
      const row = server.agentRows()[0]!;
      expect(row.state).toBe("IDLE");
      expect(row.task_id).toBeNull();
      expect(server.tasks().get(id)!.claimed_by).toBeNull();

      server.shutdown();
    },
    30000,
  );

  testInTempDirs(
    "a slot whose process died no longer shields the task from the reaper",
    async () => {
      const fixture = makeFixture();
      const id = readyTask(fixture, "A task the agent dies on");
      setPlan(fixture, { [id]: { WORK: [{ die: true }] } });

      // Given a task dispatched to an agent that will exit without settling
      const server = await serverFor(fixture);
      server.setSchedulerEnabled(true);
      await claimed(server, id);
      server.setSchedulerEnabled(false);

      // When the reaper runs over the graph
      await unclaimed(server, id);

      // Then the dead slot does not shield the task, and is released with it
      expect(server.agentRows()[0]!.state).toBe("IDLE");

      server.shutdown();
    },
    30000,
  );

  testInTempDirs(
    "a check running for a merge is left alone by the reaper",
    async () => {
      const fixture = makeFixture();
      const id = readyTask(fixture, "A task being merged", ["true"]);
      setPlan(fixture, {
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

      const server = await serverFor(fixture);
      server.setSchedulerEnabled(true);
      await reaches(server, id, "MANAGER_REVIEW");
      server.setSchedulerEnabled(false);

      // Given a merge whose re-run checks are still going
      editTaskFile(fixture, id, (meta) => {
        meta.checks.push("sleep 2");
      });
      expect(stateOf(server, id)).toBe("MANAGER_REVIEW");
      const merging = server.attemptMerge(id);
      await until(server, () => server.isCheckRunning(id), 20);

      // When the server ticks while the check is running
      await server.tick();

      // Then the task is left where it is, and the merge runs to completion
      expect(stateOf(server, id)).toBe("MANAGER_REVIEW");
      expect((await merging).to).toBe("CLOSED");

      server.shutdown();
    },
    30000,
  );

  testInTempDirs(
    "a live claim is left alone",
    async () => {
      const fixture = makeFixture();
      const id = readyTask(fixture, "A task");
      takeClaim(fixture.tasksDir, id, {
        agentName: "pi-fake-fake-1",
        pid: process.pid,
      });

      // Given a task claimed by a process that is still running
      const server = await serverFor(fixture);

      // When the server ticks over the graph
      await server.tick();

      // Then the claim is left alone, because the agent is still working
      expect(stateOf(server, id)).toBe("WORK");

      server.shutdown();
    },
    30000,
  );
});

describe("Feature: an abort that races a dispatch", () => {
  function abortable(server: Server, id: string): void {
    server.transition(id, "hold", { reason: "abandoning" }, "manager");
    server.attemptAbort(id);
  }

  testInTempDirs(
    "a task aborted while its agent is spawning is closed and never claimed",
    async () => {
      const fixture = makeFixture();
      const id = readyTask(fixture, "A task the manager throws away");
      setPlan(fixture, {
        [id]: { WORK: [{ new_session_delay_ms: 500, submit: true }] },
      });

      // Given a dispatch that is part way through opening its session
      const server = await serverFor(fixture);
      server.setSchedulerEnabled(true);
      const ticking = server.tick();
      await Bun.sleep(150);
      expect(stateOf(server, id)).toBe("WORK");

      // When the manager holds and aborts the task before the claim lands
      abortable(server, id);
      await ticking;
      await server.drain();

      // Then the task is closed, and the dispatch never claimed it
      expect(stateOf(server, id)).toBe("CLOSED");
      expect(server.tasks().get(id)).toBeUndefined();
      expect(server.agentRows()[0]!.state).toBe("IDLE");

      server.shutdown();
    },
    30000,
  );

  testInTempDirs(
    "the slot a lost dispatch was using is released, not stranded",
    async () => {
      const fixture = makeFixture();
      const id = readyTask(fixture, "A task the manager throws away");
      setPlan(fixture, {
        [id]: { WORK: [{ new_session_delay_ms: 500, submit: true }] },
      });

      // Given a dispatch that is part way through opening its session
      const server = await serverFor(fixture);
      server.setSchedulerEnabled(true);
      const ticking = server.tick();
      await Bun.sleep(150);

      // When the manager holds and aborts the task before the claim lands
      abortable(server, id);
      await ticking;
      await server.drain();

      // Then the slot goes back to idle, and the lost dispatch is logged
      const row = server.agentRows()[0]!;
      expect(row.state).toBe("IDLE");
      expect(row.task_id).toBeNull();
      expect(
        fs
          .readFileSync(server.runtime.serverLog, "utf-8")
          .includes(`dispatch of ${id} to pi-fake-fake-1 failed`),
      ).toBe(true);

      server.shutdown();
    },
    30000,
  );

  testInTempDirs(
    "a dispatch that wins the race claims the task as normal",
    async () => {
      const fixture = makeFixture();
      const id = readyTask(fixture, "A task nobody aborts");
      setPlan(fixture, {
        [id]: { WORK: [{ new_session_delay_ms: 200, submit: true }] },
      });

      // Given a task the scheduler is about to dispatch
      const server = await serverFor(fixture);
      server.setSchedulerEnabled(true);

      // When the dispatch completes before anything aborts it
      await server.tick();

      // Then the agent holds the task, and the manager can no longer abort it
      expect(stateOf(server, id)).toBe("WORK");
      expect(server.tasks().get(id)!.claimed_by).toBe("pi-fake-fake-1");
      expect(() => server.attemptAbort(id)).toThrow(/not in/);

      server.shutdown();
      await server.drain();
    },
    30000,
  );
});

describe("Feature: a task document that does not parse", () => {
  function corrupt(fixture: Fixture, id: string): void {
    const filePath = path.join(fixture.tasksDir, `${id}.md`);
    fs.writeFileSync(
      filePath,
      fs
        .readFileSync(filePath, "utf-8")
        .replace(/^depends_on: .*$/m, "depends_on: null"),
    );
  }

  testInTempDirs(
    "one unreadable task does not stop the others being dispatched",
    async () => {
      const fixture = makeFixture();
      const broken = readyTask(fixture, "A task with bad frontmatter");
      const fine = readyTask(fixture, "A task that is fine", ["true"]);
      setPlan(fixture, {
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
      corrupt(fixture, broken);

      // Given a graph with one unreadable task and one good one
      const server = await serverFor(fixture);

      // When the scheduler runs over the graph
      server.setSchedulerEnabled(true);
      await reaches(server, fine, "MANAGER_REVIEW");

      // Then the good task is worked to completion and the broken one ignored
      expect(server.tasks().has(broken)).toBe(false);

      server.shutdown();
    },
    30000,
  );

  testInTempDirs(
    "one unreadable task does not stop the reaper",
    async () => {
      const fixture = makeFixture();
      const broken = readyTask(fixture, "A task with bad frontmatter");
      const claimed = readyTask(fixture, "A task whose agent is gone");

      const dead = Bun.spawn(["true"]);
      await dead.exited;

      takeClaim(fixture.tasksDir, claimed, {
        agentName: "pi-fake-fake-1",
        pid: dead.pid,
        branch: `task/${claimed}`,
        worktree: "/tmp/gone",
      });
      corrupt(fixture, broken);

      // Given a graph with one unreadable task and one dead claim
      const server = await serverFor(fixture);
      expect(stateOf(server, claimed)).toBe("WORK");

      // When the server ticks over the graph
      await server.tick();

      // Then the reaper still runs over the tasks it could read
      expect(stateOf(server, claimed)).toBe("WORK");

      server.shutdown();
    },
    30000,
  );

  testInTempDirs(
    "the file is logged once when it breaks and once when it is repaired",
    async () => {
      const fixture = makeFixture();
      const broken = readyTask(fixture, "A task with bad frontmatter");
      const good = fs.readFileSync(
        path.join(fixture.tasksDir, `${broken}.md`),
        "utf-8",
      );
      corrupt(fixture, broken);

      const server = await serverFor(fixture);
      const logLines = () =>
        fs
          .readFileSync(server.runtime.serverLog, "utf-8")
          .split("\n")
          .filter((line) => line.includes(`${broken}.md`));

      // Given a server that has ticked five times over an unreadable task
      for (let i = 0; i < 5; i++) {
        await server.tick();
      }
      expect(
        logLines().filter((line) => line.includes("ignoring")),
      ).toHaveLength(1);

      // When the document is repaired and the server ticks five times more
      fs.writeFileSync(path.join(fixture.tasksDir, `${broken}.md`), good);
      for (let i = 0; i < 5; i++) {
        await server.tick();
      }

      // Then the repair is logged once, and the task is back in the graph
      expect(
        logLines().filter((line) => line.includes("parses again")),
      ).toHaveLength(1);
      expect(server.tasks().has(broken)).toBe(true);

      server.shutdown();
    },
    30000,
  );
});

describe("Feature: an agent that compacts mid-turn", () => {
  testInTempDirs(
    "a designer's scribbles are thrown away and the dispatch is steered back",
    async () => {
      const fixture = makeFixture();
      const id = unplannedTask(fixture, "Add a greeting");
      setPlan(fixture, {
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
      const server = await serverFor(fixture);

      // When it runs to its submit
      server.setSchedulerEnabled(true);
      await reaches(server, id, "DESIGN_REVIEW");
      server.setSchedulerEnabled(false);
      await server.drain();

      // Then the worktree is reset and the agent steered back to its assignment
      expect(
        fs.existsSync(path.join(server.runtime.worktree(id), "stray.txt")),
      ).toBe(false);
      expect(git.uncommitted(server.runtime.worktree(id))).toEqual([]);
      expect(steersTo(server.runtime.sessionDir(id, "designer"))).toEqual([
        server.prompts.fragment("DESIGN"),
      ]);
      expect(fs.readFileSync(server.runtime.serverLog, "utf-8")).toContain(
        "compacted: worktree reset, steered back to the assignment",
      );

      server.shutdown();
    },
    30000,
  );

  testInTempDirs(
    "a worker keeps its worktree and is steered back to the assignment",
    async () => {
      const fixture = makeFixture();
      const id = readyTask(fixture, "Do a thing");
      setPlan(fixture, {
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
      const server = await serverFor(fixture);

      // When it runs to its submit
      server.setSchedulerEnabled(true);
      await until(server, () => stateOf(server, id) !== "WORK", 20);
      server.setSchedulerEnabled(false);
      await server.drain();

      // Then its work is kept, and it is only steered back to the assignment
      expect(
        fs.existsSync(path.join(server.runtime.worktree(id), "a.txt")),
      ).toBe(true);
      expect(steersTo(server.runtime.sessionDir(id, "worker"))).toEqual([
        server.prompts.fragment("WORK"),
      ]);
      const log = fs.readFileSync(server.runtime.serverLog, "utf-8");
      expect(log).toContain("compacted: steered back to the assignment");
      expect(log).not.toContain("worktree reset");

      server.shutdown();
    },
    30000,
  );

  testInTempDirs(
    "a reviewer that compacts right after submitting keeps its result",
    async () => {
      const fixture = makeFixture();
      const id = unplannedTask(fixture, "Add a greeting");
      setPlan(fixture, {
        [id]: {
          DESIGN: [{ design: "the design", submit: true }],
          DESIGN_REVIEW: [
            { submit: true, findings: [], compact_after_result: "overflow" },
          ],
        },
      });

      // Given a reviewer that compacts after it has already called its result
      const server = await serverFor(fixture);

      // When it runs to its submit
      server.setSchedulerEnabled(true);
      await reaches(server, id, "PLAN");
      server.setSchedulerEnabled(false);
      await server.drain();

      // Then it is left alone to settle, rather than steered off its result
      expect(steersTo(server.runtime.sessionDir(id, "reviewer"))).toEqual([]);
      expect(fs.readFileSync(server.runtime.serverLog, "utf-8")).toContain(
        "compacted after its result: left alone to settle",
      );

      server.shutdown();
    },
    30000,
  );
});

describe("Feature: a dependency that can never be satisfied", () => {
  testInTempDirs(
    "a task that can never unblock is logged once, not every tick",
    async () => {
      const fixture = makeFixture();
      const first = readyTask(fixture, "The first half");
      const second = readyTask(fixture, "The second half");

      editTaskFile(fixture, first, (meta) => {
        meta.depends_on = [second];
      });
      editTaskFile(fixture, second, (meta) => {
        meta.depends_on = [first];
      });

      // Given two tasks that depend on each other
      const server = await serverFor(fixture);

      // When the server ticks five times over them
      for (let i = 0; i < 5; i++) {
        await server.tick();
      }

      // Then each is reported once, rather than on every tick forever
      const cycles = fs
        .readFileSync(server.runtime.serverLog, "utf-8")
        .split("\n")
        .filter((line) => line.includes("depends on itself"));

      expect(cycles).toHaveLength(2);
      expect(cycles[0]).toContain(first);
      expect(cycles[1]).toContain(second);

      server.shutdown();
    },
    30000,
  );
});
