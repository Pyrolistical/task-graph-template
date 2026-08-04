import { describe, expect } from "bun:test";
import { test } from "./temp.ts";
import fs from "node:fs";
import path from "node:path";
import {
  AGENT_STATES,
  VALID_STATES,
  type ClaimState,
  type ValidState,
  isAgentState,
} from "./states.ts";
import { createTask, readTaskFile } from "./task.ts";
import {
  ALLOWED_TRANSITIONS,
  TRANSITION_NAMES,
  type TransitionName,
} from "./transition.ts";
import {
  ORCHESTRATOR_DIR,
  addDeps,
  bodyOf,
  claim,
  closeTask,
  deadPid,
  editTask,
  makeTasksDir,
  metaOf,
  run,
  unclaim,
  toAgentReview,
  toChecking,
  toDesign,
  toHeld,
  toPlan,
  toWorking,
  writeTask,
} from "./graph-jig.ts";

describe("transitions: table", () => {
  test("an unknown task id is reported", () => {
    const dir = makeTasksDir();
    expect(() => run(dir, "000999", "submit")).toThrow(/not found/);
  });

  test("the states that can be claimed are exactly the states an agent runs", () => {
    for (const state of VALID_STATES) {
      const dir = makeTasksDir();
      const id = writeTask(dir, { id: "000001", state });
      const take = () => claim(dir, id, "agent-1");

      if (isAgentState(state)) {
        take();
        expect(metaOf(dir, id).claimed_by).toBe("agent-1");
      } else {
        expect(take).toThrow(/which no agent runs/);
        expect(metaOf(dir, id).claimed_by).toBeNull();
      }
    }
  });

  test("taking and clearing the claim moves the claim, never the stage", async () => {
    for (const state of AGENT_STATES) {
      const dir = makeTasksDir();
      const id = writeTask(dir, { id: "000001", state });

      claim(dir, id, "agent-1", await deadPid());
      expect(metaOf(dir, id).state).toBe(state);
      expect(metaOf(dir, id).claimed_by).toBe("agent-1");

      unclaim(dir, id);
      expect(metaOf(dir, id).state).toBe(state);
      expect(metaOf(dir, id).claimed_by).toBeNull();
    }
  });

  test("a claim is only cleared once its process is gone", () => {
    const dir = makeTasksDir();
    const id = writeTask(dir, { id: "000001", state: "WORK" });

    claim(dir, id, "agent-1");
    expect(() => unclaim(dir, id)).toThrow(/still claimed by a live process/);
    expect(metaOf(dir, id).claimed_by).toBe("agent-1");
  });

  test("a second agent cannot take a task another one holds", () => {
    const dir = makeTasksDir();
    const id = writeTask(dir, { id: "000001", state: "WORK" });

    claim(dir, id, "agent-1");
    expect(() => claim(dir, id, "agent-2")).toThrow(
      /already claimed by "agent-1"/,
    );
    expect(metaOf(dir, id).claimed_by).toBe("agent-1");
  });

  test("an agent cannot speak for a task nothing is holding", () => {
    const dir = makeTasksDir();
    const id = writeTask(dir, { id: "000001", state: "WORK_REVIEW" });

    expect(() => run(dir, id, "feedback", "a finding")).toThrow(
      /nothing is claiming it/,
    );
    expect(metaOf(dir, id).state).toBe("WORK_REVIEW");
  });

  test("every state offers at least one transition with no duplicates", () => {
    for (const names of Object.values(ALLOWED_TRANSITIONS)) {
      expect(names.length).toBeGreaterThan(0);
      expect(new Set(names).size).toBe(names.length);
    }
  });
});

describe("transitions: the whole state machine", () => {
  interface Case {
    to: string;
    prepare?: (dir: string, id: string) => void;
    args?: (dep: string) => string[];
  }

  const MACHINE: Record<ValidState, Partial<Record<TransitionName, Case>>> = {
    NEW: {
      submit: { to: "DESIGN" },
    },
    BLOCKED: {
      submit: {
        to: "DESIGN",
        prepare: (dir, id) =>
          editTask(dir, id, (meta) => {
            meta.depends_on = [];
          }),
      },
    },
    HELD_DESIGN: {
      resume: { to: "DESIGN" },
      abort: { to: "CLOSED" },
    },
    HELD_PLAN: {
      resume: { to: "PLAN" },
      abort: { to: "CLOSED" },
    },
    HELD_WORK: {
      resume: { to: "WORK" },
      abort: { to: "CLOSED" },
    },
    DESIGN: {
      submit: { to: "DESIGN_REVIEW" },
      hold: { to: "HELD_DESIGN", args: () => ["a reason"] },
    },
    DESIGN_REVIEW: {
      submit: { to: "PLAN" },
      feedback: {
        to: "DESIGN",
        args: () => ["the design misses the empty case"],
      },
      hold: { to: "HELD_DESIGN", args: () => ["a reason"] },
    },
    PLAN: {
      submit: { to: "PLAN_REVIEW" },
      hold: { to: "HELD_PLAN", args: () => ["a reason"] },
    },
    PLAN_REVIEW: {
      submit: { to: "WORK" },
      feedback: {
        to: "PLAN",
        args: () => ["the plan misses the empty case"],
      },
      hold: { to: "HELD_PLAN", args: () => ["a reason"] },
    },
    WORK: {
      submit: { to: "CHECK" },
      hold: { to: "HELD_WORK", args: () => ["a reason"] },
    },
    CHECK: {
      pass: { to: "WORK_REVIEW" },
      fail: { to: "WORK" },
      hold: { to: "HELD_WORK", args: () => ["a reason"] },
    },
    WORK_REVIEW: {
      feedback: { to: "WORK", args: () => ["a finding"] },
      submit: { to: "MANAGER_REVIEW" },
      hold: { to: "HELD_WORK", args: () => ["the range does not exist"] },
    },
    MANAGER_REVIEW: {
      feedback: { to: "WORK", args: () => ["not acceptable yet"] },
      submit: { to: "CLOSED" },
      abort: { to: "CLOSED" },
    },
  };

  const AGENT_OF: Record<ClaimState, string> = {
    DESIGN: "designer",
    DESIGN_REVIEW: "design-reviewer",
    PLAN: "planner",
    PLAN_REVIEW: "plan-reviewer",
    WORK: "agent-1",
    WORK_REVIEW: "reviewer",
  };

  function build(state: ValidState): { dir: string; id: string; dep: string } {
    const dir = makeTasksDir();
    const dep = createTask(dir, ORCHESTRATOR_DIR, "a dependency").id;
    const id = createTask(dir, ORCHESTRATOR_DIR, "the task under test").id;

    function here() {
      if (isAgentState(state)) {
        claim(dir, id, AGENT_OF[state]);
      }
      return { dir, id, dep };
    }

    function heldFrom(stage: ClaimState) {
      claim(dir, id, AGENT_OF[stage]);
      run(dir, id, "hold", "waiting on a person");
      return { dir, id, dep };
    }

    if (state === "NEW") return { dir, id, dep };
    if (state === "BLOCKED") {
      addDeps(dir, id, dep);
      run(dir, id, "submit");
      return { dir, id, dep };
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
    if (state === "CHECK") return { dir, id, dep };

    run(dir, id, "pass");
    if (state === "WORK_REVIEW") return here();

    claim(dir, id, "reviewer");
    run(dir, id, "submit");
    return { dir, id, dep };
  }

  test("the table covers every state and nothing but the allowed transitions", () => {
    expect(Object.keys(MACHINE).sort()).toEqual([...VALID_STATES].sort());

    for (const state of VALID_STATES) {
      expect(Object.keys(MACHINE[state]).sort()).toEqual(
        [...ALLOWED_TRANSITIONS[state]].sort(),
      );
    }

    const exercised = new Set(
      VALID_STATES.flatMap((state) => Object.keys(MACHINE[state])),
    );
    expect([...exercised].sort()).toEqual([...TRANSITION_NAMES].sort());
  });

  test("every allowed transition lands where the machine says it does", () => {
    for (const state of VALID_STATES) {
      for (const [name, expected] of Object.entries(MACHINE[state]) as [
        TransitionName,
        Case,
      ][]) {
        const { dir, id, dep } = build(state);
        expect(metaOf(dir, id).state).toBe(state);

        expected.prepare?.(dir, id);

        const result = run(dir, id, name, ...(expected.args?.(dep) ?? []));
        const landed = result.to ?? state;

        expect(`${state} --${name}--> ${landed}`).toBe(
          `${state} --${name}--> ${expected.to}`,
        );

        if (expected.to === "CLOSED") {
          expect(fs.existsSync(result.closedPath!)).toBe(true);
        } else {
          expect(metaOf(dir, id).state as string).toBe(expected.to);
        }
      }
    }
  });

  test("every transition the machine does not allow is refused", () => {
    for (const state of VALID_STATES) {
      const allowed = new Set<string>(ALLOWED_TRANSITIONS[state]);
      const refused = TRANSITION_NAMES.filter((name) => !allowed.has(name));

      const { dir, id, dep } = build(state);
      const before = fs.readFileSync(path.join(dir, `${id}.md`), "utf-8");

      for (const name of refused) {
        const args = MACHINE[state][name]?.args?.(dep) ?? cliArgs(name, dep);
        expect(() => run(dir, id, name, ...args)).toThrow(
          /not valid from state/,
        );
      }

      expect(fs.readFileSync(path.join(dir, `${id}.md`), "utf-8")).toBe(before);
    }
  });

  function cliArgs(name: TransitionName, dep: string): string[] {
    switch (name) {
      case "hold":
        return ["a reason"];
      case "feedback":
        return ["a finding"];
      default:
        return [];
    }
  }
});

describe("transitions: the design phase", () => {
  test("a rejected design leaves the body untouched, an accepted one is written in", () => {
    const { dir, id } = toDesign();
    claim(dir, id, "designer");
    run(dir, id, "submit");
    claim(dir, id, "design-reviewer");
    const before = bodyOf(path.join(dir, `${id}.md`));
    expect(
      run(dir, id, "feedback", "the design misses the empty case").to,
    ).toBe("DESIGN");
    expect(bodyOf(path.join(dir, `${id}.md`))).toBe(before);

    claim(dir, id, "designer");
    run(dir, id, "submit");
    claim(dir, id, "design-reviewer");
    expect(run(dir, id, "submit", "\n# accepted").to).toBe("PLAN");
    expect(bodyOf(path.join(dir, `${id}.md`))).toBe("\n# accepted");
  });

  test("a second rejection leaves the body untouched again", () => {
    const { dir, id } = toDesign();
    claim(dir, id, "designer");
    run(dir, id, "submit");
    claim(dir, id, "design-reviewer");
    run(dir, id, "feedback", "finding one");

    claim(dir, id, "designer");
    run(dir, id, "submit");
    claim(dir, id, "design-reviewer");
    run(dir, id, "feedback", "finding two");

    expect(metaOf(dir, id).state).toBe("DESIGN");
    const body = bodyOf(path.join(dir, `${id}.md`));
    expect(body).not.toContain("finding one");
    expect(body).not.toContain("finding two");
  });
});

describe("transitions: the planning phase", () => {
  test("a rejected plan leaves the body untouched, an accepted one is written in", () => {
    const { dir, id } = toPlan();
    claim(dir, id, "planner");
    run(dir, id, "submit");
    claim(dir, id, "plan-reviewer");
    const before = bodyOf(path.join(dir, `${id}.md`));
    expect(run(dir, id, "feedback", "the plan misses the empty case").to).toBe(
      "PLAN",
    );
    expect(bodyOf(path.join(dir, `${id}.md`))).toBe(before);

    claim(dir, id, "planner");
    run(dir, id, "submit");
    claim(dir, id, "plan-reviewer");
    expect(run(dir, id, "submit", "\n# accepted").to).toBe("WORK");
    expect(bodyOf(path.join(dir, `${id}.md`))).toBe("\n# accepted");
  });

  test("a second rejection leaves the body untouched again", () => {
    const { dir, id } = toPlan();
    claim(dir, id, "planner");
    run(dir, id, "submit");
    claim(dir, id, "plan-reviewer");
    run(dir, id, "feedback", "finding one");

    claim(dir, id, "planner");
    run(dir, id, "submit");
    claim(dir, id, "plan-reviewer");
    run(dir, id, "feedback", "finding two");

    expect(metaOf(dir, id).state).toBe("PLAN");
    const body = bodyOf(path.join(dir, `${id}.md`));
    expect(body).not.toContain("finding one");
    expect(body).not.toContain("finding two");
  });
});

describe("transitions: the split review", () => {
  test("a task walks CHECK to CLOSED through both reviews", () => {
    const { dir, id } = toChecking();

    expect(run(dir, id, "pass").to).toBe("WORK_REVIEW");
    claim(dir, id, "reviewer");
    expect(metaOf(dir, id).state).toBe("WORK_REVIEW");
    expect(run(dir, id, "submit").to).toBe("MANAGER_REVIEW");
    expect(run(dir, id, "submit").to).toBe("CLOSED");
  });

  test("submit from WORK_REVIEW hands the task straight to the manager", () => {
    const { dir, id } = toAgentReview();
    expect(run(dir, id, "submit").to).toBe("MANAGER_REVIEW");
    expect(metaOf(dir, id).claimed_by).toBeNull();
  });

  test("a finding applied in WORK_REVIEW lands the task in WORK with the finding in the body", () => {
    const { dir, id } = toAgentReview();

    expect(run(dir, id, "feedback", "the null case is untested").to).toBe(
      "WORK",
    );
    expect(bodyOf(path.join(dir, `${id}.md`))).toContain(
      "- the null case is untested",
    );
    expect(metaOf(dir, id).claimed_by).toBeNull();
  });

  test("an agent reviewer cannot close the task or fail it", () => {
    const { dir, id } = toAgentReview();
    expect(ALLOWED_TRANSITIONS.WORK_REVIEW).toEqual([
      "submit",
      "feedback",
      "hold",
    ]);
    expect(() => run(dir, id, "pass")).toThrow(/not valid from state/);
    expect(() => run(dir, id, "abort")).toThrow(/not valid from state/);
  });

  test("clearing a review claim puts the task back in the queue where it stands", async () => {
    const dir = makeTasksDir();
    const id = writeTask(dir, {
      id: "000001",
      state: "WORK_REVIEW",
      claimed_by: "dead-reviewer",
      claimed_pid: await deadPid(),
    });

    unclaim(dir, id);
    expect(metaOf(dir, id).state).toBe("WORK_REVIEW");
    expect(metaOf(dir, id).claimed_by).toBeNull();
  });
});

describe("transitions: hold and resume", () => {
  test("hold from WORK parks the task with its reason and clears the claim", () => {
    const { dir, id } = toWorking();

    expect(run(dir, id, "hold", "the staging database is down").to).toBe(
      "HELD_WORK",
    );

    const meta = metaOf(dir, id);
    expect(meta.held_reason).toBe("the staging database is down");
    expect(meta.claimed_by).toBeNull();
    expect(meta.claimed_pid).toBeNull();
  });

  test("hold from WORK_REVIEW works the same way", () => {
    const { dir, id } = toAgentReview();
    expect(run(dir, id, "hold", "the diff does not apply").to).toBe(
      "HELD_WORK",
    );
    expect(metaOf(dir, id).held_reason).toBe("the diff does not apply");
  });

  test("hold requires a reason", () => {
    const { dir, id } = toWorking();
    expect(() => run(dir, id, "hold")).toThrow(
      /"reason" must be a non-empty string/,
    );
    expect(metaOf(dir, id).state).toBe("WORK");
  });

  test("resume clears the reason and returns the task to WORK", () => {
    const { dir, id } = toHeld();

    expect(run(dir, id, "resume").to).toBe("WORK");
    expect(metaOf(dir, id).held_reason).toBeNull();
  });

  test("every exit from HELD clears held_reason", () => {
    for (const exit of ["resume", "abort"] as const) {
      const { dir, id } = toHeld();
      const result = run(dir, id, exit);
      const filePath = result.closedPath ?? path.join(dir, `${id}.md`);
      const meta = readTaskFile(filePath).meta;
      expect(meta.held_reason).toBeNull();
    }
  });

  test("resume moves a held task to BLOCKED when dependencies were edited in while held", () => {
    const { dir, id } = toHeld();
    const dep = createTask(
      dir,
      ORCHESTRATOR_DIR,
      "the thing it was waiting on",
    ).id;

    addDeps(dir, id, dep);
    expect(run(dir, id, "resume").to).toBe("BLOCKED");
    expect(metaOf(dir, id).held_reason).toBeNull();
    expect(metaOf(dir, id).depends_on).toEqual([dep]);
  });

  test("a task held from design resumes into BLOCKED and unblocks back to DESIGN", () => {
    const { dir, id } = toDesign();
    claim(dir, id, "designer");
    run(dir, id, "hold", "waiting on a dependency");
    const dep = createTask(dir, ORCHESTRATOR_DIR, "the dependency").id;
    addDeps(dir, id, dep);
    expect(run(dir, id, "resume").to).toBe("BLOCKED");
    const result = closeTask(dir, dep);
    expect(result.unblocked).toEqual([id]);
    expect(metaOf(dir, id).state).toBe("DESIGN");
  });

  test("a held task with dependencies resumes into BLOCKED and unblocks back to the start", () => {
    const { dir, id } = toPlan();
    claim(dir, id, "planner");
    run(dir, id, "hold", "waiting on a dependency");
    const dep = createTask(dir, ORCHESTRATOR_DIR, "the dependency").id;
    addDeps(dir, id, dep);
    expect(run(dir, id, "resume").to).toBe("BLOCKED");
    const result = closeTask(dir, dep);
    expect(result.unblocked).toEqual([id]);
    expect(metaOf(dir, id).state).toBe("DESIGN");
  });

  test("abort from HELD_WORK closes a held task", () => {
    const { dir, id } = toHeld();
    expect(run(dir, id, "abort").to).toBe("CLOSED");
  });

  test("hold from PLAN parks the task in HELD_PLAN and resume re-plans it", () => {
    const { dir, id } = toPlan();
    expect(run(dir, id, "hold", "the criteria are empty").to).toBe("HELD_PLAN");
    expect(run(dir, id, "resume").to).toBe("PLAN");
  });

  test("hold from WORK parks the task in HELD_WORK", () => {
    const { dir, id } = toChecking();
    run(dir, id, "fail");
    expect(metaOf(dir, id).state).toBe("WORK");
    expect(run(dir, id, "hold", "reconsidering").to).toBe("HELD_WORK");
  });

  test("hold from PLAN_REVIEW parks the task in HELD_PLAN", () => {
    const { dir, id } = toPlan();
    claim(dir, id, "planner");
    run(dir, id, "submit");
    expect(metaOf(dir, id).state).toBe("PLAN_REVIEW");
    expect(run(dir, id, "hold", "the criteria are still in flux").to).toBe(
      "HELD_PLAN",
    );
  });

  test("hold from CHECK parks the task in HELD_WORK", () => {
    const { dir, id } = toChecking();
    expect(run(dir, id, "hold", "the check needs a key").to).toBe("HELD_WORK");
    expect(metaOf(dir, id).held_reason).toBe("the check needs a key");
  });

  test("hold from WORK_REVIEW parks the task in HELD_WORK", () => {
    const { dir, id } = toChecking();
    run(dir, id, "pass");
    expect(metaOf(dir, id).state).toBe("WORK_REVIEW");
    expect(run(dir, id, "hold", "the range does not apply").to).toBe(
      "HELD_WORK",
    );
  });

  test("hold from DESIGN parks the task in HELD_DESIGN and resume re-designs it", () => {
    const { dir, id } = toDesign();
    expect(run(dir, id, "hold", "the criteria are empty").to).toBe(
      "HELD_DESIGN",
    );
    expect(run(dir, id, "resume").to).toBe("DESIGN");
  });

  test("hold from DESIGN parks the task in HELD_DESIGN and resume re-designs it", () => {
    const { dir, id } = toDesign();
    claim(dir, id, "designer");
    expect(run(dir, id, "hold", "the criteria are empty").to).toBe(
      "HELD_DESIGN",
    );
    expect(run(dir, id, "resume").to).toBe("DESIGN");
  });

  test("hold from DESIGN_REVIEW parks the task in HELD_DESIGN", () => {
    const { dir, id } = toDesign();
    claim(dir, id, "designer");
    run(dir, id, "submit");
    expect(metaOf(dir, id).state).toBe("DESIGN_REVIEW");
    expect(run(dir, id, "hold", "the criteria are still in flux").to).toBe(
      "HELD_DESIGN",
    );
  });

  test("hold from DESIGN_REVIEW parks the task in HELD_DESIGN", () => {
    const { dir, id } = toDesign();
    claim(dir, id, "designer");
    run(dir, id, "submit");
    claim(dir, id, "design-reviewer");
    expect(run(dir, id, "hold", "the criteria contradict the goal").to).toBe(
      "HELD_DESIGN",
    );
  });

  test("hold from PLAN parks the task in HELD_PLAN and resume re-plans it", () => {
    const { dir, id } = toPlan();
    claim(dir, id, "planner");
    expect(run(dir, id, "hold", "the criteria are empty").to).toBe("HELD_PLAN");
    expect(run(dir, id, "resume").to).toBe("PLAN");
  });

  test("hold from PLAN_REVIEW parks the task in HELD_PLAN", () => {
    const { dir, id } = toPlan();
    claim(dir, id, "planner");
    run(dir, id, "submit");
    claim(dir, id, "plan-reviewer");
    expect(run(dir, id, "hold", "the criteria contradict the goal").to).toBe(
      "HELD_PLAN",
    );
  });

  test("the dispatcher queue never contains a held task", () => {
    const { dir, id } = toHeld();
    expect(metaOf(dir, id).state).toBe("HELD_WORK");
    expect(() => claim(dir, id, "agent-1")).toThrow(/which no agent runs/);
  });
});
