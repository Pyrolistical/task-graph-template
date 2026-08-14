import fs from "node:fs/promises";
import {
  type TaskMeta,
  type Workspace,
  rebuildDocument,
  requireSession,
  requireWorkspace,
} from "../vocabulary/task.ts";
import type { Awaitable } from "../kernel/domain/awaitable.ts";
import { present } from "./present.ts";
import { activeTaskPath, readTaskFile } from "../tasks/adapters/task-store.ts";
import type { Fixture } from "./fixture.ts";
import type { App } from "../main/compose.ts";
import { PromptFiles } from "../prompting/adapters/prompt-files.ts";
import type { Runtime } from "../runtime/adapters/runtime.ts";
import { TaskFiles } from "../runtime/adapters/task-files.ts";
import { TransitionLog } from "../runtime/adapters/transition-log.ts";
import { ORCHESTRATOR_DIR } from "./orchestrator-jig.ts";
import { wire } from "../main/compose.ts";

interface Rig {
  runtime: Runtime;
  prompts: PromptFiles;
}

const RIGS = new WeakMap<App, Rig>();

export async function startServer(
  options: Parameters<typeof wire>[0],
): Promise<App> {
  const app = await wire(options);
  await app.server.start();
  const orchestratorDir = options.orchestratorDir ?? ORCHESTRATOR_DIR;
  RIGS.set(app, {
    runtime: options.runtime,
    prompts: await PromptFiles.open(
      orchestratorDir,
      options.overridesDir ?? options.tasksDir,
    ),
  });
  return app;
}

function rigOf(app: App): Rig {
  const rig = RIGS.get(app);
  if (!rig) {
    throw new Error("the server was not started through the jig");
  }
  return rig;
}

export function pathsOf(app: App): Runtime {
  return rigOf(app).runtime;
}

export function promptsOf(app: App): PromptFiles {
  return rigOf(app).prompts;
}

export function transitionsOf(app: App): Promise<TransitionLog> {
  return TransitionLog.open(pathsOf(app).transitionLog);
}

export function filesOf(fixture: Fixture): TaskFiles {
  return new TaskFiles(fixture.runtime);
}

export function serverFor(fixture: Fixture): Promise<App> {
  return startServer({
    runtime: fixture.runtime,
    agentsPath: fixture.agentsPath,
    tasksDir: fixture.tasksDir,
    orchestratorDir: fixture.orchestratorDir,
    overridesDir: fixture.overridesDir,
    piCommand: fixture.piCommand,
    base: "master",
  });
}

export async function editTaskFile(
  fixture: Fixture,
  id: string,
  edit: (meta: TaskMeta) => void,
): Promise<void> {
  const filePath = activeTaskPath(fixture.tasksDir, id);
  const { meta, body } = await readTaskFile(filePath);
  edit(meta);
  await fs.writeFile(filePath, rebuildDocument(meta, body));
}

export async function settle(app: App, ticks = 6): Promise<void> {
  for (let i = 0; i < ticks; i++) {
    await app.server.tick();
    await app.server.drain();
  }
}

export async function until(
  app: App,
  done: () => Awaitable<boolean>,
  ticks = 12,
): Promise<void> {
  for (let i = 0; i < ticks && !(await done()); i++) {
    await app.server.tick();
    await app.server.drain();
  }
  if (!(await done())) {
    throw new Error(
      `the server never reached the expected state in ${ticks} ticks\n${await fs.readFile(pathsOf(app).serverLog, "utf-8")}`,
    );
  }
}

export async function ticksUntil(
  app: App,
  done: () => Awaitable<boolean>,
  ticks = 40,
): Promise<void> {
  for (let i = 0; i < ticks && !(await done()); i++) {
    await app.server.tick();
    await Bun.sleep(25);
  }
  if (!(await done())) {
    throw new Error(
      `the server never reached the expected state in ${ticks} ticks\n${await fs.readFile(pathsOf(app).serverLog, "utf-8")}`,
    );
  }
}

export async function walkTo(
  app: App,
  id: string,
  state: string,
  ticks = 12,
): Promise<void> {
  await app.dispatcher.setEnabled(true);
  await reaches(app, id, state, ticks);
  await app.dispatcher.setEnabled(false);
}

export async function settleTo(
  app: App,
  id: string,
  state: string,
  ticks = 12,
): Promise<void> {
  await walkTo(app, id, state, ticks);
  await app.server.drain();
}

export async function settleUntil(
  app: App,
  done: () => Awaitable<boolean>,
  ticks = 12,
): Promise<void> {
  await app.dispatcher.setEnabled(true);
  await until(app, done, ticks);
  await app.dispatcher.setEnabled(false);
  await app.server.drain();
}

export async function runOnce(app: App): Promise<void> {
  await app.dispatcher.setEnabled(true);
  await app.server.tick();
  await app.dispatcher.setEnabled(false);
  await app.server.drain();
}

export async function dispatchOnce(app: App): Promise<void> {
  await runOnce(app);
  await app.server.tick();
  await app.server.drain();
}

export async function reviewCycle(app: App): Promise<void> {
  await dispatchOnce(app);
  await runOnce(app);
}

export async function reaches(
  app: App,
  id: string,
  state: string,
  ticks = 12,
): Promise<void> {
  await until(app, async () => (await stateOf(app, id)) === state, ticks);
}

export async function compactionsOf(
  app: App,
  id: string,
): Promise<number | undefined> {
  if (!(await fs.exists(pathsOf(app).slotsView))) {
    return undefined;
  }
  const view = JSON.parse(await fs.readFile(pathsOf(app).slotsView, "utf-8"));
  const busy = view.slots.find(
    (agent: { task_id?: string }) => agent.task_id === id,
  );
  return busy?.compactions;
}

export async function taskOf(app: App, id: string): Promise<TaskMeta> {
  const tasks = await app.graph.list();
  return present(tasks.get(id), `task "${id}" in the graph`);
}

export async function workspaceOf(app: App, id: string): Promise<Workspace> {
  return requireWorkspace(await taskOf(app, id));
}

export async function sessionOf(app: App, id: string): Promise<string> {
  const task = await taskOf(app, id);
  return requireSession(task, requireWorkspace(task));
}

export async function stateOf(app: App, id: string): Promise<string> {
  return (await app.graph.list()).get(id)?.state ?? "CLOSED";
}

export async function holderOf(
  app: App,
  id: string,
): Promise<string | undefined> {
  return (await app.graph.list()).get(id)?.claimed_by;
}

export async function claimed(app: App, id: string): Promise<void> {
  await until(app, async () => Boolean(await holderOf(app, id)));
}

export async function unclaimed(app: App, id: string): Promise<void> {
  await until(app, async () => !(await holderOf(app, id)));
}
