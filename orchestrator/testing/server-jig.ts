import fs from "node:fs/promises";
import {
  type TaskMeta,
  type Workspace,
  rebuildDocument,
  requireSession,
  requireWorkspace,
} from "../domain/task.ts";
import type { Awaitable } from "../domain/awaitable.ts";
import { present } from "./present.ts";
import { activeTaskPath, readTaskFile } from "../adapters/task-store.ts";
import type { Fixture } from "./fixture.ts";
import { Server } from "../app/server.ts";
import { PromptFiles } from "../adapters/prompt-files.ts";
import { Runtime } from "../adapters/runtime.ts";
import { TaskFiles } from "../adapters/task-files.ts";
import { TransitionLog } from "../adapters/transition-log.ts";
import { ORCHESTRATOR_DIR } from "./orchestrator-jig.ts";
import { wire } from "../main/compose.ts";

interface Rig {
  runtime: Runtime;
  prompts: PromptFiles;
}

const RIGS = new WeakMap<Server, Rig>();

export async function startServer(
  options: Parameters<typeof wire>[0],
): Promise<Server> {
  const server = await (await wire(options)).start();
  const orchestratorDir = options.orchestratorDir ?? ORCHESTRATOR_DIR;
  RIGS.set(server, {
    runtime: await Runtime.open(options.repo, options.serverRoot),
    prompts: await PromptFiles.open(
      orchestratorDir,
      options.overridesDir ?? options.tasksDir ?? null,
    ),
  });
  return server;
}

function rigOf(server: Server): Rig {
  const rig = RIGS.get(server);
  if (rig === undefined) {
    throw new Error("the server was not started through the jig");
  }
  return rig;
}

export function pathsOf(server: Server): Runtime {
  return rigOf(server).runtime;
}

export function promptsOf(server: Server): PromptFiles {
  return rigOf(server).prompts;
}

export function transitionsOf(server: Server): Promise<TransitionLog> {
  return TransitionLog.open(pathsOf(server).transitionLog);
}

export function runtimeOf(fixture: Fixture): Promise<Runtime> {
  return Runtime.open(fixture.repo, fixture.serverRoot);
}

export async function filesOf(fixture: Fixture): Promise<TaskFiles> {
  return new TaskFiles(await runtimeOf(fixture));
}

export function serverFor(fixture: Fixture): Promise<Server> {
  return startServer({
    repo: fixture.repo,
    agentsPath: fixture.agentsPath,
    tasksDir: fixture.tasksDir,
    orchestratorDir: fixture.orchestratorDir,
    overridesDir: fixture.overridesDir,
    serverRoot: fixture.serverRoot,
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

export async function settle(server: Server, ticks = 6): Promise<void> {
  for (let i = 0; i < ticks; i++) {
    await server.tick();
    await server.drain();
  }
}

export async function until(
  server: Server,
  done: () => Awaitable<boolean>,
  ticks = 12,
): Promise<void> {
  for (let i = 0; i < ticks && !(await done()); i++) {
    await server.tick();
    await server.drain();
  }
  if (!(await done())) {
    throw new Error(
      `the server never reached the expected state in ${ticks} ticks\n${await fs.readFile(pathsOf(server).serverLog, "utf-8")}`,
    );
  }
}

export async function ticksUntil(
  server: Server,
  done: () => Awaitable<boolean>,
  ticks = 40,
): Promise<void> {
  for (let i = 0; i < ticks && !(await done()); i++) {
    await server.tick();
    await Bun.sleep(25);
  }
  if (!(await done())) {
    throw new Error(
      `the server never reached the expected state in ${ticks} ticks\n${await fs.readFile(pathsOf(server).serverLog, "utf-8")}`,
    );
  }
}

export async function walkTo(
  server: Server,
  id: string,
  state: string,
  ticks = 12,
): Promise<void> {
  await server.setSchedulerEnabled(true);
  await reaches(server, id, state, ticks);
  await server.setSchedulerEnabled(false);
}

export async function settleTo(
  server: Server,
  id: string,
  state: string,
  ticks = 12,
): Promise<void> {
  await walkTo(server, id, state, ticks);
  await server.drain();
}

export async function settleUntil(
  server: Server,
  done: () => Awaitable<boolean>,
  ticks = 12,
): Promise<void> {
  await server.setSchedulerEnabled(true);
  await until(server, done, ticks);
  await server.setSchedulerEnabled(false);
  await server.drain();
}

export async function runOnce(server: Server): Promise<void> {
  await server.setSchedulerEnabled(true);
  await server.tick();
  await server.setSchedulerEnabled(false);
  await server.drain();
}

export async function dispatchOnce(server: Server): Promise<void> {
  await runOnce(server);
  await server.tick();
  await server.drain();
}

export async function reviewCycle(server: Server): Promise<void> {
  await dispatchOnce(server);
  await runOnce(server);
}

export async function reaches(
  server: Server,
  id: string,
  state: string,
  ticks = 12,
): Promise<void> {
  await until(server, async () => (await stateOf(server, id)) === state, ticks);
}

export async function compactionsOf(
  server: Server,
  id: string,
): Promise<number | null> {
  if (!(await fs.exists(pathsOf(server).slotsView))) {
    return null;
  }
  const view = JSON.parse(
    await fs.readFile(pathsOf(server).slotsView, "utf-8"),
  );
  const busy = view.slots.find(
    (agent: { task_id: string | null }) => agent.task_id === id,
  );
  return busy?.compactions ?? null;
}

export async function taskOf(server: Server, id: string): Promise<TaskMeta> {
  const tasks = await server.tasks();
  return present(tasks.get(id), `task "${id}" in the graph`);
}

export async function workspaceOf(
  server: Server,
  id: string,
): Promise<Workspace> {
  return requireWorkspace(await taskOf(server, id));
}

export async function sessionOf(server: Server, id: string): Promise<string> {
  const task = await taskOf(server, id);
  return requireSession(task, requireWorkspace(task));
}

export async function stateOf(server: Server, id: string): Promise<string> {
  return (await server.tasks()).get(id)?.state ?? "CLOSED";
}

export async function holderOf(
  server: Server,
  id: string,
): Promise<string | null> {
  return (await server.tasks()).get(id)?.claimed_by ?? null;
}

export async function claimed(server: Server, id: string): Promise<void> {
  await until(server, async () => (await holderOf(server, id)) !== null);
}

export async function unclaimed(server: Server, id: string): Promise<void> {
  await until(server, async () => (await holderOf(server, id)) === null);
}
