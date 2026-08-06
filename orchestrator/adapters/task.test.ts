import { describe, expect } from "bun:test";
import { testInTempDirs } from "../testing/temp-dirs.ts";
import fs from "node:fs";
import path from "node:path";
import { SchemaError } from "../domain/schema.ts";
import {
  FIELD_ORDER,
  type TaskMeta,
  detectCycles,
  formatId,
  isValidId,
  parseDocument,
  parseTaskMeta,
  rebuildDocument,
  splitDocument,
} from "../domain/task.ts";
import { createTask, readTaskFile, writeTaskBody } from "./task-store.ts";
import {
  ORCHESTRATOR_DIR,
  TASK_STORE_PATH,
  TEMPLATE_PATH,
  baseMeta,
  bodyOf,
  makeTasksDir,
  metaOf,
  newTask,
  raw,
  run,
  toWorking,
} from "../testing/graph-jig.ts";

function issuesOf(meta: Record<string, unknown>): string[] {
  try {
    parseTaskMeta(meta);
    return [];
  } catch (err) {
    return (err as SchemaError).issues;
  }
}

describe("Feature: the id a task is known by", () => {
  testInTempDirs("an id is written as six digits, whatever its number", () => {
    // Given the first, the forty-second and the last task a project can hold
    const numbers = [1, 42, 999999];

    // When each number is written as an id
    const ids = numbers.map(formatId);

    // Then each is padded to six digits, so ids sort as they were created
    expect(ids).toEqual(["000001", "000042", "999999"]);
  });

  testInTempDirs("only a six-digit string is a task id", () => {
    // Given ids of every shape a hand-edited document might carry
    const candidates = ["000001", "999999", "1", "00001", "0000001", "abc123"];

    // When each candidate is checked
    const valid = candidates.map(isValidId);

    // Then only the six-digit strings are ids
    expect(valid).toEqual([true, true, false, false, false, false]);
  });

  testInTempDirs("a number or a null is never a task id", () => {
    // Given the values YAML produces for an unquoted or missing id
    const candidates = [42, null];

    // When each candidate is checked
    const valid = candidates.map(isValidId);

    // Then neither is an id, because an id is a quoted string
    expect(valid).toEqual([false, false]);
  });
});

describe("Feature: splitting a task document", () => {
  testInTempDirs(
    "a body full of rules is kept exactly as it was written",
    () => {
      // Given a document whose body carries its own horizontal rules
      const body = "\n\n# Goal\n\n---\n\n# History\n\n---\n";

      // When the document is split into frontmatter and body
      const split = splitDocument(`---\nid: "000001"\n---${body}`);

      // Then only the first rule ends the frontmatter, and the body is untouched
      expect(split.frontmatter).toBe(`id: "000001"`);
      expect(split.body).toBe(body);
    },
  );

  testInTempDirs("a document with no frontmatter at all is refused", () => {
    // Given a file that is prose and nothing else
    const document = "# No frontmatter here";

    // When the document is split
    const attempt = () => splitDocument(document);

    // Then it is refused, rather than read as a task with no fields
    expect(attempt).toThrow(/no YAML frontmatter/);
  });

  testInTempDirs(
    "the shipped template carries every field the schema has",
    () => {
      // Given the template a new task is copied from
      const template = fs.readFileSync(TEMPLATE_PATH, "utf-8");

      // When its frontmatter is read
      const { raw } = parseDocument(template);

      // Then every field is there, in the state a new task starts in
      expect(Object.keys(raw).sort()).toEqual([...FIELD_ORDER].sort());
      expect(raw.state).toBe("NEW");
    },
  );

  testInTempDirs(
    "the shipped template leaves only the id and title to fill in",
    () => {
      // Given the template a new task is copied from
      const { raw } = parseDocument(fs.readFileSync(TEMPLATE_PATH, "utf-8"));

      // When it is parsed as though it were a task
      const issues = issuesOf(raw);

      // Then the only two fields it fails on are the two a person supplies
      expect(issues).toHaveLength(2);
      expect(issues[0]).toStartWith("id:");
      expect(issues[1]).toStartWith("title:");
    },
  );
});

describe("Feature: reading and writing a task's fields", () => {
  testInTempDirs("a document written and read back is unchanged", () => {
    // Given a task using every field, with awkward characters in its title
    const meta = baseMeta({
      title: "Add: a colon, a $& and a #hash",
      state: "MANAGER_REVIEW",
      depends_on: ["000007", "000008"],
      claimed_by: "reviewer-1",
      claimed_pid: 4242,
      checks: ["bun test"],
    });

    // When it is written, parsed and written again
    const once = rebuildDocument(meta, "\n\n# Goal\n");
    const reparsed = parseTaskMeta(parseDocument(once).raw);
    const twice = rebuildDocument(reparsed, "\n\n# Goal\n");

    // Then nothing drifts, so a person's edit and the server's agree
    expect(twice).toBe(once);
    expect(reparsed).toEqual(meta);
  });

  testInTempDirs(
    "ids are written quoted, so their leading zeros survive",
    () => {
      // Given a task with a dependency, both with leading zeros in their ids
      const meta = baseMeta({ depends_on: ["000007"] });

      // When the document is written and read back
      const document = rebuildDocument(meta, "\n");
      const parsed = parseTaskMeta(parseDocument(document).raw);

      // Then the ids are quoted on disk and come back as strings
      expect(document).toContain('id: "000042"');
      expect(document).toContain('- "000007"');
      expect(parsed.id).toBe("000042");
      expect(parsed.depends_on[0]).toBe("000007");
    },
  );

  testInTempDirs("an id someone unquoted by hand is refused", () => {
    // Given a document whose id YAML will read as a number
    const document = `---\nid: 000042\ntitle: t\nstate: NEW\nstate_entered: null\ndepends_on: []\nclaimed_by: null\nclaimed_pid: null\ntodos: []\nchecks: []\nfailures: []\n---\n`;

    // When it is parsed as a task
    const attempt = () => parseTaskMeta(parseDocument(document).raw);

    // Then it is refused, rather than silently becoming task forty-two
    expect(parseDocument(document).raw.id).toBe(42);
    expect(attempt).toThrow(SchemaError);
  });

  testInTempDirs("a title of any shape survives being written and read", () => {
    // Given titles carrying every character YAML gives a meaning to
    const titles = [
      "Add: colon",
      "fix #hash",
      'quote " and \\ backslash',
      "- dash",
      "123",
      "null",
    ];

    // When each is written into a document and read back
    const read = titles.map(
      (title) => parseTaskMeta(raw(baseMeta({ title }))).title,
    );

    // Then each comes back as the person typed it
    expect(read).toEqual(titles);
  });

  testInTempDirs(
    "a field that is missing and one that is unknown both report",
    () => {
      // Given a document with a stray field and most of the real ones missing
      const document = { id: "000001", nonsense: true };

      // When it is parsed as a task
      const issues = issuesOf(document);

      // Then the stray field and the missing ones are all named at once
      expect(
        issues.some((one) => one.includes('Unrecognized key: "nonsense"')),
      ).toBe(true);
      expect(issues.some((one) => one.startsWith("state:"))).toBe(true);
      expect(issues.some((one) => one.startsWith("checks:"))).toBe(true);
    },
  );

  testInTempDirs(
    "every violation is reported at once, not just the first",
    () => {
      // Given a document with four separate things wrong with it
      const document = {
        ...baseMeta(),
        id: "42",
        title: "",
        state: "BOGUS",
        depends_on: ["x"],
      };

      // When it is parsed as a task
      const issues = issuesOf(document);

      // Then all of them come back, so one edit can fix the document
      expect(issues.length).toBeGreaterThanOrEqual(4);
    },
  );

  testInTempDirs("a claim without both its halves is refused", () => {
    // Given a claim missing its pid, and one missing the agent that made it
    const halves = [
      raw(baseMeta({ claimed_by: "a", claimed_pid: null })),
      raw(baseMeta({ claimed_by: null, claimed_pid: 12 })),
    ];

    // When each is parsed as a task
    const issues = halves.map((half) => issuesOf(half).length > 0);

    // Then both are refused, because a claim without a process cannot be reaped
    expect(issues).toEqual([true, true]);
  });

  testInTempDirs("a check that is not a command line is refused", () => {
    // Given a check written as an empty string, and one written as an object
    const documents = [
      { ...baseMeta(), checks: [""] },
      { ...baseMeta(), checks: [{ command: "bun test" }] },
    ];

    // When each is parsed as a task
    const issues = documents.map((document) => issuesOf(document)[0] ?? "");

    // Then each is refused, naming the entry that is wrong
    expect(issues[0]).toContain("checks[0]: Too small");
    expect(issues[1]).toContain("checks[0]: Invalid input: expected string");
  });

  testInTempDirs(
    "an empty list is written as such, and reads back empty",
    () => {
      // Given a task depending on nothing and declaring no checks
      const meta = baseMeta();

      // When it is written and read back
      const document = rebuildDocument(meta, "\n");

      // Then the lists are written inline, and come back as empty lists
      expect(document).toContain("depends_on: []");
      expect(document).toContain("checks: []");
      expect(parseTaskMeta(parseDocument(document).raw).checks).toEqual([]);
    },
  );

  testInTempDirs("fields are always written in the same order", () => {
    // Given a task with every field on it
    const meta = baseMeta();

    // When the document is written
    const keys = rebuildDocument(meta, "\n")
      .split("\n")
      .filter((line) => /^\w+:/.test(line))
      .map((line) => line.split(":")[0]);

    // Then the order is the schema's, so a diff shows only what really changed
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

describe("Feature: finding a dependency that can never be satisfied", () => {
  function graph(edges: Record<string, string[]>): Map<string, TaskMeta> {
    return new Map(
      Object.entries(edges).map(([id, deps]) => [
        id,
        baseMeta({ id, depends_on: deps }),
      ]),
    );
  }

  testInTempDirs("a graph that only flows one way has no cycle", () => {
    // Given tasks depending only on tasks created before them
    const tasks = graph({
      "000001": [],
      "000002": ["000001"],
      "000003": ["000001", "000002"],
    });

    // When the graph is searched for cycles
    const cycling = detectCycles(tasks);

    // Then nothing is reported, because every task can eventually run
    expect(cycling).toEqual([]);
  });

  testInTempDirs("two tasks waiting on each other are both reported", () => {
    // Given two tasks each depending on the other
    const tasks = graph({ "000001": ["000002"], "000002": ["000001"] });

    // When the graph is searched for cycles
    const cycling = detectCycles(tasks).sort();

    // Then both are named, because neither can ever unblock
    expect(cycling).toEqual(["000001", "000002"]);
  });

  testInTempDirs("a cycle through a third task is found too", () => {
    // Given three tasks depending on one another in a ring
    const tasks = graph({
      "000001": ["000003"],
      "000002": ["000001"],
      "000003": ["000002"],
    });

    // When the graph is searched for cycles
    const cycling = detectCycles(tasks).sort();

    // Then all three are named, however long the ring is
    expect(cycling).toEqual(["000001", "000002", "000003"]);
  });

  testInTempDirs(
    "a dependency on a task that does not exist is not a cycle",
    () => {
      // Given a task depending on an id no document carries
      const tasks = graph({ "000001": ["999999"] });

      // When the graph is searched for cycles
      const cycling = detectCycles(tasks);

      // Then nothing is reported, because the dependency is a typo, not a ring
      expect(cycling).toEqual([]);
    },
  );
});

describe("Feature: creating a task", () => {
  testInTempDirs(
    "a new task is written with a quoted id and a fresh state",
    () => {
      // Given an empty task directory
      const dir = makeTasksDir();

      // When a task is created in it
      const { id, filePath } = createTask(dir, ORCHESTRATOR_DIR, "First task");

      // Then it is the first id, quoted on disk and read back as a string
      expect(id).toBe("000001");
      expect(fs.readFileSync(filePath, "utf-8")).toContain('id: "000001"');

      // Then it starts as new, with the moment it entered that state
      const { meta } = readTaskFile(filePath);
      expect(meta.title).toBe("First task");
      expect(meta.state).toBe("NEW");
      expect(meta.state_entered).not.toBeNull();
    },
  );

  testInTempDirs(
    "a title full of awkward characters is stored verbatim",
    () => {
      // Given titles carrying replacement patterns and YAML metacharacters
      const dir = makeTasksDir();
      const titles = [
        "Fix $& and $` and $' handling",
        'Add: colon, #hash and a "quote"',
      ];

      // When a task is created with each of them
      const stored = titles.map(
        (title) =>
          readTaskFile(createTask(dir, ORCHESTRATOR_DIR, title).filePath).meta
            .title,
      );

      // Then each comes back exactly as it was typed
      expect(stored).toEqual(titles);
    },
  );

  testInTempDirs("a task with no title is refused", () => {
    // Given an empty title, and one that is only spaces
    const dir = makeTasksDir();
    const titles = ["", "   "];

    // When a task is created with each of them
    const refused = titles.map((title) => {
      try {
        createTask(dir, ORCHESTRATOR_DIR, title);
        return "created";
      } catch (err) {
        return (err as Error).message;
      }
    });

    // Then both are refused, because a task nobody named cannot be worked on
    expect(refused.filter((one) => !/title is required/.test(one))).toEqual([]);
  });

  testInTempDirs("ids are handed out in order and never repeat", () => {
    // Given an empty task directory
    const dir = makeTasksDir();

    // When three tasks are created
    const ids = ["a", "b", "c"].map(
      (title) => createTask(dir, ORCHESTRATOR_DIR, title).id,
    );

    // Then each takes the next id, and the counter is left ready for the next
    expect(ids).toEqual(["000001", "000002", "000003"]);
    expect(
      fs.readFileSync(path.join(dir, "next-task-id"), "utf-8").trim(),
    ).toBe("4");
  });

  testInTempDirs("a new task's body is the template's, unchanged", () => {
    // Given an empty task directory
    const dir = makeTasksDir();

    // When a task is created
    const { filePath } = createTask(dir, ORCHESTRATOR_DIR, "t");

    // Then its body is what the template carries, for a person to fill in
    expect(parseDocument(fs.readFileSync(filePath, "utf-8")).body).toBe(
      parseDocument(fs.readFileSync(TEMPLATE_PATH, "utf-8")).body,
    );
  });

  testInTempDirs(
    "a project's own template is used over the shipped one",
    () => {
      // Given a task directory carrying its own template
      const dir = makeTasksDir();
      fs.writeFileSync(
        path.join(dir, "template.md"),
        `${fs.readFileSync(TEMPLATE_PATH, "utf-8")}\n## Rollout\n`,
      );

      // When a task is created
      const { filePath } = createTask(dir, ORCHESTRATOR_DIR, "t");

      // Then the project's sections are what a new task starts with
      expect(fs.readFileSync(filePath, "utf-8")).toContain("## Rollout");
    },
  );

  testInTempDirs("a counter someone has corrupted fails loudly", () => {
    // Given a task directory whose counter is not a number
    const dir = makeTasksDir();
    fs.writeFileSync(path.join(dir, "next-task-id"), "not-a-number\n");

    // When a task is created
    const attempt = () => createTask(dir, ORCHESTRATOR_DIR, "t");

    // Then it fails and names the file, rather than guessing an id
    expect(attempt).toThrow(/Invalid value in next-task-id/);
  });

  testInTempDirs(
    "a task file that already exists is never written over",
    () => {
      // Given a task directory whose counter has been wound back over a task
      const dir = makeTasksDir();
      createTask(dir, ORCHESTRATOR_DIR, "first");
      fs.writeFileSync(path.join(dir, "next-task-id"), "1\n");

      // When a task is created at the id that is already taken
      const attempt = () => createTask(dir, ORCHESTRATOR_DIR, "collision");

      // Then it fails, and the task already there is untouched
      expect(attempt).toThrow();
      expect(readTaskFile(path.join(dir, "000001.md")).meta.title).toBe(
        "first",
      );
    },
  );

  testInTempDirs(
    "tasks created at the same moment take distinct ids and none is lost",
    async () => {
      // Given eight processes creating a task in the same directory at once
      const dir = makeTasksDir();
      const count = 8;
      const procs = Array.from({ length: count }, (_, i) =>
        Bun.spawn([
          "bun",
          "-e",
          `const { createTask } = await import(${JSON.stringify(TASK_STORE_PATH)});
         createTask(${JSON.stringify(dir)}, ${JSON.stringify(ORCHESTRATOR_DIR)}, "concurrent ${i}");`,
        ]),
      );

      // When every one of them has finished
      const codes = await Promise.all(procs.map((proc) => proc.exited));

      // Then all of them succeeded, and each took its own id
      expect(codes.every((code) => code === 0)).toBe(true);
      const files = fs
        .readdirSync(dir)
        .filter((file) => /^\d{6}\.md$/.test(file))
        .sort();
      expect(files.length).toBe(count);
      expect(files[0]).toBe("000001.md");
      expect(files.at(-1)).toBe(`${String(count).padStart(6, "0")}.md`);

      // Then the counter is left where the next create expects it
      expect(
        fs.readFileSync(path.join(dir, "next-task-id"), "utf-8").trim(),
      ).toBe(String(count + 1));

      // Then every task that was asked for is on disk, none written over
      const titles = files.map(
        (file) =>
          parseTaskMeta(
            parseDocument(fs.readFileSync(path.join(dir, file), "utf-8")).raw,
          ).title,
      );
      expect(new Set(titles).size).toBe(count);
    },
    20000,
  );
});

describe("Feature: rewriting the body of a task", () => {
  testInTempDirs("the body is replaced and the fields are left alone", () => {
    // Given a task an agent is working on
    const { dir, id } = toWorking();
    const before = metaOf(dir, id);

    // When its body is rewritten
    writeTaskBody(dir, id, "# Goal\n\nA rewritten goal.");

    // Then the new body is on disk and none of the fields moved
    expect(bodyOf(path.join(dir, `${id}.md`))).toBe(
      "\n\n# Goal\n\nA rewritten goal.\n",
    );
    expect(metaOf(dir, id)).toEqual(before);
  });

  testInTempDirs(
    "a body is normalized to the spacing every document has",
    () => {
      // Given a body with stray blank lines above and below it
      const { dir, id } = newTask();

      // When that body is written to the task
      writeTaskBody(dir, id, "\n\n\n# Goal\n\n\n");

      // Then it is stored with one blank line above and one newline below
      expect(bodyOf(path.join(dir, `${id}.md`))).toBe("\n\n# Goal\n");
    },
  );

  testInTempDirs(
    "an empty body is refused and the document is untouched",
    () => {
      // Given a task and a body that is only whitespace
      const { dir, id } = newTask();
      const before = fs.readFileSync(path.join(dir, `${id}.md`), "utf-8");

      // When that body is written
      const attempt = () => writeTaskBody(dir, id, "   \n ");

      // Then it is refused, and the document is left exactly as it was
      expect(attempt).toThrow(/body is required/);
      expect(fs.readFileSync(path.join(dir, `${id}.md`), "utf-8")).toBe(before);
    },
  );

  testInTempDirs(
    "a body written to a task that does not exist is refused",
    () => {
      // Given an empty task directory
      const dir = makeTasksDir();

      // When a body is written to an id nothing carries
      const attempt = () => writeTaskBody(dir, "000999", "# Goal");

      // Then it is refused, naming the task that was not found
      expect(attempt).toThrow(/not found/);
    },
  );

  testInTempDirs("a body written before a transition survives it", () => {
    // Given a task whose body the manager has just rewritten
    const { dir, id } = toWorking();
    writeTaskBody(dir, id, "# Goal\n\nprose the manager wrote");

    // When the task is held straight afterwards
    run(dir, id, "hold", "waiting on the manager");

    // Then both the prose and the hold are on disk, because both took the lock
    expect(bodyOf(path.join(dir, `${id}.md`))).toBe(
      "\n\n# Goal\n\nprose the manager wrote\n",
    );
    expect(metaOf(dir, id).held_reason).toBe("waiting on the manager");
  });
});
