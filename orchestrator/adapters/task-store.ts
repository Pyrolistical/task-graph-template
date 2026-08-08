import fs from "node:fs";
import path from "node:path";
import type { CreatedTask } from "../app/ports.ts";
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

export function findTaskFile(id: string, tasksDir: string): string | null {
  const activePath = activeTaskPath(tasksDir, id);
  if (fs.existsSync(activePath)) return activePath;

  const closedPath = closedTaskPath(tasksDir, id);
  if (fs.existsSync(closedPath)) return closedPath;

  return null;
}

export function readTaskFile(filePath: string): {
  meta: TaskMeta;
  body: string;
} {
  const content = fs.readFileSync(filePath, "utf-8");
  const { raw, body } = parseDocument(content);
  return { meta: parseTaskMeta(raw, filePath), body };
}

export function writeTaskFile(
  filePath: string,
  meta: TaskMeta,
  body: string,
): void {
  fs.writeFileSync(filePath, rebuildDocument(meta, body), "utf-8");
}

export function writeTaskBody(
  tasksDir: string,
  id: TaskId,
  body: string,
): string {
  if (body.trim().length === 0) {
    throw new Error("A task body is required");
  }

  return withLock(tasksDir, () => {
    const filePath = findTaskFile(id, tasksDir);
    if (filePath === null) {
      throw new Error(`Task "${id}" not found`);
    }
    const { meta } = readTaskFile(filePath);
    writeTaskFile(filePath, meta, normalizeBody(body));
    return filePath;
  });
}

export function templatePath(
  tasksDir: string,
  orchestratorDir: string,
): string {
  const override = path.join(tasksDir, "template.md");
  return fs.existsSync(override)
    ? override
    : path.join(orchestratorDir, "template.md");
}

export function createTask(
  tasksDir: string,
  orchestratorDir: string,
  title: string,
): CreatedTask {
  if (title.trim().length === 0) {
    throw new Error("A task title is required");
  }

  return withLock(tasksDir, () => {
    const counter = nextTaskIdPath(tasksDir);
    const rawNext = fs.readFileSync(counter, "utf-8").trim();
    const nextId = Number.parseInt(rawNext, 10);

    if (!Number.isInteger(nextId) || nextId < 1) {
      throw new Error(`Invalid value in next-task-id: "${rawNext}"`);
    }

    const id = formatId(nextId);
    const template = templatePath(tasksDir, orchestratorDir);
    const { raw, body } = parseDocument(fs.readFileSync(template, "utf-8"));

    raw.id = id;
    raw.title = title.trim();
    raw.state_entered = new Date().toISOString();

    const meta = parseTaskMeta(raw, template);
    const filePath = activeTaskPath(tasksDir, id);

    fs.writeFileSync(filePath, rebuildDocument(meta, body), {
      encoding: "utf-8",
      flag: "wx",
    });
    fs.writeFileSync(counter, `${nextId + 1}\n`, "utf-8");

    return { id, filePath };
  });
}

export function closeTaskFile(
  activePath: string,
  tasksDir: string,
  meta: TaskMeta,
  body: string,
): string {
  const closedPath = closedTaskPath(tasksDir, path.basename(activePath, ".md"));
  fs.mkdirSync(path.dirname(closedPath), { recursive: true });

  writeTaskFile(closedPath, meta, body);
  fs.unlinkSync(activePath);
  return closedPath;
}

const LOCK_RETRIES = 200;
const LOCK_RETRY_MS = 10;

export const LOCK_FILENAME = ".tasks.lock";

export function lockPath(tasksDir: string): string {
  return path.join(tasksDir, LOCK_FILENAME);
}

export function withLock<T>(tasksDir: string, fn: () => T): T {
  const lock = lockPath(tasksDir);
  let fd: number | null = null;

  for (let attempt = 0; attempt < LOCK_RETRIES; attempt++) {
    try {
      fd = fs.openSync(lock, "wx");
      fs.writeSync(fd, `${process.pid}\n`);
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      Bun.sleepSync(LOCK_RETRY_MS);
    }
  }

  if (fd === null) {
    throw new Error(
      `Could not acquire ${lock} after ${(LOCK_RETRIES * LOCK_RETRY_MS) / 1000}s; remove it if stale`,
    );
  }

  try {
    return fn();
  } finally {
    fs.closeSync(fd);
    fs.rmSync(lock, { force: true });
  }
}

function isZombie(pid: number): boolean {
  let stat: string;
  try {
    stat = fs.readFileSync(`/proc/${pid}/stat`, "utf-8");
  } catch {
    return false;
  }
  return stat.slice(stat.lastIndexOf(")") + 2).startsWith("Z");
}

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  return !isZombie(pid);
}
