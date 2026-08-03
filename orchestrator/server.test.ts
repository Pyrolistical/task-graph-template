import { afterEach, describe, expect } from "bun:test";
import { tempDir, test } from "./temp.ts";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import fs from "node:fs";
import path from "node:path";
import { applyTransition } from "./transition.ts";
import {
  type TaskMeta,
  readTaskFile,
  rebuildDocument,
  writeTaskBody,
} from "./task.ts";
import { defaultTasksDir } from "./runtime.ts";
import * as git from "./git.ts";
import { repoKey } from "./runtime.ts";
import {
  type Fixture,
  commitGraph,
  makeFixture,
  promptsOverlapping,
  promptsTo,
  readyTask,
  setPlan,
  systemPromptTo,
  unplannedTask,
  writeOverride,
} from "./fixture.ts";
import { Server } from "./server.ts";

const openClients: Client[] = [];

afterEach(async () => {
  for (const client of openClients.splice(0)) {
    await client.close().catch(() => {});
  }
});
import { writeCommand } from "./command.ts";
import { ISSUES } from "./prompts.ts";
import { LOOP_LIMIT } from "./rpc.ts";

async function serverFor(fixture: Fixture): Promise<Server> {
  return Server.start({
    repo: fixture.repo,
    agentsPath: fixture.agentsPath,
    tasksDir: fixture.tasksDir,
    orchestratorDir: fixture.orchestratorDir,
    overridesDir: fixture.overridesDir,
    serverRoot: fixture.serverRoot,
    piCommand: fixture.piCommand,
    base: "master",
  });
}

function editTaskFile(
  fixture: Fixture,
  id: string,
  edit: (meta: TaskMeta) => void,
): void {
  const filePath = path.join(fixture.tasksDir, `${id}.md`);
  const { meta, body } = readTaskFile(filePath);
  edit(meta);
  fs.writeFileSync(filePath, rebuildDocument(meta, body));
}

async function settle(server: Server, ticks = 6): Promise<void> {
  for (let i = 0; i < ticks; i++) {
    await server.tick();
    await server.drain();
  }
}

async function until(
  server: Server,
  done: () => boolean,
  ticks = 12,
): Promise<void> {
  for (let i = 0; i < ticks && !done(); i++) {
    await server.tick();
    await server.drain();
  }
  if (!done()) {
    throw new Error(
      `the server never reached the expected state in ${ticks} ticks\n${fs.readFileSync(server.runtime.serverLog, "utf-8")}`,
    );
  }
}

async function reaches(
  server: Server,
  id: string,
  state: string,
  ticks = 12,
): Promise<void> {
  await until(server, () => stateOf(server, id) === state, ticks);
}

function stateOf(server: Server, id: string): string {
  return server.tasks().get(id)?.state ?? "CLOSED";
}

describe("the server: the default tasks directory", () => {
  test("with no tasks dir the server resolves ~/task-graph/<key> and seeds the graph", async () => {
    const fixture = makeFixture();
    const root = tempDir("task-graph-root-");
    const previous = process.env.TASK_GRAPH_TASKS_ROOT;
    process.env.TASK_GRAPH_TASKS_ROOT = root;
    try {
      const tasksDir = defaultTasksDir(fixture.repo);
      fs.mkdirSync(tasksDir, { recursive: true });
      fs.writeFileSync(
        path.join(tasksDir, "agents.json"),
        JSON.stringify({
          agents: [{ type: "pi", provider: "fake", model: "fake", slots: 1 }],
        }),
      );

      const server = await Server.start({
        repo: fixture.repo,
        serverRoot: fixture.serverRoot,
        piCommand: fixture.piCommand,
        base: "master",
      });

      expect(server.tasksDir).toBe(tasksDir);
      expect(server.overridesDir).toBe(tasksDir);
      expect(fs.existsSync(path.join(tasksDir, "template.md"))).toBe(true);
      expect(
        fs.readFileSync(path.join(tasksDir, "next-task-id"), "utf-8"),
      ).toBe("1\n");

      server.shutdown();
    } finally {
      if (previous === undefined) {
        delete process.env.TASK_GRAPH_TASKS_ROOT;
      } else {
        process.env.TASK_GRAPH_TASKS_ROOT = previous;
      }
    }
  }, 30000);
});

describe("the server: a task that goes all the way through", () => {
  test("work, checks, agent review and manager review close the task", async () => {
    const fixture = makeFixture();
    const id = readyTask(fixture, "Add a greeting", ["test -f hello.txt"]);

    setPlan(fixture, {
      [id]: {
        WORKING: [
          {
            submit: true,
            notes: "wrote hello.txt and ran the check",
            commit: { path: "hello.txt", contents: "hello\n" },
          },
        ],
        WORK_REVIEWING: [{ submit: true }],
      },
    });

    const server = await serverFor(fixture);
    server.setSchedulerEnabled(true);

    await reaches(server, id, "READY_MANAGER_REVIEW");

    const merged = await (async () => {
      server.transition(
        id,
        "claim",
        { agentName: "manager", pid: process.pid },
        "manager",
      );
      return server.attemptMerge(id);
    })();

    expect(merged.to).toBe("CLOSED");
    expect(server.tasks().has(id)).toBe(false);
    expect(
      fs.existsSync(path.join(fixture.tasksDir, "closed", `${id}.md`)),
    ).toBe(true);
    expect(fs.existsSync(path.join(fixture.repo, "hello.txt"))).toBe(true);
    expect(git.branchExists(fixture.repo, `task/${id}`)).toBe(false);
    expect(fs.existsSync(server.runtime.worktree(id))).toBe(false);

    server.shutdown();
  }, 30000);
});

describe("the server: the planning phase", () => {
  test("a plan is written, reviewed and accepted before the work starts", async () => {
    const fixture = makeFixture();
    const id = unplannedTask(fixture, "Add a greeting", ["test -f hello.txt"]);

    setPlan(fixture, {
      [id]: {
        PLANNING: [
          {
            todos: ["write hello.txt", "run the check"],
            notes: "the plan",
            submit: true,
          },
        ],
        PLAN_REVIEWING: [{ submit: true }],
        WORKING: [
          {
            submit: true,
            notes: "wrote hello.txt and ran the check",
            commit: { path: "hello.txt", contents: "hello\n" },
          },
        ],
        WORK_REVIEWING: [{ submit: true }],
      },
    });

    const server = await serverFor(fixture);
    server.setSchedulerEnabled(true);

    await reaches(server, id, "READY_WORK");

    const body = fs.readFileSync(
      path.join(fixture.tasksDir, `${id}.md`),
      "utf-8",
    );
    expect(body).toContain("## Todos");
    expect(body).toContain("1. write hello.txt");
    expect(body).toContain("2. run the check");
    expect(fs.existsSync(server.runtime.worktree(id))).toBe(true);
    expect(fs.existsSync(server.runtime.sessionDir(id, "planner"))).toBe(true);

    const submits = server.transitions
      .read()
      .filter((e) => e.task_id === id && e.transition === "submit");
    expect(submits.map((e) => `${e.from} -> ${e.to}`)).toEqual([
      "PLANNING -> READY_PLAN_REVIEW",
      "PLAN_REVIEWING -> READY_WORK",
    ]);

    server.shutdown();
    await server.drain();
  }, 30000);

  test("plan review findings go back to the planner, verbatim, until the plan passes", async () => {
    const fixture = makeFixture();
    const id = unplannedTask(fixture, "Add a greeting");

    setPlan(fixture, {
      [id]: {
        PLANNING: [
          { todos: ["write hello.txt"], submit: true },
          { todos: ["run the check"], submit: true },
        ],
        PLAN_REVIEWING: [
          { submit: true, findings: ["no todo covers the check"] },
          { submit: true },
        ],
      },
    });

    const server = await serverFor(fixture);
    server.setSchedulerEnabled(true);

    await reaches(server, id, "READY_WORK");

    const planner = server.runtime.sessionDir(id, "planner");
    expect(promptsTo(planner).join("\n")).toContain("no todo covers the check");

    const body = fs.readFileSync(
      path.join(fixture.tasksDir, `${id}.md`),
      "utf-8",
    );
    expect(body).toContain("1. run the check");
    expect(body).not.toContain("1. write hello.txt");

    server.shutdown();
    await server.drain();
  }, 30000);

  test("an empty plan is asked for again, and a persistent one is held", async () => {
    const fixture = makeFixture();
    const id = unplannedTask(fixture, "Add a greeting");

    setPlan(fixture, {
      [id]: {
        PLANNING: [
          { submit: true },
          { todos: ["write hello.txt"], submit: true },
        ],
        PLAN_REVIEWING: [{ submit: true }],
      },
    });

    const server = await serverFor(fixture);
    server.setSchedulerEnabled(true);
    await reaches(server, id, "READY_WORK");

    const planner = server.runtime.sessionDir(id, "planner");
    expect(promptsTo(planner)[1]).toContain("## Todos");

    server.shutdown();
    await server.drain();
  }, 30000);

  test("a planner that keeps submitting an empty plan is held", async () => {
    const fixture = makeFixture();
    const id = unplannedTask(fixture, "Add a greeting");

    setPlan(fixture, {
      [id]: {
        PLANNING: [{ submit: true }],
      },
    });

    const server = await serverFor(fixture);
    server.setSchedulerEnabled(true);
    await reaches(server, id, "HELD_PLAN");

    const task = server.tasks().get(id)!;
    expect(task.held_reason).toContain(
      "the planner submitted without appending a todo list",
    );
    expect(task.state).toBe("HELD_PLAN");
    expect(promptsTo(server.runtime.sessionDir(id, "planner"))).toHaveLength(
      ISSUES["missing-todos"].attempts + 1,
    );

    server.shutdown();
  }, 30000);

  test("a planner that writes to the worktree is sent back, then held", async () => {
    const fixture = makeFixture();
    const id = unplannedTask(fixture, "Add a greeting");

    setPlan(fixture, {
      [id]: {
        PLANNING: [
          {
            write: { path: "oops.txt", contents: "nope" },
            todos: ["write hello.txt"],
            submit: true,
          },
          { clean: ["oops.txt"], todos: ["write hello.txt"], submit: true },
        ],
        PLAN_REVIEWING: [{ submit: true }],
      },
    });

    const server = await serverFor(fixture);
    server.setSchedulerEnabled(true);
    await reaches(server, id, "READY_WORK");

    const prompts = promptsTo(server.runtime.sessionDir(id, "planner"));
    expect(prompts[1]).toContain("the worktree after every stop");

    server.shutdown();
    await server.drain();
  }, 30000);

  test("a planner that commits to the branch is sent back, then held", async () => {
    const fixture = makeFixture();
    const id = unplannedTask(fixture, "Add a greeting");

    setPlan(fixture, {
      [id]: {
        PLANNING: [
          {
            commit: { path: "oops.txt", contents: "nope" },
            todos: ["write hello.txt"],
            submit: true,
          },
        ],
      },
    });

    const server = await serverFor(fixture);
    server.setSchedulerEnabled(true);
    await reaches(server, id, "HELD_PLAN");

    const task = server.tasks().get(id)!;
    expect(task.held_reason).toContain("wrote to the worktree during planning");
    expect(task.state).toBe("HELD_PLAN");

    server.shutdown();
  }, 30000);

  test("a plan reviewer that writes to the worktree is sent back", async () => {
    const fixture = makeFixture();
    const id = unplannedTask(fixture, "Add a greeting");

    setPlan(fixture, {
      [id]: {
        PLANNING: [{ todos: ["write hello.txt"], submit: true }],
        PLAN_REVIEWING: [
          { write: { path: "oops.txt", contents: "nope" }, submit: true },
          { clean: ["oops.txt"], submit: true },
        ],
      },
    });

    const server = await serverFor(fixture);
    server.setSchedulerEnabled(true);
    await reaches(server, id, "READY_WORK");

    const prompts = promptsTo(server.runtime.sessionDir(id, "reviewer"));
    expect(prompts[1]).toContain("the worktree after every stop");

    server.shutdown();
    await server.drain();
  }, 30000);

  test("a blocked planner holds the task, and resume sends it back to READY_PLAN", async () => {
    const fixture = makeFixture();
    const id = unplannedTask(fixture, "Add a greeting");
    setPlan(fixture, {
      [id]: {
        PLANNING: [{ blocked: "the acceptance criteria are empty" }],
      },
    });

    const server = await serverFor(fixture);
    server.setSchedulerEnabled(true);
    await reaches(server, id, "HELD_PLAN");

    const task = server.tasks().get(id)!;
    expect(task.held_reason).toBe("the acceptance criteria are empty");
    expect(task.state).toBe("HELD_PLAN");

    server.transition(id, "resume", {}, "manager");
    expect(stateOf(server, id)).toBe("READY_PLAN");

    server.shutdown();
  }, 30000);

  test("a blocked plan reviewer holds the task, and resume sends it back to READY_PLAN", async () => {
    const fixture = makeFixture();
    const id = unplannedTask(fixture, "Add a greeting");
    setPlan(fixture, {
      [id]: {
        PLANNING: [{ todos: ["write hello.txt"], submit: true }],
        PLAN_REVIEWING: [{ blocked: "the criteria contradict the goal" }],
      },
    });

    const server = await serverFor(fixture);
    server.setSchedulerEnabled(true);
    await reaches(server, id, "HELD_PLAN");

    const task = server.tasks().get(id)!;
    expect(task.held_reason).toBe("the criteria contradict the goal");
    expect(task.state).toBe("HELD_PLAN");

    server.transition(id, "resume", {}, "manager");
    expect(stateOf(server, id)).toBe("READY_PLAN");

    server.shutdown();
  }, 30000);

  test("the manager resolves a held task by writing the body and resuming", async () => {
    const fixture = makeFixture();
    const id = readyTask(fixture, "A task");
    setPlan(fixture, {
      [id]: { WORKING: [{ blocked: "the criteria are unclear" }] },
    });

    const server = await serverFor(fixture);
    server.setSchedulerEnabled(true);
    await reaches(server, id, "HELD_WORK");
    server.setSchedulerEnabled(false);

    writeTaskBody(fixture.tasksDir, id, "# Goal\n\nclarified the criteria");
    server.transition(id, "resume", {}, "manager");
    expect(stateOf(server, id)).toBe("READY_WORK");

    server.shutdown();
  }, 30000);

  test("planning ranks below work, and plan review below both", async () => {
    const fixture = makeFixture();
    const worked = readyTask(fixture, "Ready for work");
    const reviewing = unplannedTask(fixture, "Plan awaiting review");
    const fresh = unplannedTask(fixture, "Not yet planned");

    const server = await serverFor(fixture);
    server.setSchedulerEnabled(false);
    server.transition(
      reviewing,
      "claim",
      { agentName: "planner", pid: process.pid },
      "test",
    );
    server.transition(reviewing, "submit", {}, "server");
    await server.tick();

    const view = JSON.parse(
      fs.readFileSync(server.runtime.queueView, "utf-8"),
    ) as { queue: { rank: string }[] };
    expect(view.queue.map((r) => r.rank)).toEqual([
      "READY_WORK_FRESH",
      "READY_PLAN_REVIEW",
      "READY_PLAN_FRESH",
    ]);

    server.shutdown();
  }, 30000);

  test("a task still queued in READY_PLAN can be held and aborted", async () => {
    const fixture = makeFixture();
    const id = unplannedTask(fixture, "The wrong shape");

    const server = await serverFor(fixture);
    server.setSchedulerEnabled(false);
    await server.tick();

    expect(() => server.attemptAbort(id)).toThrow(
      /not in MANAGER_REVIEWING or HELD_PLAN or HELD_WORK/,
    );
    server.transition(id, "hold", { reason: "abandoning" }, "manager");
    expect(server.attemptAbort(id).to).toBe("CLOSED");
    expect(server.tasks().has(id)).toBe(false);

    server.shutdown();
  }, 30000);
});

describe("the server: dispatch", () => {
  test("the prompts and templates come from the orchestrator's own directory, not the driven repo", async () => {
    const fixture = makeFixture();
    const id = readyTask(fixture, "Do a thing");
    fs.rmSync(fixture.orchestratorDir, { recursive: true });

    setPlan(fixture, { [id]: { WORKING: [{ notes: "still thinking" }] } });

    const server = await Server.start({
      repo: fixture.repo,
      agentsPath: fixture.agentsPath,
      tasksDir: fixture.tasksDir,
      serverRoot: fixture.serverRoot,
      piCommand: fixture.piCommand,
      base: "master",
    });
    expect(server.orchestratorDir).toBe(import.meta.dir);

    server.setSchedulerEnabled(true);
    await server.tick();
    await server.drain();

    expect(fs.existsSync(server.runtime.assignment(id))).toBe(true);

    server.shutdown();
  }, 30000);

  test("the driven repo's own orchestrator/ overrides the prompts and templates it names", async () => {
    const fixture = makeFixture();
    const id = readyTask(fixture, "Do a thing");

    writeOverride(
      fixture,
      "prompts/WORKING.md",
      "You are this project's implementer.\n",
    );
    writeOverride(
      fixture,
      "prompts/dispatch.md",
      "Start on ../ASSIGNMENT.md.\n",
    );
    setPlan(fixture, { [id]: { WORKING: [{ notes: "still thinking" }] } });

    const server = await serverFor(fixture);
    server.setSchedulerEnabled(true);
    await server.tick();
    await server.drain();

    const sessionDir = server.runtime.sessionDir(id, "worker");
    expect(systemPromptTo(sessionDir)).toBe(
      "You are this project's implementer.\n",
    );
    expect(promptsTo(sessionDir)[0]).toBe("Start on ../ASSIGNMENT.md.\n");

    const assignment = fs.readFileSync(server.runtime.assignment(id), "utf-8");
    expect(assignment).toContain("# Goal");

    server.shutdown();
  }, 30000);

  test("startup logs the absolute path of every cached prompt and template", async () => {
    const fixture = makeFixture();
    readyTask(fixture, "Do a thing");
    writeOverride(
      fixture,
      "prompts/dispatch.md",
      "Start on ../ASSIGNMENT.md.\n",
    );

    const server = await serverFor(fixture);

    const log = fs.readFileSync(server.runtime.serverLog, "utf-8");
    expect(log).toContain(
      `cached ${path.join(fixture.overridesDir, "prompts", "dispatch.md")}`,
    );
    expect(log).not.toContain(
      `cached ${path.join(fixture.orchestratorDir, "prompts", "dispatch.md")}`,
    );

    server.shutdown();
  }, 30000);

  test("an override of one file leaves every other prompt as the orchestrator ships it", async () => {
    const fixture = makeFixture();
    const id = readyTask(fixture, "Do a thing");

    writeOverride(
      fixture,
      "prompts/dispatch.md",
      "Start on ../ASSIGNMENT.md.\n",
    );

    setPlan(fixture, { [id]: { WORKING: [{ notes: "still thinking" }] } });

    const server = await serverFor(fixture);
    server.setSchedulerEnabled(true);
    await server.tick();
    await server.drain();

    const sessionDir = server.runtime.sessionDir(id, "worker");
    expect(promptsTo(sessionDir)[0]).toBe("Start on ../ASSIGNMENT.md.\n");
    expect(systemPromptTo(sessionDir)).toBe(
      fs.readFileSync(
        path.join(fixture.orchestratorDir, "prompts", "WORKING.md"),
        "utf-8",
      ),
    );

    server.shutdown();
  }, 30000);

  test("a dispatched task gets a worktree, a branch and an ASSIGNMENT.md beside it", async () => {
    const fixture = makeFixture();
    const id = readyTask(fixture, "Do a thing", ["true"]);

    setPlan(fixture, { [id]: { WORKING: [{ notes: "still thinking" }] } });

    const server = await serverFor(fixture);
    server.setSchedulerEnabled(true);
    await server.tick();
    await server.drain();

    const worktree = server.runtime.worktree(id);
    const assignment = server.runtime.assignment(id);

    expect(fs.existsSync(worktree)).toBe(true);
    expect(fs.existsSync(assignment)).toBe(true);
    expect(assignment.startsWith(worktree)).toBe(false);
    expect(git.branchExists(fixture.repo, `task/${id}`)).toBe(true);

    const body = fs.readFileSync(assignment, "utf-8");
    expect(body).toContain("# Goal");

    server.shutdown();
  }, 30000);

  test("the claim records the agent, its pid and the session it opened", async () => {
    const fixture = makeFixture();
    const id = readyTask(fixture, "Do a thing");
    setPlan(fixture, {
      [id]: {
        WORKING: [
          {
            submit: true,
            notes: "did the work",
            commit: { path: "a.txt", contents: "a" },
          },
        ],
        WORK_REVIEWING: [{ submit: true }],
      },
    });

    const server = await serverFor(fixture);
    server.setSchedulerEnabled(true);
    await reaches(server, id, "READY_MANAGER_REVIEW");
    server.setSchedulerEnabled(false);

    const task = server.tasks().get(id)!;
    expect(task.workspace!.agent).toBe("pi-fake-fake-1");
    expect(task.workspace!.branch).toBe(`task/${id}`);
    expect(task.workspace!.worktree).toBe(server.runtime.worktree(id));
    expect(fs.existsSync(task.workspace!.session!)).toBe(true);

    const claim = server.transitions
      .read()
      .find((e) => e.transition === "claim")!;
    expect(claim.by).toBe("pi-fake-fake-1");
    expect(claim.from).toBe("READY_WORK");
    expect(claim.to).toBe("WORKING");

    server.shutdown();
  }, 30000);

  test("a workspace claimed under an older branch prefix keeps the branch it recorded", async () => {
    const fixture = makeFixture();
    const id = readyTask(fixture, "A task from before the prefix changed");
    setPlan(fixture, { [id]: { WORK_REVIEWING: [{ submit: true }] } });

    const server = await serverFor(fixture);
    const legacy = `work/${id}`;
    const worktree = server.runtime.worktree(id);
    server.runtime.prepare(id);
    git.addWorkspace(fixture.repo, legacy, worktree, "master");
    fs.writeFileSync(path.join(worktree, "a.txt"), "a\n");
    git.gitOrThrow(worktree, ["add", "-A"]);
    git.gitOrThrow(worktree, ["commit", "-q", "-m", "work from before"]);
    git.harvest(fixture.repo, worktree, legacy);

    const body = readTaskFile(path.join(fixture.tasksDir, `${id}.md`)).body;
    for (const [name, args] of [
      [
        "claim",
        { agentName: "pi-old-1", pid: process.pid, branch: legacy, worktree },
      ],
      ["submit", { body }],
      ["claim", { agentName: "server", pid: process.pid }],
      ["pass", {}],
    ] as const) {
      applyTransition(fixture.tasksDir, id, name, args);
    }
    expect(stateOf(server, id)).toBe("READY_WORK_REVIEW");

    server.setSchedulerEnabled(true);
    await reaches(server, id, "READY_MANAGER_REVIEW");
    server.setSchedulerEnabled(false);

    expect(server.tasks().get(id)!.workspace!.branch).toBe(legacy);
    expect(git.branchExists(fixture.repo, `task/${id}`)).toBe(false);

    server.transition(
      id,
      "claim",
      { agentName: "manager", pid: process.pid },
      "manager",
    );
    expect((await server.attemptMerge(id)).to).toBe("CLOSED");
    expect(fs.existsSync(path.join(fixture.repo, "a.txt"))).toBe(true);
    expect(git.branchExists(fixture.repo, legacy)).toBe(false);

    server.shutdown();
  }, 30000);

  test("two ticks in flight at once dispatch a task to one slot, not two", async () => {
    const fixture = makeFixture(2);
    const id = readyTask(fixture, "Do a thing");
    setPlan(fixture, {
      [id]: {
        WORKING: [{ busy_ms: 200, submit: true, notes: "did the work" }],
      },
    });

    const server = await serverFor(fixture);
    server.setSchedulerEnabled(true);
    await Promise.all([server.tick(), server.tick()]);
    server.setSchedulerEnabled(false);

    expect(server.agentRows().filter((row) => row.task_id === id)).toHaveLength(
      1,
    );

    await server.drain();
    expect(fs.readFileSync(server.runtime.serverLog, "utf-8")).not.toContain(
      "dispatch of",
    );

    server.shutdown();
  }, 30000);

  test("nothing is dispatched while the scheduler is stopped", async () => {
    const fixture = makeFixture();
    const id = readyTask(fixture, "Do a thing");
    setPlan(fixture, { [id]: { WORKING: [{ submit: true }] } });

    const server = await serverFor(fixture);
    await settle(server, 2);

    expect(stateOf(server, id)).toBe("READY_WORK");
    expect(server.schedulerEnabled).toBe(false);

    server.shutdown();
  }, 30000);

  test("a paused scheduler still settles work already in flight", async () => {
    const fixture = makeFixture();
    const id = readyTask(fixture, "Do a thing");
    setPlan(fixture, {
      [id]: {
        WORKING: [
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
    await settle(server, 2);

    expect(stateOf(server, id)).toBe("READY_WORK_REVIEW");
    expect(server.schedulerEnabled).toBe(false);

    server.shutdown();
  }, 30000);
});

describe("the server: checks", () => {
  test("a failing check records the failure and sends the work back", async () => {
    const fixture = makeFixture();
    const id = readyTask(fixture, "Do a thing", ["echo boom >&2; exit 3"]);
    setPlan(fixture, {
      [id]: {
        WORKING: [
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
    expect(task.state).toBe("READY_WORK");
    const queued = fs.readFileSync(
      path.join(server.runtime.queueDir(id), "WORKING.md"),
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
        WORKING: [
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
      path.join(server.runtime.queueDir(id), "WORKING.md"),
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
        WORKING: [
          {
            submit: true,
            notes: "did the work",
            commit: { path: "a.txt", contents: "a" },
          },
        ],
        WORK_REVIEWING: [{ submit: true }],
      },
    });

    const server = await serverFor(fixture);
    server.setSchedulerEnabled(true);
    await reaches(server, id, "READY_WORK_REVIEW");

    server.shutdown();
  }, 30000);

  test("the check log holds the output of the command", async () => {
    const fixture = makeFixture();
    const id = readyTask(fixture, "Do a thing", ["echo written-to-the-log"]);
    setPlan(fixture, {
      [id]: {
        WORKING: [
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

describe("the server: the agent review", () => {
  test("a finding lands under # Review findings and the task drops back to READY_WORK", async () => {
    const fixture = makeFixture();
    const id = readyTask(fixture, "Do a thing");
    setPlan(fixture, {
      [id]: {
        WORKING: [
          {
            submit: true,
            notes: "I skipped the null case",
            commit: { path: "a.txt", contents: "a" },
          },
        ],
        WORK_REVIEWING: [
          { submit: true, findings: ["the null case is untested"] },
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
    server.setSchedulerEnabled(true);
    await server.tick();
    server.setSchedulerEnabled(false);
    await server.drain();

    const body = fs.readFileSync(
      path.join(fixture.tasksDir, `${id}.md`),
      "utf-8",
    );
    expect(body).toContain("# Review findings");
    expect(body).toContain("- the null case is untested");

    const queued = fs.readFileSync(
      path.join(server.runtime.queueDir(id), "WORKING.md"),
      "utf-8",
    );
    expect(queued).toContain("the null case is untested");

    const applied = server.transitions
      .read()
      .find(
        (e) => e.transition === "addFeedback" && e.from === "WORK_REVIEWING",
      )!;
    expect(applied.to).toBe("READY_WORK");
    expect(applied.by).toBe("server");

    server.shutdown();
  }, 30000);

  test("the reviewer gets its own session and a worktree with the work on it", async () => {
    const fixture = makeFixture();
    const id = readyTask(fixture, "Do a thing");
    setPlan(fixture, {
      [id]: {
        WORKING: [
          {
            submit: true,
            notes: "I decided the flaky test was not mine to fix",
            commit: { path: "a.txt", contents: "a" },
          },
        ],
        WORK_REVIEWING: [{ submit: true }],
      },
    });

    const server = await serverFor(fixture);
    server.setSchedulerEnabled(true);
    await reaches(server, id, "READY_MANAGER_REVIEW");
    server.setSchedulerEnabled(false);

    const head = git
      .gitOrThrow(server.runtime.worktree(id), ["rev-parse", "HEAD"])
      .trim();
    const base = git
      .gitOrThrow(server.runtime.worktree(id), ["rev-parse", "master"])
      .trim();
    expect(head).not.toBe(base);

    const workSessions = fs.readdirSync(
      server.runtime.sessionDir(id, "worker"),
    );
    const reviewSessions = fs.readdirSync(
      server.runtime.sessionDir(id, "reviewer"),
    );
    expect(workSessions.length).toBeGreaterThan(0);
    expect(reviewSessions.length).toBeGreaterThan(0);
    expect(reviewSessions).not.toEqual(workSessions);

    server.shutdown();
  }, 30000);

  test("a diff that writes to tasks/ is rejected at the review", async () => {
    const fixture = makeFixture();
    const id = readyTask(fixture, "Do a thing");
    setPlan(fixture, {
      [id]: {
        WORKING: [
          {
            submit: true,
            notes: "did the work",
            commit: { path: "tasks/000001.md", contents: "rewritten\n" },
          },
        ],
        WORK_REVIEWING: [{ submit: true }],
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

    const queued = fs.readFileSync(
      path.join(server.runtime.queueDir(id), "WORKING.md"),
      "utf-8",
    );
    expect(queued).toContain("writes to tasks/");

    const applied = server.transitions
      .read()
      .find(
        (e) => e.transition === "addFeedback" && e.from === "WORK_REVIEWING",
      )!;
    expect(applied.to).toBe("READY_WORK");

    server.shutdown();
  }, 30000);
});

describe("the server: a submit with nothing in the git history", () => {
  test("a branch with no commit on it comes back for one", async () => {
    const fixture = makeFixture();
    const id = readyTask(fixture, "Do a thing");
    setPlan(fixture, {
      [id]: {
        WORKING: [
          { submit: true, notes: "I forgot to commit" },
          { submit: true, commit: { path: "a.txt", contents: "a\n" } },
        ],
        WORK_REVIEWING: [{ submit: true }],
      },
    });

    const server = await serverFor(fixture);
    server.setSchedulerEnabled(true);
    await reaches(server, id, "READY_MANAGER_REVIEW");
    server.setSchedulerEnabled(false);

    const prompts = promptsTo(server.runtime.sessionDir(id, "worker"));
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain("git commit");
    expect(prompts[1]).toContain("There is no commit of yours on this branch");
    expect(prompts[1]).not.toContain("still reports");
    expect(server.transitions.read().some((e) => e.transition === "hold")).toBe(
      false,
    );

    server.shutdown();
  }, 30000);

  test("an uncommitted change comes back with what git status reports", async () => {
    const fixture = makeFixture();
    const id = readyTask(fixture, "Do a thing");
    setPlan(fixture, {
      [id]: {
        WORKING: [
          {
            submit: true,
            notes: "wrote a.txt and half of b.txt",
            commit: { path: "a.txt", contents: "a\n" },
            write: { path: "b.txt", contents: "half a fix\n" },
          },
          {
            submit: true,
            notes: "finished b.txt",
            commit: { path: "b.txt", contents: "half a fix\n" },
          },
        ],
        WORK_REVIEWING: [{ submit: true }],
      },
    });

    const server = await serverFor(fixture);
    server.setSchedulerEnabled(true);
    await reaches(server, id, "READY_MANAGER_REVIEW");
    server.setSchedulerEnabled(false);

    const prompts = promptsTo(server.runtime.sessionDir(id, "worker"));
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain("`git status --porcelain` reports:");
    expect(prompts[1]).toContain("?? b.txt");
    expect(prompts[1]).not.toContain("There is no commit of yours");

    expect(git.uncommitted(server.runtime.worktree(id))).toEqual([]);
    expect(
      git.commitCount(server.runtime.worktree(id), "master"),
    ).toBeGreaterThan(0);

    server.shutdown();
  }, 30000);

  test("an agent that never commits is held, and the slot is released", async () => {
    const fixture = makeFixture();
    const id = readyTask(fixture, "Do a thing");
    setPlan(fixture, {
      [id]: { WORKING: [{ submit: true, notes: "forgot to commit" }] },
    });

    const server = await serverFor(fixture);
    server.setSchedulerEnabled(true);
    await reaches(server, id, "HELD_WORK", 20);

    const task = server.tasks().get(id)!;
    expect(task.held_reason).toBe(
      "the agent submitted work it never committed: nothing is committed on the branch",
    );
    expect(task.claimed_by).toBeNull();
    expect(promptsTo(server.runtime.sessionDir(id, "worker"))).toHaveLength(5);
    expect(server.agentRows()[0]!.state).toBe("IDLE");

    server.shutdown();
  }, 30000);
});

describe("the server: an agent that stops short", () => {
  test("a blocked result holds the task with its message as the reason", async () => {
    const fixture = makeFixture();
    const id = readyTask(fixture, "Do a thing");
    setPlan(fixture, {
      [id]: {
        WORKING: [
          {
            blocked: "the staging database is unreachable",
            notes: "tried twice",
          },
        ],
      },
    });

    const server = await serverFor(fixture);
    server.setSchedulerEnabled(true);
    await reaches(server, id, "HELD_WORK");

    const task = server.tasks().get(id)!;
    expect(task.state).toBe("HELD_WORK");
    expect(task.held_reason).toBe("the staging database is unreachable");
    expect(task.claimed_by).toBeNull();

    const prompts = promptsTo(server.runtime.sessionDir(id, "worker"));
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain("worth one second look");
    expect(prompts[1]).toContain("A wall you can work around is not a wall");

    server.shutdown();
  }, 30000);

  test("an agent stuck on one command is asked whether it is blocked, not held", async () => {
    const fixture = makeFixture();
    const id = readyTask(fixture, "Do a thing");
    setPlan(fixture, {
      [id]: {
        WORKING: [
          { loop: LOOP_LIMIT },
          {
            submit: true,
            notes: "did the work",
            commit: { path: "a.txt", contents: "a" },
          },
        ],
        WORK_REVIEWING: [{ submit: true }],
      },
    });

    const server = await serverFor(fixture);
    server.setSchedulerEnabled(true);
    await reaches(server, id, "READY_MANAGER_REVIEW");
    server.setSchedulerEnabled(false);

    const prompts = promptsTo(server.runtime.sessionDir(id, "worker"));
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain("zig build");
    expect(prompts[1]).toContain("call the `blocked` tool");
    expect(server.transitions.read().some((e) => e.transition === "hold")).toBe(
      false,
    );

    server.shutdown();
  }, 30000);

  test("an agent that keeps looping is held only once the nudges run out", async () => {
    const fixture = makeFixture();
    const id = readyTask(fixture, "Do a thing");
    setPlan(fixture, { [id]: { WORKING: [{ loop: LOOP_LIMIT }] } });

    const server = await serverFor(fixture);
    server.setSchedulerEnabled(true);
    await reaches(server, id, "HELD_WORK");

    expect(server.tasks().get(id)!.held_reason).toContain("zig build");
    expect(promptsTo(server.runtime.sessionDir(id, "worker"))).toHaveLength(
      ISSUES.looping.attempts + 1,
    );

    server.shutdown();
  }, 30000);

  test("a reviewer that reconsiders its blocker delegates it instead", async () => {
    const fixture = makeFixture();
    const id = readyTask(fixture, "Do a thing");
    setPlan(fixture, {
      [id]: {
        WORKING: [
          {
            submit: true,
            notes: "did the work",
            commit: { path: "a.txt", contents: "a" },
          },
        ],
        WORK_REVIEWING: [
          { blocked: "the retry loop in fetch.ts has the same bug" },
          {
            submit: true,
            delegations: ["the retry loop in fetch.ts has the same bug"],
          },
        ],
      },
    });

    const server = await serverFor(fixture);
    server.setSchedulerEnabled(true);
    await reaches(server, id, "READY_MANAGER_REVIEW");
    server.setSchedulerEnabled(false);

    const prompts = promptsTo(server.runtime.sessionDir(id, "reviewer"));
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain("is a delegation, not a");

    expect(server.transitions.read().some((e) => e.transition === "hold")).toBe(
      false,
    );

    server.shutdown();
  }, 30000);

  test("a held task is never dispatched again", async () => {
    const fixture = makeFixture();
    const id = readyTask(fixture, "Do a thing");
    setPlan(fixture, {
      [id]: { WORKING: [{ blocked: "a wall" }] },
    });

    const server = await serverFor(fixture);
    server.setSchedulerEnabled(true);
    await reaches(server, id, "HELD_WORK");
    await settle(server, 3);

    expect(stateOf(server, id)).toBe("HELD_WORK");
    expect(
      server.transitions.read().filter((e) => e.transition === "claim"),
    ).toHaveLength(1);

    server.shutdown();
  }, 30000);

  test("a result tool that does not fit the state is prompted four times, then held", async () => {
    const fixture = makeFixture();
    const id = readyTask(fixture, "Do a thing");
    setPlan(fixture, {
      [id]: {
        WORKING: [
          { result_tool: { name: "submit", args: { findings: ["x"] } } },
        ],
      },
    });

    const server = await serverFor(fixture);
    server.setSchedulerEnabled(true);
    await reaches(server, id, "HELD_WORK");

    const task = server.tasks().get(id)!;
    expect(task.state).toBe("HELD_WORK");
    expect(task.held_reason).toContain("not a valid one for its state");

    const prompts = promptsTo(server.runtime.sessionDir(id, "worker"));
    expect(prompts).toHaveLength(5);
    expect(prompts[1]).toContain("Your last action was not a valid result");
    expect(prompts[1]).not.toContain("delegations");

    server.shutdown();
  }, 30000);

  test("a nudge waits for the turn the agent is already in", async () => {
    const fixture = makeFixture();
    const id = readyTask(fixture, "Do a thing");
    setPlan(fixture, {
      [id]: {
        WORKING: [{ raw_final_message: "prose", start_delay_ms: 50 }],
      },
    });

    const server = await serverFor(fixture);
    server.setSchedulerEnabled(true);
    await reaches(server, id, "HELD_WORK", 40);

    const sessionDir = server.runtime.sessionDir(id, "worker");
    expect(promptsOverlapping(sessionDir)).toEqual([]);
    expect(promptsTo(sessionDir)).toHaveLength(5);

    server.shutdown();
  }, 30000);

  test("an edited assignment is nudged to restore it, and the redo passes", async () => {
    const fixture = makeFixture();
    const id = readyTask(fixture, "Do a thing");
    setPlan(fixture, {
      [id]: {
        WORKING: [
          {
            tamper: { from: "# Goal", to: "# Changed" },
            submit: true,
            notes: "did the work",
            commit: { path: "a.txt", contents: "a" },
          },
          {
            tamper: { from: "# Changed", to: "# Goal" },
            submit: true,
            notes: "did the work",
            commit: { path: "a.txt", contents: "a" },
          },
        ],
        WORK_REVIEWING: [{ submit: true }],
      },
    });

    const server = await serverFor(fixture);
    server.setSchedulerEnabled(true);
    await reaches(server, id, "READY_MANAGER_REVIEW");
    server.setSchedulerEnabled(false);

    const prompts = promptsTo(server.runtime.sessionDir(id, "worker"));
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain("Restore every character above your section");

    server.shutdown();
  }, 30000);

  test("a worker that submits without appending notes is prompted, then held", async () => {
    const fixture = makeFixture();
    const id = readyTask(fixture, "Do a thing");
    setPlan(fixture, {
      [id]: {
        WORKING: [{ submit: true, commit: { path: "a.txt", contents: "a" } }],
      },
    });

    const server = await serverFor(fixture);
    server.setSchedulerEnabled(true);
    await reaches(server, id, "HELD_WORK");

    const task = server.tasks().get(id)!;
    expect(task.state).toBe("HELD_WORK");
    expect(task.held_reason).toContain(
      "without appending implementation notes",
    );
    expect(promptsTo(server.runtime.sessionDir(id, "worker"))).toHaveLength(5);

    server.shutdown();
  }, 30000);
});

describe("the server: rotation and history", () => {
  test("a re-dispatch rotates the previous attempt into history", async () => {
    const fixture = makeFixture();
    const id = readyTask(fixture, "Do a thing");
    setPlan(fixture, {
      [id]: {
        WORKING: [{ raw_final_message: "prose", notes: "attempt one" }],
      },
    });

    const server = await serverFor(fixture);
    server.setSchedulerEnabled(true);
    await reaches(server, id, "HELD_WORK");
    server.setSchedulerEnabled(false);

    setPlan(fixture, {
      [id]: {
        WORKING: [
          {
            submit: true,
            notes: "attempt two",
            commit: { path: "a.txt", contents: "a" },
          },
        ],
        WORK_REVIEWING: [{ submit: true }],
      },
    });
    server.transition(id, "resume", {}, "manager");
    server.setSchedulerEnabled(true);
    await reaches(server, id, "READY_MANAGER_REVIEW");
    server.setSchedulerEnabled(false);

    const history = fs.readdirSync(server.runtime.history(id)).sort();
    expect(history).toEqual(["ASSIGNMENT.1.md"]);
    expect(
      fs.readFileSync(
        path.join(server.runtime.history(id), "ASSIGNMENT.1.md"),
        "utf-8",
      ),
    ).toContain("attempt one");

    const body = fs.readFileSync(
      path.join(fixture.tasksDir, `${id}.md`),
      "utf-8",
    );
    expect(body).toContain("attempt two");

    server.shutdown();
  }, 30000);

  test("every process against one task appends to a single rpc log", async () => {
    const fixture = makeFixture();
    const id = readyTask(fixture, "Do a thing");
    setPlan(fixture, {
      [id]: {
        WORKING: [
          {
            submit: true,
            notes: "did the work",
            commit: { path: "a.txt", contents: "a" },
          },
        ],
        WORK_REVIEWING: [{ submit: true }],
      },
    });

    const server = await serverFor(fixture);
    server.setSchedulerEnabled(true);
    await reaches(server, id, "READY_MANAGER_REVIEW");

    const log = fs.readFileSync(server.runtime.rpcLog(id), "utf-8");
    const settled = log
      .split("\n")
      .filter((line) => line.includes(`"agent_settled"`));
    expect(settled.length).toBeGreaterThanOrEqual(2);

    server.shutdown();
  }, 30000);
});

describe("the server: the views", () => {
  test("an idle slot is a row of nulls, never a missing row", async () => {
    const fixture = makeFixture(2);
    const server = await serverFor(fixture);
    await server.writeViews();

    const view = JSON.parse(
      fs.readFileSync(server.runtime.agentsView, "utf-8"),
    );
    expect(view.agents).toHaveLength(2);
    expect(view.agents[0].state).toBe("IDLE");
    expect(view.agents[0].task_id).toBeNull();
    expect(view.agents[1].name).toBe("pi-fake-fake-2");

    server.shutdown();
  }, 30000);

  test("a busy slot names its task, role, pid and activity", async () => {
    const fixture = makeFixture();
    const id = readyTask(fixture, "Do a thing");
    setPlan(fixture, { [id]: { WORKING: [{ notes: "still going" }] } });

    const server = await serverFor(fixture);
    server.setSchedulerEnabled(true);
    await server.tick();

    const view = JSON.parse(
      fs.readFileSync(server.runtime.agentsView, "utf-8"),
    );
    const busy = view.agents.find(
      (agent: { task_id: string | null }) => agent.task_id === id,
    );
    expect(busy).toBeDefined();
    expect(["tool-call", "thinking", "compacting", "none"]).toContain(
      busy.activity.kind,
    );
    expect(busy.role).toBe("worker");
    expect(busy.pid).toBeGreaterThan(0);
    expect(busy.log).toBe(server.runtime.rpcLog(id));

    await server.drain();
    server.shutdown();
  }, 30000);

  test("every view carries the same transition cursor", async () => {
    const fixture = makeFixture();
    readyTask(fixture, "Do a thing");

    const server = await serverFor(fixture);
    await server.writeViews();

    const seqs = [
      server.runtime.agentsView,
      server.runtime.checksView,
      server.runtime.tasksView,
      server.runtime.inboxView,
    ].map((file) => JSON.parse(fs.readFileSync(file, "utf-8")).seq);

    expect(new Set(seqs).size).toBe(1);
    expect(seqs[0]).toBe(server.transitions.cursor);

    server.shutdown();
  }, 30000);

  test("the tasks view carries the blocking count and the held reason", async () => {
    const fixture = makeFixture();
    const dep = readyTask(fixture, "the dependency");
    const held = readyTask(fixture, "the held one");
    applyTransition(fixture.tasksDir, held, "hold", {
      reason: "waiting on its dependency",
    });
    editTaskFile(fixture, held, (meta) => {
      meta.depends_on = [dep];
    });
    applyTransition(fixture.tasksDir, held, "resume", {});

    const server = await serverFor(fixture);
    server.transition(
      dep,
      "claim",
      { agentName: "a", pid: process.pid },
      "test",
    );
    server.transition(dep, "hold", { reason: "waiting on a person" }, "test");
    await server.writeViews();

    const view = JSON.parse(fs.readFileSync(server.runtime.tasksView, "utf-8"));
    const row = view.tasks.find((task: { id: string }) => task.id === dep);
    expect(row.blocking).toBe(1);
    expect(row.held_reason).toBe("waiting on a person");
    expect(row.state).toBe("HELD_WORK");

    server.shutdown();
  }, 30000);
});

describe("the server: the queue view", () => {
  test("the queue is what the scheduler would dispatch next, with its own state", async () => {
    const fixture = makeFixture();
    const first = readyTask(fixture, "the first");
    const second = readyTask(fixture, "the second");
    applyTransition(fixture.tasksDir, second, "hold", {
      reason: "waiting on the first",
    });
    editTaskFile(fixture, second, (meta) => {
      meta.depends_on = [first];
    });
    applyTransition(fixture.tasksDir, second, "resume", {});

    const server = await serverFor(fixture);
    await server.writeViews();

    const view = JSON.parse(fs.readFileSync(server.runtime.queueView, "utf-8"));
    expect(view.scheduling).toBe(false);
    expect(view.queue).toHaveLength(1);
    expect(view.queue[0].task_id).toBe(first);
    expect(view.queue[0].rank).toBe("READY_WORK_FRESH");
    expect(view.queue[0].blocking).toBe(1);

    server.setSchedulerEnabled(true);
    await server.writeViews();
    expect(
      JSON.parse(fs.readFileSync(server.runtime.queueView, "utf-8")).scheduling,
    ).toBe(true);

    server.shutdown();
  }, 30000);
});

describe("the server: console commands", () => {
  async function applied(done: () => boolean): Promise<void> {
    for (let waited = 0; waited < 200 && !done(); waited++) {
      await Bun.sleep(10);
    }
    if (!done()) {
      throw new Error("the server never applied the console command");
    }
  }

  test("a written command toggles the scheduler and an agent, and is consumed", async () => {
    const fixture = makeFixture();
    const server = await serverFor(fixture);

    writeCommand(server.runtime, { command: "scheduler", enabled: true });
    await applied(() => server.schedulerEnabled);
    expect(fs.existsSync(server.runtime.consoleCommand)).toBe(false);

    writeCommand(server.runtime, {
      command: "agent",
      agent: "pi-fake-fake",
      enabled: false,
    });
    await applied(() => !server.agentRows()[0]!.enabled);

    writeCommand(server.runtime, { command: "scheduler", enabled: false });
    await applied(() => !server.schedulerEnabled);

    server.shutdown();
  }, 30000);

  test("a command left behind by a dead server is applied at startup", async () => {
    const fixture = makeFixture();
    const first = await serverFor(fixture);
    first.shutdown();
    writeCommand(first.runtime, { command: "scheduler", enabled: true });

    const second = await serverFor(fixture);
    expect(second.schedulerEnabled).toBe(true);
    expect(fs.existsSync(second.runtime.consoleCommand)).toBe(false);

    second.shutdown();
  }, 30000);

  test("a command naming no agent in the pool is logged, not thrown", async () => {
    const fixture = makeFixture();
    const server = await serverFor(fixture);

    writeCommand(server.runtime, {
      command: "agent",
      agent: "pi-nobody-nothing",
      enabled: false,
    });
    await applied(() =>
      fs.readFileSync(server.runtime.serverLog, "utf-8").includes("refused"),
    );

    expect(fs.readFileSync(server.runtime.serverLog, "utf-8")).toContain(
      "no agent named",
    );
    expect(server.agentRows()[0]!.enabled).toBe(true);

    server.shutdown();
  }, 30000);
});

describe("the server: the transition log", () => {
  test("every applied transition is one line with a from, a to and an author", async () => {
    const fixture = makeFixture();
    const id = readyTask(fixture, "Do a thing");
    setPlan(fixture, {
      [id]: {
        WORKING: [
          {
            submit: true,
            notes: "did the work",
            commit: { path: "a.txt", contents: "a" },
          },
        ],
        WORK_REVIEWING: [{ submit: true }],
      },
    });

    const server = await serverFor(fixture);
    server.setSchedulerEnabled(true);
    await reaches(server, id, "READY_MANAGER_REVIEW");

    const entries = server.transitions.read();
    expect(entries.map((e) => e.seq)).toEqual(entries.map((_, i) => i + 1));

    const claim = entries.find((e) => e.transition === "claim")!;
    expect(claim.from).toBe("READY_WORK");
    expect(claim.to).toBe("WORKING");
    expect(claim.by).toBe("pi-fake-fake-1");
    expect(entries.some((e) => e.by === "server")).toBe(true);

    server.shutdown();
  }, 30000);
});

describe("the server: startup recovery", () => {
  test("a worktree lost to a cleared /tmp is recreated from its branch", async () => {
    const fixture = makeFixture();
    const id = readyTask(fixture, "Do a thing");
    setPlan(fixture, { [id]: { WORKING: [{ notes: "working" }] } });

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
    first.transition(id, "claim", { agentName: "a", pid: process.pid }, "test");
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

describe("the server: integration", () => {
  test("a branch that no longer rebases is an error back to the manager", async () => {
    const fixture = makeFixture();
    const id = readyTask(fixture, "Do a thing");
    setPlan(fixture, {
      [id]: {
        WORKING: [
          {
            submit: true,
            notes: "did the work",
            commit: { path: "shared.txt", contents: "from the branch\n" },
          },
        ],
        WORK_REVIEWING: [{ submit: true }],
      },
    });

    const server = await serverFor(fixture);
    server.setSchedulerEnabled(true);
    await reaches(server, id, "READY_MANAGER_REVIEW");
    server.setSchedulerEnabled(false);

    fs.writeFileSync(path.join(fixture.repo, "shared.txt"), "from master\n");
    commitGraph(fixture, "conflicting change on master");

    server.transition(
      id,
      "claim",
      { agentName: "manager", pid: process.pid },
      "manager",
    );

    expect(server.attemptMerge(id)).rejects.toThrow(/no longer rebases/);
    expect(stateOf(server, id)).toBe("MANAGER_REVIEWING");

    server.shutdown();
  }, 30000);

  test("a check that fails after the rebase is an error back to the manager", async () => {
    const fixture = makeFixture();
    const id = readyTask(fixture, "Do a thing", ["test -f wanted.txt"]);
    setPlan(fixture, {
      [id]: {
        WORKING: [
          {
            submit: true,
            notes: "did the work",
            commit: { path: "wanted.txt", contents: "here\n" },
          },
        ],
        WORK_REVIEWING: [{ submit: true }],
      },
    });

    const server = await serverFor(fixture);
    server.setSchedulerEnabled(true);
    await reaches(server, id, "READY_MANAGER_REVIEW");
    server.setSchedulerEnabled(false);

    fs.rmSync(path.join(server.runtime.worktree(id), "wanted.txt"));
    git.gitOrThrow(server.runtime.worktree(id), [
      "commit",
      "-qam",
      "remove it",
    ]);

    server.transition(
      id,
      "claim",
      { agentName: "manager", pid: process.pid },
      "manager",
    );

    expect(server.attemptMerge(id)).rejects.toThrow(/test -f wanted\.txt/);
    expect(stateOf(server, id)).toBe("MANAGER_REVIEWING");

    server.shutdown();
  }, 30000);

  test("the repo the work came from is read-only to everything the server spawns", async () => {
    const fixture = makeFixture();
    const id = readyTask(fixture, "Do a thing", [
      `echo x > ${path.join(fixture.repo, "poke")}`,
    ]);
    setPlan(fixture, {
      [id]: {
        WORKING: [
          {
            submit: true,
            notes: "did the work",
            commit: { path: "made.txt", contents: "here\n" },
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
      path.join(server.runtime.queueDir(id), "WORKING.md"),
      "utf-8",
    );
    expect(queued).toContain("Read-only file system");
    expect(fs.existsSync(path.join(fixture.repo, "poke"))).toBe(false);

    expect(
      git.gitOrThrow(server.runtime.worktree(id), ["log", "--oneline", "-1"]),
    ).toContain(`work on ${id}`);

    server.shutdown();
  }, 30000);
});

describe("the mcp surface", () => {
  async function connect(fixture: Fixture, cwd = fixture.repo) {
    fs.mkdirSync(fixture.tasksDir, { recursive: true });
    const agentsPath = path.join(fixture.tasksDir, "agents.json");
    if (!fs.existsSync(agentsPath)) {
      fs.writeFileSync(
        agentsPath,
        JSON.stringify({
          agents: [{ type: "pi", provider: "fake", model: "fake", slots: 1 }],
        }),
      );
    }
    const client = new Client({ name: "test", version: "1.0.0" });
    openClients.push(client);
    await client.connect(
      new StdioClientTransport({
        command: "bun",
        args: [
          path.join(import.meta.dir, "mcp.ts"),
          fixture.repo,
          fixture.tasksDir,
        ],
        cwd,
        env: {
          ...(process.env as Record<string, string>),
          TASK_GRAPH_SERVER_ROOT: fixture.serverRoot,
        },
      }),
    );
    return client;
  }

  function textOf(result: unknown): string {
    return (result as { content: { text: string }[] }).content[0]!.text;
  }

  test("the manager gets one tool per judgement it can make, plus the views", async () => {
    const fixture = makeFixture();
    const client = await connect(fixture);

    expect((await client.listTools()).tools.map((t) => t.name).sort()).toEqual([
      "agent_abort",
      "disable_agent",
      "disable_scheduler",
      "enable_agent",
      "enable_scheduler",
      "reload_prompts",
      "task_abort",
      "task_add_feedback",
      "task_claim",
      "task_create",
      "task_hold",
      "task_resume",
      "task_submit",
      "task_write_body",
    ]);
    expect(
      (await client.listResources()).resources.map((r) => r.uri).sort(),
    ).toEqual([
      "orchestrator://agents",
      "orchestrator://checks",
      "orchestrator://inbox",
      "orchestrator://paths",
      "orchestrator://queue",
      "orchestrator://tasks",
      "orchestrator://workspace_path",
    ]);

    const paths = await client.readResource({ uri: "orchestrator://paths" });
    const parsed = JSON.parse(
      (paths.contents as { text: string }[])[0]!.text,
    ) as Record<string, unknown>;
    expect(parsed.tasks_dir).toBe(fixture.tasksDir);
    expect(parsed.agents_file).toBe(path.join(fixture.tasksDir, "agents.json"));
    expect(parsed.overrides_prompts_dir).toBe(
      path.join(fixture.tasksDir, "prompts"),
    );

    await client.close();
  }, 60000);

  test("task_add_feedback sends the task back with the findings in the body and the queue", async () => {
    const fixture = makeFixture();
    const id = readyTask(fixture, "A task");
    applyTransition(fixture.tasksDir, id, "claim", {
      agentName: "manager",
      pid: process.pid,
    });
    applyTransition(fixture.tasksDir, id, "submit", {
      body: readTaskFile(path.join(fixture.tasksDir, `${id}.md`)).body,
    });
    applyTransition(fixture.tasksDir, id, "claim", {
      agentName: "server",
      pid: process.pid,
    });
    applyTransition(fixture.tasksDir, id, "pass", {});
    applyTransition(fixture.tasksDir, id, "claim", {
      agentName: "manager",
      pid: process.pid,
    });
    applyTransition(fixture.tasksDir, id, "submit", {});
    applyTransition(fixture.tasksDir, id, "claim", {
      agentName: "manager",
      pid: process.pid,
    });

    const client = await connect(fixture);
    const result = await client.callTool({
      name: "task_add_feedback",
      arguments: { id, findings: ["the null case is untested"] },
    });
    expect(textOf(result)).toContain('"READY_WORK"');

    const body = readTaskFile(path.join(fixture.tasksDir, `${id}.md`)).body;
    expect(body).toContain("# Review findings");
    expect(body).toContain("- the null case is untested");

    const queued = fs.readFileSync(
      path.join(
        fixture.serverRoot,
        repoKey(fixture.repo),
        id,
        "queue",
        "WORKING.md",
      ),
      "utf-8",
    );
    expect(queued).toContain("the null case is untested");

    await client.close();
  }, 60000);

  test("reload_prompts picks up an override written after startup", async () => {
    const fixture = makeFixture();
    readyTask(fixture, "Do a thing");
    const client = await connect(fixture);

    const before = JSON.parse(
      textOf(await client.callTool({ name: "reload_prompts", arguments: {} })),
    );
    const override = path.join(fixture.tasksDir, "prompts", "dispatch.md");
    expect(before).not.toContain(override);

    writeOverride(
      fixture,
      "prompts/dispatch.md",
      "Start on ../ASSIGNMENT.md.\n",
    );
    fs.mkdirSync(path.join(fixture.tasksDir, "prompts"), { recursive: true });
    fs.writeFileSync(override, "Start on ../ASSIGNMENT.md.\n");

    const after = JSON.parse(
      textOf(await client.callTool({ name: "reload_prompts", arguments: {} })),
    );
    expect(after).toContain(override);

    await client.close();
  }, 60000);

  test("task_create returns a path the manager can edit directly", async () => {
    const fixture = makeFixture();
    const client = await connect(fixture);

    const created = JSON.parse(
      textOf(
        await client.callTool({
          name: "task_create",
          arguments: { title: "new work" },
        }),
      ),
    );
    expect(created.id).toBe("000001");
    expect(fs.existsSync(created.filePath)).toBe(true);

    await client.close();
  }, 60000);

  test("task_write_body replaces the body and leaves the frontmatter alone", async () => {
    const fixture = makeFixture();
    const id = readyTask(fixture, "A task");
    const client = await connect(fixture);

    await client.callTool({
      name: "task_write_body",
      arguments: { id, body: "# Goal\n\nRewritten by the manager." },
    });

    const document = fs.readFileSync(
      path.join(fixture.tasksDir, `${id}.md`),
      "utf-8",
    );
    expect(document).toContain("Rewritten by the manager.");
    expect(document).toContain("state: READY_WORK");

    await client.close();
  }, 60000);

  test("a transition the state does not allow comes back as an error, not a mutation", async () => {
    const fixture = makeFixture();
    const id = readyTask(fixture, "A task");
    const client = await connect(fixture);

    const result = await client.callTool({
      name: "task_submit",
      arguments: { id },
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain(
      'Transition "submit" is not valid from state "READY_WORK"',
    );

    const document = fs.readFileSync(
      path.join(fixture.tasksDir, `${id}.md`),
      "utf-8",
    );
    expect(document).toContain("state: READY_WORK");

    await client.close();
  }, 60000);

  test("authoring runs create → write body → submit", async () => {
    const fixture = makeFixture();
    const client = await connect(fixture);

    const created = JSON.parse(
      textOf(
        await client.callTool({
          name: "task_create",
          arguments: { title: "new work" },
        }),
      ),
    );
    await client.callTool({
      name: "task_write_body",
      arguments: { id: created.id, body: "# Goal\n\nDo it." },
    });
    editTaskFile(fixture, created.id, (meta) => {
      meta.checks = ["bun test"];
    });
    const done = JSON.parse(
      textOf(
        await client.callTool({
          name: "task_submit",
          arguments: { id: created.id },
        }),
      ),
    );

    expect(done.from).toBe("NEW");
    expect(done.to).toBe("READY_PLAN");

    await client.close();
  }, 60000);

  test("a task with dependencies is submitted into BLOCKED", async () => {
    const fixture = makeFixture();
    const dep = readyTask(fixture, "the dependency");
    const client = await connect(fixture);

    const created = JSON.parse(
      textOf(
        await client.callTool({
          name: "task_create",
          arguments: { title: "the dependent" },
        }),
      ),
    );
    editTaskFile(fixture, created.id, (meta) => {
      meta.depends_on = [dep];
    });

    const done = JSON.parse(
      textOf(
        await client.callTool({
          name: "task_submit",
          arguments: { id: created.id },
        }),
      ),
    );
    expect(done.from).toBe("NEW");
    expect(done.to).toBe("BLOCKED");

    await client.close();
  }, 60000);

  test("task_submit closes the task once the graph updates are marked done", async () => {
    const fixture = makeFixture();
    const id = readyTask(fixture, "A task");
    applyTransition(fixture.tasksDir, id, "claim", {
      agentName: "manager",
      pid: process.pid,
    });
    applyTransition(fixture.tasksDir, id, "submit", {
      body: readTaskFile(path.join(fixture.tasksDir, `${id}.md`)).body,
    });
    applyTransition(fixture.tasksDir, id, "claim", {
      agentName: "manager",
      pid: process.pid,
    });
    applyTransition(fixture.tasksDir, id, "pass", {});
    applyTransition(fixture.tasksDir, id, "claim", {
      agentName: "manager",
      pid: process.pid,
    });
    applyTransition(fixture.tasksDir, id, "submit", {});
    applyTransition(fixture.tasksDir, id, "claim", {
      agentName: "manager",
      pid: process.pid,
    });
    editTaskFile(fixture, id, (meta) => {
      meta.task_graph_updates.push(
        { op: "add", message: "split this in two", done: false },
        { op: "add", message: "and delete the old one", done: false },
      );
    });
    applyTransition(fixture.tasksDir, id, "submit", {});

    const client = await connect(fixture);
    await client.callTool({ name: "task_claim", arguments: { id } });
    editTaskFile(fixture, id, (meta) => {
      for (const update of meta.task_graph_updates) {
        update.done = true;
      }
    });
    const result = JSON.parse(
      textOf(
        await client.callTool({
          name: "task_submit",
          arguments: { id },
        }),
      ),
    );

    expect(result.to).toBe("CLOSED");
    expect(
      fs.existsSync(path.join(fixture.tasksDir, "closed", `${id}.md`)),
    ).toBe(true);

    await client.close();
  }, 60000);

  test("task_submit from MANAGER_REVIEWING lands the work and closes the task", async () => {
    const fixture = makeFixture();
    const id = readyTask(fixture, "A task");
    setPlan(fixture, {
      [id]: {
        WORKING: [
          {
            submit: true,
            notes: "did the work",
            commit: { path: "a.txt", contents: "a" },
          },
        ],
        WORK_REVIEWING: [{ submit: true }],
      },
    });

    const server = await serverFor(fixture);
    server.setSchedulerEnabled(true);
    await reaches(server, id, "READY_MANAGER_REVIEW");
    server.setSchedulerEnabled(false);

    const client = await connect(fixture);
    await client.callTool({ name: "task_claim", arguments: { id } });
    const result = JSON.parse(
      textOf(await client.callTool({ name: "task_submit", arguments: { id } })),
    );

    expect(result.to).toBe("CLOSED");
    expect(
      fs.existsSync(path.join(fixture.tasksDir, "closed", `${id}.md`)),
    ).toBe(true);
    expect(fs.existsSync(path.join(fixture.repo, "a.txt"))).toBe(true);

    await client.close();
    server.shutdown();
  }, 60000);

  test("the views are readable as resources and carry a cursor", async () => {
    const fixture = makeFixture();
    readyTask(fixture, "A task");
    const client = await connect(fixture);

    await client.callTool({
      name: "task_create",
      arguments: { title: "another" },
    });

    const view = await client.readResource({ uri: "orchestrator://tasks" });
    const parsed = JSON.parse((view.contents as { text: string }[])[0]!.text);
    expect(parsed.seq).toBeGreaterThan(0);
    expect(Array.isArray(parsed.tasks)).toBe(true);

    const workspace = await client.readResource({
      uri: "orchestrator://workspace_path",
    });
    expect((workspace.contents as { text: string }[])[0]!.text).toContain(
      "task-graph-server",
    );

    await client.close();
  }, 60000);

  test("disable_agent and enable_agent move every slot of one agent", async () => {
    const fixture = makeFixture();
    fs.writeFileSync(
      path.join(fixture.tasksDir, "agents.json"),
      JSON.stringify({
        agents: [
          { type: "pi", provider: "a", model: "a", slots: 2 },
          { type: "pi", provider: "b", model: "b", slots: 1 },
        ],
      }),
    );
    const client = await connect(fixture);

    const disabled = JSON.parse(
      textOf(
        await client.callTool({
          name: "disable_agent",
          arguments: { agent: "pi-a-a" },
        }),
      ),
    ) as { name: string; state: string; enabled: boolean }[];

    expect(disabled.map((row) => row.name)).toEqual(["pi-a-a-1", "pi-a-a-2"]);
    expect(disabled.every((row) => row.state === "DISABLED")).toBe(true);

    const view = await client.readResource({ uri: "orchestrator://agents" });
    const parsed = JSON.parse((view.contents as { text: string }[])[0]!.text);
    expect(
      parsed.agents.map((agent: { name: string; state: string }) => [
        agent.name,
        agent.state,
      ]),
    ).toEqual([
      ["pi-a-a-1", "DISABLED"],
      ["pi-a-a-2", "DISABLED"],
      ["pi-b-b-1", "IDLE"],
    ]);

    const enabled = JSON.parse(
      textOf(
        await client.callTool({
          name: "enable_agent",
          arguments: { agent: "pi-a-a" },
        }),
      ),
    ) as { state: string }[];
    expect(enabled.every((row) => row.state === "IDLE")).toBe(true);

    await client.close();
  }, 60000);

  test("the pool is read from the tasks directory", async () => {
    const fixture = makeFixture();
    fs.writeFileSync(
      path.join(fixture.tasksDir, "agents.json"),
      JSON.stringify({
        agents: [{ type: "pi", provider: "tasks", model: "tasks", slots: 2 }],
      }),
    );
    const client = await connect(fixture);

    const view = await client.readResource({ uri: "orchestrator://agents" });
    const parsed = JSON.parse((view.contents as { text: string }[])[0]!.text);
    expect(parsed.agents.map((agent: { name: string }) => agent.name)).toEqual([
      "pi-tasks-tasks-1",
      "pi-tasks-tasks-2",
    ]);

    await client.close();
  }, 60000);
});

describe("the server: the reaper", () => {
  test("a claim whose process is gone is released", async () => {
    const fixture = makeFixture();
    const id = readyTask(fixture, "A task");

    const dead = Bun.spawn(["true"]);
    await dead.exited;

    applyTransition(fixture.tasksDir, id, "claim", {
      agentName: "pi-fake-fake-1",
      pid: dead.pid,
      branch: `task/${id}`,
      worktree: "/tmp/gone",
    });

    const server = await serverFor(fixture);
    expect(stateOf(server, id)).toBe("WORKING");

    await server.tick();

    expect(stateOf(server, id)).toBe("READY_WORK");
    expect(server.tasks().get(id)!.claimed_by).toBeNull();
    expect(server.tasks().get(id)!.workspace).not.toBeNull();
    expect(
      server.transitions.read().some((e) => e.transition === "release"),
    ).toBe(true);

    server.shutdown();
  }, 30000);

  test("an agent that dies mid-task frees its slot and releases the task", async () => {
    const fixture = makeFixture();
    const id = readyTask(fixture, "A task the agent dies on");
    setPlan(fixture, { [id]: { WORKING: [{ die: true }] } });

    const server = await serverFor(fixture);
    server.setSchedulerEnabled(true);

    await until(server, () => stateOf(server, id) === "WORKING");
    server.setSchedulerEnabled(false);
    await until(server, () => stateOf(server, id) === "READY_WORK");

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

    applyTransition(fixture.tasksDir, id, "claim", {
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

    expect(stateOf(server, id)).toBe("READY_WORK");
    expect(server.agentRows()[0]!.state).toBe("IDLE");

    server.shutdown();
  }, 30000);

  test("a slot whose process died no longer shields the task from the reaper", async () => {
    const fixture = makeFixture();
    const id = readyTask(fixture, "A task the agent dies on");
    setPlan(fixture, { [id]: { WORKING: [{ die: true }] } });

    const server = await serverFor(fixture);
    server.setSchedulerEnabled(true);

    await until(server, () => stateOf(server, id) === "WORKING");
    server.setSchedulerEnabled(false);

    await until(server, () =>
      server.transitions
        .read()
        .some((e) => e.transition === "release" && e.by === "server"),
    );

    server.shutdown();
  }, 30000);

  test("a check running for a merge is not reaped out from under it", async () => {
    const fixture = makeFixture();
    const id = readyTask(fixture, "A task being merged", ["true"]);
    setPlan(fixture, {
      [id]: {
        WORKING: [
          {
            submit: true,
            notes: "did the work",
            commit: { path: "a.txt", contents: "a\n" },
          },
        ],
        WORK_REVIEWING: [{ submit: true }],
      },
    });

    const server = await serverFor(fixture);
    server.setSchedulerEnabled(true);
    await reaches(server, id, "READY_MANAGER_REVIEW");
    server.setSchedulerEnabled(false);

    const dead = Bun.spawn(["true"]);
    await dead.exited;

    applyTransition(fixture.tasksDir, id, "claim", {
      agentName: "manager",
      pid: dead.pid,
    });
    editTaskFile(fixture, id, (meta) => {
      meta.checks.push("sleep 2");
    });
    expect(stateOf(server, id)).toBe("MANAGER_REVIEWING");

    const merging = server.attemptMerge(id);
    await until(server, () => server.checks.isRunning(id), 20);

    await server.tick();
    expect(stateOf(server, id)).toBe("MANAGER_REVIEWING");
    expect(server.tasks().get(id)!.claimed_by).toBe("manager");

    expect((await merging).to).toBe("CLOSED");

    server.shutdown();
  }, 30000);

  test("a live claim is left alone", async () => {
    const fixture = makeFixture();
    const id = readyTask(fixture, "A task");
    applyTransition(fixture.tasksDir, id, "claim", {
      agentName: "pi-fake-fake-1",
      pid: process.pid,
    });

    const server = await serverFor(fixture);
    await server.tick();

    expect(stateOf(server, id)).toBe("WORKING");

    server.shutdown();
  }, 30000);
});

describe("the server: an abort that races a dispatch", () => {
  function abortable(fixture: Fixture, server: Server, id: string): void {
    server.transition(id, "hold", { reason: "abandoning" }, "manager");
    editTaskFile(fixture, id, (meta) => {
      meta.task_graph_updates.push({
        op: "add",
        message: "split this into two tasks that are actually separable",
        done: false,
      });
    });
    server.attemptAbort(id);
  }

  test("a task aborted while its agent is spawning is not claimed into TASK_GRAPH_UPDATING", async () => {
    const fixture = makeFixture();
    const id = readyTask(fixture, "A task the manager throws away");
    setPlan(fixture, {
      [id]: { WORKING: [{ new_session_delay_ms: 500, submit: true }] },
    });

    const server = await serverFor(fixture);
    server.setSchedulerEnabled(true);

    const ticking = server.tick();
    await Bun.sleep(150);
    expect(stateOf(server, id)).toBe("READY_WORK");

    abortable(fixture, server, id);
    expect(stateOf(server, id)).toBe("READY_TASK_GRAPH_UPDATE");

    await ticking;
    await server.drain();

    expect(stateOf(server, id)).toBe("READY_TASK_GRAPH_UPDATE");
    expect(server.tasks().get(id)!.claimed_by).toBeNull();
    expect(
      server.transitions
        .read()
        .some((e) => e.task_id === id && e.transition === "claim"),
    ).toBe(false);

    server.shutdown();
  }, 30000);

  test("the slot a lost dispatch was using is released, not stranded", async () => {
    const fixture = makeFixture();
    const id = readyTask(fixture, "A task the manager throws away");
    setPlan(fixture, {
      [id]: { WORKING: [{ new_session_delay_ms: 500, submit: true }] },
    });

    const server = await serverFor(fixture);
    server.setSchedulerEnabled(true);

    const ticking = server.tick();
    await Bun.sleep(150);
    abortable(fixture, server, id);
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
      [id]: { WORKING: [{ new_session_delay_ms: 200, submit: true }] },
    });

    const server = await serverFor(fixture);
    server.setSchedulerEnabled(true);

    await server.tick();

    expect(stateOf(server, id)).toBe("WORKING");
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
        WORKING: [
          {
            submit: true,
            notes: "did the work",
            commit: { path: "a.txt", contents: "a\n" },
          },
        ],
        WORK_REVIEWING: [{ submit: true }],
      },
    });
    corrupt(fixture, broken);

    const server = await serverFor(fixture);
    server.setSchedulerEnabled(true);

    await reaches(server, fine, "READY_MANAGER_REVIEW");
    expect(server.tasks().has(broken)).toBe(false);

    server.shutdown();
  }, 30000);

  test("one unreadable task does not stop the reaper", async () => {
    const fixture = makeFixture();
    const broken = readyTask(fixture, "A task with bad frontmatter");
    const claimed = readyTask(fixture, "A task whose agent is gone");

    const dead = Bun.spawn(["true"]);
    await dead.exited;

    applyTransition(fixture.tasksDir, claimed, "claim", {
      agentName: "pi-fake-fake-1",
      pid: dead.pid,
      branch: `task/${claimed}`,
      worktree: "/tmp/gone",
    });
    corrupt(fixture, broken);

    const server = await serverFor(fixture);
    expect(stateOf(server, claimed)).toBe("WORKING");

    await server.tick();

    expect(stateOf(server, claimed)).toBe("READY_WORK");

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

describe("the server: enabling and disabling an agent", () => {
  function pool(fixture: Fixture, entries: Record<string, unknown>[]): void {
    fs.writeFileSync(fixture.agentsPath, JSON.stringify({ agents: entries }));
  }

  test("an agent configured disabled is never dispatched to", async () => {
    const fixture = makeFixture();
    const id = readyTask(fixture, "A task nobody picks up");
    pool(fixture, [
      { type: "pi", provider: "fake", model: "fake", enabled: false },
    ]);
    setPlan(fixture, { [id]: { WORKING: [{ submit: true }] } });

    const server = await serverFor(fixture);
    server.setSchedulerEnabled(true);
    await settle(server);

    expect(stateOf(server, id)).toBe("READY_WORK");
    expect(server.agentRows()[0]!.state).toBe("DISABLED");
    expect(server.agentRows()[0]!.enabled).toBe(false);

    server.shutdown();
  }, 30000);

  test("disabling an agent disables every one of its slots", async () => {
    const fixture = makeFixture();
    pool(fixture, [
      { type: "pi", provider: "fake", model: "fake", slots: 3 },
      { type: "pi", provider: "other", model: "other", slots: 1 },
    ]);

    const server = await serverFor(fixture);
    expect(server.agentRows().every((row) => row.enabled)).toBe(true);

    const rows = server.setAgentEnabled("pi-fake-fake", false);
    expect(rows).toHaveLength(3);
    expect(rows.every((row) => row.state === "DISABLED")).toBe(true);

    const untouched = server
      .agentRows()
      .filter((row) => row.agent === "pi-other-other");
    expect(untouched).toHaveLength(1);
    expect(untouched[0]!.state).toBe("IDLE");

    server.shutdown();
  }, 30000);

  test("a disabled agent takes no work and a re-enabled one takes it again", async () => {
    const fixture = makeFixture();
    const id = readyTask(fixture, "A task", ["true"]);
    setPlan(fixture, {
      [id]: {
        WORKING: [
          {
            submit: true,
            notes: "did the work",
            commit: { path: "a.txt", contents: "a\n" },
          },
        ],
        WORK_REVIEWING: [{ submit: true }],
      },
    });

    const server = await serverFor(fixture);
    server.setAgentEnabled("pi-fake-fake", false);
    server.setSchedulerEnabled(true);
    await settle(server);

    expect(stateOf(server, id)).toBe("READY_WORK");

    server.setAgentEnabled("pi-fake-fake", true);
    await reaches(server, id, "READY_MANAGER_REVIEW");

    server.shutdown();
  }, 30000);

  test("a slot running when its agent is disabled finishes that task first", async () => {
    const fixture = makeFixture();
    const id = readyTask(fixture, "A slow task");
    setPlan(fixture, {
      [id]: {
        WORKING: [
          {
            start_delay_ms: 250,
            submit: true,
            notes: "did the work",
            commit: { path: "a.txt", contents: "a\n" },
          },
        ],
      },
    });

    const server = await serverFor(fixture);
    server.setSchedulerEnabled(true);

    await server.tick();
    expect(stateOf(server, id)).toBe("WORKING");

    const disabled = server.setAgentEnabled("pi-fake-fake", false);
    expect(disabled[0]!.enabled).toBe(false);
    expect(disabled[0]!.state).not.toBe("DISABLED");
    expect(disabled[0]!.task_id).toBe(id);

    await server.drain();
    await settle(server);

    expect(server.agentRows()[0]!.state).toBe("DISABLED");
    expect(server.agentRows()[0]!.task_id).toBeNull();
    expect(stateOf(server, id)).toBe("READY_WORK_REVIEW");

    server.shutdown();
  }, 30000);

  test("an agent that is not in the pool is refused", async () => {
    const fixture = makeFixture();
    const server = await serverFor(fixture);

    expect(() => server.setAgentEnabled("pi-fake-fake-1", false)).toThrow(
      /no agent named "pi-fake-fake-1"/,
    );
    expect(() => server.setAgentEnabled("nope", true)).toThrow(
      /the pool has pi-fake-fake/,
    );

    server.shutdown();
  }, 30000);
});

describe("the server: aborting an agent", () => {
  test("aborting a busy slot resolves, the slot goes IDLE and the task is harvested", async () => {
    const fixture = makeFixture();
    const id = readyTask(fixture, "A task to abort");
    setPlan(fixture, {
      [id]: { WORKING: [{ notes: "still going", busy_ms: 5000 }] },
    });

    const server = await serverFor(fixture);
    server.setSchedulerEnabled(true);
    await server.tick();

    expect(stateOf(server, id)).toBe("WORKING");
    const row = server.agentRows()[0]!;
    expect(row.state).toBe("BUSY");

    server.abortAgent(row.name);
    server.setSchedulerEnabled(false);
    await server.drain();

    await until(
      server,
      () => {
        const after = server.agentRows()[0]!;
        return after.state === "IDLE" && stateOf(server, id) === "READY_WORK";
      },
      20,
    );

    const after = server.agentRows()[0]!;
    expect(after.state).toBe("IDLE");
    expect(after.task_id).toBeNull();

    server.shutdown();
  }, 30000);

  test("aborting an IDLE slot throws", async () => {
    const fixture = makeFixture();
    const server = await serverFor(fixture);

    expect(() => server.abortAgent("pi-fake-fake-1")).toThrow(/not running/);

    server.shutdown();
  }, 30000);

  test("aborting an unknown slot name throws, listing the pool's slot names", async () => {
    const fixture = makeFixture();
    const server = await serverFor(fixture);

    expect(() => server.abortAgent("pi-nobody-1")).toThrow(
      /no agent slot named "pi-nobody-1"/,
    );
    expect(() => server.abortAgent("pi-nobody-1")).toThrow(/pi-fake-fake-1/);

    server.shutdown();
  }, 30000);

  test("aborting by agent key (no slot suffix) throws", async () => {
    const fixture = makeFixture();
    const server = await serverFor(fixture);

    expect(() => server.abortAgent("pi-fake-fake")).toThrow(
      /no agent slot named "pi-fake-fake"/,
    );

    server.shutdown();
  }, 30000);

  test("a slot that is BUSY but whose activity is none is refused", async () => {
    const fixture = makeFixture();
    const server = await serverFor(fixture);
    const worker = (
      server as unknown as {
        workers: Map<
          string,
          {
            process: {
              alive: boolean;
              stream: { state: { activity: { kind: string } } };
              abort: () => void;
              kill: () => void;
              close: () => void;
            };
          }
        >;
      }
    ).workers.get("pi-fake-fake-1")!;

    worker.process = {
      alive: true,
      stream: { state: { activity: { kind: "none" } } },
      abort: () => {},
      kill: () => {},
      close: () => {},
    };

    expect(() => server.abortAgent("pi-fake-fake-1")).toThrow(
      /not doing anything to abort/,
    );

    server.shutdown();
  }, 30000);

  test("a written agent_abort command file drives applyCommand and aborts the slot", async () => {
    const fixture = makeFixture();
    const id = readyTask(fixture, "A task to abort via command");
    setPlan(fixture, {
      [id]: { WORKING: [{ notes: "still going", busy_ms: 5000 }] },
    });

    const server = await serverFor(fixture);
    server.setSchedulerEnabled(true);
    await server.tick();
    expect(stateOf(server, id)).toBe("WORKING");

    writeCommand(server.runtime, {
      command: "agent_abort",
      "agent-name-slot": "pi-fake-fake-1",
    });
    for (let waited = 0; waited < 200; waited++) {
      await Bun.sleep(10);
      const log = fs.readFileSync(server.runtime.serverLog, "utf-8");
      if (log.includes("aborted")) {
        break;
      }
    }
    server.setSchedulerEnabled(false);
    await server.drain();
    await settle(server, 2);

    expect(server.agentRows()[0]!.state).toBe("IDLE");
    expect(fs.readFileSync(server.runtime.serverLog, "utf-8")).toContain(
      "aborted",
    );

    server.shutdown();
  }, 30000);

  test("a written agent_abort naming an idle slot is logged and dropped", async () => {
    const fixture = makeFixture();
    const server = await serverFor(fixture);

    writeCommand(server.runtime, {
      command: "agent_abort",
      "agent-name-slot": "pi-fake-fake-1",
    });
    for (let waited = 0; waited < 200; waited++) {
      await Bun.sleep(10);
      const log = fs.readFileSync(server.runtime.serverLog, "utf-8");
      if (log.includes("refused")) {
        break;
      }
    }

    expect(fs.readFileSync(server.runtime.serverLog, "utf-8")).toContain(
      "not running",
    );

    server.shutdown();
  }, 30000);
});

describe("the server: detaching", () => {
  test("a slot still running for a previous manager is not offered as capacity", async () => {
    const fixture = makeFixture();
    const id = readyTask(fixture, "A task");

    const alive = Bun.spawn(["sleep", "30"]);
    const runtimeDir = path.join(fixture.serverRoot, repoKey(fixture.repo));
    fs.mkdirSync(runtimeDir, { recursive: true });
    fs.writeFileSync(
      path.join(runtimeDir, "agents.json"),
      JSON.stringify({
        at: new Date().toISOString(),
        seq: 1,
        agents: [
          {
            name: "pi-fake-fake-1",
            type: "pi",
            provider: "fake",
            model: "fake",
            slot: 1,
            state: "BUSY",
            task_id: id,
            role: "worker",
            pid: alive.pid,
            started_at: new Date().toISOString(),
            activity: { kind: "none" },
            tokens: null,
            context_percent: null,
            session: "/tmp/s.jsonl",
            log: null,
          },
        ],
      }),
    );

    applyTransition(fixture.tasksDir, id, "claim", {
      agentName: "pi-fake-fake-1",
      pid: alive.pid,
    });

    const second = await serverFor(fixture);
    second.setSchedulerEnabled(true);
    await second.tick();
    await second.drain();

    const view = JSON.parse(
      fs.readFileSync(second.runtime.agentsView, "utf-8"),
    );
    expect(view.agents[0].state).toBe("BUSY");
    expect(view.agents[0].pid).toBe(alive.pid);
    expect(stateOf(second, id)).toBe("WORKING");

    alive.kill();
    second.shutdown();
  }, 30000);
});

describe("the server: the agent view", () => {
  test("tokens, context and the session file reach the view", async () => {
    const fixture = makeFixture();
    const id = readyTask(fixture, "A task");
    setPlan(fixture, {
      [id]: { WORKING: [{ notes: "still going", busy_ms: 3000 }] },
    });

    const server = await serverFor(fixture);
    server.setSchedulerEnabled(true);
    await server.tick();

    const view = JSON.parse(
      fs.readFileSync(server.runtime.agentsView, "utf-8"),
    );
    const busy = view.agents.find(
      (agent: { task_id: string | null }) => agent.task_id === id,
    );

    expect(busy.state).toBe("BUSY");
    expect(busy.tokens).toBe(105000);
    expect(busy.context_percent).toBe(30);
    expect(busy).not.toHaveProperty("cost");
    expect(busy.session).toContain("session/worker");

    await server.drain();
    server.shutdown();
  }, 30000);

  test("a closed task stays in the tasks view", async () => {
    const fixture = makeFixture();
    const id = readyTask(fixture, "A task");
    setPlan(fixture, {
      [id]: {
        WORKING: [
          {
            submit: true,
            notes: "did the work",
            commit: { path: "a.txt", contents: "a" },
          },
        ],
        WORK_REVIEWING: [{ submit: true }],
      },
    });

    const server = await serverFor(fixture);
    server.setSchedulerEnabled(true);
    await reaches(server, id, "READY_MANAGER_REVIEW");
    server.setSchedulerEnabled(false);

    server.transition(
      id,
      "claim",
      { agentName: "manager", pid: process.pid },
      "manager",
    );
    await server.attemptMerge(id);
    await server.writeViews();

    const view = JSON.parse(fs.readFileSync(server.runtime.tasksView, "utf-8"));
    const row = view.tasks.find((task: { id: string }) => task.id === id);

    expect(row).toBeDefined();
    expect(row.state).toBe("CLOSED");
    expect(row.title).toBe("A task");
    expect(row.claimed_by).toBeNull();

    server.shutdown();
  }, 30000);
});

describe("the server: a throw while finishing an agent", () => {
  test("the slot is freed and the manager survives instead of rejecting into nothing", async () => {
    const fixture = makeFixture();
    const id = readyTask(fixture, "A task");
    setPlan(fixture, {
      [id]: { WORKING: [{ stop_reason: "aborted", break_git: true }] },
    });

    const server = await serverFor(fixture);
    server.setSchedulerEnabled(true);
    await server.tick();
    server.setSchedulerEnabled(false);
    await server.drain();
    await server.writeViews();

    const view = JSON.parse(
      fs.readFileSync(server.runtime.agentsView, "utf-8"),
    );
    for (const agent of view.agents as { state: string }[]) {
      expect(agent.state).toBe("IDLE");
    }
    expect(fs.readFileSync(server.runtime.serverLog, "utf-8")).toContain(
      `on ${id} failed:`,
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
        WORKING: [
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
        WORK_REVIEWING: [{ submit: true }],
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
    expect(afterFailure.state).toBe("READY_WORK");
    expect(afterFailure.workspace!.session).not.toBeNull();

    server.setSchedulerEnabled(true);
    await reaches(server, id, "READY_MANAGER_REVIEW");
    server.setSchedulerEnabled(false);

    const history = fs.readdirSync(server.runtime.history(id));
    expect(history).toHaveLength(0);

    const claims = server.transitions
      .read()
      .filter((e) => e.transition === "claim" && e.to === "WORKING");
    expect(claims).toHaveLength(2);

    server.shutdown();
  }, 30000);

  test("the resume prompt carries every failing command into the session", async () => {
    const fixture = makeFixture();
    const id = readyTask(fixture, "Do a thing", ["test -f fixed.txt"]);
    setPlan(fixture, {
      [id]: {
        WORKING: [
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
        WORK_REVIEWING: [{ submit: true }],
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
    expect(prompts[1]).toContain("Fix each one in this worktree");

    server.shutdown();
  }, 30000);

  test("a session opened under an older role directory is reopened where it lies", async () => {
    const fixture = makeFixture();
    const id = readyTask(fixture, "Do a thing", ["test -f fixed.txt"]);
    setPlan(fixture, {
      [id]: {
        WORKING: [
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

    expect(stateOf(server, id)).toBe("WORKING");
    const view = JSON.parse(
      fs.readFileSync(server.runtime.agentsView, "utf-8"),
    );
    expect(view.agents[0].state).toBe("BUSY");
    expect(view.agents[0].session).toBe(legacy);
    expect(server.tasks().get(id)!.workspace!.session).toBe(legacy);

    server.shutdown();
  }, 30000);
});

describe("the server: a review that comes back unusable", () => {
  test("a malformed result is prompted about in place, without leaving WORK_REVIEWING", async () => {
    const fixture = makeFixture();
    const id = readyTask(fixture, "Do a thing");
    setPlan(fixture, {
      [id]: {
        WORKING: [
          {
            submit: true,
            notes: "did the work",
            commit: { path: "a.txt", contents: "a" },
          },
        ],
        WORK_REVIEWING: [
          { result_tool: { name: "submit", args: {} } },
          { submit: true },
        ],
      },
    });

    const server = await serverFor(fixture);
    server.setSchedulerEnabled(true);
    await reaches(server, id, "READY_MANAGER_REVIEW");
    server.setSchedulerEnabled(false);

    const log = server.transitions.read();
    expect(log.some((e) => e.transition === "fail")).toBe(false);
    expect(
      log.filter((e) => e.transition === "claim" && e.to === "WORK_REVIEWING"),
    ).toHaveLength(1);

    const prompts = promptsTo(server.runtime.sessionDir(id, "reviewer"));
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain("not a valid result");
    expect(prompts[1]).toContain("findings");

    server.shutdown();
  }, 30000);

  test("a review that delegates work leaves it for the manager to read", async () => {
    const fixture = makeFixture();
    const id = readyTask(fixture, "Do a thing");
    setPlan(fixture, {
      [id]: {
        WORKING: [
          {
            submit: true,
            notes: "did the work",
            commit: { path: "a.txt", contents: "a" },
          },
        ],
        WORK_REVIEWING: [
          { submit: true, delegations: ["the same bug lives in fetch.ts"] },
        ],
      },
    });

    const server = await serverFor(fixture);
    server.setSchedulerEnabled(true);
    await reaches(server, id, "READY_MANAGER_REVIEW");
    server.setSchedulerEnabled(false);

    server.shutdown();
  }, 30000);
});

describe("the server: closing", () => {
  test("merged tears the worktree and the branch down", async () => {
    const fixture = makeFixture();
    const id = readyTask(fixture, "A task");
    setPlan(fixture, {
      [id]: {
        WORKING: [
          {
            submit: true,
            notes: "did the work",
            commit: { path: "a.txt", contents: "a" },
          },
        ],
        WORK_REVIEWING: [{ submit: true }],
      },
    });

    const server = await serverFor(fixture);
    server.setSchedulerEnabled(true);
    await reaches(server, id, "READY_MANAGER_REVIEW");
    server.setSchedulerEnabled(false);

    server.transition(
      id,
      "claim",
      { agentName: "manager", pid: process.pid },
      "manager",
    );
    expect((await server.attemptMerge(id)).to).toBe("CLOSED");

    expect(fs.existsSync(server.runtime.worktree(id))).toBe(false);
    expect(git.branchExists(fixture.repo, `task/${id}`)).toBe(false);
    expect(fs.existsSync(path.join(fixture.repo, "a.txt"))).toBe(true);
  }, 30000);

  test("merged with queued graph updates stops at the update state", async () => {
    const fixture = makeFixture();
    const id = readyTask(fixture, "A task");
    setPlan(fixture, {
      [id]: {
        WORKING: [
          {
            submit: true,
            notes: "did the work",
            commit: { path: "a.txt", contents: "a" },
          },
        ],
        WORK_REVIEWING: [{ submit: true }],
      },
    });

    const server = await serverFor(fixture);
    server.setSchedulerEnabled(true);
    await reaches(server, id, "READY_MANAGER_REVIEW");
    server.setSchedulerEnabled(false);

    server.transition(
      id,
      "claim",
      { agentName: "manager", pid: process.pid },
      "manager",
    );
    editTaskFile(fixture, id, (meta) => {
      meta.task_graph_updates.push({
        op: "add",
        message: "the follow-up this uncovered",
        done: false,
      });
    });
    await server.attemptMerge(id);

    expect(stateOf(server, id)).toBe("READY_TASK_GRAPH_UPDATE");
    expect(git.branchExists(fixture.repo, `task/${id}`)).toBe(false);
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
        WORKING: [
          {
            submit: true,
            notes: "did the work",
            commit: { path: "a.txt", contents: "a" },
          },
        ],
        WORK_REVIEWING: [{ submit: true }],
      },
    });

    const server = await serverFor(fixture);
    server.setSchedulerEnabled(true);
    await reaches(server, id, "READY_MANAGER_REVIEW");
    server.setSchedulerEnabled(false);
    server.transition(
      id,
      "claim",
      { agentName: "manager", pid: process.pid },
      "manager",
    );

    return { fixture, server, id };
  }

  test("abort takes a branch that never landed, and tears it down at CLOSED", async () => {
    const { fixture, server, id } = await atManagerReview();
    editTaskFile(fixture, id, (meta) => {
      meta.task_graph_updates.push({
        op: "add",
        message: "this task was the wrong shape",
        done: false,
      });
    });

    expect(server.attemptAbort(id).to).toBe("READY_TASK_GRAPH_UPDATE");
    expect(git.branchExists(fixture.repo, `task/${id}`)).toBe(true);
    expect(fs.existsSync(path.join(fixture.repo, "a.txt"))).toBe(false);

    server.transition(
      id,
      "claim",
      { agentName: "graph-agent", pid: process.pid },
      "manager",
    );
    editTaskFile(fixture, id, (meta) => {
      meta.task_graph_updates[0]!.done = true;
    });
    expect(server.transition(id, "submit", {}, "manager").to).toBe("CLOSED");
    expect(git.branchExists(fixture.repo, `task/${id}`)).toBe(false);
    expect(fs.existsSync(server.runtime.worktree(id))).toBe(false);
  }, 30000);

  test("abort takes a task still queued in READY_WORK, via HELD_WORK", async () => {
    const fixture = makeFixture();
    const id = readyTask(fixture, "A task nobody should start");
    const server = await serverFor(fixture);
    server.transition(id, "hold", { reason: "abandoning" }, "manager");
    editTaskFile(fixture, id, (meta) => {
      meta.task_graph_updates.push({
        op: "add",
        message: "the two tasks this should have been",
        done: false,
      });
    });

    expect(server.attemptAbort(id).to).toBe("READY_TASK_GRAPH_UPDATE");
    expect(git.branchExists(fixture.repo, `task/${id}`)).toBe(false);

    server.transition(
      id,
      "claim",
      { agentName: "graph-agent", pid: process.pid },
      "manager",
    );
    editTaskFile(fixture, id, (meta) => {
      meta.task_graph_updates[0]!.done = true;
    });
    expect(server.transition(id, "submit", {}, "manager").to).toBe("CLOSED");
  }, 30000);

  test("abort refuses a task an agent is already working on", async () => {
    const fixture = makeFixture();
    const id = readyTask(fixture, "A task in flight");
    applyTransition(fixture.tasksDir, id, "claim", {
      agentName: "pi-fake-fake-1",
      pid: process.pid,
      branch: `task/${id}`,
      worktree: "/tmp/gone",
    });

    const server = await serverFor(fixture);
    expect(stateOf(server, id)).toBe("WORKING");

    expect(() => server.attemptAbort(id)).toThrow(
      /is not in MANAGER_REVIEWING or HELD_PLAN or HELD_WORK/,
    );
    expect(stateOf(server, id)).toBe("WORKING");
  }, 30000);

  test("abort refuses a branch that already landed", async () => {
    const { fixture, server, id } = await atManagerReview();
    editTaskFile(fixture, id, (meta) => {
      meta.task_graph_updates.push({
        op: "add",
        message: "too late",
        done: false,
      });
    });
    git.gitOrThrow(fixture.repo, ["merge", "--ff-only", `task/${id}`]);

    expect(() => server.attemptAbort(id)).toThrow(/already part of master/);
    expect(stateOf(server, id)).toBe("MANAGER_REVIEWING");
  }, 30000);

  test("closing a task deletes its runtime directory", async () => {
    const fixture = makeFixture();
    const id = readyTask(fixture, "A task");
    setPlan(fixture, {
      [id]: {
        WORKING: [
          {
            submit: true,
            notes: "did the work",
            commit: { path: "a.txt", contents: "a" },
          },
        ],
        WORK_REVIEWING: [{ submit: true }],
      },
    });

    const server = await serverFor(fixture);
    server.setSchedulerEnabled(true);
    await reaches(server, id, "READY_MANAGER_REVIEW");
    server.setSchedulerEnabled(false);

    server.transition(
      id,
      "claim",
      { agentName: "manager", pid: process.pid },
      "manager",
    );
    expect(fs.existsSync(server.runtime.taskDir(id))).toBe(true);
    await server.attemptMerge(id);
    expect(stateOf(server, id)).toBe("CLOSED");
    expect(fs.existsSync(server.runtime.taskDir(id))).toBe(false);

    for (let i = 0; i < 101; i++) {
      const other = readyTask(fixture, `filler ${i}`);
      server.transition(
        other,
        "claim",
        { agentName: "filler", pid: process.pid },
        "test",
      );
    }
    await server.writeViews();

    expect(fs.existsSync(server.runtime.taskDir(id))).toBe(false);
    const view = JSON.parse(fs.readFileSync(server.runtime.tasksView, "utf-8"));
    expect(view.tasks.some((t: { id: string }) => t.id === id)).toBe(false);
  }, 60000);
});
