import type { CreatedTask, ViewName } from "./ports.ts";
import type { SlotRow } from "../domain/agents.ts";
import type { TaskId, TaskMeta } from "../domain/task.ts";
import type { TransitionResult } from "../domain/state-machine.ts";

export interface PathReport {
  repo: string;
  tasks_dir: string;
  agents_file: string;
  overrides_prompts_dir: string;
  orchestrator_prompts_dir: string;
  runtime_root: string;
  server_log: string;
  transition_log: string;
  console_command: string;
  views: Record<ViewName, string>;
}

export interface Manager {
  createTask(title: string): CreatedTask;
  writeBody(id: TaskId, body: string): string;
  tasks(): Map<TaskId, TaskMeta>;
  submit(id: TaskId): Promise<TransitionResult>;
  feedback(id: TaskId, findings: string[], by: string): TransitionResult;
  hold(id: TaskId, reason: string): TransitionResult;
  resume(id: TaskId): TransitionResult;
  abort(id: TaskId): TransitionResult;
  setSchedulerEnabled(enabled: boolean): void;
  setAgentEnabled(agent: string, enabled: boolean): SlotRow[];
  abortSlot(name: string): SlotRow;
  reloadPrompts(): string[];
  writeViews(): Promise<void>;
  view(name: ViewName): string;
  pathReport(): PathReport;
  readonly lastError: string | null;
}
