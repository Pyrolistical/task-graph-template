import fs from "node:fs";
import path from "node:path";
import { type TaskMeta, rebuildDocument } from "../domain/task.ts";
import { readTaskFile } from "../adapters/task-store.ts";
import type { Fixture } from "./fixture.ts";
import { Server } from "../app/server.ts";
import { wire } from "../main/compose.ts";

export function startServer(
  options: Parameters<typeof wire>[0],
): Promise<Server> {
  return wire(options).start();
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
  const filePath = path.join(fixture.tasksDir, `${id}.md`);
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
      `the server never reached the expected state in ${ticks} ticks\n${fs.readFileSync(server.runtime.serverLog, "utf-8")}`,
    );
  }
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
  if (!fs.existsSync(server.runtime.agentsView)) {
    return null;
  }
  const view = JSON.parse(fs.readFileSync(server.runtime.agentsView, "utf-8"));
  const busy = view.agents.find(
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
