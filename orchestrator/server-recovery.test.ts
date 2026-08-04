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
  readyTask,
  setPlan,
  steersTo,
  unplannedTask,
} from "./fixture.ts";
import { Server } from "./server.ts";
import {
  claimed,
  editTaskFile,
  reaches,
  serverFor,
  stateOf,
  unclaimed,
  until,
} from "./server-jig.ts";

describe("the server: startup recovery", () => {
  test("a worktree lost to a cleared /tmp is recreated from its branch", async () => {
    const fixture = makeFixture();
    const id = readyTask(fixture, "Do a thing");
    setPlan(fixture, { [id]: { WORK: [{ notes: "working" }] } });

    const first = await serverFor(fixture);
    first.setSchedulerEnabled(true);
    await first.tick();
    await first.drain();
    first.shutdown();

    const worktree = first.runtime.worktree(id);
    expect(fs.existsSync(worktree)).toBe(true);
    fs.rmSync(worktree, { recursive: true, force: true });

    const second = await serverFor(fixture);
    expect(fs.existsSync(worktree)).toBe(true);
    expect(fs.existsSync(path.join(worktree, ".git"))).toBe(true);

    second.shutdown();
  }, 30000);

  test("a second server continues the transition log rather than restarting it", async () => {
    const fixture = makeFixture();
    const id = readyTask(fixture, "Do a thing");

    const first = await serverFor(fixture);
    first.transition(id, "hold", { reason: "waiting on a person" }, "test");
    const cursor = first.transitions.cursor;
    first.shutdown();

    const second = await serverFor(fixture);
    expect(second.transitions.cursor).toBe(cursor);

    second.shutdown();
  }, 30000);

  test("a directory that is not a git repository is refused at startup", async () => {
    const fixture = makeFixture();
    fs.rmSync(path.join(fixture.repo, ".git"), {
      recursive: true,
      force: true,
    });

    expect(serverFor(fixture)).rejects.toThrow(/not a git repository/);
  }, 30000);
});

describe("the server: the reaper", () => {
  test("a claim whose process is gone is cleared", async () => {
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

    const server = await serverFor(fixture);
    expect(stateOf(server, id)).toBe("WORK");

    await server.tick();

    expect(stateOf(server, id)).toBe("WORK");
    expect(server.tasks().get(id)!.claimed_by).toBeNull();
    expect(server.tasks().get(id)!.workspace).not.toBeNull();

    server.shutdown();
  }, 30000);

  test("an agent that dies mid-task frees its slot and releases the task", async () => {
    const fixture = makeFixture();
    const id = readyTask(fixture, "A task the agent dies on");
    setPlan(fixture, { [id]: { WORK: [{ die: true }] } });

    const server = await serverFor(fixture);
    server.setSchedulerEnabled(true);

    await claimed(server, id);
    server.setSchedulerEnabled(false);
    await unclaimed(server, id);

    const row = server.agentRows()[0]!;
    expect(row.state).toBe("IDLE");
    expect(row.task_id).toBeNull();
    expect(server.tasks().get(id)!.claimed_by).toBeNull();

    server.shutdown();
  }, 30000);

  test("a worker still holding a dead process does not shield its task", async () => {
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

    const server = await serverFor(fixture);
    const worker = (
      server as unknown as {
        workers: Map<string, Record<string, unknown>>;
      }
    ).workers.get("pi-fake-fake-1")!;

    worker.task_id = id;
    worker.state = "BUSY";
    worker.process = {
      alive: false,
      pid: dead.pid,
      close: () => {},
      kill: () => {},
      abort: () => {},
      stream: { state: { activity: { kind: "none" } } },
    };

    await server.tick();

    expect(stateOf(server, id)).toBe("WORK");
    expect(server.agentRows()[0]!.state).toBe("IDLE");

    server.shutdown();
  }, 30000);

  test("a slot whose process died no longer shields the task from the reaper", async () => {
    const fixture = makeFixture();
    const id = readyTask(fixture, "A task the agent dies on");
    setPlan(fixture, { [id]: { WORK: [{ die: true }] } });

    const server = await serverFor(fixture);
    server.setSchedulerEnabled(true);

    await claimed(server, id);
    server.setSchedulerEnabled(false);

    await unclaimed(server, id);
    expect(server.agentRows()[0]!.state).toBe("IDLE");

    server.shutdown();
  }, 30000);

  test("a check running for a merge is left alone by the reaper", async () => {
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

    editTaskFile(fixture, id, (meta) => {
      meta.checks.push("sleep 2");
    });
    expect(stateOf(server, id)).toBe("MANAGER_REVIEW");

    const merging = server.attemptMerge(id);
    await until(server, () => server.checks.isRunning(id), 20);

    await server.tick();
    expect(stateOf(server, id)).toBe("MANAGER_REVIEW");

    expect((await merging).to).toBe("CLOSED");

    server.shutdown();
  }, 30000);

  test("a live claim is left alone", async () => {
    const fixture = makeFixture();
    const id = readyTask(fixture, "A task");
    takeClaim(fixture.tasksDir, id, {
      agentName: "pi-fake-fake-1",
      pid: process.pid,
    });

    const server = await serverFor(fixture);
    await server.tick();

    expect(stateOf(server, id)).toBe("WORK");

    server.shutdown();
  }, 30000);
});

describe("the server: an abort that races a dispatch", () => {
  function abortable(server: Server, id: string): void {
    server.transition(id, "hold", { reason: "abandoning" }, "manager");
    server.attemptAbort(id);
  }

  test("a task aborted while its agent is spawning is closed and never claimed", async () => {
    const fixture = makeFixture();
    const id = readyTask(fixture, "A task the manager throws away");
    setPlan(fixture, {
      [id]: { WORK: [{ new_session_delay_ms: 500, submit: true }] },
    });

    const server = await serverFor(fixture);
    server.setSchedulerEnabled(true);

    const ticking = server.tick();
    await Bun.sleep(150);
    expect(stateOf(server, id)).toBe("WORK");

    abortable(server, id);
    expect(stateOf(server, id)).toBe("CLOSED");

    await ticking;
    await server.drain();

    expect(stateOf(server, id)).toBe("CLOSED");
    expect(server.tasks().get(id)).toBeUndefined();
    expect(server.agentRows()[0]!.state).toBe("IDLE");

    server.shutdown();
  }, 30000);

  test("the slot a lost dispatch was using is released, not stranded", async () => {
    const fixture = makeFixture();
    const id = readyTask(fixture, "A task the manager throws away");
    setPlan(fixture, {
      [id]: { WORK: [{ new_session_delay_ms: 500, submit: true }] },
    });

    const server = await serverFor(fixture);
    server.setSchedulerEnabled(true);

    const ticking = server.tick();
    await Bun.sleep(150);
    abortable(server, id);
    await ticking;
    await server.drain();

    const row = server.agentRows()[0]!;
    expect(row.state).toBe("IDLE");
    expect(row.task_id).toBeNull();
    expect(
      fs
        .readFileSync(server.runtime.serverLog, "utf-8")
        .includes(`dispatch of ${id} to pi-fake-fake-1 failed`),
    ).toBe(true);

    server.shutdown();
  }, 30000);

  test("a dispatch that wins the race claims the task as normal", async () => {
    const fixture = makeFixture();
    const id = readyTask(fixture, "A task nobody aborts");
    setPlan(fixture, {
      [id]: { WORK: [{ new_session_delay_ms: 200, submit: true }] },
    });

    const server = await serverFor(fixture);
    server.setSchedulerEnabled(true);

    await server.tick();

    expect(stateOf(server, id)).toBe("WORK");
    expect(server.tasks().get(id)!.claimed_by).toBe("pi-fake-fake-1");
    expect(() => server.attemptAbort(id)).toThrow(/not in/);

    server.shutdown();
    await server.drain();
  }, 30000);
});

describe("the server: a task file that does not parse", () => {
  function corrupt(fixture: Fixture, id: string): void {
    const filePath = path.join(fixture.tasksDir, `${id}.md`);
    fs.writeFileSync(
      filePath,
      fs
        .readFileSync(filePath, "utf-8")
        .replace(/^depends_on: .*$/m, "depends_on: null"),
    );
  }

  test("one unreadable task does not stop the others being dispatched", async () => {
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

    const server = await serverFor(fixture);
    server.setSchedulerEnabled(true);

    await reaches(server, fine, "MANAGER_REVIEW");
    expect(server.tasks().has(broken)).toBe(false);

    server.shutdown();
  }, 30000);

  test("one unreadable task does not stop the reaper", async () => {
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

    const server = await serverFor(fixture);
    expect(stateOf(server, claimed)).toBe("WORK");

    await server.tick();

    expect(stateOf(server, claimed)).toBe("WORK");

    server.shutdown();
  }, 30000);

  test("the file is logged once when it breaks and once when it is repaired", async () => {
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

    for (let i = 0; i < 5; i++) {
      await server.tick();
    }
    expect(logLines().filter((line) => line.includes("ignoring"))).toHaveLength(
      1,
    );

    fs.writeFileSync(path.join(fixture.tasksDir, `${broken}.md`), good);
    for (let i = 0; i < 5; i++) {
      await server.tick();
    }

    expect(
      logLines().filter((line) => line.includes("parses again")),
    ).toHaveLength(1);
    expect(server.tasks().has(broken)).toBe(true);

    server.shutdown();
  }, 30000);
});

describe("the server: an agent that compacts", () => {
  test("a designer's scribbles are thrown away and the dispatch is steered back", async () => {
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

    const server = await serverFor(fixture);
    server.setSchedulerEnabled(true);
    await reaches(server, id, "DESIGN_REVIEW");
    server.setSchedulerEnabled(false);
    await server.drain();

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
  }, 30000);

  test("a worker keeps its worktree and is steered back to the assignment", async () => {
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

    const server = await serverFor(fixture);
    server.setSchedulerEnabled(true);
    await until(server, () => stateOf(server, id) !== "WORK", 20);
    server.setSchedulerEnabled(false);
    await server.drain();

    expect(fs.existsSync(path.join(server.runtime.worktree(id), "a.txt"))).toBe(
      true,
    );
    expect(steersTo(server.runtime.sessionDir(id, "worker"))).toEqual([
      server.prompts.fragment("WORK"),
    ]);
    const log = fs.readFileSync(server.runtime.serverLog, "utf-8");
    expect(log).toContain("compacted: steered back to the assignment");
    expect(log).not.toContain("worktree reset");

    server.shutdown();
  }, 30000);

  test("a reviewer that compacts right after submitting keeps its result", async () => {
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

    const server = await serverFor(fixture);
    server.setSchedulerEnabled(true);
    await reaches(server, id, "PLAN");
    server.setSchedulerEnabled(false);
    await server.drain();

    expect(steersTo(server.runtime.sessionDir(id, "reviewer"))).toEqual([]);
    expect(fs.readFileSync(server.runtime.serverLog, "utf-8")).toContain(
      "compacted after its result: left alone to settle",
    );

    server.shutdown();
  }, 30000);
});

describe("the server: a dependency cycle", () => {
  test("a task that can never unblock is logged once, not every tick", async () => {
    const fixture = makeFixture();
    const first = readyTask(fixture, "The first half");
    const second = readyTask(fixture, "The second half");

    editTaskFile(fixture, first, (meta) => {
      meta.depends_on = [second];
    });
    editTaskFile(fixture, second, (meta) => {
      meta.depends_on = [first];
    });

    const server = await serverFor(fixture);
    for (let i = 0; i < 5; i++) {
      await server.tick();
    }

    const cycles = fs
      .readFileSync(server.runtime.serverLog, "utf-8")
      .split("\n")
      .filter((line) => line.includes("depends on itself"));

    expect(cycles).toHaveLength(2);
    expect(cycles[0]).toContain(first);
    expect(cycles[1]).toContain(second);

    server.shutdown();
  }, 30000);
});
