import type { ViewName } from "./ports/publisher.ts";
import type { CreatedTask } from "./ports/tasks.ts";
import type { SlotRow } from "../domain/agents.ts";
import type { TaskId, TaskMeta } from "../domain/task.ts";
import type { EntryName, TransitionResult } from "../domain/state-machine.ts";

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
  enqueue<T>(work: () => Promise<T>): Promise<T>;
  createTask(title: string): Promise<CreatedTask>;
  writeBody(id: TaskId, body: string): Promise<string>;
  tasks(): Promise<Map<TaskId, TaskMeta>>;
  submit(id: TaskId): Promise<TransitionResult>;
  enter(id: TaskId, name: EntryName): Promise<TransitionResult>;
  feedback(
    id: TaskId,
    findings: string[],
    by: string,
  ): Promise<TransitionResult>;
  hold(id: TaskId, reason: string): Promise<TransitionResult>;
  resume(id: TaskId): Promise<TransitionResult>;
  abort(id: TaskId): Promise<TransitionResult>;
  setSchedulerEnabled(enabled: boolean): Promise<void>;
  setAgentEnabled(agent: string, enabled: boolean): Promise<SlotRow[]>;
  abortSlot(name: string): Promise<SlotRow>;
  reloadPrompts(): Promise<string[]>;
  writeViews(): Promise<void>;
  view(name: ViewName): Promise<string>;
  pathReport(): PathReport;
  readonly lastError?: string;
}
