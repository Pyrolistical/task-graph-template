import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";

const ROOT = import.meta.dir;

interface Case {
  file: string;
  name: string;
  given: string[];
  when: string[];
  then: string[];
}

function suites(): string[] {
  const found: string[] = [];

  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.name.endsWith(".test.ts")) {
        found.push(path.relative(ROOT, full));
      }
    }
  };

  walk(ROOT);
  return found;
}

function cases(file: string): Case[] {
  const source = fs.readFileSync(path.join(ROOT, file), "utf-8");
  const blocks = source.split(/^ {2}(?:test|testInTempDirs)\(\s*/m).slice(1);

  return blocks.map((block) => {
    const name = /^"([^"]*)"/.exec(block)?.[1] ?? "(unnamed)";
    const comments = [...block.matchAll(/^\s*\/\/ (Given|When|Then) (.+)$/gm)];
    return {
      file,
      name,
      given: comments.filter((c) => c[1] === "Given").map((c) => c[2]!),
      when: comments.filter((c) => c[1] === "When").map((c) => c[2]!),
      then: comments.filter((c) => c[1] === "Then").map((c) => c[2]!),
    };
  });
}

describe("Feature: behaviour tests are written as Given, When, Then", () => {
  test("every suite in the orchestrator is read by this check", () => {
    // Given every test file on disk
    const files = suites();

    // When the tests this check can read are counted against them
    const empty = files.filter((file) => cases(file).length === 0);

    // Then none of them is skipped, so the rules below cover the whole suite
    expect(empty).toEqual([]);
    expect(files.length).toBeGreaterThan(20);
  });

  test("every test states a Given, a When and a Then", () => {
    // Given every test in the orchestrator
    const all = suites().flatMap(cases);

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

  test("every test has exactly one When, being one behaviour", () => {
    // Given every test in the orchestrator
    const all = suites().flatMap(cases);

    // When the tests naming more than one behaviour are collected
    const multiple = all
      .filter((one) => one.when.length > 1)
      .map((one) => `${one.file}: ${one.name}`);

    // Then none of them tests two behaviours at once
    expect(multiple).toEqual([]);
  });

  test("every Given, When and Then reads as a sentence about the system", () => {
    // Given every comment in every suite
    const sentences = suites()
      .flatMap(cases)
      .flatMap((one) =>
        [...one.given, ...one.when, ...one.then].map((text) => ({
          text,
          where: `${one.file}: ${one.name}`,
        })),
      );

    // When the ones too short to be a sentence, or written as code, are collected
    const terse = sentences
      .filter(
        (line) =>
          line.text.split(/\s+/).length < 4 ||
          /[(){};=]|\b(expect|const|await)\b/.test(line.text),
      )
      .map((line) => `${line.where} — ${line.text}`);

    // Then every one of them is prose describing behaviour
    expect(terse).toEqual([]);
  });

  test("every suite names the feature it covers", () => {
    // Given every test file on disk
    const files = suites();

    // When each is read for its describe block
    const unnamed = files.filter(
      (file) =>
        !/describe\("Feature: /.test(
          fs.readFileSync(path.join(ROOT, file), "utf-8"),
        ),
    );

    // Then each one is introduced as a feature
    expect(unnamed).toEqual([]);
  });
});
