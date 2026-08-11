import { describe, expect } from "bun:test";
import { testInTempDirs } from "../testing/temp-dirs.ts";
import fs from "node:fs/promises";
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
import {
  createTask,
  graphLock,
  lockPath,
  nextTaskIdPath,
  readTaskFile,
  writeTaskBody,
} from "./task-store.ts";
import {
  ORCHESTRATOR_DIR,
  TEMPLATE_PATH,
  baseMeta,
  bodyOf,
  deadPid,
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
    if (!(err instanceof SchemaError)) {
      throw err;
    }
    return err.issues;
  }
}
describe("Feature: the id a task is known by", () => {
  testInTempDirs(
    "the first task of a project is written as the id 000001",
    () => {
      // Given the number one, the first task a project holds
      const counted = 1;
      // When the number is written as an id
      const written = formatId(counted);
      // Then it is padded to six digits, so ids sort as they were created
      expect(written).toBe("000001");
    },
  );
  testInTempDirs("the forty-second task is written as the id 000042", () => {
    // Given the number forty-two, a task part way into a project
    const counted = 42;
    // When the number is written as an id
    const written = formatId(counted);
    // Then it is padded to six digits, so ids sort as they were created
    expect(written).toBe("000042");
  });
  testInTempDirs(
    "the last task six digits can hold keeps its own digits",
    () => {
      // Given the number nine hundred and ninety-nine thousand, nine hundred and ninety-nine
      const counted = 999999;
      // When the number is written as an id
      const written = formatId(counted);
      // Then it is written as it stands, because it already fills six digits
      expect(written).toBe("999999");
    },
  );
  testInTempDirs("a padded six digit string is a task id", () => {
    // Given the string 000001, as the first task of a project is written
    const written = "000001";
    // When the candidate is checked
    const isId = isValidId(written);
    // Then it is a task id
    expect(isId).toBe(true);
  });
  testInTempDirs("a six digit string with no padding is a task id", () => {
    // Given the string 999999, as the last task six digits can hold is written
    const written = "999999";
    // When the candidate is checked
    const isId = isValidId(written);
    // Then it is a task id
    expect(isId).toBe(true);
  });
  testInTempDirs("a single digit is not a task id", () => {
    // Given the string 1, as a person writing an id by hand might shorten it
    const written = "1";
    // When the candidate is checked
    const isId = isValidId(written);
    // Then it is refused as an id, because an id is six digits and nothing else
    expect(isId).toBe(false);
  });
  testInTempDirs("a string of five digits is not a task id", () => {
    // Given the string 00001, one digit short of an id
    const written = "00001";
    // When the candidate is checked
    const isId = isValidId(written);
    // Then it is refused as an id, because an id is six digits and nothing else
    expect(isId).toBe(false);
  });
  testInTempDirs("a string of seven digits is not a task id", () => {
    // Given the string 0000001, one digit past an id
    const written = "0000001";
    // When the candidate is checked
    const isId = isValidId(written);
    // Then it is refused as an id, because an id is six digits and nothing else
    expect(isId).toBe(false);
  });
  testInTempDirs("a string carrying letters is not a task id", () => {
    // Given the string abc123, as a hand-edited document might carry in place of an id
    const written = "abc123";
    // When the candidate is checked
    const isId = isValidId(written);
    // Then it is refused as an id, because an id is six digits and nothing else
    expect(isId).toBe(false);
  });
  testInTempDirs(
    "the number YAML reads from an unquoted id is not an id",
    () => {
      // Given the number forty-two, as YAML reads an id nobody quoted
      const read = 42;
      // When the candidate is checked
      const isId = isValidId(read);
      // Then it is not an id, because an id is a quoted string
      expect(isId).toBe(false);
    },
  );
  testInTempDirs("the null YAML reads from a missing id is not an id", () => {
    // Given no value at all, as a document without an id leaves it
    const read = undefined;
    // When the candidate is checked
    const isId = isValidId(read);
    // Then it is not an id, because an id is a quoted string
    expect(isId).toBe(false);
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
    async () => {
      // Given the template a new task is copied from
      const template = await fs.readFile(TEMPLATE_PATH, "utf-8");
      // When its frontmatter is read
      const { raw } = parseDocument(template);
      // Then every field is there, in the state a new task starts in
      expect(Object.keys(raw).sort()).toEqual([...FIELD_ORDER].sort());
      expect(raw.state).toBe("NEW");
    },
  );
  testInTempDirs(
    "the shipped template leaves only the id and title to fill in",
    async () => {
      // Given the template a new task is copied from
      const { raw } = parseDocument(await fs.readFile(TEMPLATE_PATH, "utf-8"));
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
    // Given the document written once
    const once = rebuildDocument(meta, "\n\n# Goal\n");
    // When it is parsed and written again
    const twice = rebuildDocument(
      parseTaskMeta(parseDocument(once).raw),
      "\n\n# Goal\n",
    );
    // Then nothing drifts, so a person's edit and the server's agree
    expect(twice).toBe(once);
    expect(parseTaskMeta(parseDocument(twice).raw)).toEqual(meta);
  });
  testInTempDirs(
    "ids are written quoted, so their leading zeros survive",
    () => {
      // Given a task with a dependency, both with leading zeros in their ids
      const meta = baseMeta({ depends_on: ["000007"] });
      // Given the document written out
      const document = rebuildDocument(meta, "\n");
      // When it is read back
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
  testInTempDirs(
    "a title carrying a colon survives being written and read",
    () => {
      // Given the title Add: colon, whose colon YAML reads as a key
      const typed = "Add: colon";
      // When it is written into a document and read back
      const read = parseTaskMeta(raw(baseMeta({ title: typed }))).title;
      // Then it comes back as the person typed it
      expect(read).toBe("Add: colon");
    },
  );
  testInTempDirs(
    "a title carrying a hash survives being written and read",
    () => {
      // Given the title fix #hash, whose hash YAML reads as a comment
      const typed = "fix #hash";
      // When it is written into a document and read back
      const read = parseTaskMeta(raw(baseMeta({ title: typed }))).title;
      // Then it comes back as the person typed it
      expect(read).toBe("fix #hash");
    },
  );
  testInTempDirs(
    "a title carrying a quote and a backslash survives being written and read",
    () => {
      // Given a title carrying both the quote and the backslash a quoted field escapes
      const typed = 'quote " and \\ backslash';
      // When it is written into a document and read back
      const read = parseTaskMeta(raw(baseMeta({ title: typed }))).title;
      // Then it comes back as the person typed it
      expect(read).toBe('quote " and \\ backslash');
    },
  );
  testInTempDirs(
    "a title opening with a dash survives being written and read",
    () => {
      // Given the title - dash, whose leading dash YAML reads as a list entry
      const typed = "- dash";
      // When it is written into a document and read back
      const read = parseTaskMeta(raw(baseMeta({ title: typed }))).title;
      // Then it comes back as the person typed it
      expect(read).toBe("- dash");
    },
  );
  testInTempDirs("a title of digits survives being written and read", () => {
    // Given the title 123, which YAML would otherwise read as a number
    const typed = "123";
    // When it is written into a document and read back
    const read = parseTaskMeta(raw(baseMeta({ title: typed }))).title;
    // Then it comes back as the person typed it, still a string
    expect(read).toBe("123");
  });
  testInTempDirs(
    "a title YAML would read as nothing survives being written and read",
    () => {
      // Given a title YAML would otherwise read as nothing
      const typed = "~";
      // When it is written into a document and read back
      const read = parseTaskMeta(raw(baseMeta({ title: typed }))).title;
      // Then it comes back as the person typed it, still a string
      expect(read).toBe("~");
    },
  );
  testInTempDirs("a hold reason spanning many lines survives", () => {
    // Given the reason a review failure writes, one bulleted line per finding
    const held_reason = "failed 2 rounds of DESIGN_REVIEW with:\n- one\n- two";
    // When it is written into a document and read back
    const document = rebuildDocument(baseMeta({ held_reason }), "\n");
    // Then the newlines stay inside the one quoted field, and come back whole
    expect(document).toContain(
      'held_reason: "failed 2 rounds of DESIGN_REVIEW with:\\n- one\\n- two"',
    );
    expect(parseTaskMeta(parseDocument(document).raw).held_reason).toBe(
      held_reason,
    );
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
  testInTempDirs(
    "a task claimed by an agent with no process is refused",
    () => {
      // Given a claim naming the agent a but carrying no process
      const document = raw(
        baseMeta({ claimed_by: "a", claimed_pid: undefined }),
      );
      // When it is parsed as a task
      const issues = issuesOf(document);
      // Then it is refused, because a claim without a process cannot be reaped
      expect(issues).not.toEqual([]);
    },
  );
  testInTempDirs("a task holding a process but no agent is refused", () => {
    // Given a claim carrying the process 12 but naming no agent
    const document = raw(baseMeta({ claimed_by: undefined, claimed_pid: 12 }));
    // When it is parsed as a task
    const issues = issuesOf(document);
    // Then it is refused, because a process nobody owns cannot be reaped
    expect(issues).not.toEqual([]);
  });
  testInTempDirs("a check with an empty command line is refused", () => {
    // Given a task whose first check is an empty string
    const document = { ...baseMeta(), checks: [""] };
    // When it is parsed as a task
    const issues = issuesOf(document);
    // Then it is refused as too small, naming the entry that is wrong
    expect(issues[0]).toContain("checks[0]: Too small");
  });
  testInTempDirs(
    "a check written as a mapping rather than a command line is refused",
    () => {
      // Given a task whose first check is a mapping of a command
      const document = { ...baseMeta(), checks: [{ command: "bun test" }] };
      // When it is parsed as a task
      const issues = issuesOf(document);
      // Then it is refused as not a string, naming the entry that is wrong
      expect(issues[0]).toContain("checks[0]: Invalid input: expected string");
    },
  );
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
    const document = rebuildDocument(meta, "\n");
    // Then the fields keep the schema's order, so a diff shows only real changes
    expect(
      document
        .split("\n")
        .filter((line) => /^\w+:/.test(line))
        .map((line) => line.split(":")[0]),
    ).toEqual([
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
    async () => {
      // Given an empty task directory
      const dir = await makeTasksDir();
      // When a task is created in it
      const { id, filePath } = await createTask(
        dir,
        ORCHESTRATOR_DIR,
        "First task",
      );
      // Then it is the first id, quoted on disk and read back as a string
      expect(id).toBe("000001");
      expect(await fs.readFile(filePath, "utf-8")).toContain('id: "000001"');
      // Then it starts as new, with the moment it entered that state
      const { meta } = await readTaskFile(filePath);
      expect(meta.title).toBe("First task");
      expect(meta.state).toBe("NEW");
      expect(meta.state_entered).not.toBeUndefined();
    },
  );
  testInTempDirs(
    "a title carrying replacement patterns is stored verbatim",
    async () => {
      // Given an empty task directory
      const dir = await makeTasksDir();
      // Given the title Fix $& and $` and $' handling, whose patterns a replacement would expand
      const title = "Fix $& and $` and $' handling";
      // When a task is created with it
      const created = await createTask(dir, ORCHESTRATOR_DIR, title);
      // Then it comes back exactly as it was typed
      expect((await readTaskFile(created.filePath)).meta.title).toBe(
        "Fix $& and $` and $' handling",
      );
    },
  );
  testInTempDirs(
    "a title carrying YAML punctuation is stored verbatim",
    async () => {
      // Given an empty task directory
      const dir = await makeTasksDir();
      // Given the title Add: colon, #hash and a "quote", whose punctuation YAML gives meaning to
      const title = 'Add: colon, #hash and a "quote"';
      // When a task is created with it
      const created = await createTask(dir, ORCHESTRATOR_DIR, title);
      // Then it comes back exactly as it was typed
      expect((await readTaskFile(created.filePath)).meta.title).toBe(
        'Add: colon, #hash and a "quote"',
      );
    },
  );
  testInTempDirs("a task with an empty title is refused", async () => {
    // Given an empty task directory
    const dir = await makeTasksDir();
    // Given a title with no characters in it at all
    const title = "";
    // When a task is created with it
    const attempt = async () => await createTask(dir, ORCHESTRATOR_DIR, title);
    // Then it is refused, because a task nobody named cannot be worked on
    await expect(attempt()).rejects.toThrow(/title is required/);
  });
  testInTempDirs("a task titled with only spaces is refused", async () => {
    // Given an empty task directory
    const dir = await makeTasksDir();
    // Given a title of three spaces, with nothing in it a person could read
    const title = "   ";
    // When a task is created with it
    const attempt = async () => await createTask(dir, ORCHESTRATOR_DIR, title);
    // Then it is refused, because a task nobody named cannot be worked on
    await expect(attempt()).rejects.toThrow(/title is required/);
  });
  testInTempDirs("the first task created takes the id 000001", async () => {
    // Given an empty task directory
    const dir = await makeTasksDir();
    // When the first task is created
    const first = await createTask(dir, ORCHESTRATOR_DIR, "a");
    // Then it takes the id 000001, and the counter reads two for the next one
    expect(first.id).toBe("000001");
    expect((await fs.readFile(nextTaskIdPath(dir), "utf-8")).trim()).toBe("2");
  });
  testInTempDirs("the second task created takes the id 000002", async () => {
    // Given a task directory holding the first task
    const dir = await makeTasksDir();
    await createTask(dir, ORCHESTRATOR_DIR, "a");
    // When the second task is created
    const second = await createTask(dir, ORCHESTRATOR_DIR, "b");
    // Then it takes the id 000002, and the counter reads three for the next one
    expect(second.id).toBe("000002");
    expect((await fs.readFile(nextTaskIdPath(dir), "utf-8")).trim()).toBe("3");
  });
  testInTempDirs("the third task created takes the id 000003", async () => {
    // Given a task directory holding the first two tasks
    const dir = await makeTasksDir();
    await createTask(dir, ORCHESTRATOR_DIR, "a");
    await createTask(dir, ORCHESTRATOR_DIR, "b");
    // When the third task is created
    const third = await createTask(dir, ORCHESTRATOR_DIR, "c");
    // Then it takes the id 000003, and the counter reads four for the next one
    expect(third.id).toBe("000003");
    expect((await fs.readFile(nextTaskIdPath(dir), "utf-8")).trim()).toBe("4");
  });
  testInTempDirs("a new task's body is the template's, unchanged", async () => {
    // Given an empty task directory
    const dir = await makeTasksDir();
    // When a task is created
    const { filePath } = await createTask(dir, ORCHESTRATOR_DIR, "t");
    // Then its body is what the template carries, for a person to fill in
    expect(parseDocument(await fs.readFile(filePath, "utf-8")).body).toBe(
      parseDocument(await fs.readFile(TEMPLATE_PATH, "utf-8")).body,
    );
  });
  testInTempDirs(
    "a project's own template is used over the shipped one",
    async () => {
      // Given a task directory carrying its own template
      const dir = await makeTasksDir();
      await fs.writeFile(
        path.join(dir, "template.md"),
        `${await fs.readFile(TEMPLATE_PATH, "utf-8")}\n## Rollout\n`,
      );
      // When a task is created
      const { filePath } = await createTask(dir, ORCHESTRATOR_DIR, "t");
      // Then the project's sections are what a new task starts with
      expect(await fs.readFile(filePath, "utf-8")).toContain("## Rollout");
    },
  );
  testInTempDirs("a counter someone has corrupted fails loudly", async () => {
    // Given a task directory whose counter is not a number
    const dir = await makeTasksDir();
    await fs.writeFile(nextTaskIdPath(dir), "not-a-number\n");
    // When a task is created
    const attempt = async () => await createTask(dir, ORCHESTRATOR_DIR, "t");
    // Then it fails and names the file, rather than guessing an id
    await expect(attempt()).rejects.toThrow(/Invalid value in next-task-id/);
  });
  testInTempDirs(
    "a task file that already exists is never written over",
    async () => {
      // Given a task directory whose counter has been wound back over a task
      const dir = await makeTasksDir();
      await createTask(dir, ORCHESTRATOR_DIR, "first");
      await fs.writeFile(nextTaskIdPath(dir), "1\n");
      // When a task is created at the id that is already taken
      const attempt = async () =>
        await createTask(dir, ORCHESTRATOR_DIR, "collision");
      // Then it fails, and the task already there is untouched
      await expect(attempt()).rejects.toThrow();
      expect((await readTaskFile(path.join(dir, "000001.md"))).meta.title).toBe(
        "first",
      );
    },
  );
  testInTempDirs(
    "a create that fails leaves the graph open to the next one",
    async () => {
      // Given a task directory whose counter has been wound back over a task
      const dir = await makeTasksDir();
      await createTask(dir, ORCHESTRATOR_DIR, "first");
      await fs.writeFile(nextTaskIdPath(dir), "1\n");
      // When a create collides with the task and fails
      await expect(
        createTask(dir, ORCHESTRATOR_DIR, "collision"),
      ).rejects.toThrow();
      // Then a fresh create still takes the id the counter owes
      await fs.rm(path.join(dir, "000001.md"));
      const { id } = await createTask(dir, ORCHESTRATOR_DIR, "retry");
      expect(id).toBe("000001");
    },
  );
  testInTempDirs(
    "a graph another server holds is refused, not waited for",
    async () => {
      // Given a task directory a live server has taken for itself
      const dir = await makeTasksDir();
      await graphLock(dir).take();
      // When a second server tries to take the same graph
      const attempt = async () => await graphLock(dir).take();
      // Then it refuses, naming the server that holds the graph
      await expect(attempt()).rejects.toThrow(
        `already in use by server ${process.pid}`,
      );
    },
  );
  testInTempDirs(
    "a graph whose server died without clearing is taken over",
    async () => {
      // Given a task directory whose last server died holding it
      const dir = await makeTasksDir();
      await fs.writeFile(lockPath(dir), `${await deadPid()}`);
      // When a new server takes the graph
      await graphLock(dir).take();
      // Then the lock names the new server, so a crash never wedges the graph
      expect(await graphLock(dir).holder()).toBe(process.pid);
    },
  );
});
describe("Feature: rewriting the body of a task", () => {
  testInTempDirs(
    "the body is replaced and the fields are left alone",
    async () => {
      // Given a task an agent is working on
      const { dir, id } = await toWorking();
      const before = await metaOf(dir, id);
      // When its body is rewritten
      await writeTaskBody(dir, id, "# Goal\n\nA rewritten goal.");
      // Then the new body is on disk and none of the fields moved
      expect(await bodyOf(path.join(dir, `${id}.md`))).toBe(
        "\n\n# Goal\n\nA rewritten goal.\n",
      );
      expect(await metaOf(dir, id)).toEqual(before);
    },
  );
  testInTempDirs(
    "a body is normalized to the spacing every document has",
    async () => {
      // Given a body with stray blank lines above and below it
      const { dir, id } = await newTask();
      // When that body is written to the task
      await writeTaskBody(dir, id, "\n\n\n# Goal\n\n\n");
      // Then it is stored with one blank line above and one newline below
      expect(await bodyOf(path.join(dir, `${id}.md`))).toBe("\n\n# Goal\n");
    },
  );
  testInTempDirs(
    "an empty body is refused and the document is untouched",
    async () => {
      // Given a task and a body that is only whitespace
      const { dir, id } = await newTask();
      const before = await fs.readFile(path.join(dir, `${id}.md`), "utf-8");
      // When that body is written
      const attempt = async () => await writeTaskBody(dir, id, "   \n ");
      // Then it is refused, and the document is left exactly as it was
      await expect(attempt()).rejects.toThrow(/body is required/);
      expect(await fs.readFile(path.join(dir, `${id}.md`), "utf-8")).toBe(
        before,
      );
    },
  );
  testInTempDirs(
    "a body written to a task that does not exist is refused",
    async () => {
      // Given an empty task directory
      const dir = await makeTasksDir();
      // When a body is written to an id nothing carries
      const attempt = async () => await writeTaskBody(dir, "000999", "# Goal");
      // Then it is refused, naming the task that was not found
      await expect(attempt()).rejects.toThrow(/not found/);
    },
  );
  testInTempDirs("a body written before a transition survives it", async () => {
    // Given a task whose body the manager has just rewritten
    const { dir, id } = await toWorking();
    await writeTaskBody(dir, id, "# Goal\n\nprose the manager wrote");
    // When the task is held straight afterwards
    await run(dir, id, "hold", "waiting on the manager");
    // Then both the prose and the hold are on disk, because both took the lock
    expect(await bodyOf(path.join(dir, `${id}.md`))).toBe(
      "\n\n# Goal\n\nprose the manager wrote\n",
    );
    expect((await metaOf(dir, id)).held_reason).toBe("waiting on the manager");
  });
});
