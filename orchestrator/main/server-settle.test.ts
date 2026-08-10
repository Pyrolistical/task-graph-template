import { describe, expect } from "bun:test";
import { at, present } from "../testing/present.ts";
import { testInTempDirs } from "../testing/temp-dirs.ts";
import fs from "node:fs/promises";
import path from "node:path";
import { activeTaskPath } from "../adapters/task-store.ts";
import { SlotsView } from "../domain/agents.ts";
import { parse } from "../domain/schema.ts";
import * as git from "../adapters/git.ts";
import {
  makeFixture,
  promptsOverlapping,
  promptsTo,
  readyTask,
  setBody,
  setPlan,
} from "../testing/fixture.ts";
import { ISSUES } from "../domain/issues.ts";
import { LOOP_LIMIT } from "../domain/protocol.ts";
import { bodyOf } from "../testing/graph-jig.ts";
import {
  filesOf,
  transitionsOf,
  pathsOf,
  promptsOf,
  reaches,
  reviewCycle,
  runOnce,
  serverFor,
  settle,
  settleTo,
  stateOf,
  until,
  walkTo,
  taskOf,
  workspaceOf,
} from "../testing/server-jig.ts";

describe("Feature: what a reviewer sends back to the worker", () => {
  testInTempDirs(
    "a finding lands under # Review findings and the task drops back to WORK",
    async () => {
      const fixture = await makeFixture();
      const id = await readyTask(fixture, "Do a thing");
      await setPlan(fixture, {
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

      // Given work that a reviewer will find a problem with
      const server = await serverFor(fixture);

      // When the work is done, checked and reviewed
      await reviewCycle(server);

      // Then the finding is written into the task body for the worker to read
      const body = await fs.readFile(
        activeTaskPath(fixture.tasksDir, id),
        "utf-8",
      );
      expect(body).toContain("# Review findings");
      expect(body).toContain("- the null case is untested");

      // Then it is also left where the next dispatch will pick it up
      expect(await (await filesOf(fixture)).findings(id)).toEqual([
        "the null case is untested",
      ]);

      // Then the transition is recorded as the server's, not the reviewer's
      const applied = present(
        (await (await transitionsOf(server)).read()).find(
          (e) => e.transition === "feedback" && e.from === "WORK_REVIEW",
        ),
        "a feedback transition out of WORK_REVIEW",
      );
      expect(applied.to).toBe("WORK");
      expect(applied.by).toBe("server");

      await server.shutdown();
    },
    30000,
  );

  testInTempDirs(
    "the findings reach the worker as its next prompt, and are cleared once it submits",
    async () => {
      const fixture = await makeFixture();
      const id = await readyTask(fixture, "Do a thing");
      await setPlan(fixture, {
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

      // Given work sent back once by a review and then finished
      const server = await serverFor(fixture);

      // When the task runs to the manager
      await settleTo(server, id, "MANAGER_REVIEW");

      // Then the worker's second prompt carried the findings it had to answer
      expect(
        (await promptsTo(pathsOf(server).sessionDir(id, "worker")))[1],
      ).toBe(
        promptsOf(server).fragment("WORK-with-findings", {
          findings: [{ finding: "the null case is untested" }],
        }),
      );
      // Then nothing is left queued once the worker has answered them
      expect(await fs.exists(pathsOf(server).findings(id))).toBe(false);
      expect(await fs.exists(pathsOf(server).messageFile(id, "WORK"))).toBe(
        false,
      );

      await server.shutdown();
    },
    30000,
  );

  testInTempDirs(
    "the worker sent back by a review works in its own session, never the review's",
    async () => {
      const fixture = await makeFixture();
      const id = await readyTask(fixture, "Do a thing");
      await setPlan(fixture, {
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

      // Given work sent back once by a review and then finished
      const server = await serverFor(fixture);

      // When the task runs to the manager
      await walkTo(server, id, "MANAGER_REVIEW");

      // Then the worker was resumed in its own session, twice, never the review's
      const worked = path.join(
        pathsOf(server).sessionDir(id, "worker"),
        `${id}-worker.jsonl`,
      );
      expect((await workspaceOf(server, id)).session).toBe(worked);
      expect(
        await promptsTo(pathsOf(server).sessionDir(id, "worker")),
      ).toHaveLength(2);
      expect(
        await promptsTo(pathsOf(server).sessionDir(id, "reviewer")),
      ).toHaveLength(2);

      await server.shutdown();
    },
    30000,
  );

  testInTempDirs(
    "the reviewer gets its own session and a worktree with the work on it",
    async () => {
      const fixture = await makeFixture();
      const id = await readyTask(fixture, "Do a thing");
      await setPlan(fixture, {
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

      // Given work an agent committed and a reviewer accepted
      const server = await serverFor(fixture);

      // When the task runs to the manager
      await walkTo(server, id, "MANAGER_REVIEW");

      // Then the reviewer saw a worktree with the work committed on it
      const head = (
        await git.gitOrThrow(pathsOf(server).worktree(id), [
          "rev-parse",
          "HEAD",
        ])
      ).trim();
      const base = (
        await git.gitOrThrow(pathsOf(server).worktree(id), [
          "rev-parse",
          "master",
        ])
      ).trim();
      expect(head).not.toBe(base);

      // Then the reviewer read the work in a session of its own
      const workSessions = await fs.readdir(
        pathsOf(server).sessionDir(id, "worker"),
      );
      const reviewSessions = await fs.readdir(
        pathsOf(server).sessionDir(id, "reviewer"),
      );
      expect(workSessions.length).toBeGreaterThan(0);
      expect(reviewSessions.length).toBeGreaterThan(0);
      expect(reviewSessions).not.toEqual(workSessions);

      await server.shutdown();
    },
    30000,
  );
});

describe("Feature: a review that fails twice", () => {
  testInTempDirs(
    "a first review failure bounces the work back and is counted",
    async () => {
      const fixture = await makeFixture();
      const id = await readyTask(fixture, "Do a thing");
      await setPlan(fixture, {
        [id]: {
          WORK: [
            {
              submit: true,
              notes: "round one",
              commit: { path: "a.txt", contents: "a" },
            },
          ],
          WORK_REVIEW: [{ submit: true, findings: ["finding one"] }],
        },
      });

      // Given work a reviewer will send back
      const server = await serverFor(fixture);

      // Given a server with its scheduler enabled
      await server.setSchedulerEnabled(true);

      // When the work is done, checked and reviewed once
      await until(server, async () =>
        (await (await transitionsOf(server)).read()).some(
          (e) => e.transition === "feedback",
        ),
      );

      // Then the failure is counted and the work only bounced back
      expect(await (await filesOf(fixture)).failures(id)).toBe(1);
      expect(await stateOf(server, id)).toBe("WORK");

      await server.shutdown();
    },
    30000,
  );

  testInTempDirs(
    "a second review failure holds the task with the findings as the reason",
    async () => {
      const fixture = await makeFixture();
      const id = await readyTask(fixture, "Do a thing");
      await setPlan(fixture, {
        [id]: {
          WORK: [
            {
              submit: true,
              notes: "round one",
              commit: { path: "a.txt", contents: "a" },
            },
            {
              submit: true,
              notes: "round two",
              commit: { path: "b.txt", contents: "b" },
            },
          ],
          WORK_REVIEW: [
            { submit: true, findings: ["finding one"] },
            { submit: true, findings: ["finding two"] },
          ],
        },
      });

      // Given work sent back once by a review
      const server = await serverFor(fixture);

      // When the review fails a second time
      await settleTo(server, id, "HELD_WORK");

      // Then the task is held with the second round's findings as the reason
      const task = await taskOf(server, id);
      expect(task.state).toBe("HELD_WORK");
      expect(task.held_reason).toBe(
        "failed 2 rounds of WORK_REVIEW with:\n- finding two",
      );
      expect(task.claimed_by).toBeNull();

      // Then only the first round's findings reached the body
      const body = await bodyOf(activeTaskPath(fixture.tasksDir, id));
      expect(body).toContain("- finding one");
      expect(body).not.toContain("finding two");

      // Then the count file is gone and the findings wait for the resume
      expect(await fs.exists(pathsOf(server).reviewFailures(id))).toBe(false);
      expect(await (await filesOf(fixture)).findings(id)).toEqual([
        "finding two",
      ]);

      await server.shutdown();
    },
    30000,
  );

  testInTempDirs(
    "a review that finally passes clears the count",
    async () => {
      const fixture = await makeFixture();
      const id = await readyTask(fixture, "Do a thing");
      await setPlan(fixture, {
        [id]: {
          WORK: [
            {
              submit: true,
              notes: "round one",
              commit: { path: "a.txt", contents: "a" },
            },
            {
              submit: true,
              notes: "round two",
              commit: { path: "b.txt", contents: "b" },
            },
          ],
          WORK_REVIEW: [
            { submit: true, findings: ["finding one"] },
            { submit: true },
          ],
        },
      });

      // Given work sent back once and then accepted
      const server = await serverFor(fixture);

      // When the task runs to the manager
      await walkTo(server, id, "MANAGER_REVIEW");

      // Then the passing review cleared the count
      expect(await stateOf(server, id)).toBe("MANAGER_REVIEW");
      expect(await fs.exists(pathsOf(server).reviewFailures(id))).toBe(false);
      expect(
        (await (await transitionsOf(server)).read()).some(
          (e) => e.transition === "hold",
        ),
      ).toBe(false);

      await server.shutdown();
    },
    30000,
  );

  testInTempDirs(
    "manager review bounces are never counted",
    async () => {
      const fixture = await makeFixture();
      const id = await readyTask(fixture, "Do a thing");
      await setPlan(fixture, {
        [id]: {
          WORK: [
            {
              submit: true,
              notes: "round one",
              commit: { path: "a.txt", contents: "a" },
            },
            {
              submit: true,
              notes: "round two",
              commit: { path: "b.txt", contents: "b" },
            },
          ],
          WORK_REVIEW: [{ submit: true }],
        },
      });

      // Given work the manager will send back twice
      const server = await serverFor(fixture);
      await walkTo(server, id, "MANAGER_REVIEW");
      await server.transition(
        id,
        "feedback",
        { findings: ["the manager wants changes"] },
        "manager",
      );
      await walkTo(server, id, "MANAGER_REVIEW");

      // When the manager sends it back again after the redo
      await server.transition(
        id,
        "feedback",
        { findings: ["the manager wants more changes"] },
        "manager",
      );

      // Then it is back in WORK, never held, and no review was ever counted
      expect(await stateOf(server, id)).toBe("WORK");
      expect(
        (await (await transitionsOf(server)).read()).some(
          (e) => e.transition === "hold",
        ),
      ).toBe(false);
      expect(await fs.exists(pathsOf(server).reviewFailures(id))).toBe(false);

      await server.shutdown();
    },
    30000,
  );

  testInTempDirs(
    "resume after a review-failure hold starts the count fresh",
    async () => {
      const fixture = await makeFixture();
      const id = await readyTask(fixture, "Do a thing");
      await setPlan(fixture, {
        [id]: {
          WORK: [
            {
              submit: true,
              notes: "round one",
              commit: { path: "a.txt", contents: "a" },
            },
            {
              submit: true,
              notes: "round two",
              commit: { path: "b.txt", contents: "b" },
            },
            {
              submit: true,
              notes: "round three",
              commit: { path: "c.txt", contents: "c" },
            },
          ],
          WORK_REVIEW: [
            { submit: true, findings: ["finding one"] },
            { submit: true, findings: ["finding two"] },
            { submit: true, findings: ["finding three"] },
          ],
        },
      });

      // Given work held after two review failures
      const server = await serverFor(fixture);
      await walkTo(server, id, "HELD_WORK");

      // Given the manager resumes it, and a server with its scheduler enabled
      await server.transition(id, "resume", {}, "manager");
      await server.setSchedulerEnabled(true);

      // When the redo fails once
      await until(
        server,
        async () => (await (await filesOf(fixture)).failures(id)) === 1,
      );

      // Then one failure only bounces it, never holds it again
      expect(await stateOf(server, id)).toBe("WORK");
      expect(
        (await (await transitionsOf(server)).read()).filter(
          (e) => e.transition === "hold",
        ),
      ).toHaveLength(1);

      await server.shutdown();
    },
    30000,
  );
});

describe("Feature: a submit with nothing committed behind it", () => {
  testInTempDirs(
    "a branch with no commit on it comes back for one",
    async () => {
      const fixture = await makeFixture();
      const id = await readyTask(fixture, "Do a thing");
      await setPlan(fixture, {
        [id]: {
          WORK: [
            { submit: true, notes: "I forgot to commit" },
            { submit: true, commit: { path: "a.txt", contents: "a\n" } },
          ],
          WORK_REVIEW: [{ submit: true }],
        },
      });

      // Given a worker that submits once without committing, then commits
      const server = await serverFor(fixture);

      // When the task runs to the manager
      await walkTo(server, id, "MANAGER_REVIEW");

      // Then it was nudged once and never held, because the second try passed
      const prompts = await promptsTo(pathsOf(server).sessionDir(id, "worker"));
      expect(prompts).toHaveLength(2);
      expect(
        (await (await transitionsOf(server)).read()).some(
          (e) => e.transition === "hold",
        ),
      ).toBe(false);

      await server.shutdown();
    },
    30000,
  );

  testInTempDirs(
    "an uncommitted change comes back with what git status reports",
    async () => {
      const fixture = await makeFixture();
      const id = await readyTask(fixture, "Do a thing");
      await setPlan(fixture, {
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

      // Given a worker that leaves one file uncommitted, then commits it
      const server = await serverFor(fixture);

      // When the task runs to the manager
      await walkTo(server, id, "MANAGER_REVIEW");

      // Then it was told which file it had left behind, and committed it
      const prompts = await promptsTo(pathsOf(server).sessionDir(id, "worker"));
      expect(prompts).toHaveLength(2);
      expect(prompts[1]).toContain("?? b.txt");
      expect(await git.uncommitted(pathsOf(server).worktree(id))).toEqual([]);
      expect(
        await git.commitCount(pathsOf(server).worktree(id), "master"),
      ).toBeGreaterThan(0);

      await server.shutdown();
    },
    30000,
  );

  testInTempDirs(
    "an agent that never commits is held, and the slot is released",
    async () => {
      const fixture = await makeFixture();
      const id = await readyTask(fixture, "Do a thing");
      await setPlan(fixture, {
        [id]: { WORK: [{ submit: true, notes: "forgot to commit" }] },
      });

      // Given a worker that submits without ever committing anything
      const server = await serverFor(fixture);

      // When the server nudges it until the attempts run out
      await walkTo(server, id, "HELD_WORK", 20);

      // Then the task is held with a reason the manager can act on
      const task = await taskOf(server, id);
      expect(task.held_reason).toBe(
        "the agent submitted work it never committed: nothing is committed on the branch",
      );
      expect(task.claimed_by).toBeNull();
      expect(
        await promptsTo(pathsOf(server).sessionDir(id, "worker")),
      ).toHaveLength(5);
      expect(at(server.slotRows(), 0).state).toBe("IDLE");

      await server.shutdown();
    },
    30000,
  );
});

describe("Feature: an agent that stops short of finishing", () => {
  testInTempDirs(
    "a blocked result holds the task with its message as the reason",
    async () => {
      const fixture = await makeFixture();
      const id = await readyTask(fixture, "Do a thing");
      await setPlan(fixture, {
        [id]: {
          WORK: [
            {
              blocked: "the staging database is unreachable",
              notes: "tried twice",
            },
          ],
        },
      });

      // Given a worker that reports it cannot go on
      const server = await serverFor(fixture);

      // When the server settles its turn
      await walkTo(server, id, "HELD_WORK");

      // Then the task is parked with the agent's own words as the reason
      const task = await taskOf(server, id);
      expect(task.state).toBe("HELD_WORK");
      expect(task.held_reason).toBe("the staging database is unreachable");
      expect(task.claimed_by).toBeNull();

      const prompts = await promptsTo(pathsOf(server).sessionDir(id, "worker"));
      expect(prompts).toHaveLength(2);

      await server.shutdown();
    },
    30000,
  );

  testInTempDirs(
    "an agent stuck on one command is asked whether it is blocked, not held",
    async () => {
      const fixture = await makeFixture();
      const id = await readyTask(fixture, "Do a thing");
      await setPlan(fixture, {
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

      // Given a worker that repeats one command and then does the work
      const server = await serverFor(fixture);

      // When the task runs to the manager
      await walkTo(server, id, "MANAGER_REVIEW");

      // Then it was asked about the command it repeated, and never held
      const prompts = await promptsTo(pathsOf(server).sessionDir(id, "worker"));
      expect(prompts).toHaveLength(2);
      expect(prompts[1]).toContain("zig build");
      expect(
        (await (await transitionsOf(server)).read()).some(
          (e) => e.transition === "hold",
        ),
      ).toBe(false);

      await server.shutdown();
    },
    30000,
  );

  testInTempDirs(
    "an agent that keeps looping is held only once the nudges run out",
    async () => {
      const fixture = await makeFixture();
      const id = await readyTask(fixture, "Do a thing");
      await setPlan(fixture, { [id]: { WORK: [{ loop: LOOP_LIMIT }] } });

      // Given a worker that repeats one command every time it is nudged
      const server = await serverFor(fixture);

      // When the server nudges it until the attempts run out
      await walkTo(server, id, "HELD_WORK");

      // Then the task is held, naming the command it was stuck on
      expect((await taskOf(server, id)).held_reason).toContain("zig build");
      expect(
        await promptsTo(pathsOf(server).sessionDir(id, "worker")),
      ).toHaveLength(ISSUES.looping.attempts + 1);

      await server.shutdown();
    },
    30000,
  );

  testInTempDirs(
    "a reviewer that reconsiders its blocker submits instead",
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
          WORK_REVIEW: [
            { blocked: "the retry loop in fetch.ts has the same bug" },
            { submit: true },
          ],
        },
      });

      // Given a reviewer that reports a blocker and then submits anyway
      const server = await serverFor(fixture);

      // When the task runs to the manager
      await walkTo(server, id, "MANAGER_REVIEW");

      // Then it was asked once and the task was never held
      const prompts = await promptsTo(
        pathsOf(server).sessionDir(id, "reviewer"),
      );
      expect(prompts).toHaveLength(2);
      expect(
        (await (await transitionsOf(server)).read()).some(
          (e) => e.transition === "hold",
        ),
      ).toBe(false);

      await server.shutdown();
    },
    30000,
  );

  testInTempDirs(
    "a held task is never dispatched again",
    async () => {
      const fixture = await makeFixture();
      const id = await readyTask(fixture, "Do a thing");
      await setPlan(fixture, {
        [id]: { WORK: [{ blocked: "a wall" }] },
      });

      // Given a task held after its agent reported a blocker
      const server = await serverFor(fixture);
      await server.setSchedulerEnabled(true);
      await reaches(server, id, "HELD_WORK");

      // When the scheduler runs for three more ticks
      await settle(server, 3);

      // Then it is still held, and no second agent was ever prompted
      expect(await stateOf(server, id)).toBe("HELD_WORK");
      expect(
        await promptsTo(pathsOf(server).sessionDir(id, "worker")),
      ).toHaveLength(2);

      await server.shutdown();
    },
    30000,
  );

  testInTempDirs(
    "a nudge waits for the turn the agent is already in",
    async () => {
      const fixture = await makeFixture();
      const id = await readyTask(fixture, "Do a thing");
      await setPlan(fixture, {
        [id]: {
          WORK: [{ raw_final_message: "prose", start_delay_ms: 50 }],
        },
      });

      // Given an agent that answers in prose and takes time to start each turn
      const server = await serverFor(fixture);

      // When the server nudges it until the attempts run out
      await walkTo(server, id, "HELD_WORK", 40);

      // Then no nudge was sent into a turn the agent was still inside
      const sessionDir = pathsOf(server).sessionDir(id, "worker");
      expect(await promptsOverlapping(sessionDir)).toEqual([]);
      expect(await promptsTo(sessionDir)).toHaveLength(
        ISSUES["missing-result"].attempts + 1,
      );

      await server.shutdown();
    },
    30000,
  );

  testInTempDirs(
    "an edited assignment is restored above the notes, and the redo passes",
    async () => {
      const fixture = await makeFixture();
      const id = await readyTask(fixture, "Do a thing");
      await setBody(fixture, id, "\n# The body of this task\n");
      await setPlan(fixture, {
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

      // Given a worker that rewrites the part of its assignment it may not
      const server = await serverFor(fixture);

      // When the task runs to the manager
      await walkTo(server, id, "MANAGER_REVIEW");

      // Then what it changed was put back and only its own section survives
      const prompts = await promptsTo(pathsOf(server).sessionDir(id, "worker"));
      expect(prompts).toHaveLength(2);
      const assignment = await fs.readFile(
        pathsOf(server).assignment(id),
        "utf-8",
      );
      expect(assignment).toContain("# The body of this task");
      expect(assignment).not.toContain("# Changed");
      expect(assignment).toContain("did the work");

      await server.shutdown();
    },
    30000,
  );

  testInTempDirs(
    "a worker that submits without appending notes is prompted, then held",
    async () => {
      const fixture = await makeFixture();
      const id = await readyTask(fixture, "Do a thing");
      await setPlan(fixture, {
        [id]: {
          WORK: [{ submit: true, commit: { path: "a.txt", contents: "a" } }],
        },
      });

      // Given a worker that commits but never writes its notes
      const server = await serverFor(fixture);

      // When the server nudges it until the attempts run out
      await walkTo(server, id, "HELD_WORK");

      // Then the task is held, saying which part of the assignment is missing
      const task = await taskOf(server, id);
      expect(task.state).toBe("HELD_WORK");
      expect(task.held_reason).toContain(
        "without appending implementation notes",
      );
      expect(
        await promptsTo(pathsOf(server).sessionDir(id, "worker")),
      ).toHaveLength(5);

      await server.shutdown();
    },
    30000,
  );
});

describe("Feature: a review that comes back unusable", () => {
  testInTempDirs(
    "an assignment the reviewer changed is restored, and the review is prompted in place",
    async () => {
      const fixture = await makeFixture();
      const id = await readyTask(fixture, "Do a thing");
      await setBody(fixture, id, "\n# The body of this task\n");
      await setPlan(fixture, {
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

      // Given a reviewer that rewrites the assignment it was given
      const server = await serverFor(fixture);

      // When the task runs to the manager
      await walkTo(server, id, "MANAGER_REVIEW");

      // Then the task never went back to the worker over the reviewer's mistake
      const log = await (await transitionsOf(server)).read();
      expect(log.some((e) => e.transition === "fail")).toBe(false);

      // Then the reviewer was prompted again in place, and its edit was undone
      const prompts = await promptsTo(
        pathsOf(server).sessionDir(id, "reviewer"),
      );
      expect(prompts).toHaveLength(2);
      const assignment = await fs.readFile(
        pathsOf(server).assignment(id),
        "utf-8",
      );
      expect(assignment).toContain("# The body of this task");
      expect(assignment).not.toContain("# Changed");
      expect(assignment).toContain("did the work");

      await server.shutdown();
    },
    30000,
  );
});

describe("Feature: keeping the attempts an agent already made", () => {
  testInTempDirs(
    "a re-dispatch rotates the previous attempt into history",
    async () => {
      const fixture = await makeFixture();
      const id = await readyTask(fixture, "Do a thing");
      await setPlan(fixture, {
        [id]: {
          WORK: [{ raw_final_message: "prose", notes: "attempt one" }],
        },
      });

      // Given a task held after an attempt that wrote notes into its assignment
      const server = await serverFor(fixture);
      await walkTo(server, id, "HELD_WORK");

      // Given the manager resumes it with a plan that lets the redo finish
      await setPlan(fixture, {
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
      await server.transition(id, "resume", {}, "manager");

      // When the second attempt finishes the work
      await walkTo(server, id, "MANAGER_REVIEW");

      // Then the first attempt is kept in history and the second is the one that counts
      const history = (await fs.readdir(pathsOf(server).history(id))).sort();
      expect(history).toEqual(["ASSIGNMENT.1.md"]);
      expect(
        await fs.readFile(
          path.join(pathsOf(server).history(id), "ASSIGNMENT.1.md"),
          "utf-8",
        ),
      ).toContain("attempt one");

      const body = await fs.readFile(
        activeTaskPath(fixture.tasksDir, id),
        "utf-8",
      );
      expect(body).toContain("attempt two");

      await server.shutdown();
    },
    30000,
  );
});

describe("Feature: a failure while finishing with an agent", () => {
  testInTempDirs(
    "the slot is freed and the manager survives instead of rejecting into nothing",
    async () => {
      const fixture = await makeFixture();
      const id = await readyTask(fixture, "A task");
      await setPlan(fixture, {
        [id]: { WORK: [{ stop_reason: "aborted", break_git: true }] },
      });

      // Given an agent whose abort leaves the workspace unable to be harvested
      const server = await serverFor(fixture);

      // When the server settles its turn and finishes with it
      await runOnce(server);

      // Then the slot is freed and the failure is logged rather than thrown away
      await server.writeViews();
      const view = parse(
        SlotsView,
        JSON.parse(await fs.readFile(pathsOf(server).slotsView, "utf-8")),
        "slots view",
        pathsOf(server).slotsView,
      );
      for (const slot of view.slots) {
        expect(slot.state).toBe("IDLE");
      }
      expect(await fs.readFile(pathsOf(server).serverLog, "utf-8")).toContain(
        `on ${id} failed:`,
      );

      await server.shutdown();
    },
    30000,
  );
});
