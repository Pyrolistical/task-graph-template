import { describe, expect, test } from "bun:test";
import { type Settlement, decideSettle } from "./settle.ts";
import type { ClaimState } from "../domain/state-machine.ts";
import { LOOP_LIMIT } from "../domain/protocol.ts";

function anAgent(state: ClaimState): Settlement {
  return {
    state,
    alive: true,
    stopReason: "toolUse",
    looping: null,
    calls: [{ tool: "submit", args: submitArgs(state) }],
    diff: state.endsWith("_REVIEW") ? "unchanged" : "ok",
    worktree: { dirty: [], commits: state === "WORK" ? 1 : 0 },
    base: "master",
  };
}

function submitArgs(state: ClaimState): Record<string, unknown> {
  if (state === "WORK_REVIEW") {
    return { findings: [], delegations: [] };
  }
  if (state === "DESIGN_REVIEW" || state === "PLAN_REVIEW") {
    return { findings: [] };
  }
  return {};
}

describe("Feature: settling an agent that finished its turn", () => {
  test("a designer that appended its section hands the turn in", () => {
    // Given a designer settled after calling submit
    const settled = anAgent("DESIGN");

    // Given it appended a design section and left the worktree alone
    settled.diff = "ok";
    settled.worktree = { dirty: [], commits: 0 };

    // When the server decides what to do with the settle
    const intents = decideSettle(settled);

    // Then the task is submitted to the next stage
    expect(intents).toEqual([{ kind: "submit", body: false }]);
  });

  test("a worker hands in its assignment as the new task body", () => {
    // Given a worker settled after calling submit
    const settled = anAgent("WORK");

    // Given it appended notes and committed its work
    settled.diff = "ok";
    settled.worktree = { dirty: [], commits: 2 };

    // When the server decides what to do with the settle
    const intents = decideSettle(settled);

    // Then the assignment becomes the task body
    expect(intents).toEqual([{ kind: "submit", body: true }]);
  });

  test("a reviewer that found nothing accepts the work", () => {
    // Given a work reviewer settled after calling submit with no findings
    const settled = anAgent("WORK_REVIEW");

    // When the server decides what to do with the settle
    const intents = decideSettle(settled);

    // Then the task moves on without a body change
    expect(intents).toEqual([{ kind: "submit", body: false }]);
  });

  test("a reviewer that found defects sends the work back", () => {
    // Given a work reviewer settled after calling submit with findings
    const settled = anAgent("WORK_REVIEW");
    settled.calls = [
      {
        tool: "submit",
        args: { findings: ["the null case is untested"], delegations: [] },
      },
    ];

    // When the server decides what to do with the settle
    const intents = decideSettle(settled);

    // Then the findings become feedback
    expect(intents).toEqual([
      { kind: "feedback", findings: ["the null case is untested"] },
    ]);
  });

  test("a designer that appended nothing is asked for a design", () => {
    // Given a designer settled after calling submit
    const settled = anAgent("DESIGN");

    // Given the assignment came back exactly as it was dispatched
    settled.diff = "unchanged";

    // When the server decides what to do with the settle
    const intents = decideSettle(settled);

    // Then the missing-design issue is raised against it
    expect(intents).toEqual([
      { kind: "raise", issue: "missing-design", detail: "", vars: {} },
    ]);
  });

  test("a planner that appended nothing is asked for todos", () => {
    // Given a planner settled after calling submit
    const settled = anAgent("PLAN");

    // Given the assignment came back exactly as it was dispatched
    settled.diff = "unchanged";

    // When the server decides what to do with the settle
    const intents = decideSettle(settled);

    // Then the missing-todos issue is raised against it
    expect(intents).toEqual([
      { kind: "raise", issue: "missing-todos", detail: "", vars: {} },
    ]);
  });

  test("a worker that rewrote the assignment above its section has it restored", () => {
    // Given a worker settled after calling submit
    const settled = anAgent("WORK");

    // Given it changed the assignment above the notes it was allowed to append
    settled.diff = "modified";

    // When the server decides what to do with the settle
    const intents = decideSettle(settled);

    // Then everything above its heading is restored
    expect(intents[0]).toEqual({
      kind: "restore",
      section: "## Implementation Notes",
    });

    // Then the modified-assignment issue is raised against it
    expect(intents[1]).toEqual({
      kind: "raise",
      issue: "modified-assignment",
      detail: "",
      vars: {},
    });
  });

  test("a reviewer that touched the assignment at all has it restored", () => {
    // Given a plan reviewer settled after calling submit
    const settled = anAgent("PLAN_REVIEW");

    // Given it appended to an assignment it may only read
    settled.diff = "ok";

    // When the server decides what to do with the settle
    const intents = decideSettle(settled);

    // Then the whole file is restored, with no section kept
    expect(intents[0]).toEqual({ kind: "restore", section: null });

    // Then the modified-assignment issue is raised against it
    expect(intents[1]!.kind).toBe("raise");
  });

  test("a worker that committed nothing is told its work is uncommitted", () => {
    // Given a worker settled after calling submit with notes appended
    const settled = anAgent("WORK");

    // Given its branch carries no commit of its own
    settled.worktree = { dirty: [], commits: 0 };

    // When the server decides what to do with the settle
    const intents = decideSettle(settled);

    // Then the uncommitted issue is raised against it
    expect(intents[0]).toMatchObject({ kind: "raise", issue: "uncommitted" });
  });

  test("a designer that wrote to the worktree is told to undo it", () => {
    // Given a designer settled after appending its design
    const settled = anAgent("DESIGN");

    // Given it left two uncommitted files in the worktree
    settled.worktree = { dirty: [" M a.txt", "?? b.txt"], commits: 0 };

    // When the server decides what to do with the settle
    const intents = decideSettle(settled);

    // Then the modified-worktree issue is raised against it
    expect(intents[0]).toMatchObject({
      kind: "raise",
      issue: "modified-worktree",
    });
  });

  test("an agent that stopped without a result tool call is nudged for one", () => {
    // Given a worker settled having called no result tool
    const settled = anAgent("WORK");
    settled.calls = [];

    // When the server decides what to do with the settle
    const intents = decideSettle(settled);

    // Then the missing-result issue is raised against it
    expect(intents).toEqual([
      { kind: "raise", issue: "missing-result", detail: "", vars: {} },
    ]);
  });

  test("an agent that ran out of context is nudged for a result", () => {
    // Given a worker whose turn ended because it ran out of context
    const settled = anAgent("WORK");
    settled.stopReason = "length";

    // When the server decides what to do with the settle
    const intents = decideSettle(settled);

    // Then the missing-result issue is raised against it, whatever it called
    expect(intents).toEqual([
      { kind: "raise", issue: "missing-result", detail: "", vars: {} },
    ]);
  });

  test("an agent that called blocked is raised as blocked with its message", () => {
    // Given a planner that called blocked instead of submit
    const settled = anAgent("PLAN");
    settled.calls = [{ tool: "blocked", args: { message: "the box is down" } }];

    // When the server decides what to do with the settle
    const intents = decideSettle(settled);

    // Then the blocked issue carries the agent's own message
    expect(intents).toEqual([
      {
        kind: "raise",
        issue: "blocked",
        detail: "the box is down",
        vars: {},
      },
    ]);
  });

  test("an agent caught repeating one command is raised as looping", () => {
    // Given a worker whose turn was cut short for repeating a command
    const settled = anAgent("WORK");
    settled.looping = "zig build";

    // When the server decides what to do with the settle
    const intents = decideSettle(settled);

    // Then the looping issue names the command and the limit it hit
    expect(intents).toEqual([
      {
        kind: "raise",
        issue: "looping",
        detail: "zig build",
        vars: { command: "zig build", limit: LOOP_LIMIT },
      },
    ]);
  });

  test("a provider error backs off instead of blaming the agent", () => {
    // Given a worker whose turn ended in a provider error
    const settled = anAgent("WORK");
    settled.stopReason = "error";

    // When the server decides what to do with the settle
    const intents = decideSettle(settled);

    // Then the server backs off rather than raising an issue
    expect(intents).toEqual([{ kind: "back-off" }]);
  });

  test("an aborted turn releases the slot without touching the graph", () => {
    // Given a worker whose turn was aborted
    const settled = anAgent("WORK");
    settled.stopReason = "aborted";

    // When the server decides what to do with the settle
    const intents = decideSettle(settled);

    // Then the agent is abandoned and nothing is submitted
    expect(intents).toEqual([{ kind: "abandon" }]);
  });

  test("a process that died before settling is abandoned", () => {
    // Given a worker whose process is no longer alive
    const settled = anAgent("WORK");
    settled.alive = false;

    // When the server decides what to do with the settle
    const intents = decideSettle(settled);

    // Then the agent is abandoned
    expect(intents).toEqual([{ kind: "abandon" }]);
  });

  test("a loop is decided before the result the agent managed to call", () => {
    // Given a worker that both looped and called submit
    const settled = anAgent("WORK");
    settled.looping = "zig build";

    // When the server decides what to do with the settle
    const intents = decideSettle(settled);

    // Then the loop is what it hears about
    expect(intents[0]).toMatchObject({ issue: "looping" });
  });
});
