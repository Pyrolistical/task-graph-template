import { describe, expect } from "bun:test";
import { present } from "../testing/present.ts";
import fs from "node:fs";
import { tempDir, testInTempDirs } from "../testing/temp-dirs.ts";
import { aSlot } from "../testing/ports.ts";
import { idleRow } from "../domain/agents.ts";
import { Runtime, writeAtomic } from "./runtime.ts";
import { ViewFiles } from "./view-files.ts";

function viewsFor(): { runtime: Runtime; publisher: ViewFiles } {
  const runtime = new Runtime("/home/model/project", tempDir("orchestrator-"));
  return { runtime, publisher: new ViewFiles(runtime) };
}

describe("Feature: reading back the slots the last server published", () => {
  testInTempDirs(
    "a runtime directory with no view yet has no last slots",
    () => {
      // Given a runtime directory that no server has published into
      const { publisher } = viewsFor();

      // When the last slots are read
      const rows = publisher.lastSlots();

      // Then there are none, which is how a first start is told apart
      expect(rows).toBeNull();
    },
  );

  testInTempDirs("the slots come back as the last publish wrote them", () => {
    // Given a server that published a view of its pool
    const { publisher } = viewsFor();
    publisher.publish({
      seq: 1,
      agentsFile: "/tasks/agents.json",
      slots: [idleRow(aSlot())],
      checks: [],
      tasks: [],
      inbox: [],
      queue: [],
      scheduling: false,
    });

    // When the next server reads the slots back
    const rows = publisher.lastSlots();

    // Then it gets the rows it needs to reattach to what was running
    expect(rows).toHaveLength(1);
    expect(present(rows, "the slots view")[0].name).toBe("pi-fake-fake-1");
  });

  testInTempDirs(
    "a view file that is not readable JSON stops the server",
    () => {
      // Given a slots view that was left truncated on disk
      const { runtime, publisher } = viewsFor();
      writeAtomic(runtime.slotsView, '{"slots": [{"name"');

      // When the next server tries to read it back
      // Then it fails, rather than starting as though nothing had been running
      expect(() => publisher.lastSlots()).toThrow();
    },
  );

  testInTempDirs("a view file carrying no slots stops the server", () => {
    // Given a slots view that parses but holds no slots at all
    const { runtime, publisher } = viewsFor();
    writeAtomic(runtime.slotsView, '{"seq": 1}');

    // When the next server tries to read it back
    // Then it names the file it could not use, and what was missing from it
    expect(() => publisher.lastSlots()).toThrow(
      /Invalid slots view in .*slots\.json/,
    );

    // Then the file really was there, so this is not the first-start path
    expect(fs.existsSync(runtime.slotsView)).toBe(true);
  });
});
