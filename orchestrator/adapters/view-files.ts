import fs from "node:fs/promises";
import type { Publisher, ViewName, Views } from "../app/ports/publisher.ts";
import { type SlotRow, SlotsViewOfAnyServer } from "../domain/agents.ts";
import { parse } from "../domain/schema.ts";
import { exists, writeAtomic } from "./files.ts";
import { Runtime, viewJson } from "./runtime.ts";

export class ViewFiles implements Publisher {
  constructor(private readonly runtime: Runtime) {}

  async publish(views: Views): Promise<void> {
    await writeAtomic(
      this.runtime.slotsView,
      viewJson(views.seq, "slots", views.slots, {
        agents_file: views.agentsFile,
      }),
    );
    await writeAtomic(
      this.runtime.checksView,
      viewJson(views.seq, "checks", views.checks),
    );
    await writeAtomic(
      this.runtime.tasksView,
      viewJson(views.seq, "tasks", views.tasks),
    );
    await writeAtomic(
      this.runtime.inboxView,
      viewJson(views.seq, "inbox", views.inbox),
    );
    await writeAtomic(
      this.runtime.queueView,
      viewJson(views.seq, "queue", views.queue, {
        scheduling: views.scheduling,
      }),
    );
  }

  async read(name: ViewName): Promise<string> {
    const filePath = this.runtime.view(name);
    return (await exists(filePath)) ? fs.readFile(filePath, "utf-8") : "{}";
  }

  async lastSlots(): Promise<SlotRow[] | undefined> {
    if (!(await exists(this.runtime.slotsView))) {
      return undefined;
    }
    const view = parse(
      SlotsViewOfAnyServer,
      JSON.parse(await fs.readFile(this.runtime.slotsView, "utf-8")),
      "slots view",
      this.runtime.slotsView,
    );
    return view.slots;
  }

  log(line: string): Promise<void> {
    return this.runtime.log(line);
  }
}
