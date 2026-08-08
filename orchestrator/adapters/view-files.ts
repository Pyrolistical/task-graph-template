import fs from "node:fs";
import type { Publisher, ViewName, Views } from "../app/ports/publisher.ts";
import type { SlotRow } from "../domain/agents.ts";
import { Runtime, viewJson, writeAtomic } from "./runtime.ts";

export class ViewFiles implements Publisher {
  constructor(private readonly runtime: Runtime) {}

  publish(views: Views): void {
    writeAtomic(
      this.runtime.slotsView,
      viewJson(views.seq, "slots", views.slots, {
        agents_file: views.agentsFile,
      }),
    );
    writeAtomic(
      this.runtime.checksView,
      viewJson(views.seq, "checks", views.checks),
    );
    writeAtomic(
      this.runtime.tasksView,
      viewJson(views.seq, "tasks", views.tasks),
    );
    writeAtomic(
      this.runtime.inboxView,
      viewJson(views.seq, "inbox", views.inbox),
    );
    writeAtomic(
      this.runtime.queueView,
      viewJson(views.seq, "queue", views.queue, {
        scheduling: views.scheduling,
      }),
    );
  }

  read(name: ViewName): string {
    const filePath = this.runtime.view(name);
    return fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf-8") : "{}";
  }

  lastSlots(): SlotRow[] | null {
    if (!fs.existsSync(this.runtime.slotsView)) {
      return null;
    }
    const view = JSON.parse(
      fs.readFileSync(this.runtime.slotsView, "utf-8"),
    ) as { slots?: SlotRow[] };
    if (!Array.isArray(view.slots)) {
      throw new Error(`${this.runtime.slotsView} has no slots array`);
    }
    return view.slots;
  }

  log(line: string): void {
    this.runtime.log(line);
  }
}
