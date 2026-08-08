import fs from "node:fs";
import path from "node:path";
import { tempDir } from "./temp-dirs.ts";
import {
  type TaskMeta,
  parseDocument,
  rebuildDocument,
  splitDocument,
} from "../domain/task.ts";
import {
  activeTaskPath,
  createTask,
  nextTaskIdPath,
  readTaskFile,
} from "../adapters/task-store.ts";
import {
  type TransitionArgs,
  type TransitionName,
  type TransitionResult,
} from "../domain/state-machine.ts";
import { applyTransition } from "../adapters/transition-store.ts";
import { type ClaimArgs, clearClaim, takeClaim } from "../adapters/claim.ts";
import { ORCHESTRATOR_DIR } from "./orchestrator-jig.ts";

export { ORCHESTRATOR_DIR };

export const TEMPLATE_PATH = path.join(ORCHESTRATOR_DIR, "template.md");
export const TASK_STORE_PATH = path.join(
  ORCHESTRATOR_DIR,
  "adapters",
  "task-store.ts",
);

export function makeTasksDir(): string {
  const dir = tempDir("task-graph-");
  fs.writeFileSync(nextTaskIdPath(dir), "1\n");
  return dir;
}

export function bodyOf(filePath: string): string {
  return splitDocument(fs.readFileSync(filePath, "utf-8")).body;
}

export async function deadPid(): Promise<number> {
  const proc = Bun.spawn(["true"]);
  await proc.exited;
  return proc.pid;
}

export function baseMeta(overrides: Partial<TaskMeta> = {}): TaskMeta {
  return {
    id: "000042",
    title: "A task",
    state: "NEW",
    state_entered: "2026-07-27T12:00:00Z",
    depends_on: [],
    claimed_by: null,
    claimed_pid: null,
    held_reason: null,
    workspace: null,
    checks: [],
    ...overrides,
  };
}

export function raw(meta: TaskMeta): Record<string, unknown> {
  return parseDocument(rebuildDocument(meta, "\n\n# Goal\n")).raw;
}

export function writeTask(dir: string, overrides: Partial<TaskMeta>): string {
  const meta = baseMeta(overrides);
  fs.writeFileSync(
    activeTaskPath(dir, meta.id),
    rebuildDocument(meta, "\n\n# Goal\n"),
  );

  const highest = fs
    .readdirSync(dir)
    .filter((f) => /^\d{6}\.md$/.test(f))
    .reduce((max, f) => Math.max(max, Number.parseInt(f, 10)), 0);
  fs.writeFileSync(nextTaskIdPath(dir), `${highest + 1}\n`);

  return meta.id;
}

export function editTask(
  dir: string,
  id: string,
  edit: (meta: TaskMeta) => void,
): void {
  const filePath = activeTaskPath(dir, id);
  const { meta, body } = readTaskFile(filePath);
  edit(meta);
  fs.writeFileSync(filePath, rebuildDocument(meta, body));
}

export function addDeps(dir: string, id: string, ...deps: string[]): void {
  editTask(dir, id, (meta) => {
    for (const dep of deps) {
      if (!meta.depends_on.includes(dep)) {
        meta.depends_on.push(dep);
      }
    }
  });
}

export function shape(name: TransitionName, extra: string[]): TransitionArgs {
  const rest = (from: number) => extra.slice(from).join(" ");

  switch (name) {
    case "hold":
      return { reason: rest(0) };
    case "feedback":
      return { findings: extra };
    case "submit":
      return { body: extra.length === 0 ? "\n\n# Goal\n" : rest(0) };
    default:
      return {};
  }
}

export function run(
  dir: string,
  id: string,
  name: TransitionName,
  ...extra: string[]
) {
  return applyTransition(dir, id, name, shape(name, extra));
}

export function claim(
  dir: string,
  id: string,
  agentName: string,
  pid: number = process.pid,
  workspace: Omit<ClaimArgs, "agentName" | "pid"> = {},
): void {
  takeClaim(dir, id, { agentName, pid, ...workspace });
}

export function unclaim(dir: string, id: string): void {
  clearClaim(dir, id);
}

export function metaOf(dir: string, id: string) {
  return readTaskFile(activeTaskPath(dir, id)).meta;
}

export function newTask(title = "a task"): { dir: string; id: string } {
  const dir = makeTasksDir();
  return { dir, id: createTask(dir, ORCHESTRATOR_DIR, title).id };
}

export function newTasks(count: number): { dir: string; ids: string[] } {
  const dir = makeTasksDir();
  const ids = Array.from(
    { length: count },
    (_, i) => createTask(dir, ORCHESTRATOR_DIR, `task ${i}`).id,
  );
  return { dir, ids };
}

export function toDesign(): { dir: string; id: string } {
  const { dir, id } = newTask();
  run(dir, id, "submit");
  return { dir, id };
}

export function toDesignReview(): { dir: string; id: string } {
  const { dir, id } = toDesign();
  claim(dir, id, "designer");
  run(dir, id, "submit");
  claim(dir, id, "design-reviewer");
  return { dir, id };
}

export function toPlan(): { dir: string; id: string } {
  const { dir, id } = toDesignReview();
  run(dir, id, "submit", bodyOf(activeTaskPath(dir, id)));
  return { dir, id };
}

export function toPlanReview(): { dir: string; id: string } {
  const { dir, id } = toPlan();
  claim(dir, id, "planner");
  run(dir, id, "submit");
  claim(dir, id, "plan-reviewer");
  return { dir, id };
}

export function planThrough(): { dir: string; id: string } {
  const { dir, id } = toPlanReview();
  run(dir, id, "submit", bodyOf(activeTaskPath(dir, id)));
  return { dir, id };
}

export function toWorking(): { dir: string; id: string } {
  const { dir, id } = planThrough();
  claim(dir, id, "agent-1");
  return { dir, id };
}

export function toChecking(): { dir: string; id: string } {
  const { dir, id } = toWorking();
  run(dir, id, "submit");
  return { dir, id };
}

export function toAgentReview(): { dir: string; id: string } {
  const { dir, id } = toChecking();
  run(dir, id, "pass");
  claim(dir, id, "reviewer");
  return { dir, id };
}

export function toManagerReview(): { dir: string; id: string } {
  const { dir, id } = toAgentReview();
  run(dir, id, "submit");
  return { dir, id };
}

export function closeTask(dir: string, id: string) {
  run(dir, id, "submit");
  claim(dir, id, "d");
  run(dir, id, "submit");
  claim(dir, id, "dr");
  run(dir, id, "submit");
  claim(dir, id, "p");
  run(dir, id, "submit");
  claim(dir, id, "pr");
  run(dir, id, "submit");
  claim(dir, id, "a");
  run(dir, id, "submit");
  run(dir, id, "pass");
  claim(dir, id, "r");
  run(dir, id, "submit");
  return run(dir, id, "submit");
}

export function closedPath(result: TransitionResult): string {
  if (result.to !== "CLOSED") {
    throw new Error(`the task landed in ${result.to}, not CLOSED`);
  }
  return result.closedPath;
}
