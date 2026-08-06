import { describe, expect, test } from "bun:test";
import {
  type TransitionArgs,
  type TransitionName,
  type Decision,
  type ValidState,
  ALLOWED_TRANSITIONS,
  TRANSITION_NAMES,
  VALID_STATES,
  decide,
  isAgentState,
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
    claimed_by: isAgentState(state) ? "agent-1" : null,
    claimed_pid: isAgentState(state) ? 1234 : null,
    held_reason: null,
    workspace: null,
    checks: [],
    ...overrides,
  };
}

const ARGS: Record<TransitionName, TransitionArgs> = {
  submit: { body: BODY },
  pass: {},
  fail: {},
  hold: { reason: "the staging database is down" },
  resume: {},
  feedback: { findings: ["the null case is untested"] },
  abort: {},
};

const EDGES: Record<ValidState, Partial<Record<TransitionName, string>>> = {
  NEW: { submit: "DESIGN" },
  BLOCKED: { submit: "DESIGN" },
  HELD_DESIGN: { resume: "DESIGN", abort: "CLOSED" },
  HELD_PLAN: { resume: "PLAN", abort: "CLOSED" },
  HELD_WORK: { resume: "WORK", abort: "CLOSED" },
  DESIGN: { submit: "DESIGN_REVIEW", hold: "HELD_DESIGN" },
  DESIGN_REVIEW: {
    submit: "PLAN",
    feedback: "DESIGN",
    hold: "HELD_DESIGN",
  },
  PLAN: { submit: "PLAN_REVIEW", hold: "HELD_PLAN" },
  PLAN_REVIEW: { submit: "WORK", feedback: "PLAN", hold: "HELD_PLAN" },
  WORK: { submit: "CHECK", hold: "HELD_WORK" },
  CHECK: { pass: "WORK_REVIEW", fail: "WORK", hold: "HELD_WORK" },
  WORK_REVIEW: {
    submit: "MANAGER_REVIEW",
    feedback: "WORK",
    hold: "HELD_WORK",
  },
  MANAGER_REVIEW: { submit: "CLOSED", feedback: "WORK", abort: "CLOSED" },
};

function landed(decision: Decision, from: ValidState): string {
  return decision.kind === "stay" ? from : decision.to;
}

function edges(): { from: ValidState; name: TransitionName; to: string }[] {
  return VALID_STATES.flatMap((from) =>
    Object.entries(EDGES[from]).map(([name, to]) => ({
      from,
      name: name as TransitionName,
      to,
    })),
  );
}

describe("Feature: where every transition lands", () => {
  test("the table of edges names every transition the machine allows", () => {
    // Given the edges this suite claims the machine has
    const claimed = VALID_STATES.map(
      (state) => `${state}: ${Object.keys(EDGES[state]).sort().join(", ")}`,
    );

    // When they are lined up against the transitions the machine allows
    const allowed = VALID_STATES.map(
      (state) =>
        `${state}: ${[...ALLOWED_TRANSITIONS[state]].sort().join(", ")}`,
    );

    // Then the suite covers each of them and invents none
    expect(claimed).toEqual(allowed);
  });

  test("every transition the machine allows is one this suite exercises", () => {
    // Given the names of every transition in the machine
    const names = [...TRANSITION_NAMES].sort();

    // When the names appearing somewhere in the table of edges are collected
    const exercised = [...new Set(edges().map((edge) => edge.name))].sort();

    // Then none of the transitions goes untested
    expect(exercised).toEqual(names);
  });

  test("every allowed transition lands in the state the machine promises", () => {
    // Given a task sitting in each state the machine allows a transition from
    const walked = edges().map((edge) => {
      const meta = aTask(edge.from);

      // When each allowed transition is decided on that task
      const decided = decide(meta, BODY, edge.name, ARGS[edge.name]);
      return `${edge.from} --${edge.name}--> ${landed(decided, edge.from)}`;
    });

    // Then each one lands where the machine says it does
    expect(walked).toEqual(
      edges().map((edge) => `${edge.from} --${edge.name}--> ${edge.to}`),
    );
  });

  test("every transition the machine does not allow is refused", () => {
    // Given every pairing of a state with a transition it does not allow
    const refused = VALID_STATES.flatMap((state) =>
      TRANSITION_NAMES.filter(
        (name) => !ALLOWED_TRANSITIONS[state].includes(name),
      ).map((name) => ({ state, name })),
    );

    // Given there are enough of them for the rule to mean something
    expect(refused.length).toBeGreaterThan(30);

    // When each pairing is decided on a task sitting in that state
    const accepted = refused.filter(({ state, name }) => {
      try {
        decide(aTask(state), BODY, name, ARGS[name]);
        return true;
      } catch (err) {
        return !/not valid from state/.test((err as Error).message);
      }
    });

    // Then every one of them is turned away as invalid from that state
    expect(accepted).toEqual([]);
  });

  test("a closed task has no transition left at all", () => {
    // Given a task that has already been closed
    const meta = { ...aTask("NEW"), state: "CLOSED" as const };

    // When any transition is decided on it
    const attempt = () => decide(meta, BODY, "submit", ARGS.submit);

    // Then the machine says the task is closed and has no further transitions
    expect(attempt).toThrow(/is CLOSED and has no further transitions/);
  });
});

describe("Feature: the edges that read the task itself", () => {
  test("a new task with dependencies is submitted into BLOCKED", () => {
    // Given a new task that depends on another
    const meta = aTask("NEW", { depends_on: ["000001"] });

    // When the task is submitted into the pipeline
    const decided = decide(meta, BODY, "submit", {});

    // Then it waits in BLOCKED rather than entering the design phase
    expect(landed(decided, "NEW")).toBe("BLOCKED");
  });

  test("a blocked task that still has dependencies stays where it is", () => {
    // Given a blocked task whose dependency has not closed
    const meta = aTask("BLOCKED", { depends_on: ["000001"] });

    // When the task is submitted into the pipeline
    const decided = decide(meta, BODY, "submit", {});

    // Then the machine moves it nowhere at all
    expect(decided).toEqual({ kind: "stay" });
  });

  test("a held task that gained a dependency resumes into BLOCKED", () => {
    // Given a held task that was given a dependency while it was parked
    const meta = aTask("HELD_WORK", { depends_on: ["000001"] });

    // When the task is resumed off its hold
    const decided = decide(meta, BODY, "resume", {});

    // Then it waits in BLOCKED instead of returning to its phase
    expect(landed(decided, "HELD_WORK")).toBe("BLOCKED");
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

  test("holding a task without a reason is refused", () => {
    // Given a task an agent is working on
    const meta = aTask("WORK");

    // When it is held with no reason given
    const attempt = () => decide(meta, BODY, "hold", {});

    // Then the machine insists on a reason
    expect(attempt).toThrow(/"reason" must be a non-empty string/);
  });

  test("a review that accepts the work carries the reviewed body forward", () => {
    // Given a reviewer holding a task in design review
    const meta = aTask("DESIGN_REVIEW");

    // When it submits the body it reviewed
    const decided = decide(meta, BODY, "submit", { body: "the design\n" });

    // Then the body it submitted is what the task will carry
    expect(decided).toEqual({ kind: "move", to: "PLAN", body: "the design\n" });
  });

  test("a review that accepts the work without a body is refused", () => {
    // Given a reviewer holding a task in design review
    const meta = aTask("DESIGN_REVIEW");

    // When it submits with no body
    const attempt = () => decide(meta, BODY, "submit", {});

    // Then the machine insists on the body it reviewed
    expect(attempt).toThrow(/"body" must be a non-empty string/);
  });

  test("a stage that writes no body submits without carrying one", () => {
    // Given a designer holding a task in the design stage
    const meta = aTask("DESIGN");

    // When the designer submits its stage
    const decided = decide(meta, BODY, "submit", {});

    // Then the machine carries no body forward
    expect(decided).toEqual({ kind: "move", to: "DESIGN_REVIEW", body: null });
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
    expect(decided).toEqual({ kind: "move", to: "PLAN", body: null });
  });

  test("feedback with no findings is refused", () => {
    // Given a reviewer holding a task in work review
    const meta = aTask("WORK_REVIEW");

    // When it sends feedback with an empty list of findings
    const attempt = () => decide(meta, BODY, "feedback", { findings: [] });

    // Then the machine insists on at least one finding
    expect(attempt).toThrow(/"findings" must be a non-empty list/);
  });
});

describe("Feature: only the agent holding a task may speak for it", () => {
  test("an unclaimed task in an agent state cannot be submitted", () => {
    // Given a task in an agent state that nothing is claiming
    const meta = aTask("WORK", { claimed_by: null, claimed_pid: null });

    // When a submit arrives for it
    const attempt = () => decide(meta, BODY, "submit", { body: BODY });

    // Then the machine refuses it as an agent speaking for a task it does not hold
    expect(attempt).toThrow(/nothing is claiming it/);
  });

  test("an unclaimed task in an agent state cannot be sent feedback", () => {
    // Given a task in review that nothing is claiming
    const meta = aTask("WORK_REVIEW", { claimed_by: null, claimed_pid: null });

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
