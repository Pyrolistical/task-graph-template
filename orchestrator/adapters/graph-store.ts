import fs from "node:fs";
import path from "node:path";
import {
  type TaskId,
  type TaskMeta,
  parseDocument,
  parseTaskMeta,
  splitDocument,
} from "../domain/task.ts";
import { activeTaskPath } from "./task-store.ts";

export interface Scan {
  tasks: Map<TaskId, TaskMeta>;
  problems: Map<string, string>;
}

export function readActiveTasks(tasksDir: string): Scan {
  const tasks = new Map<TaskId, TaskMeta>();
  const problems = new Map<string, string>();

  for (const entry of fs.readdirSync(tasksDir, { withFileTypes: true })) {
    if (!entry.isFile() || !/^\d{6}\.md$/.test(entry.name)) {
      continue;
    }
    const filePath = path.join(tasksDir, entry.name);
    try {
      const { raw } = parseDocument(fs.readFileSync(filePath, "utf-8"));
      const meta = parseTaskMeta(raw, filePath);
      tasks.set(meta.id, meta);
    } catch (err) {
      problems.set(filePath, (err as Error).message);
    }
  }

  return { tasks, problems };
}

export function readTaskBody(tasksDir: string, id: TaskId): string {
  const filePath = activeTaskPath(tasksDir, id);
  return splitDocument(fs.readFileSync(filePath, "utf-8")).body.trim();
}
