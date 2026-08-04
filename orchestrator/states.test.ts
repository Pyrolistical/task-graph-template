import { describe, expect } from "bun:test";
import { test } from "./temp.ts";
import {
  AGENT_STATES,
  ALL_ROLES,
  ENTRY_STATE,
  HELD_OF,
  HELD_STATES,
  NEXT_STATE,
  PHASES,
  PHASE_OF,
  RESUME_TARGETS,
  STAGES,
  STATE_ROLE,
  VALID_STATES,
  isAgentState,
  isHeld,
  isStage,
} from "./states.ts";

describe("the state vocabulary", () => {
  test("every stage is a state the graph accepts, named once", () => {
    const states = STAGES.map((stage) => stage.state);

    for (const state of states) {
      expect(VALID_STATES).toContain(state);
    }
    expect(new Set(states).size).toBe(states.length);

    for (const held of HELD_STATES) {
      expect(VALID_STATES).toContain(held);
    }
  });

  test("the pipeline is one state per stage", () => {
    expect(STAGES.map((stage) => stage.state)).toEqual([
      "DESIGN",
      "DESIGN_REVIEW",
      "PLAN",
      "PLAN_REVIEW",
      "WORK",
      "CHECK",
      "WORK_REVIEW",
      "MANAGER_REVIEW",
    ]);
  });

  test("the states an agent is dispatched to are the ones with a role", () => {
    expect(AGENT_STATES).toEqual([
      "DESIGN",
      "DESIGN_REVIEW",
      "PLAN",
      "PLAN_REVIEW",
      "WORK",
      "WORK_REVIEW",
    ]);

    for (const state of AGENT_STATES) {
      expect(ALL_ROLES).toContain(STATE_ROLE[state]);
    }
    for (const stage of STAGES) {
      expect(stage.state in STATE_ROLE).toBe(isAgentState(stage.state));
    }
  });

  test("the stages with no role are the ones the server and the manager run", () => {
    expect(
      STAGES.filter((stage) => stage.role === null).map((stage) => stage.state),
    ).toEqual(["CHECK", "MANAGER_REVIEW"]);
  });

  test("submit advances to the next stage and stops at the last one", () => {
    expect(NEXT_STATE.DESIGN).toBe("DESIGN_REVIEW");
    expect(NEXT_STATE.DESIGN_REVIEW).toBe("PLAN");
    expect(NEXT_STATE.PLAN).toBe("PLAN_REVIEW");
    expect(NEXT_STATE.PLAN_REVIEW).toBe("WORK");
    expect(NEXT_STATE.WORK).toBe("CHECK");
    expect(NEXT_STATE.CHECK).toBe("WORK_REVIEW");
    expect(NEXT_STATE.WORK_REVIEW).toBe("MANAGER_REVIEW");
    expect("MANAGER_REVIEW" in NEXT_STATE).toBe(false);
  });

  test("every phase has a held state that resumes to where it started", () => {
    for (const phase of PHASES) {
      const held = HELD_OF[phase];
      expect(HELD_STATES).toContain(held);
      expect(PHASE_OF[RESUME_TARGETS[held]]).toBe(phase);
    }
    expect(new Set(Object.values(HELD_OF)).size).toBe(PHASES.length);
  });

  test("every state a task can be held from knows its phase", () => {
    for (const stage of STAGES) {
      expect(PHASES).toContain(PHASE_OF[stage.state]);
    }
  });

  test("a task that unblocks starts at the entry state", () => {
    expect(ENTRY_STATE).toBe("DESIGN");
    expect(PHASE_OF[ENTRY_STATE]).toBe("design");
  });

  test("the guards tell held, stage and agent states apart", () => {
    expect(isHeld("HELD_DESIGN")).toBe(true);
    expect(isHeld("DESIGN")).toBe(false);
    expect(isStage("DESIGN")).toBe(true);
    expect(isStage("CHECK")).toBe(true);
    expect(isStage("HELD_DESIGN")).toBe(false);
    expect(isStage("BLOCKED")).toBe(false);
    expect(isStage("CLOSED")).toBe(false);
    expect(isAgentState("WORK")).toBe(true);
    expect(isAgentState("CHECK")).toBe(false);
    expect(isAgentState("MANAGER_REVIEW")).toBe(false);
  });
});
