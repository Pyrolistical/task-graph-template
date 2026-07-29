#!/usr/bin/env bun
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  formatId,
  parseDocument,
  parseTaskMeta,
  rebuildDocument,
  withLock,
} from "./task.ts";

export interface CreatedTask {
  id: string;
  filePath: string;
}

export function createTask(tasksDir: string, title: string): CreatedTask {
  if (title.trim().length === 0) {
    throw new Error("A task title is required");
  }

  return withLock(tasksDir, () => {
    const nextTaskIdPath = path.join(tasksDir, "next-task-id");
    const rawNext = fs.readFileSync(nextTaskIdPath, "utf-8").trim();
    const nextId = Number.parseInt(rawNext, 10);

    if (!Number.isInteger(nextId) || nextId < 1) {
      throw new Error(`Invalid value in next-task-id: "${rawNext}"`);
    }

    const id = formatId(nextId);
    const templatePath = path.join(tasksDir, "template.md");
    const { raw, body } = parseDocument(fs.readFileSync(templatePath, "utf-8"));

    raw.id = id;
    raw.title = title.trim();
    raw.state_entered = new Date().toISOString();

    const meta = parseTaskMeta(raw, templatePath);
    const filePath = path.join(tasksDir, `${id}.md`);

    fs.writeFileSync(filePath, rebuildDocument(meta, body), {
      encoding: "utf-8",
      flag: "wx",
    });
    fs.writeFileSync(nextTaskIdPath, `${nextId + 1}\n`, "utf-8");

    return { id, filePath };
  });
}

function main(): void {
  const args = process.argv.slice(2);

  if (args.length === 0) {
    console.error("Usage: bun tasks/create.ts <title>");
    process.exit(1);
  }

  const tasksDir = path.dirname(fileURLToPath(import.meta.url));

  try {
    const { id, filePath } = createTask(tasksDir, args.join(" "));
    console.log(`Created task ${id}: ${filePath}`);
  } catch (err) {
    console.error(`Error: ${(err as Error).message}`);
    process.exit(1);
  }
}

if (import.meta.main) {
  main();
}
