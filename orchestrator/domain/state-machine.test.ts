import { describe, expect, test } from "bun:test";
import {
  type TransitionArgs,
  type TransitionName,
  type Decision,
  type ValidState,
  decide,
  isClaimState,
} from "./state-machine.ts";
import type { TaskMeta } from "./task.ts";

const BODY = "the goal\n";

function aTask(state: ValidState, overrides: Partial<TaskMeta> = {}): TaskMeta {
  return {
    id: "000042",
    title: "A task",
    state,
    state_entered: "2026-07-27T12:00:00Z",
    depends_on: [],
    claimed_by: isClaimState(state) ? "agent-1" : undefined,
    claimed_pid: isClaimState(state) ? 1234 : undefined,
    held_reason: undefined,
    workspace: undefined,
    checks: [],
    ...overrides,
  };
}

const ARGS: Record<TransitionName, TransitionArgs> = {
  submit: { body: BODY },
  submit_designing: {},
  submit_planning: {},
  submit_working: {},
  pass: {},
  fail: {},
  hold: { reason: "the staging database is down" },
  resume: {},
  feedback: { findings: ["the null case is untested"] },
  abort: {},
};

function landed(decision: Decision, from: ValidState): string {
  return decision.kind === "stay" ? from : decision.to;
}

describe("Feature: where every transition lands", () => {
  test("a task in NEW submitted for designing lands in DESIGN", () => {
    // Given a new task with nothing holding it back
    const meta = aTask("NEW");

    // When a submit_designing is decided on it
    const decided = decide(meta, BODY, "submit_designing", {});

    // Then the task lands in DESIGN
    expect(landed(decided, "NEW")).toBe("DESIGN");
  });

  test("a task in NEW submitted for planning lands in PLAN", () => {
    // Given a new task the manager has already designed
    const meta = aTask("NEW");

    // When a submit_planning is decided on it
    const decided = decide(meta, BODY, "submit_planning", {});

    // Then the task lands in PLAN, its design taken on trust
    expect(landed(decided, "NEW")).toBe("PLAN");
  });

  test("a task in NEW submitted for working lands in WORK", () => {
    // Given a new task the manager has already designed and planned
    const meta = aTask("NEW");

    // When a submit_working is decided on it
    const decided = decide(meta, BODY, "submit_working", {});

    // Then the task lands in WORK, its design and plan taken on trust
    expect(landed(decided, "NEW")).toBe("WORK");
  });

  test("a task in BLOCKED_DESIGN submitted for designing lands in DESIGN", () => {
    // Given a task waiting to be designed, with nothing left to wait on
    const meta = aTask("BLOCKED_DESIGN");

    // When a submit_designing is decided on it
    const decided = decide(meta, BODY, "submit_designing", {});

    // Then the task lands in DESIGN
    expect(landed(decided, "BLOCKED_DESIGN")).toBe("DESIGN");
  });

  test("a task in BLOCKED_WORK submitted for working lands in WORK", () => {
    // Given a task waiting to be worked, with nothing left to wait on
    const meta = aTask("BLOCKED_WORK");

    // When a submit_working is decided on it
    const decided = decide(meta, BODY, "submit_working", {});

    // Then the task lands in WORK
    expect(landed(decided, "BLOCKED_WORK")).toBe("WORK");
  });

  test("a task in HELD_DESIGN that resumes lands in DESIGN", () => {
    // Given a task parked on a design hold
    const meta = aTask("HELD_DESIGN");

    // When a resume is decided on it
    const decided = decide(meta, BODY, "resume", ARGS.resume);

    // Then the task lands in DESIGN
    expect(landed(decided, "HELD_DESIGN")).toBe("DESIGN");
  });

  test("a task in HELD_DESIGN that aborts lands in CLOSED", () => {
    // Given a task parked on a design hold
    const meta = aTask("HELD_DESIGN");

    // When an abort is decided on it
    const decided = decide(meta, BODY, "abort", ARGS.abort);

    // Then the task lands in CLOSED
    expect(landed(decided, "HELD_DESIGN")).toBe("CLOSED");
  });

  test("a task in HELD_PLAN that resumes lands in PLAN", () => {
    // Given a task parked on a plan hold
    const meta = aTask("HELD_PLAN");

    // When a resume is decided on it
    const decided = decide(meta, BODY, "resume", ARGS.resume);

    // Then the task lands in PLAN
    expect(landed(decided, "HELD_PLAN")).toBe("PLAN");
  });

  test("a task in HELD_PLAN that aborts lands in CLOSED", () => {
    // Given a task parked on a plan hold
    const meta = aTask("HELD_PLAN");

    // When an abort is decided on it
    const decided = decide(meta, BODY, "abort", ARGS.abort);

    // Then the task lands in CLOSED
    expect(landed(decided, "HELD_PLAN")).toBe("CLOSED");
  });

  test("a task in HELD_WORK that resumes lands in WORK", () => {
    // Given a task parked on a work hold
    const meta = aTask("HELD_WORK");

    // When a resume is decided on it
    const decided = decide(meta, BODY, "resume", ARGS.resume);

    // Then the task lands in WORK
    expect(landed(decided, "HELD_WORK")).toBe("WORK");
  });

  test("a task in HELD_WORK that aborts lands in CLOSED", () => {
    // Given a task parked on a work hold
    const meta = aTask("HELD_WORK");

    // When an abort is decided on it
    const decided = decide(meta, BODY, "abort", ARGS.abort);

    // Then the task lands in CLOSED
    expect(landed(decided, "HELD_WORK")).toBe("CLOSED");
  });

  test("a task in DESIGN that submits lands in DESIGN_REVIEW", () => {
    // Given a task in the design stage
    const meta = aTask("DESIGN");

    // When a submit is decided on it
    const decided = decide(meta, BODY, "submit", ARGS.submit);

    // Then the task lands in DESIGN_REVIEW
    expect(landed(decided, "DESIGN")).toBe("DESIGN_REVIEW");
  });

  test("a task in DESIGN that holds lands in HELD_DESIGN", () => {
    // Given a task in the design stage
    const meta = aTask("DESIGN");

    // When a hold is decided on it
    const decided = decide(meta, BODY, "hold", ARGS.hold);

    // Then the task lands in HELD_DESIGN
    expect(landed(decided, "DESIGN")).toBe("HELD_DESIGN");
  });

  test("a task in DESIGN_REVIEW that submits lands in PLAN", () => {
    // Given a task sitting in design review
    const meta = aTask("DESIGN_REVIEW");

    // When a submit is decided on it
    const decided = decide(meta, BODY, "submit", ARGS.submit);

    // Then the task lands in PLAN
    expect(landed(decided, "DESIGN_REVIEW")).toBe("PLAN");
  });

  test("a task in DESIGN_REVIEW that sends feedback lands in DESIGN", () => {
    // Given a task sitting in design review
    const meta = aTask("DESIGN_REVIEW");

    // When feedback is decided on it
    const decided = decide(meta, BODY, "feedback", ARGS.feedback);

    // Then the task lands in DESIGN
    expect(landed(decided, "DESIGN_REVIEW")).toBe("DESIGN");
  });

  test("a task in DESIGN_REVIEW that holds lands in HELD_DESIGN", () => {
    // Given a task sitting in design review
    const meta = aTask("DESIGN_REVIEW");

    // When a hold is decided on it
    const decided = decide(meta, BODY, "hold", ARGS.hold);

    // Then the task lands in HELD_DESIGN
    expect(landed(decided, "DESIGN_REVIEW")).toBe("HELD_DESIGN");
  });

  test("a task in PLAN that submits lands in PLAN_REVIEW", () => {
    // Given a task in the plan stage
    const meta = aTask("PLAN");

    // When a submit is decided on it
    const decided = decide(meta, BODY, "submit", ARGS.submit);

    // Then the task lands in PLAN_REVIEW
    expect(landed(decided, "PLAN")).toBe("PLAN_REVIEW");
  });

  test("a task in PLAN that holds lands in HELD_PLAN", () => {
    // Given a task in the plan stage
    const meta = aTask("PLAN");

    // When a hold is decided on it
    const decided = decide(meta, BODY, "hold", ARGS.hold);

    // Then the task lands in HELD_PLAN
    expect(landed(decided, "PLAN")).toBe("HELD_PLAN");
  });

  test("a task in PLAN_REVIEW that submits lands in WORK", () => {
    // Given a task sitting in plan review
    const meta = aTask("PLAN_REVIEW");

    // When a submit is decided on it
    const decided = decide(meta, BODY, "submit", ARGS.submit);

    // Then the task lands in WORK
    expect(landed(decided, "PLAN_REVIEW")).toBe("WORK");
  });

  test("a task in PLAN_REVIEW that sends feedback lands in PLAN", () => {
    // Given a task sitting in plan review
    const meta = aTask("PLAN_REVIEW");

    // When feedback is decided on it
    const decided = decide(meta, BODY, "feedback", ARGS.feedback);

    // Then the task lands in PLAN
    expect(landed(decided, "PLAN_REVIEW")).toBe("PLAN");
  });

  test("a task in PLAN_REVIEW that holds lands in HELD_PLAN", () => {
    // Given a task sitting in plan review
    const meta = aTask("PLAN_REVIEW");

    // When a hold is decided on it
    const decided = decide(meta, BODY, "hold", ARGS.hold);

    // Then the task lands in HELD_PLAN
    expect(landed(decided, "PLAN_REVIEW")).toBe("HELD_PLAN");
  });

  test("a task in WORK that submits lands in CHECK", () => {
    // Given a task being worked on
    const meta = aTask("WORK");

    // When a submit is decided on it
    const decided = decide(meta, BODY, "submit", ARGS.submit);

    // Then the task lands in CHECK
    expect(landed(decided, "WORK")).toBe("CHECK");
  });

  test("a task in WORK that holds lands in HELD_WORK", () => {
    // Given a task being worked on
    const meta = aTask("WORK");

    // When a hold is decided on it
    const decided = decide(meta, BODY, "hold", ARGS.hold);

    // Then the task lands in HELD_WORK
    expect(landed(decided, "WORK")).toBe("HELD_WORK");
  });

  test("a task in CHECK that passes lands in WORK_REVIEW", () => {
    // Given a task sitting in the check stage
    const meta = aTask("CHECK");

    // When a pass is decided on it
    const decided = decide(meta, BODY, "pass", ARGS.pass);

    // Then the task lands in WORK_REVIEW
    expect(landed(decided, "CHECK")).toBe("WORK_REVIEW");
  });

  test("a task in CHECK that fails lands in WORK", () => {
    // Given a task sitting in the check stage
    const meta = aTask("CHECK");

    // When a fail is decided on it
    const decided = decide(meta, BODY, "fail", ARGS.fail);

    // Then the task lands in WORK
    expect(landed(decided, "CHECK")).toBe("WORK");
  });

  test("a task in CHECK that holds lands in HELD_WORK", () => {
    // Given a task sitting in the check stage
    const meta = aTask("CHECK");

    // When a hold is decided on it
    const decided = decide(meta, BODY, "hold", ARGS.hold);

    // Then the task lands in HELD_WORK
    expect(landed(decided, "CHECK")).toBe("HELD_WORK");
  });

  test("a task in WORK_REVIEW that submits lands in MANAGER_REVIEW", () => {
    // Given a task sitting in work review
    const meta = aTask("WORK_REVIEW");

    // When a submit is decided on it
    const decided = decide(meta, BODY, "submit", ARGS.submit);

    // Then the task lands in MANAGER_REVIEW
    expect(landed(decided, "WORK_REVIEW")).toBe("MANAGER_REVIEW");
  });

  test("a task in WORK_REVIEW that sends feedback lands in WORK", () => {
    // Given a task sitting in work review
    const meta = aTask("WORK_REVIEW");

    // When feedback is decided on it
    const decided = decide(meta, BODY, "feedback", ARGS.feedback);

    // Then the task lands in WORK
    expect(landed(decided, "WORK_REVIEW")).toBe("WORK");
  });

  test("a task in WORK_REVIEW that holds lands in HELD_WORK", () => {
    // Given a task sitting in work review
    const meta = aTask("WORK_REVIEW");

    // When a hold is decided on it
    const decided = decide(meta, BODY, "hold", ARGS.hold);

    // Then the task lands in HELD_WORK
    expect(landed(decided, "WORK_REVIEW")).toBe("HELD_WORK");
  });

  test("a task in MANAGER_REVIEW that submits lands in CLOSED", () => {
    // Given a task waiting on the manager
    const meta = aTask("MANAGER_REVIEW");

    // When a submit is decided on it
    const decided = decide(meta, BODY, "submit", ARGS.submit);

    // Then the task lands in CLOSED
    expect(landed(decided, "MANAGER_REVIEW")).toBe("CLOSED");
  });

  test("a task in MANAGER_REVIEW that sends feedback lands in WORK", () => {
    // Given a task waiting on the manager
    const meta = aTask("MANAGER_REVIEW");

    // When feedback is decided on it
    const decided = decide(meta, BODY, "feedback", ARGS.feedback);

    // Then the task lands in WORK
    expect(landed(decided, "MANAGER_REVIEW")).toBe("WORK");
  });

  test("a task in MANAGER_REVIEW that aborts lands in CLOSED", () => {
    // Given a task waiting on the manager
    const meta = aTask("MANAGER_REVIEW");

    // When an abort is decided on it
    const decided = decide(meta, BODY, "abort", ARGS.abort);

    // Then the task lands in CLOSED
    expect(landed(decided, "MANAGER_REVIEW")).toBe("CLOSED");
  });
});

describe("Feature: the transitions a task turns away", () => {
  test("a task in NEW will not take a pass", () => {
    // Given a new task with nothing holding it back
    const meta = aTask("NEW");

    // When a pass is decided on it
    const attempt = () => decide(meta, BODY, "pass", ARGS.pass);

    // Then it is turned away as not valid from NEW
    expect(attempt).toThrow(/not valid from state "NEW"/);
  });
});

describe("Feature: the edges that read the task itself", () => {
  test("a new task with dependencies is submitted into BLOCKED_DESIGN", () => {
    // Given a new task that depends on another
    const meta = aTask("NEW", { depends_on: ["000001"] });

    // When the task is submitted into the pipeline
    const decided = decide(meta, BODY, "submit_designing", {});

    // Then it waits in BLOCKED_DESIGN rather than entering the design phase
    expect(landed(decided, "NEW")).toBe("BLOCKED_DESIGN");
  });

  test("a new task with dependencies submitted for working waits in BLOCKED_WORK", () => {
    // Given a new task that depends on another, designed and planned already
    const meta = aTask("NEW", { depends_on: ["000001"] });

    // When the task is submitted into the pipeline at the work phase
    const decided = decide(meta, BODY, "submit_working", {});

    // Then it waits in BLOCKED_WORK, remembering the phase it will start at
    expect(landed(decided, "NEW")).toBe("BLOCKED_WORK");
  });

  test("a blocked task that still has dependencies stays where it is", () => {
    // Given a task waiting to be designed whose dependency has not closed
    const meta = aTask("BLOCKED_DESIGN", { depends_on: ["000001"] });

    // When the task is submitted into the pipeline
    const decided = decide(meta, BODY, "submit_designing", {});

    // Then the machine moves it nowhere at all
    expect(decided).toEqual({ kind: "stay" });
  });

  test("a blocked task submitted for another phase waits for that one instead", () => {
    // Given a task waiting to be designed whose dependency has not closed
    const meta = aTask("BLOCKED_DESIGN", { depends_on: ["000001"] });

    // When the manager submits it for working while it waits
    const decided = decide(meta, BODY, "submit_working", {});

    // Then it waits in BLOCKED_WORK, so the last dependency releases it into WORK
    expect(landed(decided, "BLOCKED_DESIGN")).toBe("BLOCKED_WORK");
  });

  test("a held task that gained a dependency resumes into its phase's blocked state", () => {
    // Given a task held out of the work phase, given a dependency while parked
    const meta = aTask("HELD_WORK", { depends_on: ["000001"] });

    // When the task is resumed off its hold
    const decided = decide(meta, BODY, "resume", {});

    // Then it waits in BLOCKED_WORK, so it returns to the work phase when freed
    expect(landed(decided, "HELD_WORK")).toBe("BLOCKED_WORK");
  });
});

describe("Feature: what a transition carries with it", () => {
  test("holding a task records the reason it was parked", () => {
    // Given a task an agent is working on
    const meta = aTask("WORK");

    // When it is held with a reason
    decide(meta, BODY, "hold", { reason: "the staging database is down" });

    // Then the reason is written onto the task
    expect(meta.held_reason).toBe("the staging database is down");
  });

  test("a review that accepts the work carries the reviewed body forward", () => {
    // Given a reviewer holding a task in design review
    const meta = aTask("DESIGN_REVIEW");

    // When it submits the body it reviewed
    const decided = decide(meta, BODY, "submit", { body: "the design\n" });

    // Then the body it submitted is what the task will carry
    expect(decided).toEqual({ kind: "move", to: "PLAN", body: "the design\n" });
  });

  test("a stage that writes no body submits without carrying one", () => {
    // Given a designer holding a task in the design stage
    const meta = aTask("DESIGN");

    // When the designer submits its stage
    const decided = decide(meta, BODY, "submit", {});

    // Then the machine carries no body forward
    expect(decided).toEqual({
      kind: "move",
      to: "DESIGN_REVIEW",
      body: undefined,
    });
  });

  test("findings sent back to the worker are appended to the task body", () => {
    // Given a reviewer holding a task in work review
    const meta = aTask("WORK_REVIEW");

    // When it sends findings back
    const decided = decide(meta, BODY, "feedback", {
      findings: ["the null case is untested"],
    });

    // Then the findings are appended to the body the worker will read
    expect(decided).toEqual({
      kind: "move",
      to: "WORK",
      body: `${BODY}\n\n# Review findings\n\n- the null case is untested\n`,
    });
  });

  test("findings sent back to an earlier phase leave the body alone", () => {
    // Given a reviewer holding a task in plan review
    const meta = aTask("PLAN_REVIEW");

    // When it sends findings back to the planner
    const decided = decide(meta, BODY, "feedback", {
      findings: ["the plan misses the empty case"],
    });

    // Then the body is left for the planner to rewrite
    expect(decided).toEqual({ kind: "move", to: "PLAN", body: undefined });
  });
});

describe("Feature: only the agent holding a task may speak for it", () => {
  test("an unclaimed task in an agent state cannot be submitted", () => {
    // Given a task in an agent state that nothing is claiming
    const meta = aTask("WORK", {
      claimed_by: undefined,
      claimed_pid: undefined,
    });

    // When a submit arrives for it
    const attempt = () => decide(meta, BODY, "submit", { body: BODY });

    // Then the machine refuses it as an agent speaking for a task it does not hold
    expect(attempt).toThrow(/nothing is claiming it/);
  });

  test("an unclaimed task in an agent state cannot be sent feedback", () => {
    // Given a task in review that nothing is claiming
    const meta = aTask("WORK_REVIEW", {
      claimed_by: undefined,
      claimed_pid: undefined,
    });

    // When feedback arrives for it
    const attempt = () =>
      decide(meta, BODY, "feedback", { findings: ["a finding"] });

    // Then the machine refuses it as an agent speaking for a task it does not hold
    expect(attempt).toThrow(/nothing is claiming it/);
  });

  test("a manager may still speak for a task no agent holds", () => {
    // Given a task waiting on the manager, which no agent claims
    const meta = aTask("MANAGER_REVIEW");

    // When the manager submits it
    const decided = decide(meta, BODY, "submit", {});

    // Then the task closes, because the rule guards agent states only
    expect(landed(decided, "MANAGER_REVIEW")).toBe("CLOSED");
  });
});
