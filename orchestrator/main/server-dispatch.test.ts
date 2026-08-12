import { describe, expect } from "bun:test";
import { requireWorkspace } from "../domain/task.ts";
import {
  tempDir,
  testInTempDirs,
  withTasksRoot,
} from "../testing/temp-dirs.ts";
import fs from "node:fs/promises";
import path from "node:path";
import { applyTransition } from "../adapters/task-documents.ts";
import { takeClaim } from "../adapters/task-documents.ts";
import { branchName } from "../domain/workspace.ts";
import {
  activeTaskPath,
  closedTaskPath,
  nextTaskIdPath,
  readTaskFile,
  writeTaskBody,
  requireTaskFile,
} from "../adapters/task-store.ts";
import { readView } from "../adapters/tui.ts";
import { defaultTasksDir } from "../adapters/runtime.ts";
import * as git from "../adapters/git.ts";
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
} from "../testing/fixture.ts";
import { startServer } from "../testing/server-jig.ts";
import { ISSUES } from "../domain/issues.ts";
import {
  dispatchOnce,
  transitionsOf,
  pathsOf,
  promptsOf,
  reaches,
  serverFor,
  settle,
  settleTo,
  stateOf,
  walkTo,
  taskOf,
  workspaceOf,
  sessionOf,
} from "../testing/server-jig.ts";

describe("Feature: where a project's task graph is found", () => {
  testInTempDirs(
    "a tasks dir that is not there yet is seeded from the template",
    async () => {
      const fixture = await makeFixture();
      const root = await tempDir("task-graph-root-");

      await withTasksRoot(root, async () => {
        // Given a project that has never had a task graph
        const tasksDir = defaultTasksDir(fixture.repo);

        // When a server is started against it with a graph that is not there yet
        const server = await startServer({
          runtime: fixture.runtime,
          tasksDir,
          piCommand: fixture.piCommand,
          base: "master",
        });

        // Then it seeds the graph and takes its overrides from there
        expect(server.config.promptDirs.overrides).toBe(
          path.join(tasksDir, "prompts"),
        );
        expect(await fs.exists(path.join(tasksDir, "agents.json"))).toBe(true);
        expect(await fs.exists(path.join(tasksDir, "template.md"))).toBe(false);
        expect(await fs.readFile(nextTaskIdPath(tasksDir), "utf-8")).toBe(
          "1\n",
        );

        await server.shutdown();
      });
    },
    30000,
  );

  testInTempDirs(
    "with no base named the server lands work on the branch the repo is on",
    async () => {
      // Given a project checked out on a branch of its own naming
      const fixture = await makeFixture();
      await git.gitOrThrow(fixture.repo, ["checkout", "-q", "-b", "trunk"]);

      // When a server is started against it without being told a base
      const server = await startServer({
        runtime: fixture.runtime,
        agentsPath: fixture.agentsPath,
        tasksDir: fixture.tasksDir,
        orchestratorDir: fixture.orchestratorDir,
        overridesDir: fixture.overridesDir,
        piCommand: fixture.piCommand,
      });

      // Then that branch is the one it will rebase onto and land work on
      expect(server.config.base).toBe("trunk");

      await server.shutdown();
    },
    30000,
  );
});

describe("Feature: a task that goes all the way through", () => {
  testInTempDirs(
    "work, checks, agent review and manager review close the task",
    async () => {
      const fixture = await makeFixture();
      const id = await readyTask(fixture, "Add a greeting", [
        "test -f hello.txt",
      ]);

      await setPlan(fixture, {
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

      // Given a task with a check, and agents that will do and review the work
      const server = await serverFor(fixture);
      await walkTo(server, id, "MANAGER_REVIEW");

      // When the manager merges it
      const merged = await server.submit(id);

      // Then the task closes and nothing of its workspace is left behind
      expect(merged.to).toBe("CLOSED");
      expect((await server.tasks()).has(id)).toBe(false);
      expect(await fs.exists(closedTaskPath(fixture.tasksDir, id))).toBe(true);
      expect(await fs.exists(path.join(fixture.repo, "hello.txt"))).toBe(true);
      expect(await git.branchExists(fixture.repo, branchName(id))).toBe(false);
      expect(await fs.exists(pathsOf(server).worktree(id))).toBe(false);

      await server.shutdown();
    },
    30000,
  );
});

describe("Feature: measuring how fast an agent writes", () => {
  testInTempDirs(
    "the output tokens of every message land in the pool's rate table",
    async () => {
      const fixture = await makeFixture();
      const id = await readyTask(fixture, "Add a greeting", ["true"]);

      await setPlan(fixture, {
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

      // Given a task whose agents report the tokens each message cost
      const server = await serverFor(fixture);

      // When the scheduler runs it to the manager
      await walkTo(server, id, "MANAGER_REVIEW");

      // Then the agent that ran has a measured rate and an idle one has none
      expect(server.rateOf("pi-fake-fake")).toBeGreaterThan(0);
      expect(server.rateOf("pi-other-other")).toBeUndefined();

      await server.shutdown();
    },
    30000,
  );
});

describe("Feature: the design and planning phases", () => {
  testInTempDirs(
    "a plan is written, reviewed and accepted before the work starts",
    async () => {
      const fixture = await makeFixture();
      const id = await unplannedTask(fixture, "Add a greeting", [
        "test -f hello.txt",
      ]);

      await setPlan(fixture, {
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

      // Given a task nobody has designed or planned yet
      const server = await serverFor(fixture);

      // When the scheduler runs it as far as the work stage
      await walkTo(server, id, "WORK");

      // Then the design and the plan are both in the task body
      const body = await fs.readFile(
        activeTaskPath(fixture.tasksDir, id),
        "utf-8",
      );
      expect(body).toContain("## Design");
      expect(body).toContain("## Todos");
      expect(body).toContain("1. write hello.txt");
      expect(body).toContain("2. run the check");
      expect(await fs.exists(pathsOf(server).worktree(id))).toBe(true);
      expect(await fs.exists(pathsOf(server).sessionDir(id, "designer"))).toBe(
        true,
      );
      expect(await fs.exists(pathsOf(server).sessionDir(id, "planner"))).toBe(
        true,
      );

      // Then it went through each phase and its review in order
      const submits = (await (await transitionsOf(server)).read()).filter(
        (e) => e.task_id === id && e.transition === "submit",
      );
      expect(submits.map((e) => `${e.from} -> ${e.to}`)).toEqual([
        "DESIGN -> DESIGN_REVIEW",
        "DESIGN_REVIEW -> PLAN",
        "PLAN -> PLAN_REVIEW",
        "PLAN_REVIEW -> WORK",
      ]);

      await server.shutdown();
      await server.drain();
    },
    30000,
  );

  testInTempDirs(
    "design review findings go back to the designer, verbatim, until the design passes",
    async () => {
      const fixture = await makeFixture();
      const id = await unplannedTask(fixture, "Add a greeting");

      await setPlan(fixture, {
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

      // Given a design the reviewer will reject once before accepting
      const server = await serverFor(fixture);

      // When the scheduler runs the task as far as the work stage
      await walkTo(server, id, "WORK");

      // Then the designer was told what the reviewer found, in its own words
      const designer = pathsOf(server).sessionDir(id, "designer");
      expect((await promptsTo(designer)).join("\n")).toContain(
        "the design misses the farewell",
      );

      // Then only the design that was accepted is what the task carries
      const body = await fs.readFile(
        activeTaskPath(fixture.tasksDir, id),
        "utf-8",
      );
      expect(body).toContain("structure B");
      expect(body).not.toContain("structure A");

      await server.shutdown();
      await server.drain();
    },
    30000,
  );

  testInTempDirs(
    "design review findings reach the designer without touching the task body",
    async () => {
      const fixture = await makeFixture();
      const id = await unplannedTask(fixture, "Add a greeting");

      await setPlan(fixture, {
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

      // Given a design the reviewer will reject once before accepting
      const server = await serverFor(fixture);

      // When the scheduler runs the task as far as the plan review
      await settleTo(server, id, "PLAN_REVIEW");

      // Then the designer read the findings in its next prompt
      expect(
        (await promptsTo(pathsOf(server).sessionDir(id, "designer")))[1],
      ).toBe(
        promptsOf(server).fragment("DESIGN-with-findings", {
          findings: [{ finding: "the design misses the farewell" }],
        }),
      );

      // Then the findings are nowhere in the task body or the assignment
      const body = await fs.readFile(
        activeTaskPath(fixture.tasksDir, id),
        "utf-8",
      );
      expect(body).toContain("structure B");
      expect(body).not.toContain("the design misses the farewell");

      const assignment = await fs.readFile(
        pathsOf(server).assignment(id),
        "utf-8",
      );
      expect(assignment).not.toContain("the design misses the farewell");

      expect(await fs.exists(pathsOf(server).messageFile(id, "DESIGN"))).toBe(
        false,
      );
      expect(await fs.exists(pathsOf(server).findings(id))).toBe(false);

      await server.shutdown();
      await server.drain();
    },
    30000,
  );

  testInTempDirs(
    "a designer that compacts after a rejection is steered with the findings again",
    async () => {
      const fixture = await makeFixture();
      const id = await unplannedTask(fixture, "Add a greeting");

      await setPlan(fixture, {
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

      // Given a designer that compacts on the turn after it was sent back
      const server = await serverFor(fixture);

      // When the scheduler runs the task as far as the planning stage
      await settleTo(server, id, "PLAN");

      // Then the steer it was given still carried the findings to answer
      expect(
        await steersTo(pathsOf(server).sessionDir(id, "designer")),
      ).toEqual([
        promptsOf(server).fragment("DESIGN-with-findings", {
          findings: [{ finding: "the design misses the farewell" }],
        }),
      ]);

      await server.shutdown();
      await server.drain();
    },
    30000,
  );

  testInTempDirs(
    "a designer that keeps submitting an empty design is held",
    async () => {
      const fixture = await makeFixture();
      const id = await unplannedTask(fixture, "Add a greeting");

      await setPlan(fixture, {
        [id]: {
          DESIGN: [{ submit: true }],
        },
      });

      // Given a designer that submits without writing anything
      const server = await serverFor(fixture);

      // When the server nudges it until the attempts run out
      await walkTo(server, id, "HELD_DESIGN");

      // Then the task is held, saying what the designer never wrote
      const task = await taskOf(server, id);
      expect(task.held_reason).toContain(
        "the designer submitted without appending a design section",
      );
      expect(task.state).toBe("HELD_DESIGN");
      expect(
        await promptsTo(pathsOf(server).sessionDir(id, "designer")),
      ).toHaveLength(ISSUES["missing-design"].attempts + 1);

      await server.shutdown();
    },
    30000,
  );

  testInTempDirs(
    "a design reviewer that writes to the worktree is sent back",
    async () => {
      const fixture = await makeFixture();
      const id = await unplannedTask(fixture, "Add a greeting");

      await setPlan(fixture, {
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

      // Given a design reviewer that leaves a file behind in the worktree
      const server = await serverFor(fixture);

      // When the scheduler runs the task as far as the work stage
      await walkTo(server, id, "WORK");

      // Then it was sent back to clean up before its review was accepted
      expect(
        await promptsTo(pathsOf(server).sessionDir(id, "reviewer")),
      ).toHaveLength(3);

      await server.shutdown();
      await server.drain();
    },
    30000,
  );

  testInTempDirs(
    "plan review findings go back to the planner, verbatim, until the plan passes",
    async () => {
      const fixture = await makeFixture();
      const id = await unplannedTask(fixture, "Add a greeting");

      await setPlan(fixture, {
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

      // Given a plan the reviewer will reject once before accepting
      const server = await serverFor(fixture);

      // When the scheduler runs the task as far as the work stage
      await walkTo(server, id, "WORK");

      // Then the planner was told what the reviewer found, in its own words
      const planner = pathsOf(server).sessionDir(id, "planner");
      expect((await promptsTo(planner)).join("\n")).toContain(
        "no todo covers the check",
      );

      // Then only the plan that was accepted is what the task carries
      const body = await fs.readFile(
        activeTaskPath(fixture.tasksDir, id),
        "utf-8",
      );
      expect(body).toContain("1. run the check");
      expect(body).not.toContain("1. write hello.txt");

      await server.shutdown();
      await server.drain();
    },
    30000,
  );

  testInTempDirs(
    "an empty plan is asked for again, and a persistent one is held",
    async () => {
      const fixture = await makeFixture();
      const id = await unplannedTask(fixture, "Add a greeting");

      await setPlan(fixture, {
        [id]: {
          DESIGN: [{ design: "the design", submit: true }],
          DESIGN_REVIEW: [{ submit: true }],
          PLAN: [
            { submit: true },
            { todos: ["write hello.txt"], submit: true },
          ],
          PLAN_REVIEW: [{ submit: true }],
        },
      });

      // Given a planner that submits nothing once, then writes its todos
      const server = await serverFor(fixture);

      // When the scheduler runs the task as far as the work stage
      await walkTo(server, id, "WORK");

      // Then it was asked once for the plan and never held
      expect(
        await promptsTo(pathsOf(server).sessionDir(id, "planner")),
      ).toHaveLength(2);

      await server.shutdown();
      await server.drain();
    },
    30000,
  );

  testInTempDirs(
    "a planner that keeps submitting an empty plan is held",
    async () => {
      const fixture = await makeFixture();
      const id = await unplannedTask(fixture, "Add a greeting");

      await setPlan(fixture, {
        [id]: {
          DESIGN: [{ design: "the design", submit: true }],
          DESIGN_REVIEW: [{ submit: true }],
          PLAN: [{ submit: true }],
        },
      });

      // Given a planner that submits without writing anything
      const server = await serverFor(fixture);

      // When the server nudges it until the attempts run out
      await walkTo(server, id, "HELD_PLAN");

      // Then the task is held, saying what the planner never wrote
      const task = await taskOf(server, id);
      expect(task.held_reason).toContain(
        "the planner submitted without appending a todo list",
      );
      expect(task.state).toBe("HELD_PLAN");
      expect(
        await promptsTo(pathsOf(server).sessionDir(id, "planner")),
      ).toHaveLength(ISSUES["missing-todos"].attempts + 1);

      await server.shutdown();
    },
    30000,
  );

  testInTempDirs(
    "a planner that writes to the worktree is sent back, then held",
    async () => {
      const fixture = await makeFixture();
      const id = await unplannedTask(fixture, "Add a greeting");

      await setPlan(fixture, {
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

      // Given a planner that leaves a file behind in the worktree
      const server = await serverFor(fixture);

      // When the scheduler runs the task as far as the work stage
      await walkTo(server, id, "WORK");

      // Then it was sent back to clean up before its plan was accepted
      expect(
        await promptsTo(pathsOf(server).sessionDir(id, "planner")),
      ).toHaveLength(2);

      await server.shutdown();
      await server.drain();
    },
    30000,
  );

  testInTempDirs(
    "a planner that commits to the branch is sent back, then held",
    async () => {
      const fixture = await makeFixture();
      const id = await unplannedTask(fixture, "Add a greeting");

      await setPlan(fixture, {
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

      // Given a planner that commits work the plan stage may not do
      const server = await serverFor(fixture);

      // When the server nudges it until the attempts run out
      await walkTo(server, id, "HELD_PLAN");

      // Then the task is held, saying which rule the planner broke
      const task = await taskOf(server, id);
      expect(task.held_reason).toContain(
        "wrote to the worktree during design or planning",
      );
      expect(task.state).toBe("HELD_PLAN");

      await server.shutdown();
    },
    30000,
  );

  testInTempDirs(
    "a plan reviewer that writes to the worktree is sent back",
    async () => {
      const fixture = await makeFixture();
      const id = await unplannedTask(fixture, "Add a greeting");

      await setPlan(fixture, {
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

      // Given a plan reviewer that leaves a file behind in the worktree
      const server = await serverFor(fixture);

      // When the scheduler runs the task as far as the work stage
      await walkTo(server, id, "WORK");

      // Then it was sent back to clean up before its review was accepted
      expect(
        await promptsTo(pathsOf(server).sessionDir(id, "reviewer")),
      ).toHaveLength(3);

      await server.shutdown();
      await server.drain();
    },
    30000,
  );

  testInTempDirs(
    "a blocked designer holds the task, and resume sends it back to DESIGN",
    async () => {
      const fixture = await makeFixture();
      const id = await unplannedTask(fixture, "Add a greeting");
      await setPlan(fixture, {
        [id]: {
          DESIGN: [{ blocked: "the acceptance criteria are empty" }],
        },
      });

      // Given a designer that reports it cannot go on
      const server = await serverFor(fixture);
      await server.setSchedulerEnabled(true);
      await reaches(server, id, "HELD_DESIGN");
      const task = await taskOf(server, id);
      expect(task.held_reason).toBe("the acceptance criteria are empty");

      // When the manager resumes it
      await server.transition(id, "resume", {}, "manager");

      // Then the task starts its design phase over
      expect(await stateOf(server, id)).toBe("DESIGN");

      await server.shutdown();
    },
    30000,
  );

  testInTempDirs(
    "a blocked planner holds the task, and resume sends it back to PLAN",
    async () => {
      const fixture = await makeFixture();
      const id = await unplannedTask(fixture, "Add a greeting");
      await setPlan(fixture, {
        [id]: {
          DESIGN: [{ design: "the design", submit: true }],
          DESIGN_REVIEW: [{ submit: true }],
          PLAN: [{ blocked: "the acceptance criteria are empty" }],
        },
      });

      // Given a planner that reports it cannot go on
      const server = await serverFor(fixture);
      await server.setSchedulerEnabled(true);
      await reaches(server, id, "HELD_PLAN");
      const task = await taskOf(server, id);
      expect(task.held_reason).toBe("the acceptance criteria are empty");

      // When the manager resumes it
      await server.transition(id, "resume", {}, "manager");

      // Then the task starts its planning phase over
      expect(await stateOf(server, id)).toBe("PLAN");

      await server.shutdown();
    },
    30000,
  );

  testInTempDirs(
    "a blocked plan reviewer holds the task, and resume sends it back to PLAN",
    async () => {
      const fixture = await makeFixture();
      const id = await unplannedTask(fixture, "Add a greeting");
      await setPlan(fixture, {
        [id]: {
          DESIGN: [{ design: "the design", submit: true }],
          DESIGN_REVIEW: [{ submit: true }],
          PLAN: [{ todos: ["write hello.txt"], submit: true }],
          PLAN_REVIEW: [{ blocked: "the criteria contradict the goal" }],
        },
      });

      // Given a plan reviewer that reports it cannot go on
      const server = await serverFor(fixture);
      await server.setSchedulerEnabled(true);
      await reaches(server, id, "HELD_PLAN");
      const task = await taskOf(server, id);
      expect(task.held_reason).toBe("the criteria contradict the goal");

      // When the manager resumes it
      await server.transition(id, "resume", {}, "manager");

      // Then the task goes back to the planner rather than the reviewer
      expect(await stateOf(server, id)).toBe("PLAN");

      await server.shutdown();
    },
    30000,
  );

  testInTempDirs(
    "the manager resolves a held task by writing the body and resuming",
    async () => {
      const fixture = await makeFixture();
      const id = await readyTask(fixture, "A task");
      await setPlan(fixture, {
        [id]: { WORK: [{ blocked: "the criteria are unclear" }] },
      });

      // Given a task held because its goal was unclear to the agent
      const server = await serverFor(fixture);
      await walkTo(server, id, "HELD_WORK");

      // Given the manager rewrites the goal in the task body
      await writeTaskBody(
        fixture.tasksDir,
        id,
        "# Goal\n\nclarified the criteria",
      );

      // When the manager resumes it
      await server.transition(id, "resume", {}, "manager");

      // Then the task goes back into the queue with the clearer goal
      expect(await stateOf(server, id)).toBe("WORK");

      await server.shutdown();
    },
    30000,
  );

  testInTempDirs(
    "design and planning rank below work, reviews above their fresh states",
    async () => {
      // Given one task in each of the four states the scheduler ranks
      const fixture = await makeFixture();
      await readyTask(fixture, "Ready for work");
      const reviewing = await unplannedTask(fixture, "Plan awaiting review");
      const planFresh = await unplannedTask(fixture, "Ready to be planned");
      await unplannedTask(fixture, "Not yet designed");

      const server = await serverFor(fixture);
      await server.setSchedulerEnabled(false);

      for (const id of [reviewing, planFresh]) {
        await takeClaim(fixture.tasksDir, id, {
          slotName: "designer",
          pid: process.pid,
        });
        await applyTransition(fixture.tasksDir, id, "submit", {});
        await takeClaim(fixture.tasksDir, id, {
          slotName: "design-reviewer",
          pid: process.pid,
        });
        await applyTransition(fixture.tasksDir, id, "submit", {
          body: (
            await readTaskFile(await requireTaskFile(id, fixture.tasksDir))
          ).body,
        });
      }
      await server.claim(reviewing, { slotName: "planner", pid: process.pid });
      await server.transition(reviewing, "submit", {}, "server");

      // When the queue is published
      await server.tick();

      // Then work outranks planning, and a review outranks its own fresh stage
      const view = await readView(fixture.runtime);
      expect(view.queue.map((one) => one.rank)).toEqual([
        "WORK_FRESH",
        "PLAN_REVIEW",
        "PLAN_FRESH",
        "DESIGN_FRESH",
      ]);

      await server.shutdown();
    },
    30000,
  );

  testInTempDirs(
    "a task still queued in PLAN can be held and aborted",
    async () => {
      const fixture = await makeFixture();
      const id = await unplannedTask(fixture, "The wrong shape");

      // Given a task queued for design that nothing has started
      const server = await serverFor(fixture);
      await server.setSchedulerEnabled(false);
      await server.tick();
      expect(() => server.abort(id)).toThrow(
        /not in MANAGER_REVIEW or HELD_DESIGN or HELD_PLAN or HELD_WORK/,
      );

      // Given the manager holds it, abandoning it
      await server.transition(id, "hold", { reason: "abandoning" }, "manager");

      // When the manager aborts it
      const result = await server.abort(id);

      // Then it closes and leaves the graph
      expect(result.to).toBe("CLOSED");
      expect((await server.tasks()).has(id)).toBe(false);

      await server.shutdown();
    },
    30000,
  );
});

describe("Feature: handing a task to an agent", () => {
  testInTempDirs(
    "the prompts and templates come from the orchestrator's own directory, not the driven repo",
    async () => {
      const fixture = await makeFixture();
      const id = await readyTask(fixture, "Do a thing");
      await fs.rm(fixture.orchestratorDir, { recursive: true });

      await setPlan(fixture, { [id]: { WORK: [{ notes: "still thinking" }] } });

      // Given a driven project with no orchestrator directory of its own
      const server = await startServer({
        runtime: fixture.runtime,
        agentsPath: fixture.agentsPath,
        tasksDir: fixture.tasksDir,
        piCommand: fixture.piCommand,
        base: "master",
      });

      // Given a server with its scheduler enabled
      await server.setSchedulerEnabled(true);

      // When a task is dispatched
      await settle(server, 1);

      // Then the prompts came from the orchestrator's own directory
      expect(server.config.promptDirs.orchestrator).toBe(
        path.join(import.meta.dir, "..", "prompts"),
      );
      expect(await fs.exists(pathsOf(server).assignment(id))).toBe(true);

      await server.shutdown();
    },
    30000,
  );

  testInTempDirs(
    "the driven repo's own orchestrator/ overrides the prompts and templates it names",
    async () => {
      const fixture = await makeFixture();
      const id = await readyTask(fixture, "Do a thing");
      await setBody(fixture, id, "\n# The body of this task\n");

      await writeOverride(
        fixture,
        "prompts/WORK.md",
        "You are this project's implementer.\n",
      );
      await setPlan(fixture, { [id]: { WORK: [{ notes: "still thinking" }] } });

      // Given a project that carries its own copy of the work prompt
      const server = await serverFor(fixture);

      // Given a server with its scheduler enabled
      await server.setSchedulerEnabled(true);

      // When a task is dispatched
      await settle(server, 1);

      // Then the agent read the project's words, over the task's own body
      const sessionDir = pathsOf(server).sessionDir(id, "worker");
      expect((await promptsTo(sessionDir))[0]).toBe(
        "You are this project's implementer.\n",
      );
      const assignment = await fs.readFile(
        pathsOf(server).assignment(id),
        "utf-8",
      );
      expect(assignment).toContain("# The body of this task");

      await server.shutdown();
    },
    30000,
  );

  testInTempDirs(
    "startup logs the absolute path of every cached prompt and template",
    async () => {
      // Given a project that overrides one of the prompts
      const fixture = await makeFixture();
      await readyTask(fixture, "Do a thing");
      await writeOverride(
        fixture,
        "prompts/WORK.md",
        "Start on ../ASSIGNMENT.md.\n",
      );

      // When the server starts against it
      const server = await serverFor(fixture);

      // Then the override is named in the log, and the file it replaced is not
      const log = await fs.readFile(pathsOf(server).serverLog, "utf-8");
      expect(log).toContain(
        `cached ${path.join(fixture.overridesDir, "prompts", "WORK.md")}`,
      );
      expect(log).not.toContain(
        `cached ${path.join(fixture.orchestratorDir, "prompts", "WORK.md")}`,
      );

      await server.shutdown();
    },
    30000,
  );

  testInTempDirs(
    "an override of one file leaves every other prompt as the orchestrator ships it",
    async () => {
      const fixture = await makeFixture();
      const id = await readyTask(fixture, "Do a thing");

      await writeOverride(
        fixture,
        "prompts/DESIGN.md",
        "Start on ../ASSIGNMENT.md.\n",
      );

      await setPlan(fixture, { [id]: { WORK: [{ notes: "still thinking" }] } });

      // Given a project that overrides the design prompt but not the work one
      const server = await serverFor(fixture);

      // Given a server with its scheduler enabled
      await server.setSchedulerEnabled(true);

      // When a task is dispatched into the work stage
      await settle(server, 1);

      // Then the agent read the orchestrator's own work prompt, untouched
      const sessionDir = pathsOf(server).sessionDir(id, "worker");
      expect((await promptsTo(sessionDir))[0]).toBe(
        await fs.readFile(
          path.join(fixture.orchestratorDir, "prompts", "WORK.md"),
          "utf-8",
        ),
      );

      await server.shutdown();
    },
    30000,
  );

  testInTempDirs(
    "a dispatched task gets a worktree, a branch and an ASSIGNMENT.md beside it",
    async () => {
      const fixture = await makeFixture();
      const id = await readyTask(fixture, "Do a thing", ["true"]);
      await setBody(fixture, id, "\n# The body of this task\n");

      await setPlan(fixture, { [id]: { WORK: [{ notes: "still thinking" }] } });

      // Given a task with a goal written into its body
      const server = await serverFor(fixture);

      // Given a server with its scheduler enabled
      await server.setSchedulerEnabled(true);

      // When the task is dispatched
      await settle(server, 1);

      // Then it has a worktree, a branch, and its assignment beside the worktree
      const worktree = pathsOf(server).worktree(id);
      const assignment = pathsOf(server).assignment(id);
      expect(await fs.exists(worktree)).toBe(true);
      expect(await fs.exists(assignment)).toBe(true);
      expect(assignment.startsWith(worktree)).toBe(false);
      expect(await git.branchExists(fixture.repo, branchName(id))).toBe(true);

      const body = await fs.readFile(assignment, "utf-8");
      expect(body).toContain("# The body of this task");

      await server.shutdown();
    },
    30000,
  );

  testInTempDirs(
    "the assignment is handed over with the empty section the agent is to write",
    async () => {
      const fixture = await makeFixture();
      const id = await unplannedTask(fixture, "Do a thing");
      await setBody(fixture, id, "\n# The body of this task\n");

      await setPlan(fixture, { [id]: { DESIGN: [{ submit: true }] } });

      // Given a task about to be dispatched into the design stage
      const server = await serverFor(fixture);

      // Given a server with its scheduler enabled
      await server.setSchedulerEnabled(true);

      // When the task is dispatched
      await settle(server, 1);

      // Then the assignment is the body plus the empty heading to fill in
      expect(await fs.readFile(pathsOf(server).assignment(id), "utf-8")).toBe(
        "\n\n# The body of this task\n\n## Design\n",
      );

      await server.shutdown();
    },
    30000,
  );

  testInTempDirs(
    "the claim records the agent, its pid and the session it opened",
    async () => {
      const fixture = await makeFixture();
      const id = await readyTask(fixture, "Do a thing");
      await setPlan(fixture, {
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

      // Given a task about to be dispatched
      const server = await serverFor(fixture);

      // Given a server with its scheduler enabled
      await server.setSchedulerEnabled(true);

      // When the agent claims it
      await server.tick();

      // Then the document names the agent, its process and everything it needs
      const held = await taskOf(server, id);
      const workspace = requireWorkspace(held);
      expect(held.claimed_by).toBe("pi-fake-fake-1");
      expect(held.claimed_pid).toBeGreaterThan(0);
      expect(workspace.slot).toBe("pi-fake-fake-1");
      expect(workspace.branch).toBe(branchName(id));
      expect(workspace.worktree).toBe(pathsOf(server).worktree(id));
      expect(await fs.exists(await sessionOf(server, id))).toBe(true);

      await reaches(server, id, "MANAGER_REVIEW");
      await server.setSchedulerEnabled(false);

      // Then the claim is released once the work is done
      expect((await taskOf(server, id)).claimed_by).toBeUndefined();

      await server.shutdown();
    },
    30000,
  );

  testInTempDirs(
    "a workspace claimed under an older branch prefix keeps the branch it recorded",
    async () => {
      const fixture = await makeFixture();
      const id = await readyTask(
        fixture,
        "A task from before the prefix changed",
      );
      await setPlan(fixture, { [id]: { WORK_REVIEW: [{ submit: true }] } });

      // Given work committed on a branch named by an older version of the server
      const server = await serverFor(fixture);
      const legacy = `work/${id}`;
      const worktree = pathsOf(server).worktree(id);
      await pathsOf(server).prepare(id);
      await git.createWorkspace(fixture.repo, legacy, worktree, "master");
      await fs.writeFile(path.join(worktree, "a.txt"), "a\n");
      await git.gitOrThrow(worktree, ["add", "-A"]);
      await git.gitOrThrow(worktree, [
        "commit",
        "-q",
        "-m",
        "work from before",
      ]);
      await git.harvest(fixture.repo, worktree, legacy);

      const body = (await readTaskFile(activeTaskPath(fixture.tasksDir, id)))
        .body;
      await takeClaim(fixture.tasksDir, id, {
        slotName: "pi-old-1",
        pid: process.pid,
        branch: legacy,
        worktree,
      });
      for (const [name, args] of [
        ["submit", { body }],
        ["pass", {}],
      ] as const) {
        await applyTransition(fixture.tasksDir, id, name, args);
      }
      expect(await stateOf(server, id)).toBe("WORK_REVIEW");

      // When the task is reviewed and merged under the current server
      await walkTo(server, id, "MANAGER_REVIEW");

      // Then the branch it recorded is the one used, not the one it would pick
      expect((await workspaceOf(server, id)).branch).toBe(legacy);
      expect(await git.branchExists(fixture.repo, branchName(id))).toBe(false);

      expect((await server.submit(id)).to).toBe("CLOSED");
      expect(await fs.exists(path.join(fixture.repo, "a.txt"))).toBe(true);
      expect(await git.branchExists(fixture.repo, legacy)).toBe(false);

      await server.shutdown();
    },
    30000,
  );

  testInTempDirs(
    "nothing is dispatched while the scheduler is stopped",
    async () => {
      const fixture = await makeFixture();
      const id = await readyTask(fixture, "Do a thing");
      await setPlan(fixture, { [id]: { WORK: [{ submit: true }] } });

      // Given a queued task and a server whose scheduler is stopped
      const server = await serverFor(fixture);

      // When the server ticks twice
      await settle(server, 2);

      // Then the task is still queued and nothing was started
      expect(await stateOf(server, id)).toBe("WORK");
      expect(server.schedulerEnabled).toBe(false);

      await server.shutdown();
    },
    30000,
  );

  testInTempDirs(
    "a paused scheduler still settles work already in flight",
    async () => {
      const fixture = await makeFixture();
      const id = await readyTask(fixture, "Do a thing");
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

      // Given a task already dispatched to an agent
      const server = await serverFor(fixture);
      await server.setSchedulerEnabled(true);
      await server.tick();

      // When the scheduler is stopped while the agent is still working
      await server.setSchedulerEnabled(false);

      // Then its submit is still applied and its checks still run
      await server.drain();
      await settle(server, 2);
      expect(await stateOf(server, id)).toBe("WORK_REVIEW");
      expect(server.schedulerEnabled).toBe(false);

      await server.shutdown();
    },
    30000,
  );
});

describe("Feature: landing work on the base branch", () => {
  testInTempDirs(
    "a branch that no longer rebases is an error back to the manager",
    async () => {
      const fixture = await makeFixture();
      const id = await readyTask(fixture, "Do a thing");
      await setPlan(fixture, {
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

      // Given finished work whose base has since changed the same file
      const server = await serverFor(fixture);
      await server.setSchedulerEnabled(true);
      await reaches(server, id, "MANAGER_REVIEW");
      await server.setSchedulerEnabled(false);
      await fs.writeFile(
        path.join(fixture.repo, "shared.txt"),
        "from master\n",
      );
      await commitGraph(fixture, "conflicting change on master");

      // When the manager merges it
      const merging = server.submit(id);

      // Then the manager is told it no longer rebases, and the task is untouched
      expect(merging).rejects.toThrow(/no longer rebases/);
      expect(await stateOf(server, id)).toBe("MANAGER_REVIEW");

      await server.shutdown();
    },
    30000,
  );

  testInTempDirs(
    "a check that fails after the rebase is an error back to the manager",
    async () => {
      const fixture = await makeFixture();
      const id = await readyTask(fixture, "Do a thing", ["test -f wanted.txt"]);
      await setPlan(fixture, {
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

      // Given finished work whose branch no longer passes its own check
      const server = await serverFor(fixture);
      await server.setSchedulerEnabled(true);
      await reaches(server, id, "MANAGER_REVIEW");
      await server.setSchedulerEnabled(false);
      await fs.rm(path.join(pathsOf(server).worktree(id), "wanted.txt"));
      await git.gitOrThrow(pathsOf(server).worktree(id), [
        "commit",
        "-qam",
        "remove it",
      ]);

      // When the manager merges it
      const merging = server.submit(id);

      // Then the check that failed is named, and the task is untouched
      expect(merging).rejects.toThrow(/test -f wanted\.txt/);
      expect(await stateOf(server, id)).toBe("MANAGER_REVIEW");

      await server.shutdown();
    },
    30000,
  );

  testInTempDirs(
    "the repo the work came from is read-only to everything the server spawns",
    async () => {
      const fixture = await makeFixture();
      const id = await readyTask(fixture, "Do a thing", [
        `echo x > ${path.join(fixture.repo, "poke")}`,
      ]);
      await setPlan(fixture, {
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

      // Given a task whose check tries to write into the project it came from
      const server = await serverFor(fixture);

      // When the work is done and the check runs against it
      await dispatchOnce(server);

      // Then the write is refused, and the project is untouched
      const queued = await fs.readFile(
        pathsOf(server).messageFile(id, "WORK"),
        "utf-8",
      );
      expect(queued).toContain("Read-only file system");
      expect(await fs.exists(path.join(fixture.repo, "poke"))).toBe(false);

      expect(
        await git.gitOrThrow(pathsOf(server).worktree(id), [
          "log",
          "--oneline",
          "-1",
        ]),
      ).toContain(`work on ${id}`);

      await server.shutdown();
    },
    30000,
  );
});
