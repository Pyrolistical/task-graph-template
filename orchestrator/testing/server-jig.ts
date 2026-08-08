import fs from "node:fs";
import path from "node:path";
import { type TaskMeta, rebuildDocument } from "../domain/task.ts";
import { activeTaskPath, readTaskFile } from "../adapters/task-store.ts";
import type { Fixture } from "./fixture.ts";
import { Server } from "../app/server.ts";
import { Prompts } from "../adapters/prompts.ts";
import { Runtime } from "../adapters/runtime.ts";
import { TaskFiles } from "../adapters/task-files.ts";
import { TransitionLog } from "../adapters/transition-log.ts";
import { ORCHESTRATOR_DIR } from "./orchestrator-jig.ts";
import { wire } from "../main/compose.ts";

interface Rig {
  runtime: Runtime;
  prompts: Prompts;
}

const RIGS = new WeakMap<Server, Rig>();

export async function startServer(
  options: Parameters<typeof wire>[0],
): Promise<Server> {
  const server = await wire(options).start();
  const orchestratorDir = options.orchestratorDir ?? ORCHESTRATOR_DIR;
  RIGS.set(server, {
    runtime: new Runtime(options.repo, options.serverRoot),
    prompts: new Prompts(
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

export function promptsOf(server: Server): Prompts {
  return rigOf(server).prompts;
}

export function transitionsOf(server: Server): TransitionLog {
  return new TransitionLog(pathsOf(server).transitionLog);
}

export function runtimeOf(fixture: Fixture): Runtime {
  return new Runtime(fixture.repo, fixture.serverRoot);
}

export function filesOf(fixture: Fixture): TaskFiles {
  return new TaskFiles(runtimeOf(fixture));
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

export function editTaskFile(
  fixture: Fixture,
  id: string,
  edit: (meta: TaskMeta) => void,
): void {
  const filePath = activeTaskPath(fixture.tasksDir, id);
  const { meta, body } = readTaskFile(filePath);
  edit(meta);
  fs.writeFileSync(filePath, rebuildDocument(meta, body));
}

export async function settle(server: Server, ticks = 6): Promise<void> {
  for (let i = 0; i < ticks; i++) {
    await server.tick();
    await server.drain();
  }
}

export async function until(
  server: Server,
  done: () => boolean,
  ticks = 12,
): Promise<void> {
  for (let i = 0; i < ticks && !done(); i++) {
    await server.tick();
    await server.drain();
  }
  if (!done()) {
    throw new Error(
      `the server never reached the expected state in ${ticks} ticks\n${fs.readFileSync(pathsOf(server).serverLog, "utf-8")}`,
    );
  }
}

export async function ticksUntil(
  server: Server,
  done: () => boolean,
  ticks = 40,
): Promise<void> {
  for (let i = 0; i < ticks && !done(); i++) {
    await server.tick();
    await Bun.sleep(25);
  }
  if (!done()) {
    throw new Error(
      `the server never reached the expected state in ${ticks} ticks\n${fs.readFileSync(pathsOf(server).serverLog, "utf-8")}`,
    );
  }
}

export async function walkTo(
  server: Server,
  id: string,
  state: string,
  ticks = 12,
): Promise<void> {
  server.setSchedulerEnabled(true);
  await reaches(server, id, state, ticks);
  server.setSchedulerEnabled(false);
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
  done: () => boolean,
  ticks = 12,
): Promise<void> {
  server.setSchedulerEnabled(true);
  await until(server, done, ticks);
  server.setSchedulerEnabled(false);
  await server.drain();
}

export async function runOnce(server: Server): Promise<void> {
  server.setSchedulerEnabled(true);
  await server.tick();
  server.setSchedulerEnabled(false);
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
  await until(server, () => stateOf(server, id) === state, ticks);
}

export function compactionsOf(server: Server, id: string): number | null {
  if (!fs.existsSync(pathsOf(server).slotsView)) {
    return null;
  }
  const view = JSON.parse(fs.readFileSync(pathsOf(server).slotsView, "utf-8"));
  const busy = view.slots.find(
    (agent: { task_id: string | null }) => agent.task_id === id,
  );
  return busy?.compactions ?? null;
}

export function stateOf(server: Server, id: string): string {
  return server.tasks().get(id)?.state ?? "CLOSED";
}

export function holderOf(server: Server, id: string): string | null {
  return server.tasks().get(id)?.claimed_by ?? null;
}

export async function claimed(server: Server, id: string): Promise<void> {
  await until(server, () => holderOf(server, id) !== null);
}

export async function unclaimed(server: Server, id: string): Promise<void> {
  await until(server, () => holderOf(server, id) === null);
}
