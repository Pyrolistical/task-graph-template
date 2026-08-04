import { describe, expect } from "bun:test";
import { test } from "./temp.ts";
import fs from "node:fs";
import path from "node:path";
import { SchemaError } from "./schema.ts";
import {
  FIELD_ORDER,
  type TaskMeta,
  createTask,
  detectCycles,
  formatId,
  isValidId,
  parseDocument,
  parseTaskMeta,
  readTaskFile,
  rebuildDocument,
  splitDocument,
  writeTaskBody,
} from "./task.ts";
import {
  ORCHESTRATOR_DIR,
  TASK_PATH,
  TEMPLATE_PATH,
  baseMeta,
  bodyOf,
  makeTasksDir,
  metaOf,
  newTask,
  raw,
  run,
  toWorking,
} from "./graph-jig.ts";

describe("id helpers", () => {
  test("formatId pads to six digits", () => {
    expect(formatId(1)).toBe("000001");
    expect(formatId(42)).toBe("000042");
    expect(formatId(999999)).toBe("999999");
  });

  test("isValidId accepts only six-digit strings", () => {
    expect(isValidId("000001")).toBe(true);
    expect(isValidId("999999")).toBe(true);
    expect(isValidId("1")).toBe(false);
    expect(isValidId("00001")).toBe(false);
    expect(isValidId("0000001")).toBe(false);
    expect(isValidId("abc123")).toBe(false);
    expect(isValidId(42)).toBe(false);
    expect(isValidId(null)).toBe(false);
  });
});

describe("document splitting", () => {
  test("body containing --- separators is preserved verbatim", () => {
    const body = "\n\n# Goal\n\n---\n\n# History\n\n---\n";
    const { frontmatter, body: got } = splitDocument(
      `---\nid: "000001"\n---${body}`,
    );
    expect(frontmatter).toBe(`id: "000001"`);
    expect(got).toBe(body);
  });

  test("a document with no frontmatter is rejected", () => {
    expect(() => splitDocument("# No frontmatter here")).toThrow(
      /no YAML frontmatter/,
    );
  });

  test("the shipped template carries every schema field and only id and title are unfilled", () => {
    const { raw } = parseDocument(fs.readFileSync(TEMPLATE_PATH, "utf-8"));
    expect(Object.keys(raw).sort()).toEqual([...FIELD_ORDER].sort());
    expect(raw.state).toBe("NEW");

    let issues: string[] = [];
    try {
      parseTaskMeta(raw);
    } catch (err) {
      issues = (err as SchemaError).issues;
    }
    expect(issues).toHaveLength(2);
    expect(issues[0]).toStartWith("id:");
    expect(issues[1]).toStartWith("title:");
  });
});

describe("schema", () => {
  test("a valid document round-trips to a fixed point", () => {
    const meta = baseMeta({
      title: "Add: a colon, a $& and a #hash",
      state: "MANAGER_REVIEW",
      depends_on: ["000007", "000008"],
      claimed_by: "reviewer-1",
      claimed_pid: 4242,
      checks: ["bun test"],
    });

    const once = rebuildDocument(meta, "\n\n# Goal\n");
    const reparsed = parseTaskMeta(parseDocument(once).raw);
    const twice = rebuildDocument(reparsed, "\n\n# Goal\n");

    expect(twice).toBe(once);
    expect(reparsed).toEqual(meta);
  });

  test("zero-padded ids survive as strings, not numbers", () => {
    const doc = rebuildDocument(baseMeta({ depends_on: ["000007"] }), "\n");
    expect(doc).toContain('id: "000042"');
    expect(doc).toContain('- "000007"');

    const parsed = parseTaskMeta(parseDocument(doc).raw);
    expect(parsed.id).toBe("000042");
    expect(typeof parsed.id).toBe("string");
    expect(parsed.depends_on[0]).toBe("000007");
  });

  test("an unquoted six-digit id would be read as a number and is rejected", () => {
    const doc = `---\nid: 000042\ntitle: t\nstate: NEW\nstate_entered: null\ndepends_on: []\nclaimed_by: null\nclaimed_pid: null\ntodos: []\nchecks: []\nfailures: []\n---\n`;
    expect(parseDocument(doc).raw.id).toBe(42);
    expect(() => parseTaskMeta(parseDocument(doc).raw)).toThrow(SchemaError);
  });

  test("titles with YAML metacharacters survive a round-trip", () => {
    for (const title of [
      "Add: colon",
      "fix #hash",
      'quote " and \\ backslash',
      "- dash",
      "123",
      "null",
    ]) {
      expect(parseTaskMeta(raw(baseMeta({ title }))).title).toBe(title);
    }
  });

  test("missing and unknown fields are both reported", () => {
    let issues: string[] = [];
    try {
      parseTaskMeta({ id: "000001", nonsense: true });
    } catch (err) {
      issues = (err as SchemaError).issues;
    }
    expect(issues.some((i) => i.includes('Unrecognized key: "nonsense"'))).toBe(
      true,
    );
    expect(issues.some((i) => i.startsWith("state:"))).toBe(true);
    expect(issues.some((i) => i.startsWith("checks:"))).toBe(true);
  });

  test("every violation is reported at once, not just the first", () => {
    try {
      parseTaskMeta({
        ...baseMeta(),
        id: "42",
        title: "",
        state: "BOGUS",
        depends_on: ["x"],
      });
      expect.unreachable();
    } catch (err) {
      expect((err as SchemaError).issues.length).toBeGreaterThanOrEqual(4);
    }
  });

  test("a claim must have both claimed_by and claimed_pid", () => {
    expect(() =>
      parseTaskMeta(raw(baseMeta({ claimed_by: "a", claimed_pid: null }))),
    ).toThrow(SchemaError);
    expect(() =>
      parseTaskMeta(raw(baseMeta({ claimed_by: null, claimed_pid: 12 }))),
    ).toThrow(SchemaError);
  });

  test("check entries reject malformed shapes", () => {
    expect(() => parseTaskMeta({ ...baseMeta(), checks: [""] })).toThrow(
      /checks\[0\]: Too small/,
    );
    expect(() =>
      parseTaskMeta({ ...baseMeta(), checks: [{ command: "bun test" }] }),
    ).toThrow(/checks\[0\]: Invalid input: expected string/);
  });

  test("empty lists serialize as [] and parse back as empty", () => {
    const doc = rebuildDocument(baseMeta(), "\n");
    expect(doc).toContain("depends_on: []");
    expect(doc).toContain("checks: []");
    expect(parseTaskMeta(parseDocument(doc).raw).checks).toEqual([]);
  });

  test("fields are serialized in schema order with state_entered under state", () => {
    const keys = rebuildDocument(baseMeta(), "\n")
      .split("\n")
      .filter((l) => /^\w+:/.test(l))
      .map((l) => l.split(":")[0]);
    expect(keys).toEqual([
      "id",
      "title",
      "state",
      "state_entered",
      "depends_on",
      "claimed_by",
      "claimed_pid",
      "held_reason",
      "workspace",
      "checks",
    ]);
  });
});

describe("detectCycles", () => {
  function graph(edges: Record<string, string[]>): Map<string, TaskMeta> {
    return new Map(
      Object.entries(edges).map(([id, deps]) => [
        id,
        baseMeta({ id, depends_on: deps }),
      ]),
    );
  }

  test("a DAG has no cycles", () => {
    expect(
      detectCycles(
        graph({
          "000001": [],
          "000002": ["000001"],
          "000003": ["000001", "000002"],
        }),
      ),
    ).toEqual([]);
  });

  test("a two-node cycle is found", () => {
    expect(
      detectCycles(
        graph({ "000001": ["000002"], "000002": ["000001"] }),
      ).sort(),
    ).toEqual(["000001", "000002"]);
  });

  test("a three-node cycle is found", () => {
    expect(
      detectCycles(
        graph({
          "000001": ["000003"],
          "000002": ["000001"],
          "000003": ["000002"],
        }),
      ).sort(),
    ).toEqual(["000001", "000002", "000003"]);
  });

  test("dependencies on non-existent tasks are not cycles", () => {
    expect(detectCycles(graph({ "000001": ["999999"] }))).toEqual([]);
  });
});

describe("createTask", () => {
  test("creates a task whose id is quoted and reparses as a string", () => {
    const dir = makeTasksDir();
    const { id, filePath } = createTask(dir, ORCHESTRATOR_DIR, "First task");

    expect(id).toBe("000001");
    expect(fs.readFileSync(filePath, "utf-8")).toContain('id: "000001"');

    const { meta } = readTaskFile(filePath);
    expect(meta.id).toBe("000001");
    expect(typeof meta.id).toBe("string");
    expect(meta.title).toBe("First task");
    expect(meta.state).toBe("NEW");
    expect(meta.state_entered).not.toBeNull();
  });

  test("a title containing regex replacement patterns is stored verbatim", () => {
    const dir = makeTasksDir();
    const title = "Fix $& and $` and $' handling";
    expect(
      readTaskFile(createTask(dir, ORCHESTRATOR_DIR, title).filePath).meta
        .title,
    ).toBe(title);
  });

  test("a title containing YAML metacharacters is stored verbatim", () => {
    const dir = makeTasksDir();
    const title = 'Add: colon, #hash and a "quote"';
    expect(
      readTaskFile(createTask(dir, ORCHESTRATOR_DIR, title).filePath).meta
        .title,
    ).toBe(title);
  });

  test("an empty title is rejected", () => {
    const dir = makeTasksDir();
    expect(() => createTask(dir, ORCHESTRATOR_DIR, "")).toThrow(
      /title is required/,
    );
    expect(() => createTask(dir, ORCHESTRATOR_DIR, "   ")).toThrow(
      /title is required/,
    );
  });

  test("the counter advances and ids never repeat", () => {
    const dir = makeTasksDir();
    const ids = [
      createTask(dir, ORCHESTRATOR_DIR, "a").id,
      createTask(dir, ORCHESTRATOR_DIR, "b").id,
      createTask(dir, ORCHESTRATOR_DIR, "c").id,
    ];

    expect(ids).toEqual(["000001", "000002", "000003"]);
    expect(
      fs.readFileSync(path.join(dir, "next-task-id"), "utf-8").trim(),
    ).toBe("4");
  });

  test("the body is copied from the template unchanged", () => {
    const dir = makeTasksDir();
    const { filePath } = createTask(dir, ORCHESTRATOR_DIR, "t");
    const templateBody = parseDocument(
      fs.readFileSync(TEMPLATE_PATH, "utf-8"),
    ).body;

    expect(parseDocument(fs.readFileSync(filePath, "utf-8")).body).toBe(
      templateBody,
    );
  });

  test("a template.md in the task directory overrides the orchestrator's", () => {
    const dir = makeTasksDir();
    fs.writeFileSync(
      path.join(dir, "template.md"),
      `${fs.readFileSync(TEMPLATE_PATH, "utf-8")}\n## Rollout\n`,
    );
    const { filePath } = createTask(dir, ORCHESTRATOR_DIR, "t");

    expect(fs.readFileSync(filePath, "utf-8")).toContain("## Rollout");
  });

  test("a corrupt next-task-id fails loudly", () => {
    const dir = makeTasksDir();
    fs.writeFileSync(path.join(dir, "next-task-id"), "not-a-number\n");
    expect(() => createTask(dir, ORCHESTRATOR_DIR, "t")).toThrow(
      /Invalid value in next-task-id/,
    );
  });

  test("an existing task file is never overwritten", () => {
    const dir = makeTasksDir();
    createTask(dir, ORCHESTRATOR_DIR, "first");
    fs.writeFileSync(path.join(dir, "next-task-id"), "1\n");

    expect(() => createTask(dir, ORCHESTRATOR_DIR, "collision")).toThrow();
    expect(readTaskFile(path.join(dir, "000001.md")).meta.title).toBe("first");
  });

  test("concurrent creates allocate distinct ids and lose no tasks", async () => {
    const dir = makeTasksDir();
    const count = 8;

    const procs = Array.from({ length: count }, (_, i) =>
      Bun.spawn([
        "bun",
        "-e",
        `const { createTask } = await import(${JSON.stringify(TASK_PATH)});
         createTask(${JSON.stringify(dir)}, ${JSON.stringify(ORCHESTRATOR_DIR)}, "concurrent ${i}");`,
      ]),
    );
    const codes = await Promise.all(procs.map((p) => p.exited));
    expect(codes.every((c) => c === 0)).toBe(true);

    const files = fs
      .readdirSync(dir)
      .filter((f) => /^\d{6}\.md$/.test(f))
      .sort();
    expect(files.length).toBe(count);
    expect(files[0]).toBe("000001.md");
    expect(files.at(-1)).toBe(`${String(count).padStart(6, "0")}.md`);
    expect(
      fs.readFileSync(path.join(dir, "next-task-id"), "utf-8").trim(),
    ).toBe(String(count + 1));

    const titles = files.map(
      (f) =>
        parseTaskMeta(
          parseDocument(fs.readFileSync(path.join(dir, f), "utf-8")).raw,
        ).title,
    );
    expect(new Set(titles).size).toBe(count);
  }, 20000);
});

describe("writeTaskBody", () => {
  test("the body is replaced and the frontmatter is untouched", () => {
    const { dir, id } = toWorking();
    const before = metaOf(dir, id);

    writeTaskBody(dir, id, "# Goal\n\nA rewritten goal.");

    expect(bodyOf(path.join(dir, `${id}.md`))).toBe(
      "\n\n# Goal\n\nA rewritten goal.\n",
    );
    expect(metaOf(dir, id)).toEqual(before);
  });

  test("a body is normalized to one leading blank line and one trailing newline", () => {
    const { dir, id } = newTask();
    writeTaskBody(dir, id, "\n\n\n# Goal\n\n\n");

    expect(bodyOf(path.join(dir, `${id}.md`))).toBe("\n\n# Goal\n");
  });

  test("an empty body is refused and the document is left alone", () => {
    const { dir, id } = newTask();
    const before = fs.readFileSync(path.join(dir, `${id}.md`), "utf-8");

    expect(() => writeTaskBody(dir, id, "   \n ")).toThrow(/body is required/);
    expect(fs.readFileSync(path.join(dir, `${id}.md`), "utf-8")).toBe(before);
  });

  test("an unknown task is refused", () => {
    const dir = makeTasksDir();
    expect(() => writeTaskBody(dir, "000999", "# Goal")).toThrow(/not found/);
  });

  test("a body written under the lock is not lost to a concurrent transition", () => {
    const { dir, id } = toWorking();

    writeTaskBody(dir, id, "# Goal\n\nprose the manager wrote");
    run(dir, id, "hold", "waiting on the manager");

    expect(bodyOf(path.join(dir, `${id}.md`))).toBe(
      "\n\n# Goal\n\nprose the manager wrote\n",
    );
    expect(metaOf(dir, id).held_reason).toBe("waiting on the manager");
  });
});
