import fs from "node:fs";
import type { TaskId } from "../domain/task.ts";
import {
  type CheckResult,
  type RunningCheck,
  tailOf,
} from "../domain/checks.ts";

export class CheckRunner {
  private readonly running = new Map<string, RunningCheck>();

  get view(): RunningCheck[] {
    return [...this.running.values()].sort(
      (a, b) => a.task_id.localeCompare(b.task_id) || a.index - b.index,
    );
  }

  isRunning(taskId: TaskId): boolean {
    return [...this.running.values()].some((check) => check.task_id === taskId);
  }

  start(
    taskId: TaskId,
    index: number,
    command: string,
    cwd: string,
    logPath: string,
    launch: string[] = [],
  ): Promise<CheckResult> {
    const key = `${taskId}:${index}`;
    fs.writeFileSync(logPath, "", "utf-8");

    const proc = Bun.spawn([...launch, "bash", "-lc", command], {
      cwd,
      stdout: "pipe",
      stderr: "pipe",
    });

    this.running.set(key, {
      task_id: taskId,
      index,
      command,
      pid: proc.pid,
      started_at: new Date().toISOString(),
      log: logPath,
    });

    return (async (): Promise<CheckResult> => {
      const [stdout, stderr, code] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      const output = `${stdout}${stderr}`;
      fs.writeFileSync(logPath, output, "utf-8");
      this.running.delete(key);
      return {
        task_id: taskId,
        index,
        command,
        code,
        log: logPath,
        tail: tailOf(output),
      };
    })();
  }
}
