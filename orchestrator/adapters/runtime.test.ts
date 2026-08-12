import { afterAll, beforeAll, describe, expect, setSystemTime } from "bun:test";
import {
  TEST_ROOT,
  tempDir,
  testInTempDirs,
  withTasksRoot,
} from "../testing/temp-dirs.ts";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { TaskFiles, attemptOf, historyName, rotate } from "./task-files.ts";
import { type TransitionEntry, TransitionLog } from "./transition-log.ts";
import { isProcessAlive } from "./processes.ts";
import { splitDocument } from "../domain/task.ts";
import { Runtime, defaultTasksDir, graphKey, repoKey } from "./runtime.ts";
import * as git from "./git.ts";
import { STATUS_SHOWN_LINES, statusOf } from "../domain/guard.ts";
import type { TaskState } from "../domain/state-machine.ts";
import { commitIn, tempRepo } from "../testing/orchestrator-jig.ts";
import { deadPid } from "../testing/graph-jig.ts";
import { at } from "../testing/present.ts";
beforeAll(() => {
  setSystemTime(new Date("2026-01-01").getTime());
});
afterAll(() => {
  setSystemTime();
});
const REPO = "/home/model/project";
async function runtimeFor(repo = REPO, serverRoot?: string): Promise<Runtime> {
  return Runtime.open(repo, serverRoot ?? (await tempDir("orchestrator-")));
}
describe("Feature: where a project's runtime state lives", () => {
  testInTempDirs("a project is keyed by the path it was opened at", () => {
    // Given the absolute path of a checkout
    const repo = "/home/model/task-graph-template";
    // When the runtime key for it is worked out
    const key = repoKey(repo);
    // Then it is the path itself, flattened into one directory name
    expect(key).toBe("-home-model-task-graph-template");
  });
  testInTempDirs("two clones of one project never share a runtime", () => {
    // Given the same project checked out at a different path
    const clone = "/b/project";
    // When the runtime key for it is worked out
    const key = repoKey(clone);
    // Then it is the clone's own flattened path, never the other checkout's
    expect(key).toBe("-b-project");
  });
  testInTempDirs(
    "every path a task needs hangs off its own directory",
    async () => {
      // Given a runtime directory for a project
      const root = await tempDir("orchestrator-");
      const runtime = new Runtime("/home/model/task-graph-template", root);
      // When the paths of one task are worked out
      const paths = {
        root: runtime.root,
        assignment: runtime.assignment("000042"),
        worktree: runtime.worktree("000042"),
        session: runtime.sessionDir("000042", "reviewer"),
        check: runtime.checkLog("000042", 1),
      };
      // Then all of them sit under one directory, which discarding removes whole
      expect(paths).toEqual({
        root: path.join(root, "-home-model-task-graph-template"),
        assignment: path.join(
          root,
          "-home-model-task-graph-template",
          "000042",
          "ASSIGNMENT.md",
        ),
        worktree: path.join(
          root,
          "-home-model-task-graph-template",
          "000042",
          "worktree",
        ),
        session: path.join(
          root,
          "-home-model-task-graph-template",
          "000042",
          "session",
          "reviewer",
        ),
        check: path.join(
          root,
          "-home-model-task-graph-template",
          "000042",
          "check-1.log",
        ),
      });
    },
  );
  testInTempDirs(
    "the assignment sits beside the worktree, never inside it",
    async () => {
      // Given a runtime directory for a project
      const runtime = await runtimeFor();
      // When the assignment and the worktree of one task are compared
      const inside = runtime
        .assignment("000042")
        .startsWith(runtime.worktree("000042"));
      // Then the assignment is a sibling, so it never lands in a commit
      expect(inside).toBe(false);
      expect(path.dirname(runtime.assignment("000042"))).toBe(
        path.dirname(runtime.worktree("000042")),
      );
    },
  );
  testInTempDirs(
    "preparing a task makes the directories it will write to",
    async () => {
      // Given a runtime directory a task has never been dispatched in
      const runtime = await runtimeFor();
      // When the task is prepared
      await runtime.prepare("000042");
      // Then the history and both session directories are there to be written to
      expect(await fs.exists(runtime.history("000042"))).toBe(true);
      expect(await fs.exists(runtime.sessionDir("000042", "worker"))).toBe(
        true,
      );
      expect(await fs.exists(runtime.sessionDir("000042", "reviewer"))).toBe(
        true,
      );
    },
  );
});
describe("Feature: where a project's task graph lives", () => {
  testInTempDirs(
    "a project directly under home is keyed by its own name",
    () => {
      // Given the home directory of the user
      const home = "/home/model";
      // Given a project sitting directly below it, named project
      const project = "/home/model/project";
      // When the graph key of it is worked out
      const worked = graphKey(project, home);
      // Then the key is its name below home
      expect(worked).toBe("project");
    },
  );
  testInTempDirs(
    "a project nested under home is keyed by the names it sits below",
    () => {
      // Given the home directory of the user
      const home = "/home/model";
      // Given a project two directories below it, at a then b
      const project = "/home/model/a/b";
      // When the graph key of it is worked out
      const worked = graphKey(project, home);
      // Then the key is its path below home, flattened into one name
      expect(worked).toBe("a-b");
    },
  );
  testInTempDirs("the home directory itself is keyed by its whole path", () => {
    // Given the home directory of the user
    const home = "/home/model";
    // Given the home directory is the project being worked in
    const project = "/home/model";
    // When the graph key of it is worked out
    const worked = graphKey(project, home);
    // Then the key is its whole path, flattened into one name
    expect(worked).toBe("-home-model");
  });
  testInTempDirs("a project outside home is keyed by its whole path", () => {
    // Given the home directory of the user
    const home = "/home/model";
    // Given a project in the temporary directory, outside home altogether
    const project = "/tmp/other";
    // When the graph key of it is worked out
    const worked = graphKey(project, home);
    // Then the key is its whole path, flattened into one name
    expect(worked).toBe("-tmp-other");
  });
  testInTempDirs(
    "the root the graph lives under can be pointed elsewhere",
    async () => {
      // Given an environment naming another root for task graphs
      const root = "/tmp/tg";
      // When the task directory of a project is worked out
      const dir = await withTasksRoot(root, () =>
        defaultTasksDir("/home/model/project"),
      );
      // Then it is that root joined with the project's key
      expect(dir).toBe("/tmp/tg/project");
    },
  );
  testInTempDirs(
    "the suite never writes a task graph into the real home",
    () => {
      // Given the test rig, which points the root at a temporary directory
      const project = "/tmp/whatever";
      // When the task directory of a project is worked out
      const dir = defaultTasksDir(project);
      // Then it lands under the test root, and never in the user's own graph
      expect(dir).toBe(
        path.join(TEST_ROOT, "task-graph-root", "-tmp-whatever"),
      );
      expect(dir).not.toContain(path.join(os.homedir(), "task-graph"));
    },
  );
});
describe("Feature: keeping a second server out of the runtime directory", () => {
  testInTempDirs("the first server to start takes the directory", async () => {
    // Given a runtime directory no server has started against
    const runtime = await runtimeFor();
    // When the server takes the lock
    await runtime.takeLock();
    // Then the lock names the server, so others can see who holds it
    expect(await runtime.lockHolder()).toBe(process.pid);
  });
  testInTempDirs(
    "a server holding the directory keeps another out",
    async () => {
      // Given a runtime directory a live server already holds
      const serverRoot = await tempDir("orchestrator-");
      const runtime = await runtimeFor(REPO, serverRoot);
      await runtime.takeLock();
      // When another server tries to take the lock
      const attempt = async () => await runtime.takeLock();
      // Then it refuses, naming the server that holds the directory
      await expect(attempt()).rejects.toThrow(
        `already in use by server ${process.pid}`,
      );
    },
  );
  testInTempDirs("a stale lock from a dead server is taken over", async () => {
    // Given a runtime directory whose last server died without clearing its lock
    const runtime = await runtimeFor();
    await fs.writeFile(runtime.lockFile, `${await deadPid()}`);
    // When a new server takes the lock
    await runtime.takeLock();
    // Then the lock names the new server
    expect(await runtime.lockHolder()).toBe(process.pid);
  });
  testInTempDirs(
    "two servers racing for a stale lock end with one holder",
    async () => {
      // Given a runtime directory with a stale lock, and two servers claiming it
      const root = await tempDir("orchestrator-");
      const first = new Runtime(REPO, root);
      const second = new Runtime(REPO, root);
      await fs.mkdir(first.root, { recursive: true });
      await fs.writeFile(first.lockFile, `${await deadPid()}`);
      // When both servers take the lock at once
      const results = await Promise.allSettled([
        first.takeLock(),
        second.takeLock(),
      ]);
      // Then at least one of them holds it, and no one leaves it empty
      expect(results.some((result) => result.status === "fulfilled")).toBe(
        true,
      );
      for (const result of results) {
        if (result.status === "rejected") {
          expect(String(result.reason)).toMatch(/already in use by server/);
        }
      }
      expect(await first.lockHolder()).toBe(process.pid);
    },
  );
  testInTempDirs("a server clears the lock it holds", async () => {
    // Given a runtime directory the server holds
    const runtime = await runtimeFor();
    await runtime.takeLock();
    // When the server is done with it
    await runtime.clearLock();
    // Then nothing is left to keep another server out
    expect(await runtime.lockHolder()).toBe(undefined);
  });
  testInTempDirs(
    "a server does not clear a lock it does not hold",
    async () => {
      // Given a lock some other server holds
      const runtime = await runtimeFor();
      const other = await deadPid();
      await fs.writeFile(runtime.lockFile, `${other}`);
      // When the server clears the lock
      await runtime.clearLock();
      // Then the other server's lock stays, still naming its holder
      expect(await runtime.lockHolder()).toBe(other);
    },
  );
});
describe("Feature: the server log", () => {
  testInTempDirs(
    "the log keeps its most recent lines and stays bounded",
    async () => {
      // Given a server log with a small cap on how much it keeps
      const runtime = await runtimeFor();
      // When far more is written to it than it can hold
      for (let i = 0; i < 200; i++) await runtime.log(`line ${i}`, 400);
      // Then what is left is under the cap, ends at the newest line, and is whole
      const contents = await fs.readFile(runtime.serverLog, "utf-8");
      expect(contents.length).toBeLessThanOrEqual(400);
      expect(contents.endsWith("line 199\n")).toBe(true);
      expect(contents.split("\n").filter((line) => line.length > 0)).toEqual(
        contents.split("\n").filter((line) => /^\d{4}-/.test(line)),
      );
    },
  );
  testInTempDirs(
    "concurrent log calls keep the bounded end of the log",
    async () => {
      // Given a server log with a small cap on how much it keeps
      const runtime = await runtimeFor();
      // When many lines are written to it all at once
      await Promise.all(
        Array.from({ length: 200 }, (_, i) => runtime.log(`line ${i}`, 400)),
      );
      // Then the log is bounded, ends at the newest line, and is whole
      const contents = await fs.readFile(runtime.serverLog, "utf-8");
      expect(contents.length).toBeLessThanOrEqual(400);
      expect(contents.endsWith("line 199\n")).toBe(true);
      expect(contents.split("\n").filter((line) => line.length > 0)).toEqual(
        contents.split("\n").filter((line) => /^\d{4}-/.test(line)),
      );
    },
  );
  testInTempDirs("a log that was closed writes again if asked", async () => {
    // Given a server log that has been written to and then closed
    const runtime = await runtimeFor();
    await runtime.log("before the close");
    await runtime.close();
    // When something still in flight logs afterwards
    await runtime.log("after the close");
    // Then the line lands beside the earlier one instead of failing
    const contents = await fs.readFile(runtime.serverLog, "utf-8");
    expect(contents).toContain("before the close");
    expect(contents).toContain("after the close");
  });
});
describe("Feature: discarding a task that is finished with", () => {
  testInTempDirs("the whole task directory goes with it", async () => {
    // Given a task that has been prepared and written to
    const runtime = await runtimeFor();
    await runtime.prepare("000042");
    await fs.writeFile(runtime.assignment("000042"), "gone soon");
    // When the task is discarded
    await runtime.discard("000042");
    // Then nothing of it is left behind on disk
    expect(await fs.exists(runtime.taskRoot("000042"))).toBe(false);
  });
  testInTempDirs(
    "discarding a task that was never started is harmless",
    async () => {
      // Given a task that was closed before it was ever dispatched
      const runtime = await runtimeFor();
      // When the task is discarded
      await runtime.discard("000042");
      // Then nothing fails, because there was nothing to remove
    },
  );
});
describe("Feature: telling whether a process is still running", () => {
  testInTempDirs("a process that is running reads as alive", async () => {
    // Given the pid of this process, which is certainly running
    const candidate = process.pid;
    // When the candidate is checked
    const alive = await isProcessAlive(candidate);
    // Then it reads as alive
    expect(alive).toBe(true);
  });
  testInTempDirs("a pid nothing has ever had reads as dead", async () => {
    // Given a pid beyond anything this machine has handed out
    const candidate = 2 ** 22;
    // When the candidate is checked
    const alive = await isProcessAlive(candidate);
    // Then it reads as dead, so the reaper is free to take the task back
    expect(alive).toBe(false);
  });
  testInTempDirs("a child that exited is dead, waited on or not", async () => {
    // Given a detached child that has run to completion
    const proc = Bun.spawn(["true"], {
      stdout: "pipe",
      stderr: "pipe",
      stdin: "pipe",
      detached: true,
    });
    const decoder = new TextDecoder();
    for await (const chunk of proc.stdout) {
      decoder.decode(chunk, { stream: true });
    }
    await proc.exited;
    // When its pid is checked
    const alive = await isProcessAlive(proc.pid);
    // Then it reads as dead, so a zombie never shields a task from the reaper
    expect(alive).toBe(false);
  });
});
describe("Feature: the log of every transition applied", () => {
  const entry = (to: TaskState): Omit<TransitionEntry, "seq" | "at"> => ({
    task_id: "000042",
    transition: "t",
    from: "WORK",
    to,
    by: "pi-1",
  });
  testInTempDirs(
    "the sequence advances by one for each transition",
    async () => {
      // Given a fresh transition log
      const log = await TransitionLog.open(
        path.join(await tempDir("orchestrator-"), "transitions.jsonl"),
      );
      // When two transitions are appended
      const appended = [
        await log.append(entry("CHECK")),
        await log.append(entry("WORK")),
      ];
      // Then each takes the next number, and the cursor reaches the last of them
      expect(appended.map((one) => one.seq)).toEqual([1, 2]);
      expect(log.cursor).toBe(2);
    },
  );
  testInTempDirs(
    "a log reopened by a new server continues its sequence",
    async () => {
      // Given a log a previous server appended to
      const filePath = path.join(
        await tempDir("orchestrator-"),
        "transitions.jsonl",
      );
      await (await TransitionLog.open(filePath)).append(entry("CHECK"));
      // Given a new server opening the same log
      const reopened = await TransitionLog.open(filePath);
      // When it appends to it
      const appended = await reopened.append(entry("WORK"));
      // Then it picks up where the last one left off, so no number repeats
      expect(reopened.cursor).toBe(2);
      expect(appended.seq).toBe(2);
    },
  );
  testInTempDirs(
    "a reader is given every transition in the order applied",
    async () => {
      // Given a log with three transitions in it
      const log = await TransitionLog.open(
        path.join(await tempDir("orchestrator-"), "transitions.jsonl"),
      );
      for (const to of ["WORK", "CHECK", "WORK_REVIEW"] as const) {
        await log.append(entry(to));
      }
      // When the log is read back
      const entries = await log.read();
      // Then every entry is there, numbered so a reader can find its own place
      expect(entries.map((one) => one.to)).toEqual([
        "WORK",
        "CHECK",
        "WORK_REVIEW",
      ]);
      expect(entries.map((one) => one.seq)).toEqual([1, 2, 3]);
    },
  );
  testInTempDirs(
    "a log nothing has been written to reads as empty",
    async () => {
      // Given a log file that does not exist yet
      const filePath = path.join(
        await tempDir("orchestrator-"),
        "transitions.jsonl",
      );
      // When the log is read
      const entries = await (await TransitionLog.open(filePath)).read();
      // Then it reads as empty rather than failing the first tick
      expect(entries).toEqual([]);
    },
  );
  testInTempDirs(
    "the file is trimmed but the sequence keeps counting",
    async () => {
      // Given a log that keeps only its last ten entries
      const filePath = path.join(
        await tempDir("orchestrator-"),
        "transitions.jsonl",
      );
      const log = await TransitionLog.open(filePath, 10);
      // When twenty-five transitions are appended
      for (let i = 0; i < 25; i++) await log.append(entry("WORK"));
      // Then only the last ten are kept, still numbered from where they happened
      const kept = await log.read();
      expect(kept).toHaveLength(10);
      expect(at(kept, 0).seq).toBe(16);
      expect(at(kept, 9).seq).toBe(25);
      // Then a server reopening the log carries on from the same number
      expect(log.cursor).toBe(25);
      expect((await TransitionLog.open(filePath, 10)).cursor).toBe(25);
    },
  );
  testInTempDirs(
    "concurrent appends all land, and none is lost to another's rewrite",
    async () => {
      // Given a log that keeps only its last ten entries
      const filePath = path.join(
        await tempDir("orchestrator-"),
        "transitions.jsonl",
      );
      const log = await TransitionLog.open(filePath, 10);
      // When fifty transitions are appended all at once
      const appended = await Promise.all(
        Array.from({ length: 50 }, (_, i) =>
          log.append(entry(i % 2 === 0 ? "WORK" : "CHECK")),
        ),
      );
      // Then every one is acknowledged, and the newest ten are on disk
      expect(appended.map((one) => one.seq)).toEqual(
        Array.from({ length: 50 }, (_, i) => i + 1),
      );
      expect(log.cursor).toBe(50);
      expect((await log.read()).map((one) => one.seq)).toEqual(
        Array.from({ length: 10 }, (_, i) => i + 41),
      );
    },
  );
  testInTempDirs(
    "a reader never sees the log torn by an append or a trim",
    async () => {
      // Given a log that keeps only its last ten entries
      const filePath = path.join(
        await tempDir("orchestrator-"),
        "transitions.jsonl",
      );
      const log = await TransitionLog.open(filePath, 10);
      // When reads and appends race each other, past the point where it trims
      const results = await Promise.all(
        Array.from({ length: 100 }, (_, i) =>
          i % 4 === 0
            ? log.read()
            : log.append(entry(i % 2 === 0 ? "WORK" : "CHECK")),
        ),
      );
      // Then every read is a whole log: complete entries, none torn by a rewrite
      const snapshots = results.filter((one): one is TransitionEntry[] =>
        Array.isArray(one),
      );
      expect(snapshots.some((snapshot) => snapshot.length > 0)).toBe(true);
      for (const snapshot of snapshots) {
        const seqs = snapshot.map((one) => one.seq);
        expect(seqs.slice(1)).toEqual(seqs.slice(0, -1).map((seq) => seq + 1));
      }
    },
  );
  testInTempDirs(
    "a transition still in flight at shutdown is recorded, not lost",
    async () => {
      // Given a transition log the manager has already closed on its way out
      const log = await TransitionLog.open(
        path.join(await tempDir("orchestrator-"), "transitions.jsonl"),
      );
      await log.append(entry("WORK"));
      await log.close();
      // When a settling agent appends one last transition
      const late = await log.append(entry("CHECK"));
      // Then it is written and numbered in turn, rather than failing the settle
      expect(late.seq).toBe(2);
      expect((await log.read()).map((one) => one.to)).toEqual([
        "WORK",
        "CHECK",
      ]);
    },
  );
});
describe("Feature: keeping what an agent wrote on an earlier attempt", () => {
  function assignment(note: string): string {
    return [
      "---",
      'assignment: "000042"',
      "todos: []",
      "checks: []",
      "result: null",
      "---",
      "",
      "## Notes",
      "",
      note,
    ].join("\n");
  }
  testInTempDirs(
    "the first dispatch of a task has nothing behind it",
    async () => {
      // Given a task that has never been dispatched
      const history = path.join(await tempDir("orchestrator-"), "history");
      // When the attempt about to be made is counted
      const attempt = await attemptOf(history);
      // Then it is the first
      expect(attempt).toBe(1);
    },
  );
  testInTempDirs(
    "rotating never writes over what an agent wrote before",
    async () => {
      // Given a task whose first attempt has already been rotated into history
      const dir = await tempDir("orchestrator-");
      const live = path.join(dir, "ASSIGNMENT.md");
      const history = path.join(dir, "history");
      await fs.writeFile(live, assignment("the first attempt"));
      expect(await rotate(live, history)).toBe(
        path.join(history, historyName(1)),
      );
      expect(await fs.exists(live)).toBe(false);
      // Given a second attempt written to the live assignment
      await fs.writeFile(live, assignment("the second attempt"));
      // When the live file is rotated into history
      await rotate(live, history);
      // Then both attempts are kept, numbered in the order they were made
      expect((await fs.readdir(history)).sort()).toEqual([
        "ASSIGNMENT.1.md",
        "ASSIGNMENT.2.md",
      ]);
      expect(
        splitDocument(
          await fs.readFile(path.join(history, "ASSIGNMENT.1.md"), "utf-8"),
        ).body,
      ).toContain("the first attempt");
      expect(await attemptOf(history)).toBe(3);
    },
  );
  testInTempDirs(
    "rotating when there is nothing to rotate is harmless",
    async () => {
      // Given a task with no live assignment on disk
      const dir = await tempDir("orchestrator-");
      // When the assignment is rotated
      const rotated = await rotate(
        path.join(dir, "ASSIGNMENT.md"),
        path.join(dir, "history"),
      );
      // Then nothing is moved, and the dispatch carries on
      expect(rotated).toBeUndefined();
    },
  );
});
describe("Feature: messages waiting for an agent's next turn", () => {
  async function messages(): Promise<TaskFiles> {
    const runtime = await runtimeFor();
    await runtime.prepare("000042");
    return new TaskFiles(runtime);
  }
  testInTempDirs("a second message is kept beside the first", async () => {
    // Given a task with one message already waiting
    const files = await messages();
    await files.queue("000042", "WORK", "the checks failed");
    // When another message is queued for the same turn
    await files.queue("000042", "WORK", "the manager asked for a change");
    // Then the agent is handed both of them, in one drain
    const drained = await files.drain("000042", "WORK");
    expect(drained).toContain("the checks failed");
    expect(drained).toContain("the manager asked for a change");
  });
  testInTempDirs("a drain leaves nothing for the next turn", async () => {
    // Given a task whose waiting message has been drained
    const files = await messages();
    await files.queue("000042", "WORK", "the checks failed");
    expect(await files.drain("000042", "WORK")).toContain("the checks failed");
    // When the next turn drains again
    const drained = await files.drain("000042", "WORK");
    // Then it is handed nothing, rather than the message twice
    expect(drained).toBe("");
  });
});
describe("Feature: the workspace an agent works in", () => {
  testInTempDirs("a workspace borrows the repository's objects", async () => {
    // Given a repository with a commit in it
    const repo = await tempRepo();
    // Given a path the clone will land on
    const workspace = path.join(await tempDir("clone-"), "worktree");
    // When a workspace is cloned from it
    await git.createWorkspace(repo, "work/000001", workspace, "master");
    // Then it points at the repository's objects instead of copying them
    expect(
      (
        await fs.readFile(
          path.join(workspace, ".git", "objects", "info", "alternates"),
          "utf-8",
        )
      ).trim(),
    ).toBe(path.join(repo, ".git", "objects"));
  });
  testInTempDirs(
    "a workspace inherits the repository's commit identity",
    async () => {
      // Given a repository configured with an author
      const repo = await tempRepo();
      // Given a path the clone will land on
      const workspace = path.join(await tempDir("clone-"), "worktree");
      // When a workspace is cloned from it
      await git.createWorkspace(repo, "work/000001", workspace, "master");
      // Then the agent's commits carry that author, which a plain clone would not
      expect(
        (
          await git.gitOrThrow(workspace, ["config", "--get", "user.email"])
        ).trim(),
      ).toBe("orchestrator@example.com");
    },
  );
  testInTempDirs(
    "a workspace starts on its task branch, cut from the base",
    async () => {
      // Given a repository with a base branch
      const repo = await tempRepo();
      // Given a path the clone will land on
      const workspace = path.join(await tempDir("clone-"), "worktree");
      // When a workspace is cloned for a task
      await git.createWorkspace(repo, "work/000001", workspace, "master");
      // Then it is on the task's own branch, standing where the base does
      expect(
        (
          await git.gitOrThrow(workspace, ["rev-parse", "--abbrev-ref", "HEAD"])
        ).trim(),
      ).toBe("work/000001");
      expect(await git.gitOrThrow(workspace, ["rev-parse", "HEAD"])).toBe(
        await git.gitOrThrow(repo, ["rev-parse", "master"]),
      );
    },
  );
  testInTempDirs(
    "a recloned workspace comes back to the work already done",
    async () => {
      // Given a workspace whose commits were harvested before it was removed
      const repo = await tempRepo();
      const first = path.join(await tempDir("clone-"), "worktree");
      await git.createWorkspace(repo, "work/000001", first, "master");
      await commitIn(first, "b.txt", "work\n");
      await git.harvest(repo, first, "work/000001");
      await git.removeWorkspace(first);
      // Given a path the new clone will land on
      const second = path.join(await tempDir("clone-"), "worktree");
      // When it is cloned again for the same task
      await git.createWorkspace(repo, "work/000001", second, "master");
      // Then it checks out the branch that survived, not the base it was cut from
      expect(
        (
          await git.gitOrThrow(second, ["rev-parse", "--abbrev-ref", "HEAD"])
        ).trim(),
      ).toBe("work/000001");
      expect(await fs.exists(path.join(second, "b.txt"))).toBe(true);
    },
  );
  testInTempDirs(
    "harvesting lands the branch where the manager can see it",
    async () => {
      // Given a workspace with a commit the repository has never seen
      const repo = await tempRepo();
      const workspace = path.join(await tempDir("clone-"), "worktree");
      await git.createWorkspace(repo, "work/000001", workspace, "master");
      await commitIn(workspace, "b.txt", "work\n");
      expect(await git.branchExists(repo, "work/000001")).toBe(false);
      // When the workspace is harvested
      await git.harvest(repo, workspace, "work/000001");
      // Then the branch is in the repository, and the base is untouched
      expect(await git.branchExists(repo, "work/000001")).toBe(true);
      expect(await git.gitOrThrow(repo, ["rev-parse", "work/000001"])).toBe(
        await git.gitOrThrow(workspace, ["rev-parse", "HEAD"]),
      );
      expect(await git.gitOrThrow(repo, ["rev-parse", "master"])).not.toBe(
        await git.gitOrThrow(repo, ["rev-parse", "work/000001"]),
      );
    },
  );
  testInTempDirs(
    "harvesting a linked worktree does nothing rather than fail",
    async () => {
      // Given a linked worktree, which already shares the repository's refs
      const repo = await tempRepo();
      const workspace = path.join(await tempDir("worktree-"), "worktree");
      await git.gitOrThrow(repo, [
        "worktree",
        "add",
        "-q",
        "-b",
        "work/000001",
        workspace,
        "master",
      ]);
      await commitIn(workspace, "b.txt", "work\n");
      expect(await git.sharesRefs(repo, workspace)).toBe(true);
      // When the worktree is harvested
      await git.harvest(repo, workspace, "work/000001");
      // Then the branch is already where it needs to be, and the fetch is skipped
      expect(await git.gitOrThrow(repo, ["rev-parse", "work/000001"])).toBe(
        await git.gitOrThrow(workspace, ["rev-parse", "HEAD"]),
      );
    },
  );
  testInTempDirs("a cloned workspace has refs of its own", async () => {
    // Given a repository with a commit in it
    const repo = await tempRepo();
    // Given a path the clone will land on
    const workspace = path.join(await tempDir("clone-"), "worktree");
    // When a workspace is cloned from it
    await git.createWorkspace(repo, "work/000001", workspace, "master");
    // Then it does not share the repository's refs, so harvesting is a real fetch
    expect(await git.sharesRefs(repo, workspace)).toBe(false);
  });
  testInTempDirs(
    "harvesting after a rebase replaces the branch that was there",
    async () => {
      // Given a harvested branch whose base has since moved on, and a rebase onto it
      const repo = await tempRepo();
      const workspace = path.join(await tempDir("clone-"), "worktree");
      await git.createWorkspace(repo, "work/000001", workspace, "master");
      await commitIn(workspace, "b.txt", "work\n");
      await git.harvest(repo, workspace, "work/000001");
      await commitIn(repo, "c.txt", "moved on\n");
      await git.syncBase(workspace, "master");
      expect((await git.rebase(workspace, "master")).code).toBe(0);
      // When the workspace is harvested again
      await git.harvest(repo, workspace, "work/000001");
      // Then the stale branch is replaced by the rebased one, ready to merge
      expect(await git.gitOrThrow(repo, ["rev-parse", "work/000001"])).toBe(
        await git.gitOrThrow(workspace, ["rev-parse", "HEAD"]),
      );
      expect(await git.isAncestor(repo, "master", "work/000001")).toBe(true);
    },
  );
  testInTempDirs(
    "syncing brings the workspace's copy of the base forward",
    async () => {
      // Given a workspace whose base has moved on in the repository
      const repo = await tempRepo();
      const workspace = path.join(await tempDir("clone-"), "worktree");
      await git.createWorkspace(repo, "work/000001", workspace, "master");
      await commitIn(repo, "c.txt", "moved on\n");
      expect(await git.gitOrThrow(workspace, ["rev-parse", "master"])).not.toBe(
        await git.gitOrThrow(repo, ["rev-parse", "master"]),
      );
      // When the base is synced into the workspace
      await git.syncBase(workspace, "master");
      // Then the workspace can rebase onto what the base has actually become
      expect(await git.gitOrThrow(workspace, ["rev-parse", "master"])).toBe(
        await git.gitOrThrow(repo, ["rev-parse", "master"]),
      );
    },
  );
  testInTempDirs(
    "a fresh workspace carries no commit and no change",
    async () => {
      // Given a repository with a commit in it
      const repo = await tempRepo();
      // Given a path the clone will land on
      const workspace = path.join(await tempDir("clone-"), "worktree");
      // When a workspace is cloned from it
      await git.createWorkspace(repo, "work/000001", workspace, "master");
      // Then the guard sees nothing committed and nothing changed
      expect(await git.commitCount(workspace, "master")).toBe(0);
      expect(await git.uncommitted(workspace)).toEqual([]);
    },
  );
  testInTempDirs(
    "a commit in the workspace is counted against the base",
    async () => {
      // Given a workspace with nothing committed in it
      const repo = await tempRepo();
      const workspace = path.join(await tempDir("clone-"), "worktree");
      await git.createWorkspace(repo, "work/000001", workspace, "master");
      // When the agent commits in it
      await commitIn(workspace, "b.txt", "work\n");
      // Then the guard sees the commit it made
      expect(await git.commitCount(workspace, "master")).toBe(1);
    },
  );
  testInTempDirs(
    "an untracked or modified file counts as uncommitted work",
    async () => {
      // Given a workspace with one file added and one changed
      const repo = await tempRepo();
      const workspace = path.join(await tempDir("clone-"), "worktree");
      await git.createWorkspace(repo, "work/000001", workspace, "master");
      await fs.writeFile(path.join(workspace, "b.txt"), "untracked\n");
      await fs.writeFile(path.join(workspace, "a.txt"), "modified\n");
      // When the workspace is read for uncommitted work
      const dirty = await git.uncommitted(workspace);
      // Then both are reported, so a submit without a commit can be caught
      expect(dirty).toEqual([" M a.txt", "?? b.txt"]);
    },
  );
  testInTempDirs("staged work is still uncommitted work", async () => {
    // Given a workspace whose changes have been staged but not committed
    const repo = await tempRepo();
    const workspace = path.join(await tempDir("clone-"), "worktree");
    await git.createWorkspace(repo, "work/000001", workspace, "master");
    await fs.writeFile(path.join(workspace, "b.txt"), "untracked\n");
    await fs.writeFile(path.join(workspace, "a.txt"), "modified\n");
    await git.gitOrThrow(workspace, ["add", "-A"]);
    // When the workspace is read for uncommitted work
    const dirty = await git.uncommitted(workspace);
    // Then staging does not count as committing
    expect(dirty).toEqual(["M  a.txt", "A  b.txt"]);
  });
  testInTempDirs("a long list of changes is cut down for a prompt", () => {
    // Given a workspace with far more changed files than a prompt should carry
    const dirty = Array.from({ length: 25 }, (_, at) => `?? file${at}.txt`);
    // When the list is written for the prompt the agent will read
    const cut = statusOf(dirty).split("\n");
    // Then it is capped, and says how many more there were
    expect(cut).toHaveLength(STATUS_SHOWN_LINES + 1);
    expect(cut[STATUS_SHOWN_LINES]).toBe("… and 5 more");
  });
  testInTempDirs("a short list of changes is written out in full", () => {
    // Given a workspace with three changed files
    const dirty = ["?? file0.txt", "?? file1.txt", "?? file2.txt"];
    // When the list is written for the prompt the agent will read
    const written = statusOf(dirty);
    // Then all of them are named, because they fit
    expect(written).toBe("?? file0.txt\n?? file1.txt\n?? file2.txt");
  });
  testInTempDirs(
    "the base a recloned workspace measures against is its remote",
    async () => {
      // Given a workspace recloned from a branch that had already been harvested
      const repo = await tempRepo();
      const first = path.join(await tempDir("clone-"), "worktree");
      await git.createWorkspace(repo, "work/000001", first, "master");
      await commitIn(first, "b.txt", "work\n");
      await git.harvest(repo, first, "work/000001");
      await git.removeWorkspace(first);
      const second = path.join(await tempDir("clone-"), "worktree");
      await git.createWorkspace(repo, "work/000001", second, "master");
      // When its commits are counted against the base
      const count = await git.commitCount(second, "master");
      // Then the count is right even though it has no local branch by that name
      await expect(
        git.gitOrThrow(second, ["rev-parse", "master"]),
      ).rejects.toThrow();
      expect(count).toBe(1);
    },
  );
  testInTempDirs(
    "the commit count stays the agent's own as the base moves",
    async () => {
      // Given a workspace with one commit, and a base that has moved on since
      const repo = await tempRepo();
      const workspace = path.join(await tempDir("clone-"), "worktree");
      await git.createWorkspace(repo, "work/000001", workspace, "master");
      await commitIn(workspace, "b.txt", "work\n");
      await commitIn(repo, "c.txt", "moved on\n");
      await git.syncBase(workspace, "master");
      // When its commits are counted against the base
      const count = await git.commitCount(workspace, "master");
      // Then only the agent's own commit is counted, not the base's
      expect(count).toBe(1);
    },
  );
  testInTempDirs(
    "removing a workspace leaves the repository untouched",
    async () => {
      // Given a workspace cloned from a repository
      const repo = await tempRepo();
      const workspace = path.join(await tempDir("clone-"), "worktree");
      await git.createWorkspace(repo, "work/000001", workspace, "master");
      // When the workspace is removed, and removed again
      await git.removeWorkspace(workspace);
      // Then it is gone, the repository is clean, and removing it twice is harmless
      expect(await fs.exists(workspace)).toBe(false);
      expect(await git.gitOrThrow(repo, ["status", "--porcelain"])).toBe("");
      await git.removeWorkspace(workspace);
    },
  );
});
