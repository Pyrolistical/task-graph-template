import { describe, expect } from "bun:test";
import { testInTempDirs } from "../testing/temp-dirs.ts";
import fs from "node:fs";
import path from "node:path";
import {
  type ClaimState,
  type TransitionName,
  type ValidState,
  isAgentState,
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

describe("Feature: applying the state machine to the task directory", () => {
  testInTempDirs("the directory can walk a task into NEW", () => {
    // Given a task directory the machine walks a fresh task through
    // When the task is walked into NEW through the task directory
    const { dir, id } = build("NEW");

    // Then it is sitting in NEW
    expect(metaOf(dir, id).state).toBe("NEW");
  });

  testInTempDirs("the directory can walk a task into BLOCKED", () => {
    // Given a task directory the machine walks a fresh task through
    // When the task is walked into BLOCKED through the task directory
    const { dir, id } = build("BLOCKED");

    // Then it is sitting in BLOCKED
    expect(metaOf(dir, id).state).toBe("BLOCKED");
  });

  testInTempDirs("the directory can walk a task into HELD_DESIGN", () => {
    // Given a task directory the machine walks a fresh task through
    // When the task is walked into HELD_DESIGN through the task directory
    const { dir, id } = build("HELD_DESIGN");

    // Then it is sitting in HELD_DESIGN
    expect(metaOf(dir, id).state).toBe("HELD_DESIGN");
  });

  testInTempDirs("the directory can walk a task into HELD_PLAN", () => {
    // Given a task directory the machine walks a fresh task through
    // When the task is walked into HELD_PLAN through the task directory
    const { dir, id } = build("HELD_PLAN");

    // Then it is sitting in HELD_PLAN
    expect(metaOf(dir, id).state).toBe("HELD_PLAN");
  });

  testInTempDirs("the directory can walk a task into HELD_WORK", () => {
    // Given a task directory the machine walks a fresh task through
    // When the task is walked into HELD_WORK through the task directory
    const { dir, id } = build("HELD_WORK");

    // Then it is sitting in HELD_WORK
    expect(metaOf(dir, id).state).toBe("HELD_WORK");
  });

  testInTempDirs("the directory can walk a task into DESIGN", () => {
    // Given a task directory the machine walks a fresh task through
    // When the task is walked into DESIGN through the task directory
    const { dir, id } = build("DESIGN");

    // Then it is sitting in DESIGN
    expect(metaOf(dir, id).state).toBe("DESIGN");
  });

  testInTempDirs("the directory can walk a task into DESIGN_REVIEW", () => {
    // Given a task directory the machine walks a fresh task through
    // When the task is walked into DESIGN_REVIEW through the task directory
    const { dir, id } = build("DESIGN_REVIEW");

    // Then it is sitting in DESIGN_REVIEW
    expect(metaOf(dir, id).state).toBe("DESIGN_REVIEW");
  });

  testInTempDirs("the directory can walk a task into PLAN", () => {
    // Given a task directory the machine walks a fresh task through
    // When the task is walked into PLAN through the task directory
    const { dir, id } = build("PLAN");

    // Then it is sitting in PLAN
    expect(metaOf(dir, id).state).toBe("PLAN");
  });

  testInTempDirs("the directory can walk a task into PLAN_REVIEW", () => {
    // Given a task directory the machine walks a fresh task through
    // When the task is walked into PLAN_REVIEW through the task directory
    const { dir, id } = build("PLAN_REVIEW");

    // Then it is sitting in PLAN_REVIEW
    expect(metaOf(dir, id).state).toBe("PLAN_REVIEW");
  });

  testInTempDirs("the directory can walk a task into WORK", () => {
    // Given a task directory the machine walks a fresh task through
    // When the task is walked into WORK through the task directory
    const { dir, id } = build("WORK");

    // Then it is sitting in WORK
    expect(metaOf(dir, id).state).toBe("WORK");
  });

  testInTempDirs("the directory can walk a task into CHECK", () => {
    // Given a task directory the machine walks a fresh task through
    // When the task is walked into CHECK through the task directory
    const { dir, id } = build("CHECK");

    // Then it is sitting in CHECK
    expect(metaOf(dir, id).state).toBe("CHECK");
  });

  testInTempDirs("the directory can walk a task into WORK_REVIEW", () => {
    // Given a task directory the machine walks a fresh task through
    // When the task is walked into WORK_REVIEW through the task directory
    const { dir, id } = build("WORK_REVIEW");

    // Then it is sitting in WORK_REVIEW
    expect(metaOf(dir, id).state).toBe("WORK_REVIEW");
  });

  testInTempDirs("the directory can walk a task into MANAGER_REVIEW", () => {
    // Given a task directory the machine walks a fresh task through
    // When the task is walked into MANAGER_REVIEW through the task directory
    const { dir, id } = build("MANAGER_REVIEW");

    // Then it is sitting in MANAGER_REVIEW
    expect(metaOf(dir, id).state).toBe("MANAGER_REVIEW");
  });
  testInTempDirs(
    "a task in NEW that submits is written to the document as DESIGN",
    () => {
      // Given a task sitting in NEW
      const { dir, id } = build("NEW");

      // When a submit is applied through the task directory
      const result = run(dir, id, "submit");

      // Then the document on disk holds DESIGN, as the machine decided
      expect(readTaskFile(documentOf(dir, id, result)).meta.state).toBe(
        "DESIGN",
      );
    },
  );

  testInTempDirs(
    "a task in BLOCKED that submits is written to the document as DESIGN",
    () => {
      // Given a task sitting in BLOCKED with nothing left to wait on
      const dir = makeTasksDir();
      const id = writeTask(dir, { id: "000001", state: "BLOCKED" });

      // When a submit is applied through the task directory
      const result = run(dir, id, "submit");

      // Then the document on disk holds DESIGN, as the machine decided
      expect(readTaskFile(documentOf(dir, id, result)).meta.state).toBe(
        "DESIGN",
      );
    },
  );

  testInTempDirs(
    "a task in HELD_DESIGN that resumes is written to the document as DESIGN",
    () => {
      // Given a task sitting in HELD_DESIGN
      const { dir, id } = build("HELD_DESIGN");

      // When a resume is applied through the task directory
      const result = run(dir, id, "resume");

      // Then the document on disk holds DESIGN, as the machine decided
      expect(readTaskFile(documentOf(dir, id, result)).meta.state).toBe(
        "DESIGN",
      );
    },
  );

  testInTempDirs(
    "a task in HELD_DESIGN that aborts is written to the document as CLOSED",
    () => {
      // Given a task sitting in HELD_DESIGN
      const { dir, id } = build("HELD_DESIGN");

      // When an abort is applied through the task directory
      const result = run(dir, id, "abort");

      // Then the document on disk holds CLOSED, as the machine decided
      expect(readTaskFile(documentOf(dir, id, result)).meta.state).toBe(
        "CLOSED",
      );
    },
  );

  testInTempDirs(
    "a task in HELD_PLAN that resumes is written to the document as PLAN",
    () => {
      // Given a task sitting in HELD_PLAN
      const { dir, id } = build("HELD_PLAN");

      // When a resume is applied through the task directory
      const result = run(dir, id, "resume");

      // Then the document on disk holds PLAN, as the machine decided
      expect(readTaskFile(documentOf(dir, id, result)).meta.state).toBe("PLAN");
    },
  );

  testInTempDirs(
    "a task in HELD_PLAN that aborts is written to the document as CLOSED",
    () => {
      // Given a task sitting in HELD_PLAN
      const { dir, id } = build("HELD_PLAN");

      // When an abort is applied through the task directory
      const result = run(dir, id, "abort");

      // Then the document on disk holds CLOSED, as the machine decided
      expect(readTaskFile(documentOf(dir, id, result)).meta.state).toBe(
        "CLOSED",
      );
    },
  );

  testInTempDirs(
    "a task in HELD_WORK that resumes is written to the document as WORK",
    () => {
      // Given a task sitting in HELD_WORK
      const { dir, id } = build("HELD_WORK");

      // When a resume is applied through the task directory
      const result = run(dir, id, "resume");

      // Then the document on disk holds WORK, as the machine decided
      expect(readTaskFile(documentOf(dir, id, result)).meta.state).toBe("WORK");
    },
  );

  testInTempDirs(
    "a task in HELD_WORK that aborts is written to the document as CLOSED",
    () => {
      // Given a task sitting in HELD_WORK
      const { dir, id } = build("HELD_WORK");

      // When an abort is applied through the task directory
      const result = run(dir, id, "abort");

      // Then the document on disk holds CLOSED, as the machine decided
      expect(readTaskFile(documentOf(dir, id, result)).meta.state).toBe(
        "CLOSED",
      );
    },
  );

  testInTempDirs(
    "a task in DESIGN that submits is written to the document as DESIGN_REVIEW",
    () => {
      // Given a task sitting in DESIGN
      const { dir, id } = build("DESIGN");

      // When a submit is applied through the task directory
      const result = run(dir, id, "submit");

      // Then the document on disk holds DESIGN_REVIEW, as the machine decided
      expect(readTaskFile(documentOf(dir, id, result)).meta.state).toBe(
        "DESIGN_REVIEW",
      );
    },
  );

  testInTempDirs(
    "a task in DESIGN that holds is written to the document as HELD_DESIGN",
    () => {
      // Given a task sitting in DESIGN
      const { dir, id } = build("DESIGN");

      // When a hold is applied through the task directory
      const result = run(dir, id, "hold", "a reason");

      // Then the document on disk holds HELD_DESIGN, as the machine decided
      expect(readTaskFile(documentOf(dir, id, result)).meta.state).toBe(
        "HELD_DESIGN",
      );
    },
  );

  testInTempDirs(
    "a task in DESIGN_REVIEW that submits is written to the document as PLAN",
    () => {
      // Given a task sitting in DESIGN_REVIEW
      const { dir, id } = build("DESIGN_REVIEW");

      // When a submit is applied through the task directory
      const result = run(dir, id, "submit");

      // Then the document on disk holds PLAN, as the machine decided
      expect(readTaskFile(documentOf(dir, id, result)).meta.state).toBe("PLAN");
    },
  );

  testInTempDirs(
    "a task in DESIGN_REVIEW that sends feedback is written to the document as DESIGN",
    () => {
      // Given a task sitting in DESIGN_REVIEW
      const { dir, id } = build("DESIGN_REVIEW");

      // When feedback is applied through the task directory
      const result = run(dir, id, "feedback", "a finding");

      // Then the document on disk holds DESIGN, as the machine decided
      expect(readTaskFile(documentOf(dir, id, result)).meta.state).toBe(
        "DESIGN",
      );
    },
  );

  testInTempDirs(
    "a task in DESIGN_REVIEW that holds is written to the document as HELD_DESIGN",
    () => {
      // Given a task sitting in DESIGN_REVIEW
      const { dir, id } = build("DESIGN_REVIEW");

      // When a hold is applied through the task directory
      const result = run(dir, id, "hold", "a reason");

      // Then the document on disk holds HELD_DESIGN, as the machine decided
      expect(readTaskFile(documentOf(dir, id, result)).meta.state).toBe(
        "HELD_DESIGN",
      );
    },
  );

  testInTempDirs(
    "a task in PLAN that submits is written to the document as PLAN_REVIEW",
    () => {
      // Given a task sitting in PLAN
      const { dir, id } = build("PLAN");

      // When a submit is applied through the task directory
      const result = run(dir, id, "submit");

      // Then the document on disk holds PLAN_REVIEW, as the machine decided
      expect(readTaskFile(documentOf(dir, id, result)).meta.state).toBe(
        "PLAN_REVIEW",
      );
    },
  );

  testInTempDirs(
    "a task in PLAN that holds is written to the document as HELD_PLAN",
    () => {
      // Given a task sitting in PLAN
      const { dir, id } = build("PLAN");

      // When a hold is applied through the task directory
      const result = run(dir, id, "hold", "a reason");

      // Then the document on disk holds HELD_PLAN, as the machine decided
      expect(readTaskFile(documentOf(dir, id, result)).meta.state).toBe(
        "HELD_PLAN",
      );
    },
  );

  testInTempDirs(
    "a task in PLAN_REVIEW that submits is written to the document as WORK",
    () => {
      // Given a task sitting in PLAN_REVIEW
      const { dir, id } = build("PLAN_REVIEW");

      // When a submit is applied through the task directory
      const result = run(dir, id, "submit");

      // Then the document on disk holds WORK, as the machine decided
      expect(readTaskFile(documentOf(dir, id, result)).meta.state).toBe("WORK");
    },
  );

  testInTempDirs(
    "a task in PLAN_REVIEW that sends feedback is written to the document as PLAN",
    () => {
      // Given a task sitting in PLAN_REVIEW
      const { dir, id } = build("PLAN_REVIEW");

      // When feedback is applied through the task directory
      const result = run(dir, id, "feedback", "a finding");

      // Then the document on disk holds PLAN, as the machine decided
      expect(readTaskFile(documentOf(dir, id, result)).meta.state).toBe("PLAN");
    },
  );

  testInTempDirs(
    "a task in PLAN_REVIEW that holds is written to the document as HELD_PLAN",
    () => {
      // Given a task sitting in PLAN_REVIEW
      const { dir, id } = build("PLAN_REVIEW");

      // When a hold is applied through the task directory
      const result = run(dir, id, "hold", "a reason");

      // Then the document on disk holds HELD_PLAN, as the machine decided
      expect(readTaskFile(documentOf(dir, id, result)).meta.state).toBe(
        "HELD_PLAN",
      );
    },
  );

  testInTempDirs(
    "a task in WORK that submits is written to the document as CHECK",
    () => {
      // Given a task sitting in WORK
      const { dir, id } = build("WORK");

      // When a submit is applied through the task directory
      const result = run(dir, id, "submit");

      // Then the document on disk holds CHECK, as the machine decided
      expect(readTaskFile(documentOf(dir, id, result)).meta.state).toBe(
        "CHECK",
      );
    },
  );

  testInTempDirs(
    "a task in WORK that holds is written to the document as HELD_WORK",
    () => {
      // Given a task sitting in WORK
      const { dir, id } = build("WORK");

      // When a hold is applied through the task directory
      const result = run(dir, id, "hold", "a reason");

      // Then the document on disk holds HELD_WORK, as the machine decided
      expect(readTaskFile(documentOf(dir, id, result)).meta.state).toBe(
        "HELD_WORK",
      );
    },
  );

  testInTempDirs(
    "a task in CHECK that passes is written to the document as WORK_REVIEW",
    () => {
      // Given a task sitting in CHECK
      const { dir, id } = build("CHECK");

      // When a pass is applied through the task directory
      const result = run(dir, id, "pass");

      // Then the document on disk holds WORK_REVIEW, as the machine decided
      expect(readTaskFile(documentOf(dir, id, result)).meta.state).toBe(
        "WORK_REVIEW",
      );
    },
  );

  testInTempDirs(
    "a task in CHECK that fails is written to the document as WORK",
    () => {
      // Given a task sitting in CHECK
      const { dir, id } = build("CHECK");

      // When a fail is applied through the task directory
      const result = run(dir, id, "fail");

      // Then the document on disk holds WORK, as the machine decided
      expect(readTaskFile(documentOf(dir, id, result)).meta.state).toBe("WORK");
    },
  );

  testInTempDirs(
    "a task in CHECK that holds is written to the document as HELD_WORK",
    () => {
      // Given a task sitting in CHECK
      const { dir, id } = build("CHECK");

      // When a hold is applied through the task directory
      const result = run(dir, id, "hold", "a reason");

      // Then the document on disk holds HELD_WORK, as the machine decided
      expect(readTaskFile(documentOf(dir, id, result)).meta.state).toBe(
        "HELD_WORK",
      );
    },
  );

  testInTempDirs(
    "a task in WORK_REVIEW that submits is written to the document as MANAGER_REVIEW",
    () => {
      // Given a task sitting in WORK_REVIEW
      const { dir, id } = build("WORK_REVIEW");

      // When a submit is applied through the task directory
      const result = run(dir, id, "submit");

      // Then the document on disk holds MANAGER_REVIEW, as the machine decided
      expect(readTaskFile(documentOf(dir, id, result)).meta.state).toBe(
        "MANAGER_REVIEW",
      );
    },
  );

  testInTempDirs(
    "a task in WORK_REVIEW that sends feedback is written to the document as WORK",
    () => {
      // Given a task sitting in WORK_REVIEW
      const { dir, id } = build("WORK_REVIEW");

      // When feedback is applied through the task directory
      const result = run(dir, id, "feedback", "a finding");

      // Then the document on disk holds WORK, as the machine decided
      expect(readTaskFile(documentOf(dir, id, result)).meta.state).toBe("WORK");
    },
  );

  testInTempDirs(
    "a task in WORK_REVIEW that holds is written to the document as HELD_WORK",
    () => {
      // Given a task sitting in WORK_REVIEW
      const { dir, id } = build("WORK_REVIEW");

      // When a hold is applied through the task directory
      const result = run(dir, id, "hold", "a reason");

      // Then the document on disk holds HELD_WORK, as the machine decided
      expect(readTaskFile(documentOf(dir, id, result)).meta.state).toBe(
        "HELD_WORK",
      );
    },
  );

  testInTempDirs(
    "a task in MANAGER_REVIEW that sends feedback is written to the document as WORK",
    () => {
      // Given a task sitting in MANAGER_REVIEW
      const { dir, id } = build("MANAGER_REVIEW");

      // When feedback is applied through the task directory
      const result = run(dir, id, "feedback", "a finding");

      // Then the document on disk holds WORK, as the machine decided
      expect(readTaskFile(documentOf(dir, id, result)).meta.state).toBe("WORK");
    },
  );

  testInTempDirs(
    "a task in MANAGER_REVIEW that submits is written to the document as CLOSED",
    () => {
      // Given a task sitting in MANAGER_REVIEW
      const { dir, id } = build("MANAGER_REVIEW");

      // When a submit is applied through the task directory
      const result = run(dir, id, "submit");

      // Then the document on disk holds CLOSED, as the machine decided
      expect(readTaskFile(documentOf(dir, id, result)).meta.state).toBe(
        "CLOSED",
      );
    },
  );

  testInTempDirs(
    "a task in MANAGER_REVIEW that aborts is written to the document as CLOSED",
    () => {
      // Given a task sitting in MANAGER_REVIEW
      const { dir, id } = build("MANAGER_REVIEW");

      // When an abort is applied through the task directory
      const result = run(dir, id, "abort");

      // Then the document on disk holds CLOSED, as the machine decided
      expect(readTaskFile(documentOf(dir, id, result)).meta.state).toBe(
        "CLOSED",
      );
    },
  );
  testInTempDirs(
    "a task in NEW will not take a pass, and its document stays whole",
    () => {
      // Given a task sitting in NEW, and its document as it stands
      const { dir, id } = build("NEW");
      const filePath = path.join(dir, `${id}.md`);
      const before = fs.readFileSync(filePath, "utf-8");

      // When a pass is applied through the task directory
      const attempt = () => run(dir, id, "pass");

      // Then it is refused, and the document is byte for byte what it was
      expect(attempt).toThrow(/not valid from state/);
      expect(fs.readFileSync(filePath, "utf-8")).toBe(before);
    },
  );

  testInTempDirs(
    "a task in NEW will not take a fail, and its document stays whole",
    () => {
      // Given a task sitting in NEW, and its document as it stands
      const { dir, id } = build("NEW");
      const filePath = path.join(dir, `${id}.md`);
      const before = fs.readFileSync(filePath, "utf-8");

      // When a fail is applied through the task directory
      const attempt = () => run(dir, id, "fail");

      // Then it is refused, and the document is byte for byte what it was
      expect(attempt).toThrow(/not valid from state/);
      expect(fs.readFileSync(filePath, "utf-8")).toBe(before);
    },
  );

  testInTempDirs(
    "a task in NEW will not take a hold, and its document stays whole",
    () => {
      // Given a task sitting in NEW, and its document as it stands
      const { dir, id } = build("NEW");
      const filePath = path.join(dir, `${id}.md`);
      const before = fs.readFileSync(filePath, "utf-8");

      // When a hold is applied through the task directory
      const attempt = () => run(dir, id, "hold", "a reason");

      // Then it is refused, and the document is byte for byte what it was
      expect(attempt).toThrow(/not valid from state/);
      expect(fs.readFileSync(filePath, "utf-8")).toBe(before);
    },
  );

  testInTempDirs(
    "a task in NEW will not take a resume, and its document stays whole",
    () => {
      // Given a task sitting in NEW, and its document as it stands
      const { dir, id } = build("NEW");
      const filePath = path.join(dir, `${id}.md`);
      const before = fs.readFileSync(filePath, "utf-8");

      // When a resume is applied through the task directory
      const attempt = () => run(dir, id, "resume");

      // Then it is refused, and the document is byte for byte what it was
      expect(attempt).toThrow(/not valid from state/);
      expect(fs.readFileSync(filePath, "utf-8")).toBe(before);
    },
  );

  testInTempDirs(
    "a task in NEW will not take feedback, and its document stays whole",
    () => {
      // Given a task sitting in NEW, and its document as it stands
      const { dir, id } = build("NEW");
      const filePath = path.join(dir, `${id}.md`);
      const before = fs.readFileSync(filePath, "utf-8");

      // When feedback is applied through the task directory
      const attempt = () => run(dir, id, "feedback", "a finding");

      // Then it is refused, and the document is byte for byte what it was
      expect(attempt).toThrow(/not valid from state/);
      expect(fs.readFileSync(filePath, "utf-8")).toBe(before);
    },
  );

  testInTempDirs(
    "a task in NEW will not take an abort, and its document stays whole",
    () => {
      // Given a task sitting in NEW, and its document as it stands
      const { dir, id } = build("NEW");
      const filePath = path.join(dir, `${id}.md`);
      const before = fs.readFileSync(filePath, "utf-8");

      // When an abort is applied through the task directory
      const attempt = () => run(dir, id, "abort");

      // Then it is refused, and the document is byte for byte what it was
      expect(attempt).toThrow(/not valid from state/);
      expect(fs.readFileSync(filePath, "utf-8")).toBe(before);
    },
  );

  testInTempDirs(
    "a task in BLOCKED will not take a pass, and its document stays whole",
    () => {
      // Given a task sitting in BLOCKED, and its document as it stands
      const { dir, id } = build("BLOCKED");
      const filePath = path.join(dir, `${id}.md`);
      const before = fs.readFileSync(filePath, "utf-8");

      // When a pass is applied through the task directory
      const attempt = () => run(dir, id, "pass");

      // Then it is refused, and the document is byte for byte what it was
      expect(attempt).toThrow(/not valid from state/);
      expect(fs.readFileSync(filePath, "utf-8")).toBe(before);
    },
  );

  testInTempDirs(
    "a task in BLOCKED will not take a fail, and its document stays whole",
    () => {
      // Given a task sitting in BLOCKED, and its document as it stands
      const { dir, id } = build("BLOCKED");
      const filePath = path.join(dir, `${id}.md`);
      const before = fs.readFileSync(filePath, "utf-8");

      // When a fail is applied through the task directory
      const attempt = () => run(dir, id, "fail");

      // Then it is refused, and the document is byte for byte what it was
      expect(attempt).toThrow(/not valid from state/);
      expect(fs.readFileSync(filePath, "utf-8")).toBe(before);
    },
  );

  testInTempDirs(
    "a task in BLOCKED will not take a hold, and its document stays whole",
    () => {
      // Given a task sitting in BLOCKED, and its document as it stands
      const { dir, id } = build("BLOCKED");
      const filePath = path.join(dir, `${id}.md`);
      const before = fs.readFileSync(filePath, "utf-8");

      // When a hold is applied through the task directory
      const attempt = () => run(dir, id, "hold", "a reason");

      // Then it is refused, and the document is byte for byte what it was
      expect(attempt).toThrow(/not valid from state/);
      expect(fs.readFileSync(filePath, "utf-8")).toBe(before);
    },
  );

  testInTempDirs(
    "a task in BLOCKED will not take a resume, and its document stays whole",
    () => {
      // Given a task sitting in BLOCKED, and its document as it stands
      const { dir, id } = build("BLOCKED");
      const filePath = path.join(dir, `${id}.md`);
      const before = fs.readFileSync(filePath, "utf-8");

      // When a resume is applied through the task directory
      const attempt = () => run(dir, id, "resume");

      // Then it is refused, and the document is byte for byte what it was
      expect(attempt).toThrow(/not valid from state/);
      expect(fs.readFileSync(filePath, "utf-8")).toBe(before);
    },
  );

  testInTempDirs(
    "a task in BLOCKED will not take feedback, and its document stays whole",
    () => {
      // Given a task sitting in BLOCKED, and its document as it stands
      const { dir, id } = build("BLOCKED");
      const filePath = path.join(dir, `${id}.md`);
      const before = fs.readFileSync(filePath, "utf-8");

      // When feedback is applied through the task directory
      const attempt = () => run(dir, id, "feedback", "a finding");

      // Then it is refused, and the document is byte for byte what it was
      expect(attempt).toThrow(/not valid from state/);
      expect(fs.readFileSync(filePath, "utf-8")).toBe(before);
    },
  );

  testInTempDirs(
    "a task in BLOCKED will not take an abort, and its document stays whole",
    () => {
      // Given a task sitting in BLOCKED, and its document as it stands
      const { dir, id } = build("BLOCKED");
      const filePath = path.join(dir, `${id}.md`);
      const before = fs.readFileSync(filePath, "utf-8");

      // When an abort is applied through the task directory
      const attempt = () => run(dir, id, "abort");

      // Then it is refused, and the document is byte for byte what it was
      expect(attempt).toThrow(/not valid from state/);
      expect(fs.readFileSync(filePath, "utf-8")).toBe(before);
    },
  );

  testInTempDirs(
    "a task in HELD_DESIGN will not take a submit, and its document stays whole",
    () => {
      // Given a task sitting in HELD_DESIGN, and its document as it stands
      const { dir, id } = build("HELD_DESIGN");
      const filePath = path.join(dir, `${id}.md`);
      const before = fs.readFileSync(filePath, "utf-8");

      // When a submit is applied through the task directory
      const attempt = () => run(dir, id, "submit");

      // Then it is refused, and the document is byte for byte what it was
      expect(attempt).toThrow(/not valid from state/);
      expect(fs.readFileSync(filePath, "utf-8")).toBe(before);
    },
  );

  testInTempDirs(
    "a task in HELD_DESIGN will not take a pass, and its document stays whole",
    () => {
      // Given a task sitting in HELD_DESIGN, and its document as it stands
      const { dir, id } = build("HELD_DESIGN");
      const filePath = path.join(dir, `${id}.md`);
      const before = fs.readFileSync(filePath, "utf-8");

      // When a pass is applied through the task directory
      const attempt = () => run(dir, id, "pass");

      // Then it is refused, and the document is byte for byte what it was
      expect(attempt).toThrow(/not valid from state/);
      expect(fs.readFileSync(filePath, "utf-8")).toBe(before);
    },
  );

  testInTempDirs(
    "a task in HELD_DESIGN will not take a fail, and its document stays whole",
    () => {
      // Given a task sitting in HELD_DESIGN, and its document as it stands
      const { dir, id } = build("HELD_DESIGN");
      const filePath = path.join(dir, `${id}.md`);
      const before = fs.readFileSync(filePath, "utf-8");

      // When a fail is applied through the task directory
      const attempt = () => run(dir, id, "fail");

      // Then it is refused, and the document is byte for byte what it was
      expect(attempt).toThrow(/not valid from state/);
      expect(fs.readFileSync(filePath, "utf-8")).toBe(before);
    },
  );

  testInTempDirs(
    "a task in HELD_DESIGN will not take a hold, and its document stays whole",
    () => {
      // Given a task sitting in HELD_DESIGN, and its document as it stands
      const { dir, id } = build("HELD_DESIGN");
      const filePath = path.join(dir, `${id}.md`);
      const before = fs.readFileSync(filePath, "utf-8");

      // When a hold is applied through the task directory
      const attempt = () => run(dir, id, "hold", "a reason");

      // Then it is refused, and the document is byte for byte what it was
      expect(attempt).toThrow(/not valid from state/);
      expect(fs.readFileSync(filePath, "utf-8")).toBe(before);
    },
  );

  testInTempDirs(
    "a task in HELD_DESIGN will not take feedback, and its document stays whole",
    () => {
      // Given a task sitting in HELD_DESIGN, and its document as it stands
      const { dir, id } = build("HELD_DESIGN");
      const filePath = path.join(dir, `${id}.md`);
      const before = fs.readFileSync(filePath, "utf-8");

      // When feedback is applied through the task directory
      const attempt = () => run(dir, id, "feedback", "a finding");

      // Then it is refused, and the document is byte for byte what it was
      expect(attempt).toThrow(/not valid from state/);
      expect(fs.readFileSync(filePath, "utf-8")).toBe(before);
    },
  );

  testInTempDirs(
    "a task in HELD_PLAN will not take a submit, and its document stays whole",
    () => {
      // Given a task sitting in HELD_PLAN, and its document as it stands
      const { dir, id } = build("HELD_PLAN");
      const filePath = path.join(dir, `${id}.md`);
      const before = fs.readFileSync(filePath, "utf-8");

      // When a submit is applied through the task directory
      const attempt = () => run(dir, id, "submit");

      // Then it is refused, and the document is byte for byte what it was
      expect(attempt).toThrow(/not valid from state/);
      expect(fs.readFileSync(filePath, "utf-8")).toBe(before);
    },
  );

  testInTempDirs(
    "a task in HELD_PLAN will not take a pass, and its document stays whole",
    () => {
      // Given a task sitting in HELD_PLAN, and its document as it stands
      const { dir, id } = build("HELD_PLAN");
      const filePath = path.join(dir, `${id}.md`);
      const before = fs.readFileSync(filePath, "utf-8");

      // When a pass is applied through the task directory
      const attempt = () => run(dir, id, "pass");

      // Then it is refused, and the document is byte for byte what it was
      expect(attempt).toThrow(/not valid from state/);
      expect(fs.readFileSync(filePath, "utf-8")).toBe(before);
    },
  );

  testInTempDirs(
    "a task in HELD_PLAN will not take a fail, and its document stays whole",
    () => {
      // Given a task sitting in HELD_PLAN, and its document as it stands
      const { dir, id } = build("HELD_PLAN");
      const filePath = path.join(dir, `${id}.md`);
      const before = fs.readFileSync(filePath, "utf-8");

      // When a fail is applied through the task directory
      const attempt = () => run(dir, id, "fail");

      // Then it is refused, and the document is byte for byte what it was
      expect(attempt).toThrow(/not valid from state/);
      expect(fs.readFileSync(filePath, "utf-8")).toBe(before);
    },
  );

  testInTempDirs(
    "a task in HELD_PLAN will not take a hold, and its document stays whole",
    () => {
      // Given a task sitting in HELD_PLAN, and its document as it stands
      const { dir, id } = build("HELD_PLAN");
      const filePath = path.join(dir, `${id}.md`);
      const before = fs.readFileSync(filePath, "utf-8");

      // When a hold is applied through the task directory
      const attempt = () => run(dir, id, "hold", "a reason");

      // Then it is refused, and the document is byte for byte what it was
      expect(attempt).toThrow(/not valid from state/);
      expect(fs.readFileSync(filePath, "utf-8")).toBe(before);
    },
  );

  testInTempDirs(
    "a task in HELD_PLAN will not take feedback, and its document stays whole",
    () => {
      // Given a task sitting in HELD_PLAN, and its document as it stands
      const { dir, id } = build("HELD_PLAN");
      const filePath = path.join(dir, `${id}.md`);
      const before = fs.readFileSync(filePath, "utf-8");

      // When feedback is applied through the task directory
      const attempt = () => run(dir, id, "feedback", "a finding");

      // Then it is refused, and the document is byte for byte what it was
      expect(attempt).toThrow(/not valid from state/);
      expect(fs.readFileSync(filePath, "utf-8")).toBe(before);
    },
  );

  testInTempDirs(
    "a task in HELD_WORK will not take a submit, and its document stays whole",
    () => {
      // Given a task sitting in HELD_WORK, and its document as it stands
      const { dir, id } = build("HELD_WORK");
      const filePath = path.join(dir, `${id}.md`);
      const before = fs.readFileSync(filePath, "utf-8");

      // When a submit is applied through the task directory
      const attempt = () => run(dir, id, "submit");

      // Then it is refused, and the document is byte for byte what it was
      expect(attempt).toThrow(/not valid from state/);
      expect(fs.readFileSync(filePath, "utf-8")).toBe(before);
    },
  );

  testInTempDirs(
    "a task in HELD_WORK will not take a pass, and its document stays whole",
    () => {
      // Given a task sitting in HELD_WORK, and its document as it stands
      const { dir, id } = build("HELD_WORK");
      const filePath = path.join(dir, `${id}.md`);
      const before = fs.readFileSync(filePath, "utf-8");

      // When a pass is applied through the task directory
      const attempt = () => run(dir, id, "pass");

      // Then it is refused, and the document is byte for byte what it was
      expect(attempt).toThrow(/not valid from state/);
      expect(fs.readFileSync(filePath, "utf-8")).toBe(before);
    },
  );

  testInTempDirs(
    "a task in HELD_WORK will not take a fail, and its document stays whole",
    () => {
      // Given a task sitting in HELD_WORK, and its document as it stands
      const { dir, id } = build("HELD_WORK");
      const filePath = path.join(dir, `${id}.md`);
      const before = fs.readFileSync(filePath, "utf-8");

      // When a fail is applied through the task directory
      const attempt = () => run(dir, id, "fail");

      // Then it is refused, and the document is byte for byte what it was
      expect(attempt).toThrow(/not valid from state/);
      expect(fs.readFileSync(filePath, "utf-8")).toBe(before);
    },
  );

  testInTempDirs(
    "a task in HELD_WORK will not take a hold, and its document stays whole",
    () => {
      // Given a task sitting in HELD_WORK, and its document as it stands
      const { dir, id } = build("HELD_WORK");
      const filePath = path.join(dir, `${id}.md`);
      const before = fs.readFileSync(filePath, "utf-8");

      // When a hold is applied through the task directory
      const attempt = () => run(dir, id, "hold", "a reason");

      // Then it is refused, and the document is byte for byte what it was
      expect(attempt).toThrow(/not valid from state/);
      expect(fs.readFileSync(filePath, "utf-8")).toBe(before);
    },
  );

  testInTempDirs(
    "a task in HELD_WORK will not take feedback, and its document stays whole",
    () => {
      // Given a task sitting in HELD_WORK, and its document as it stands
      const { dir, id } = build("HELD_WORK");
      const filePath = path.join(dir, `${id}.md`);
      const before = fs.readFileSync(filePath, "utf-8");

      // When feedback is applied through the task directory
      const attempt = () => run(dir, id, "feedback", "a finding");

      // Then it is refused, and the document is byte for byte what it was
      expect(attempt).toThrow(/not valid from state/);
      expect(fs.readFileSync(filePath, "utf-8")).toBe(before);
    },
  );

  testInTempDirs(
    "a task in DESIGN will not take a pass, and its document stays whole",
    () => {
      // Given a task sitting in DESIGN, and its document as it stands
      const { dir, id } = build("DESIGN");
      const filePath = path.join(dir, `${id}.md`);
      const before = fs.readFileSync(filePath, "utf-8");

      // When a pass is applied through the task directory
      const attempt = () => run(dir, id, "pass");

      // Then it is refused, and the document is byte for byte what it was
      expect(attempt).toThrow(/not valid from state/);
      expect(fs.readFileSync(filePath, "utf-8")).toBe(before);
    },
  );

  testInTempDirs(
    "a task in DESIGN will not take a fail, and its document stays whole",
    () => {
      // Given a task sitting in DESIGN, and its document as it stands
      const { dir, id } = build("DESIGN");
      const filePath = path.join(dir, `${id}.md`);
      const before = fs.readFileSync(filePath, "utf-8");

      // When a fail is applied through the task directory
      const attempt = () => run(dir, id, "fail");

      // Then it is refused, and the document is byte for byte what it was
      expect(attempt).toThrow(/not valid from state/);
      expect(fs.readFileSync(filePath, "utf-8")).toBe(before);
    },
  );

  testInTempDirs(
    "a task in DESIGN will not take a resume, and its document stays whole",
    () => {
      // Given a task sitting in DESIGN, and its document as it stands
      const { dir, id } = build("DESIGN");
      const filePath = path.join(dir, `${id}.md`);
      const before = fs.readFileSync(filePath, "utf-8");

      // When a resume is applied through the task directory
      const attempt = () => run(dir, id, "resume");

      // Then it is refused, and the document is byte for byte what it was
      expect(attempt).toThrow(/not valid from state/);
      expect(fs.readFileSync(filePath, "utf-8")).toBe(before);
    },
  );

  testInTempDirs(
    "a task in DESIGN will not take feedback, and its document stays whole",
    () => {
      // Given a task sitting in DESIGN, and its document as it stands
      const { dir, id } = build("DESIGN");
      const filePath = path.join(dir, `${id}.md`);
      const before = fs.readFileSync(filePath, "utf-8");

      // When feedback is applied through the task directory
      const attempt = () => run(dir, id, "feedback", "a finding");

      // Then it is refused, and the document is byte for byte what it was
      expect(attempt).toThrow(/not valid from state/);
      expect(fs.readFileSync(filePath, "utf-8")).toBe(before);
    },
  );

  testInTempDirs(
    "a task in DESIGN will not take an abort, and its document stays whole",
    () => {
      // Given a task sitting in DESIGN, and its document as it stands
      const { dir, id } = build("DESIGN");
      const filePath = path.join(dir, `${id}.md`);
      const before = fs.readFileSync(filePath, "utf-8");

      // When an abort is applied through the task directory
      const attempt = () => run(dir, id, "abort");

      // Then it is refused, and the document is byte for byte what it was
      expect(attempt).toThrow(/not valid from state/);
      expect(fs.readFileSync(filePath, "utf-8")).toBe(before);
    },
  );

  testInTempDirs(
    "a task in DESIGN_REVIEW will not take a pass, and its document stays whole",
    () => {
      // Given a task sitting in DESIGN_REVIEW, and its document as it stands
      const { dir, id } = build("DESIGN_REVIEW");
      const filePath = path.join(dir, `${id}.md`);
      const before = fs.readFileSync(filePath, "utf-8");

      // When a pass is applied through the task directory
      const attempt = () => run(dir, id, "pass");

      // Then it is refused, and the document is byte for byte what it was
      expect(attempt).toThrow(/not valid from state/);
      expect(fs.readFileSync(filePath, "utf-8")).toBe(before);
    },
  );

  testInTempDirs(
    "a task in DESIGN_REVIEW will not take a fail, and its document stays whole",
    () => {
      // Given a task sitting in DESIGN_REVIEW, and its document as it stands
      const { dir, id } = build("DESIGN_REVIEW");
      const filePath = path.join(dir, `${id}.md`);
      const before = fs.readFileSync(filePath, "utf-8");

      // When a fail is applied through the task directory
      const attempt = () => run(dir, id, "fail");

      // Then it is refused, and the document is byte for byte what it was
      expect(attempt).toThrow(/not valid from state/);
      expect(fs.readFileSync(filePath, "utf-8")).toBe(before);
    },
  );

  testInTempDirs(
    "a task in DESIGN_REVIEW will not take a resume, and its document stays whole",
    () => {
      // Given a task sitting in DESIGN_REVIEW, and its document as it stands
      const { dir, id } = build("DESIGN_REVIEW");
      const filePath = path.join(dir, `${id}.md`);
      const before = fs.readFileSync(filePath, "utf-8");

      // When a resume is applied through the task directory
      const attempt = () => run(dir, id, "resume");

      // Then it is refused, and the document is byte for byte what it was
      expect(attempt).toThrow(/not valid from state/);
      expect(fs.readFileSync(filePath, "utf-8")).toBe(before);
    },
  );

  testInTempDirs(
    "a task in DESIGN_REVIEW will not take an abort, and its document stays whole",
    () => {
      // Given a task sitting in DESIGN_REVIEW, and its document as it stands
      const { dir, id } = build("DESIGN_REVIEW");
      const filePath = path.join(dir, `${id}.md`);
      const before = fs.readFileSync(filePath, "utf-8");

      // When an abort is applied through the task directory
      const attempt = () => run(dir, id, "abort");

      // Then it is refused, and the document is byte for byte what it was
      expect(attempt).toThrow(/not valid from state/);
      expect(fs.readFileSync(filePath, "utf-8")).toBe(before);
    },
  );

  testInTempDirs(
    "a task in PLAN will not take a pass, and its document stays whole",
    () => {
      // Given a task sitting in PLAN, and its document as it stands
      const { dir, id } = build("PLAN");
      const filePath = path.join(dir, `${id}.md`);
      const before = fs.readFileSync(filePath, "utf-8");

      // When a pass is applied through the task directory
      const attempt = () => run(dir, id, "pass");

      // Then it is refused, and the document is byte for byte what it was
      expect(attempt).toThrow(/not valid from state/);
      expect(fs.readFileSync(filePath, "utf-8")).toBe(before);
    },
  );

  testInTempDirs(
    "a task in PLAN will not take a fail, and its document stays whole",
    () => {
      // Given a task sitting in PLAN, and its document as it stands
      const { dir, id } = build("PLAN");
      const filePath = path.join(dir, `${id}.md`);
      const before = fs.readFileSync(filePath, "utf-8");

      // When a fail is applied through the task directory
      const attempt = () => run(dir, id, "fail");

      // Then it is refused, and the document is byte for byte what it was
      expect(attempt).toThrow(/not valid from state/);
      expect(fs.readFileSync(filePath, "utf-8")).toBe(before);
    },
  );

  testInTempDirs(
    "a task in PLAN will not take a resume, and its document stays whole",
    () => {
      // Given a task sitting in PLAN, and its document as it stands
      const { dir, id } = build("PLAN");
      const filePath = path.join(dir, `${id}.md`);
      const before = fs.readFileSync(filePath, "utf-8");

      // When a resume is applied through the task directory
      const attempt = () => run(dir, id, "resume");

      // Then it is refused, and the document is byte for byte what it was
      expect(attempt).toThrow(/not valid from state/);
      expect(fs.readFileSync(filePath, "utf-8")).toBe(before);
    },
  );

  testInTempDirs(
    "a task in PLAN will not take feedback, and its document stays whole",
    () => {
      // Given a task sitting in PLAN, and its document as it stands
      const { dir, id } = build("PLAN");
      const filePath = path.join(dir, `${id}.md`);
      const before = fs.readFileSync(filePath, "utf-8");

      // When feedback is applied through the task directory
      const attempt = () => run(dir, id, "feedback", "a finding");

      // Then it is refused, and the document is byte for byte what it was
      expect(attempt).toThrow(/not valid from state/);
      expect(fs.readFileSync(filePath, "utf-8")).toBe(before);
    },
  );

  testInTempDirs(
    "a task in PLAN will not take an abort, and its document stays whole",
    () => {
      // Given a task sitting in PLAN, and its document as it stands
      const { dir, id } = build("PLAN");
      const filePath = path.join(dir, `${id}.md`);
      const before = fs.readFileSync(filePath, "utf-8");

      // When an abort is applied through the task directory
      const attempt = () => run(dir, id, "abort");

      // Then it is refused, and the document is byte for byte what it was
      expect(attempt).toThrow(/not valid from state/);
      expect(fs.readFileSync(filePath, "utf-8")).toBe(before);
    },
  );

  testInTempDirs(
    "a task in PLAN_REVIEW will not take a pass, and its document stays whole",
    () => {
      // Given a task sitting in PLAN_REVIEW, and its document as it stands
      const { dir, id } = build("PLAN_REVIEW");
      const filePath = path.join(dir, `${id}.md`);
      const before = fs.readFileSync(filePath, "utf-8");

      // When a pass is applied through the task directory
      const attempt = () => run(dir, id, "pass");

      // Then it is refused, and the document is byte for byte what it was
      expect(attempt).toThrow(/not valid from state/);
      expect(fs.readFileSync(filePath, "utf-8")).toBe(before);
    },
  );

  testInTempDirs(
    "a task in PLAN_REVIEW will not take a fail, and its document stays whole",
    () => {
      // Given a task sitting in PLAN_REVIEW, and its document as it stands
      const { dir, id } = build("PLAN_REVIEW");
      const filePath = path.join(dir, `${id}.md`);
      const before = fs.readFileSync(filePath, "utf-8");

      // When a fail is applied through the task directory
      const attempt = () => run(dir, id, "fail");

      // Then it is refused, and the document is byte for byte what it was
      expect(attempt).toThrow(/not valid from state/);
      expect(fs.readFileSync(filePath, "utf-8")).toBe(before);
    },
  );

  testInTempDirs(
    "a task in PLAN_REVIEW will not take a resume, and its document stays whole",
    () => {
      // Given a task sitting in PLAN_REVIEW, and its document as it stands
      const { dir, id } = build("PLAN_REVIEW");
      const filePath = path.join(dir, `${id}.md`);
      const before = fs.readFileSync(filePath, "utf-8");

      // When a resume is applied through the task directory
      const attempt = () => run(dir, id, "resume");

      // Then it is refused, and the document is byte for byte what it was
      expect(attempt).toThrow(/not valid from state/);
      expect(fs.readFileSync(filePath, "utf-8")).toBe(before);
    },
  );

  testInTempDirs(
    "a task in PLAN_REVIEW will not take an abort, and its document stays whole",
    () => {
      // Given a task sitting in PLAN_REVIEW, and its document as it stands
      const { dir, id } = build("PLAN_REVIEW");
      const filePath = path.join(dir, `${id}.md`);
      const before = fs.readFileSync(filePath, "utf-8");

      // When an abort is applied through the task directory
      const attempt = () => run(dir, id, "abort");

      // Then it is refused, and the document is byte for byte what it was
      expect(attempt).toThrow(/not valid from state/);
      expect(fs.readFileSync(filePath, "utf-8")).toBe(before);
    },
  );

  testInTempDirs(
    "a task in WORK will not take a pass, and its document stays whole",
    () => {
      // Given a task sitting in WORK, and its document as it stands
      const { dir, id } = build("WORK");
      const filePath = path.join(dir, `${id}.md`);
      const before = fs.readFileSync(filePath, "utf-8");

      // When a pass is applied through the task directory
      const attempt = () => run(dir, id, "pass");

      // Then it is refused, and the document is byte for byte what it was
      expect(attempt).toThrow(/not valid from state/);
      expect(fs.readFileSync(filePath, "utf-8")).toBe(before);
    },
  );

  testInTempDirs(
    "a task in WORK will not take a fail, and its document stays whole",
    () => {
      // Given a task sitting in WORK, and its document as it stands
      const { dir, id } = build("WORK");
      const filePath = path.join(dir, `${id}.md`);
      const before = fs.readFileSync(filePath, "utf-8");

      // When a fail is applied through the task directory
      const attempt = () => run(dir, id, "fail");

      // Then it is refused, and the document is byte for byte what it was
      expect(attempt).toThrow(/not valid from state/);
      expect(fs.readFileSync(filePath, "utf-8")).toBe(before);
    },
  );

  testInTempDirs(
    "a task in WORK will not take a resume, and its document stays whole",
    () => {
      // Given a task sitting in WORK, and its document as it stands
      const { dir, id } = build("WORK");
      const filePath = path.join(dir, `${id}.md`);
      const before = fs.readFileSync(filePath, "utf-8");

      // When a resume is applied through the task directory
      const attempt = () => run(dir, id, "resume");

      // Then it is refused, and the document is byte for byte what it was
      expect(attempt).toThrow(/not valid from state/);
      expect(fs.readFileSync(filePath, "utf-8")).toBe(before);
    },
  );

  testInTempDirs(
    "a task in WORK will not take feedback, and its document stays whole",
    () => {
      // Given a task sitting in WORK, and its document as it stands
      const { dir, id } = build("WORK");
      const filePath = path.join(dir, `${id}.md`);
      const before = fs.readFileSync(filePath, "utf-8");

      // When feedback is applied through the task directory
      const attempt = () => run(dir, id, "feedback", "a finding");

      // Then it is refused, and the document is byte for byte what it was
      expect(attempt).toThrow(/not valid from state/);
      expect(fs.readFileSync(filePath, "utf-8")).toBe(before);
    },
  );

  testInTempDirs(
    "a task in WORK will not take an abort, and its document stays whole",
    () => {
      // Given a task sitting in WORK, and its document as it stands
      const { dir, id } = build("WORK");
      const filePath = path.join(dir, `${id}.md`);
      const before = fs.readFileSync(filePath, "utf-8");

      // When an abort is applied through the task directory
      const attempt = () => run(dir, id, "abort");

      // Then it is refused, and the document is byte for byte what it was
      expect(attempt).toThrow(/not valid from state/);
      expect(fs.readFileSync(filePath, "utf-8")).toBe(before);
    },
  );

  testInTempDirs(
    "a task in CHECK will not take a submit, and its document stays whole",
    () => {
      // Given a task sitting in CHECK, and its document as it stands
      const { dir, id } = build("CHECK");
      const filePath = path.join(dir, `${id}.md`);
      const before = fs.readFileSync(filePath, "utf-8");

      // When a submit is applied through the task directory
      const attempt = () => run(dir, id, "submit");

      // Then it is refused, and the document is byte for byte what it was
      expect(attempt).toThrow(/not valid from state/);
      expect(fs.readFileSync(filePath, "utf-8")).toBe(before);
    },
  );

  testInTempDirs(
    "a task in CHECK will not take a resume, and its document stays whole",
    () => {
      // Given a task sitting in CHECK, and its document as it stands
      const { dir, id } = build("CHECK");
      const filePath = path.join(dir, `${id}.md`);
      const before = fs.readFileSync(filePath, "utf-8");

      // When a resume is applied through the task directory
      const attempt = () => run(dir, id, "resume");

      // Then it is refused, and the document is byte for byte what it was
      expect(attempt).toThrow(/not valid from state/);
      expect(fs.readFileSync(filePath, "utf-8")).toBe(before);
    },
  );

  testInTempDirs(
    "a task in CHECK will not take feedback, and its document stays whole",
    () => {
      // Given a task sitting in CHECK, and its document as it stands
      const { dir, id } = build("CHECK");
      const filePath = path.join(dir, `${id}.md`);
      const before = fs.readFileSync(filePath, "utf-8");

      // When feedback is applied through the task directory
      const attempt = () => run(dir, id, "feedback", "a finding");

      // Then it is refused, and the document is byte for byte what it was
      expect(attempt).toThrow(/not valid from state/);
      expect(fs.readFileSync(filePath, "utf-8")).toBe(before);
    },
  );

  testInTempDirs(
    "a task in CHECK will not take an abort, and its document stays whole",
    () => {
      // Given a task sitting in CHECK, and its document as it stands
      const { dir, id } = build("CHECK");
      const filePath = path.join(dir, `${id}.md`);
      const before = fs.readFileSync(filePath, "utf-8");

      // When an abort is applied through the task directory
      const attempt = () => run(dir, id, "abort");

      // Then it is refused, and the document is byte for byte what it was
      expect(attempt).toThrow(/not valid from state/);
      expect(fs.readFileSync(filePath, "utf-8")).toBe(before);
    },
  );

  testInTempDirs(
    "a task in WORK_REVIEW will not take a pass, and its document stays whole",
    () => {
      // Given a task sitting in WORK_REVIEW, and its document as it stands
      const { dir, id } = build("WORK_REVIEW");
      const filePath = path.join(dir, `${id}.md`);
      const before = fs.readFileSync(filePath, "utf-8");

      // When a pass is applied through the task directory
      const attempt = () => run(dir, id, "pass");

      // Then it is refused, and the document is byte for byte what it was
      expect(attempt).toThrow(/not valid from state/);
      expect(fs.readFileSync(filePath, "utf-8")).toBe(before);
    },
  );

  testInTempDirs(
    "a task in WORK_REVIEW will not take a fail, and its document stays whole",
    () => {
      // Given a task sitting in WORK_REVIEW, and its document as it stands
      const { dir, id } = build("WORK_REVIEW");
      const filePath = path.join(dir, `${id}.md`);
      const before = fs.readFileSync(filePath, "utf-8");

      // When a fail is applied through the task directory
      const attempt = () => run(dir, id, "fail");

      // Then it is refused, and the document is byte for byte what it was
      expect(attempt).toThrow(/not valid from state/);
      expect(fs.readFileSync(filePath, "utf-8")).toBe(before);
    },
  );

  testInTempDirs(
    "a task in WORK_REVIEW will not take a resume, and its document stays whole",
    () => {
      // Given a task sitting in WORK_REVIEW, and its document as it stands
      const { dir, id } = build("WORK_REVIEW");
      const filePath = path.join(dir, `${id}.md`);
      const before = fs.readFileSync(filePath, "utf-8");

      // When a resume is applied through the task directory
      const attempt = () => run(dir, id, "resume");

      // Then it is refused, and the document is byte for byte what it was
      expect(attempt).toThrow(/not valid from state/);
      expect(fs.readFileSync(filePath, "utf-8")).toBe(before);
    },
  );

  testInTempDirs(
    "a task in WORK_REVIEW will not take an abort, and its document stays whole",
    () => {
      // Given a task sitting in WORK_REVIEW, and its document as it stands
      const { dir, id } = build("WORK_REVIEW");
      const filePath = path.join(dir, `${id}.md`);
      const before = fs.readFileSync(filePath, "utf-8");

      // When an abort is applied through the task directory
      const attempt = () => run(dir, id, "abort");

      // Then it is refused, and the document is byte for byte what it was
      expect(attempt).toThrow(/not valid from state/);
      expect(fs.readFileSync(filePath, "utf-8")).toBe(before);
    },
  );

  testInTempDirs(
    "a task in MANAGER_REVIEW will not take a pass, and its document stays whole",
    () => {
      // Given a task sitting in MANAGER_REVIEW, and its document as it stands
      const { dir, id } = build("MANAGER_REVIEW");
      const filePath = path.join(dir, `${id}.md`);
      const before = fs.readFileSync(filePath, "utf-8");

      // When a pass is applied through the task directory
      const attempt = () => run(dir, id, "pass");

      // Then it is refused, and the document is byte for byte what it was
      expect(attempt).toThrow(/not valid from state/);
      expect(fs.readFileSync(filePath, "utf-8")).toBe(before);
    },
  );

  testInTempDirs(
    "a task in MANAGER_REVIEW will not take a fail, and its document stays whole",
    () => {
      // Given a task sitting in MANAGER_REVIEW, and its document as it stands
      const { dir, id } = build("MANAGER_REVIEW");
      const filePath = path.join(dir, `${id}.md`);
      const before = fs.readFileSync(filePath, "utf-8");

      // When a fail is applied through the task directory
      const attempt = () => run(dir, id, "fail");

      // Then it is refused, and the document is byte for byte what it was
      expect(attempt).toThrow(/not valid from state/);
      expect(fs.readFileSync(filePath, "utf-8")).toBe(before);
    },
  );

  testInTempDirs(
    "a task in MANAGER_REVIEW will not take a hold, and its document stays whole",
    () => {
      // Given a task sitting in MANAGER_REVIEW, and its document as it stands
      const { dir, id } = build("MANAGER_REVIEW");
      const filePath = path.join(dir, `${id}.md`);
      const before = fs.readFileSync(filePath, "utf-8");

      // When a hold is applied through the task directory
      const attempt = () => run(dir, id, "hold", "a reason");

      // Then it is refused, and the document is byte for byte what it was
      expect(attempt).toThrow(/not valid from state/);
      expect(fs.readFileSync(filePath, "utf-8")).toBe(before);
    },
  );

  testInTempDirs(
    "a task in MANAGER_REVIEW will not take a resume, and its document stays whole",
    () => {
      // Given a task sitting in MANAGER_REVIEW, and its document as it stands
      const { dir, id } = build("MANAGER_REVIEW");
      const filePath = path.join(dir, `${id}.md`);
      const before = fs.readFileSync(filePath, "utf-8");

      // When a resume is applied through the task directory
      const attempt = () => run(dir, id, "resume");

      // Then it is refused, and the document is byte for byte what it was
      expect(attempt).toThrow(/not valid from state/);
      expect(fs.readFileSync(filePath, "utf-8")).toBe(before);
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
  testInTempDirs("a task sitting in DESIGN can be claimed by an agent", () => {
    // Given a task sitting in DESIGN
    const dir = makeTasksDir();
    const id = writeTask(dir, { id: "000001", state: "DESIGN" });

    // When an agent claims it
    claim(dir, id, "agent-1");

    // Then the agent's name is on the task
    expect(metaOf(dir, id).claimed_by).toBe("agent-1");
  });

  testInTempDirs(
    "a task sitting in DESIGN_REVIEW can be claimed by an agent",
    () => {
      // Given a task sitting in DESIGN_REVIEW
      const dir = makeTasksDir();
      const id = writeTask(dir, { id: "000001", state: "DESIGN_REVIEW" });

      // When an agent claims it
      claim(dir, id, "agent-1");

      // Then the agent's name is on the task
      expect(metaOf(dir, id).claimed_by).toBe("agent-1");
    },
  );

  testInTempDirs("a task sitting in PLAN can be claimed by an agent", () => {
    // Given a task sitting in PLAN
    const dir = makeTasksDir();
    const id = writeTask(dir, { id: "000001", state: "PLAN" });

    // When an agent claims it
    claim(dir, id, "agent-1");

    // Then the agent's name is on the task
    expect(metaOf(dir, id).claimed_by).toBe("agent-1");
  });

  testInTempDirs(
    "a task sitting in PLAN_REVIEW can be claimed by an agent",
    () => {
      // Given a task sitting in PLAN_REVIEW
      const dir = makeTasksDir();
      const id = writeTask(dir, { id: "000001", state: "PLAN_REVIEW" });

      // When an agent claims it
      claim(dir, id, "agent-1");

      // Then the agent's name is on the task
      expect(metaOf(dir, id).claimed_by).toBe("agent-1");
    },
  );

  testInTempDirs("a task sitting in WORK can be claimed by an agent", () => {
    // Given a task sitting in WORK
    const dir = makeTasksDir();
    const id = writeTask(dir, { id: "000001", state: "WORK" });

    // When an agent claims it
    claim(dir, id, "agent-1");

    // Then the agent's name is on the task
    expect(metaOf(dir, id).claimed_by).toBe("agent-1");
  });

  testInTempDirs(
    "a task sitting in WORK_REVIEW can be claimed by an agent",
    () => {
      // Given a task sitting in WORK_REVIEW
      const dir = makeTasksDir();
      const id = writeTask(dir, { id: "000001", state: "WORK_REVIEW" });

      // When an agent claims it
      claim(dir, id, "agent-1");

      // Then the agent's name is on the task
      expect(metaOf(dir, id).claimed_by).toBe("agent-1");
    },
  );
  testInTempDirs("a task sitting in NEW cannot be claimed by an agent", () => {
    // Given a task sitting in NEW
    const dir = makeTasksDir();
    const id = writeTask(dir, { id: "000001", state: "NEW" });

    // When an agent tries to claim it
    const attempt = () => claim(dir, id, "agent-1");

    // Then it is refused, because no agent runs that state
    expect(attempt).toThrow(/which no agent runs/);
  });

  testInTempDirs(
    "a task sitting in BLOCKED cannot be claimed by an agent",
    () => {
      // Given a task sitting in BLOCKED
      const dir = makeTasksDir();
      const id = writeTask(dir, { id: "000001", state: "BLOCKED" });

      // When an agent tries to claim it
      const attempt = () => claim(dir, id, "agent-1");

      // Then it is refused, because no agent runs that state
      expect(attempt).toThrow(/which no agent runs/);
    },
  );

  testInTempDirs(
    "a task sitting in HELD_DESIGN cannot be claimed by an agent",
    () => {
      // Given a task sitting in HELD_DESIGN
      const dir = makeTasksDir();
      const id = writeTask(dir, { id: "000001", state: "HELD_DESIGN" });

      // When an agent tries to claim it
      const attempt = () => claim(dir, id, "agent-1");

      // Then it is refused, because no agent runs that state
      expect(attempt).toThrow(/which no agent runs/);
    },
  );

  testInTempDirs(
    "a task sitting in HELD_PLAN cannot be claimed by an agent",
    () => {
      // Given a task sitting in HELD_PLAN
      const dir = makeTasksDir();
      const id = writeTask(dir, { id: "000001", state: "HELD_PLAN" });

      // When an agent tries to claim it
      const attempt = () => claim(dir, id, "agent-1");

      // Then it is refused, because no agent runs that state
      expect(attempt).toThrow(/which no agent runs/);
    },
  );

  testInTempDirs(
    "a task sitting in HELD_WORK cannot be claimed by an agent",
    () => {
      // Given a task sitting in HELD_WORK
      const dir = makeTasksDir();
      const id = writeTask(dir, { id: "000001", state: "HELD_WORK" });

      // When an agent tries to claim it
      const attempt = () => claim(dir, id, "agent-1");

      // Then it is refused, because no agent runs that state
      expect(attempt).toThrow(/which no agent runs/);
    },
  );

  testInTempDirs(
    "a task sitting in CHECK cannot be claimed by an agent",
    () => {
      // Given a task sitting in CHECK
      const dir = makeTasksDir();
      const id = writeTask(dir, { id: "000001", state: "CHECK" });

      // When an agent tries to claim it
      const attempt = () => claim(dir, id, "agent-1");

      // Then it is refused, because no agent runs that state
      expect(attempt).toThrow(/which no agent runs/);
    },
  );

  testInTempDirs(
    "a task sitting in MANAGER_REVIEW cannot be claimed by an agent",
    () => {
      // Given a task sitting in MANAGER_REVIEW
      const dir = makeTasksDir();
      const id = writeTask(dir, { id: "000001", state: "MANAGER_REVIEW" });

      // When an agent tries to claim it
      const attempt = () => claim(dir, id, "agent-1");

      // Then it is refused, because no agent runs that state
      expect(attempt).toThrow(/which no agent runs/);
    },
  );
  testInTempDirs(
    "releasing a claimed DESIGN task frees it without moving the stage",
    async () => {
      // Given a task in DESIGN claimed by a process now gone
      const dir = makeTasksDir();
      const id = writeTask(dir, { id: "000001", state: "DESIGN" });
      claim(dir, id, "agent-1", await deadPid());
      const held = metaOf(dir, id);

      // When the claim is released
      unclaim(dir, id);

      // Then the task stays in DESIGN, and only the holder changes
      expect(held.state).toBe("DESIGN");
      expect(held.claimed_by).toBe("agent-1");
      const free = metaOf(dir, id);
      expect(free.state).toBe("DESIGN");
      expect(free.claimed_by).toBeNull();
    },
  );

  testInTempDirs(
    "releasing a claimed DESIGN_REVIEW task frees it without moving the stage",
    async () => {
      // Given a task in DESIGN_REVIEW claimed by a process now gone
      const dir = makeTasksDir();
      const id = writeTask(dir, { id: "000001", state: "DESIGN_REVIEW" });
      claim(dir, id, "agent-1", await deadPid());
      const held = metaOf(dir, id);

      // When the claim is released
      unclaim(dir, id);

      // Then the task stays in DESIGN_REVIEW, and only the holder changes
      expect(held.state).toBe("DESIGN_REVIEW");
      expect(held.claimed_by).toBe("agent-1");
      const free = metaOf(dir, id);
      expect(free.state).toBe("DESIGN_REVIEW");
      expect(free.claimed_by).toBeNull();
    },
  );

  testInTempDirs(
    "releasing a claimed PLAN task frees it without moving the stage",
    async () => {
      // Given a task in PLAN claimed by a process now gone
      const dir = makeTasksDir();
      const id = writeTask(dir, { id: "000001", state: "PLAN" });
      claim(dir, id, "agent-1", await deadPid());
      const held = metaOf(dir, id);

      // When the claim is released
      unclaim(dir, id);

      // Then the task stays in PLAN, and only the holder changes
      expect(held.state).toBe("PLAN");
      expect(held.claimed_by).toBe("agent-1");
      const free = metaOf(dir, id);
      expect(free.state).toBe("PLAN");
      expect(free.claimed_by).toBeNull();
    },
  );

  testInTempDirs(
    "releasing a claimed PLAN_REVIEW task frees it without moving the stage",
    async () => {
      // Given a task in PLAN_REVIEW claimed by a process now gone
      const dir = makeTasksDir();
      const id = writeTask(dir, { id: "000001", state: "PLAN_REVIEW" });
      claim(dir, id, "agent-1", await deadPid());
      const held = metaOf(dir, id);

      // When the claim is released
      unclaim(dir, id);

      // Then the task stays in PLAN_REVIEW, and only the holder changes
      expect(held.state).toBe("PLAN_REVIEW");
      expect(held.claimed_by).toBe("agent-1");
      const free = metaOf(dir, id);
      expect(free.state).toBe("PLAN_REVIEW");
      expect(free.claimed_by).toBeNull();
    },
  );

  testInTempDirs(
    "releasing a claimed WORK task frees it without moving the stage",
    async () => {
      // Given a task in WORK claimed by a process now gone
      const dir = makeTasksDir();
      const id = writeTask(dir, { id: "000001", state: "WORK" });
      claim(dir, id, "agent-1", await deadPid());
      const held = metaOf(dir, id);

      // When the claim is released
      unclaim(dir, id);

      // Then the task stays in WORK, and only the holder changes
      expect(held.state).toBe("WORK");
      expect(held.claimed_by).toBe("agent-1");
      const free = metaOf(dir, id);
      expect(free.state).toBe("WORK");
      expect(free.claimed_by).toBeNull();
    },
  );

  testInTempDirs(
    "releasing a claimed WORK_REVIEW task frees it without moving the stage",
    async () => {
      // Given a task in WORK_REVIEW claimed by a process now gone
      const dir = makeTasksDir();
      const id = writeTask(dir, { id: "000001", state: "WORK_REVIEW" });
      claim(dir, id, "agent-1", await deadPid());
      const held = metaOf(dir, id);

      // When the claim is released
      unclaim(dir, id);

      // Then the task stays in WORK_REVIEW, and only the holder changes
      expect(held.state).toBe("WORK_REVIEW");
      expect(held.claimed_by).toBe("agent-1");
      const free = metaOf(dir, id);
      expect(free.state).toBe("WORK_REVIEW");
      expect(free.claimed_by).toBeNull();
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

  testInTempDirs(
    "resuming a held task clears the reason it was held for",
    () => {
      // Given a held task, carrying the reason the agent gave for holding it
      const { dir, id } = toHeld();

      // When the manager resumes it
      const result = run(dir, id, "resume");

      // Then the document it lands on carries no stale reason
      expect(readTaskFile(documentOf(dir, id, result)).meta.held_reason).toBe(
        null,
      );
    },
  );

  testInTempDirs(
    "aborting a held task clears the reason it was held for",
    () => {
      // Given a held task, carrying the reason the agent gave for holding it
      const { dir, id } = toHeld();

      // When the manager aborts it
      const result = run(dir, id, "abort");

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
