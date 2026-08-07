import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "bun:test";

export const TEST_ROOT = path.join(os.tmpdir(), "task-graph-server-test");

fs.rmSync(TEST_ROOT, { recursive: true, force: true });
fs.mkdirSync(TEST_ROOT, { recursive: true });

process.env.TASK_GRAPH_TASKS_ROOT = path.join(TEST_ROOT, "task-graph-root");

const live: string[] = [];

export function tempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(TEST_ROOT, prefix));
  live.push(dir);
  return dir;
}

export async function withTasksRoot<T>(
  root: string,
  fn: () => T | Promise<T>,
): Promise<T> {
  const previous = process.env.TASK_GRAPH_TASKS_ROOT;
  process.env.TASK_GRAPH_TASKS_ROOT = root;
  try {
    return await fn();
  } finally {
    if (previous === undefined) {
      delete process.env.TASK_GRAPH_TASKS_ROOT;
    } else {
      process.env.TASK_GRAPH_TASKS_ROOT = previous;
    }
  }
}

function inTempDirs<Args extends unknown[]>(
  fn: (...args: Args) => void | Promise<void>,
): (...args: Args) => Promise<void> {
  return async (...args: Args) => {
    const mark = live.length;
    try {
      await fn(...args);
    } catch (err) {
      live.splice(mark);
      throw err;
    }
    for (const dir of live.splice(mark)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  };
}

export function testInTempDirs(
  name: string,
  fn: () => void | Promise<void>,
  timeout?: number,
): void {
  test(name, inTempDirs(fn), timeout);
}
