import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "bun:test";
import { type Awaitable } from "../kernel/domain/awaitable.ts";

const STALE_MS = 60 * 60 * 1000;

export const TEST_ROOT = path.join(os.tmpdir(), "task-graph-server-test");

await fs.mkdir(TEST_ROOT, { recursive: true });
for (const name of await fs.readdir(TEST_ROOT)) {
  const entry = path.join(TEST_ROOT, name);
  let stats;
  try {
    stats = await fs.stat(entry);
  } catch {
    continue;
  }
  if (Date.now() - stats.mtimeMs > STALE_MS) {
    await fs.rm(entry, { recursive: true, force: true });
  }
}

process.env.TASK_GRAPH_TASKS_ROOT = path.join(TEST_ROOT, "task-graph-root");

const live: string[] = [];

export async function tempDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(TEST_ROOT, prefix));
  live.push(dir);
  return dir;
}

export async function withTasksRoot<T>(
  root: string,
  fn: () => Awaitable<T>,
): Promise<T> {
  const previous = process.env.TASK_GRAPH_TASKS_ROOT;
  process.env.TASK_GRAPH_TASKS_ROOT = root;
  try {
    return await fn();
  } finally {
    if (!previous) {
      delete process.env.TASK_GRAPH_TASKS_ROOT;
    } else {
      process.env.TASK_GRAPH_TASKS_ROOT = previous;
    }
  }
}

function inTempDirs<Args extends unknown[]>(
  fn: (...args: Args) => Awaitable<void>,
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
      await fs.rm(dir, { recursive: true, force: true });
    }
  };
}

export function testInTempDirs(
  name: string,
  fn: () => Awaitable<void>,
  timeout?: number,
): void {
  test(name, inTempDirs(fn), timeout);
}

export function testInTempDirsIf(
  name: string,
  supported: boolean,
  fn: () => Awaitable<void>,
  timeout?: number,
): void {
  test.skipIf(!supported)(name, inTempDirs(fn), timeout);
}
