import { describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import path from "node:path";
import { groupOf } from "./domain/pattern.ts";

const ROOT = import.meta.dir;

interface Case {
  file: string;
  name: string;
  given: string[];
  when: string[];
  then: string[];
}

async function suites(): Promise<string[]> {
  const found: string[] = [];

  const walk = async (dir: string) => {
    for (const entry of await fs.readdir(dir, {
      withFileTypes: true,
    })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.name.endsWith(".test.ts")) {
        found.push(path.relative(ROOT, full));
      }
    }
  };

  await walk(ROOT);
  return found;
}

async function allCases(): Promise<Case[]> {
  const found: Case[] = [];
  for (const file of await suites()) {
    found.push(...(await cases(file)));
  }
  return found;
}

function stepsOf(comments: RegExpExecArray[], keyword: string): string[] {
  return comments
    .filter((comment) => groupOf(comment, 1) === keyword)
    .map((comment) => groupOf(comment, 2));
}

async function cases(file: string): Promise<Case[]> {
  const source = await fs.readFile(path.join(ROOT, file), "utf-8");
  const blocks = source
    .split(/^ {2}(?:test|testInTempDirs|testInTempDirsIf)\(\s*/m)
    .slice(1);

  return blocks.map((block) => {
    const name = /^"([^"]*)"/.exec(block)?.[1] ?? "(unnamed)";
    const comments = [...block.matchAll(/^\s*\/\/ (Given|When|Then) (.+)$/gm)];
    return {
      file,
      name,
      given: stepsOf(comments, "Given"),
      when: stepsOf(comments, "When"),
      then: stepsOf(comments, "Then"),
    };
  });
}

describe("Feature: behaviour tests are written as Given, When, Then", () => {
  test("every suite in the orchestrator is read by this check", async () => {
    // Given every test file on disk
    const files = await suites();

    // When the tests this check can read are counted against them
    const empty = [];
    for (const file of files) {
      if ((await cases(file)).length === 0) {
        empty.push(file);
      }
    }

    // Then none of them is skipped, so the rules below cover the whole suite
    expect(empty).toEqual([]);
    expect(files.length).toBeGreaterThan(20);
  });

  test("every test states a Given, a When and a Then", async () => {
    // Given every test in the orchestrator
    const all = await allCases();

    // Given there are enough of them for the rule to mean something
    expect(all.length).toBeGreaterThan(400);

    // When each is checked for the three comments
    const incomplete = all
      .filter(
        (one) =>
          one.given.length === 0 ||
          one.when.length === 0 ||
          one.then.length === 0,
      )
      .map((one) => `${one.file}: ${one.name}`);

    // Then none of them is missing one
    expect(incomplete).toEqual([]);
  });

  test("every test has exactly one When, being one behaviour", async () => {
    // Given every test in the orchestrator
    const all = await allCases();

    // When the tests naming more than one behaviour are collected
    const multiple = all
      .filter((one) => one.when.length > 1)
      .map((one) => `${one.file}: ${one.name}`);

    // Then none of them tests two behaviours at once
    expect(multiple).toEqual([]);
  });

  test("every Given, When and Then reads as a sentence about the system", async () => {
    // Given every comment in every suite
    const sentences = (await allCases()).flatMap((one) =>
      [...one.given, ...one.when, ...one.then].map((text) => ({
        text,
        where: `${one.file}: ${one.name}`,
      })),
    );

    // When the ones too short to be a sentence, or written as code, are collected
    const terse = sentences
      .filter(
        (line) =>
          line.text.split(/\s+/).length < 2 ||
          /[(){};=]|\b(expect|const|await)\b/.test(line.text),
      )
      .map((line) => `${line.where} — ${line.text}`);

    // Then every one of them is prose describing behaviour
    expect(terse).toEqual([]);
  });

  test("no test stands for a table of rows", async () => {
    // Given every test file on disk
    const files = await suites();

    // When the suites declaring their tests from a table are collected
    const tabled = [];
    for (const file of files) {
      const source = await fs.readFile(path.join(ROOT, file), "utf-8");
      if (/(?:test|testInTempDirs|testInTempDirsIf)\.each/.test(source)) {
        tabled.push(file);
      }
    }

    // Then none of them does, because a row leaves the Given, When and Then abstract
    expect(tabled).toEqual([]);
  });

  test("every suite names the feature it covers", async () => {
    // Given every test file on disk
    const files = await suites();

    // When each is read for its describe block
    const unnamed = [];
    for (const file of files) {
      const source = await fs.readFile(path.join(ROOT, file), "utf-8");
      if (!/describe\("Feature: /.test(source)) {
        unnamed.push(file);
      }
    }

    // Then each one is introduced as a feature
    expect(unnamed).toEqual([]);
  });
});
