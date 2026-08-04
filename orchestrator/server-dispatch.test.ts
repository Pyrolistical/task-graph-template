import { describe, expect } from "bun:test";
import { tempDir, test } from "./temp.ts";
import fs from "node:fs";
import path from "node:path";
import { applyTransition } from "./transition.ts";
import { takeClaim } from "./claim.ts";
import { findTaskFile, readTaskFile, writeTaskBody } from "./task.ts";
import { defaultTasksDir } from "./runtime.ts";
import * as git from "./git.ts";
import {
  commitGraph,
  makeFixture,
  promptsTo,
  readyTask,
  setBody,
  setPlan,
  steersTo,
  unplannedTask,
  writeOverride,
} from "./fixture.ts";
import { Server } from "./server.ts";
import { ISSUES } from "./prompts.ts";
import { reaches, serverFor, settle, stateOf, until } from "./server-jig.ts";

describe("the server: the default tasks directory", () => {
  test("with no tasks dir the server resolves ~/task-graph/<key> and seeds the graph", async () => {
    const fixture = makeFixture();
    const root = tempDir("task-graph-root-");
    const previous = process.env.TASK_GRAPH_TASKS_ROOT;
    process.env.TASK_GRAPH_TASKS_ROOT = root;
    try {
      const tasksDir = defaultTasksDir(fixture.repo);

      const server = await Server.start({
        repo: fixture.repo,
        serverRoot: fixture.serverRoot,
        piCommand: fixture.piCommand,
        base: "master",
      });

      expect(server.tasksDir).toBe(tasksDir);
      expect(server.overridesDir).toBe(tasksDir);
      expect(fs.existsSync(path.join(tasksDir, "agents.json"))).toBe(true);
      expect(fs.existsSync(path.join(tasksDir, "template.md"))).toBe(false);
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
        WORK: [
          {
            submit: true,
            notes: "wrote hello.txt and ran the check",
            commit: { path: "hello.txt", contents: "hello\n" },
          },
        ],
        WORK_REVIEW: [{ submit: true }],
      },
    });

    const server = await serverFor(fixture);
    server.setSchedulerEnabled(true);

    await reaches(server, id, "MANAGER_REVIEW");

    const merged = await server.attemptMerge(id);

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

describe("the server: how fast an agent writes", () => {
  test("the output tokens of every message land in the pool's rate table", async () => {
    const fixture = makeFixture();
    const id = readyTask(fixture, "Add a greeting", ["true"]);

    setPlan(fixture, {
      [id]: {
        WORK: [
          {
            submit: true,
            notes: "wrote hello.txt",
            output_tokens: 500,
            commit: { path: "hello.txt", contents: "hello\n" },
          },
        ],
        WORK_REVIEW: [{ submit: true, output_tokens: 100 }],
      },
    });

    const server = await serverFor(fixture);
    server.setSchedulerEnabled(true);

    await reaches(server, id, "MANAGER_REVIEW");

    expect(server.rates.rate("pi-fake-fake")).toBeGreaterThan(0);
    expect(server.rates.rate("pi-other-other")).toBeNull();

    server.shutdown();
  }, 30000);
});

describe("the server: the planning phase", () => {
  test("a plan is written, reviewed and accepted before the work starts", async () => {
    const fixture = makeFixture();
    const id = unplannedTask(fixture, "Add a greeting", ["test -f hello.txt"]);

    setPlan(fixture, {
      [id]: {
        DESIGN: [{ design: "the design", submit: true }],
        DESIGN_REVIEW: [{ submit: true }],
        PLAN: [
          {
            todos: ["write hello.txt", "run the check"],
            notes: "the plan",
            submit: true,
          },
        ],
        PLAN_REVIEW: [{ submit: true }],
        WORK: [
          {
            submit: true,
            notes: "wrote hello.txt and ran the check",
            commit: { path: "hello.txt", contents: "hello\n" },
          },
        ],
        WORK_REVIEW: [{ submit: true }],
      },
    });

    const server = await serverFor(fixture);
    server.setSchedulerEnabled(true);

    await reaches(server, id, "WORK");

    const body = fs.readFileSync(
      path.join(fixture.tasksDir, `${id}.md`),
      "utf-8",
    );
    expect(body).toContain("## Design");
    expect(body).toContain("## Todos");
    expect(body).toContain("1. write hello.txt");
    expect(body).toContain("2. run the check");
    expect(fs.existsSync(server.runtime.worktree(id))).toBe(true);
    expect(fs.existsSync(server.runtime.sessionDir(id, "designer"))).toBe(true);
    expect(fs.existsSync(server.runtime.sessionDir(id, "planner"))).toBe(true);

    const submits = server.transitions
      .read()
      .filter((e) => e.task_id === id && e.transition === "submit");
    expect(submits.map((e) => `${e.from} -> ${e.to}`)).toEqual([
      "DESIGN -> DESIGN_REVIEW",
      "DESIGN_REVIEW -> PLAN",
      "PLAN -> PLAN_REVIEW",
      "PLAN_REVIEW -> WORK",
    ]);

    server.shutdown();
    await server.drain();
  }, 30000);

  test("design review findings go back to the designer, verbatim, until the design passes", async () => {
    const fixture = makeFixture();
    const id = unplannedTask(fixture, "Add a greeting");

    setPlan(fixture, {
      [id]: {
        DESIGN: [
          { design: "structure A", submit: true },
          { design: "structure B", submit: true },
        ],
        DESIGN_REVIEW: [
          { submit: true, findings: ["the design misses the farewell"] },
          { submit: true },
        ],
        PLAN: [{ todos: ["write hello.txt"], submit: true }],
        PLAN_REVIEW: [{ submit: true }],
      },
    });

    const server = await serverFor(fixture);
    server.setSchedulerEnabled(true);

    await reaches(server, id, "WORK");

    const designer = server.runtime.sessionDir(id, "designer");
    expect(promptsTo(designer).join("\n")).toContain(
      "the design misses the farewell",
    );

    const body = fs.readFileSync(
      path.join(fixture.tasksDir, `${id}.md`),
      "utf-8",
    );
    expect(body).toContain("structure B");
    expect(body).not.toContain("structure A");

    server.shutdown();
    await server.drain();
  }, 30000);

  test("design review findings reach the designer without touching the task body", async () => {
    const fixture = makeFixture();
    const id = unplannedTask(fixture, "Add a greeting");

    setPlan(fixture, {
      [id]: {
        DESIGN: [
          { design: "structure A", submit: true },
          { design: "structure B", submit: true },
        ],
        DESIGN_REVIEW: [
          { submit: true, findings: ["the design misses the farewell"] },
          { submit: true },
        ],
        PLAN: [{ todos: ["write hello.txt"], submit: true }],
      },
    });

    const server = await serverFor(fixture);
    server.setSchedulerEnabled(true);
    await reaches(server, id, "PLAN_REVIEW");
    server.setSchedulerEnabled(false);
    await server.drain();

    expect(promptsTo(server.runtime.sessionDir(id, "designer"))[1]).toBe(
      server.prompts.fragment("DESIGN-with-findings", {
        findings: [{ finding: "the design misses the farewell" }],
      }),
    );

    const body = fs.readFileSync(
      path.join(fixture.tasksDir, `${id}.md`),
      "utf-8",
    );
    expect(body).toContain("structure B");
    expect(body).not.toContain("the design misses the farewell");

    const assignment = fs.readFileSync(server.runtime.assignment(id), "utf-8");
    expect(assignment).not.toContain("the design misses the farewell");

    expect(
      fs.existsSync(path.join(server.runtime.queueDir(id), "DESIGN.md")),
    ).toBe(false);
    expect(fs.existsSync(server.runtime.findings(id))).toBe(false);

    server.shutdown();
    await server.drain();
  }, 30000);

  test("a designer that compacts after a rejection is steered with the findings again", async () => {
    const fixture = makeFixture();
    const id = unplannedTask(fixture, "Add a greeting");

    setPlan(fixture, {
      [id]: {
        DESIGN: [
          { design: "structure A", submit: true },
          { compact: "overflow" },
          { design: "structure B", submit: true },
        ],
        DESIGN_REVIEW: [
          { submit: true, findings: ["the design misses the farewell"] },
          { submit: true },
        ],
      },
    });

    const server = await serverFor(fixture);
    server.setSchedulerEnabled(true);
    await reaches(server, id, "PLAN");
    server.setSchedulerEnabled(false);
    await server.drain();

    expect(steersTo(server.runtime.sessionDir(id, "designer"))).toEqual([
      server.prompts.fragment("DESIGN-with-findings", {
        findings: [{ finding: "the design misses the farewell" }],
      }),
    ]);

    server.shutdown();
    await server.drain();
  }, 30000);

  test("a designer that keeps submitting an empty design is held", async () => {
    const fixture = makeFixture();
    const id = unplannedTask(fixture, "Add a greeting");

    setPlan(fixture, {
      [id]: {
        DESIGN: [{ submit: true }],
      },
    });

    const server = await serverFor(fixture);
    server.setSchedulerEnabled(true);
    await reaches(server, id, "HELD_DESIGN");

    const task = server.tasks().get(id)!;
    expect(task.held_reason).toContain(
      "the designer submitted without appending a design section",
    );
    expect(task.state).toBe("HELD_DESIGN");
    expect(promptsTo(server.runtime.sessionDir(id, "designer"))).toHaveLength(
      ISSUES["missing-design"].attempts + 1,
    );

    server.shutdown();
  }, 30000);

  test("a design reviewer that writes to the worktree is sent back", async () => {
    const fixture = makeFixture();
    const id = unplannedTask(fixture, "Add a greeting");

    setPlan(fixture, {
      [id]: {
        DESIGN: [{ design: "the design", submit: true }],
        DESIGN_REVIEW: [
          { write: { path: "oops.txt", contents: "nope" }, submit: true },
          { clean: ["oops.txt"], submit: true },
        ],
        PLAN: [{ todos: ["write hello.txt"], submit: true }],
        PLAN_REVIEW: [{ submit: true }],
      },
    });

    const server = await serverFor(fixture);
    server.setSchedulerEnabled(true);
    await reaches(server, id, "WORK");

    expect(promptsTo(server.runtime.sessionDir(id, "reviewer"))).toHaveLength(
      3,
    );

    server.shutdown();
    await server.drain();
  }, 30000);

  test("plan review findings go back to the planner, verbatim, until the plan passes", async () => {
    const fixture = makeFixture();
    const id = unplannedTask(fixture, "Add a greeting");

    setPlan(fixture, {
      [id]: {
        DESIGN: [{ design: "the design", submit: true }],
        DESIGN_REVIEW: [{ submit: true }],
        PLAN: [
          { todos: ["write hello.txt"], submit: true },
          { todos: ["run the check"], submit: true },
        ],
        PLAN_REVIEW: [
          { submit: true, findings: ["no todo covers the check"] },
          { submit: true },
        ],
      },
    });

    const server = await serverFor(fixture);
    server.setSchedulerEnabled(true);

    await reaches(server, id, "WORK");

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
        DESIGN: [{ design: "the design", submit: true }],
        DESIGN_REVIEW: [{ submit: true }],
        PLAN: [{ submit: true }, { todos: ["write hello.txt"], submit: true }],
        PLAN_REVIEW: [{ submit: true }],
      },
    });

    const server = await serverFor(fixture);
    server.setSchedulerEnabled(true);
    await reaches(server, id, "WORK");

    expect(promptsTo(server.runtime.sessionDir(id, "planner"))).toHaveLength(2);

    server.shutdown();
    await server.drain();
  }, 30000);

  test("a planner that keeps submitting an empty plan is held", async () => {
    const fixture = makeFixture();
    const id = unplannedTask(fixture, "Add a greeting");

    setPlan(fixture, {
      [id]: {
        DESIGN: [{ design: "the design", submit: true }],
        DESIGN_REVIEW: [{ submit: true }],
        PLAN: [{ submit: true }],
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
        DESIGN: [{ design: "the design", submit: true }],
        DESIGN_REVIEW: [{ submit: true }],
        PLAN: [
          {
            write: { path: "oops.txt", contents: "nope" },
            todos: ["write hello.txt"],
            submit: true,
          },
          { clean: ["oops.txt"], todos: ["write hello.txt"], submit: true },
        ],
        PLAN_REVIEW: [{ submit: true }],
      },
    });

    const server = await serverFor(fixture);
    server.setSchedulerEnabled(true);
    await reaches(server, id, "WORK");

    expect(promptsTo(server.runtime.sessionDir(id, "planner"))).toHaveLength(2);

    server.shutdown();
    await server.drain();
  }, 30000);

  test("a planner that commits to the branch is sent back, then held", async () => {
    const fixture = makeFixture();
    const id = unplannedTask(fixture, "Add a greeting");

    setPlan(fixture, {
      [id]: {
        DESIGN: [{ design: "the design", submit: true }],
        DESIGN_REVIEW: [{ submit: true }],
        PLAN: [
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
    expect(task.held_reason).toContain(
      "wrote to the worktree during design or planning",
    );
    expect(task.state).toBe("HELD_PLAN");

    server.shutdown();
  }, 30000);

  test("a plan reviewer that writes to the worktree is sent back", async () => {
    const fixture = makeFixture();
    const id = unplannedTask(fixture, "Add a greeting");

    setPlan(fixture, {
      [id]: {
        DESIGN: [{ design: "the design", submit: true }],
        DESIGN_REVIEW: [{ submit: true }],
        PLAN: [{ todos: ["write hello.txt"], submit: true }],
        PLAN_REVIEW: [
          { write: { path: "oops.txt", contents: "nope" }, submit: true },
          { clean: ["oops.txt"], submit: true },
        ],
      },
    });

    const server = await serverFor(fixture);
    server.setSchedulerEnabled(true);
    await reaches(server, id, "WORK");

    expect(promptsTo(server.runtime.sessionDir(id, "reviewer"))).toHaveLength(
      3,
    );

    server.shutdown();
    await server.drain();
  }, 30000);

  test("a blocked designer holds the task, and resume sends it back to DESIGN", async () => {
    const fixture = makeFixture();
    const id = unplannedTask(fixture, "Add a greeting");
    setPlan(fixture, {
      [id]: {
        DESIGN: [{ blocked: "the acceptance criteria are empty" }],
      },
    });

    const server = await serverFor(fixture);
    server.setSchedulerEnabled(true);
    await reaches(server, id, "HELD_DESIGN");

    const task = server.tasks().get(id)!;
    expect(task.held_reason).toBe("the acceptance criteria are empty");
    expect(task.state).toBe("HELD_DESIGN");

    server.transition(id, "resume", {}, "manager");
    expect(stateOf(server, id)).toBe("DESIGN");

    server.shutdown();
  }, 30000);

  test("a blocked planner holds the task, and resume sends it back to PLAN", async () => {
    const fixture = makeFixture();
    const id = unplannedTask(fixture, "Add a greeting");
    setPlan(fixture, {
      [id]: {
        DESIGN: [{ design: "the design", submit: true }],
        DESIGN_REVIEW: [{ submit: true }],
        PLAN: [{ blocked: "the acceptance criteria are empty" }],
      },
    });

    const server = await serverFor(fixture);
    server.setSchedulerEnabled(true);
    await reaches(server, id, "HELD_PLAN");

    const task = server.tasks().get(id)!;
    expect(task.held_reason).toBe("the acceptance criteria are empty");
    expect(task.state).toBe("HELD_PLAN");

    server.transition(id, "resume", {}, "manager");
    expect(stateOf(server, id)).toBe("PLAN");

    server.shutdown();
  }, 30000);

  test("a blocked plan reviewer holds the task, and resume sends it back to PLAN", async () => {
    const fixture = makeFixture();
    const id = unplannedTask(fixture, "Add a greeting");
    setPlan(fixture, {
      [id]: {
        DESIGN: [{ design: "the design", submit: true }],
        DESIGN_REVIEW: [{ submit: true }],
        PLAN: [{ todos: ["write hello.txt"], submit: true }],
        PLAN_REVIEW: [{ blocked: "the criteria contradict the goal" }],
      },
    });

    const server = await serverFor(fixture);
    server.setSchedulerEnabled(true);
    await reaches(server, id, "HELD_PLAN");

    const task = server.tasks().get(id)!;
    expect(task.held_reason).toBe("the criteria contradict the goal");
    expect(task.state).toBe("HELD_PLAN");

    server.transition(id, "resume", {}, "manager");
    expect(stateOf(server, id)).toBe("PLAN");

    server.shutdown();
  }, 30000);

  test("the manager resolves a held task by writing the body and resuming", async () => {
    const fixture = makeFixture();
    const id = readyTask(fixture, "A task");
    setPlan(fixture, {
      [id]: { WORK: [{ blocked: "the criteria are unclear" }] },
    });

    const server = await serverFor(fixture);
    server.setSchedulerEnabled(true);
    await reaches(server, id, "HELD_WORK");
    server.setSchedulerEnabled(false);

    writeTaskBody(fixture.tasksDir, id, "# Goal\n\nclarified the criteria");
    server.transition(id, "resume", {}, "manager");
    expect(stateOf(server, id)).toBe("WORK");

    server.shutdown();
  }, 30000);

  test("design and planning rank below work, reviews above their fresh states", async () => {
    const fixture = makeFixture();
    const worked = readyTask(fixture, "Ready for work");
    const reviewing = unplannedTask(fixture, "Plan awaiting review");
    const planFresh = unplannedTask(fixture, "Ready to be planned");
    const designFresh = unplannedTask(fixture, "Not yet designed");

    const server = await serverFor(fixture);
    server.setSchedulerEnabled(false);

    for (const id of [reviewing, planFresh]) {
      takeClaim(fixture.tasksDir, id, {
        agentName: "designer",
        pid: process.pid,
      });
      applyTransition(fixture.tasksDir, id, "submit", {});
      takeClaim(fixture.tasksDir, id, {
        agentName: "design-reviewer",
        pid: process.pid,
      });
      applyTransition(fixture.tasksDir, id, "submit", {
        body: readTaskFile(findTaskFile(id, fixture.tasksDir)!).body,
      });
    }
    server.claim(reviewing, { agentName: "planner", pid: process.pid });
    server.transition(reviewing, "submit", {}, "server");
    await server.tick();

    const view = JSON.parse(
      fs.readFileSync(server.runtime.queueView, "utf-8"),
    ) as { queue: { rank: string }[] };
    expect(view.queue.map((r) => r.rank)).toEqual([
      "WORK_FRESH",
      "PLAN_REVIEW",
      "PLAN_FRESH",
      "DESIGN_FRESH",
    ]);

    server.shutdown();
  }, 30000);

  test("a task still queued in PLAN can be held and aborted", async () => {
    const fixture = makeFixture();
    const id = unplannedTask(fixture, "The wrong shape");

    const server = await serverFor(fixture);
    server.setSchedulerEnabled(false);
    await server.tick();

    expect(() => server.attemptAbort(id)).toThrow(
      /not in MANAGER_REVIEW or HELD_DESIGN or HELD_PLAN or HELD_WORK/,
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

    setPlan(fixture, { [id]: { WORK: [{ notes: "still thinking" }] } });

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
    setBody(fixture, id, "\n# The body of this task\n");

    writeOverride(
      fixture,
      "prompts/WORK.md",
      "You are this project's implementer.\n",
    );
    setPlan(fixture, { [id]: { WORK: [{ notes: "still thinking" }] } });

    const server = await serverFor(fixture);
    server.setSchedulerEnabled(true);
    await server.tick();
    await server.drain();

    const sessionDir = server.runtime.sessionDir(id, "worker");
    expect(promptsTo(sessionDir)[0]).toBe(
      "You are this project's implementer.\n",
    );

    const assignment = fs.readFileSync(server.runtime.assignment(id), "utf-8");
    expect(assignment).toContain("# The body of this task");

    server.shutdown();
  }, 30000);

  test("startup logs the absolute path of every cached prompt and template", async () => {
    const fixture = makeFixture();
    readyTask(fixture, "Do a thing");
    writeOverride(fixture, "prompts/WORK.md", "Start on ../ASSIGNMENT.md.\n");

    const server = await serverFor(fixture);

    const log = fs.readFileSync(server.runtime.serverLog, "utf-8");
    expect(log).toContain(
      `cached ${path.join(fixture.overridesDir, "prompts", "WORK.md")}`,
    );
    expect(log).not.toContain(
      `cached ${path.join(fixture.orchestratorDir, "prompts", "WORK.md")}`,
    );

    server.shutdown();
  }, 30000);

  test("an override of one file leaves every other prompt as the orchestrator ships it", async () => {
    const fixture = makeFixture();
    const id = readyTask(fixture, "Do a thing");

    writeOverride(fixture, "prompts/DESIGN.md", "Start on ../ASSIGNMENT.md.\n");

    setPlan(fixture, { [id]: { WORK: [{ notes: "still thinking" }] } });

    const server = await serverFor(fixture);
    server.setSchedulerEnabled(true);
    await server.tick();
    await server.drain();

    const sessionDir = server.runtime.sessionDir(id, "worker");
    expect(promptsTo(sessionDir)[0]).toBe(
      fs.readFileSync(
        path.join(fixture.orchestratorDir, "prompts", "WORK.md"),
        "utf-8",
      ),
    );

    server.shutdown();
  }, 30000);

  test("a dispatched task gets a worktree, a branch and an ASSIGNMENT.md beside it", async () => {
    const fixture = makeFixture();
    const id = readyTask(fixture, "Do a thing", ["true"]);
    setBody(fixture, id, "\n# The body of this task\n");

    setPlan(fixture, { [id]: { WORK: [{ notes: "still thinking" }] } });

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
    expect(body).toContain("# The body of this task");

    server.shutdown();
  }, 30000);

  test("the assignment is handed over with the empty section the agent is to write", async () => {
    const fixture = makeFixture();
    const id = unplannedTask(fixture, "Do a thing");
    setBody(fixture, id, "\n# The body of this task\n");

    setPlan(fixture, { [id]: { DESIGN: [{ submit: true }] } });

    const server = await serverFor(fixture);
    server.setSchedulerEnabled(true);
    await server.tick();
    await server.drain();

    expect(fs.readFileSync(server.runtime.assignment(id), "utf-8")).toBe(
      "\n\n# The body of this task\n\n## Design\n",
    );

    server.shutdown();
  }, 30000);

  test("the claim records the agent, its pid and the session it opened", async () => {
    const fixture = makeFixture();
    const id = readyTask(fixture, "Do a thing");
    setPlan(fixture, {
      [id]: {
        WORK: [
          {
            submit: true,
            notes: "did the work",
            commit: { path: "a.txt", contents: "a" },
            start_delay_ms: 500,
          },
        ],
        WORK_REVIEW: [{ submit: true }],
      },
    });

    const server = await serverFor(fixture);
    server.setSchedulerEnabled(true);
    await server.tick();

    const held = server.tasks().get(id)!;
    expect(held.claimed_by).toBe("pi-fake-fake-1");
    expect(held.claimed_pid).toBeGreaterThan(0);
    expect(held.workspace!.agent).toBe("pi-fake-fake-1");
    expect(held.workspace!.branch).toBe(`task/${id}`);
    expect(held.workspace!.worktree).toBe(server.runtime.worktree(id));
    expect(fs.existsSync(held.workspace!.session!)).toBe(true);

    await reaches(server, id, "MANAGER_REVIEW");
    server.setSchedulerEnabled(false);

    expect(server.tasks().get(id)!.claimed_by).toBeNull();

    server.shutdown();
  }, 30000);

  test("a workspace claimed under an older branch prefix keeps the branch it recorded", async () => {
    const fixture = makeFixture();
    const id = readyTask(fixture, "A task from before the prefix changed");
    setPlan(fixture, { [id]: { WORK_REVIEW: [{ submit: true }] } });

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
    takeClaim(fixture.tasksDir, id, {
      agentName: "pi-old-1",
      pid: process.pid,
      branch: legacy,
      worktree,
    });
    for (const [name, args] of [
      ["submit", { body }],
      ["pass", {}],
    ] as const) {
      applyTransition(fixture.tasksDir, id, name, args);
    }
    expect(stateOf(server, id)).toBe("WORK_REVIEW");

    server.setSchedulerEnabled(true);
    await reaches(server, id, "MANAGER_REVIEW");
    server.setSchedulerEnabled(false);

    expect(server.tasks().get(id)!.workspace!.branch).toBe(legacy);
    expect(git.branchExists(fixture.repo, `task/${id}`)).toBe(false);

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
        WORK: [{ busy_ms: 200, submit: true, notes: "did the work" }],
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
    setPlan(fixture, { [id]: { WORK: [{ submit: true }] } });

    const server = await serverFor(fixture);
    await settle(server, 2);

    expect(stateOf(server, id)).toBe("WORK");
    expect(server.schedulerEnabled).toBe(false);

    server.shutdown();
  }, 30000);

  test("a paused scheduler still settles work already in flight", async () => {
    const fixture = makeFixture();
    const id = readyTask(fixture, "Do a thing");
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
    await settle(server, 2);

    expect(stateOf(server, id)).toBe("WORK_REVIEW");
    expect(server.schedulerEnabled).toBe(false);

    server.shutdown();
  }, 30000);
});

describe("the server: integration", () => {
  test("a branch that no longer rebases is an error back to the manager", async () => {
    const fixture = makeFixture();
    const id = readyTask(fixture, "Do a thing");
    setPlan(fixture, {
      [id]: {
        WORK: [
          {
            submit: true,
            notes: "did the work",
            commit: { path: "shared.txt", contents: "from the branch\n" },
          },
        ],
        WORK_REVIEW: [{ submit: true }],
      },
    });

    const server = await serverFor(fixture);
    server.setSchedulerEnabled(true);
    await reaches(server, id, "MANAGER_REVIEW");
    server.setSchedulerEnabled(false);

    fs.writeFileSync(path.join(fixture.repo, "shared.txt"), "from master\n");
    commitGraph(fixture, "conflicting change on master");

    expect(server.attemptMerge(id)).rejects.toThrow(/no longer rebases/);
    expect(stateOf(server, id)).toBe("MANAGER_REVIEW");

    server.shutdown();
  }, 30000);

  test("a check that fails after the rebase is an error back to the manager", async () => {
    const fixture = makeFixture();
    const id = readyTask(fixture, "Do a thing", ["test -f wanted.txt"]);
    setPlan(fixture, {
      [id]: {
        WORK: [
          {
            submit: true,
            notes: "did the work",
            commit: { path: "wanted.txt", contents: "here\n" },
          },
        ],
        WORK_REVIEW: [{ submit: true }],
      },
    });

    const server = await serverFor(fixture);
    server.setSchedulerEnabled(true);
    await reaches(server, id, "MANAGER_REVIEW");
    server.setSchedulerEnabled(false);

    fs.rmSync(path.join(server.runtime.worktree(id), "wanted.txt"));
    git.gitOrThrow(server.runtime.worktree(id), [
      "commit",
      "-qam",
      "remove it",
    ]);

    expect(server.attemptMerge(id)).rejects.toThrow(/test -f wanted\.txt/);
    expect(stateOf(server, id)).toBe("MANAGER_REVIEW");

    server.shutdown();
  }, 30000);

  test("the repo the work came from is read-only to everything the server spawns", async () => {
    const fixture = makeFixture();
    const id = readyTask(fixture, "Do a thing", [
      `echo x > ${path.join(fixture.repo, "poke")}`,
    ]);
    setPlan(fixture, {
      [id]: {
        WORK: [
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
      path.join(server.runtime.queueDir(id), "WORK.md"),
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
