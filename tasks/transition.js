#!/usr/bin/env bun
/**
 * transition.js - Asserts task state and performs a state transition.
 *
 * Usage:
 *   bun tasks/transition.js <task-id> <transition-name> [args...]
 *
 * Transitions:
 *   addDependencies  <taskId1> [taskId2 ...]
 *   removeDependencies <taskId1> [taskId2 ...]
 *   noDependencies
 *   claim            <agentName> <pid>
 *   submit
 *   pass
 *   fail             <message>
 *   addTaskGraph     <update1> [update2 ...]
 *   doneTaskGraph    <update>
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  isValidId,
  parseFrontmatter,
  rebuildDocument,
  findTaskFile,
  readTaskFile,
  writeTaskFile,
  closeTaskFile,
} from "./task.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const tasksDir = __dirname;
const closedDir = path.join(tasksDir, "closed");

// ── Valid transitions keyed by source state ────────────────────────────

/**
 * Transition definitions. Each key is a source state.
 * Values are arrays of { name, targetState, args }.
 *   - `name` matches the CLI transition name
 *   - `targetState` is the new state after transition (or null for self-loop)
 *   - `args` describes expected arguments: [ { name, required } ]
 */
const TRANSITIONS = {
  NEW: [
    { name: "addDependencies", targetState: "BLOCKED", args: [{ name: "taskIds", min: 1 }] },
    { name: "noDependencies", targetState: "READY_WORK", args: [] },
  ],
  BLOCKED: [
    { name: "addDependencies", targetState: null, args: [{ name: "taskIds", min: 1 }] }, // self-loop
    { name: "removeDependencies", targetState: null, args: [{ name: "taskIds", min: 1 }] }, // resolved at apply time
  ],
  READY_WORK: [
    { name: "addDependencies", targetState: "BLOCKED", args: [{ name: "taskIds", min: 1 }] },
    { name: "claim", targetState: "WORKING", args: [{ name: "agentName", required: true }, { name: "pid", required: true }] },
  ],
  WORKING: [
    { name: "submit", targetState: "READY_CHECK", args: [] },
  ],
  READY_CHECK: [
    { name: "claim", targetState: "CHECKING", args: [{ name: "agentName", required: true }, { name: "pid", required: true }] },
  ],
  CHECKING: [
    { name: "fail", targetState: "READY_WORK", args: [{ name: "message", required: true }] },
    { name: "pass", targetState: "READY_REVIEW", args: [] },
  ],
  READY_REVIEW: [
    { name: "claim", targetState: "REVIEWING", args: [{ name: "agentName", required: true }, { name: "pid", required: true }] },
  ],
  REVIEWING: [
    { name: "fail", targetState: "READY_WORK", args: [{ name: "message", required: true }] },
    { name: "pass", targetState: null, args: [] }, // resolved at apply time (CLOSED or READY_TASK_GRAPH_UPDATE)
    { name: "addTaskGraph", targetState: "READY_TASK_GRAPH_UPDATE", args: [{ name: "updates", min: 1 }] },
  ],
  READY_TASK_GRAPH_UPDATE: [
    { name: "claim", targetState: "TASK_GRAPH_UPDATING", args: [{ name: "agentName", required: true }, { name: "pid", required: true }] },
  ],
  TASK_GRAPH_UPDATING: [
    { name: "doneTaskGraph", targetState: null, args: [{ name: "update", required: true }] }, // resolved at apply time
  ],
};

// ── Transition logic ───────────────────────────────────────────────────

/**
 * Resolve the target state for transitions that have conditional targets.
 */
function resolveTargetState(currentState, transitionName, meta, args) {
  // BLOCKED → removeDependencies: READY_WORK only if last dependency removed
  if (currentState === "BLOCKED" && transitionName === "removeDependencies") {
    const currentDeps = Array.isArray(meta.depends_on) ? [...meta.depends_on] : [];
    const toRemove = args.taskIds;
    const remaining = currentDeps.filter((d) => !toRemove.includes(d));
    return remaining.length === 0 ? "READY_WORK" : null; // null = self-loop (stay BLOCKED)
  }

  // REVIEWING → pass: CLOSED unless there are pending task graph updates
  if (currentState === "REVIEWING" && transitionName === "pass") {
    const pending = meta.pending_task_graph_updates;
    if (Array.isArray(pending) && pending.length > 0) {
      return "READY_TASK_GRAPH_UPDATE";
    }
    return "CLOSED";
  }

  // TASK_GRAPH_UPDATING → doneTaskGraph: CLOSED only if last update marked done
  if (currentState === "TASK_GRAPH_UPDATING" && transitionName === "doneTaskGraph") {
    const pending = Array.isArray(meta.pending_task_graph_updates) ? [...meta.pending_task_graph_updates] : [];
    const updateDone = args.update;
    const remaining = pending.filter((u) => u !== updateDone);
    return remaining.length === 0 ? "CLOSED" : null; // null = self-loop (stay TASK_GRAPH_UPDATING)
  }

  return null;
}

function applyTransition(filePath, currentState, transitionName, args) {
  const { meta, body } = readTaskFile(filePath);

  // Validate task ID in document matches the requested ID
  const docId = String(meta.id ?? "").trim();
  if (docId !== filePath.match(/(\d+)\.md$/)?.[1]) {
    console.error(`Error: Task file ID mismatch in ${filePath}`);
    process.exit(1);
  }

  // Validate current state matches expectation
  const docState = String(meta.state ?? "").trim();
  if (docState !== currentState) {
    console.error(`Error: Task "${docId}" is in state "${docState}", expected "${currentState}"`);
    process.exit(1);
  }

  // Resolve target state
  let targetState = resolveTargetState(currentState, transitionName, meta, args);

  // For transitions with a fixed target, use it directly
  const transDef = TRANSITIONS[currentState]?.find((t) => t.name === transitionName);
  if (transDef && targetState === null && transDef.targetState !== null) {
    targetState = transDef.targetState;
  }

  // Apply state-specific updates to metadata
  switch (transitionName) {
    case "addDependencies": {
      const currentDeps = Array.isArray(meta.depends_on) ? [...meta.depends_on] : [];
      for (const dep of args.taskIds) {
        if (!isValidId(dep)) {
          console.error(`Error: Invalid dependency ID "${dep}"`);
          process.exit(1);
        }
        if (!currentDeps.includes(dep)) {
          currentDeps.push(dep);
        }
      }
      meta.depends_on = currentDeps;
      break;
    }

    case "removeDependencies": {
      const currentDeps = Array.isArray(meta.depends_on) ? [...meta.depends_on] : [];
      const remaining = currentDeps.filter((d) => !args.taskIds.includes(d));
      meta.depends_on = remaining;
      break;
    }

    case "claim": {
      meta.claimed_by = args.agentName;
      meta.claimed_pid = Number(args.pid);
      break;
    }

    case "doneTaskGraph": {
      const pending = Array.isArray(meta.pending_task_graph_updates) ? [...meta.pending_task_graph_updates] : [];
      const remaining = pending.filter((u) => u !== args.update);
      meta.pending_task_graph_updates = remaining;
      break;
    }

    case "addTaskGraph": {
      const existing = Array.isArray(meta.pending_task_graph_updates) ? [...meta.pending_task_graph_updates] : [];
      for (const update of args.updates) {
        if (!existing.includes(update)) {
          existing.push(update);
        }
      }
      meta.pending_task_graph_updates = existing;
      break;
    }
  }

  // Update state
  if (targetState) {
    meta.state = targetState;
    meta.state_entered = new Date().toISOString();
  } else {
    // Self-loop: update state_entered timestamp to reflect activity
    meta.state_entered = new Date().toISOString();
  }

  // Clear claim when leaving claimed states back to unclaimed states
  const unclaimedStates = ["READY_WORK", "READY_CHECK", "READY_REVIEW", "READY_TASK_GRAPH_UPDATE", "BLOCKED", "CLOSED"];
  if (targetState && unclaimedStates.includes(targetState)) {
    meta.claimed_by = null;
    meta.claimed_pid = null;
  }

  // When transitioning to CLOSED, move file to closed/
  if (targetState === "CLOSED") {
    const closedPath = closeTaskFile(filePath, tasksDir, meta, body);
    console.log(`Task "${docId}" transitioned to CLOSED → ${closedPath}`);
  } else {
    writeTaskFile(filePath, meta, body);

    // Re-read after claim to verify we didn't lose a race
    if (transitionName === "claim") {
      const { meta: reReadMeta } = readTaskFile(filePath);
      const reReadBy = String(reReadMeta.claimed_by ?? "").trim();
      const reReadPid = reReadMeta.claimed_pid != null ? Number(reReadMeta.claimed_pid) : null;
      if (reReadBy !== args.agentName || reReadPid !== Number(args.pid)) {
        console.error(
          `Error: Claim race detected on task "${docId}" — expected claimed_by="${args.agentName}" claimed_pid=${args.pid}, got claimed_by="${reReadBy}" claimed_pid=${reReadPid}`,
        );
        process.exit(1);
      }
    }

    if (targetState) {
      console.log(`Task "${docId}" ${currentState} → ${targetState}`);
    } else {
      console.log(`Task "${docId}" stayed in ${currentState} (${transitionName} applied)`);
    }
  }
}

// ── Main ───────────────────────────────────────────────────────────────

function main() {
  const argv = process.argv.slice(2);

  if (argv.length < 2) {
    console.error("Usage: bun tasks/transition.js <task-id> <transition-name> [args...]");
    console.error("");
    console.error("Transitions:");
    console.error("  addDependencies     <taskId1> [taskId2 ...]");
    console.error("  removeDependencies  <taskId1> [taskId2 ...]");
    console.error("  noDependencies");
    console.error("  claim              <agentName> <pid>");
    console.error("  submit");
    console.error("  pass");
    console.error("  fail               <message>");
    console.error("  addTaskGraph       <update1> [update2 ...]");
    console.error("  doneTaskGraph      <update>");
    process.exit(1);
  }

  const taskId = argv[0];
  const transitionName = argv[1];
  const extraArgs = argv.slice(2);

  // Validate task ID format
  if (!isValidId(taskId)) {
    console.error(`Error: Invalid task ID "${taskId}". Must be a six-digit number.`);
    process.exit(1);
  }

  // Find the task file
  const filePath = findTaskFile(taskId, tasksDir);
  if (!filePath) {
    console.error(`Error: Task "${taskId}" not found`);
    process.exit(1);
  }

  // Parse current state from the file
  const { meta } = readTaskFile(filePath);
  const currentState = String(meta.state ?? "").trim();

  if (!currentState) {
    console.error(`Error: Task "${taskId}" has no state`);
    process.exit(1);
  }

  // Look up valid transitions from current state
  const validTransitions = TRANSITIONS[currentState];
  if (!validTransitions) {
    console.error(`Error: No transitions available from state "${currentState}" (terminal or unknown state)`);
    process.exit(1);
  }

  const transDef = validTransitions.find((t) => t.name === transitionName);
  if (!transDef) {
    console.error(`Error: Transition "${transitionName}" is not valid from state "${currentState}"`);
    console.error(`Valid transitions: ${validTransitions.map((t) => t.name).join(", ")}`);
    process.exit(1);
  }

  // Parse and validate arguments
  const args = {};

  if (transitionName === "addDependencies" || transitionName === "removeDependencies") {
    if (extraArgs.length < 1) {
      console.error(`Error: "${transitionName}" requires at least one task ID`);
      process.exit(1);
    }
    args.taskIds = extraArgs;
    for (const id of args.taskIds) {
      if (!isValidId(id)) {
        console.error(`Error: Invalid dependency ID "${id}". Must be a six-digit number.`);
        process.exit(1);
      }
    }
  } else if (transitionName === "claim") {
    if (extraArgs.length < 2) {
      console.error('Error: "claim" requires <agentName> <pid>');
      process.exit(1);
    }
    args.agentName = extraArgs[0];
    args.pid = extraArgs[1];
    if (isNaN(Number(args.pid))) {
      console.error(`Error: Invalid PID "${args.pid}"`);
      process.exit(1);
    }
  } else if (transitionName === "fail") {
    if (extraArgs.length < 1) {
      console.error('Error: "fail" requires a <message>');
      process.exit(1);
    }
    args.message = extraArgs.join(" ");
  } else if (transitionName === "addTaskGraph") {
    if (extraArgs.length < 1) {
      console.error('Error: "addTaskGraph" requires at least one <update>');
      process.exit(1);
    }
    args.updates = extraArgs;
  } else if (transitionName === "doneTaskGraph") {
    if (extraArgs.length < 1) {
      console.error('Error: "doneTaskGraph" requires an <update>');
      process.exit(1);
    }
    args.update = extraArgs[0];
  }

  // Apply the transition
  applyTransition(filePath, currentState, transitionName, args);
}

// ── Entry point / Tests ────────────────────────────────────────────────

import os from "node:os";

if (import.meta.main) {
  if (process.env.NODE_ENV === "test") {
    test("resolveTargetState BLOCKED removeDependencies → READY_WORK when last dep removed", () => {
      const meta = { depends_on: ["000001", "000002"] };
      const args = { taskIds: ["000001", "000002"] };
      expect(resolveTargetState("BLOCKED", "removeDependencies", meta, args)).toBe("READY_WORK");
    });

    test("resolveTargetState BLOCKED removeDependencies stays BLOCKED when deps remain", () => {
      const meta = { depends_on: ["000001", "000002"] };
      const args = { taskIds: ["000001"] };
      expect(resolveTargetState("BLOCKED", "removeDependencies", meta, args)).toBeNull();
    });

    test("resolveTargetState REVIEWING pass → CLOSED when no pending updates", () => {
      const meta = { pending_task_graph_updates: [] };
      const args = {};
      expect(resolveTargetState("REVIEWING", "pass", meta, args)).toBe("CLOSED");
    });

    test("resolveTargetState REVIEWING pass → READY_TASK_GRAPH_UPDATE when pending updates exist", () => {
      const meta = { pending_task_graph_updates: ["update-1"] };
      const args = {};
      expect(resolveTargetState("REVIEWING", "pass", meta, args)).toBe("READY_TASK_GRAPH_UPDATE");
    });

    test("resolveTargetState TASK_GRAPH_UPDATING doneTaskGraph → CLOSED when last update done", () => {
      const meta = { pending_task_graph_updates: ["update-1"] };
      const args = { update: "update-1" };
      expect(resolveTargetState("TASK_GRAPH_UPDATING", "doneTaskGraph", meta, args)).toBe("CLOSED");
    });

    test("resolveTargetState TASK_GRAPH_UPDATING doneTaskGraph stays when updates remain", () => {
      const meta = { pending_task_graph_updates: ["update-1", "update-2"] };
      const args = { update: "update-1" };
      expect(resolveTargetState("TASK_GRAPH_UPDATING", "doneTaskGraph", meta, args)).toBeNull();
    });

    test("full transition NEW → READY_WORK via noDependencies (e2e)", () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "transition-test-"));

      const taskPath = path.join(tmpDir, "000001.md");
      fs.writeFileSync(taskPath, `---
id: 000001
title: Test Task
state: NEW
depends_on: []
claimed_by:
claimed_pid:
state_entered:
---

# Goal`);

      // Simulate the transition logic
      const { meta, body } = parseFrontmatter(fs.readFileSync(taskPath, "utf-8"));
      expect(meta.state).toBe("NEW");

      // Apply noDependencies transition
      meta.state = "READY_WORK";
      meta.claimed_by = null;
      meta.claimed_pid = null;
      const newContent = rebuildDocument(meta, body);
      fs.writeFileSync(taskPath, newContent, "utf-8");

      // Verify
      const { meta: updatedMeta } = parseFrontmatter(fs.readFileSync(taskPath, "utf-8"));
      expect(updatedMeta.state).toBe("READY_WORK");

      fs.rmSync(tmpDir, { recursive: true });
    });

    test("full transition NEW → BLOCKED via addDependencies (e2e)", () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "transition-test-"));

      const taskPath = path.join(tmpDir, "000001.md");
      fs.writeFileSync(taskPath, `---
id: 000001
title: Test Task
state: NEW
depends_on: []
claimed_by:
claimed_pid:
state_entered:
---

# Goal`);

      const { meta, body } = parseFrontmatter(fs.readFileSync(taskPath, "utf-8"));

      // Apply addDependencies
      const currentDeps = Array.isArray(meta.depends_on) ? [...meta.depends_on] : [];
      currentDeps.push("000002");
      meta.depends_on = currentDeps;
      meta.state = "BLOCKED";
      const newContent = rebuildDocument(meta, body);
      fs.writeFileSync(taskPath, newContent, "utf-8");

      const { meta: updatedMeta } = parseFrontmatter(fs.readFileSync(taskPath, "utf-8"));
      expect(updatedMeta.state).toBe("BLOCKED");
      expect(Array.isArray(updatedMeta.depends_on)).toBe(true);
      expect(updatedMeta.depends_on).toContain("000002");

      fs.rmSync(tmpDir, { recursive: true });
    });

    test("CLOSED transition moves file to closed/ (e2e)", () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "transition-test-"));
      const closedDirTest = path.join(tmpDir, "closed");

      const taskPath = path.join(tmpDir, "000001.md");
      fs.writeFileSync(taskPath, `---
id: 000001
title: Test Task
state: REVIEWING
depends_on: []
claimed_by: agent-1
claimed_pid: 12345
pending_task_graph_updates: []
state_entered:
---

# Goal`);

      const { meta, body } = parseFrontmatter(fs.readFileSync(taskPath, "utf-8"));

      // Simulate pass → CLOSED transition
      meta.state = "CLOSED";
      meta.claimed_by = null;
      meta.claimed_pid = null;

      fs.mkdirSync(closedDirTest, { recursive: true });
      const closedPath = path.join(closedDirTest, "000001.md");
      fs.writeFileSync(closedPath, rebuildDocument(meta, body), "utf-8");
      fs.unlinkSync(taskPath);

      expect(fs.existsSync(taskPath)).toBe(false);
      expect(fs.existsSync(closedPath)).toBe(true);

      const { meta: closedMeta } = parseFrontmatter(fs.readFileSync(closedPath, "utf-8"));
      expect(closedMeta.state).toBe("CLOSED");

      fs.rmSync(tmpDir, { recursive: true });
    });

    test("serializeMeta handles arrays and null values", () => {
      const meta = {
        id: "000001",
        title: "Test",
        state: "BLOCKED",
        depends_on: ["000002", "000003"],
        claimed_by: null,
        claimed_pid: null,
      };
      const serialized = rebuildDocument(meta, "");
      expect(serialized).toContain("id: 000001");
      expect(serialized).toContain("state: BLOCKED");
      expect(serialized).toContain("depends_on:");
      expect(serialized).toContain("- 000002");
      expect(serialized).toContain("- 000003");
      expect(serialized).toContain("claimed_by:");
    });

    test("serializeMeta handles empty arrays", () => {
      const meta = { depends_on: [], pending_task_graph_updates: [] };
      const serialized = rebuildDocument(meta, "");
      expect(serialized).toContain("depends_on: []");
      expect(serialized).toContain("pending_task_graph_updates: []");
    });

    test("isValidId validation", () => {
      expect(isValidId("000001")).toBe(true);
      expect(isValidId("999999")).toBe(true);
      expect(isValidId("1")).toBe(false);
      expect(isValidId("abc123")).toBe(false);
    });

    test("claim re-read verifies our claim persisted (race detection)", () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "transition-test-"));

      const taskPath = path.join(tmpDir, "000001.md");
      fs.writeFileSync(taskPath, `---
id: 000001
title: Test Task
state: READY_WORK
depends_on: []
claimed_by:
claimed_pid:
state_entered:
---

# Goal`);

      const { meta, body } = parseFrontmatter(fs.readFileSync(taskPath, "utf-8"));

      // Simulate claim by agent-1
      meta.claimed_by = "agent-1";
      meta.claimed_pid = 99999;
      meta.state = "WORKING";
      const newContent = rebuildDocument(meta, body);
      fs.writeFileSync(taskPath, newContent, "utf-8");

      // Re-read and verify (what applyTransition does for claim)
      const { meta: reReadMeta } = parseFrontmatter(fs.readFileSync(taskPath, "utf-8"));
      const reReadBy = String(reReadMeta.claimed_by ?? "").trim();
      const reReadPid = reReadMeta.claimed_pid != null ? Number(reReadMeta.claimed_pid) : null;

      // Should match our claim
      expect(reReadBy).toBe("agent-1");
      expect(reReadPid).toBe(99999);

      // Now simulate a race: another agent overwrites between write and re-read
      const { meta: raceMeta, body: raceBody } = parseFrontmatter(fs.readFileSync(taskPath, "utf-8"));
      raceMeta.claimed_by = "agent-2";
      raceMeta.claimed_pid = 11111;
      fs.writeFileSync(taskPath, rebuildDocument(raceMeta, raceBody), "utf-8");

      // Re-read now should show different claimer
      const { meta: reReadMeta2 } = parseFrontmatter(fs.readFileSync(taskPath, "utf-8"));
      const reReadBy2 = String(reReadMeta2.claimed_by ?? "").trim();
      expect(reReadBy2).toBe("agent-2");

      fs.rmSync(tmpDir, { recursive: true });
    });

  } else {
    main();
  }
}
