import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test as bunTest } from "bun:test";

export const TEST_ROOT = path.join(os.tmpdir(), "task-graph-server-test");

fs.rmSync(TEST_ROOT, { recursive: true, force: true });
fs.mkdirSync(TEST_ROOT, { recursive: true });

const live: string[] = [];

export function tempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(TEST_ROOT, prefix));
  live.push(dir);
  return dir;
}

export function test(
  name: string,
  fn: () => void | Promise<void>,
  timeout?: number,
): void {
  bunTest(
    name,
    async () => {
      const mark = live.length;
      try {
        await fn();
      } catch (err) {
        live.splice(mark);
        throw err;
      }
      for (const dir of live.splice(mark)) {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
    timeout,
  );
}
