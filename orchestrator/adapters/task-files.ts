import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { Assignments } from "../app/ports/assignments.ts";
import type { Messages } from "../app/ports/messages.ts";
import type { Reviews } from "../app/ports/reviews.ts";
import type { ClaimState } from "../domain/state-machine.ts";
import type { TaskId } from "../domain/task.ts";
import { parse } from "../domain/schema.ts";
import { exists, writeAtomic } from "./files.ts";
import { Runtime } from "./runtime.ts";

const Findings = z.array(z.string());

export function historyName(n: number): string {
  return `ASSIGNMENT.${n}.md`;
}

export async function attemptOf(historyDir: string): Promise<number> {
  if (!(await exists(historyDir))) {
    return 1;
  }
  return (
    (await fs.readdir(historyDir)).filter((name) =>
      name.startsWith("ASSIGNMENT."),
    ).length + 1
  );
}

export async function rotate(
  assignmentPath: string,
  historyDir: string,
): Promise<string | null> {
  if (!(await exists(assignmentPath))) {
    return null;
  }

  await fs.mkdir(historyDir, { recursive: true });
  const target = path.join(
    historyDir,
    historyName(await attemptOf(historyDir)),
  );
  await fs.rename(assignmentPath, target);
  return target;
}

async function write(filePath: string, contents: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await writeAtomic(filePath, contents);
}

export class TaskFiles implements Messages, Reviews, Assignments {
  constructor(private readonly runtime: Runtime) {}

  async queue(
    taskId: TaskId,
    state: ClaimState,
    message: string,
  ): Promise<void> {
    const filePath = this.runtime.messageFile(taskId, state);
    const previous = (await exists(filePath))
      ? await fs.readFile(filePath, "utf-8")
      : "";
    const separator = previous.trim().length === 0 ? "" : "\n\n---\n\n";
    await write(filePath, `${previous}${separator}${message.trim()}\n`);
  }

  async drain(taskId: TaskId, state: ClaimState): Promise<string> {
    const filePath = this.runtime.messageFile(taskId, state);
    if (!(await exists(filePath))) {
      return "";
    }
    const contents = await fs.readFile(filePath, "utf-8");
    await fs.rm(filePath, { force: true });
    return contents.trim();
  }

  queued(taskId: TaskId, state: ClaimState): Promise<boolean> {
    return exists(this.runtime.messageFile(taskId, state));
  }

  async findings(taskId: TaskId): Promise<string[]> {
    const filePath = this.runtime.findings(taskId);
    if (!(await exists(filePath))) {
      return [];
    }
    return parse(
      Findings,
      JSON.parse(await fs.readFile(filePath, "utf-8")),
      "findings",
      filePath,
    );
  }

  async setFindings(taskId: TaskId, findings: string[]): Promise<void> {
    await write(
      this.runtime.findings(taskId),
      `${JSON.stringify(findings, null, 2)}\n`,
    );
  }

  async clearFindings(taskId: TaskId): Promise<void> {
    await fs.rm(this.runtime.findings(taskId), { force: true });
  }

  async failures(taskId: TaskId): Promise<number> {
    const filePath = this.runtime.reviewFailures(taskId);
    if (!(await exists(filePath))) {
      return 0;
    }
    const contents = (await fs.readFile(filePath, "utf-8")).trim();
    const count = Number.parseInt(contents, 10);
    if (!Number.isInteger(count) || count < 0) {
      throw new Error(`${filePath} holds "${contents}", not a failure count`);
    }
    return count;
  }

  async setFailures(taskId: TaskId, failures: number): Promise<void> {
    await write(this.runtime.reviewFailures(taskId), `${failures}\n`);
  }

  async clearFailures(taskId: TaskId): Promise<void> {
    await fs.rm(this.runtime.reviewFailures(taskId), { force: true });
  }

  read(taskId: TaskId): Promise<string> {
    return fs.readFile(this.runtime.assignment(taskId), "utf-8");
  }

  async write(taskId: TaskId, contents: string): Promise<void> {
    await writeAtomic(this.runtime.assignment(taskId), contents);
  }

  exists(taskId: TaskId): Promise<boolean> {
    return exists(this.runtime.assignment(taskId));
  }

  async rotate(taskId: TaskId): Promise<void> {
    await rotate(this.runtime.assignment(taskId), this.runtime.history(taskId));
  }
}
