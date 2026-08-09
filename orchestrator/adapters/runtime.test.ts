import { afterAll, beforeAll, describe, expect, setSystemTime } from "bun:test";
import {
  TEST_ROOT,
  tempDir,
  testInTempDirs,
  withTasksRoot,
} from "../testing/temp-dirs.ts";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { attemptOf, historyName, rotate } from "./task-files.ts";
import { type TransitionEntry, TransitionLog } from "./transition-log.ts";
import { isProcessAlive } from "./task-store.ts";
import { splitDocument } from "../domain/task.ts";
import {
  Runtime,
  defaultTasksDir,
  graphKey,
  repoKey,
  writeAtomic,
} from "./runtime.ts";
import * as git from "./git.ts";
import { STATUS_SHOWN_LINES, statusOf } from "../domain/guard.ts";
import type { TaskState } from "../domain/state-machine.ts";
import { commitIn, tempRepo } from "../testing/orchestrator-jig.ts";
import { deadPid } from "../testing/graph-jig.ts";

beforeAll(() => {
  setSystemTime(new Date("2026-01-01").getTime());
});

afterAll(() => {
  setSystemTime();
});

const REPO = "/home/model/project";

function runtimeFor(
  repo = REPO,
  serverRoot = tempDir("orchestrator-"),
): Runtime {
  return new Runtime(repo, serverRoot);
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

  testInTempDirs("every path a task needs hangs off its own directory", () => {
    // Given a runtime directory for a project
    const root = tempDir("orchestrator-");
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
  });

  testInTempDirs(
    "the assignment sits beside the worktree, never inside it",
    () => {
      // Given a runtime directory for a project
      const runtime = runtimeFor();

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
    () => {
      // Given a runtime directory a task has never been dispatched in
      const runtime = runtimeFor();

      // When the task is prepared
      runtime.prepare("000042");

      // Then the history and both session directories are there to be written to
      expect(fs.existsSync(runtime.history("000042"))).toBe(true);
      expect(fs.existsSync(runtime.sessionDir("000042", "worker"))).toBe(true);
      expect(fs.existsSync(runtime.sessionDir("000042", "reviewer"))).toBe(
        true,
      );
    },
  );

  testInTempDirs("a published view is never seen half written", () => {
    // Given a view that has already been published once
    const dir = tempDir("orchestrator-");
    const target = path.join(dir, "agents.json");
    writeAtomic(target, '{"agents":[]}');

    // When it is published again
    writeAtomic(target, '{"agents":[1]}');

    // Then the reader sees the new document whole, with no partial left behind
    expect(fs.readFileSync(target, "utf-8")).toBe('{"agents":[1]}');
    expect(fs.readdirSync(dir)).toEqual(["agents.json"]);
  });
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
  testInTempDirs("the first server to start takes the directory", () => {
    // Given a runtime directory no server has started against
    const runtime = runtimeFor();

    // When the server takes the lock
    runtime.takeLock();

    // Then the lock names the server, so others can see who holds it
    expect(runtime.lockHolder()).toBe(process.pid);
  });

  testInTempDirs("a server holding the directory keeps another out", () => {
    // Given a runtime directory a live server already holds
    const serverRoot = tempDir("orchestrator-");
    runtimeFor(REPO, serverRoot).takeLock();

    // When another server tries to take the lock
    const attempt = () => runtimeFor(REPO, serverRoot).takeLock();

    // Then it refuses, naming the server that holds the directory
    expect(attempt).toThrow(`already in use by server ${process.pid}`);
  });

  testInTempDirs("a stale lock from a dead server is taken over", async () => {
    // Given a runtime directory whose last server died without clearing its lock
    const runtime = runtimeFor();
    fs.writeFileSync(runtime.lockFile, `${await deadPid()}`);

    // When a new server takes the lock
    runtime.takeLock();

    // Then the lock names the new server
    expect(runtime.lockHolder()).toBe(process.pid);
  });

  testInTempDirs("a server clears the lock it holds", () => {
    // Given a runtime directory the server holds
    const runtime = runtimeFor();
    runtime.takeLock();

    // When the server is done with it
    runtime.clearLock();

    // Then nothing is left to keep another server out
    expect(runtime.lockHolder()).toBe(null);
  });

  testInTempDirs(
    "a server does not clear a lock it does not hold",
    async () => {
      // Given a lock some other server holds
      const runtime = runtimeFor();
      const other = await deadPid();
      fs.writeFileSync(runtime.lockFile, `${other}`);

      // When the server clears the lock
      runtime.clearLock();

      // Then the other server's lock stays, still naming its holder
      expect(runtime.lockHolder()).toBe(other);
    },
  );
});

describe("Feature: the server log", () => {
  testInTempDirs(
    "the log keeps its most recent lines and stays bounded",
    () => {
      // Given a server log with a small cap on how much it keeps
      const runtime = runtimeFor();

      // When far more is written to it than it can hold
      for (let i = 0; i < 200; i++) runtime.log(`line ${i}`, 400);

      // Then what is left is under the cap, ends at the newest line, and is whole
      const contents = fs.readFileSync(runtime.serverLog, "utf-8");
      expect(contents.length).toBeLessThanOrEqual(400);
      expect(contents.endsWith("line 199\n")).toBe(true);
      expect(contents.split("\n").filter((line) => line.length > 0)).toEqual(
        contents.split("\n").filter((line) => /^\d{4}-/.test(line)),
      );
    },
  );
});

describe("Feature: discarding a task that is finished with", () => {
  testInTempDirs("the whole task directory goes with it", () => {
    // Given a task that has been prepared and written to
    const runtime = runtimeFor();
    runtime.prepare("000042");
    fs.writeFileSync(runtime.assignment("000042"), "gone soon");

    // When the task is discarded
    runtime.discard("000042");

    // Then nothing of it is left behind on disk
    expect(fs.existsSync(runtime.taskRoot("000042"))).toBe(false);
  });

  testInTempDirs("discarding a task that was never started is harmless", () => {
    // Given a task that was closed before it was ever dispatched
    const runtime = runtimeFor();

    // When the task is discarded
    const attempt = () => runtime.discard("000042");

    // Then nothing fails, because there was nothing to remove
    expect(attempt).not.toThrow();
  });
});

describe("Feature: telling whether a process is still running", () => {
  testInTempDirs("a process that is running reads as alive", () => {
    // Given the pid of this process, which is certainly running
    const candidate = process.pid;

    // When the candidate is checked
    const alive = isProcessAlive(candidate);

    // Then it reads as alive
    expect(alive).toBe(true);
  });

  testInTempDirs("a pid nothing has ever had reads as dead", () => {
    // Given a pid beyond anything this machine has handed out
    const candidate = 2 ** 22;

    // When the candidate is checked
    const alive = isProcessAlive(candidate);

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

    // When its pid is checked
    const alive = isProcessAlive(proc.pid);

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

  testInTempDirs("the sequence advances by one for each transition", () => {
    // Given a fresh transition log
    const log = new TransitionLog(
      path.join(tempDir("orchestrator-"), "transitions.jsonl"),
    );

    // When two transitions are appended
    const appended = [log.append(entry("CHECK")), log.append(entry("WORK"))];

    // Then each takes the next number, and the cursor reaches the last of them
    expect(appended.map((one) => one.seq)).toEqual([1, 2]);
    expect(log.cursor).toBe(2);
  });

  testInTempDirs(
    "a log reopened by a new server continues its sequence",
    () => {
      // Given a log a previous server appended to
      const filePath = path.join(tempDir("orchestrator-"), "transitions.jsonl");
      new TransitionLog(filePath).append(entry("CHECK"));

      // Given a new server opening the same log
      const reopened = new TransitionLog(filePath);

      // When it appends to it
      const appended = reopened.append(entry("WORK"));

      // Then it picks up where the last one left off, so no number repeats
      expect(reopened.cursor).toBe(2);
      expect(appended.seq).toBe(2);
    },
  );

  testInTempDirs(
    "a reader is given every transition in the order applied",
    () => {
      // Given a log with three transitions in it
      const log = new TransitionLog(
        path.join(tempDir("orchestrator-"), "transitions.jsonl"),
      );
      for (const to of ["WORK", "CHECK", "WORK_REVIEW"] as const) {
        log.append(entry(to));
      }

      // When the log is read back
      const entries = log.read();

      // Then every entry is there, numbered so a reader can find its own place
      expect(entries.map((one) => one.to)).toEqual([
        "WORK",
        "CHECK",
        "WORK_REVIEW",
      ]);
      expect(entries.map((one) => one.seq)).toEqual([1, 2, 3]);
    },
  );

  testInTempDirs("a log nothing has been written to reads as empty", () => {
    // Given a log file that does not exist yet
    const filePath = path.join(tempDir("orchestrator-"), "transitions.jsonl");

    // When the log is read
    const entries = new TransitionLog(filePath).read();

    // Then it reads as empty rather than failing the first tick
    expect(entries).toEqual([]);
  });

  testInTempDirs("the file is trimmed but the sequence keeps counting", () => {
    // Given a log that keeps only its last ten entries
    const filePath = path.join(tempDir("orchestrator-"), "transitions.jsonl");
    const log = new TransitionLog(filePath, 10);

    // When twenty-five transitions are appended
    for (let i = 0; i < 25; i++) log.append(entry("WORK"));

    // Then only the last ten are kept, still numbered from where they happened
    const kept = log.read();
    expect(kept).toHaveLength(10);
    expect(kept[0].seq).toBe(16);
    expect(kept[9].seq).toBe(25);

    // Then a server reopening the log carries on from the same number
    expect(log.cursor).toBe(25);
    expect(new TransitionLog(filePath, 10).cursor).toBe(25);
  });
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

  testInTempDirs("the first dispatch of a task has nothing behind it", () => {
    // Given a task that has never been dispatched
    const history = path.join(tempDir("orchestrator-"), "history");

    // When the attempt about to be made is counted
    const attempt = attemptOf(history);

    // Then it is the first
    expect(attempt).toBe(1);
  });

  testInTempDirs(
    "rotating never writes over what an agent wrote before",
    () => {
      // Given a task whose first attempt has already been rotated into history
      const dir = tempDir("orchestrator-");
      const live = path.join(dir, "ASSIGNMENT.md");
      const history = path.join(dir, "history");
      fs.writeFileSync(live, assignment("the first attempt"));
      expect(rotate(live, history)).toBe(path.join(history, historyName(1)));
      expect(fs.existsSync(live)).toBe(false);

      // Given a second attempt written to the live assignment
      fs.writeFileSync(live, assignment("the second attempt"));

      // When the live file is rotated into history
      rotate(live, history);

      // Then both attempts are kept, numbered in the order they were made
      expect(fs.readdirSync(history).sort()).toEqual([
        "ASSIGNMENT.1.md",
        "ASSIGNMENT.2.md",
      ]);
      expect(
        splitDocument(
          fs.readFileSync(path.join(history, "ASSIGNMENT.1.md"), "utf-8"),
        ).body,
      ).toContain("the first attempt");
      expect(attemptOf(history)).toBe(3);
    },
  );

  testInTempDirs("rotating when there is nothing to rotate is harmless", () => {
    // Given a task with no live assignment on disk
    const dir = tempDir("orchestrator-");

    // When the assignment is rotated
    const rotated = rotate(
      path.join(dir, "ASSIGNMENT.md"),
      path.join(dir, "history"),
    );

    // Then nothing is moved, and the dispatch carries on
    expect(rotated).toBeNull();
  });
});

describe("Feature: the workspace an agent works in", () => {
  testInTempDirs("a workspace borrows the repository's objects", () => {
    // Given a repository with a commit in it
    const repo = tempRepo();

    // Given a path the clone will land on
    const workspace = path.join(tempDir("clone-"), "worktree");

    // When a workspace is cloned from it
    git.createWorkspace(repo, "work/000001", workspace, "master");

    // Then it points at the repository's objects instead of copying them
    expect(
      fs
        .readFileSync(
          path.join(workspace, ".git", "objects", "info", "alternates"),
          "utf-8",
        )
        .trim(),
    ).toBe(path.join(repo, ".git", "objects"));
  });

  testInTempDirs(
    "a workspace inherits the repository's commit identity",
    () => {
      // Given a repository configured with an author
      const repo = tempRepo();

      // Given a path the clone will land on
      const workspace = path.join(tempDir("clone-"), "worktree");

      // When a workspace is cloned from it
      git.createWorkspace(repo, "work/000001", workspace, "master");

      // Then the agent's commits carry that author, which a plain clone would not
      expect(
        git.gitOrThrow(workspace, ["config", "--get", "user.email"]).trim(),
      ).toBe("orchestrator@example.com");
    },
  );

  testInTempDirs(
    "a workspace starts on its task branch, cut from the base",
    () => {
      // Given a repository with a base branch
      const repo = tempRepo();

      // Given a path the clone will land on
      const workspace = path.join(tempDir("clone-"), "worktree");

      // When a workspace is cloned for a task
      git.createWorkspace(repo, "work/000001", workspace, "master");

      // Then it is on the task's own branch, standing where the base does
      expect(
        git.gitOrThrow(workspace, ["rev-parse", "--abbrev-ref", "HEAD"]).trim(),
      ).toBe("work/000001");
      expect(git.gitOrThrow(workspace, ["rev-parse", "HEAD"])).toBe(
        git.gitOrThrow(repo, ["rev-parse", "master"]),
      );
    },
  );

  testInTempDirs(
    "a recloned workspace comes back to the work already done",
    () => {
      // Given a workspace whose commits were harvested before it was removed
      const repo = tempRepo();
      const first = path.join(tempDir("clone-"), "worktree");
      git.createWorkspace(repo, "work/000001", first, "master");
      commitIn(first, "b.txt", "work\n");
      git.harvest(repo, first, "work/000001");
      git.removeWorkspace(first);

      // Given a path the new clone will land on
      const second = path.join(tempDir("clone-"), "worktree");

      // When it is cloned again for the same task
      git.createWorkspace(repo, "work/000001", second, "master");

      // Then it checks out the branch that survived, not the base it was cut from
      expect(
        git.gitOrThrow(second, ["rev-parse", "--abbrev-ref", "HEAD"]).trim(),
      ).toBe("work/000001");
      expect(fs.existsSync(path.join(second, "b.txt"))).toBe(true);
    },
  );

  testInTempDirs(
    "harvesting lands the branch where the manager can see it",
    () => {
      // Given a workspace with a commit the repository has never seen
      const repo = tempRepo();
      const workspace = path.join(tempDir("clone-"), "worktree");
      git.createWorkspace(repo, "work/000001", workspace, "master");
      commitIn(workspace, "b.txt", "work\n");
      expect(git.branchExists(repo, "work/000001")).toBe(false);

      // When the workspace is harvested
      git.harvest(repo, workspace, "work/000001");

      // Then the branch is in the repository, and the base is untouched
      expect(git.branchExists(repo, "work/000001")).toBe(true);
      expect(git.gitOrThrow(repo, ["rev-parse", "work/000001"])).toBe(
        git.gitOrThrow(workspace, ["rev-parse", "HEAD"]),
      );
      expect(git.gitOrThrow(repo, ["rev-parse", "master"])).not.toBe(
        git.gitOrThrow(repo, ["rev-parse", "work/000001"]),
      );
    },
  );

  testInTempDirs(
    "harvesting a linked worktree does nothing rather than fail",
    () => {
      // Given a linked worktree, which already shares the repository's refs
      const repo = tempRepo();
      const workspace = path.join(tempDir("worktree-"), "worktree");
      git.gitOrThrow(repo, [
        "worktree",
        "add",
        "-q",
        "-b",
        "work/000001",
        workspace,
        "master",
      ]);
      commitIn(workspace, "b.txt", "work\n");
      expect(git.sharesRefs(repo, workspace)).toBe(true);

      // When the worktree is harvested
      git.harvest(repo, workspace, "work/000001");

      // Then the branch is already where it needs to be, and the fetch is skipped
      expect(git.gitOrThrow(repo, ["rev-parse", "work/000001"])).toBe(
        git.gitOrThrow(workspace, ["rev-parse", "HEAD"]),
      );
    },
  );

  testInTempDirs("a cloned workspace has refs of its own", () => {
    // Given a repository with a commit in it
    const repo = tempRepo();

    // Given a path the clone will land on
    const workspace = path.join(tempDir("clone-"), "worktree");

    // When a workspace is cloned from it
    git.createWorkspace(repo, "work/000001", workspace, "master");

    // Then it does not share the repository's refs, so harvesting is a real fetch
    expect(git.sharesRefs(repo, workspace)).toBe(false);
  });

  testInTempDirs(
    "harvesting after a rebase replaces the branch that was there",
    () => {
      // Given a harvested branch whose base has since moved on, and a rebase onto it
      const repo = tempRepo();
      const workspace = path.join(tempDir("clone-"), "worktree");
      git.createWorkspace(repo, "work/000001", workspace, "master");
      commitIn(workspace, "b.txt", "work\n");
      git.harvest(repo, workspace, "work/000001");
      commitIn(repo, "c.txt", "moved on\n");
      git.syncBase(workspace, "master");
      expect(git.rebase(workspace, "master").code).toBe(0);

      // When the workspace is harvested again
      git.harvest(repo, workspace, "work/000001");

      // Then the stale branch is replaced by the rebased one, ready to merge
      expect(git.gitOrThrow(repo, ["rev-parse", "work/000001"])).toBe(
        git.gitOrThrow(workspace, ["rev-parse", "HEAD"]),
      );
      expect(git.isAncestor(repo, "master", "work/000001")).toBe(true);
    },
  );

  testInTempDirs(
    "syncing brings the workspace's copy of the base forward",
    () => {
      // Given a workspace whose base has moved on in the repository
      const repo = tempRepo();
      const workspace = path.join(tempDir("clone-"), "worktree");
      git.createWorkspace(repo, "work/000001", workspace, "master");
      commitIn(repo, "c.txt", "moved on\n");
      expect(git.gitOrThrow(workspace, ["rev-parse", "master"])).not.toBe(
        git.gitOrThrow(repo, ["rev-parse", "master"]),
      );

      // When the base is synced into the workspace
      git.syncBase(workspace, "master");

      // Then the workspace can rebase onto what the base has actually become
      expect(git.gitOrThrow(workspace, ["rev-parse", "master"])).toBe(
        git.gitOrThrow(repo, ["rev-parse", "master"]),
      );
    },
  );

  testInTempDirs("a fresh workspace carries no commit and no change", () => {
    // Given a repository with a commit in it
    const repo = tempRepo();

    // Given a path the clone will land on
    const workspace = path.join(tempDir("clone-"), "worktree");

    // When a workspace is cloned from it
    git.createWorkspace(repo, "work/000001", workspace, "master");

    // Then the guard sees nothing committed and nothing changed
    expect(git.commitCount(workspace, "master")).toBe(0);
    expect(git.uncommitted(workspace)).toEqual([]);
  });

  testInTempDirs(
    "a commit in the workspace is counted against the base",
    () => {
      // Given a workspace with nothing committed in it
      const repo = tempRepo();
      const workspace = path.join(tempDir("clone-"), "worktree");
      git.createWorkspace(repo, "work/000001", workspace, "master");

      // When the agent commits in it
      commitIn(workspace, "b.txt", "work\n");

      // Then the guard sees the commit it made
      expect(git.commitCount(workspace, "master")).toBe(1);
    },
  );

  testInTempDirs(
    "an untracked or modified file counts as uncommitted work",
    () => {
      // Given a workspace with one file added and one changed
      const repo = tempRepo();
      const workspace = path.join(tempDir("clone-"), "worktree");
      git.createWorkspace(repo, "work/000001", workspace, "master");
      fs.writeFileSync(path.join(workspace, "b.txt"), "untracked\n");
      fs.writeFileSync(path.join(workspace, "a.txt"), "modified\n");

      // When the workspace is read for uncommitted work
      const dirty = git.uncommitted(workspace);

      // Then both are reported, so a submit without a commit can be caught
      expect(dirty).toEqual([" M a.txt", "?? b.txt"]);
    },
  );

  testInTempDirs("staged work is still uncommitted work", () => {
    // Given a workspace whose changes have been staged but not committed
    const repo = tempRepo();
    const workspace = path.join(tempDir("clone-"), "worktree");
    git.createWorkspace(repo, "work/000001", workspace, "master");
    fs.writeFileSync(path.join(workspace, "b.txt"), "untracked\n");
    fs.writeFileSync(path.join(workspace, "a.txt"), "modified\n");
    git.gitOrThrow(workspace, ["add", "-A"]);

    // When the workspace is read for uncommitted work
    const dirty = git.uncommitted(workspace);

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
    () => {
      // Given a workspace recloned from a branch that had already been harvested
      const repo = tempRepo();
      const first = path.join(tempDir("clone-"), "worktree");
      git.createWorkspace(repo, "work/000001", first, "master");
      commitIn(first, "b.txt", "work\n");
      git.harvest(repo, first, "work/000001");
      git.removeWorkspace(first);
      const second = path.join(tempDir("clone-"), "worktree");
      git.createWorkspace(repo, "work/000001", second, "master");

      // When its commits are counted against the base
      const count = git.commitCount(second, "master");

      // Then the count is right even though it has no local branch by that name
      expect(() => git.gitOrThrow(second, ["rev-parse", "master"])).toThrow();
      expect(count).toBe(1);
    },
  );

  testInTempDirs(
    "the commit count stays the agent's own as the base moves",
    () => {
      // Given a workspace with one commit, and a base that has moved on since
      const repo = tempRepo();
      const workspace = path.join(tempDir("clone-"), "worktree");
      git.createWorkspace(repo, "work/000001", workspace, "master");
      commitIn(workspace, "b.txt", "work\n");
      commitIn(repo, "c.txt", "moved on\n");
      git.syncBase(workspace, "master");

      // When its commits are counted against the base
      const count = git.commitCount(workspace, "master");

      // Then only the agent's own commit is counted, not the base's
      expect(count).toBe(1);
    },
  );

  testInTempDirs("removing a workspace leaves the repository untouched", () => {
    // Given a workspace cloned from a repository
    const repo = tempRepo();
    const workspace = path.join(tempDir("clone-"), "worktree");
    git.createWorkspace(repo, "work/000001", workspace, "master");

    // When the workspace is removed, and removed again
    git.removeWorkspace(workspace);

    // Then it is gone, the repository is clean, and removing it twice is harmless
    expect(fs.existsSync(workspace)).toBe(false);
    expect(git.gitOrThrow(repo, ["status", "--porcelain"])).toBe("");
    expect(() => git.removeWorkspace(workspace)).not.toThrow();
  });
});
