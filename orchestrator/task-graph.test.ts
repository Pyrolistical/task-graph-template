import { describe, expect } from "bun:test";
import { tempDir, test } from "./temp.ts";
import fs from "node:fs";
import path from "node:path";
import { SchemaError } from "./schema.ts";
import {
  CLAIMED_STATES,
  FAILURE_STATES,
  FIELD_ORDER,
  LOCK_FILENAME,
  type TaskMeta,
  type UpdateOp,
  VALID_STATES,
  type ValidState,
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
  ALLOWED_TRANSITIONS,
  TRANSITION_NAMES,
  type TransitionArgs,
  type TransitionName,
  type TransitionResult,
  applyTransition,
} from "./transition.ts";

const TEMPLATE_PATH = path.join(import.meta.dir, "..", "tasks", "template.md");
const TASK_PATH = path.join(import.meta.dir, "task.ts");

function makeTasksDir(): string {
  const dir = tempDir("task-graph-");
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
    held_reason: null,
    workspace: null,
    todos: [],
    checks: [],
    plan_feedback: [],
    failures: [],
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

function shape(name: TransitionName, extra: string[]): TransitionArgs {
  const rest = (from: number) => extra.slice(from).join(" ");

  switch (name) {
    case "addDependencies":
    case "removeDependencies":
      return { taskIds: extra };
    case "claim":
      return extra.length <= 2
        ? { agentName: extra[0], pid: Number(extra[1]) }
        : {
            agentName: extra[0],
            pid: Number(extra[1]),
            branch: extra[2],
            worktree: extra[3],
            session: extra[4],
          };
    case "fail":
      return extra[0] === "result"
        ? { failures: [{ type: "result", message: rest(1) }] }
        : {
            failures: [
              {
                type: "check",
                command: rest(2),
                exit_code: Number(extra[1]),
                output: "",
              },
            ],
          };
    case "hold":
      return { reason: rest(0) };
    case "addTodo":
      return { message: rest(0) };
    case "addCheck":
      return { command: rest(0) };
    case "doneTodo":
    case "doneTaskGraph":
    case "removeTodo":
      return { index: Number(extra[0]) };
    case "addTaskGraph":
      return extra[0] === "add"
        ? { op: "add", message: rest(1) }
        : { op: extra[0] as UpdateOp, taskId: extra[1], message: rest(2) };
    case "addFeedback":
      return { findings: extra };
    default:
      return {};
  }
}

function run(
  dir: string,
  id: string,
  name: TransitionName,
  ...extra: string[]
) {
  return applyTransition(dir, id, name, shape(name, extra));
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

function toPlan(): { dir: string; id: string } {
  const { dir, id } = newTask();
  run(dir, id, "noDependencies");
  return { dir, id };
}

function planThrough(): { dir: string; id: string } {
  const { dir, id } = toPlan();
  run(dir, id, "claim", "planner", String(process.pid));
  run(dir, id, "submit");
  run(dir, id, "claim", "plan-reviewer", String(process.pid));
  run(dir, id, "submit");
  return { dir, id };
}

function toWorking(): { dir: string; id: string } {
  const { dir, id } = planThrough();
  run(dir, id, "claim", "agent-1", String(process.pid));
  return { dir, id };
}

function toChecking(): { dir: string; id: string } {
  const { dir, id } = toWorking();
  run(dir, id, "submit");
  run(dir, id, "claim", "checker", String(process.pid));
  return { dir, id };
}

function toAgentReview(): { dir: string; id: string } {
  const { dir, id } = toChecking();
  run(dir, id, "pass");
  run(dir, id, "claim", "reviewer", String(process.pid));
  return { dir, id };
}

function toManagerReview(): { dir: string; id: string } {
  const { dir, id } = toAgentReview();
  run(dir, id, "submit");
  run(dir, id, "claim", "manager", String(process.pid));
  return { dir, id };
}

function toHeld(): { dir: string; id: string } {
  const { dir, id } = toWorking();
  run(dir, id, "hold", "the API key is missing");
  return { dir, id };
}

function closeTask(dir: string, id: string) {
  run(dir, id, "noDependencies");
  run(dir, id, "claim", "p", String(process.pid));
  run(dir, id, "submit");
  run(dir, id, "claim", "pr", String(process.pid));
  run(dir, id, "submit");
  run(dir, id, "claim", "a", String(process.pid));
  run(dir, id, "submit");
  run(dir, id, "claim", "c", String(process.pid));
  run(dir, id, "pass");
  run(dir, id, "claim", "r", String(process.pid));
  run(dir, id, "submit");
  run(dir, id, "claim", "m", String(process.pid));
  return run(dir, id, "merged");
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
      issues = (err as SchemaError).issues;
    }
    expect(issues).toHaveLength(2);
    expect(issues[0]).toStartWith("id:");
    expect(issues[1]).toStartWith("title:");

    expect(body).toContain("# Goal");
    expect(body).toContain("# Implementation History");
  });
});

describe("schema", () => {
  test("a valid document round-trips to a fixed point", () => {
    const meta = baseMeta({
      title: "Add: a colon, a $& and a #hash",
      state: "MANAGER_REVIEWING",
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
      checks: ["bun test"],
      failures: [
        { type: "check", command: "bun test", exit_code: 1, output: "boom" },
        { type: "result", message: "the review did not parse" },
      ],
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
    const doc = `---\nid: 000042\ntitle: t\nstate: NEW\nstate_entered: null\ndepends_on: []\nclaimed_by: null\nclaimed_pid: null\ntodos: []\nchecks: []\nfailures: []\ntask_graph_updates: []\n---\n`;
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
    expect(issues.some((i) => i.startsWith("todos:"))).toBe(true);
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

  test("task graph update ops are discriminated on op", () => {
    expect(() =>
      parseTaskMeta({
        ...baseMeta(),
        task_graph_updates: [
          { op: "add", task_id: "000007", message: "m", done: false },
        ],
      }),
    ).toThrow(/task_graph_updates\[0\]: Unrecognized key: "task_id"/);

    for (const op of ["update", "delete"]) {
      expect(() =>
        parseTaskMeta({
          ...baseMeta(),
          task_graph_updates: [{ op, message: "m", done: false }],
        }),
      ).toThrow(
        /task_graph_updates\[0\]\.task_id: must be a quoted six-digit string/,
      );
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
    expect(doc).toContain("todos: []");
    expect(doc).toContain("checks: []");
    expect(doc).toContain("failures: []");
    expect(doc).toContain("task_graph_updates: []");
    expect(parseTaskMeta(parseDocument(doc).raw).todos).toEqual([]);
  });

  test("a document without plan_feedback parses, defaulting to empty", () => {
    const meta = raw(baseMeta());
    delete meta.plan_feedback;
    expect(parseTaskMeta(meta).plan_feedback).toEqual([]);
    const doc = `---\nid: "000042"\ntitle: t\nstate: NEW\nstate_entered: null\ndepends_on: []\nclaimed_by: null\nclaimed_pid: null\nheld_reason: null\nworkspace: null\ntodos: []\nchecks: []\nfailures: []\ntask_graph_updates: []\n---\n`;
    expect(parseTaskMeta(parseDocument(doc).raw).plan_feedback).toEqual([]);
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
      "todos",
      "checks",
      "plan_feedback",
      "failures",
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
        `const { createTask } = await import(${JSON.stringify(TASK_PATH)});
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
    expect(run(dir, main, "removeDependencies", second).to).toBe("READY_PLAN");
  });

  test("removeDependencies can clear a reference to a task that is gone", () => {
    const dir = makeTasksDir();
    const main = writeTask(dir, {
      id: "000001",
      state: "BLOCKED",
      depends_on: ["000999"],
    });

    expect(run(dir, main, "removeDependencies", "000999").to).toBe(
      "READY_PLAN",
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
});

describe("transitions: claim and release", () => {
  test("claim records the agent and pid", () => {
    const { dir, id } = planThrough();
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

    expect(run(dir, id, "release").to).toBe("READY_PLAN");

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
});

describe("transitions: todos", () => {
  test("addFeedback from AGENT_REVIEWING sends the task back with findings as todos", () => {
    const { dir, id } = toAgentReview();
    expect(run(dir, id, "addFeedback", "fix null handling").to).toBe(
      "READY_WORK",
    );

    const todo = metaOf(dir, id).todos[0]!;
    expect(todo.message).toBe("fix null handling");
    expect(todo.done).toBe(false);
  });

  test("every finding in an addFeedback from AGENT_REVIEWING becomes a todo", () => {
    const { dir, id } = toAgentReview();
    run(dir, id, "addFeedback", "first", "second");
    expect(metaOf(dir, id).todos.map((t) => t.message)).toEqual([
      "first",
      "second",
    ]);
  });

  test("addTodo from MANAGER_REVIEWING sends the task back to READY_WORK", () => {
    const { dir, id } = toManagerReview();
    expect(run(dir, id, "addTodo", "restructure the parser").to).toBe(
      "READY_WORK",
    );
    expect(metaOf(dir, id).todos[0]!.message).toBe("restructure the parser");
  });

  test("addTodo self-loops in READY_WORK and WORKING so more can be filed", () => {
    const { dir, id } = toAgentReview();
    run(dir, id, "addFeedback", "first");
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
    const { dir, id } = toAgentReview();
    run(dir, id, "addFeedback", "keep me");
    run(dir, id, "claim", "agent-1", String(process.pid));
    run(dir, id, "doneTodo", "0");
    run(dir, id, "submit");
    run(dir, id, "claim", "checker", String(process.pid));
    run(dir, id, "pass");
    run(dir, id, "claim", "reviewer", String(process.pid));
    run(dir, id, "submit");
    run(dir, id, "claim", "manager", String(process.pid));
    const { closedPath } = run(dir, id, "merged");

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
    expect(metaOf(dir, id).checks).toEqual(["bun test"]);
  });

  test("addCheck self-loops in NEW and the checks survive into READY_PLAN", () => {
    const { dir, id } = newTask();
    expect(run(dir, id, "addCheck", "bun test").to).toBeNull();
    expect(metaOf(dir, id).state).toBe("NEW");

    expect(run(dir, id, "noDependencies").to).toBe("READY_PLAN");
    expect(metaOf(dir, id).checks).toEqual(["bun test"]);
  });

  test("a check is a command and nothing else, so nothing records a stale pass", () => {
    const { dir, id } = toChecking();
    run(dir, id, "addCheck", "bun test");
    expect(run(dir, id, "pass").to).toBe("READY_AGENT_REVIEW");
    expect(metaOf(dir, id).checks).toEqual(["bun test"]);
  });
});

describe("transitions: failures", () => {
  test("fail from CHECKING sends the task back to READY_WORK with what failed", () => {
    const { dir, id } = toChecking();
    const result = applyTransition(dir, id, "fail", {
      failures: [
        { type: "check", command: "bun test", exit_code: 1, output: "1 fail" },
      ],
    });

    expect(result.to).toBe("READY_WORK");
    expect(metaOf(dir, id).failures).toEqual([
      { type: "check", command: "bun test", exit_code: 1, output: "1 fail" },
    ]);
  });

  test("every failing check is recorded, not just the first", () => {
    const { dir, id } = toChecking();
    applyTransition(dir, id, "fail", {
      failures: [
        { type: "check", command: "bun test", exit_code: 1, output: "a" },
        { type: "check", command: "tsc", exit_code: 2, output: "b" },
      ],
    });
    expect(metaOf(dir, id).failures.length).toBe(2);
  });

  test("fail is only for the checks; a review cannot fail its own task", () => {
    const { dir, id } = toAgentReview();
    expect(() =>
      applyTransition(dir, id, "fail", {
        failures: [{ type: "result", message: "result.type was missing" }],
      }),
    ).toThrow(/not valid from state/);
  });

  test("a submit clears the failures it was sent back to fix", () => {
    const { dir, id } = toChecking();
    applyTransition(dir, id, "fail", {
      failures: [
        { type: "check", command: "bun test", exit_code: 1, output: "x" },
      ],
    });
    run(dir, id, "claim", "agent-1", String(process.pid));
    expect(metaOf(dir, id).failures.length).toBe(1);

    run(dir, id, "submit");
    expect(metaOf(dir, id).failures).toEqual([]);
  });

  test("a hold clears them too, because held_reason is the record then", () => {
    const { dir, id } = toChecking();
    applyTransition(dir, id, "fail", {
      failures: [
        { type: "check", command: "bun test", exit_code: 1, output: "x" },
      ],
    });
    run(dir, id, "claim", "agent-1", String(process.pid));
    run(dir, id, "hold", "the fix needs a decision");

    expect(metaOf(dir, id).failures).toEqual([]);
  });

  test("fail refuses an empty or malformed list and writes nothing", () => {
    const { dir, id } = toChecking();
    const before = fs.readFileSync(path.join(dir, `${id}.md`), "utf-8");

    expect(() => applyTransition(dir, id, "fail", {})).toThrow(/non-empty/);
    expect(() => applyTransition(dir, id, "fail", { failures: [] })).toThrow(
      /non-empty/,
    );
    expect(() =>
      applyTransition(dir, id, "fail", {
        failures: [{ type: "nonsense" } as never],
      }),
    ).toThrow(/type of check, result/);
    expect(() =>
      applyTransition(dir, id, "fail", {
        failures: [
          { type: "check", command: "x", exit_code: 1.5, output: "" } as never,
        ],
      }),
    ).toThrow(/exit_code/);

    expect(fs.readFileSync(path.join(dir, `${id}.md`), "utf-8")).toBe(before);
  });
});

describe("transitions: task graph updates", () => {
  test("addTaskGraph self-loops in MANAGER_REVIEWING, so a review can queue several", () => {
    const { dir, id } = toManagerReview();
    const target = createTask(dir, "a task to retarget").id;
    const doomed = createTask(dir, "a task to supersede").id;

    expect(
      run(dir, id, "addTaskGraph", "add", "split the parser").to,
    ).toBeNull();
    expect(
      run(dir, id, "addTaskGraph", "update", target, "retarget").to,
    ).toBeNull();
    expect(metaOf(dir, id).state).toBe("MANAGER_REVIEWING");

    run(dir, id, "abort");
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
    const { dir, id } = toManagerReview();
    expect(() =>
      run(dir, id, "addTaskGraph", "update", "000999", "retarget"),
    ).toThrow(/Task "000999" does not exist/);
    expect(metaOf(dir, id).task_graph_updates).toEqual([]);
    expect(metaOf(dir, id).state).toBe("MANAGER_REVIEWING");
  });

  test("update and delete require a task id, add takes a bare message", () => {
    const { dir, id } = toManagerReview();

    for (const op of ["update", "delete"] as const) {
      expect(() =>
        applyTransition(dir, id, "addTaskGraph", { op, message: "no target" }),
      ).toThrow(/must be a six-digit task ID/);
    }
    expect(metaOf(dir, id).task_graph_updates).toEqual([]);

    expect(run(dir, id, "addTaskGraph", "add", "just a message").to).toBeNull();
    expect(metaOf(dir, id).task_graph_updates).toEqual([
      { op: "add", message: "just a message", done: false },
    ]);
  });

  test("doneTaskGraph marks by index and closes only on the last one", () => {
    const { dir, id } = toManagerReview();
    run(dir, id, "addTaskGraph", "add", "first");
    run(dir, id, "addTaskGraph", "add", "second");
    run(dir, id, "merged");
    run(dir, id, "claim", "graph-agent", String(process.pid));

    expect(run(dir, id, "doneTaskGraph", "1").to).toBeNull();
    const result = run(dir, id, "doneTaskGraph", "0");
    expect(result.to).toBe("CLOSED");
    expect(fs.existsSync(result.closedPath!)).toBe(true);
  });

  test("doneTaskGraph rejects an unknown or negative index", () => {
    const { dir, id } = toManagerReview();
    run(dir, id, "addTaskGraph", "add", "only one");
    run(dir, id, "merged");
    run(dir, id, "claim", "graph-agent", String(process.pid));

    expect(() => run(dir, id, "doneTaskGraph", "7")).toThrow(/out of range/);
    expect(() => run(dir, id, "doneTaskGraph", "-1")).toThrow(/non-negative/);
  });
});

describe("transitions: closing", () => {
  test("merged from MANAGER_REVIEWING closes the task and moves the file", () => {
    const { dir, id } = toManagerReview();
    const result = run(dir, id, "merged");

    expect(result.to).toBe("CLOSED");
    expect(fs.existsSync(path.join(dir, `${id}.md`))).toBe(false);
    expect(fs.existsSync(path.join(dir, "closed", `${id}.md`))).toBe(true);
    expect(readTaskFile(result.closedPath!).meta.state).toBe("CLOSED");
  });

  test("merged with queued graph updates goes to the update state, not to CLOSED", () => {
    const { dir, id } = toManagerReview();
    run(dir, id, "addTaskGraph", "add", "the follow-up this uncovered");

    expect(run(dir, id, "merged").to).toBe("READY_TASK_GRAPH_UPDATE");
    expect(fs.existsSync(path.join(dir, `${id}.md`))).toBe(true);
  });

  test("abort always goes to the update state and refuses an empty queue", () => {
    const { dir, id } = toManagerReview();
    expect(() => run(dir, id, "abort")).toThrow(/no task graph updates/);

    run(dir, id, "addTaskGraph", "add", "this task was the wrong shape");
    expect(run(dir, id, "abort").to).toBe("READY_TASK_GRAPH_UPDATE");
  });

  test("abort throws away a task still queued in READY_PLAN", () => {
    const { dir, id } = newTask("the wrong shape");
    run(dir, id, "noDependencies");
    expect(() => run(dir, id, "abort")).toThrow(/no task graph updates/);

    expect(
      run(dir, id, "addTaskGraph", "add", "two tasks instead of this one").to,
    ).toBeNull();
    expect(metaOf(dir, id).state).toBe("READY_PLAN");

    expect(run(dir, id, "abort").to).toBe("READY_TASK_GRAPH_UPDATE");
  });

  test("a task sent back by a failed check can be aborted from READY_WORK", () => {
    const { dir, id } = toChecking();
    run(dir, id, "fail", "check", "1", "bun test");
    expect(metaOf(dir, id).state).toBe("READY_WORK");

    run(dir, id, "addTaskGraph", "add", "the task this should have been");
    run(dir, id, "abort");
    run(dir, id, "claim", "graph-agent", String(process.pid));

    expect(run(dir, id, "doneTaskGraph", "0").to).toBe("CLOSED");
  });

  test("an aborted task still closes once the graph has been rewritten", () => {
    const { dir, id } = toManagerReview();
    run(dir, id, "addTaskGraph", "add", "split this in two");
    run(dir, id, "abort");
    run(dir, id, "claim", "graph-agent", String(process.pid));

    expect(run(dir, id, "doneTaskGraph", "0").to).toBe("CLOSED");
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
    expect(metaOf(dir, main).state).toBe("READY_PLAN");
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
    const { dir, id } = toManagerReview();
    run(dir, id, "merged");

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
    expect(meta.state).toBe("READY_PLAN");
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
    const { dir, id } = toManagerReview();

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
      ["claim", ["planner", String(process.pid)]],
      ["submit", []],
      ["claim", ["plan-reviewer", String(process.pid)]],
      ["submit", []],
      ["addCheck", ["bun test"]],
      ["addTodo", ["something to do"]],
      ["claim", ["agent-1", String(process.pid)]],
      ["doneTodo", ["0"]],
      ["submit", []],
      ["claim", ["checker", String(process.pid)]],
      ["pass", []],
      ["claim", ["reviewer", String(process.pid)]],
      ["submit", []],
      ["claim", ["manager", String(process.pid)]],
      ["addTaskGraph", ["add", "follow-up work"]],
      ["merged", []],
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

describe("transitions: the whole state machine", () => {
  interface Case {
    to: string;
    prepare?: string[][];
    args?: (dep: string) => string[];
  }

  const MACHINE: Record<ValidState, Partial<Record<TransitionName, Case>>> = {
    NEW: {
      addDependencies: { to: "BLOCKED", args: (dep) => [dep] },
      noDependencies: { to: "READY_PLAN" },
      addTodo: { to: "NEW", args: () => ["a todo"] },
      addCheck: { to: "NEW", args: () => ["bun test"] },
    },
    BLOCKED: {
      addDependencies: { to: "BLOCKED", args: (dep) => [dep] },
      removeDependencies: { to: "READY_PLAN", args: (dep) => [dep] },
    },
    READY_PLAN: {
      addDependencies: { to: "BLOCKED", args: (dep) => [dep] },
      addTodo: { to: "READY_PLAN", args: () => ["a todo"] },
      addCheck: { to: "READY_PLAN", args: () => ["bun test"] },
      addTaskGraph: {
        to: "READY_PLAN",
        args: () => ["add", "a follow-up"],
      },
      abort: {
        to: "READY_TASK_GRAPH_UPDATE",
        prepare: [["addTaskGraph", "add", "this was the wrong shape"]],
      },
      claim: { to: "PLANNING", args: () => ["planner", String(process.pid)] },
    },
    PLANNING: {
      addTodo: { to: "PLANNING", args: () => ["a todo"] },
      removeTodo: {
        to: "PLANNING",
        prepare: [["addTodo", "something"]],
        args: () => ["0"],
      },
      submit: { to: "READY_PLAN_REVIEW" },
      hold: { to: "HELD_PLAN", args: () => ["waiting on a person"] },
      release: { to: "READY_PLAN" },
    },
    READY_PLAN_REVIEW: {
      claim: {
        to: "PLAN_REVIEWING",
        args: () => ["plan-reviewer", String(process.pid)],
      },
    },
    PLAN_REVIEWING: {
      submit: { to: "READY_WORK" },
      addFeedback: {
        to: "READY_PLAN",
        args: () => ["the plan misses the empty case"],
      },
      hold: { to: "HELD_PLAN", args: () => ["waiting on a person"] },
      release: { to: "READY_PLAN_REVIEW" },
    },
    HELD_PLAN: {
      resume: { to: "READY_PLAN" },
      addTodo: { to: "READY_PLAN", args: () => ["the missing piece"] },
      addCheck: { to: "HELD_PLAN", args: () => ["bun test"] },
      addDependencies: { to: "BLOCKED", args: (dep) => [dep] },
      addTaskGraph: {
        to: "READY_TASK_GRAPH_UPDATE",
        args: () => ["add", "the graph was wrong"],
      },
    },
    HELD_WORK: {
      resume: { to: "READY_WORK" },
      addTodo: { to: "READY_WORK", args: () => ["the missing piece"] },
      addCheck: { to: "HELD_WORK", args: () => ["bun test"] },
      addDependencies: { to: "BLOCKED", args: (dep) => [dep] },
      addTaskGraph: {
        to: "READY_TASK_GRAPH_UPDATE",
        args: () => ["add", "the graph was wrong"],
      },
    },
    READY_WORK: {
      addDependencies: { to: "BLOCKED", args: (dep) => [dep] },
      addTodo: { to: "READY_WORK", args: () => ["a todo"] },
      addCheck: { to: "READY_WORK", args: () => ["bun test"] },
      addTaskGraph: {
        to: "READY_WORK",
        args: () => ["add", "a follow-up"],
      },
      abort: {
        to: "READY_TASK_GRAPH_UPDATE",
        prepare: [["addTaskGraph", "add", "this was the wrong shape"]],
      },
      claim: { to: "WORKING", args: () => ["agent-1", String(process.pid)] },
    },
    WORKING: {
      addTodo: { to: "WORKING", args: () => ["a todo"] },
      doneTodo: {
        to: "WORKING",
        prepare: [["addTodo", "something"]],
        args: () => ["0"],
      },
      addCheck: { to: "WORKING", args: () => ["bun test"] },
      submit: { to: "READY_CHECK" },
      hold: { to: "HELD_WORK", args: () => ["waiting on a person"] },
      release: { to: "READY_WORK" },
    },
    READY_CHECK: {
      claim: { to: "CHECKING", args: () => ["server", String(process.pid)] },
    },
    CHECKING: {
      addCheck: { to: "CHECKING", args: () => ["tsc --noEmit"] },
      pass: { to: "READY_AGENT_REVIEW" },
      fail: { to: "READY_WORK", args: () => ["check", "1", "bun test"] },
      release: { to: "READY_CHECK" },
    },
    READY_AGENT_REVIEW: {
      claim: {
        to: "AGENT_REVIEWING",
        args: () => ["reviewer", String(process.pid)],
      },
    },
    AGENT_REVIEWING: {
      addFeedback: { to: "READY_WORK", args: () => ["a finding"] },
      submit: { to: "READY_MANAGER_REVIEW" },
      hold: { to: "HELD_WORK", args: () => ["the range does not exist"] },
      release: { to: "READY_AGENT_REVIEW" },
    },
    READY_MANAGER_REVIEW: {
      claim: {
        to: "MANAGER_REVIEWING",
        args: () => ["manager", String(process.pid)],
      },
    },
    MANAGER_REVIEWING: {
      addTodo: { to: "READY_WORK", args: () => ["not acceptable yet"] },
      addCheck: { to: "MANAGER_REVIEWING", args: () => ["tsc --noEmit"] },
      addTaskGraph: {
        to: "MANAGER_REVIEWING",
        args: () => ["add", "a follow-up"],
      },
      merged: { to: "CLOSED" },
      abort: {
        to: "READY_TASK_GRAPH_UPDATE",
        prepare: [["addTaskGraph", "add", "this was the wrong shape"]],
      },
      release: { to: "READY_MANAGER_REVIEW" },
    },
    READY_TASK_GRAPH_UPDATE: {
      addTaskGraph: {
        to: "READY_TASK_GRAPH_UPDATE",
        args: () => ["add", "one more"],
      },
      claim: {
        to: "TASK_GRAPH_UPDATING",
        args: () => ["graph-agent", String(process.pid)],
      },
    },
    TASK_GRAPH_UPDATING: {
      addTaskGraph: {
        to: "TASK_GRAPH_UPDATING",
        args: () => ["add", "one more"],
      },
      doneTaskGraph: { to: "CLOSED", args: () => ["0"] },
      release: { to: "READY_TASK_GRAPH_UPDATE" },
    },
  };

  async function build(
    state: ValidState,
    live: boolean,
  ): Promise<{ dir: string; id: string; dep: string }> {
    const pid = String(live ? process.pid : await deadPid());
    const dir = makeTasksDir();
    const dep = createTask(dir, "a dependency").id;
    const id = createTask(dir, "the task under test").id;
    const walk = (steps: string[][]) => {
      for (const [name, ...args] of steps) {
        run(dir, id, name as TransitionName, ...args);
      }
    };

    if (state === "NEW") return { dir, id, dep };
    if (state === "BLOCKED") {
      walk([["addDependencies", dep]]);
      return { dir, id, dep };
    }

    walk([["noDependencies"]]);
    if (state === "READY_PLAN") return { dir, id, dep };

    walk([["claim", "planner", pid]]);
    if (state === "PLANNING") return { dir, id, dep };
    if (state === "HELD_PLAN") {
      walk([["hold", "waiting on a person"]]);
      return { dir, id, dep };
    }

    walk([["submit"]]);
    if (state === "READY_PLAN_REVIEW") return { dir, id, dep };

    walk([["claim", "plan-reviewer", pid]]);
    if (state === "PLAN_REVIEWING") return { dir, id, dep };

    walk([["submit"]]);
    if (state === "READY_WORK") return { dir, id, dep };

    walk([["claim", "agent-1", pid]]);
    if (state === "WORKING") return { dir, id, dep };
    if (state === "HELD_WORK") {
      walk([["hold", "waiting on a person"]]);
      return { dir, id, dep };
    }

    walk([["submit"]]);
    if (state === "READY_CHECK") return { dir, id, dep };

    walk([["claim", "server", pid]]);
    if (state === "CHECKING") return { dir, id, dep };

    walk([["pass"]]);
    if (state === "READY_AGENT_REVIEW") return { dir, id, dep };

    walk([["claim", "reviewer", pid]]);
    if (state === "AGENT_REVIEWING") return { dir, id, dep };

    walk([["submit"]]);
    if (state === "READY_MANAGER_REVIEW") return { dir, id, dep };

    walk([["claim", "manager", pid]]);
    if (state === "MANAGER_REVIEWING") return { dir, id, dep };

    walk([["addTaskGraph", "add", "the follow-up this uncovered"], ["merged"]]);
    if (state === "READY_TASK_GRAPH_UPDATE") return { dir, id, dep };

    walk([["claim", "graph-agent", pid]]);
    return { dir, id, dep };
  }

  test("the table covers every state and nothing but the allowed transitions", () => {
    expect(Object.keys(MACHINE).sort()).toEqual([...VALID_STATES].sort());

    for (const state of VALID_STATES) {
      expect(Object.keys(MACHINE[state]).sort()).toEqual(
        [...ALLOWED_TRANSITIONS[state]].sort(),
      );
    }

    const exercised = new Set(
      VALID_STATES.flatMap((state) => Object.keys(MACHINE[state])),
    );
    expect([...exercised].sort()).toEqual([...TRANSITION_NAMES].sort());
  });

  test("every allowed transition lands where the machine says it does", async () => {
    for (const state of VALID_STATES) {
      for (const [name, expected] of Object.entries(MACHINE[state]) as [
        TransitionName,
        Case,
      ][]) {
        const { dir, id, dep } = await build(state, name !== "release");
        expect(metaOf(dir, id).state).toBe(state);

        for (const [step, ...args] of expected.prepare ?? []) {
          run(dir, id, step as TransitionName, ...args);
        }

        const result = run(dir, id, name, ...(expected.args?.(dep) ?? []));
        const landed = result.to ?? state;

        expect(`${state} --${name}--> ${landed}`).toBe(
          `${state} --${name}--> ${expected.to}`,
        );

        if (expected.to === "CLOSED") {
          expect(fs.existsSync(result.closedPath!)).toBe(true);
        } else {
          expect(metaOf(dir, id).state as string).toBe(expected.to);
        }
      }
    }
  });

  test("every transition the machine does not allow is refused", async () => {
    for (const state of VALID_STATES) {
      const allowed = new Set<string>(ALLOWED_TRANSITIONS[state]);
      const refused = TRANSITION_NAMES.filter((name) => !allowed.has(name));

      const { dir, id, dep } = await build(state, true);
      const before = fs.readFileSync(path.join(dir, `${id}.md`), "utf-8");

      for (const name of refused) {
        const args = MACHINE[state][name]?.args?.(dep) ?? cliArgs(name, dep);
        expect(() => run(dir, id, name, ...args)).toThrow(
          /not valid from state/,
        );
      }

      expect(fs.readFileSync(path.join(dir, `${id}.md`), "utf-8")).toBe(before);
    }
  });

  function cliArgs(name: TransitionName, dep: string): string[] {
    switch (name) {
      case "addDependencies":
      case "removeDependencies":
        return [dep];
      case "claim":
        return ["agent-1", String(process.pid)];
      case "hold":
        return ["a reason"];
      case "addTodo":
        return ["a todo"];
      case "addCheck":
        return ["bun test"];
      case "doneTodo":
      case "doneTaskGraph":
      case "removeTodo":
        return ["0"];
      case "addTaskGraph":
        return ["add", "a message"];
      case "addFeedback":
        return ["a finding"];
      case "fail":
        return ["check", "1", "bun test"];
      default:
        return [];
    }
  }
});

describe("transitions: the planning phase", () => {
  test("plan_feedback is set by a rejection and gone by the time the task reaches READY_WORK", () => {
    const { dir, id } = toPlan();
    run(dir, id, "claim", "planner", String(process.pid));
    run(dir, id, "submit");
    run(dir, id, "claim", "plan-reviewer", String(process.pid));
    run(dir, id, "addFeedback", "the plan misses the empty case");
    expect(metaOf(dir, id).plan_feedback).toEqual([
      "the plan misses the empty case",
    ]);

    run(dir, id, "claim", "planner", String(process.pid));
    run(dir, id, "submit");
    run(dir, id, "claim", "plan-reviewer", String(process.pid));
    run(dir, id, "submit");

    expect(metaOf(dir, id).state).toBe("READY_WORK");
    expect(metaOf(dir, id).plan_feedback).toEqual([]);
  });

  test("a second rejection replaces the first plan_feedback", () => {
    const { dir, id } = toPlan();
    run(dir, id, "claim", "planner", String(process.pid));
    run(dir, id, "submit");
    run(dir, id, "claim", "plan-reviewer", String(process.pid));
    run(dir, id, "addFeedback", "finding one");

    run(dir, id, "claim", "planner", String(process.pid));
    run(dir, id, "submit");
    run(dir, id, "claim", "plan-reviewer", String(process.pid));
    run(dir, id, "addFeedback", "finding two");

    expect(metaOf(dir, id).plan_feedback).toEqual(["finding two"]);
  });
});

describe("transitions: the split review", () => {
  test("a task walks CHECKING to CLOSED through both reviews", () => {
    const { dir, id } = toChecking();

    expect(run(dir, id, "pass").to).toBe("READY_AGENT_REVIEW");
    expect(run(dir, id, "claim", "reviewer", String(process.pid)).to).toBe(
      "AGENT_REVIEWING",
    );
    expect(run(dir, id, "submit").to).toBe("READY_MANAGER_REVIEW");
    expect(run(dir, id, "claim", "manager", String(process.pid)).to).toBe(
      "MANAGER_REVIEWING",
    );
    expect(run(dir, id, "merged").to).toBe("CLOSED");
  });

  test("submit from AGENT_REVIEWING hands the task straight to the manager", () => {
    const { dir, id } = toAgentReview();
    expect(run(dir, id, "submit").to).toBe("READY_MANAGER_REVIEW");
    expect(metaOf(dir, id).claimed_by).toBeNull();
  });

  test("a finding applied in AGENT_REVIEWING lands the task in READY_WORK", () => {
    const { dir, id } = toAgentReview();

    expect(run(dir, id, "addFeedback", "the null case is untested").to).toBe(
      "READY_WORK",
    );
    expect(run(dir, id, "addTodo", "the error message is wrong").to).toBeNull();
    expect(metaOf(dir, id).todos.map((t) => t.message)).toEqual([
      "the null case is untested",
      "the error message is wrong",
    ]);
    expect(metaOf(dir, id).claimed_by).toBeNull();
  });

  test("an agent reviewer cannot close the task or fail it", () => {
    const { dir, id } = toAgentReview();
    expect(ALLOWED_TRANSITIONS.AGENT_REVIEWING).toEqual([
      "addFeedback",
      "submit",
      "hold",
      "release",
    ]);
    expect(() => run(dir, id, "pass")).toThrow(/not valid from state/);
    expect(() => run(dir, id, "merged")).toThrow(/not valid from state/);
  });

  test("a review release returns the task to its own ready state", async () => {
    const dir = makeTasksDir();
    const id = writeTask(dir, {
      id: "000001",
      state: "AGENT_REVIEWING",
      claimed_by: "dead-reviewer",
      claimed_pid: await deadPid(),
    });

    expect(run(dir, id, "release").to).toBe("READY_AGENT_REVIEW");
  });
});

describe("transitions: hold and resume", () => {
  test("hold from WORKING parks the task with its reason and clears the claim", () => {
    const { dir, id } = toWorking();

    expect(run(dir, id, "hold", "the staging database is down").to).toBe(
      "HELD_WORK",
    );

    const meta = metaOf(dir, id);
    expect(meta.held_reason).toBe("the staging database is down");
    expect(meta.claimed_by).toBeNull();
    expect(meta.claimed_pid).toBeNull();
  });

  test("hold from AGENT_REVIEWING works the same way", () => {
    const { dir, id } = toAgentReview();
    expect(run(dir, id, "hold", "the diff does not apply").to).toBe(
      "HELD_WORK",
    );
    expect(metaOf(dir, id).held_reason).toBe("the diff does not apply");
  });

  test("hold requires a reason", () => {
    const { dir, id } = toWorking();
    expect(() => run(dir, id, "hold")).toThrow(
      /"reason" must be a non-empty string/,
    );
    expect(metaOf(dir, id).state).toBe("WORKING");
  });

  test("resume clears the reason and returns the task to READY_WORK", () => {
    const { dir, id } = toHeld();

    expect(run(dir, id, "resume").to).toBe("READY_WORK");
    expect(metaOf(dir, id).held_reason).toBeNull();
  });

  test("every exit from HELD clears held_reason", () => {
    for (const exit of ["resume", "addTodo", "addTaskGraph"] as const) {
      const { dir, id } = toHeld();
      const extra =
        exit === "addTodo"
          ? ["here is the missing piece"]
          : exit === "addTaskGraph"
            ? ["add", "the graph was wrong"]
            : [];

      run(dir, id, exit, ...extra);
      expect(metaOf(dir, id).held_reason).toBeNull();
    }
  });

  test("addDependencies moves a held task to BLOCKED and clears the reason", () => {
    const { dir, id } = toHeld();
    const dep = createTask(dir, "the thing it was waiting on").id;

    expect(run(dir, id, "addDependencies", dep).to).toBe("BLOCKED");
    expect(metaOf(dir, id).held_reason).toBeNull();
    expect(metaOf(dir, id).depends_on).toEqual([dep]);
  });

  test("addTaskGraph moves a held task to READY_TASK_GRAPH_UPDATE", () => {
    const { dir, id } = toHeld();
    expect(run(dir, id, "addTaskGraph", "add", "split this task").to).toBe(
      "READY_TASK_GRAPH_UPDATE",
    );
  });

  test("a held task keeps its open todos", () => {
    const { dir, id } = toWorking();
    run(dir, id, "addTodo", "half of the work");
    run(dir, id, "hold", "blocked on a decision");

    expect(metaOf(dir, id).todos).toHaveLength(1);
    expect(metaOf(dir, id).state).toBe("HELD_WORK");
  });

  test("hold from PLANNING parks the task in HELD_PLAN and resume re-plans it", () => {
    const { dir, id } = toPlan();
    run(dir, id, "claim", "planner", String(process.pid));
    expect(run(dir, id, "hold", "the criteria are empty").to).toBe("HELD_PLAN");
    expect(run(dir, id, "resume").to).toBe("READY_PLAN");
  });

  test("hold from PLAN_REVIEWING parks the task in HELD_PLAN", () => {
    const { dir, id } = toPlan();
    run(dir, id, "claim", "planner", String(process.pid));
    run(dir, id, "submit");
    run(dir, id, "claim", "plan-reviewer", String(process.pid));
    expect(run(dir, id, "hold", "the criteria contradict the goal").to).toBe(
      "HELD_PLAN",
    );
  });

  test("addTodo from HELD_PLAN sends the task back to READY_PLAN", () => {
    const { dir, id } = toPlan();
    run(dir, id, "claim", "planner", String(process.pid));
    run(dir, id, "hold", "waiting on a person");
    expect(run(dir, id, "addTodo", "the missing piece").to).toBe("READY_PLAN");
  });

  test("the dispatcher queue never contains a held task", () => {
    const { dir, id } = toHeld();
    expect(metaOf(dir, id).state).toBe("HELD_WORK");
    expect(ALLOWED_TRANSITIONS.HELD_PLAN).not.toContain("claim");
    expect(ALLOWED_TRANSITIONS.HELD_WORK).not.toContain("claim");
  });
});

describe("transitions: the workspace block", () => {
  test("a task has no workspace before its first claim", () => {
    const { dir, id } = newTask();
    run(dir, id, "noDependencies");
    expect(metaOf(dir, id).workspace).toBeNull();
  });

  test("claim records branch, worktree, agent and session", () => {
    const { dir, id } = newTask();
    run(dir, id, "noDependencies");
    run(
      dir,
      id,
      "claim",
      "pi-anthropic-claude-sonnet-4-5-2",
      String(process.pid),
      "work/000001",
      "/tmp/task-graph-server/-repo/000001/worktree",
      "/tmp/task-graph-server/-repo/000001/session/work/019f.jsonl",
    );

    expect(metaOf(dir, id).workspace).toEqual({
      branch: "work/000001",
      worktree: "/tmp/task-graph-server/-repo/000001/worktree",
      agent: "pi-anthropic-claude-sonnet-4-5-2",
      session: "/tmp/task-graph-server/-repo/000001/session/work/019f.jsonl",
    });
  });

  test("a claim with no workspace args leaves the recorded one alone", () => {
    const { dir, id } = newTask();
    run(dir, id, "noDependencies");
    run(
      dir,
      id,
      "claim",
      "pi-1",
      String(process.pid),
      "work/000001",
      "/tmp/wt",
      "/tmp/session.jsonl",
    );
    const before = metaOf(dir, id).workspace;

    run(dir, id, "submit");
    run(dir, id, "claim", "server", String(process.pid));

    expect(metaOf(dir, id).workspace).toEqual(before);
  });

  test("the session is null when the claim does not carry one", () => {
    const { dir, id } = newTask();
    run(dir, id, "noDependencies");
    run(
      dir,
      id,
      "claim",
      "pi-1",
      String(process.pid),
      "work/000001",
      "/tmp/wt",
    );

    expect(metaOf(dir, id).workspace!.session).toBeNull();
  });

  test("a branch without a worktree is refused and writes nothing", () => {
    const { dir, id } = newTask();
    run(dir, id, "noDependencies");

    expect(() =>
      run(dir, id, "claim", "pi-1", String(process.pid), "work/000001"),
    ).toThrow(/"worktree" must be a non-empty string/);
    expect(metaOf(dir, id).state).toBe("READY_PLAN");
    expect(metaOf(dir, id).workspace).toBeNull();
  });

  test("the workspace survives a release and round-trips through the schema", async () => {
    const dir = makeTasksDir();
    const workspace = {
      branch: "work/000001",
      worktree: "/tmp/task-graph-server/-repo/000001/worktree",
      agent: "pi-anthropic-claude-sonnet-4-5-2",
      session: "/tmp/task-graph-server/-repo/000001/session/work/019f.jsonl",
    };
    const id = writeTask(dir, {
      id: "000001",
      state: "WORKING",
      claimed_by: "pi-anthropic-claude-sonnet-4-5-2",
      claimed_pid: await deadPid(),
      workspace,
    });

    expect(metaOf(dir, id).workspace).toEqual(workspace);
    run(dir, id, "release");
    expect(metaOf(dir, id).workspace).toEqual(workspace);
  });

  test("closing clears the workspace", () => {
    const dir = makeTasksDir();
    const id = createTask(dir, "a task").id;
    run(dir, id, "noDependencies");
    run(dir, id, "claim", "p", String(process.pid));
    run(dir, id, "submit");
    run(dir, id, "claim", "pr", String(process.pid));
    run(dir, id, "submit");
    run(
      dir,
      id,
      "claim",
      "pi-1",
      String(process.pid),
      "work/000001",
      "/tmp/wt",
    );
    run(dir, id, "submit");
    run(dir, id, "claim", "c", String(process.pid));
    run(dir, id, "pass");
    run(dir, id, "claim", "r", String(process.pid));
    run(dir, id, "submit");
    run(dir, id, "claim", "m", String(process.pid));
    const { closedPath } = run(dir, id, "merged");

    expect(readTaskFile(closedPath!).meta.workspace).toBeNull();
  });

  test("a workspace missing a key or holding an unknown one is rejected", () => {
    const partial = raw(baseMeta());
    partial.workspace = { branch: "work/000001" };
    expect(() => parseTaskMeta(partial)).toThrow(/workspace\.worktree/);

    const extra = raw(baseMeta());
    extra.workspace = {
      branch: "b",
      worktree: "w",
      agent: "a",
      session: null,
      pid: 1,
    };
    expect(() => parseTaskMeta(extra)).toThrow(/Unrecognized key: "pid"/);
  });
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

    run(dir, id, "addTodo", "a todo filed by the server");
    writeTaskBody(dir, id, "# Goal\n\nprose the manager wrote");
    run(dir, id, "addTodo", "another todo filed by the server");

    expect(bodyOf(path.join(dir, `${id}.md`))).toBe(
      "\n\n# Goal\n\nprose the manager wrote\n",
    );
    expect(metaOf(dir, id).todos).toHaveLength(2);
  });
});
