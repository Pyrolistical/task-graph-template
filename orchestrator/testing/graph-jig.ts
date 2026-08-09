import fs from "node:fs";
import path from "node:path";
import { tempDir } from "./temp-dirs.ts";
import { present } from "./present.ts";
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
import { applyTransition } from "../adapters/task-documents.ts";
import { clearClaim, takeClaim } from "../adapters/task-documents.ts";
import type { ClaimArgs } from "../app/ports/tasks.ts";
import { ORCHESTRATOR_DIR } from "./orchestrator-jig.ts";

export { ORCHESTRATOR_DIR };

export const TEMPLATE_PATH = path.join(ORCHESTRATOR_DIR, "template.md");
export const TASK_STORE_PATH = path.join(
  ORCHESTRATOR_DIR,
  "adapters",
  "task-store.ts",
);

export async function makeTasksDir(): Promise<string> {
  const dir = await tempDir("task-graph-");
  await fs.promises.writeFile(nextTaskIdPath(dir), "1\n");
  return dir;
}

export async function bodyOf(filePath: string): Promise<string> {
  return splitDocument(await fs.promises.readFile(filePath, "utf-8")).body;
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

export async function writeTask(
  dir: string,
  overrides: Partial<TaskMeta>,
): Promise<string> {
  const meta = baseMeta(overrides);
  await fs.promises.writeFile(
    activeTaskPath(dir, meta.id),
    rebuildDocument(meta, "\n\n# Goal\n"),
  );

  const highest = (await fs.promises.readdir(dir))
    .filter((f) => /^\d{6}\.md$/.test(f))
    .reduce((max, f) => Math.max(max, Number.parseInt(f, 10)), 0);
  await fs.promises.writeFile(nextTaskIdPath(dir), `${highest + 1}\n`);

  return meta.id;
}

export async function editTask(
  dir: string,
  id: string,
  edit: (meta: TaskMeta) => void,
): Promise<void> {
  const filePath = activeTaskPath(dir, id);
  const { meta, body } = readTaskFile(filePath);
  edit(meta);
  await fs.promises.writeFile(filePath, rebuildDocument(meta, body));
}

export async function addDeps(
  dir: string,
  id: string,
  ...deps: string[]
): Promise<void> {
  await editTask(dir, id, (meta) => {
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
  slotName: string,
  pid: number = process.pid,
  workspace: Omit<ClaimArgs, "slotName" | "pid"> = {},
): void {
  takeClaim(dir, id, { slotName, pid, ...workspace });
}

export function unclaim(dir: string, id: string): void {
  clearClaim(dir, id);
}

export function metaOf(dir: string, id: string) {
  return readTaskFile(activeTaskPath(dir, id)).meta;
}

export function enteredAt(dir: string, id: string): number {
  return Date.parse(
    present(metaOf(dir, id).state_entered, `a state_entered stamp on `),
  );
}

export async function newTask(
  title = "a task",
): Promise<{ dir: string; id: string }> {
  const dir = await makeTasksDir();
  return { dir, id: createTask(dir, ORCHESTRATOR_DIR, title).id };
}

export async function newTasks(
  count: number,
): Promise<{ dir: string; ids: string[] }> {
  const dir = await makeTasksDir();
  const ids = Array.from(
    { length: count },
    (_, i) => createTask(dir, ORCHESTRATOR_DIR, `task ${i}`).id,
  );
  return { dir, ids };
}

export async function toDesign(): Promise<{ dir: string; id: string }> {
  const { dir, id } = await newTask();
  run(dir, id, "submit");
  return { dir, id };
}

export async function toDesignReview(): Promise<{ dir: string; id: string }> {
  const { dir, id } = await toDesign();
  claim(dir, id, "designer");
  run(dir, id, "submit");
  claim(dir, id, "design-reviewer");
  return { dir, id };
}

export async function toPlan(): Promise<{ dir: string; id: string }> {
  const { dir, id } = await toDesignReview();
  run(dir, id, "submit", await bodyOf(activeTaskPath(dir, id)));
  return { dir, id };
}

export async function toPlanReview(): Promise<{ dir: string; id: string }> {
  const { dir, id } = await toPlan();
  claim(dir, id, "planner");
  run(dir, id, "submit");
  claim(dir, id, "plan-reviewer");
  return { dir, id };
}

export async function planThrough(): Promise<{ dir: string; id: string }> {
  const { dir, id } = await toPlanReview();
  run(dir, id, "submit", await bodyOf(activeTaskPath(dir, id)));
  return { dir, id };
}

export async function toWorking(): Promise<{ dir: string; id: string }> {
  const { dir, id } = await planThrough();
  claim(dir, id, "agent-1");
  return { dir, id };
}

export async function toChecking(): Promise<{ dir: string; id: string }> {
  const { dir, id } = await toWorking();
  run(dir, id, "submit");
  return { dir, id };
}

export async function toAgentReview(): Promise<{ dir: string; id: string }> {
  const { dir, id } = await toChecking();
  run(dir, id, "pass");
  claim(dir, id, "reviewer");
  return { dir, id };
}

export async function toManagerReview(): Promise<{ dir: string; id: string }> {
  const { dir, id } = await toAgentReview();
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
