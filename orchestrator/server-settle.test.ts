import { describe, expect } from "bun:test";
import { test } from "./temp.ts";
import fs from "node:fs";
import path from "node:path";
import * as git from "./git.ts";
import {
  makeFixture,
  promptsOverlapping,
  promptsTo,
  readyTask,
  setBody,
  setPlan,
} from "./fixture.ts";
import { ISSUES } from "./prompts.ts";
import { LOOP_LIMIT } from "./rpc.ts";
import { reaches, serverFor, settle, stateOf } from "./server-jig.ts";

describe("the server: the agent review", () => {
  test("a finding lands under # Review findings and the task drops back to WORK", async () => {
    const fixture = makeFixture();
    const id = readyTask(fixture, "Do a thing");
    setPlan(fixture, {
      [id]: {
        WORK: [
          {
            submit: true,
            notes: "I skipped the null case",
            commit: { path: "a.txt", contents: "a" },
          },
        ],
        WORK_REVIEW: [
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
      path.join(server.runtime.queueDir(id), "WORK.md"),
      "utf-8",
    );
    expect(queued).toContain("the null case is untested");

    const applied = server.transitions
      .read()
      .find((e) => e.transition === "feedback" && e.from === "WORK_REVIEW")!;
    expect(applied.to).toBe("WORK");
    expect(applied.by).toBe("server");

    server.shutdown();
  }, 30000);

  test("the worker sent back by a review resumes its own session, never the review's", async () => {
    const fixture = makeFixture();
    const id = readyTask(fixture, "Do a thing");
    setPlan(fixture, {
      [id]: {
        WORK: [
          {
            submit: true,
            notes: "I skipped the null case",
            commit: { path: "a.txt", contents: "a" },
          },
          {
            submit: true,
            notes: "I covered the null case",
            commit: { path: "b.txt", contents: "b" },
          },
        ],
        WORK_REVIEW: [
          { submit: true, findings: ["the null case is untested"] },
          { submit: true },
        ],
      },
    });

    const server = await serverFor(fixture);
    server.setSchedulerEnabled(true);
    await reaches(server, id, "MANAGER_REVIEW");
    server.setSchedulerEnabled(false);

    const worked = path.join(
      server.runtime.sessionDir(id, "worker"),
      `${id}-worker.jsonl`,
    );
    expect(server.tasks().get(id)!.workspace!.session).toBe(worked);
    expect(promptsTo(server.runtime.sessionDir(id, "worker"))).toHaveLength(2);
    expect(promptsTo(server.runtime.sessionDir(id, "reviewer"))).toHaveLength(
      2,
    );

    server.shutdown();
  }, 30000);

  test("the reviewer gets its own session and a worktree with the work on it", async () => {
    const fixture = makeFixture();
    const id = readyTask(fixture, "Do a thing");
    setPlan(fixture, {
      [id]: {
        WORK: [
          {
            submit: true,
            notes: "I decided the flaky test was not mine to fix",
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
});

describe("the server: a submit with nothing in the git history", () => {
  test("a branch with no commit on it comes back for one", async () => {
    const fixture = makeFixture();
    const id = readyTask(fixture, "Do a thing");
    setPlan(fixture, {
      [id]: {
        WORK: [
          { submit: true, notes: "I forgot to commit" },
          { submit: true, commit: { path: "a.txt", contents: "a\n" } },
        ],
        WORK_REVIEW: [{ submit: true }],
      },
    });

    const server = await serverFor(fixture);
    server.setSchedulerEnabled(true);
    await reaches(server, id, "MANAGER_REVIEW");
    server.setSchedulerEnabled(false);

    const prompts = promptsTo(server.runtime.sessionDir(id, "worker"));
    expect(prompts).toHaveLength(2);
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
        WORK: [
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
        WORK_REVIEW: [{ submit: true }],
      },
    });

    const server = await serverFor(fixture);
    server.setSchedulerEnabled(true);
    await reaches(server, id, "MANAGER_REVIEW");
    server.setSchedulerEnabled(false);

    const prompts = promptsTo(server.runtime.sessionDir(id, "worker"));
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain("?? b.txt");

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
      [id]: { WORK: [{ submit: true, notes: "forgot to commit" }] },
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
        WORK: [
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

    server.shutdown();
  }, 30000);

  test("an agent stuck on one command is asked whether it is blocked, not held", async () => {
    const fixture = makeFixture();
    const id = readyTask(fixture, "Do a thing");
    setPlan(fixture, {
      [id]: {
        WORK: [
          { loop: LOOP_LIMIT },
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

    const prompts = promptsTo(server.runtime.sessionDir(id, "worker"));
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain("zig build");
    expect(server.transitions.read().some((e) => e.transition === "hold")).toBe(
      false,
    );

    server.shutdown();
  }, 30000);

  test("an agent that keeps looping is held only once the nudges run out", async () => {
    const fixture = makeFixture();
    const id = readyTask(fixture, "Do a thing");
    setPlan(fixture, { [id]: { WORK: [{ loop: LOOP_LIMIT }] } });

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
        WORK: [
          {
            submit: true,
            notes: "did the work",
            commit: { path: "a.txt", contents: "a" },
          },
        ],
        WORK_REVIEW: [
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
    await reaches(server, id, "MANAGER_REVIEW");
    server.setSchedulerEnabled(false);

    const prompts = promptsTo(server.runtime.sessionDir(id, "reviewer"));
    expect(prompts).toHaveLength(2);

    expect(server.transitions.read().some((e) => e.transition === "hold")).toBe(
      false,
    );

    server.shutdown();
  }, 30000);

  test("a held task is never dispatched again", async () => {
    const fixture = makeFixture();
    const id = readyTask(fixture, "Do a thing");
    setPlan(fixture, {
      [id]: { WORK: [{ blocked: "a wall" }] },
    });

    const server = await serverFor(fixture);
    server.setSchedulerEnabled(true);
    await reaches(server, id, "HELD_WORK");
    await settle(server, 3);

    expect(stateOf(server, id)).toBe("HELD_WORK");
    expect(promptsTo(server.runtime.sessionDir(id, "worker"))).toHaveLength(2);

    server.shutdown();
  }, 30000);

  test("a nudge waits for the turn the agent is already in", async () => {
    const fixture = makeFixture();
    const id = readyTask(fixture, "Do a thing");
    setPlan(fixture, {
      [id]: {
        WORK: [{ raw_final_message: "prose", start_delay_ms: 50 }],
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

  test("an edited assignment is restored above the notes, and the redo passes", async () => {
    const fixture = makeFixture();
    const id = readyTask(fixture, "Do a thing");
    setBody(fixture, id, "\n# The body of this task\n");
    setPlan(fixture, {
      [id]: {
        WORK: [
          {
            tamper: { from: "# The body of this task", to: "# Changed" },
            submit: true,
            notes: "did the work",
            commit: { path: "a.txt", contents: "a" },
          },
          { submit: true },
        ],
        WORK_REVIEW: [{ submit: true }],
      },
    });

    const server = await serverFor(fixture);
    server.setSchedulerEnabled(true);
    await reaches(server, id, "MANAGER_REVIEW");
    server.setSchedulerEnabled(false);

    const prompts = promptsTo(server.runtime.sessionDir(id, "worker"));
    expect(prompts).toHaveLength(2);

    const assignment = fs.readFileSync(server.runtime.assignment(id), "utf-8");
    expect(assignment).toContain("# The body of this task");
    expect(assignment).not.toContain("# Changed");
    expect(assignment).toContain("did the work");

    server.shutdown();
  }, 30000);

  test("a worker that submits without appending notes is prompted, then held", async () => {
    const fixture = makeFixture();
    const id = readyTask(fixture, "Do a thing");
    setPlan(fixture, {
      [id]: {
        WORK: [{ submit: true, commit: { path: "a.txt", contents: "a" } }],
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

describe("the server: a review that comes back unusable", () => {
  test("an assignment the reviewer changed is restored, and the review is prompted in place", async () => {
    const fixture = makeFixture();
    const id = readyTask(fixture, "Do a thing");
    setBody(fixture, id, "\n# The body of this task\n");
    setPlan(fixture, {
      [id]: {
        WORK: [
          {
            submit: true,
            notes: "did the work",
            commit: { path: "a.txt", contents: "a" },
          },
        ],
        WORK_REVIEW: [
          {
            submit: true,
            tamper: { from: "# The body of this task", to: "# Changed" },
          },
          { submit: true },
        ],
      },
    });

    const server = await serverFor(fixture);
    server.setSchedulerEnabled(true);
    await reaches(server, id, "MANAGER_REVIEW");
    server.setSchedulerEnabled(false);

    const log = server.transitions.read();
    expect(log.some((e) => e.transition === "fail")).toBe(false);

    const prompts = promptsTo(server.runtime.sessionDir(id, "reviewer"));
    expect(prompts).toHaveLength(2);

    const assignment = fs.readFileSync(server.runtime.assignment(id), "utf-8");
    expect(assignment).toContain("# The body of this task");
    expect(assignment).not.toContain("# Changed");
    expect(assignment).toContain("did the work");

    server.shutdown();
  }, 30000);

  test("a review that delegates work leaves it for the manager to read", async () => {
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
        WORK_REVIEW: [
          { submit: true, delegations: ["the same bug lives in fetch.ts"] },
        ],
      },
    });

    const server = await serverFor(fixture);
    server.setSchedulerEnabled(true);
    await reaches(server, id, "MANAGER_REVIEW");
    server.setSchedulerEnabled(false);

    server.shutdown();
  }, 30000);
});

describe("the server: rotation and history", () => {
  test("a re-dispatch rotates the previous attempt into history", async () => {
    const fixture = makeFixture();
    const id = readyTask(fixture, "Do a thing");
    setPlan(fixture, {
      [id]: {
        WORK: [{ raw_final_message: "prose", notes: "attempt one" }],
      },
    });

    const server = await serverFor(fixture);
    server.setSchedulerEnabled(true);
    await reaches(server, id, "HELD_WORK");
    server.setSchedulerEnabled(false);

    setPlan(fixture, {
      [id]: {
        WORK: [
          {
            submit: true,
            notes: "attempt two",
            commit: { path: "a.txt", contents: "a" },
          },
        ],
        WORK_REVIEW: [{ submit: true }],
      },
    });
    server.transition(id, "resume", {}, "manager");
    server.setSchedulerEnabled(true);
    await reaches(server, id, "MANAGER_REVIEW");
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

    const log = fs.readFileSync(server.runtime.rpcLog(id), "utf-8");
    const settled = log
      .split("\n")
      .filter((line) => line.includes(`"agent_settled"`));
    expect(settled.length).toBeGreaterThanOrEqual(2);

    server.shutdown();
  }, 30000);
});

describe("the server: a throw while finishing an agent", () => {
  test("the slot is freed and the manager survives instead of rejecting into nothing", async () => {
    const fixture = makeFixture();
    const id = readyTask(fixture, "A task");
    setPlan(fixture, {
      [id]: { WORK: [{ stop_reason: "aborted", break_git: true }] },
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
