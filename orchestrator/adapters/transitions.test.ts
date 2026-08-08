import { describe, expect } from "bun:test";
import { testInTempDirs } from "../testing/temp-dirs.ts";
import fs from "node:fs";
import {
  activeTaskPath,
  closedTaskPath,
  createTask,
  readTaskFile,
} from "./task-store.ts";
import { parseTaskMeta } from "../domain/task.ts";
import {
  type TransitionArgs,
  type TransitionName,
  type TransitionResult,
} from "../domain/state-machine.ts";
import { applyTransition } from "./task-documents.ts";
import {
  ORCHESTRATOR_DIR,
  addDeps,
  baseMeta,
  bodyOf,
  claim,
  closeTask,
  closedPath,
  deadPid,
  editTask,
  makeTasksDir,
  metaOf,
  newTask,
  newTasks,
  planThrough,
  raw,
  run,
  toAgentReview,
  toChecking,
  toDesignReview,
  toManagerReview,
  toPlan,
  toPlanReview,
  toWorking,
  unclaim,
  writeTask,
} from "../testing/graph-jig.ts";

function apply(
  dir: string,
  id: string,
  name: TransitionName,
  args: TransitionArgs,
): TransitionResult {
  return applyTransition(dir, id, name, args);
}

describe("Feature: a task that waits on other tasks", () => {
  testInTempDirs(
    "a task with no dependencies starts as soon as it is submitted",
    () => {
      // Given a new task nothing was edited into
      const { dir, id } = newTask();

      // When the task is submitted
      const result = run(dir, id, "submit");

      // Then it enters the design phase straight away
      expect(result.to).toBe("DESIGN");
    },
  );

  testInTempDirs("a task with a dependency waits instead of starting", () => {
    // Given a new task edited to depend on another
    const { dir, ids } = newTasks(2);
    const main = ids[0]!;
    const dep = ids[1]!;
    addDeps(dir, main, dep);

    // When the task is submitted
    const result = run(dir, main, "submit");

    // Then it waits, still carrying the dependency it is waiting on
    expect(result.to).toBe("BLOCKED");
    expect(metaOf(dir, main).depends_on).toEqual([dep]);
  });

  testInTempDirs("a blocked task submitted again stays where it is", () => {
    // Given a task already blocked behind a dependency
    const { dir, ids } = newTasks(2);
    const main = ids[0]!;
    const dep = ids[1]!;
    addDeps(dir, main, dep);
    run(dir, main, "submit");

    // When it is submitted again
    const result = run(dir, main, "submit");

    // Then the machine moves it nowhere, and it keeps waiting
    expect(result.to).toBeNull();
    expect(metaOf(dir, main).state).toBe("BLOCKED");
  });

  testInTempDirs(
    "a blocked task starts once its last dependency is gone",
    () => {
      // Given a task blocked behind two dependencies, one since edited out
      const { dir, ids } = newTasks(3);
      const main = ids[0]!;
      const first = ids[1]!;
      const second = ids[2]!;
      addDeps(dir, main, first, second);
      run(dir, main, "submit");
      editTask(dir, main, (meta) => {
        meta.depends_on = [first];
      });
      expect(run(dir, main, "submit").to).toBeNull();

      // Given the last dependency edited out of it
      editTask(dir, main, (meta) => {
        meta.depends_on = [];
      });

      // When it is submitted with its dependencies gone
      const result = run(dir, main, "submit");

      // Then it starts, because nothing is left for it to wait on
      expect(result.to).toBe("DESIGN");
    },
  );

  testInTempDirs(
    "a dependency on a task that is gone can be edited away",
    () => {
      // Given a task blocked on an id no document carries any more
      const dir = makeTasksDir();
      const main = writeTask(dir, {
        id: "000001",
        state: "BLOCKED",
        depends_on: ["000999"],
      });
      editTask(dir, main, (meta) => {
        meta.depends_on = [];
      });

      // When the task is submitted
      const result = run(dir, main, "submit");

      // Then it starts, rather than waiting on something that will never close
      expect(result.to).toBe("DESIGN");
      expect(metaOf(dir, main).depends_on).toEqual([]);
    },
  );
});

describe("Feature: taking and clearing a claim", () => {
  testInTempDirs(
    "a claim records the agent and its process, not a new state",
    () => {
      // Given a task waiting in the work stage
      const { dir, id } = planThrough();
      expect(metaOf(dir, id).state).toBe("WORK");

      // When an agent claims it
      claim(dir, id, "agent-1", 4242);

      // Then the holder and its process are recorded, and the stage is unchanged
      const meta = metaOf(dir, id);
      expect(meta.state).toBe("WORK");
      expect(meta.claimed_by).toBe("agent-1");
      expect(meta.claimed_pid).toBe(4242);
    },
  );

  testInTempDirs(
    "a task an agent already holds cannot be claimed again",
    () => {
      // Given a task an agent is working on
      const { dir, id } = toWorking();

      // When a second agent claims it
      const attempt = () => claim(dir, id, "agent-2");

      // Then it is refused, and the first agent keeps it
      expect(attempt).toThrow(/already claimed by "agent-1"/);
      expect(metaOf(dir, id).claimed_by).toBe("agent-1");
    },
  );

  testInTempDirs("a claim whose process is still alive is not cleared", () => {
    // Given a task claimed by an agent that is still running
    const { dir, id } = toWorking();

    // When the claim is cleared
    const attempt = () => unclaim(dir, id);

    // Then it is refused, so a live agent is never reaped
    expect(attempt).toThrow(/still claimed by a live process/);
  });

  testInTempDirs(
    "a claim whose process is gone is cleared where it stands",
    async () => {
      // Given a task claimed by an agent whose process has exited
      const { dir, id } = newTask();
      run(dir, id, "submit");
      claim(dir, id, "dead-agent", await deadPid());

      // When the claim is cleared
      unclaim(dir, id);

      // Then the task keeps its stage and goes back into the queue unheld
      const meta = metaOf(dir, id);
      expect(meta.state).toBe("DESIGN");
      expect(meta.claimed_by).toBeNull();
      expect(meta.claimed_pid).toBeNull();
    },
  );

  testInTempDirs("a state no agent runs has no claim to clear", () => {
    // Given a task in a state the server drives rather than an agent
    const { dir, id } = toChecking();
    expect(metaOf(dir, id).claimed_by).toBeNull();

    // When a claim is cleared on it
    const attempt = () => unclaim(dir, id);

    // Then it is refused, because there was never a holder to release
    expect(attempt).toThrow(/with no claim to clear/);
  });

  testInTempDirs("a state no agent runs cannot be claimed", () => {
    // Given a task in a state the server drives rather than an agent
    const { dir, id } = toChecking();

    // When an agent claims it
    const attempt = () => claim(dir, id, "agent-1");

    // Then it is refused, and nothing is written onto the task
    expect(attempt).toThrow(/which no agent runs/);
    expect(metaOf(dir, id).claimed_by).toBeNull();
  });

  testInTempDirs(
    "a claim by an agent named only with spaces is refused",
    () => {
      // Given a task ready to be claimed
      const { dir, id } = newTask();
      run(dir, id, "submit");

      // When a claim is made under a name of two spaces, with the process 12
      const attempt = () => claim(dir, id, "  ", 12);

      // Then it is refused for the empty name, and the task is left unclaimed in DESIGN
      expect(attempt).toThrow('"slotName" must be a non-empty string');
      const meta = metaOf(dir, id);
      expect(meta.state).toBe("DESIGN");
      expect(meta.claimed_by).toBeNull();
    },
  );

  testInTempDirs("a claim carrying the process zero is refused", () => {
    // Given a task ready to be claimed
    const { dir, id } = newTask();
    run(dir, id, "submit");

    // When the agent a claims it with the process 0
    const attempt = () => claim(dir, id, "a", 0);

    // Then it is refused for the process, and the task is left unclaimed in DESIGN
    expect(attempt).toThrow('"pid" must be a positive integer');
    const meta = metaOf(dir, id);
    expect(meta.state).toBe("DESIGN");
    expect(meta.claimed_by).toBeNull();
  });

  testInTempDirs("a claim carrying a fractional process is refused", () => {
    // Given a task ready to be claimed
    const { dir, id } = newTask();
    run(dir, id, "submit");

    // When the agent a claims it with the process 1.5
    const attempt = () => claim(dir, id, "a", 1.5);

    // Then it is refused for the process, and the task is left unclaimed in DESIGN
    expect(attempt).toThrow('"pid" must be a positive integer');
    const meta = metaOf(dir, id);
    expect(meta.state).toBe("DESIGN");
    expect(meta.claimed_by).toBeNull();
  });
});

describe("Feature: what a review writes into the task body", () => {
  testInTempDirs(
    "a work review's finding is appended for the worker to read",
    () => {
      // Given finished work under review
      const { dir, id } = toAgentReview();

      // When the reviewer sends it back with a finding
      const result = run(dir, id, "feedback", "fix null handling");

      // Then the worker gets the task back with the finding written into it
      expect(result.to).toBe("WORK");
      const body = bodyOf(activeTaskPath(dir, id));
      expect(body).toContain("# Review findings");
      expect(body).toContain("- fix null handling");
    },
  );

  testInTempDirs("every finding in a review lands in the body", () => {
    // Given finished work under review
    const { dir, id } = toAgentReview();

    // When the reviewer sends it back with two findings
    run(dir, id, "feedback", "first", "second");

    // Then both are written in, so none is lost between reviews
    const body = bodyOf(activeTaskPath(dir, id));
    expect(body).toContain("- first");
    expect(body).toContain("- second");
  });

  testInTempDirs("the manager's findings are appended the same way", () => {
    // Given a task waiting on the manager
    const { dir, id } = toManagerReview();

    // When the manager sends it back with a finding
    const result = run(dir, id, "feedback", "restructure the parser");

    // Then the worker reads it exactly as it reads an agent reviewer's
    expect(result.to).toBe("WORK");
    const body = bodyOf(activeTaskPath(dir, id));
    expect(body).toContain("# Review findings");
    expect(body).toContain("- restructure the parser");
  });

  testInTempDirs(
    "a second round of findings is appended below the first",
    () => {
      // Given work sent back once already and submitted again
      const { dir, id } = toAgentReview();
      run(dir, id, "feedback", "first");
      claim(dir, id, "agent-1");
      run(dir, id, "submit", bodyOf(activeTaskPath(dir, id)));
      run(dir, id, "pass");
      claim(dir, id, "reviewer");

      // When the reviewer sends it back a second time
      run(dir, id, "feedback", "second");

      // Then both rounds are in the body, so the history of the task is one file
      const body = bodyOf(activeTaskPath(dir, id));
      expect(body.match(/# Review findings/g)).toHaveLength(2);
      expect(body).toContain("- second");
    },
  );

  testInTempDirs("a plan review's findings never touch the body", () => {
    // Given a plan under review
    const { dir, id } = toPlan();
    claim(dir, id, "planner");
    run(dir, id, "submit");
    claim(dir, id, "plan-reviewer");
    const before = bodyOf(activeTaskPath(dir, id));

    // When the reviewer sends it back
    const result = run(dir, id, "feedback", "the list is missing");

    // Then the planner rewrites the body itself, so nothing is appended
    expect(result.to).toBe("PLAN");
    expect(bodyOf(activeTaskPath(dir, id))).toBe(before);
  });

  testInTempDirs("a review with no findings at all is refused", () => {
    // Given finished work under review
    const { dir, id } = toAgentReview();
    const before = fs.readFileSync(activeTaskPath(dir, id), "utf-8");

    // When the reviewer sends it back with an empty list
    const attempt = () => apply(dir, id, "feedback", { findings: [] });

    // Then it is refused, and the document is untouched
    expect(attempt).toThrow(/non-empty/);
    expect(fs.readFileSync(activeTaskPath(dir, id), "utf-8")).toBe(before);
  });

  testInTempDirs("an accepted plan becomes the task's body", () => {
    // Given a plan under review
    const { dir, id } = toPlan();
    claim(dir, id, "planner");
    run(dir, id, "submit");
    claim(dir, id, "plan-reviewer");

    // When the reviewer accepts it
    run(dir, id, "submit", "\n# accepted plan");

    // Then what was accepted is what the task carries from here on
    expect(bodyOf(activeTaskPath(dir, id))).toBe("\n# accepted plan");
  });

  testInTempDirs("a worker's notes become the task's body", () => {
    // Given a task an agent has finished working on
    const { dir, id } = toWorking();
    const accepted =
      "\n# Goal\n\n## Todos\n\n1. x\n\n## Implementation Notes\n\nI did x";

    // When the worker submits the assignment it wrote
    const result = run(dir, id, "submit", accepted);

    // Then the task carries the notes into its checks
    expect(result.to).toBe("CHECK");
    expect(bodyOf(activeTaskPath(dir, id))).toBe(accepted);
  });

  testInTempDirs("a task in WORK cannot submit without a body", () => {
    // Given a task an agent is working on, which hands in the work it wrote
    const { dir, id } = toWorking();

    // When it submits with no body
    const attempt = () => apply(dir, id, "submit", {});

    // Then it is refused for the missing body
    expect(attempt).toThrow(/body/);
  });

  testInTempDirs("a task in PLAN_REVIEW cannot submit without a body", () => {
    // Given a task under plan review, which hands in the plan it accepted
    const { dir, id } = toPlanReview();

    // When it submits with no body
    const attempt = () => apply(dir, id, "submit", {});

    // Then it is refused for the missing body
    expect(attempt).toThrow(/body/);
  });

  testInTempDirs("a task in DESIGN_REVIEW cannot submit without a body", () => {
    // Given a task under design review, which hands in the design it accepted
    const { dir, id } = toDesignReview();

    // When it submits with no body
    const attempt = () => apply(dir, id, "submit", {});

    // Then it is refused for the missing body
    expect(attempt).toThrow(/body/);
  });

  testInTempDirs(
    "findings written into the body survive to the closed file",
    () => {
      // Given work that was sent back with a finding and then finished
      const { dir, id } = toAgentReview();
      run(dir, id, "feedback", "keep me");
      claim(dir, id, "agent-1");
      run(
        dir,
        id,
        "submit",
        `${bodyOf(activeTaskPath(dir, id))}\n\n## Implementation Notes\n\nI fixed it`,
      );
      run(dir, id, "pass");
      claim(dir, id, "reviewer");
      run(dir, id, "submit");

      // When the manager closes the task
      const result = run(dir, id, "submit");

      // Then the closed document still carries why the work was sent back
      expect(result.to).toBe("CLOSED");
      expect(bodyOf(closedPath(result))).toContain("- keep me");
    },
  );
});

describe("Feature: the checks a task carries", () => {
  testInTempDirs(
    "checks edited in before a task starts survive into design",
    () => {
      // Given a new task a person has written checks onto
      const { dir, id } = newTask();
      editTask(dir, id, (meta) => {
        meta.checks = ["bun test"];
      });

      // When the task is submitted
      const result = run(dir, id, "submit");

      // Then it starts with the checks it will be held to
      expect(result.to).toBe("DESIGN");
      expect(metaOf(dir, id).checks).toEqual(["bun test"]);
    },
  );

  testInTempDirs(
    "a check is a command and never a record of having passed",
    () => {
      // Given a task in its checks, with another check edited in
      const { dir, id } = toChecking();
      editTask(dir, id, (meta) => {
        meta.checks.push("bun test");
      });

      // When the task's checks pass
      const result = run(dir, id, "pass");

      // Then the checks are still just commands, with no result written beside them
      expect(result.to).toBe("WORK_REVIEW");
      expect(metaOf(dir, id).checks).toEqual(["bun test"]);
    },
  );

  testInTempDirs("a failed check sends the task back to the worker", () => {
    // Given a task whose checks are running
    const { dir, id } = toChecking();

    // When the checks run and fail
    const result = run(dir, id, "fail");

    // Then the task goes back to work
    expect(result.to).toBe("WORK");
  });

  testInTempDirs("a failed check writes nothing into the graph", () => {
    // Given a task whose checks are running
    const { dir, id } = toChecking();
    const before = metaOf(dir, id);

    // When the checks run and fail
    run(dir, id, "fail");

    // Then only the state moved, because the failure is told to the agent
    const after = metaOf(dir, id);
    expect(after.state).toBe("WORK");
    expect(after.depends_on).toEqual(before.depends_on);
    expect(after.checks).toEqual(before.checks);
    expect(after.workspace).toEqual(before.workspace);
    expect(after.held_reason).toBeNull();
  });

  testInTempDirs("a reviewer cannot fail the task it is reviewing", () => {
    // Given finished work under review
    const { dir, id } = toAgentReview();

    // When the reviewer tries to fail it as a check would
    const attempt = () => run(dir, id, "fail");

    // Then it is refused, because a review sends findings back instead
    expect(attempt).toThrow(/not valid from state/);
  });
});

describe("Feature: closing a task", () => {
  testInTempDirs("a task the manager accepts is closed and moved aside", () => {
    // Given a task waiting on the manager
    const { dir, id } = toManagerReview();

    // When the manager accepts it
    const result = run(dir, id, "submit");

    // Then the document leaves the active graph for the closed directory
    expect(result.to).toBe("CLOSED");
    expect(fs.existsSync(activeTaskPath(dir, id))).toBe(false);
    expect(fs.existsSync(closedTaskPath(dir, id))).toBe(true);
    expect(readTaskFile(closedPath(result)).meta.state).toBe("CLOSED");
  });

  testInTempDirs("a task the manager rejects outright is closed too", () => {
    // Given a task waiting on the manager
    const { dir, id } = toManagerReview();

    // When the manager aborts it
    const result = run(dir, id, "abort");

    // Then it closes, because aborting is throwing the work away
    expect(result.to).toBe("CLOSED");
  });

  testInTempDirs("a task an agent is still holding cannot be aborted", () => {
    // Given a task in the design phase
    const { dir, id } = newTask("the wrong shape");
    run(dir, id, "submit");
    expect(metaOf(dir, id).state).toBe("DESIGN");

    // When the manager aborts it
    const attempt = () => run(dir, id, "abort");

    // Then it is refused, because a task is held before it is thrown away
    expect(attempt).toThrow(/not valid from state "DESIGN"/);
  });

  testInTempDirs("a task held out of design can then be aborted", () => {
    // Given a task in the design phase, held by the manager
    const { dir, id } = newTask("the wrong shape");
    run(dir, id, "submit");
    run(dir, id, "hold", "abandoning");
    expect(metaOf(dir, id).state).toBe("HELD_DESIGN");

    // When the manager aborts it
    const result = run(dir, id, "abort");

    // Then it closes without ever having been worked on
    expect(result.to).toBe("CLOSED");
  });

  testInTempDirs("a task sent back by a failed check can be abandoned", () => {
    // Given a task returned to work by a failed check, and then held
    const { dir, id } = toChecking();
    run(dir, id, "fail");
    expect(metaOf(dir, id).state).toBe("WORK");
    run(dir, id, "hold", "abandoning");

    // When the manager aborts it
    const result = run(dir, id, "abort");

    // Then it closes, and the work in progress is thrown away with it
    expect(result.to).toBe("CLOSED");
  });

  testInTempDirs("closing a task frees everything that waited on it", () => {
    // Given a task blocked behind a dependency
    const dir = makeTasksDir();
    const dep = createTask(dir, ORCHESTRATOR_DIR, "dependency").id;
    const main = createTask(dir, ORCHESTRATOR_DIR, "main").id;
    addDeps(dir, main, dep);
    expect(run(dir, main, "submit").to).toBe("BLOCKED");

    // When the dependency is closed
    const result = closeTask(dir, dep);

    // Then the dependency is edited out of it and it starts
    expect(result.dependentsUpdated).toEqual([main]);
    expect(result.unblocked).toEqual([main]);
    expect(metaOf(dir, main).depends_on).toEqual([]);
    expect(metaOf(dir, main).state).toBe("DESIGN");
  });

  testInTempDirs("a task still waiting on something else stays blocked", () => {
    // Given a task blocked behind two dependencies
    const dir = makeTasksDir();
    const dep = createTask(dir, ORCHESTRATOR_DIR, "dependency").id;
    const other = createTask(dir, ORCHESTRATOR_DIR, "other dependency").id;
    const main = createTask(dir, ORCHESTRATOR_DIR, "main").id;
    addDeps(dir, main, dep, other);
    run(dir, main, "submit");

    // When one of them is closed
    const result = closeTask(dir, dep);

    // Then it is not unblocked, and still names what it is waiting on
    expect(result.unblocked).toEqual([]);
    expect(metaOf(dir, main).state).toBe("BLOCKED");
    expect(metaOf(dir, main).depends_on).toEqual([other]);
  });

  testInTempDirs("a closed task will not take a submit", () => {
    // Given a task that has been closed
    const { dir, id } = toManagerReview();
    run(dir, id, "submit");

    // When a submit is applied to it
    const attempt = () => apply(dir, id, "submit", {});

    // Then it is refused, because a closed task is finished with
    expect(attempt).toThrow(/is CLOSED/);
  });

  testInTempDirs("a closed task will not take a pass", () => {
    // Given a task that has been closed
    const { dir, id } = toManagerReview();
    run(dir, id, "submit");

    // When a pass is applied to it
    const attempt = () => apply(dir, id, "pass", {});

    // Then it is refused, because a closed task is finished with
    expect(attempt).toThrow(/is CLOSED/);
  });

  testInTempDirs("a closed task will not take a fail", () => {
    // Given a task that has been closed
    const { dir, id } = toManagerReview();
    run(dir, id, "submit");

    // When a fail is applied to it
    const attempt = () => apply(dir, id, "fail", {});

    // Then it is refused, because a closed task is finished with
    expect(attempt).toThrow(/is CLOSED/);
  });

  testInTempDirs("a closed task will not take a hold", () => {
    // Given a task that has been closed
    const { dir, id } = toManagerReview();
    run(dir, id, "submit");

    // When a hold is applied to it
    const attempt = () => apply(dir, id, "hold", {});

    // Then it is refused, because a closed task is finished with
    expect(attempt).toThrow(/is CLOSED/);
  });

  testInTempDirs("a closed task will not take a resume", () => {
    // Given a task that has been closed
    const { dir, id } = toManagerReview();
    run(dir, id, "submit");

    // When a resume is applied to it
    const attempt = () => apply(dir, id, "resume", {});

    // Then it is refused, because a closed task is finished with
    expect(attempt).toThrow(/is CLOSED/);
  });

  testInTempDirs("a closed task will not take a feedback", () => {
    // Given a task that has been closed
    const { dir, id } = toManagerReview();
    run(dir, id, "submit");

    // When a feedback is applied to it
    const attempt = () => apply(dir, id, "feedback", {});

    // Then it is refused, because a closed task is finished with
    expect(attempt).toThrow(/is CLOSED/);
  });

  testInTempDirs("a closed task will not take an abort", () => {
    // Given a task that has been closed
    const { dir, id } = toManagerReview();
    run(dir, id, "submit");

    // When an abort is applied to it
    const attempt = () => apply(dir, id, "abort", {});

    // Then it is refused, because a closed task is finished with
    expect(attempt).toThrow(/is CLOSED/);
  });
});

describe("Feature: a transition that is refused writes nothing", () => {
  testInTempDirs("a transition on a task the directory has never held", () => {
    // Given a task directory with nothing in it
    const dir = makeTasksDir();

    // When a transition is applied to an id nothing carries
    const attempt = () => run(dir, "000999", "submit");

    // Then it is refused, naming the task that was not found
    expect(attempt).toThrow(/not found/);
  });

  testInTempDirs("holding with a blank reason is refused", () => {
    // Given a task an agent is working on
    const { dir, id } = toWorking();

    // When it is held with a reason that is only spaces
    const attempt = () => apply(dir, id, "hold", { reason: "  " });

    // Then it is refused, and the task stays where it was
    expect(attempt).toThrow(/"reason" must be a non-empty string/);
    expect(metaOf(dir, id).state).toBe("WORK");
  });

  testInTempDirs(
    "every rejected argument leaves the document byte for byte",
    () => {
      // Given a task an agent is working on, and its document as it stands
      const { dir, id } = toWorking();
      const filePath = activeTaskPath(dir, id);
      const before = fs.readFileSync(filePath, "utf-8");

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
      expect(fs.readFileSync(filePath, "utf-8")).toBe(before);
    },
  );
});

describe("Feature: what changes as a task walks the pipeline", () => {
  testInTempDirs("the body changes only where a stage hands one in", () => {
    // Given a new task, and the whole pipeline it will be walked through
    const { dir, id } = newTask();
    const filePath = activeTaskPath(dir, id);
    const original = bodyOf(filePath);
    const steps: [string[], TransitionName, string[], string][] = [
      [[], "submit", [], original],
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
        const held = bodyOf(filePath);
        claim(dir, id, agent);
        expect(bodyOf(filePath)).toBe(held);
      }
      run(dir, id, name, ...args);
      expect(bodyOf(filePath)).toBe(expected);
    }

    // Then the closed document carries what the last review accepted
    expect(bodyOf(closedPath(run(dir, id, "submit")))).toBe("\n# accepted");
  });

  testInTempDirs("the clock moves even when the task does not", async () => {
    // Given a blocked task, and when it last entered that state
    const { dir, ids } = newTasks(2);
    const main = ids[0]!;
    const dep = ids[1]!;
    addDeps(dir, main, dep);
    run(dir, main, "submit");
    const before = metaOf(dir, main).state_entered;
    await Bun.sleep(5);

    // When it is submitted again and stays blocked
    expect(run(dir, main, "submit").to).toBeNull();

    // Then the clock still moved, so the inbox shows how long it has waited
    expect(Date.parse(metaOf(dir, main).state_entered!)).toBeGreaterThan(
      Date.parse(before!),
    );
  });

  testInTempDirs("the clock moves when the task moves", async () => {
    // Given a blocked task whose dependency has since been edited out
    const { dir, ids } = newTasks(2);
    const main = ids[0]!;
    const dep = ids[1]!;
    addDeps(dir, main, dep);
    run(dir, main, "submit");
    const before = metaOf(dir, main).state_entered;
    await Bun.sleep(5);
    editTask(dir, main, (meta) => {
      meta.depends_on = [];
    });

    // When the task is submitted
    expect(run(dir, main, "submit").to).toBe("DESIGN");

    // Then the clock is stamped with the moment it entered its new state
    expect(Date.parse(metaOf(dir, main).state_entered!)).toBeGreaterThan(
      Date.parse(before!),
    );
  });
});

describe("Feature: the workspace a task is worked in", () => {
  testInTempDirs("a task has no workspace before its first claim", () => {
    // Given a task that has entered the pipeline but been dispatched to nobody
    const { dir, id } = newTask();

    // When it is submitted into the design phase
    run(dir, id, "submit");

    // Then it carries no workspace, because none has been cloned for it
    expect(metaOf(dir, id).workspace).toBeNull();
  });

  testInTempDirs(
    "a work claim records the branch, worktree, agent and session",
    () => {
      // Given a task waiting in the work stage
      const { dir, id } = planThrough();

      // When a worker claims it with the workspace it was given
      claim(dir, id, "pi-anthropic-claude-sonnet-4-5-2", process.pid, {
        branch: "work/000001",
        worktree: "/tmp/task-graph-server/-repo/000001/worktree",
        session:
          "/tmp/task-graph-server/-repo/000001/session/worker/019f.jsonl",
      });

      // Then everything needed to pick the work back up is on the document
      expect(metaOf(dir, id).workspace).toEqual({
        branch: "work/000001",
        worktree: "/tmp/task-graph-server/-repo/000001/worktree",
        slot: "pi-anthropic-claude-sonnet-4-5-2",
        session:
          "/tmp/task-graph-server/-repo/000001/session/worker/019f.jsonl",
      });
    },
  );

  testInTempDirs("only the working session is worth recording", () => {
    // Given a task in the design phase
    const { dir, id } = newTask();
    run(dir, id, "submit");

    // When a designer claims it, naming its own session
    claim(dir, id, "designer", process.pid, {
      branch: "work/000001",
      worktree: "/tmp/wt",
      session:
        "/tmp/task-graph-server/-repo/000001/session/designer/019f.jsonl",
    });

    // Then no session is recorded, because only work is ever resumed
    expect(metaOf(dir, id).workspace!.session).toBeNull();
  });

  testInTempDirs(
    "a review claim leaves the worker's session where it was",
    () => {
      // Given a task whose worker recorded a session and then submitted
      const work =
        "/tmp/task-graph-server/-repo/000001/session/worker/019f.jsonl";
      const { dir, id } = planThrough();
      claim(dir, id, "worker", process.pid, {
        branch: "work/000001",
        worktree: "/tmp/wt",
        session: work,
      });
      run(dir, id, "submit");
      run(dir, id, "pass");

      // When a reviewer claims it with a session of its own
      claim(dir, id, "reviewer", process.pid, {
        branch: "work/000001",
        worktree: "/tmp/wt",
        session:
          "/tmp/task-graph-server/-repo/000001/session/reviewer/01a0.jsonl",
      });

      // Then the worker's session survives, so the work can still be resumed
      expect(metaOf(dir, id).state).toBe("WORK_REVIEW");
      expect(metaOf(dir, id).workspace!.session).toBe(work);
    },
  );

  testInTempDirs("a transition leaves the recorded workspace alone", () => {
    // Given a task claimed with a workspace
    const { dir, id } = newTask();
    run(dir, id, "submit");
    claim(dir, id, "pi-1", process.pid, {
      branch: "work/000001",
      worktree: "/tmp/wt",
      session: "/tmp/session.jsonl",
    });
    const before = metaOf(dir, id).workspace;

    // When the task moves on
    run(dir, id, "submit");

    // Then the workspace it was cloned into is still recorded on it
    expect(metaOf(dir, id).workspace).toEqual(before);
  });

  testInTempDirs("a work claim with no session records none", () => {
    // Given a task waiting in the work stage
    const { dir, id } = planThrough();

    // When a worker claims it before its session exists
    claim(dir, id, "pi-1", process.pid, {
      branch: "work/000001",
      worktree: "/tmp/wt",
    });

    // Then there is no session to resume from, and the field says so
    expect(metaOf(dir, id).workspace!.session).toBeNull();
  });

  testInTempDirs("a branch with no worktree beside it is refused", () => {
    // Given a task in the design phase
    const { dir, id } = newTask();
    run(dir, id, "submit");

    // When it is claimed with a branch but no worktree
    const attempt = () =>
      claim(dir, id, "pi-1", process.pid, { branch: "work/000001" });

    // Then it is refused, and nothing is written onto the task
    expect(attempt).toThrow(/"worktree" must be a non-empty string/);
    expect(metaOf(dir, id).state).toBe("DESIGN");
    expect(metaOf(dir, id).workspace).toBeNull();
  });

  testInTempDirs(
    "the workspace outlives the claim that recorded it",
    async () => {
      // Given a task whose claiming process is gone but whose workspace is on it
      const dir = makeTasksDir();
      const workspace = {
        branch: "work/000001",
        worktree: "/tmp/task-graph-server/-repo/000001/worktree",
        slot: "pi-anthropic-claude-sonnet-4-5-2",
        session: "/tmp/task-graph-server/-repo/000001/session/work/019f.jsonl",
      };
      const id = writeTask(dir, {
        id: "000001",
        state: "WORK",
        claimed_by: "pi-anthropic-claude-sonnet-4-5-2",
        claimed_pid: await deadPid(),
        workspace,
      });

      // When the claim is cleared
      unclaim(dir, id);

      // Then the workspace survives, so the next agent can pick the work up
      expect(metaOf(dir, id).workspace).toEqual(workspace);
    },
  );

  testInTempDirs("closing a task clears the workspace it was worked in", () => {
    // Given a task walked all the way to the manager with a workspace
    const dir = makeTasksDir();
    const id = createTask(dir, ORCHESTRATOR_DIR, "a task").id;
    run(dir, id, "submit");
    for (const agent of ["d", "dr", "p", "pr"]) {
      claim(dir, id, agent);
      run(dir, id, "submit");
    }
    claim(dir, id, "pi-1", process.pid, {
      branch: "work/000001",
      worktree: "/tmp/wt",
    });
    run(dir, id, "submit");
    run(dir, id, "pass");
    claim(dir, id, "r");
    run(dir, id, "submit");

    // When the manager closes it
    const result = run(dir, id, "submit");

    // Then the closed document points at no worktree, which is gone by then
    expect(readTaskFile(closedPath(result)).meta.workspace).toBeNull();
  });

  testInTempDirs("a workspace missing a field is refused", () => {
    // Given a document whose workspace names only a branch
    const partial = raw(baseMeta());
    partial.workspace = { branch: "work/000001" };

    // When it is parsed as a task
    const attempt = () => parseTaskMeta(partial);

    // Then it is refused, naming the field that is missing
    expect(attempt).toThrow(/workspace\.worktree/);
  });

  testInTempDirs("a workspace carrying an unknown field is refused", () => {
    // Given a document whose workspace carries a field the schema has no use for
    const extra = raw(baseMeta());
    extra.workspace = {
      branch: "b",
      worktree: "w",
      slot: "a",
      session: null,
      pid: 1,
    };

    // When it is parsed as a task
    const attempt = () => parseTaskMeta(extra);

    // Then it is refused, naming the field nobody will read
    expect(attempt).toThrow(/Unrecognized key: "pid"/);
  });
});
