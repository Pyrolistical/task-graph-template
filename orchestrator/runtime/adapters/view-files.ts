import fs from "node:fs/promises";
import type { Published, Publisher, ViewName } from "../ports/publisher.ts";
import { type DetachedSlot, SlotsViewOfAnyServer } from "../../views/slots.ts";
import { parse } from "../../kernel/domain/schema.ts";
import { exists, writeAtomic } from "../../kernel/adapters/files.ts";
import { Runtime, viewJson } from "./runtime.ts";

export class ViewFiles implements Publisher {
  constructor(private readonly runtime: Runtime) {}

  async publish(published: Published): Promise<void> {
    await writeAtomic(
      this.runtime.slotsView,
      viewJson(published.seq, "slots", published.slots, {
        agents_file: published.agentsFile,
      }),
    );
    await writeAtomic(
      this.runtime.checksView,
      viewJson(published.seq, "checks", published.checks),
    );
    await writeAtomic(
      this.runtime.tasksView,
      viewJson(published.seq, "tasks", published.tasks),
    );
    await writeAtomic(
      this.runtime.inboxView,
      viewJson(published.seq, "inbox", published.inbox),
    );
    await writeAtomic(
      this.runtime.queueView,
      viewJson(published.seq, "queue", published.queue, {
        scheduling: published.scheduling,
      }),
    );
  }

  async read(name: ViewName): Promise<string> {
    const filePath = this.runtime.view(name);
    return (await exists(filePath)) ? fs.readFile(filePath, "utf-8") : "{}";
  }

  async lastSlots(): Promise<DetachedSlot[] | undefined> {
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
