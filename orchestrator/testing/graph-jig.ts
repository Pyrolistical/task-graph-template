import fs from "node:fs/promises";
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
  await fs.writeFile(nextTaskIdPath(dir), "1\n");
  return dir;
}

export async function bodyOf(filePath: string): Promise<string> {
  return splitDocument(await fs.readFile(filePath, "utf-8")).body;
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
    claimed_by: undefined,
    claimed_pid: undefined,
    held_reason: undefined,
    workspace: undefined,
    checks: [],
    costs: [],
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
  await fs.writeFile(
    activeTaskPath(dir, meta.id),
    rebuildDocument(meta, "\n\n# Goal\n"),
  );

  const highest = (await fs.readdir(dir))
    .filter((f) => /^\d{6}\.md$/.test(f))
    .reduce((max, f) => Math.max(max, Number.parseInt(f, 10)), 0);
  await fs.writeFile(nextTaskIdPath(dir), `${highest + 1}\n`);

  return meta.id;
}

export async function editTask(
  dir: string,
  id: string,
  edit: (meta: TaskMeta) => void,
): Promise<void> {
  const filePath = activeTaskPath(dir, id);
  const { meta, body } = await readTaskFile(filePath);
  edit(meta);
  await fs.writeFile(filePath, rebuildDocument(meta, body));
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
): Promise<TransitionResult> {
  return applyTransition(dir, id, name, shape(name, extra));
}

export async function claim(
  dir: string,
  id: string,
  slotName: string,
  pid: number = process.pid,
  workspace: Omit<ClaimArgs, "slotName" | "pid"> = {},
): Promise<void> {
  await takeClaim(dir, id, { slotName, pid, ...workspace });
}

export async function unclaim(dir: string, id: string): Promise<void> {
  await clearClaim(dir, id);
}

export async function metaOf(dir: string, id: string): Promise<TaskMeta> {
  return (await readTaskFile(activeTaskPath(dir, id))).meta;
}

export async function enteredAt(dir: string, id: string): Promise<number> {
  return Date.parse(
    present((await metaOf(dir, id)).state_entered, `a state_entered stamp on `),
  );
}

export async function newTask(
  title = "a task",
): Promise<{ dir: string; id: string }> {
  const dir = await makeTasksDir();
  return {
    dir,
    id: (await createTask(dir, ORCHESTRATOR_DIR, title)).id,
  };
}

export async function newTasks(
  count: number,
): Promise<{ dir: string; ids: string[] }> {
  const dir = await makeTasksDir();
  const created = await Promise.all(
    Array.from({ length: count }, (_, i) =>
      createTask(dir, ORCHESTRATOR_DIR, `task ${i}`),
    ),
  );
  return { dir, ids: created.map((task) => task.id) };
}

export async function toDesign(): Promise<{ dir: string; id: string }> {
  const { dir, id } = await newTask();
  await run(dir, id, "submit_designing");
  return { dir, id };
}

export async function toDesignReview(): Promise<{ dir: string; id: string }> {
  const { dir, id } = await toDesign();
  await claim(dir, id, "designer");
  await run(dir, id, "submit");
  await claim(dir, id, "design-reviewer");
  return { dir, id };
}

export async function toPlan(): Promise<{ dir: string; id: string }> {
  const { dir, id } = await toDesignReview();
  await run(dir, id, "submit", await bodyOf(activeTaskPath(dir, id)));
  return { dir, id };
}

export async function toPlanReview(): Promise<{ dir: string; id: string }> {
  const { dir, id } = await toPlan();
  await claim(dir, id, "planner");
  await run(dir, id, "submit");
  await claim(dir, id, "plan-reviewer");
  return { dir, id };
}

export async function planThrough(): Promise<{ dir: string; id: string }> {
  const { dir, id } = await toPlanReview();
  await run(dir, id, "submit", await bodyOf(activeTaskPath(dir, id)));
  return { dir, id };
}

export async function toWorking(): Promise<{ dir: string; id: string }> {
  const { dir, id } = await planThrough();
  await claim(dir, id, "agent-1");
  return { dir, id };
}

export async function toChecking(): Promise<{ dir: string; id: string }> {
  const { dir, id } = await toWorking();
  await run(dir, id, "submit");
  return { dir, id };
}

export async function toAgentReview(): Promise<{ dir: string; id: string }> {
  const { dir, id } = await toChecking();
  await run(dir, id, "pass");
  await claim(dir, id, "reviewer");
  return { dir, id };
}

export async function toManagerReview(): Promise<{ dir: string; id: string }> {
  const { dir, id } = await toAgentReview();
  await run(dir, id, "submit");
  return { dir, id };
}

export async function toClosing(dir: string, id: string): Promise<void> {
  await run(dir, id, "submit_designing");
  await claim(dir, id, "d");
  await run(dir, id, "submit");
  await claim(dir, id, "dr");
  await run(dir, id, "submit");
  await claim(dir, id, "p");
  await run(dir, id, "submit");
  await claim(dir, id, "pr");
  await run(dir, id, "submit");
  await claim(dir, id, "a");
  await run(dir, id, "submit");
  await run(dir, id, "pass");
  await claim(dir, id, "r");
  await run(dir, id, "submit");
}

export async function closeTask(
  dir: string,
  id: string,
): Promise<TransitionResult> {
  await toClosing(dir, id);
  return run(dir, id, "submit");
}

export function closedPath(result: TransitionResult): string {
  if (result.to !== "CLOSED") {
    throw new Error(`the task landed in ${result.to}, not CLOSED`);
  }
  return result.closedPath;
}
