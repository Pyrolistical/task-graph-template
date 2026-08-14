import { describe, expect } from "bun:test";
import { testInTempDirs } from "../../testing/temp-dirs.ts";
import fs from "node:fs/promises";
import {
  activeTaskPath,
  closedTaskPath,
  createTask,
  readTaskFile,
} from "./task-store.ts";
import { requireWorkspace } from "../../vocabulary/task.ts";
import {
  type TransitionArgs,
  type TransitionName,
  type TransitionResult,
} from "../../vocabulary/state-machine.ts";
import { applyTransition } from "./task-documents.ts";
import {
  ORCHESTRATOR_DIR,
  addDeps,
  bodyOf,
  claim,
  closeTask,
  closedPath,
  deadPid,
  editTask,
  enteredAt,
  makeTasksDir,
  metaOf,
  newTask,
  newTasks,
  planThrough,
  run,
  toAgentReview,
  toChecking,
  toManagerReview,
  toPlan,
  toWorking,
  unclaim,
  writeTask,
} from "../../testing/graph-jig.ts";
import { at } from "../../testing/present.ts";
async function apply(
  dir: string,
  id: string,
  name: TransitionName,
  args: TransitionArgs,
): Promise<TransitionResult> {
  return await applyTransition(dir, id, name, args);
}
describe("Feature: a task that waits on other tasks", () => {
  testInTempDirs(
    "a task with no dependencies starts as soon as it is submitted",
    async () => {
      // Given a new task nothing was edited into
      const { dir, id } = await newTask();
      // When the task is submitted
      const result = await run(dir, id, "submit_designing");
      // Then it enters the design phase straight away
      expect(result.to).toBe("DESIGN");
    },
  );
  testInTempDirs(
    "a task with a dependency waits instead of starting",
    async () => {
      // Given a new task edited to depend on another
      const { dir, ids } = await newTasks(2);
      const main = at(ids, 0);
      const dep = at(ids, 1);
      await addDeps(dir, main, dep);
      // When the task is submitted
      const result = await run(dir, main, "submit_designing");
      // Then it waits, still carrying the dependency it is waiting on
      expect(result.to).toBe("BLOCKED_DESIGN");
      expect((await metaOf(dir, main)).depends_on).toEqual([dep]);
    },
  );
  testInTempDirs(
    "a blocked task submitted again stays where it is",
    async () => {
      // Given a task already blocked behind a dependency
      const { dir, ids } = await newTasks(2);
      const main = at(ids, 0);
      const dep = at(ids, 1);
      await addDeps(dir, main, dep);
      await run(dir, main, "submit_designing");
      // When it is submitted again
      const result = await run(dir, main, "submit_designing");
      // Then the machine moves it nowhere, and it keeps waiting
      expect(result.to).toBeUndefined();
      expect((await metaOf(dir, main)).state).toBe("BLOCKED_DESIGN");
    },
  );
  testInTempDirs(
    "a blocked task starts once its last dependency is gone",
    async () => {
      // Given a task blocked behind two dependencies, one since edited out
      const { dir, ids } = await newTasks(3);
      const main = at(ids, 0);
      const first = at(ids, 1);
      const second = at(ids, 2);
      await addDeps(dir, main, first, second);
      await run(dir, main, "submit_designing");
      await editTask(dir, main, (meta) => {
        meta.depends_on = [first];
      });
      expect((await run(dir, main, "submit_designing")).to).toBeUndefined();
      // Given the last dependency edited out of it
      await editTask(dir, main, (meta) => {
        meta.depends_on = [];
      });
      // When it is submitted with its dependencies gone
      const result = await run(dir, main, "submit_designing");
      // Then it starts, because nothing is left for it to wait on
      expect(result.to).toBe("DESIGN");
    },
  );
  testInTempDirs(
    "a dependency on a task that is gone can be edited away",
    async () => {
      // Given a task blocked on an id no document carries any more
      const dir = await makeTasksDir();
      const main = await writeTask(dir, {
        id: "000001",
        state: "BLOCKED_DESIGN",
        depends_on: ["000999"],
      });
      await editTask(dir, main, (meta) => {
        meta.depends_on = [];
      });
      // When the task is submitted
      const result = await run(dir, main, "submit_designing");
      // Then it starts, rather than waiting on something that will never close
      expect(result.to).toBe("DESIGN");
      expect((await metaOf(dir, main)).depends_on).toEqual([]);
    },
  );
});
describe("Feature: taking and clearing a claim", () => {
  testInTempDirs(
    "a claim records the agent and its process, not a new state",
    async () => {
      // Given a task waiting in the work stage
      const { dir, id } = await planThrough();
      expect((await metaOf(dir, id)).state).toBe("WORK");
      // When an agent claims it
      await claim(dir, id, "agent-1", 4242);
      // Then the holder and its process are recorded, and the stage is unchanged
      const meta = await metaOf(dir, id);
      expect(meta.state).toBe("WORK");
      expect(meta.claimed_by).toBe("agent-1");
      expect(meta.claimed_pid).toBe(4242);
    },
  );
  testInTempDirs(
    "a task an agent already holds cannot be claimed again",
    async () => {
      // Given a task an agent is working on
      const { dir, id } = await toWorking();
      // When a second agent claims it
      const attempt = async () => await claim(dir, id, "agent-2");
      // Then it is refused, and the first agent keeps it
      await expect(attempt()).rejects.toThrow(/already claimed by "agent-1"/);
      expect((await metaOf(dir, id)).claimed_by).toBe("agent-1");
    },
  );
  testInTempDirs(
    "a claim whose process is still alive is not cleared",
    async () => {
      // Given a task claimed by an agent that is still running
      const { dir, id } = await toWorking();
      // When the claim is cleared
      const attempt = async () => await unclaim(dir, id);
      // Then it is refused, so a live agent is never reaped
      await expect(attempt()).rejects.toThrow(
        /still claimed by a live process/,
      );
    },
  );
  testInTempDirs(
    "a claim whose process is gone is cleared where it stands",
    async () => {
      // Given a task claimed by an agent whose process has exited
      const { dir, id } = await newTask();
      await run(dir, id, "submit_designing");
      await claim(dir, id, "dead-agent", await deadPid());
      // When the claim is cleared
      await unclaim(dir, id);
      // Then the task keeps its stage and goes back into the queue unheld
      const meta = await metaOf(dir, id);
      expect(meta.state).toBe("DESIGN");
      expect(meta.claimed_by).toBeUndefined();
      expect(meta.claimed_pid).toBeUndefined();
    },
  );
});
describe("Feature: what a review writes into the task body", () => {
  testInTempDirs(
    "a work review's finding is appended for the worker to read",
    async () => {
      // Given finished work under review
      const { dir, id } = await toAgentReview();
      // When the reviewer sends it back with a finding
      const result = await run(dir, id, "feedback", "fix null handling");
      // Then the worker gets the task back with the finding written into it
      expect(result.to).toBe("WORK");
      const body = await bodyOf(activeTaskPath(dir, id));
      expect(body).toContain("# Review findings");
      expect(body).toContain("- fix null handling");
    },
  );
  testInTempDirs("every finding in a review lands in the body", async () => {
    // Given finished work under review
    const { dir, id } = await toAgentReview();
    // When the reviewer sends it back with two findings
    await run(dir, id, "feedback", "first", "second");
    // Then both are written in, so none is lost between reviews
    const body = await bodyOf(activeTaskPath(dir, id));
    expect(body).toContain("- first");
    expect(body).toContain("- second");
  });
  testInTempDirs(
    "the manager's findings are appended the same way",
    async () => {
      // Given a task waiting on the manager
      const { dir, id } = await toManagerReview();
      // When the manager sends it back with a finding
      const result = await run(dir, id, "feedback", "restructure the parser");
      // Then the worker reads it exactly as it reads an agent reviewer's
      expect(result.to).toBe("WORK");
      const body = await bodyOf(activeTaskPath(dir, id));
      expect(body).toContain("# Review findings");
      expect(body).toContain("- restructure the parser");
    },
  );
  testInTempDirs(
    "a second round of findings is appended below the first",
    async () => {
      // Given work sent back once already and submitted again
      const { dir, id } = await toAgentReview();
      await run(dir, id, "feedback", "first");
      await claim(dir, id, "agent-1");
      await run(dir, id, "submit", await bodyOf(activeTaskPath(dir, id)));
      await run(dir, id, "pass");
      await claim(dir, id, "reviewer");
      // When the reviewer sends it back a second time
      await run(dir, id, "feedback", "second");
      // Then both rounds are in the body, so the history of the task is one file
      const body = await bodyOf(activeTaskPath(dir, id));
      expect(body.match(/# Review findings/g)).toHaveLength(2);
      expect(body).toContain("- second");
    },
  );
  testInTempDirs("a plan review's findings never touch the body", async () => {
    // Given a plan under review
    const { dir, id } = await toPlan();
    await claim(dir, id, "planner");
    await run(dir, id, "submit");
    await claim(dir, id, "plan-reviewer");
    const before = await bodyOf(activeTaskPath(dir, id));
    // When the reviewer sends it back
    const result = await run(dir, id, "feedback", "the list is missing");
    // Then the planner rewrites the body itself, so nothing is appended
    expect(result.to).toBe("PLAN");
    expect(await bodyOf(activeTaskPath(dir, id))).toBe(before);
  });
  testInTempDirs("an accepted plan becomes the task's body", async () => {
    // Given a plan under review
    const { dir, id } = await toPlan();
    await claim(dir, id, "planner");
    await run(dir, id, "submit");
    await claim(dir, id, "plan-reviewer");
    // When the reviewer accepts it
    await run(dir, id, "submit", "\n# accepted plan");
    // Then what was accepted is what the task carries from here on
    expect(await bodyOf(activeTaskPath(dir, id))).toBe("\n# accepted plan");
  });
  testInTempDirs("a worker's notes become the task's body", async () => {
    // Given a task an agent has finished working on
    const { dir, id } = await toWorking();
    const accepted =
      "\n# Goal\n\n## Todos\n\n1. x\n\n## Implementation Notes\n\nI did x";
    // When the worker submits the assignment it wrote
    const result = await run(dir, id, "submit", accepted);
    // Then the task carries the notes into its checks
    expect(result.to).toBe("CHECK");
    expect(await bodyOf(activeTaskPath(dir, id))).toBe(accepted);
  });
  testInTempDirs(
    "findings written into the body survive to the closed file",
    async () => {
      // Given work that was sent back with a finding and then finished
      const { dir, id } = await toAgentReview();
      await run(dir, id, "feedback", "keep me");
      await claim(dir, id, "agent-1");
      await run(
        dir,
        id,
        "submit",
        `${await bodyOf(activeTaskPath(dir, id))}\n\n## Implementation Notes\n\nI fixed it`,
      );
      await run(dir, id, "pass");
      await claim(dir, id, "reviewer");
      await run(dir, id, "submit");
      // When the manager closes the task
      const result = await run(dir, id, "submit");
      // Then the closed document still carries why the work was sent back
      expect(result.to).toBe("CLOSED");
      expect(await bodyOf(closedPath(result))).toContain("- keep me");
    },
  );
});
describe("Feature: the checks a task carries", () => {
  testInTempDirs(
    "checks edited in before a task starts survive into design",
    async () => {
      // Given a new task a person has written checks onto
      const { dir, id } = await newTask();
      await editTask(dir, id, (meta) => {
        meta.checks = ["bun test"];
      });
      // When the task is submitted
      const result = await run(dir, id, "submit_designing");
      // Then it starts with the checks it will be held to
      expect(result.to).toBe("DESIGN");
      expect((await metaOf(dir, id)).checks).toEqual(["bun test"]);
    },
  );
  testInTempDirs(
    "a check is a command and never a record of having passed",
    async () => {
      // Given a task in its checks, with another check edited in
      const { dir, id } = await toChecking();
      await editTask(dir, id, (meta) => {
        meta.checks.push("bun test");
      });
      // When the task's checks pass
      const result = await run(dir, id, "pass");
      // Then the checks are still just commands, with no result written beside them
      expect(result.to).toBe("WORK_REVIEW");
      expect((await metaOf(dir, id)).checks).toEqual(["bun test"]);
    },
  );
  testInTempDirs(
    "a failed check sends the task back to the worker",
    async () => {
      // Given a task whose checks are running
      const { dir, id } = await toChecking();
      // When the checks run and fail
      const result = await run(dir, id, "fail");
      // Then the task goes back to work
      expect(result.to).toBe("WORK");
    },
  );
  testInTempDirs("a failed check writes nothing into the graph", async () => {
    // Given a task whose checks are running
    const { dir, id } = await toChecking();
    const before = await metaOf(dir, id);
    // When the checks run and fail
    await run(dir, id, "fail");
    // Then only the state moved, because the failure is told to the agent
    const after = await metaOf(dir, id);
    expect(after.state).toBe("WORK");
    expect(after.depends_on).toEqual(before.depends_on);
    expect(after.checks).toEqual(before.checks);
    expect(after.workspace).toEqual(before.workspace);
    expect(after.held_reason).toBeUndefined();
  });
});
describe("Feature: closing a task", () => {
  testInTempDirs(
    "a task the manager accepts is closed and moved aside",
    async () => {
      // Given a task waiting on the manager
      const { dir, id } = await toManagerReview();
      // When the manager accepts it
      const result = await run(dir, id, "submit");
      // Then the document leaves the active graph for the closed directory
      expect(result.to).toBe("CLOSED");
      expect(await fs.exists(activeTaskPath(dir, id))).toBe(false);
      expect(await fs.exists(closedTaskPath(dir, id))).toBe(true);
      expect((await readTaskFile(closedPath(result))).meta.state).toBe(
        "CLOSED",
      );
    },
  );
  testInTempDirs(
    "a task the manager rejects outright is closed too",
    async () => {
      // Given a task waiting on the manager
      const { dir, id } = await toManagerReview();
      // When the manager aborts it
      const result = await run(dir, id, "abort");
      // Then it closes, because aborting is throwing the work away
      expect(result.to).toBe("CLOSED");
    },
  );
  testInTempDirs("a task held out of design can then be aborted", async () => {
    // Given a task in the design phase, held by the manager
    const { dir, id } = await newTask("the wrong shape");
    await run(dir, id, "submit_designing");
    await run(dir, id, "hold", "abandoning");
    expect((await metaOf(dir, id)).state).toBe("HELD_DESIGN");
    // When the manager aborts it
    const result = await run(dir, id, "abort");
    // Then it closes without ever having been worked on
    expect(result.to).toBe("CLOSED");
  });
  testInTempDirs(
    "a task sent back by a failed check can be abandoned",
    async () => {
      // Given a task returned to work by a failed check, and then held
      const { dir, id } = await toChecking();
      await run(dir, id, "fail");
      expect((await metaOf(dir, id)).state).toBe("WORK");
      await run(dir, id, "hold", "abandoning");
      // When the manager aborts it
      const result = await run(dir, id, "abort");
      // Then it closes, and the work in progress is thrown away with it
      expect(result.to).toBe("CLOSED");
    },
  );
  testInTempDirs(
    "closing a task frees everything that waited on it",
    async () => {
      // Given a task blocked behind a dependency
      const dir = await makeTasksDir();
      const dep = (await createTask(dir, ORCHESTRATOR_DIR, "dependency")).id;
      const main = (await createTask(dir, ORCHESTRATOR_DIR, "main")).id;
      await addDeps(dir, main, dep);
      expect((await run(dir, main, "submit_designing")).to).toBe(
        "BLOCKED_DESIGN",
      );
      // When the dependency is closed
      const result = await closeTask(dir, dep);
      // Then the dependency is edited out of it and it starts
      expect(result.dependentsUpdated).toEqual([main]);
      expect(result.unblocked).toEqual([main]);
      expect((await metaOf(dir, main)).depends_on).toEqual([]);
      expect((await metaOf(dir, main)).state).toBe("DESIGN");
    },
  );
  testInTempDirs(
    "a freed task starts at the phase it was submitted for",
    async () => {
      // Given a task the manager designed and planned itself, blocked behind a dependency
      const dir = await makeTasksDir();
      const dep = (await createTask(dir, ORCHESTRATOR_DIR, "dependency")).id;
      const main = (await createTask(dir, ORCHESTRATOR_DIR, "main")).id;
      await addDeps(dir, main, dep);
      expect((await run(dir, main, "submit_working")).to).toBe("BLOCKED_WORK");
      // When the dependency is closed
      const result = await closeTask(dir, dep);
      // Then it starts at WORK, rather than being designed over again
      expect(result.unblocked).toEqual([main]);
      expect((await metaOf(dir, main)).state).toBe("WORK");
    },
  );
  testInTempDirs(
    "a task still waiting on something else stays blocked",
    async () => {
      // Given a task blocked behind two dependencies
      const dir = await makeTasksDir();
      const dep = (await createTask(dir, ORCHESTRATOR_DIR, "dependency")).id;
      const other = (
        await createTask(dir, ORCHESTRATOR_DIR, "other dependency")
      ).id;
      const main = (await createTask(dir, ORCHESTRATOR_DIR, "main")).id;
      await addDeps(dir, main, dep, other);
      await run(dir, main, "submit_designing");
      // When one of them is closed
      const result = await closeTask(dir, dep);
      // Then it is not unblocked, and still names what it is waiting on
      expect(result.unblocked).toEqual([]);
      expect((await metaOf(dir, main)).state).toBe("BLOCKED_DESIGN");
      expect((await metaOf(dir, main)).depends_on).toEqual([other]);
    },
  );
  testInTempDirs("a closed task will not take a submit", async () => {
    // Given a task that has been closed
    const { dir, id } = await toManagerReview();
    await run(dir, id, "submit");
    // When a submit is applied to it
    const attempt = async () => await apply(dir, id, "submit", {});
    // Then it is refused, because a closed task is finished with
    await expect(attempt()).rejects.toThrow(/is CLOSED/);
  });
});
describe("Feature: a transition that is refused writes nothing", () => {
  testInTempDirs(
    "every rejected argument leaves the document byte for byte",
    async () => {
      // Given a task an agent is working on, and its document as it stands
      const { dir, id } = await toWorking();
      const filePath = activeTaskPath(dir, id);
      const before = await fs.readFile(filePath, "utf-8");
      // When transitions are applied with arguments the machine refuses
      const rejected: [TransitionName, TransitionArgs][] = [
        ["feedback", { findings: [] }],
        ["hold", {}],
        ["submit", {}],
      ];
      for (const [name, args] of rejected) {
        expect(() => apply(dir, id, name, args)).toThrow();
      }
      // Then the document is untouched, so a refusal is never half-applied
      expect(await fs.readFile(filePath, "utf-8")).toBe(before);
    },
  );
});
describe("Feature: what changes as a task walks the pipeline", () => {
  testInTempDirs(
    "the body changes only where a stage hands one in",
    async () => {
      // Given a new task, and the whole pipeline it will be walked through
      const { dir, id } = await newTask();
      const filePath = activeTaskPath(dir, id);
      const original = await bodyOf(filePath);
      const steps: [string[], TransitionName, string[], string][] = [
        [[], "submit_designing", [], original],
        [["designer"], "submit", [], original],
        [["design-reviewer"], "submit", ["\n# accepted"], "\n# accepted"],
        [["planner"], "submit", [], "\n# accepted"],
        [["plan-reviewer"], "submit", ["\n# accepted"], "\n# accepted"],
        [["agent-1"], "submit", ["\n# accepted"], "\n# accepted"],
        [[], "pass", [], "\n# accepted"],
        [["reviewer"], "submit", [], "\n# accepted"],
      ];
      // When the task is walked from new to closed
      for (const [agents, name, args, expected] of steps) {
        for (const agent of agents) {
          const held = await bodyOf(filePath);
          await claim(dir, id, agent);
          expect(await bodyOf(filePath)).toBe(held);
        }
        await run(dir, id, name, ...args);
        expect(await bodyOf(filePath)).toBe(expected);
      }
      // Then the closed document carries what the last review accepted
      expect(await bodyOf(closedPath(await run(dir, id, "submit")))).toBe(
        "\n# accepted",
      );
    },
  );
  testInTempDirs("the clock moves even when the task does not", async () => {
    // Given a blocked task, and when it last entered that state
    const { dir, ids } = await newTasks(2);
    const main = at(ids, 0);
    const dep = at(ids, 1);
    await addDeps(dir, main, dep);
    await run(dir, main, "submit_designing");
    const before = await enteredAt(dir, main);
    await Bun.sleep(5);
    // When it is submitted again and stays blocked
    expect((await run(dir, main, "submit_designing")).to).toBeUndefined();
    // Then the clock still moved, so the inbox shows how long it has waited
    expect(await enteredAt(dir, main)).toBeGreaterThan(before);
  });
  testInTempDirs("the clock moves when the task moves", async () => {
    // Given a blocked task whose dependency has since been edited out
    const { dir, ids } = await newTasks(2);
    const main = at(ids, 0);
    const dep = at(ids, 1);
    await addDeps(dir, main, dep);
    await run(dir, main, "submit_designing");
    const before = await enteredAt(dir, main);
    await Bun.sleep(5);
    await editTask(dir, main, (meta) => {
      meta.depends_on = [];
    });
    // When the task is submitted
    expect((await run(dir, main, "submit_designing")).to).toBe("DESIGN");
    // Then the clock is stamped with the moment it entered its new state
    expect(await enteredAt(dir, main)).toBeGreaterThan(before);
  });
});
describe("Feature: the workspace a task is worked in", () => {
  testInTempDirs("a task has no workspace before its first claim", async () => {
    // Given a task that has entered the pipeline but been dispatched to nobody
    const { dir, id } = await newTask();
    // When it is submitted into the design phase
    await run(dir, id, "submit_designing");
    // Then it carries no workspace, because none has been cloned for it
    expect((await metaOf(dir, id)).workspace).toBeUndefined();
  });
  testInTempDirs(
    "a work claim records the branch, worktree, agent and session",
    async () => {
      // Given a task waiting in the work stage
      const { dir, id } = await planThrough();
      // When a worker claims it with the workspace it was given
      await claim(dir, id, "pi-anthropic-claude-sonnet-4-5-2", process.pid, {
        branch: "work/000001",
        worktree: "/tmp/task-graph-server/-repo/000001/worktree",
        session:
          "/tmp/task-graph-server/-repo/000001/session/worker/019f.jsonl",
      });
      // Then everything needed to pick the work back up is on the document
      expect((await metaOf(dir, id)).workspace).toEqual({
        branch: "work/000001",
        worktree: "/tmp/task-graph-server/-repo/000001/worktree",
        slot: "pi-anthropic-claude-sonnet-4-5-2",
        session:
          "/tmp/task-graph-server/-repo/000001/session/worker/019f.jsonl",
      });
    },
  );
  testInTempDirs("only the working session is worth recording", async () => {
    // Given a task in the design phase
    const { dir, id } = await newTask();
    await run(dir, id, "submit_designing");
    // When a designer claims it, naming its own session
    await claim(dir, id, "designer", process.pid, {
      branch: "work/000001",
      worktree: "/tmp/wt",
      session:
        "/tmp/task-graph-server/-repo/000001/session/designer/019f.jsonl",
    });
    // Then no session is recorded, because only work is ever resumed
    expect(requireWorkspace(await metaOf(dir, id)).session).toBeUndefined();
  });
  testInTempDirs(
    "a review claim leaves the worker's session where it was",
    async () => {
      // Given a task whose worker recorded a session and then submitted
      const work =
        "/tmp/task-graph-server/-repo/000001/session/worker/019f.jsonl";
      const { dir, id } = await planThrough();
      await claim(dir, id, "worker", process.pid, {
        branch: "work/000001",
        worktree: "/tmp/wt",
        session: work,
      });
      await run(dir, id, "submit");
      await run(dir, id, "pass");
      // When a reviewer claims it with a session of its own
      await claim(dir, id, "reviewer", process.pid, {
        branch: "work/000001",
        worktree: "/tmp/wt",
        session:
          "/tmp/task-graph-server/-repo/000001/session/reviewer/01a0.jsonl",
      });
      // Then the worker's session survives, so the work can still be resumed
      expect((await metaOf(dir, id)).state).toBe("WORK_REVIEW");
      expect(requireWorkspace(await metaOf(dir, id)).session).toBe(work);
    },
  );
  testInTempDirs(
    "a transition leaves the recorded workspace alone",
    async () => {
      // Given a task claimed with a workspace
      const { dir, id } = await newTask();
      await run(dir, id, "submit_designing");
      await claim(dir, id, "pi-1", process.pid, {
        branch: "work/000001",
        worktree: "/tmp/wt",
        session: "/tmp/session.jsonl",
      });
      const before = (await metaOf(dir, id)).workspace;
      // When the task moves on
      await run(dir, id, "submit");
      // Then the workspace it was cloned into is still recorded on it
      expect((await metaOf(dir, id)).workspace).toEqual(before);
    },
  );
  testInTempDirs("a work claim with no session records none", async () => {
    // Given a task waiting in the work stage
    const { dir, id } = await planThrough();
    // When a worker claims it before its session exists
    await claim(dir, id, "pi-1", process.pid, {
      branch: "work/000001",
      worktree: "/tmp/wt",
    });
    // Then there is no session to resume from, and the field says so
    expect(requireWorkspace(await metaOf(dir, id)).session).toBeUndefined();
  });
  testInTempDirs(
    "the workspace outlives the claim that recorded it",
    async () => {
      // Given a task whose claiming process is gone but whose workspace is on it
      const dir = await makeTasksDir();
      const workspace = {
        branch: "work/000001",
        worktree: "/tmp/task-graph-server/-repo/000001/worktree",
        slot: "pi-anthropic-claude-sonnet-4-5-2",
        session: "/tmp/task-graph-server/-repo/000001/session/work/019f.jsonl",
      };
      const id = await writeTask(dir, {
        id: "000001",
        state: "WORK",
        claimed_by: "pi-anthropic-claude-sonnet-4-5-2",
        claimed_pid: await deadPid(),
        workspace,
      });
      // When the claim is cleared
      await unclaim(dir, id);
      // Then the workspace survives, so the next agent can pick the work up
      expect((await metaOf(dir, id)).workspace).toEqual(workspace);
    },
  );
  testInTempDirs(
    "closing a task clears the workspace it was worked in",
    async () => {
      // Given a task walked all the way to the manager with a workspace
      const dir = await makeTasksDir();
      const id = (await createTask(dir, ORCHESTRATOR_DIR, "a task")).id;
      await run(dir, id, "submit_designing");
      for (const agent of ["d", "dr", "p", "pr"]) {
        await claim(dir, id, agent);
        await run(dir, id, "submit");
      }
      await claim(dir, id, "pi-1", process.pid, {
        branch: "work/000001",
        worktree: "/tmp/wt",
      });
      await run(dir, id, "submit");
      await run(dir, id, "pass");
      await claim(dir, id, "r");
      await run(dir, id, "submit");
      // When the manager closes it
      const result = await run(dir, id, "submit");
      // Then the closed document points at no worktree, which is gone by then
      expect(
        (await readTaskFile(closedPath(result))).meta.workspace,
      ).toBeUndefined();
    },
  );
});
