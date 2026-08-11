import fs from "node:fs/promises";
import path from "node:path";
import type { CreatedTask } from "../app/ports/tasks.ts";
import { exists, writeAtomic } from "./files.ts";
import { PidLock } from "./pid-lock.ts";
import {
  type TaskId,
  type TaskMeta,
  formatId,
  normalizeBody,
  parseDocument,
  parseTaskMeta,
  rebuildDocument,
} from "../domain/task.ts";

export function activeTaskPath(tasksDir: string, id: string): string {
  return path.join(tasksDir, `${id}.md`);
}

export function closedTaskPath(tasksDir: string, id: string): string {
  return path.join(tasksDir, "closed", `${id}.md`);
}

export function nextTaskIdPath(tasksDir: string): string {
  return path.join(tasksDir, "next-task-id");
}

export async function findTaskFile(
  id: string,
  tasksDir: string,
): Promise<string | undefined> {
  const activePath = activeTaskPath(tasksDir, id);
  if (await exists(activePath)) return activePath;

  const closedPath = closedTaskPath(tasksDir, id);
  if (await exists(closedPath)) return closedPath;
}

export async function requireTaskFile(
  id: string,
  tasksDir: string,
): Promise<string> {
  const filePath = await findTaskFile(id, tasksDir);
  if (!filePath) {
    throw new Error(`Task "${id}" not found`);
  }
  return filePath;
}

export async function readTaskFile(filePath: string): Promise<{
  meta: TaskMeta;
  body: string;
}> {
  const content = await fs.readFile(filePath, "utf-8");
  const { raw, body } = parseDocument(content);
  return { meta: parseTaskMeta(raw, filePath), body };
}

export async function writeTaskFile(
  filePath: string,
  meta: TaskMeta,
  body: string,
): Promise<void> {
  await writeAtomic(filePath, rebuildDocument(meta, body));
}

export async function writeTaskBody(
  tasksDir: string,
  id: TaskId,
  body: string,
): Promise<string> {
  if (body.trim().length === 0) {
    throw new Error("A task body is required");
  }

  const filePath = await requireTaskFile(id, tasksDir);
  const { meta } = await readTaskFile(filePath);
  await writeTaskFile(filePath, meta, normalizeBody(body));
  return filePath;
}

export async function templatePath(
  tasksDir: string,
  orchestratorDir: string,
): Promise<string> {
  const override = path.join(tasksDir, "template.md");
  return (await exists(override))
    ? override
    : path.join(orchestratorDir, "template.md");
}

export async function createTask(
  tasksDir: string,
  orchestratorDir: string,
  title: string,
): Promise<CreatedTask> {
  if (title.trim().length === 0) {
    throw new Error("A task title is required");
  }

  const counter = nextTaskIdPath(tasksDir);
  const rawNext = (await fs.readFile(counter, "utf-8")).trim();
  const nextId = Number.parseInt(rawNext, 10);

  if (!Number.isInteger(nextId) || nextId < 1) {
    throw new Error(`Invalid value in next-task-id: "${rawNext}"`);
  }

  const id = formatId(nextId);
  const template = await templatePath(tasksDir, orchestratorDir);
  const { raw, body } = parseDocument(await fs.readFile(template, "utf-8"));

  raw.id = id;
  raw.title = title.trim();
  raw.state_entered = new Date().toISOString();

  const meta = parseTaskMeta(raw, template);
  const filePath = activeTaskPath(tasksDir, id);

  if (await exists(filePath)) {
    throw new Error(
      `${filePath} already holds a task; ${counter} owes the id ${id}`,
    );
  }
  await writeTaskFile(filePath, meta, body);
  await writeAtomic(counter, `${nextId + 1}\n`);

  return { id, filePath };
}

export async function closeTaskFile(
  activePath: string,
  tasksDir: string,
  meta: TaskMeta,
  body: string,
): Promise<string> {
  const closedPath = closedTaskPath(tasksDir, path.basename(activePath, ".md"));
  await fs.mkdir(path.dirname(closedPath), { recursive: true });

  await writeTaskFile(closedPath, meta, body);
  await fs.unlink(activePath);
  return closedPath;
}

export const LOCK_FILENAME = ".tasks.lock";

export function lockPath(tasksDir: string): string {
  return path.join(tasksDir, LOCK_FILENAME);
}

export function graphLock(tasksDir: string): PidLock {
  return new PidLock(lockPath(tasksDir), tasksDir);
}
