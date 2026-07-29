import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createTask } from "./create.ts";
import { buildReport } from "./state.ts";
import {
  CLAIMED_STATES,
  FIELD_ORDER,
  LOCK_FILENAME,
  type TaskMeta,
  TaskSchemaError,
  VALID_STATES,
  type ValidState,
  detectCycles,
  formatId,
  isValidId,
  parseDocument,
  parseTaskMeta,
  readTaskFile,
  rebuildDocument,
  splitDocument,
} from "./task.ts";
import {
  ALLOWED_TRANSITIONS,
  TRANSITION_NAMES,
  type TransitionArgs,
  type TransitionName,
  type TransitionResult,
  applyTransition,
  parseArgs,
} from "./transition.ts";

const TEMPLATE_PATH = path.join(import.meta.dir, "template.md");
const CREATE_PATH = path.join(import.meta.dir, "create.ts");

function makeTasksDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "task-graph-"));
  fs.copyFileSync(TEMPLATE_PATH, path.join(dir, "template.md"));
  fs.writeFileSync(path.join(dir, "next-task-id"), "1\n");
  return dir;
}

function bodyOf(filePath: string): string {
  return splitDocument(fs.readFileSync(filePath, "utf-8")).body;
}

async function deadPid(): Promise<number> {
  const proc = Bun.spawn(["true"]);
  await proc.exited;
  return proc.pid;
}

function baseMeta(overrides: Partial<TaskMeta> = {}): TaskMeta {
  return {
    id: "000042",
    title: "A task",
    state: "NEW",
    state_entered: "2026-07-27T12:00:00Z",
    depends_on: [],
    claimed_by: null,
    claimed_pid: null,
    todos: [],
    checks: [],
    task_graph_updates: [],
    ...overrides,
  };
}

function raw(meta: TaskMeta): Record<string, unknown> {
  return parseDocument(rebuildDocument(meta, "\n\n# Goal\n")).raw;
}

function writeTask(dir: string, overrides: Partial<TaskMeta>): string {
  const meta = baseMeta(overrides);
  fs.writeFileSync(
    path.join(dir, `${meta.id}.md`),
    rebuildDocument(meta, "\n\n# Goal\n"),
  );

  const highest = fs
    .readdirSync(dir)
    .filter((f) => /^\d{6}\.md$/.test(f))
    .reduce((max, f) => Math.max(max, Number.parseInt(f, 10)), 0);
  fs.writeFileSync(path.join(dir, "next-task-id"), `${highest + 1}\n`);

  return meta.id;
}

function run(
  dir: string,
  id: string,
  name: TransitionName,
  ...extra: string[]
) {
  return applyTransition(dir, id, name, parseArgs(name, extra));
}

function metaOf(dir: string, id: string) {
  return readTaskFile(path.join(dir, `${id}.md`)).meta;
}

function newTask(title = "a task"): { dir: string; id: string } {
  const dir = makeTasksDir();
  return { dir, id: createTask(dir, title).id };
}

function newTasks(count: number): { dir: string; ids: string[] } {
  const dir = makeTasksDir();
  const ids = Array.from(
    { length: count },
    (_, i) => createTask(dir, `task ${i}`).id,
  );
  return { dir, ids };
}

function toWorking(): { dir: string; id: string } {
  const { dir, id } = newTask();
  run(dir, id, "noDependencies");
  run(dir, id, "claim", "agent-1", String(process.pid));
  return { dir, id };
}

function toChecking(): { dir: string; id: string } {
  const { dir, id } = toWorking();
  run(dir, id, "submit");
  run(dir, id, "claim", "checker", String(process.pid));
  return { dir, id };
}

function toReviewing(): { dir: string; id: string } {
  const { dir, id } = toChecking();
  run(dir, id, "pass");
  run(dir, id, "claim", "reviewer", String(process.pid));
  return { dir, id };
}

function closeTask(dir: string, id: string) {
  run(dir, id, "noDependencies");
  run(dir, id, "claim", "a", String(process.pid));
  run(dir, id, "submit");
  run(dir, id, "claim", "c", String(process.pid));
  run(dir, id, "pass");
  run(dir, id, "claim", "r", String(process.pid));
  return run(dir, id, "pass");
}

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
    const { raw, body } = parseDocument(
      fs.readFileSync(TEMPLATE_PATH, "utf-8"),
    );
    expect(Object.keys(raw).sort()).toEqual([...FIELD_ORDER].sort());
    expect(raw.state).toBe("NEW");

    let issues: string[] = [];
    try {
      parseTaskMeta(raw);
    } catch (err) {
      issues = (err as TaskSchemaError).issues;
    }
    expect(issues).toHaveLength(2);
    expect(issues[0]).toContain(`"id"`);
    expect(issues[1]).toContain(`"title"`);

    expect(body).toContain("# Goal");
    expect(body).toContain("# Implementation History");
  });
});

describe("schema", () => {
  test("a valid document round-trips to a fixed point", () => {
    const meta = baseMeta({
      title: "Add: a colon, a $& and a #hash",
      state: "REVIEWING",
      depends_on: ["000007", "000008"],
      claimed_by: "reviewer-1",
      claimed_pid: 4242,
      todos: [
        {
          at: "2026-07-27T12:30:00Z",
          message: "fix null",
          done: true,
        },
      ],
      checks: [{ command: "bun test", done: false }],
      task_graph_updates: [
        { op: "add", message: "split parser", done: false },
        { op: "update", task_id: "000007", message: "retarget", done: true },
      ],
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
    const doc = `---\nid: 000042\ntitle: t\nstate: NEW\nstate_entered: null\ndepends_on: []\nclaimed_by: null\nclaimed_pid: null\ntodos: []\nchecks: []\ntask_graph_updates: []\n---\n`;
    expect(parseDocument(doc).raw.id).toBe(42);
    expect(() => parseTaskMeta(parseDocument(doc).raw)).toThrow(
      TaskSchemaError,
    );
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
      issues = (err as TaskSchemaError).issues;
    }
    expect(issues.some((i) => i.includes('unknown field "nonsense"'))).toBe(
      true,
    );
    expect(issues.some((i) => i.includes('missing field "state"'))).toBe(true);
    expect(issues.some((i) => i.includes('missing field "todos"'))).toBe(true);
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
      expect((err as TaskSchemaError).issues.length).toBeGreaterThanOrEqual(4);
    }
  });

  test("a claim must have both claimed_by and claimed_pid", () => {
    expect(() =>
      parseTaskMeta(raw(baseMeta({ claimed_by: "a", claimed_pid: null }))),
    ).toThrow(TaskSchemaError);
    expect(() =>
      parseTaskMeta(raw(baseMeta({ claimed_by: null, claimed_pid: 12 }))),
    ).toThrow(TaskSchemaError);
  });

  test("task graph update ops are discriminated on op", () => {
    expect(() =>
      parseTaskMeta({
        ...baseMeta(),
        task_graph_updates: [
          { op: "add", task_id: "000007", message: "m", done: false },
        ],
      }),
    ).toThrow(/must not have a task_id/);

    for (const op of ["update", "delete"]) {
      expect(() =>
        parseTaskMeta({
          ...baseMeta(),
          task_graph_updates: [{ op, message: "m", done: false }],
        }),
      ).toThrow(/requires a six-digit task_id/);
    }

    const ok = parseTaskMeta({
      ...baseMeta(),
      task_graph_updates: [
        { op: "delete", task_id: "000009", message: "m", done: false },
      ],
    });
    expect(ok.task_graph_updates[0]).toEqual({
      op: "delete",
      task_id: "000009",
      message: "m",
      done: false,
    });
  });

  test("todo and check entries reject malformed shapes", () => {
    expect(() =>
      parseTaskMeta({
        ...baseMeta(),
        todos: [{ at: "nope", message: "m", done: false }],
      }),
    ).toThrow(/todos\[0\]\.at/);
    expect(() =>
      parseTaskMeta({
        ...baseMeta(),
        todos: [
          {
            at: "2026-07-27T12:00:00Z",
            message: "m",
            done: "yes",
          },
        ],
      }),
    ).toThrow(/todos\[0\]\.done/);
    expect(() =>
      parseTaskMeta({ ...baseMeta(), checks: [{ command: "", done: false }] }),
    ).toThrow(/checks\[0\]\.command/);
    expect(() =>
      parseTaskMeta({ ...baseMeta(), checks: [{ command: "x", done: "yes" }] }),
    ).toThrow(/checks\[0\]\.done/);
  });

  test("empty lists serialize as [] and parse back as empty", () => {
    const doc = rebuildDocument(baseMeta(), "\n");
    expect(doc).toContain("depends_on: []");
    expect(doc).toContain("todos: []");
    expect(doc).toContain("checks: []");
    expect(doc).toContain("task_graph_updates: []");
    expect(parseTaskMeta(parseDocument(doc).raw).todos).toEqual([]);
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
      "todos",
      "checks",
      "task_graph_updates",
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
    const { id, filePath } = createTask(dir, "First task");

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
    expect(readTaskFile(createTask(dir, title).filePath).meta.title).toBe(
      title,
    );
  });

  test("a title containing YAML metacharacters is stored verbatim", () => {
    const dir = makeTasksDir();
    const title = 'Add: colon, #hash and a "quote"';
    expect(readTaskFile(createTask(dir, title).filePath).meta.title).toBe(
      title,
    );
  });

  test("an empty title is rejected", () => {
    const dir = makeTasksDir();
    expect(() => createTask(dir, "")).toThrow(/title is required/);
    expect(() => createTask(dir, "   ")).toThrow(/title is required/);
  });

  test("the counter advances and ids never repeat", () => {
    const dir = makeTasksDir();
    const ids = [
      createTask(dir, "a").id,
      createTask(dir, "b").id,
      createTask(dir, "c").id,
    ];

    expect(ids).toEqual(["000001", "000002", "000003"]);
    expect(
      fs.readFileSync(path.join(dir, "next-task-id"), "utf-8").trim(),
    ).toBe("4");
  });

  test("the body is copied from the template unchanged", () => {
    const dir = makeTasksDir();
    const { filePath } = createTask(dir, "t");
    const templateBody = parseDocument(
      fs.readFileSync(path.join(dir, "template.md"), "utf-8"),
    ).body;

    expect(parseDocument(fs.readFileSync(filePath, "utf-8")).body).toBe(
      templateBody,
    );
  });

  test("a corrupt next-task-id fails loudly", () => {
    const dir = makeTasksDir();
    fs.writeFileSync(path.join(dir, "next-task-id"), "not-a-number\n");
    expect(() => createTask(dir, "t")).toThrow(/Invalid value in next-task-id/);
  });

  test("an existing task file is never overwritten", () => {
    const dir = makeTasksDir();
    createTask(dir, "first");
    fs.writeFileSync(path.join(dir, "next-task-id"), "1\n");

    expect(() => createTask(dir, "collision")).toThrow();
    expect(readTaskFile(path.join(dir, "000001.md")).meta.title).toBe("first");
  });

  test("concurrent creates allocate distinct ids and lose no tasks", async () => {
    const dir = makeTasksDir();
    const count = 8;

    const procs = Array.from({ length: count }, (_, i) =>
      Bun.spawn([
        "bun",
        "-e",
        `const { createTask } = await import(${JSON.stringify(CREATE_PATH)});
         createTask(${JSON.stringify(dir)}, "concurrent ${i}");`,
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

describe("transitions: dependencies", () => {
  test("addDependencies moves NEW to BLOCKED then self-loops", () => {
    const { dir, ids } = newTasks(3);
    const [main, first, second] = ids as [string, string, string];

    expect(run(dir, main, "addDependencies", first).to).toBe("BLOCKED");
    expect(run(dir, main, "addDependencies", second).to).toBeNull();
    expect(metaOf(dir, main).depends_on).toEqual([first, second]);
  });

  test("duplicate dependencies are not added twice", () => {
    const { dir, ids } = newTasks(2);
    const [main, dep] = ids as [string, string];

    run(dir, main, "addDependencies", dep);
    run(dir, main, "addDependencies", dep);
    expect(metaOf(dir, main).depends_on).toEqual([dep]);
  });

  test("a task cannot depend on itself", () => {
    const { dir, id } = newTask();
    expect(() => run(dir, id, "addDependencies", id)).toThrow(
      /cannot depend on itself/,
    );
  });

  test("a dependency on a task that does not exist is refused", () => {
    const { dir, id } = newTask();
    expect(() => run(dir, id, "addDependencies", "000999")).toThrow(
      /Task "000999" does not exist/,
    );
    expect(metaOf(dir, id).depends_on).toEqual([]);
    expect(metaOf(dir, id).state).toBe("NEW");
  });

  test("a dependency on a closed task is refused", () => {
    const { dir, ids } = newTasks(2);
    const [main, dep] = ids as [string, string];

    closeTask(dir, dep);
    expect(() => run(dir, main, "addDependencies", dep)).toThrow(/is CLOSED/);
  });

  test("a rejected dependency in a batch leaves none of the batch applied", () => {
    const { dir, ids } = newTasks(2);
    const [main, dep] = ids as [string, string];

    expect(() => run(dir, main, "addDependencies", dep, "000999")).toThrow(
      /does not exist/,
    );
    expect(metaOf(dir, main).depends_on).toEqual([]);
    expect(metaOf(dir, main).state).toBe("NEW");
  });

  test("removeDependencies self-loops until the last dependency goes", () => {
    const { dir, ids } = newTasks(3);
    const [main, first, second] = ids as [string, string, string];

    run(dir, main, "addDependencies", first, second);
    expect(run(dir, main, "removeDependencies", first).to).toBeNull();
    expect(run(dir, main, "removeDependencies", second).to).toBe("READY_WORK");
  });

  test("removeDependencies can clear a reference to a task that is gone", () => {
    const dir = makeTasksDir();
    const main = writeTask(dir, {
      id: "000001",
      state: "BLOCKED",
      depends_on: ["000999"],
    });

    expect(run(dir, main, "removeDependencies", "000999").to).toBe(
      "READY_WORK",
    );
    expect(metaOf(dir, main).depends_on).toEqual([]);
  });

  test("noDependencies refuses while dependencies remain", () => {
    const { dir, ids } = newTasks(2);
    const [main, dep] = ids as [string, string];

    run(dir, main, "addDependencies", dep);
    expect(() => run(dir, main, "noDependencies")).toThrow(
      /not valid from state "BLOCKED"/,
    );
  });

  test("malformed dependency ids are rejected", () => {
    expect(() => parseArgs("addDependencies", ["42"])).toThrow(/six-digit/);
  });
});

describe("transitions: claim and release", () => {
  test("claim records the agent and pid", () => {
    const { dir, id } = newTask();
    run(dir, id, "noDependencies");
    expect(run(dir, id, "claim", "agent-1", "4242").to).toBe("WORKING");

    const meta = metaOf(dir, id);
    expect(meta.claimed_by).toBe("agent-1");
    expect(meta.claimed_pid).toBe(4242);
  });

  test("a claimed task cannot be claimed again", () => {
    const { dir, id } = toWorking();
    expect(() => run(dir, id, "claim", "agent-2", String(process.pid))).toThrow(
      /not valid from state "WORKING"/,
    );
  });

  test("release refuses while the claiming process is alive", () => {
    const { dir, id } = toWorking();
    expect(() => run(dir, id, "release")).toThrow(
      /still claimed by a live process/,
    );
  });

  test("release recovers a dead claim and clears it", async () => {
    const { dir, id } = newTask();
    run(dir, id, "noDependencies");
    run(dir, id, "claim", "dead-agent", String(await deadPid()));

    expect(run(dir, id, "release").to).toBe("READY_WORK");

    const meta = metaOf(dir, id);
    expect(meta.claimed_by).toBeNull();
    expect(meta.claimed_pid).toBeNull();
  });

  test("release returns a dead CHECKING claim to READY_CHECK", async () => {
    const { dir, id } = toChecking();
    const filePath = path.join(dir, `${id}.md`);
    fs.writeFileSync(
      filePath,
      fs
        .readFileSync(filePath, "utf-8")
        .replace(/claimed_pid: \d+/, `claimed_pid: ${await deadPid()}`),
    );
    expect(run(dir, id, "release").to).toBe("READY_CHECK");
  });

  test("an invalid pid is rejected", () => {
    expect(() => parseArgs("claim", ["agent", "not-a-pid"])).toThrow(
      /Invalid PID/,
    );
  });
});

describe("transitions: todos", () => {
  test("addTodo from CHECKING sends the task back to READY_WORK", () => {
    const { dir, id } = toChecking();
    expect(run(dir, id, "addTodo", "fix null handling").to).toBe("READY_WORK");

    const todo = metaOf(dir, id).todos[0]!;
    expect(todo.message).toBe("fix null handling");
    expect(todo.done).toBe(false);
  });

  test("addTodo from REVIEWING sends the task back to READY_WORK", () => {
    const { dir, id } = toReviewing();
    expect(run(dir, id, "addTodo", "restructure the parser").to).toBe(
      "READY_WORK",
    );
    expect(metaOf(dir, id).todos[0]!.message).toBe("restructure the parser");
  });

  test("addTodo self-loops in READY_WORK and WORKING so more can be filed", () => {
    const { dir, id } = toChecking();
    run(dir, id, "addTodo", "first");
    expect(run(dir, id, "addTodo", "second").to).toBeNull();
    run(dir, id, "claim", "agent-1", String(process.pid));
    expect(run(dir, id, "addTodo", "third").to).toBeNull();
    expect(metaOf(dir, id).todos.map((t) => t.message)).toEqual([
      "first",
      "second",
      "third",
    ]);
  });

  test("addTodo self-loops in NEW while the task is still being filled in", () => {
    const { dir, id } = newTask();
    expect(run(dir, id, "addTodo", "written up front").to).toBeNull();
    expect(metaOf(dir, id).state).toBe("NEW");

    run(dir, id, "noDependencies");
    expect(metaOf(dir, id).todos.map((t) => t.message)).toEqual([
      "written up front",
    ]);
  });

  test("submit is refused while a todo is open", () => {
    const { dir, id } = toWorking();
    run(dir, id, "addTodo", "unfinished");
    expect(() => run(dir, id, "submit")).toThrow(/1 open todo/);
  });

  test("doneTodo marks by index and unblocks submit", () => {
    const { dir, id } = toWorking();
    run(dir, id, "addTodo", "a");
    run(dir, id, "addTodo", "b");
    run(dir, id, "doneTodo", "0");
    expect(() => run(dir, id, "submit")).toThrow(/1 open todo/);
    run(dir, id, "doneTodo", "1");
    expect(run(dir, id, "submit").to).toBe("READY_CHECK");
    expect(metaOf(dir, id).todos.every((t) => t.done)).toBe(true);
  });

  test("doneTodo rejects an out-of-range or already-done index", () => {
    const { dir, id } = toWorking();
    run(dir, id, "addTodo", "a");
    expect(() => run(dir, id, "doneTodo", "1")).toThrow(/out of range/);
    run(dir, id, "doneTodo", "0");
    expect(() => run(dir, id, "doneTodo", "0")).toThrow(/already done/);
  });

  test("doneTodo on an empty list says there is nothing to mark", () => {
    const { dir, id } = toWorking();
    expect(() => run(dir, id, "doneTodo", "0")).toThrow(/no todo entries/);
  });

  test("todos are never cleared, so the record survives to close", () => {
    const { dir, id } = toChecking();
    run(dir, id, "addTodo", "keep me");
    run(dir, id, "claim", "agent-1", String(process.pid));
    run(dir, id, "doneTodo", "0");
    run(dir, id, "submit");
    run(dir, id, "claim", "checker", String(process.pid));
    run(dir, id, "pass");
    run(dir, id, "claim", "reviewer", String(process.pid));
    const { closedPath } = run(dir, id, "pass");

    expect(readTaskFile(closedPath!).meta.todos[0]!.message).toBe("keep me");
  });
});

describe("transitions: checks", () => {
  test("addCheck self-loops and rejects duplicates", () => {
    const { dir, id } = toWorking();
    expect(run(dir, id, "addCheck", "bun test").to).toBeNull();
    expect(() => run(dir, id, "addCheck", "bun test")).toThrow(
      /already has check/,
    );
    expect(metaOf(dir, id).checks).toEqual([
      { command: "bun test", done: false },
    ]);
  });

  test("addCheck self-loops in NEW and the checks survive into READY_WORK", () => {
    const { dir, id } = newTask();
    expect(run(dir, id, "addCheck", "bun test").to).toBeNull();
    expect(metaOf(dir, id).state).toBe("NEW");

    expect(run(dir, id, "noDependencies").to).toBe("READY_WORK");
    expect(metaOf(dir, id).checks).toEqual([
      { command: "bun test", done: false },
    ]);
  });

  test("pass from CHECKING is refused while a check has not been run", () => {
    const { dir, id } = toWorking();
    run(dir, id, "addCheck", "bun test");
    run(dir, id, "submit");
    run(dir, id, "claim", "checker", String(process.pid));

    expect(() => run(dir, id, "pass")).toThrow(/1 check\(s\) not yet run/);
    run(dir, id, "doneCheck", "0");
    expect(run(dir, id, "pass").to).toBe("READY_REVIEW");
  });

  test("doneCheck rejects an out-of-range or already-done index", () => {
    const { dir, id } = toWorking();
    run(dir, id, "addCheck", "bun test");
    run(dir, id, "submit");
    run(dir, id, "claim", "checker", String(process.pid));

    expect(() => run(dir, id, "doneCheck", "5")).toThrow(/out of range/);
    run(dir, id, "doneCheck", "0");
    expect(() => run(dir, id, "doneCheck", "0")).toThrow(/already done/);
  });

  test("check results reset whenever the task returns to READY_WORK", () => {
    const { dir, id } = toWorking();
    run(dir, id, "addCheck", "bun test");
    run(dir, id, "submit");
    run(dir, id, "claim", "checker", String(process.pid));
    run(dir, id, "doneCheck", "0");
    expect(metaOf(dir, id).checks[0]!.done).toBe(true);

    run(dir, id, "addTodo", "found a bug");
    expect(metaOf(dir, id).state).toBe("READY_WORK");
    expect(metaOf(dir, id).checks[0]!.done).toBe(false);
  });

  test("checks reset when a review sends the task back too", () => {
    const { dir, id } = toWorking();
    run(dir, id, "addCheck", "bun test");
    run(dir, id, "submit");
    run(dir, id, "claim", "checker", String(process.pid));
    run(dir, id, "doneCheck", "0");
    run(dir, id, "pass");
    run(dir, id, "claim", "reviewer", String(process.pid));
    run(dir, id, "addTodo", "needs rework");

    expect(metaOf(dir, id).checks[0]!.done).toBe(false);
  });
});

describe("transitions: task graph updates", () => {
  test("addTaskGraph moves REVIEWING to READY_TASK_GRAPH_UPDATE then self-loops", () => {
    const { dir, id } = toReviewing();
    const target = createTask(dir, "a task to retarget").id;
    const doomed = createTask(dir, "a task to supersede").id;

    expect(run(dir, id, "addTaskGraph", "add", "split the parser").to).toBe(
      "READY_TASK_GRAPH_UPDATE",
    );
    expect(
      run(dir, id, "addTaskGraph", "update", target, "retarget").to,
    ).toBeNull();

    run(dir, id, "claim", "graph-agent", String(process.pid));
    expect(
      run(dir, id, "addTaskGraph", "delete", doomed, "superseded").to,
    ).toBeNull();
    expect(metaOf(dir, id).task_graph_updates.map((u) => u.op)).toEqual([
      "add",
      "update",
      "delete",
    ]);
  });

  test("an update or delete op naming a task that does not exist is refused", () => {
    const { dir, id } = toReviewing();
    expect(() =>
      run(dir, id, "addTaskGraph", "update", "000999", "retarget"),
    ).toThrow(/Task "000999" does not exist/);
    expect(metaOf(dir, id).task_graph_updates).toEqual([]);
    expect(metaOf(dir, id).state).toBe("REVIEWING");
  });

  test("update and delete require a task id, add takes a bare message", () => {
    expect(() => parseArgs("addTaskGraph", ["update", "message only"])).toThrow(
      /six-digit/,
    );
    expect(() => parseArgs("addTaskGraph", ["delete", "nope", "m"])).toThrow(
      /six-digit/,
    );
    expect(parseArgs("addTaskGraph", ["add", "just", "a", "message"])).toEqual({
      op: "add",
      message: "just a message",
    });
    expect(() => parseArgs("addTaskGraph", ["rename", "m"])).toThrow(
      /requires an op/,
    );
  });

  test("doneTaskGraph marks by index and closes only on the last one", () => {
    const { dir, id } = toReviewing();
    run(dir, id, "addTaskGraph", "add", "first");
    run(dir, id, "addTaskGraph", "add", "second");
    run(dir, id, "claim", "graph-agent", String(process.pid));

    expect(run(dir, id, "doneTaskGraph", "1").to).toBeNull();
    const result = run(dir, id, "doneTaskGraph", "0");
    expect(result.to).toBe("CLOSED");
    expect(fs.existsSync(result.closedPath!)).toBe(true);
  });

  test("doneTaskGraph rejects an unknown or negative index", () => {
    const { dir, id } = toReviewing();
    run(dir, id, "addTaskGraph", "add", "only one");
    run(dir, id, "claim", "graph-agent", String(process.pid));

    expect(() => run(dir, id, "doneTaskGraph", "7")).toThrow(/out of range/);
    expect(() => run(dir, id, "doneTaskGraph", "-1")).toThrow(/non-negative/);
  });
});

describe("transitions: closing", () => {
  test("pass from REVIEWING closes the task and moves the file", () => {
    const { dir, id } = toReviewing();
    const result = run(dir, id, "pass");

    expect(result.to).toBe("CLOSED");
    expect(fs.existsSync(path.join(dir, `${id}.md`))).toBe(false);
    expect(fs.existsSync(path.join(dir, "closed", `${id}.md`))).toBe(true);
    expect(readTaskFile(result.closedPath!).meta.state).toBe("CLOSED");
  });

  test("closing removes the id from dependents and unblocks them", () => {
    const dir = makeTasksDir();
    const dep = createTask(dir, "dependency").id;
    const main = createTask(dir, "main").id;

    run(dir, main, "addDependencies", dep);
    expect(metaOf(dir, main).state).toBe("BLOCKED");

    const result = closeTask(dir, dep);

    expect(result.dependentsUpdated).toEqual([main]);
    expect(result.unblocked).toEqual([main]);
    expect(metaOf(dir, main).depends_on).toEqual([]);
    expect(metaOf(dir, main).state).toBe("READY_WORK");
  });

  test("a dependent with other dependencies stays BLOCKED", () => {
    const dir = makeTasksDir();
    const dep = createTask(dir, "dependency").id;
    const other = createTask(dir, "other dependency").id;
    const main = createTask(dir, "main").id;

    run(dir, main, "addDependencies", dep, other);
    const result = closeTask(dir, dep);

    expect(result.unblocked).toEqual([]);
    expect(metaOf(dir, main).state).toBe("BLOCKED");
    expect(metaOf(dir, main).depends_on).toEqual([other]);
  });

  test("a closed task has no further transitions", () => {
    const { dir, id } = toReviewing();
    run(dir, id, "pass");

    for (const name of TRANSITION_NAMES) {
      expect(() => applyTransition(dir, id, name, {})).toThrow(/is CLOSED/);
    }
  });
});

describe("transitions: argument validation", () => {
  function apply(
    dir: string,
    id: string,
    name: TransitionName,
    args: unknown,
  ): TransitionResult {
    return applyTransition(dir, id, name, args as TransitionArgs);
  }

  test("claim rejects a blank agent name and a non-positive pid", () => {
    const { dir, id } = newTask();
    run(dir, id, "noDependencies");

    expect(() => apply(dir, id, "claim", { agentName: "  ", pid: 42 })).toThrow(
      /"agentName" must be a non-empty string/,
    );
    expect(() => apply(dir, id, "claim", { agentName: "a", pid: 0 })).toThrow(
      /"pid" must be a positive integer/,
    );
    expect(() => apply(dir, id, "claim", { agentName: "a", pid: 1.5 })).toThrow(
      /"pid" must be a positive integer/,
    );

    const meta = metaOf(dir, id);
    expect(meta.state).toBe("READY_WORK");
    expect(meta.claimed_by).toBeNull();
    expect(meta.claimed_pid).toBeNull();
  });

  test("addTodo and addCheck reject a blank message and command", () => {
    const { dir, id } = toWorking();

    expect(() => apply(dir, id, "addTodo", { message: "   " })).toThrow(
      /"message" must be a non-empty string/,
    );
    expect(() => apply(dir, id, "addTodo", {})).toThrow(
      /"message" must be a non-empty string/,
    );
    expect(() => apply(dir, id, "addCheck", { command: "" })).toThrow(
      /"command" must be a non-empty string/,
    );

    expect(metaOf(dir, id).todos).toEqual([]);
    expect(metaOf(dir, id).checks).toEqual([]);
  });

  test("doneTodo rejects a negative or fractional index", () => {
    const { dir, id } = toWorking();
    run(dir, id, "addTodo", "a todo");

    expect(() => apply(dir, id, "doneTodo", { index: -1 })).toThrow(
      /"index" must be a non-negative integer/,
    );
    expect(() => apply(dir, id, "doneTodo", { index: 0.5 })).toThrow(
      /"index" must be a non-negative integer/,
    );
    expect(() => apply(dir, id, "doneTodo", {})).toThrow(
      /"index" must be a non-negative integer/,
    );

    expect(metaOf(dir, id).todos[0]!.done).toBe(false);
  });

  test("addDependencies rejects a missing, empty or malformed id list", () => {
    const { dir, id } = newTask();

    expect(() => apply(dir, id, "addDependencies", {})).toThrow(
      /"taskIds" must be a non-empty list/,
    );
    expect(() => apply(dir, id, "addDependencies", { taskIds: [] })).toThrow(
      /"taskIds" must be a non-empty list/,
    );
    expect(() =>
      apply(dir, id, "addDependencies", { taskIds: ["42"] }),
    ).toThrow(/is not a six-digit task ID/);

    const meta = metaOf(dir, id);
    expect(meta.depends_on).toEqual([]);
    expect(meta.state).toBe("NEW");
  });

  test("addTaskGraph rejects an unknown op", () => {
    const { dir, id } = toReviewing();

    expect(() =>
      apply(dir, id, "addTaskGraph", { op: "rename", message: "m" }),
    ).toThrow(/"op" must be one of add, update, delete/);
    expect(metaOf(dir, id).task_graph_updates).toEqual([]);
  });

  test("every rejected argument leaves the document byte-identical", () => {
    const { dir, id } = toWorking();
    const filePath = path.join(dir, `${id}.md`);
    const before = fs.readFileSync(filePath, "utf-8");

    const rejected: [TransitionName, unknown][] = [
      ["addTodo", { message: "" }],
      ["addCheck", { command: "  " }],
      ["doneTodo", { index: -3 }],
    ];
    for (const [name, args] of rejected) {
      expect(() => apply(dir, id, name, args)).toThrow();
    }

    expect(fs.readFileSync(filePath, "utf-8")).toBe(before);
  });
});

describe("transitions: document integrity", () => {
  test("the body is byte-identical after every transition in a full lifecycle", () => {
    const { dir, id } = newTask();
    const filePath = path.join(dir, `${id}.md`);
    const original = bodyOf(filePath);
    expect(original).toContain("# Implementation History");

    const steps: [TransitionName, string[]][] = [
      ["noDependencies", []],
      ["addCheck", ["bun test"]],
      ["addTodo", ["something to do"]],
      ["claim", ["agent-1", String(process.pid)]],
      ["doneTodo", ["0"]],
      ["submit", []],
      ["claim", ["checker", String(process.pid)]],
      ["doneCheck", ["0"]],
      ["pass", []],
      ["claim", ["reviewer", String(process.pid)]],
      ["addTaskGraph", ["add", "follow-up work"]],
      ["claim", ["graph-agent", String(process.pid)]],
    ];

    for (const [name, args] of steps) {
      run(dir, id, name, ...args);
      expect(bodyOf(filePath)).toBe(original);
    }

    const closed = run(dir, id, "doneTaskGraph", "0");
    expect(bodyOf(closed.closedPath!)).toBe(original);
  });

  test("state_entered advances on self-loops as well as real transitions", async () => {
    const { dir, id } = toWorking();

    const beforeSelfLoop = metaOf(dir, id).state_entered;
    await Bun.sleep(5);
    expect(run(dir, id, "addTodo", "self loop").to).toBeNull();

    const afterSelfLoop = metaOf(dir, id).state_entered;
    expect(Date.parse(afterSelfLoop!)).toBeGreaterThan(
      Date.parse(beforeSelfLoop!),
    );

    run(dir, id, "doneTodo", "0");
    const beforeMove = metaOf(dir, id).state_entered;
    await Bun.sleep(5);
    expect(run(dir, id, "submit").to).toBe("READY_CHECK");

    expect(Date.parse(metaOf(dir, id).state_entered!)).toBeGreaterThan(
      Date.parse(beforeMove!),
    );
  });
});

describe("transitions: table", () => {
  test("an unknown task id is reported", () => {
    const dir = makeTasksDir();
    expect(() => run(dir, "000999", "noDependencies")).toThrow(/not found/);
  });

  test("release and claim are inverses across every claimed state", async () => {
    const released: string[] = [];

    for (const state of CLAIMED_STATES) {
      const dir = makeTasksDir();
      const id = writeTask(dir, {
        id: "000001",
        state,
        claimed_by: "dead-agent",
        claimed_pid: await deadPid(),
      });

      const to = run(dir, id, "release").to as ValidState;
      expect(ALLOWED_TRANSITIONS[to]).toContain("claim");
      expect(run(dir, id, "claim", "agent-1", String(process.pid)).to).toBe(
        state,
      );
      released.push(to);
    }

    const claimable = Object.entries(ALLOWED_TRANSITIONS)
      .filter(([, names]) => names.includes("claim"))
      .map(([state]) => state);
    expect(released.sort()).toEqual(claimable.sort());
  });

  test("every state offers at least one transition with no duplicates", () => {
    for (const names of Object.values(ALLOWED_TRANSITIONS)) {
      expect(names.length).toBeGreaterThan(0);
      expect(new Set(names).size).toBe(names.length);
    }
  });
});

describe("state report", () => {
  test("an empty project reports one empty group per state and nothing else", () => {
    const report = buildReport(makeTasksDir());

    const empty = {} as Record<ValidState, string[]>;
    for (const state of VALID_STATES) {
      empty[state] = [];
    }

    expect(report.tasks).toEqual(empty);
    expect(report.open).toEqual({});
    expect(report.problems).toEqual([]);
  });

  test("tasks are grouped by state, and template.md contributes no task", () => {
    const dir = makeTasksDir();
    const a = createTask(dir, "a").id;
    const b = createTask(dir, "b").id;
    const c = createTask(dir, "c").id;
    run(dir, c, "noDependencies");

    const report = buildReport(dir);
    expect(report.tasks.NEW).toEqual([a, b]);
    expect(report.tasks.READY_WORK).toEqual([c]);
    expect(Object.values(report.tasks).flat()).toHaveLength(3);
    expect(Object.keys(report.open)).toEqual([a, b, c]);
    expect(report.problems).toEqual([]);
  });

  test("closing clears the reference, leaving no MissingDependency", () => {
    const dir = makeTasksDir();
    const dep = createTask(dir, "dependency").id;
    const main = createTask(dir, "main").id;

    run(dir, main, "addDependencies", dep);
    closeTask(dir, dep);

    const report = buildReport(dir);
    expect(metaOf(dir, main).depends_on).toEqual([]);
    expect(report.problems).toEqual([]);
    expect(report.tasks.READY_WORK).toEqual([main]);
  });

  test("a reference that outlives the task it names is reported", () => {
    const dir = makeTasksDir();
    const dep = createTask(dir, "dependency").id;
    const main = createTask(dir, "main").id;

    run(dir, main, "addDependencies", dep);
    fs.rmSync(path.join(dir, `${dep}.md`));

    const problems = buildReport(dir).problems;
    expect(problems).toHaveLength(1);
    expect(problems[0]!.type).toBe("MissingDependency");
    expect(problems[0]!.task_id).toBe(main);
  });

  test("a hand-written dependency that never existed is reported", () => {
    const dir = makeTasksDir();
    const id = writeTask(dir, {
      id: "000001",
      state: "BLOCKED",
      depends_on: ["000999"],
    });

    const problems = buildReport(dir).problems;
    expect(problems).toHaveLength(1);
    expect(problems[0]!.type).toBe("MissingDependency");
    expect(problems[0]!.task_id).toBe(id);
  });

  test("a dependency cycle is reported once", () => {
    const dir = makeTasksDir();
    writeTask(dir, { id: "000001", state: "BLOCKED", depends_on: ["000002"] });
    writeTask(dir, { id: "000002", state: "BLOCKED", depends_on: ["000001"] });

    const cycles = buildReport(dir).problems.filter(
      (p) => p.type === "DependencyCycle",
    );
    expect(cycles).toHaveLength(1);
    expect(cycles[0]!.message).toContain("000001, 000002");
    expect(cycles[0]!.task_id).toBeUndefined();
  });

  test("a malformed document is reported without stopping the report", () => {
    const dir = makeTasksDir();
    const good = createTask(dir, "good").id;
    fs.writeFileSync(path.join(dir, "000999.md"), "no frontmatter at all");

    const report = buildReport(dir);
    expect(report.tasks.NEW).toEqual([good]);
    expect(
      report.problems.some((p) => p.type === "MalformedTaskDocument"),
    ).toBe(true);
  });

  test("a schema violation is reported as InvalidMetadata", () => {
    const dir = makeTasksDir();
    fs.writeFileSync(
      path.join(dir, "000001.md"),
      `---\nid: "000001"\ntitle: t\nstate: NONSENSE\nstate_entered: null\ndepends_on: []\nclaimed_by: null\nclaimed_pid: null\ntodos: []\nchecks: []\ntask_graph_updates: []\n---\n`,
    );

    const problems = buildReport(dir).problems;
    expect(problems[0]!.type).toBe("InvalidMetadata");
    expect(problems[0]!.message).toContain("NONSENSE");
  });

  test("a filename that disagrees with the id is reported", () => {
    const dir = makeTasksDir();
    const meta = baseMeta({ id: "000042" });
    fs.writeFileSync(path.join(dir, "000007.md"), rebuildDocument(meta, "\n"));

    const problems = buildReport(dir).problems;
    expect(problems[0]!.type).toBe("MalformedTaskDocument");
    expect(problems[0]!.message).toContain("000042");
  });

  test("BLOCKED with no dependencies is reported", () => {
    const dir = makeTasksDir();
    writeTask(dir, { id: "000001", state: "BLOCKED", depends_on: [] });

    const problems = buildReport(dir).problems;
    expect(problems[0]!.type).toBe("InvalidMetadata");
    expect(problems[0]!.message).toContain("no dependencies");
  });

  test("a claimed state with no claim is reported", () => {
    const dir = makeTasksDir();
    writeTask(dir, {
      id: "000001",
      state: "WORKING",
      claimed_by: null,
      claimed_pid: null,
    });

    const problems = buildReport(dir).problems;
    expect(problems.some((p) => p.type === "InvalidStateTransition")).toBe(
      true,
    );
  });

  test("an unclaimed state holding a claim is reported", () => {
    const dir = makeTasksDir();
    writeTask(dir, {
      id: "000001",
      state: "READY_WORK",
      claimed_by: "ghost",
      claimed_pid: process.pid,
    });

    const problems = buildReport(dir).problems;
    expect(problems.some((p) => p.type === "InvalidStateTransition")).toBe(
      true,
    );
  });

  test("a dead claiming process is reported", async () => {
    const dir = makeTasksDir();
    writeTask(dir, {
      id: "000001",
      state: "WORKING",
      claimed_by: "dead-agent",
      claimed_pid: await deadPid(),
    });

    const problems = buildReport(dir).problems;
    expect(problems.some((p) => p.type === "MissingClaimProcess")).toBe(true);
    expect(
      problems.find((p) => p.type === "MissingClaimProcess")!.message,
    ).toContain("release");
  });

  test("a task past its stuck threshold is reported", () => {
    const dir = makeTasksDir();
    const longAgo = new Date(Date.now() - 20 * 60 * 60 * 1000).toISOString();
    writeTask(dir, {
      id: "000001",
      state: "WORKING",
      state_entered: longAgo,
      claimed_by: "agent-1",
      claimed_pid: process.pid,
    });

    const stuck = buildReport(dir).problems.find((p) => p.type === "StuckTask");
    expect(stuck).toBeDefined();
    expect(stuck!.message).toContain("threshold: 12h");
  });

  test("a task within its threshold is not reported as stuck", () => {
    const dir = makeTasksDir();
    writeTask(dir, {
      id: "000001",
      state: "WORKING",
      state_entered: new Date().toISOString(),
      claimed_by: "agent-1",
      claimed_pid: process.pid,
    });

    expect(buildReport(dir).problems.some((p) => p.type === "StuckTask")).toBe(
      false,
    );
  });

  test("open todo and check counts are reported per task", () => {
    const { dir, id } = toWorking();
    run(dir, id, "addCheck", "bun test");
    run(dir, id, "addCheck", "tsc --noEmit");
    run(dir, id, "addTodo", "one");
    run(dir, id, "addTodo", "two");
    run(dir, id, "doneTodo", "0");

    expect(buildReport(dir).open[id]).toEqual({
      open_todos: 1,
      open_checks: 2,
      open_task_graph_updates: 0,
    });
  });

  test("a CLOSED document left in the active directory is reported", () => {
    const dir = makeTasksDir();
    writeTask(dir, { id: "000001", state: "CLOSED" });

    const problems = buildReport(dir).problems;
    expect(problems[0]!.type).toBe("InvalidMetadata");
    expect(problems[0]!.message).toContain("still in the active directory");
  });
});

describe("state report: tooling blocked", () => {
  test("a lock held by a dead process is reported", async () => {
    const dir = makeTasksDir();
    fs.writeFileSync(path.join(dir, LOCK_FILENAME), `${await deadPid()}\n`);

    const problem = buildReport(dir).problems.find(
      (p) => p.type === "ToolingBlocked",
    );
    expect(problem).toBeDefined();
    expect(problem!.message).toContain("no longer exists");
    expect(problem!.task_id).toBeUndefined();
  });

  test("a lock held by a live process is not reported", () => {
    const dir = makeTasksDir();
    fs.writeFileSync(path.join(dir, LOCK_FILENAME), `${process.pid}\n`);

    expect(buildReport(dir).problems).toEqual([]);
  });

  test("a fresh lock with no recorded pid is tolerated", () => {
    const dir = makeTasksDir();
    fs.writeFileSync(path.join(dir, LOCK_FILENAME), "");

    expect(buildReport(dir).problems).toEqual([]);
  });

  test("an old lock with no recorded pid is reported", () => {
    const dir = makeTasksDir();
    const lock = path.join(dir, LOCK_FILENAME);
    fs.writeFileSync(lock, "");
    const longAgo = new Date(Date.now() - 5 * 60 * 1000);
    fs.utimesSync(lock, longAgo, longAgo);

    const problem = buildReport(dir).problems.find(
      (p) => p.type === "ToolingBlocked",
    );
    expect(problem).toBeDefined();
    expect(problem!.message).toContain("no owning PID");
  });

  test("a counter at or below the highest existing id is reported", () => {
    const dir = makeTasksDir();
    createTask(dir, "a");
    createTask(dir, "b");
    fs.writeFileSync(path.join(dir, "next-task-id"), "2\n");

    const problem = buildReport(dir).problems.find(
      (p) => p.type === "ToolingBlocked",
    );
    expect(problem).toBeDefined();
    expect(problem!.message).toContain("000002 already exists");
  });

  test("the counter check matches the failure it predicts", () => {
    const dir = makeTasksDir();
    createTask(dir, "a");
    fs.writeFileSync(path.join(dir, "next-task-id"), "1\n");

    expect(
      buildReport(dir).problems.some((p) => p.type === "ToolingBlocked"),
    ).toBe(true);
    expect(() => createTask(dir, "collides")).toThrow();
  });

  test("a missing or unparseable counter is reported", () => {
    const dir = makeTasksDir();
    fs.rmSync(path.join(dir, "next-task-id"));
    expect(buildReport(dir).problems[0]!.message).toContain(
      "next-task-id is missing",
    );

    const other = makeTasksDir();
    fs.writeFileSync(path.join(other, "next-task-id"), "banana\n");
    expect(buildReport(other).problems[0]!.message).toContain(
      "not a positive integer",
    );
  });

  test("a completed create releases the lock and leaves no tooling problem", () => {
    const dir = makeTasksDir();
    createTask(dir, "a");

    expect(fs.existsSync(path.join(dir, LOCK_FILENAME))).toBe(false);
    expect(buildReport(dir).problems).toEqual([]);
  });
});

describe("state report: queue invariants", () => {
  test("an open todo downstream of submit is reported", () => {
    const dir = makeTasksDir();
    writeTask(dir, {
      id: "000001",
      state: "READY_REVIEW",
      todos: [
        {
          at: "2026-07-27T12:00:00Z",
          message: "unresolved",
          done: false,
        },
      ],
    });

    const problem = buildReport(dir).problems.find((p) =>
      p.message.includes("open todo"),
    );
    expect(problem).toBeDefined();
    expect(problem!.type).toBe("InvalidMetadata");
    expect(problem!.message).toContain("submit should have blocked this");
  });

  test("an unrun check downstream of pass is reported", () => {
    const dir = makeTasksDir();
    writeTask(dir, {
      id: "000001",
      state: "REVIEWING",
      claimed_by: "reviewer",
      claimed_pid: process.pid,
      checks: [{ command: "bun test", done: false }],
    });

    const problem = buildReport(dir).problems.find((p) =>
      p.message.includes("not yet run"),
    );
    expect(problem).toBeDefined();
    expect(problem!.message).toContain("pass should have blocked this");
  });

  test("a done todo downstream of submit is fine", () => {
    const dir = makeTasksDir();
    writeTask(dir, {
      id: "000001",
      state: "READY_REVIEW",
      todos: [
        {
          at: "2026-07-27T12:00:00Z",
          message: "resolved",
          done: true,
        },
      ],
      checks: [{ command: "bun test", done: true }],
    });

    expect(buildReport(dir).problems).toEqual([]);
  });

  test("a NEW task carrying todos and checks is fine, since NEW is where it is filled in", () => {
    const dir = makeTasksDir();
    writeTask(dir, {
      id: "000001",
      state: "NEW",
      todos: [
        {
          at: "2026-07-27T12:00:00Z",
          message: "early",
          done: false,
        },
      ],
      checks: [{ command: "bun test", done: false }],
    });

    expect(buildReport(dir).problems).toEqual([]);
  });

  test("open task graph updates outside the update states are reported", () => {
    const dir = makeTasksDir();
    writeTask(dir, {
      id: "000001",
      state: "READY_WORK",
      task_graph_updates: [{ op: "add", message: "orphaned", done: false }],
    });

    const problem = buildReport(dir).problems.find((p) =>
      p.message.includes("open task graph update"),
    );
    expect(problem).toBeDefined();
  });

  test("an update state with nothing queued is reported", () => {
    const dir = makeTasksDir();
    writeTask(dir, {
      id: "000001",
      state: "TASK_GRAPH_UPDATING",
      claimed_by: "agent",
      claimed_pid: process.pid,
      task_graph_updates: [],
    });

    const problem = buildReport(dir).problems.find((p) =>
      p.message.includes("no task graph updates queued"),
    );
    expect(problem).toBeDefined();
  });

  test("a task driven through the real transitions violates no queue invariant", () => {
    const { dir, id } = toChecking();
    run(dir, id, "addTodo", "found something");
    run(dir, id, "claim", "agent-1", String(process.pid));
    run(dir, id, "doneTodo", "0");
    run(dir, id, "submit");

    expect(buildReport(dir).problems).toEqual([]);
    expect(buildReport(dir).tasks.READY_CHECK).toEqual([id]);
  });
});

describe("state report: state_entered", () => {
  test("a null state_entered in a stuck-tracked state is reported", () => {
    const dir = makeTasksDir();
    writeTask(dir, {
      id: "000001",
      state: "WORKING",
      state_entered: null,
      claimed_by: "agent",
      claimed_pid: process.pid,
    });

    const problem = buildReport(dir).problems.find((p) =>
      p.message.includes("never be reported as stuck"),
    );
    expect(problem).toBeDefined();
  });

  test("a null state_entered in an untracked state is tolerated", () => {
    const dir = makeTasksDir();
    writeTask(dir, { id: "000001", state: "NEW", state_entered: null });

    expect(buildReport(dir).problems).toEqual([]);
  });

  test("a state_entered in the future is reported", () => {
    const dir = makeTasksDir();
    writeTask(dir, {
      id: "000001",
      state: "WORKING",
      state_entered: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      claimed_by: "agent",
      claimed_pid: process.pid,
    });

    const problem = buildReport(dir).problems.find((p) =>
      p.message.includes("in the future"),
    );
    expect(problem).toBeDefined();
    expect(buildReport(dir).problems.some((p) => p.type === "StuckTask")).toBe(
      false,
    );
  });
});
