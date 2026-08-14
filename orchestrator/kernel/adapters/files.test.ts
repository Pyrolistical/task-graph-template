import { describe, expect } from "bun:test";
import { tempDir, testInTempDirs } from "../../testing/temp-dirs.ts";
import fs from "node:fs/promises";
import path from "node:path";
import { exists, writeAtomic } from "./files.ts";

describe("Feature: replacing a file without ever showing a half written one", () => {
  testInTempDirs("a published view is never seen half written", async () => {
    // Given a view that has already been published once
    const dir = await tempDir("orchestrator-");
    const target = path.join(dir, "agents.json");
    await writeAtomic(target, '{"agents":[]}');
    // When it is published again
    await writeAtomic(target, '{"agents":[1]}');
    // Then the reader sees the new document whole, with no partial left behind
    expect(await fs.readFile(target, "utf-8")).toBe('{"agents":[1]}');
    expect(await fs.readdir(dir)).toEqual(["agents.json"]);
  });
  testInTempDirs("a failed publish leaves no poison for the next", async () => {
    // Given a path a publish can never land on, because a directory is in the way
    const dir = await tempDir("orchestrator-");
    const target = path.join(dir, "agents.json");
    await fs.mkdir(target);
    // When a publish fails at it, the way is cleared, and the publish is tried again
    await expect(writeAtomic(target, '{"seq":1}')).rejects.toThrow();
    await fs.rmdir(target);
    await writeAtomic(target, '{"seq":2}');
    // Then the same path still publishes whole, with no temp file left behind
    expect(await fs.readFile(target, "utf-8")).toBe('{"seq":2}');
    expect(await fs.readdir(dir)).toEqual(["agents.json"]);
  });
  testInTempDirs(
    "concurrent publishes to one file both land whole",
    async () => {
      // Given a view that has already been published once
      const dir = await tempDir("orchestrator-");
      const target = path.join(dir, "agents.json");
      await writeAtomic(target, "{}");
      // When two publishes race to replace it
      const results = await Promise.allSettled([
        writeAtomic(target, '{"seq":1}'),
        writeAtomic(target, '{"seq":2}'),
      ]);
      // Then both land, without tripping over one another's temp file
      expect(results.every((result) => result.status === "fulfilled")).toBe(
        true,
      );
      expect(['{"seq":1}', '{"seq":2}']).toContain(
        await fs.readFile(target, "utf-8"),
      );
      expect(await fs.readdir(dir)).toEqual(["agents.json"]);
    },
  );
  testInTempDirs(
    "a reader beside a replacement sees one whole version",
    async () => {
      // Given a document long enough that one write is not one syscall
      const dir = await tempDir("orchestrator-");
      const target = path.join(dir, "000001.md");
      const before = "a".repeat(64 * 1024);
      const after = "b".repeat(64 * 1024);
      await writeAtomic(target, before);
      // When a hundred reads are taken while the document is replaced under them
      const torn: string[] = [];
      for (let round = 0; round < 100; round++) {
        const replacing = writeAtomic(target, round % 2 === 0 ? after : before);
        const seen = await fs.readFile(target, "utf-8");
        await replacing;
        if (seen !== before && seen !== after) {
          torn.push(`round ${round} read ${seen.length} bytes of both`);
        }
      }
      // Then not one of them caught the file part way through
      expect(torn).toEqual([]);
    },
  );
  testInTempDirs("a path with nothing at it does not exist", async () => {
    // Given a directory with nothing written in it yet
    const dir = await tempDir("orchestrator-");
    const target = path.join(dir, "absent");
    // When the path is asked for before and after it is written
    const before = await exists(target);
    await writeAtomic(target, "here");
    // Then only the second answer is yes
    expect([before, await exists(target)]).toEqual([false, true]);
  });
});
