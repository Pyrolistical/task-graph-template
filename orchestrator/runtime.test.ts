import { afterAll, beforeAll, describe, expect, setSystemTime } from "bun:test";
import { TEST_ROOT, tempDir, test } from "./temp.ts";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { attemptOf, historyName, rotate } from "./assignment.ts";
import { TransitionLog } from "./transition-log.ts";
import { isProcessAlive, splitDocument } from "./task.ts";
import {
  Runtime,
  branchName,
  defaultTasksDir,
  graphKey,
  repoKey,
  writeAtomic,
} from "./runtime.ts";
import * as git from "./git.ts";
import { commitIn, tempRepo } from "./orchestrator-jig.ts";

beforeAll(() => {
  setSystemTime(new Date("2026-01-01").getTime());
});

afterAll(() => {
  setSystemTime();
});

describe("the runtime directory", () => {
  test("the repo key is its absolute path with slashes replaced", () => {
    expect(repoKey("/home/model/task-graph-template")).toBe(
      "-home-model-task-graph-template",
    );
  });

  test("two clones of one project never collide", () => {
    expect(repoKey("/a/project")).not.toBe(repoKey("/b/project"));
  });

  test("every path hangs off the task directory", () => {
    const root = tempDir("orchestrator-");
    const runtime = new Runtime("/home/model/task-graph-template", root);

    expect(runtime.root).toBe(
      path.join(root, "-home-model-task-graph-template"),
    );
    expect(runtime.assignment("000042")).toBe(
      path.join(runtime.root, "000042", "ASSIGNMENT.md"),
    );
    expect(runtime.worktree("000042")).toBe(
      path.join(runtime.root, "000042", "worktree"),
    );
    expect(runtime.sessionDir("000042", "reviewer")).toBe(
      path.join(runtime.root, "000042", "session", "reviewer"),
    );
    expect(runtime.checkLog("000042", 1)).toBe(
      path.join(runtime.root, "000042", "check-1.log"),
    );
  });

  test("the assignment sits beside the worktree, never inside it", () => {
    const runtime = new Runtime(
      "/home/model/project",
      tempDir("orchestrator-"),
    );
    expect(
      runtime.assignment("000042").startsWith(runtime.worktree("000042")),
    ).toBe(false);
    expect(path.dirname(runtime.assignment("000042"))).toBe(
      path.dirname(runtime.worktree("000042")),
    );
  });

  test("prepare creates the history and both session directories", () => {
    const runtime = new Runtime(
      "/home/model/project",
      tempDir("orchestrator-"),
    );
    runtime.prepare("000042");

    expect(fs.existsSync(runtime.history("000042"))).toBe(true);
    expect(fs.existsSync(runtime.sessionDir("000042", "worker"))).toBe(true);
    expect(fs.existsSync(runtime.sessionDir("000042", "reviewer"))).toBe(true);
  });

  test("an atomic write never leaves a partial document", () => {
    const dir = tempDir("orchestrator-");
    const target = path.join(dir, "agents.json");

    writeAtomic(target, '{"agents":[]}');
    writeAtomic(target, '{"agents":[1]}');

    expect(fs.readFileSync(target, "utf-8")).toBe('{"agents":[1]}');
    expect(fs.readdirSync(dir)).toEqual(["agents.json"]);
  });

  test("the branch is named for the work, not for the graph", () => {
    expect(branchName("000042")).toBe("task/000042");
  });
});

describe("the task graph directory", () => {
  test("graphKey is relative under home and absolute outside it", () => {
    const home = "/home/model";
    expect(graphKey("/home/model/project", home)).toBe("project");
    expect(graphKey("/home/model/a/b", home)).toBe("a-b");
    expect(graphKey("/home/model", home)).toBe("-home-model");
    expect(graphKey("/tmp/other", home)).toBe("-tmp-other");
  });

  test("the tests never resolve the task graph into the real home", () => {
    expect(defaultTasksDir("/tmp/whatever")).toBe(
      path.join(TEST_ROOT, "task-graph-root", "-tmp-whatever"),
    );
    expect(defaultTasksDir("/tmp/whatever")).not.toContain(
      path.join(os.homedir(), "task-graph"),
    );
  });

  test("defaultTasksDir joins the root with the key", () => {
    const previous = process.env.TASK_GRAPH_TASKS_ROOT;
    process.env.TASK_GRAPH_TASKS_ROOT = "/tmp/tg";
    try {
      expect(defaultTasksDir("/home/model/project")).toBe("/tmp/tg/project");
    } finally {
      if (previous === undefined) {
        delete process.env.TASK_GRAPH_TASKS_ROOT;
      } else {
        process.env.TASK_GRAPH_TASKS_ROOT = previous;
      }
    }
  });
});

describe("the server log", () => {
  test("it is trimmed to the most recent bytes, at a line boundary", () => {
    const runtime = new Runtime(
      "/home/model/project",
      tempDir("orchestrator-"),
    );

    for (let i = 0; i < 200; i++) {
      runtime.log(`line ${i}`, 400);
    }

    const contents = fs.readFileSync(runtime.serverLog, "utf-8");
    expect(contents.length).toBeLessThanOrEqual(400);
    expect(contents.startsWith("2")).toBe(true);
    expect(contents.endsWith("line 199\n")).toBe(true);
    expect(contents.split("\n").filter((l) => l.length > 0).length).toBe(
      contents.split("\n").filter((l) => /^\d{4}-/.test(l)).length,
    );
  });
});

describe("discarding a closed task", () => {
  test("the whole task directory goes, so nothing of it outlives the view", () => {
    const runtime = new Runtime(
      "/home/model/project",
      tempDir("orchestrator-"),
    );
    runtime.prepare("000042");
    fs.writeFileSync(runtime.assignment("000042"), "gone soon");

    runtime.discard("000042");
    expect(fs.existsSync(runtime.taskDir("000042"))).toBe(false);
  });

  test("discarding a task that was never started is not an error", () => {
    const runtime = new Runtime(
      "/home/model/project",
      tempDir("orchestrator-"),
    );
    expect(() => runtime.discard("000042")).not.toThrow();
  });
});

describe("process liveness", () => {
  test("a live process is alive and a never-existent pid is not", () => {
    expect(isProcessAlive(process.pid)).toBe(true);
    expect(isProcessAlive(2 ** 22)).toBe(false);
  });

  test("a child that exited but has not been waited on is dead, not alive", async () => {
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

    expect(isProcessAlive(proc.pid)).toBe(false);
  });
});

describe("the transition log", () => {
  test("seq advances by one per applied transition", () => {
    const log = new TransitionLog(
      path.join(tempDir("orchestrator-"), "transitions.jsonl"),
    );

    const first = log.append({
      task_id: "000042",
      transition: "pass",
      from: "CHECK",
      to: "WORK_REVIEW",
      by: "pi-1",
    });
    const second = log.append({
      task_id: "000042",
      transition: "submit",
      from: "WORK",
      to: "CHECK",
      by: "pi-1",
    });

    expect(first.seq).toBe(1);
    expect(second.seq).toBe(2);
    expect(log.cursor).toBe(2);
  });

  test("a reopened log continues the sequence", () => {
    const filePath = path.join(tempDir("orchestrator-"), "transitions.jsonl");
    new TransitionLog(filePath).append({
      task_id: "000042",
      transition: "pass",
      from: "CHECK",
      to: "WORK_REVIEW",
      by: "pi-1",
    });

    expect(new TransitionLog(filePath).cursor).toBe(1);
    expect(
      new TransitionLog(filePath).append({
        task_id: "000042",
        transition: "fail",
        from: "CHECK",
        to: "WORK",
        by: "pi-1",
      }).seq,
    ).toBe(2);
  });

  test("since gives the manager a delta from its cursor", () => {
    const log = new TransitionLog(
      path.join(tempDir("orchestrator-"), "transitions.jsonl"),
    );
    for (const to of ["WORK", "CHECK", "WORK_REVIEW"] as const) {
      log.append({
        task_id: "000042",
        transition: "t",
        from: "WORK",
        to,
        by: "pi-1",
      });
    }

    expect(log.since(1).map((e) => e.to)).toEqual(["CHECK", "WORK_REVIEW"]);
    expect(log.since(3)).toEqual([]);
  });

  test("a fresh log reads as empty rather than failing", () => {
    expect(
      new TransitionLog(
        path.join(tempDir("orchestrator-"), "transitions.jsonl"),
      ).read(),
    ).toEqual([]);
  });

  test("the file keeps the last lines and the sequence keeps counting", () => {
    const filePath = path.join(tempDir("orchestrator-"), "transitions.jsonl");
    const log = new TransitionLog(filePath, 10);

    for (let i = 0; i < 25; i++) {
      log.append({
        task_id: "000042",
        transition: "t",
        from: "WORK",
        to: "WORK",
        by: "pi-1",
      });
    }

    const kept = log.read();
    expect(kept).toHaveLength(10);
    expect(kept[0]!.seq).toBe(16);
    expect(kept[9]!.seq).toBe(25);
    expect(log.cursor).toBe(25);
    expect(new TransitionLog(filePath, 10).cursor).toBe(25);
  });
});

describe("rotation", () => {
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

  test("the first dispatch has nothing behind it", () => {
    expect(attemptOf(path.join(tempDir("orchestrator-"), "history"))).toBe(1);
  });

  test("rotating never overwrites what an agent wrote", () => {
    const dir = tempDir("orchestrator-");
    const live = path.join(dir, "ASSIGNMENT.md");
    const history = path.join(dir, "history");

    fs.writeFileSync(live, assignment("the first attempt"));
    expect(rotate(live, history)).toBe(path.join(history, historyName(1)));
    expect(fs.existsSync(live)).toBe(false);

    fs.writeFileSync(live, assignment("the second attempt"));
    rotate(live, history);

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
  });

  test("rotating when there is nothing to rotate is not an error", () => {
    const dir = tempDir("orchestrator-");
    expect(
      rotate(path.join(dir, "ASSIGNMENT.md"), path.join(dir, "history")),
    ).toBeNull();
  });
});

describe("a workspace clone", () => {
  test("it borrows the repo's objects instead of copying them", () => {
    const repo = tempRepo();
    const workspace = path.join(tempDir("clone-"), "worktree");
    git.addWorkspace(repo, "work/000001", workspace, "master");

    expect(
      fs
        .readFileSync(
          path.join(workspace, ".git", "objects", "info", "alternates"),
          "utf-8",
        )
        .trim(),
    ).toBe(path.join(repo, ".git", "objects"));
  });

  test("it inherits the repo's commit identity, which a clone does not copy", () => {
    const repo = tempRepo();
    const workspace = path.join(tempDir("clone-"), "worktree");
    git.addWorkspace(repo, "work/000001", workspace, "master");

    expect(
      git.gitOrThrow(workspace, ["config", "--get", "user.email"]).trim(),
    ).toBe("orchestrator@example.com");
  });

  test("it starts on the task branch, cut from the base", () => {
    const repo = tempRepo();
    const workspace = path.join(tempDir("clone-"), "worktree");
    git.addWorkspace(repo, "work/000001", workspace, "master");

    expect(
      git.gitOrThrow(workspace, ["rev-parse", "--abbrev-ref", "HEAD"]).trim(),
    ).toBe("work/000001");
    expect(git.gitOrThrow(workspace, ["rev-parse", "HEAD"])).toBe(
      git.gitOrThrow(repo, ["rev-parse", "master"]),
    );
  });

  test("a recovered workspace checks out the branch that survived, not the base", () => {
    const repo = tempRepo();
    const first = path.join(tempDir("clone-"), "worktree");
    git.addWorkspace(repo, "work/000001", first, "master");
    commitIn(first, "b.txt", "work\n");
    git.harvest(repo, first, "work/000001");
    git.removeWorkspace(first);

    const second = path.join(tempDir("clone-"), "worktree");
    git.addWorkspace(repo, "work/000001", second, "master");

    expect(
      git.gitOrThrow(second, ["rev-parse", "--abbrev-ref", "HEAD"]).trim(),
    ).toBe("work/000001");
    expect(fs.existsSync(path.join(second, "b.txt"))).toBe(true);
  });

  test("harvesting lands the branch in the repo, where the manager can see it", () => {
    const repo = tempRepo();
    const workspace = path.join(tempDir("clone-"), "worktree");
    git.addWorkspace(repo, "work/000001", workspace, "master");
    commitIn(workspace, "b.txt", "work\n");

    expect(git.branchExists(repo, "work/000001")).toBe(false);
    git.harvest(repo, workspace, "work/000001");

    expect(git.branchExists(repo, "work/000001")).toBe(true);
    expect(git.gitOrThrow(repo, ["rev-parse", "work/000001"])).toBe(
      git.gitOrThrow(workspace, ["rev-parse", "HEAD"]),
    );
    expect(git.gitOrThrow(repo, ["rev-parse", "master"])).not.toBe(
      git.gitOrThrow(repo, ["rev-parse", "work/000001"]),
    );
  });

  test("harvesting a linked worktree is a no-op, not a refused fetch", () => {
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
    git.harvest(repo, workspace, "work/000001");

    expect(git.gitOrThrow(repo, ["rev-parse", "work/000001"])).toBe(
      git.gitOrThrow(workspace, ["rev-parse", "HEAD"]),
    );
  });

  test("a shared clone does not share the repo's refs", () => {
    const repo = tempRepo();
    const workspace = path.join(tempDir("clone-"), "worktree");
    git.addWorkspace(repo, "work/000001", workspace, "master");

    expect(git.sharesRefs(repo, workspace)).toBe(false);
  });

  test("harvesting again after a rebase replaces the stale branch", () => {
    const repo = tempRepo();
    const workspace = path.join(tempDir("clone-"), "worktree");
    git.addWorkspace(repo, "work/000001", workspace, "master");
    commitIn(workspace, "b.txt", "work\n");
    git.harvest(repo, workspace, "work/000001");

    commitIn(repo, "c.txt", "moved on\n");
    git.syncBase(workspace, "master");
    expect(git.rebase(workspace, "master").code).toBe(0);
    git.harvest(repo, workspace, "work/000001");

    expect(git.gitOrThrow(repo, ["rev-parse", "work/000001"])).toBe(
      git.gitOrThrow(workspace, ["rev-parse", "HEAD"]),
    );
    expect(git.isAncestor(repo, "master", "work/000001")).toBe(true);
  });

  test("syncing the base brings the workspace's base ref forward", () => {
    const repo = tempRepo();
    const workspace = path.join(tempDir("clone-"), "worktree");
    git.addWorkspace(repo, "work/000001", workspace, "master");
    commitIn(repo, "c.txt", "moved on\n");

    expect(git.gitOrThrow(workspace, ["rev-parse", "master"])).not.toBe(
      git.gitOrThrow(repo, ["rev-parse", "master"]),
    );
    git.syncBase(workspace, "master");
    expect(git.gitOrThrow(workspace, ["rev-parse", "master"])).toBe(
      git.gitOrThrow(repo, ["rev-parse", "master"]),
    );
  });

  test("a fresh workspace carries no commit of its own and a clean tree", () => {
    const repo = tempRepo();
    const workspace = path.join(tempDir("clone-"), "worktree");
    git.addWorkspace(repo, "work/000001", workspace, "master");

    expect(git.commitCount(workspace, "master")).toBe(0);
    expect(git.uncommitted(workspace)).toEqual([]);

    commitIn(workspace, "b.txt", "work\n");
    expect(git.commitCount(workspace, "master")).toBe(1);
  });

  test("an untracked or modified file is uncommitted work", () => {
    const repo = tempRepo();
    const workspace = path.join(tempDir("clone-"), "worktree");
    git.addWorkspace(repo, "work/000001", workspace, "master");

    fs.writeFileSync(path.join(workspace, "b.txt"), "untracked\n");
    fs.writeFileSync(path.join(workspace, "a.txt"), "modified\n");

    expect(git.uncommitted(workspace)).toEqual([" M a.txt", "?? b.txt"]);

    git.gitOrThrow(workspace, ["add", "-A"]);
    expect(git.uncommitted(workspace)).toEqual(["M  a.txt", "A  b.txt"]);
  });

  test("a long git status is cut down to something a prompt can carry", () => {
    const dirty = Array.from({ length: 25 }, (_, at) => `?? file${at}.txt`);

    expect(git.statusOf(dirty.slice(0, 3))).toBe(
      "?? file0.txt\n?? file1.txt\n?? file2.txt",
    );

    const cut = git.statusOf(dirty).split("\n");
    expect(cut).toHaveLength(git.STATUS_SHOWN_LINES + 1);
    expect(cut[git.STATUS_SHOWN_LINES]).toBe("… and 5 more");
  });

  test("the base is read as a remote ref, which a recloned workspace still has", () => {
    const repo = tempRepo();
    const first = path.join(tempDir("clone-"), "worktree");
    git.addWorkspace(repo, "work/000001", first, "master");
    commitIn(first, "b.txt", "work\n");
    git.harvest(repo, first, "work/000001");
    git.removeWorkspace(first);

    const second = path.join(tempDir("clone-"), "worktree");
    git.addWorkspace(repo, "work/000001", second, "master");

    expect(() => git.gitOrThrow(second, ["rev-parse", "master"])).toThrow();
    expect(git.commitCount(second, "master")).toBe(1);
  });

  test("the commit count is the agent's own, even after the base moves on", () => {
    const repo = tempRepo();
    const workspace = path.join(tempDir("clone-"), "worktree");
    git.addWorkspace(repo, "work/000001", workspace, "master");
    commitIn(workspace, "b.txt", "work\n");
    commitIn(repo, "c.txt", "moved on\n");
    git.syncBase(workspace, "master");

    expect(git.commitCount(workspace, "master")).toBe(1);
  });

  test("removing a workspace leaves the repo alone", () => {
    const repo = tempRepo();
    const workspace = path.join(tempDir("clone-"), "worktree");
    git.addWorkspace(repo, "work/000001", workspace, "master");
    git.removeWorkspace(workspace);

    expect(fs.existsSync(workspace)).toBe(false);
    expect(git.gitOrThrow(repo, ["status", "--porcelain"])).toBe("");
    expect(() => git.removeWorkspace(workspace)).not.toThrow();
  });
});
