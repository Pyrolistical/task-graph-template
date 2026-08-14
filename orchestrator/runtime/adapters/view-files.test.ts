import { describe, expect } from "bun:test";
import { at, present } from "../../testing/present.ts";
import fs from "node:fs/promises";
import { tempDir, testInTempDirs } from "../../testing/temp-dirs.ts";
import { aSlot } from "../../testing/ports.ts";
import { idleRow } from "../../agents/domain/slots.ts";
import { writeAtomic } from "../../kernel/adapters/files.ts";
import { Runtime } from "./runtime.ts";
import { ViewFiles } from "./view-files.ts";
import type { ViewName } from "../ports/publisher.ts";

async function viewsFor(): Promise<{ runtime: Runtime; publisher: ViewFiles }> {
  const runtime = await Runtime.open(
    "/home/model/project",
    await tempDir("orchestrator-"),
  );
  return { runtime, publisher: new ViewFiles(runtime) };
}

describe("Feature: reading back the slots the last server published", () => {
  testInTempDirs(
    "a runtime directory with no view yet has no last slots",
    async () => {
      // Given a runtime directory that no server has published into
      const { publisher } = await viewsFor();

      // When the last slots are read
      const rows = await publisher.lastSlots();

      // Then there are none, which is how a first start is told apart
      expect(rows).toBeUndefined();
    },
  );

  testInTempDirs(
    "the slots come back as the last publish wrote them",
    async () => {
      // Given a server that published a view of its pool
      const { publisher } = await viewsFor();
      await publisher.publish({
        seq: 1,
        agentsFile: "/tasks/agents.json",
        slots: [idleRow(aSlot(), 1)],
        checks: [],
        tasks: [],
        inbox: [],
        queue: [],
        scheduling: false,
      });

      // When the next server reads the slots back
      const rows = await publisher.lastSlots();

      // Then it gets the rows it needs to reattach to what was running
      expect(rows).toHaveLength(1);
      expect(at(present(rows, "the slots view"), 0).name).toBe(
        "pi-fake-fake-1",
      );
    },
  );

  testInTempDirs("a view file carrying no slots stops the server", async () => {
    // Given a slots view that parses but holds no slots at all
    const { runtime, publisher } = await viewsFor();
    await writeAtomic(runtime.slotsView, '{"seq": 1}');

    // When the next server tries to read it back
    // Then it names the file it could not use, and what was missing from it
    await expect(publisher.lastSlots()).rejects.toThrow(
      /Invalid slots view in .*slots\.json/,
    );

    // Then the file really was there, so this is not the first-start path
    expect(await fs.exists(runtime.slotsView)).toBe(true);
  });

  testInTempDirs(
    "a slots view left by an older server still reattaches",
    async () => {
      // Given a slots view an older server wrote, with keys rows no longer use
      const { runtime, publisher } = await viewsFor();
      const row = { ...idleRow(aSlot(), 1), log: "legacy" };
      await writeAtomic(
        runtime.slotsView,
        `${JSON.stringify(
          {
            at: new Date().toISOString(),
            seq: 4,
            agents_file: "/tasks/agents.json",
            log: "legacy",
            slots: [row],
          },
          undefined,
          2,
        )}\n`,
      );

      // When the next server reads the slots back
      const rows = await publisher.lastSlots();

      // Then it gets the rows, ignoring the keys it no longer knows
      expect(rows).toHaveLength(1);
      expect(at(present(rows, "the slots view"), 0).name).toBe(
        "pi-fake-fake-1",
      );
    },
  );

  testInTempDirs(
    "a slots view written before a row key existed still reattaches",
    async () => {
      // Given a slots view an older server wrote, before rows carried a total
      const { runtime, publisher } = await viewsFor();
      const { total: _total, ...row } = idleRow(aSlot(), 1);
      await writeAtomic(
        runtime.slotsView,
        `${JSON.stringify(
          {
            at: new Date().toISOString(),
            seq: 4,
            agents_file: "/tasks/agents.json",
            slots: [
              { ...row, task_id: "000001", pid: 4321, session: "/sessions/1" },
            ],
          },
          undefined,
          2,
        )}\n`,
      );

      // When the next server reads the slots back
      const rows = await publisher.lastSlots();

      // Then it gets what reattaching needs, and no key it draws with
      const slot = at(present(rows, "the slots view"), 0);
      expect(slot.name).toBe("pi-fake-fake-1");
      expect(slot.pid).toBe(4321);
      expect(slot.task_id).toBe("000001");
      expect(slot.session).toBe("/sessions/1");
      expect(slot).not.toHaveProperty("state");
    },
  );
});

describe("Feature: publishing the views a console reads", () => {
  testInTempDirs(
    "a publish replaces every view the console reads",
    async () => {
      // Given a server that has published once
      const { runtime, publisher } = await viewsFor();
      const views = {
        seq: 1,
        agentsFile: "/tasks/agents.json",
        slots: [idleRow(aSlot(), 1)],
        checks: [],
        tasks: [],
        inbox: [],
        queue: [],
        scheduling: false,
      };
      await publisher.publish(views);

      // When the next publish replaces them
      await publisher.publish({ ...views, seq: 2, scheduling: true });

      // Then every view carries the sequence number of the same publish
      const names: ViewName[] = ["slots", "checks", "tasks", "inbox", "queue"];
      const seqs = await Promise.all(
        names.map(async (name) => {
          const view = JSON.parse(
            await fs.readFile(runtime.view(name), "utf-8"),
          );
          return view.seq as number;
        }),
      );
      expect(seqs).toEqual([2, 2, 2, 2, 2]);
    },
  );
});
