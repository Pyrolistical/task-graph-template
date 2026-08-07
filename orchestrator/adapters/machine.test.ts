import { describe, expect } from "bun:test";
import { testInTempDirs } from "../testing/temp-dirs.ts";
import fs from "node:fs";
import path from "node:path";
import {
  AGENT_STATES,
  VALID_STATES,
  type ClaimState,
  type ValidState,
  isAgentState,
  ALLOWED_TRANSITIONS,
  TRANSITION_NAMES,
  type TransitionName,
  type TaskState,
  type Decision,
  decide,
} from "../domain/state-machine.ts";
import { createTask, readTaskFile } from "./task-store.ts";
import {
  ORCHESTRATOR_DIR,
  addDeps,
  bodyOf,
  claim,
  closeTask,
  closedPath,
  documentOf,
  deadPid,
  makeTasksDir,
  metaOf,
  run,
  shape,
  unclaim,
  toAgentReview,
  toChecking,
  toDesign,
  toHeld,
  toPlan,
  toWorking,
  writeTask,
} from "../testing/graph-jig.ts";

const AGENT_OF: Record<ClaimState, string> = {
  DESIGN: "designer",
  DESIGN_REVIEW: "design-reviewer",
  PLAN: "planner",
  PLAN_REVIEW: "plan-reviewer",
  WORK: "agent-1",
  WORK_REVIEW: "reviewer",
};

const ARGS: Record<TransitionName, string[]> = {
  submit: [],
  pass: [],
  fail: [],
  hold: ["a reason"],
  resume: [],
  feedback: ["a finding"],
  abort: [],
};

function build(state: ValidState): { dir: string; id: string } {
  const dir = makeTasksDir();
  const id = createTask(dir, ORCHESTRATOR_DIR, "the task under test").id;

  function here() {
    if (isAgentState(state)) {
      claim(dir, id, AGENT_OF[state]);
    }
    return { dir, id };
  }

  function heldFrom(stage: ClaimState) {
    claim(dir, id, AGENT_OF[stage]);
    run(dir, id, "hold", "waiting on a person");
    return { dir, id };
  }

  if (state === "NEW") return { dir, id };
  if (state === "BLOCKED") {
    const dep = createTask(dir, ORCHESTRATOR_DIR, "a dependency").id;
    addDeps(dir, id, dep);
    run(dir, id, "submit");
    return { dir, id };
  }

  run(dir, id, "submit");
  if (state === "DESIGN") return here();
  if (state === "HELD_DESIGN") return heldFrom("DESIGN");

  claim(dir, id, "designer");
  run(dir, id, "submit");
  if (state === "DESIGN_REVIEW") return here();

  claim(dir, id, "design-reviewer");
  run(dir, id, "submit");
  if (state === "PLAN") return here();
  if (state === "HELD_PLAN") return heldFrom("PLAN");

  claim(dir, id, "planner");
  run(dir, id, "submit");
  if (state === "PLAN_REVIEW") return here();

  claim(dir, id, "plan-reviewer");
  run(dir, id, "submit");
  if (state === "WORK") return here();
  if (state === "HELD_WORK") return heldFrom("WORK");

  claim(dir, id, "agent-1");
  run(dir, id, "submit");
  if (state === "CHECK") return { dir, id };

  run(dir, id, "pass");
  if (state === "WORK_REVIEW") return here();

  claim(dir, id, "reviewer");
  run(dir, id, "submit");
  return { dir, id };
}

function landsIn(decided: Decision, state: ValidState): TaskState {
  return decided.kind === "stay" ? state : decided.to;
}

describe("Feature: applying the state machine to the task directory", () => {
  testInTempDirs("the directory can put a task in every state there is", () => {
    // Given every state the machine allows a task to sit in
    const states = [...VALID_STATES];

    // When a task is walked into each of them through the task directory
    const reached = states.map((state) => {
      const { dir, id } = build(state);
      return metaOf(dir, id).state;
    });

    // Then each task is sitting in the state that was asked for
    expect(reached).toEqual(states);
  });

  testInTempDirs("every allowed transition is written to the document", () => {
    // Given a task sitting in each state the machine allows a transition from
    const edges = VALID_STATES.flatMap((state) =>
      ALLOWED_TRANSITIONS[state].map((name) => ({ state, name })),
    );

    // When each allowed transition is applied through the task directory
    const applied = edges.map(({ state, name }) => {
      const { dir, id } = build(state);
      const decided = decide(
        structuredClone(metaOf(dir, id)),
        bodyOf(path.join(dir, `${id}.md`)),
        name,
        shape(name, ARGS[name]),
      );

      const result = run(dir, id, name, ...ARGS[name]);
      return {
        edge: `${state} --${name}-->`,
        landed: readTaskFile(documentOf(dir, id, result)).meta.state,
        decided: landsIn(decided, state),
      };
    });

    // Then the document on disk holds the state the machine decided on
    expect(applied.filter((one) => one.landed !== one.decided)).toEqual([]);
  });

  testInTempDirs(
    "a refused transition leaves the document byte for byte",
    () => {
      // Given a task sitting in each state, and its document as it stands
      const untouched = VALID_STATES.map((state) => {
        const { dir, id } = build(state);
        const filePath = path.join(dir, `${id}.md`);
        const before = fs.readFileSync(filePath, "utf-8");

        // When every transition the machine refuses from that state is applied
        const refused = TRANSITION_NAMES.filter(
          (name) => !ALLOWED_TRANSITIONS[state].includes(name),
        );
        for (const name of refused) {
          expect(() => run(dir, id, name, ...ARGS[name])).toThrow(
            /not valid from state/,
          );
        }

        return fs.readFileSync(filePath, "utf-8") === before;
      });

      // Then none of the refusals changed a document
      expect(untouched).toEqual(VALID_STATES.map(() => true));
    },
  );

  testInTempDirs(
    "a transition on a task that does not exist is refused",
    () => {
      // Given an empty task directory
      const dir = makeTasksDir();

      // When a transition is applied to an id nothing carries
      const attempt = () => run(dir, "000999", "submit");

      // Then it is refused, naming the task that was not found
      expect(attempt).toThrow(/not found/);
    },
  );

  testInTempDirs("closing a task moves its document out of the way", () => {
    // Given a task waiting on the manager
    const { dir, id } = build("MANAGER_REVIEW");

    // When the manager submits it
    const result = run(dir, id, "submit");

    // Then the document is in the closed directory, out of the active graph
    expect(fs.existsSync(closedPath(result))).toBe(true);
    expect(fs.existsSync(path.join(dir, `${id}.md`))).toBe(false);
  });

  testInTempDirs("closing a task lets everything waiting on it start", () => {
    // Given a task blocked behind a dependency, held from its design phase
    const { dir, id } = toDesign();
    claim(dir, id, "designer");
    run(dir, id, "hold", "waiting on a dependency");
    const dep = createTask(dir, ORCHESTRATOR_DIR, "the dependency").id;
    addDeps(dir, id, dep);
    expect(run(dir, id, "resume").to).toBe("BLOCKED");

    // When the dependency is closed
    const result = closeTask(dir, dep);

    // Then the task is named as unblocked and starts again from the beginning
    expect(result.unblocked).toEqual([id]);
    expect(metaOf(dir, id).state).toBe("DESIGN");
  });
});

describe("Feature: claiming a task in the task directory", () => {
  testInTempDirs("only the states an agent runs can be claimed", () => {
    // Given a task sitting in each state the machine has
    const states = [...VALID_STATES];

    // When an agent tries to claim each of them
    const claimed = states.map((state) => {
      const dir = makeTasksDir();
      const id = writeTask(dir, { id: "000001", state });
      try {
        claim(dir, id, "agent-1");
        return metaOf(dir, id).claimed_by === "agent-1";
      } catch {
        return false;
      }
    });

    // Then exactly the states an agent runs are the ones it could take
    expect(claimed).toEqual(states.map(isAgentState));
  });

  testInTempDirs(
    "claiming and releasing moves the claim, never the stage",
    async () => {
      // Given a task in each state an agent runs, claimed by a process now gone
      const states = AGENT_STATES;
      const dead = await deadPid();

      // When each claim is taken and then released
      const walked = states.map((state) => {
        const dir = makeTasksDir();
        const id = writeTask(dir, { id: "000001", state });
        claim(dir, id, "agent-1", dead);
        const held = metaOf(dir, id);
        unclaim(dir, id);
        const free = metaOf(dir, id);
        return [held.state, held.claimed_by, free.state, free.claimed_by];
      });

      // Then each task stays where it was, and only the holder changes
      expect(walked).toEqual(
        states.map((state) => [state, "agent-1", state, null]),
      );
    },
  );

  testInTempDirs("a claim held by a live process is not released", () => {
    // Given a task claimed by a process that is still running
    const dir = makeTasksDir();
    const id = writeTask(dir, { id: "000001", state: "WORK" });
    claim(dir, id, "agent-1");

    // When the claim is released
    const attempt = () => unclaim(dir, id);

    // Then it is refused, so a running agent is never reaped out from under
    expect(attempt).toThrow(/still claimed by a live process/);
    expect(metaOf(dir, id).claimed_by).toBe("agent-1");
  });

  testInTempDirs("a task another agent holds cannot be claimed", () => {
    // Given a task an agent is already holding
    const dir = makeTasksDir();
    const id = writeTask(dir, { id: "000001", state: "WORK" });
    claim(dir, id, "agent-1");

    // When a second agent tries to claim it
    const attempt = () => claim(dir, id, "agent-2");

    // Then it is refused, naming the agent that holds it
    expect(attempt).toThrow(/already claimed by "agent-1"/);
    expect(metaOf(dir, id).claimed_by).toBe("agent-1");
  });

  testInTempDirs("an agent cannot speak for a task nothing is holding", () => {
    // Given a task in review that no agent has claimed
    const dir = makeTasksDir();
    const id = writeTask(dir, { id: "000001", state: "WORK_REVIEW" });

    // When a review result arrives for it
    const attempt = () => run(dir, id, "feedback", "a finding");

    // Then it is refused, and the task stays where it was
    expect(attempt).toThrow(/nothing is claiming it/);
    expect(metaOf(dir, id).state).toBe("WORK_REVIEW");
  });

  testInTempDirs(
    "releasing a claim leaves the task where it stood",
    async () => {
      // Given a task in review whose reviewer's process is gone
      const dir = makeTasksDir();
      const id = writeTask(dir, {
        id: "000001",
        state: "WORK_REVIEW",
        claimed_by: "dead-reviewer",
        claimed_pid: await deadPid(),
      });

      // When the claim is released
      unclaim(dir, id);

      // Then the task is back in the queue in the state it was already in
      expect(metaOf(dir, id).state).toBe("WORK_REVIEW");
      expect(metaOf(dir, id).claimed_by).toBeNull();
    },
  );

  testInTempDirs("a held task is never claimable by an agent", () => {
    // Given a task held, waiting on a person
    const { dir, id } = toHeld();
    expect(metaOf(dir, id).state).toBe("HELD_WORK");

    // When an agent tries to claim it
    const attempt = () => claim(dir, id, "agent-1");

    // Then it is refused, so nothing is dispatched onto a parked task
    expect(attempt).toThrow(/which no agent runs/);
  });
});

describe("Feature: what a review does to the task body", () => {
  testInTempDirs("a rejected design leaves the body for the designer", () => {
    // Given a design under review
    const { dir, id } = toDesign();
    claim(dir, id, "designer");
    run(dir, id, "submit");
    claim(dir, id, "design-reviewer");
    const before = bodyOf(path.join(dir, `${id}.md`));

    // When the reviewer sends it back
    const result = run(dir, id, "feedback", "the design misses the empty case");

    // Then the task returns to design with its body untouched
    expect(result.to).toBe("DESIGN");
    expect(bodyOf(path.join(dir, `${id}.md`))).toBe(before);
  });

  testInTempDirs("an accepted design is written into the task body", () => {
    // Given a design under review
    const { dir, id } = toDesign();
    claim(dir, id, "designer");
    run(dir, id, "submit");
    claim(dir, id, "design-reviewer");

    // When the reviewer accepts it, handing in the body it reviewed
    const result = run(dir, id, "submit", "\n# accepted");

    // Then the task moves on to planning, carrying what was accepted
    expect(result.to).toBe("PLAN");
    expect(bodyOf(path.join(dir, `${id}.md`))).toBe("\n# accepted");
  });

  testInTempDirs(
    "repeated design rejections never accumulate in the body",
    () => {
      // Given a design that has been sent back once already
      const { dir, id } = toDesign();
      claim(dir, id, "designer");
      run(dir, id, "submit");
      claim(dir, id, "design-reviewer");
      run(dir, id, "feedback", "finding one");

      // When it is sent back a second time
      claim(dir, id, "designer");
      run(dir, id, "submit");
      claim(dir, id, "design-reviewer");
      run(dir, id, "feedback", "finding two");

      // Then the body still carries neither round of findings
      expect(metaOf(dir, id).state).toBe("DESIGN");
      const body = bodyOf(path.join(dir, `${id}.md`));
      expect(body).not.toContain("finding one");
      expect(body).not.toContain("finding two");
    },
  );

  testInTempDirs("a rejected plan leaves the body for the planner", () => {
    // Given a plan under review
    const { dir, id } = toPlan();
    claim(dir, id, "planner");
    run(dir, id, "submit");
    claim(dir, id, "plan-reviewer");
    const before = bodyOf(path.join(dir, `${id}.md`));

    // When the reviewer sends it back
    const result = run(dir, id, "feedback", "the plan misses the empty case");

    // Then the task returns to planning with its body untouched
    expect(result.to).toBe("PLAN");
    expect(bodyOf(path.join(dir, `${id}.md`))).toBe(before);
  });

  testInTempDirs("an accepted plan is written into the task body", () => {
    // Given a plan under review
    const { dir, id } = toPlan();
    claim(dir, id, "planner");
    run(dir, id, "submit");
    claim(dir, id, "plan-reviewer");

    // When the reviewer accepts it, handing in the body it reviewed
    const result = run(dir, id, "submit", "\n# accepted");

    // Then the task moves on to work, carrying what was accepted
    expect(result.to).toBe("WORK");
    expect(bodyOf(path.join(dir, `${id}.md`))).toBe("\n# accepted");
  });

  testInTempDirs(
    "repeated plan rejections never accumulate in the body",
    () => {
      // Given a plan that has been sent back once already
      const { dir, id } = toPlan();
      claim(dir, id, "planner");
      run(dir, id, "submit");
      claim(dir, id, "plan-reviewer");
      run(dir, id, "feedback", "finding one");

      // When it is sent back a second time
      claim(dir, id, "planner");
      run(dir, id, "submit");
      claim(dir, id, "plan-reviewer");
      run(dir, id, "feedback", "finding two");

      // Then the body still carries neither round of findings
      expect(metaOf(dir, id).state).toBe("PLAN");
      const body = bodyOf(path.join(dir, `${id}.md`));
      expect(body).not.toContain("finding one");
      expect(body).not.toContain("finding two");
    },
  );

  testInTempDirs("a work review's findings are written into the body", () => {
    // Given finished work under review
    const { dir, id } = toAgentReview();

    // When the reviewer sends it back with a finding
    const result = run(dir, id, "feedback", "the null case is untested");

    // Then the worker gets the task back with the finding to read
    expect(result.to).toBe("WORK");
    expect(bodyOf(path.join(dir, `${id}.md`))).toContain(
      "- the null case is untested",
    );
    expect(metaOf(dir, id).claimed_by).toBeNull();
  });

  testInTempDirs(
    "an accepted work review hands the task to the manager",
    () => {
      // Given finished work under review
      const { dir, id } = toAgentReview();

      // When the reviewer accepts it
      const result = run(dir, id, "submit");

      // Then it goes to the manager, claimed by nobody
      expect(result.to).toBe("MANAGER_REVIEW");
      expect(metaOf(dir, id).claimed_by).toBeNull();
    },
  );

  testInTempDirs(
    "a task walks from its checks to closed through both reviews",
    () => {
      // Given a task whose checks are about to pass
      const { dir, id } = toChecking();

      // When it passes, is reviewed, and is accepted by the manager
      const walked = [run(dir, id, "pass").to];
      claim(dir, id, "reviewer");
      walked.push(run(dir, id, "submit").to, run(dir, id, "submit").to);

      // Then it goes through the agent review and the manager review, and closes
      expect(walked).toEqual(["WORK_REVIEW", "MANAGER_REVIEW", "CLOSED"]);
    },
  );
});

describe("Feature: parking a task on a person", () => {
  testInTempDirs(
    "holding a task records its reason and drops the claim",
    () => {
      // Given a task an agent is working on
      const { dir, id } = toWorking();

      // When it is held on something only a person can resolve
      const result = run(dir, id, "hold", "the staging database is down");

      // Then it is parked with the reason, and the slot it held is freed
      expect(result.to).toBe("HELD_WORK");
      const meta = metaOf(dir, id);
      expect(meta.held_reason).toBe("the staging database is down");
      expect(meta.claimed_by).toBeNull();
      expect(meta.claimed_pid).toBeNull();
    },
  );

  testInTempDirs("holding a task with no reason is refused", () => {
    // Given a task an agent is working on
    const { dir, id } = toWorking();

    // When it is held with nothing said about why
    const attempt = () => run(dir, id, "hold");

    // Then it is refused, so nothing lands in the inbox unexplained
    expect(attempt).toThrow(/"reason" must be a non-empty string/);
    expect(metaOf(dir, id).state).toBe("WORK");
  });

  testInTempDirs.each([["resume"], ["abort"]] as const)(
    "answering a hold with %p clears the reason",
    (exit) => {
      // Given a held task, and the way the manager answers it
      const { dir, id } = toHeld();

      // When that exit is taken
      const result = run(dir, id, exit);

      // Then the document it lands on carries no stale reason
      expect(readTaskFile(documentOf(dir, id, result)).meta.held_reason).toBe(
        null,
      );
    },
  );

  testInTempDirs(
    "a task given a dependency while held resumes into BLOCKED",
    () => {
      // Given a held task that has since been made to depend on another
      const { dir, id } = toHeld();
      const dep = createTask(
        dir,
        ORCHESTRATOR_DIR,
        "the thing it was waiting on",
      ).id;
      addDeps(dir, id, dep);

      // When the manager resumes it
      const result = run(dir, id, "resume");

      // Then it waits on its dependency rather than going back to an agent
      expect(result.to).toBe("BLOCKED");
      expect(metaOf(dir, id).held_reason).toBeNull();
      expect(metaOf(dir, id).depends_on).toEqual([dep]);
    },
  );
});
