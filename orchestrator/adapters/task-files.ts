import fs from "node:fs";
import path from "node:path";
import type { Assignments } from "../app/ports/assignments.ts";
import type { Messages } from "../app/ports/messages.ts";
import type { Reviews } from "../app/ports/reviews.ts";
import type { ClaimState } from "../domain/state-machine.ts";
import type { TaskId } from "../domain/task.ts";
import { Runtime } from "./runtime.ts";

export function historyName(n: number): string {
  return `ASSIGNMENT.${n}.md`;
}

export function attemptOf(historyDir: string): number {
  if (!fs.existsSync(historyDir)) {
    return 1;
  }
  return (
    fs.readdirSync(historyDir).filter((name) => name.startsWith("ASSIGNMENT."))
      .length + 1
  );
}

export function rotate(
  assignmentPath: string,
  historyDir: string,
): string | null {
  if (!fs.existsSync(assignmentPath)) {
    return null;
  }

  fs.mkdirSync(historyDir, { recursive: true });
  const target = path.join(historyDir, historyName(attemptOf(historyDir)));
  fs.renameSync(assignmentPath, target);
  return target;
}

function write(filePath: string, contents: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, contents, "utf-8");
}

export class TaskFiles implements Messages, Reviews, Assignments {
  constructor(private readonly runtime: Runtime) {}

  queue(taskId: TaskId, state: ClaimState, message: string): void {
    const filePath = this.runtime.messageFile(taskId, state);
    const previous = fs.existsSync(filePath)
      ? fs.readFileSync(filePath, "utf-8")
      : "";
    const separator = previous.trim().length === 0 ? "" : "\n\n---\n\n";
    write(filePath, `${previous}${separator}${message.trim()}\n`);
  }

  drain(taskId: TaskId, state: ClaimState): string {
    const filePath = this.runtime.messageFile(taskId, state);
    if (!fs.existsSync(filePath)) {
      return "";
    }
    const contents = fs.readFileSync(filePath, "utf-8");
    fs.rmSync(filePath, { force: true });
    return contents.trim();
  }

  queued(taskId: TaskId, state: ClaimState): boolean {
    return fs.existsSync(this.runtime.messageFile(taskId, state));
  }

  findings(taskId: TaskId): string[] {
    const filePath = this.runtime.findings(taskId);
    if (!fs.existsSync(filePath)) {
      return [];
    }
    return JSON.parse(fs.readFileSync(filePath, "utf-8")) as string[];
  }

  setFindings(taskId: TaskId, findings: string[]): void {
    write(
      this.runtime.findings(taskId),
      `${JSON.stringify(findings, null, 2)}\n`,
    );
  }

  clearFindings(taskId: TaskId): void {
    fs.rmSync(this.runtime.findings(taskId), { force: true });
  }

  failures(taskId: TaskId): number {
    const filePath = this.runtime.reviewFailures(taskId);
    if (!fs.existsSync(filePath)) {
      return 0;
    }
    const contents = fs.readFileSync(filePath, "utf-8").trim();
    const count = Number.parseInt(contents, 10);
    if (!Number.isInteger(count) || count < 0) {
      throw new Error(`${filePath} holds "${contents}", not a failure count`);
    }
    return count;
  }

  setFailures(taskId: TaskId, failures: number): void {
    write(this.runtime.reviewFailures(taskId), `${failures}\n`);
  }

  clearFailures(taskId: TaskId): void {
    fs.rmSync(this.runtime.reviewFailures(taskId), { force: true });
  }

  read(taskId: TaskId): string {
    return fs.readFileSync(this.runtime.assignment(taskId), "utf-8");
  }

  write(taskId: TaskId, contents: string): void {
    fs.writeFileSync(this.runtime.assignment(taskId), contents, "utf-8");
  }

  exists(taskId: TaskId): boolean {
    return fs.existsSync(this.runtime.assignment(taskId));
  }

  rotate(taskId: TaskId): void {
    rotate(this.runtime.assignment(taskId), this.runtime.history(taskId));
  }
}
