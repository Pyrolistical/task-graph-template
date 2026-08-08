import type { TaskId } from "../../domain/task.ts";

export interface Reviews {
  findings(taskId: TaskId): string[];
  setFindings(taskId: TaskId, findings: string[]): void;
  clearFindings(taskId: TaskId): void;
  failures(taskId: TaskId): number;
  setFailures(taskId: TaskId, failures: number): void;
  clearFailures(taskId: TaskId): void;
}
