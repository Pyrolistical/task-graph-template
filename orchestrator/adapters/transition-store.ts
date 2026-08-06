import fs from "node:fs";
import path from "node:path";
import type { TaskId, TaskMeta } from "../domain/task.ts";
import {
  readTaskFile,
  writeTaskFile,
  findTaskFile,
  closeTaskFile,
  withLock,
} from "./task-store.ts";
import {
  type TransitionArgs,
  type TransitionName,
  type TransitionResult,
  decide,
  ENTRY_STATE,
  isHeld,
  type ValidState,
} from "../domain/state-machine.ts";

function activeTaskFiles(tasksDir: string): string[] {
  return fs
    .readdirSync(tasksDir, { withFileTypes: true })
    .filter((e) => e.isFile() && /^\d{6}\.md$/.test(e.name))
    .map((e) => path.join(tasksDir, e.name));
}

function propagateClose(
  tasksDir: string,
  closedId: TaskId,
  now: string,
): { unblocked: TaskId[]; dependentsUpdated: TaskId[] } {
  const unblocked: TaskId[] = [];
  const dependentsUpdated: TaskId[] = [];

  for (const filePath of activeTaskFiles(tasksDir)) {
    const { meta, body } = readTaskFile(filePath);
    if (!meta.depends_on.includes(closedId)) continue;

    meta.depends_on = meta.depends_on.filter((d) => d !== closedId);
    dependentsUpdated.push(meta.id);

    if (meta.state === "BLOCKED" && meta.depends_on.length === 0) {
      meta.state = ENTRY_STATE;
      unblocked.push(meta.id);
    }
    meta.state_entered = now;

    writeTaskFile(filePath, meta, body);
  }

  return { unblocked, dependentsUpdated };
}

export function applyTransition(
  tasksDir: string,
  taskId: TaskId,
  name: TransitionName,
  args: TransitionArgs,
): TransitionResult {
  return withLock(tasksDir, () => {
    const filePath = findTaskFile(taskId, tasksDir);
    if (!filePath) {
      throw new Error(`Task "${taskId}" not found`);
    }

    const { meta, body } = readTaskFile(filePath);

    if (meta.id !== taskId) {
      throw new Error(`Task file ${filePath} declares id "${meta.id}"`);
    }

    const from = meta.state as ValidState;
    const now = new Date().toISOString();
    const decided = decide(meta, body, name, args);

    meta.state_entered = now;
    meta.claimed_by = null;
    meta.claimed_pid = null;

    if (decided.kind === "stay") {
      writeTaskFile(filePath, meta, body);
      return { taskId, from, to: null, unblocked: [], dependentsUpdated: [] };
    }

    const nextBody = decided.body ?? body;
    meta.state = decided.to;
    if (!isHeld(decided.to)) {
      meta.held_reason = null;
    }

    if (decided.to === "CLOSED") {
      meta.workspace = null;
      const closedPath = closeTaskFile(filePath, tasksDir, meta, nextBody);
      const { unblocked, dependentsUpdated } = propagateClose(
        tasksDir,
        taskId,
        now,
      );
      return {
        taskId,
        from,
        to: "CLOSED",
        closedPath,
        unblocked,
        dependentsUpdated,
      };
    }

    writeTaskFile(filePath, meta, nextBody);
    return {
      taskId,
      from,
      to: decided.to,
      unblocked: [],
      dependentsUpdated: [],
    };
  });
}
