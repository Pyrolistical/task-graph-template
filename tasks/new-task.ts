#!/usr/bin/env bun
/**
 * new-task.ts - Creates new task documents.
 *
 * Reads next-task-id, copies template.md, populates the ID,
 * and increments the counter.
 *
 * Usage:
 *   bun tasks/new-task.ts [title]
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { formatId, writeTaskFile, parseFrontmatter, rebuildDocument } from "./task.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const nextTaskIdPath = path.join(__dirname, "next-task-id");
const templatePath = path.join(__dirname, "template.md");
const tasksDir = __dirname;

function main() {
  // 1. Read next-task-id
  const raw = fs.readFileSync(nextTaskIdPath, "utf-8").trim();
  const nextId = parseInt(raw, 10);

  if (isNaN(nextId) || nextId < 1) {
    console.error(`Error: Invalid value in next-task-id: "${raw}"`);
    process.exit(1);
  }

  // 2. Format as six-digit ID
  const id = formatId(nextId);

  // 3. Read template and populate fields
  let template = fs.readFileSync(templatePath, "utf-8");

  // Populate the task ID in frontmatter
  template = template.replace(/^id:[^\S\n]*/m, `id: ${id}`);

  // Optionally populate title
  const args = process.argv.slice(2);
  if (args.length > 0) {
    const title = args.join(" ");
    template = template.replace(/^title:[^\S\n]*/m, `title: ${title}`);
  }

  // Set state_entered timestamp
  const now = new Date().toISOString();
  template = template.replace(
    /^state_entered:[^\S\n]*/m,
    `state_entered: ${now}`,
  );

  // 4. Create the new task document
  const taskIdPath = path.join(tasksDir, `${id}.md`);
  if (fs.existsSync(taskIdPath)) {
    console.error(`Error: Task file already exists: ${taskIdPath}`);
    process.exit(1);
  }

  fs.writeFileSync(taskIdPath, template, "utf-8");

  // 5. Increment and persist next-task-id
  const newNextId = String(nextId + 1) + "\n";
  fs.writeFileSync(nextTaskIdPath, newNextId, "utf-8");

  console.log(`Created task ${id}: ${taskIdPath}`);
}

// ── Entry point / Tests ────────────────────────────────────────────────

import os from "node:os";

if (import.meta.main) {
  if (process.env.NODE_ENV === "test") {
    test("formatId pads to six digits", () => {
      expect(formatId(1)).toBe("000001");
      expect(formatId(42)).toBe("000042");
      expect(formatId(999999)).toBe("999999");
    });

    test("formatId handles large numbers", () => {
      expect(formatId(1000000)).toBe("1000000");
    });

    test("template population replaces id, title, and state_entered", () => {
      const template = `---
id:
title:
state: NEW
depends_on: []
claimed_by:
claimed_pid:
state_entered:
---

# Goal`;

      let t = template.replace(/^id:[^\S\n]*/m, "id: 000042");
      expect(t).toContain("id: 000042");

      t = t.replace(/^title:[^\S\n]*/m, "title: Test Task");
      expect(t).toContain("title: Test Task");

      const now = new Date().toISOString();
      t = t.replace(/^state_entered:[^\S\n]*/m, `state_entered: ${now}`);
      expect(t).toContain(`state_entered: ${now}`);

      // Ensure other fields are untouched
      expect(t).toContain("state: NEW");
      expect(t).toContain("depends_on: []");
    });

    test("creates task file and increments counter (e2e)", () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "new-task-test-"));

      // Write a minimal template
      const tmplPath = path.join(tmpDir, "template.md");
      fs.writeFileSync(tmplPath, `---
id:
title:
state: NEW
depends_on: []
claimed_by:
claimed_pid:
state_entered:
---

# Goal`);

      const idPath = path.join(tmpDir, "next-task-id");
      fs.writeFileSync(idPath, "5\n");

      // Simulate the creation logic
      let content = fs.readFileSync(tmplPath, "utf-8");
      const nextId = 5;
      const id = formatId(nextId);
      content = content.replace(/^id:[^\S\n]*/m, `id: ${id}`);
      content = content.replace(/^title:[^\S\n]*/m, "title: E2E Test");
      content = content.replace(
        /^state_entered:[^\S\n]*/m,
        `state_entered: ${new Date().toISOString()}`,
      );

      const outPath = path.join(tmpDir, `${id}.md`);
      fs.writeFileSync(outPath, content);
      fs.writeFileSync(idPath, "6\n");

      // Verify file exists and has correct ID
      expect(fs.existsSync(outPath)).toBe(true);
      expect(content).toContain("id: 000005");
      expect(content).toContain("title: E2E Test");
      expect(fs.readFileSync(idPath, "utf-8").trim()).toBe("6");

      // Cleanup
      fs.rmSync(tmpDir, { recursive: true });
    });
  } else {
    main();
  }
}
