import { describe, expect } from "bun:test";
import { test } from "./temp.ts";
import fs from "node:fs";
import path from "node:path";
import { createTask, parseTaskMeta, readTaskFile } from "./task.ts";
import {
  TRANSITION_NAMES,
  type TransitionArgs,
  type TransitionName,
  type TransitionResult,
  applyTransition,
} from "./transition.ts";
import {
  ORCHESTRATOR_DIR,
  addDeps,
  baseMeta,
  bodyOf,
  claim,
  closeTask,
  deadPid,
  editTask,
  makeTasksDir,
  metaOf,
  newTask,
  newTasks,
  planThrough,
  raw,
  run,
  shape,
  toAgentReview,
  toChecking,
  toDesign,
  toManagerReview,
  toPlan,
  toWorking,
  unclaim,
  writeTask,
} from "./graph-jig.ts";

describe("transitions: dependencies", () => {
  test("submit moves NEW to DESIGN when nothing was edited in", () => {
    const { dir, id } = newTask();
    expect(run(dir, id, "submit").to).toBe("DESIGN");
  });

  test("submit moves NEW to BLOCKED when dependencies were edited in", () => {
    const { dir, ids } = newTasks(2);
    const [main, dep] = ids as [string, string];

    addDeps(dir, main, dep);
    expect(run(dir, main, "submit").to).toBe("BLOCKED");
    expect(metaOf(dir, main).depends_on).toEqual([dep]);
  });

  test("submit from NEW never reaches DESIGN while dependencies remain", () => {
    const { dir, ids } = newTasks(2);
    const [main, dep] = ids as [string, string];

    addDeps(dir, main, dep);
    expect(run(dir, main, "submit").to).toBe("BLOCKED");
    expect(metaOf(dir, main).state).toBe("BLOCKED");
  });

  test("submit self-loops on BLOCKED while dependencies remain", () => {
    const { dir, ids } = newTasks(2);
    const [main, dep] = ids as [string, string];

    addDeps(dir, main, dep);
    run(dir, main, "submit");
    expect(run(dir, main, "submit").to).toBeNull();
    expect(metaOf(dir, main).state).toBe("BLOCKED");
  });

  test("submit from BLOCKED reaches DESIGN once the last dependency is edited out", () => {
    const { dir, ids } = newTasks(3);
    const [main, first, second] = ids as [string, string, string];

    addDeps(dir, main, first, second);
    run(dir, main, "submit");

    editTask(dir, main, (meta) => {
      meta.depends_on = [first];
    });
    expect(run(dir, main, "submit").to).toBeNull();

    editTask(dir, main, (meta) => {
      meta.depends_on = [];
    });
    expect(run(dir, main, "submit").to).toBe("DESIGN");
  });

  test("submit can clear a reference to a task that is gone", () => {
    const dir = makeTasksDir();
    const main = writeTask(dir, {
      id: "000001",
      state: "BLOCKED",
      depends_on: ["000999"],
    });

    editTask(dir, main, (meta) => {
      meta.depends_on = [];
    });
    expect(run(dir, main, "submit").to).toBe("DESIGN");
    expect(metaOf(dir, main).depends_on).toEqual([]);
  });
});

describe("the claim", () => {
  test("taking the claim records the agent and pid without moving the task", () => {
    const { dir, id } = planThrough();
    expect(metaOf(dir, id).state).toBe("WORK");
    claim(dir, id, "agent-1", 4242);

    const meta = metaOf(dir, id);
    expect(meta.state).toBe("WORK");
    expect(meta.claimed_by).toBe("agent-1");
    expect(meta.claimed_pid).toBe(4242);
  });

  test("a claimed task cannot be claimed again", () => {
    const { dir, id } = toWorking();
    expect(() => claim(dir, id, "agent-2")).toThrow(
      /already claimed by "agent-1"/,
    );
    expect(metaOf(dir, id).claimed_by).toBe("agent-1");
  });

  test("a claim is not cleared while its process is alive", () => {
    const { dir, id } = toWorking();
    expect(() => unclaim(dir, id)).toThrow(/still claimed by a live process/);
  });

  test("a dead claim is cleared and the task stays where it stands", async () => {
    const { dir, id } = newTask();
    run(dir, id, "submit");
    claim(dir, id, "dead-agent", await deadPid());

    unclaim(dir, id);

    const meta = metaOf(dir, id);
    expect(meta.state).toBe("DESIGN");
    expect(meta.claimed_by).toBeNull();
    expect(meta.claimed_pid).toBeNull();
  });

  test("a state nobody claims has nothing to clear", () => {
    const { dir, id } = toChecking();
    expect(metaOf(dir, id).claimed_by).toBeNull();
    expect(() => unclaim(dir, id)).toThrow(/with no claim to clear/);
  });

  test("a claim is refused in a state no agent runs", () => {
    const { dir, id } = toChecking();
    expect(() => claim(dir, id, "agent-1")).toThrow(/which no agent runs/);
    expect(metaOf(dir, id).claimed_by).toBeNull();
  });

  test("a claim rejects a blank agent name and a non-positive pid", () => {
    const { dir, id } = newTask();
    run(dir, id, "submit");

    expect(() => claim(dir, id, "  ")).toThrow(
      /"agentName" must be a non-empty string/,
    );
    expect(() => claim(dir, id, "a", 0)).toThrow(
      /"pid" must be a positive integer/,
    );
    expect(() => claim(dir, id, "a", 1.5)).toThrow(
      /"pid" must be a positive integer/,
    );

    const meta = metaOf(dir, id);
    expect(meta.state).toBe("DESIGN");
    expect(meta.claimed_by).toBeNull();
    expect(meta.claimed_pid).toBeNull();
  });
});

describe("transitions: the task body", () => {
  test("feedback from WORK_REVIEW sends the task back and appends the findings to the body", () => {
    const { dir, id } = toAgentReview();
    expect(run(dir, id, "feedback", "fix null handling").to).toBe("WORK");

    const body = bodyOf(path.join(dir, `${id}.md`));
    expect(body).toContain("# Review findings");
    expect(body).toContain("- fix null handling");
  });

  test("every finding in a feedback from WORK_REVIEW lands in the body", () => {
    const { dir, id } = toAgentReview();
    run(dir, id, "feedback", "first", "second");
    const body = bodyOf(path.join(dir, `${id}.md`));
    expect(body).toContain("- first");
    expect(body).toContain("- second");
  });

  test("feedback from MANAGER_REVIEW appends the same findings", () => {
    const { dir, id } = toManagerReview();
    expect(run(dir, id, "feedback", "restructure the parser").to).toBe("WORK");
    const body = bodyOf(path.join(dir, `${id}.md`));
    expect(body).toContain("# Review findings");
    expect(body).toContain("- restructure the parser");
  });

  test("a second rejection appends another review findings section", () => {
    const { dir, id } = toAgentReview();
    run(dir, id, "feedback", "first");
    claim(dir, id, "agent-1");
    run(dir, id, "submit", bodyOf(path.join(dir, `${id}.md`)));
    run(dir, id, "pass");
    claim(dir, id, "reviewer");
    run(dir, id, "feedback", "second");
    const body = bodyOf(path.join(dir, `${id}.md`));
    expect(body.match(/# Review findings/g)).toHaveLength(2);
    expect(body).toContain("- second");
  });

  test("feedback from PLAN_REVIEW leaves the body untouched", () => {
    const { dir, id } = toPlan();
    claim(dir, id, "planner");
    run(dir, id, "submit");
    claim(dir, id, "plan-reviewer");
    const before = bodyOf(path.join(dir, `${id}.md`));
    expect(run(dir, id, "feedback", "the list is missing").to).toBe("PLAN");
    expect(bodyOf(path.join(dir, `${id}.md`))).toBe(before);
  });

  test("feedback refuses an empty findings list and writes nothing", () => {
    const { dir, id } = toAgentReview();
    const before = fs.readFileSync(path.join(dir, `${id}.md`), "utf-8");
    expect(() =>
      applyTransition(dir, id, "feedback", { findings: [] }),
    ).toThrow(/non-empty/);
    expect(fs.readFileSync(path.join(dir, `${id}.md`), "utf-8")).toBe(before);
  });

  test("submit from PLAN_REVIEW writes the accepted assignment into the body", () => {
    const { dir, id } = toPlan();
    claim(dir, id, "planner");
    run(dir, id, "submit");
    claim(dir, id, "plan-reviewer");
    run(dir, id, "submit", "\n# accepted plan");
    expect(bodyOf(path.join(dir, `${id}.md`))).toBe("\n# accepted plan");
  });

  test("submit from WORK writes the notes into the body", () => {
    const { dir, id } = toWorking();
    const accepted =
      "\n# Goal\n\n## Todos\n\n1. x\n\n## Implementation Notes\n\nI did x";
    expect(run(dir, id, "submit", accepted).to).toBe("CHECK");
    expect(bodyOf(path.join(dir, `${id}.md`))).toBe(accepted);
  });

  test("submit from WORK, PLAN_REVIEW or DESIGN_REVIEW requires the accepted assignment", () => {
    const { dir, id } = toWorking();
    expect(() => applyTransition(dir, id, "submit", {})).toThrow(/body/);

    const plan = toPlan();
    claim(plan.dir, plan.id, "p");
    run(plan.dir, plan.id, "submit");
    claim(plan.dir, plan.id, "pr");
    expect(() => applyTransition(plan.dir, plan.id, "submit", {})).toThrow(
      /body/,
    );

    const design = toDesign();
    claim(design.dir, design.id, "d");
    run(design.dir, design.id, "submit");
    claim(design.dir, design.id, "dr");
    expect(() => applyTransition(design.dir, design.id, "submit", {})).toThrow(
      /body/,
    );
  });

  test("the review findings survive to close, in the body", () => {
    const { dir, id } = toAgentReview();
    run(dir, id, "feedback", "keep me");
    claim(dir, id, "agent-1");
    const current = bodyOf(path.join(dir, `${id}.md`));
    run(
      dir,
      id,
      "submit",
      current + "\n\n## Implementation Notes\n\nI fixed it",
    );
    run(dir, id, "pass");
    claim(dir, id, "reviewer");
    run(dir, id, "submit");
    const { closedPath } = run(dir, id, "submit");

    expect(bodyOf(closedPath!)).toContain("- keep me");
  });
});

describe("transitions: checks", () => {
  test("checks edited into the document survive into DESIGN", () => {
    const { dir, id } = newTask();
    editTask(dir, id, (meta) => {
      meta.checks = ["bun test"];
    });
    expect(run(dir, id, "submit").to).toBe("DESIGN");
    expect(metaOf(dir, id).checks).toEqual(["bun test"]);
  });

  test("a check is a command and nothing else, so nothing records a stale pass", () => {
    const { dir, id } = toChecking();
    editTask(dir, id, (meta) => {
      meta.checks.push("bun test");
    });
    expect(run(dir, id, "pass").to).toBe("WORK_REVIEW");
    expect(metaOf(dir, id).checks).toEqual(["bun test"]);
  });
});

describe("transitions: check failures", () => {
  test("fail from CHECK sends the task back to WORK", () => {
    const { dir, id } = toChecking();
    expect(run(dir, id, "fail").to).toBe("WORK");
  });

  test("fail records nothing in the graph", () => {
    const { dir, id } = toChecking();
    const before = metaOf(dir, id);
    run(dir, id, "fail");
    const after = metaOf(dir, id);
    expect(after.state).toBe("WORK");
    expect(after.depends_on).toEqual(before.depends_on);
    expect(after.checks).toEqual(before.checks);
    expect(after.workspace).toEqual(before.workspace);
    expect(after.held_reason).toBeNull();
  });

  test("fail is only for the checks; a review cannot fail its own task", () => {
    const { dir, id } = toAgentReview();
    expect(() => run(dir, id, "fail")).toThrow(/not valid from state/);
  });
});

describe("transitions: closing", () => {
  test("submit from MANAGER_REVIEW closes the task and moves the file", () => {
    const { dir, id } = toManagerReview();
    const result = run(dir, id, "submit");

    expect(result.to).toBe("CLOSED");
    expect(fs.existsSync(path.join(dir, `${id}.md`))).toBe(false);
    expect(fs.existsSync(path.join(dir, "closed", `${id}.md`))).toBe(true);
    expect(readTaskFile(result.closedPath!).meta.state).toBe("CLOSED");
  });

  test("abort closes a task from MANAGER_REVIEW", () => {
    const { dir, id } = toManagerReview();
    expect(run(dir, id, "abort").to).toBe("CLOSED");
  });

  test("abort throws away a task still queued in DESIGN, via HELD_DESIGN", () => {
    const { dir, id } = newTask("the wrong shape");
    run(dir, id, "submit");
    expect(metaOf(dir, id).state).toBe("DESIGN");
    expect(() => run(dir, id, "abort")).toThrow(
      /not valid from state "DESIGN"/,
    );

    run(dir, id, "hold", "abandoning");
    expect(metaOf(dir, id).state).toBe("HELD_DESIGN");
    expect(run(dir, id, "abort").to).toBe("CLOSED");
  });

  test("abort closes a held task when nothing should replace it", () => {
    const { dir, id } = newTask("the wrong shape");
    run(dir, id, "submit");
    run(dir, id, "hold", "abandoning");
    expect(run(dir, id, "abort").to).toBe("CLOSED");
  });

  test("a task sent back by a failed check can be aborted from HELD_WORK", () => {
    const { dir, id } = toChecking();
    run(dir, id, "fail");
    expect(metaOf(dir, id).state).toBe("WORK");

    run(dir, id, "hold", "abandoning");
    expect(run(dir, id, "abort").to).toBe("CLOSED");
  });

  test("closing removes the id from dependents and unblocks them", () => {
    const dir = makeTasksDir();
    const dep = createTask(dir, ORCHESTRATOR_DIR, "dependency").id;
    const main = createTask(dir, ORCHESTRATOR_DIR, "main").id;

    addDeps(dir, main, dep);
    expect(run(dir, main, "submit").to).toBe("BLOCKED");

    const result = closeTask(dir, dep);

    expect(result.dependentsUpdated).toEqual([main]);
    expect(result.unblocked).toEqual([main]);
    expect(metaOf(dir, main).depends_on).toEqual([]);
    expect(metaOf(dir, main).state).toBe("DESIGN");
  });

  test("a dependent with other dependencies stays BLOCKED", () => {
    const dir = makeTasksDir();
    const dep = createTask(dir, ORCHESTRATOR_DIR, "dependency").id;
    const other = createTask(dir, ORCHESTRATOR_DIR, "other dependency").id;
    const main = createTask(dir, ORCHESTRATOR_DIR, "main").id;

    addDeps(dir, main, dep, other);
    run(dir, main, "submit");
    const result = closeTask(dir, dep);

    expect(result.unblocked).toEqual([]);
    expect(metaOf(dir, main).state).toBe("BLOCKED");
    expect(metaOf(dir, main).depends_on).toEqual([other]);
  });

  test("a closed task has no further transitions", () => {
    const { dir, id } = toManagerReview();
    run(dir, id, "submit");

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

  test("hold rejects a blank reason", () => {
    const { dir, id } = toWorking();
    expect(() => apply(dir, id, "hold", { reason: "  " })).toThrow(
      /"reason" must be a non-empty string/,
    );
    expect(metaOf(dir, id).state).toBe("WORK");
  });

  test("every rejected argument leaves the document byte-identical", () => {
    const { dir, id } = toWorking();
    const filePath = path.join(dir, `${id}.md`);
    const before = fs.readFileSync(filePath, "utf-8");

    const rejected: [TransitionName, unknown][] = [
      ["feedback", { findings: [] }],
      ["hold", {}],
      ["submit", {}],
    ];
    for (const [name, args] of rejected) {
      expect(() => apply(dir, id, name, args)).toThrow();
    }

    expect(fs.readFileSync(filePath, "utf-8")).toBe(before);
  });
});

describe("transitions: document integrity", () => {
  test("the body changes only at the accepts and feedback appends", () => {
    const { dir, id } = newTask();
    const filePath = path.join(dir, `${id}.md`);
    const original = bodyOf(filePath);

    const steps: [string | null, TransitionName, string[], string][] = [
      [null, "submit", [], original],
      ["designer", "submit", [], original],
      ["design-reviewer", "submit", ["\n# accepted"], "\n# accepted"],
      ["planner", "submit", [], "\n# accepted"],
      ["plan-reviewer", "submit", ["\n# accepted"], "\n# accepted"],
      ["agent-1", "submit", ["\n# accepted"], "\n# accepted"],
      [null, "pass", [], "\n# accepted"],
      ["reviewer", "submit", [], "\n# accepted"],
    ];

    for (const [agent, name, args, expected] of steps) {
      const held = bodyOf(filePath);
      if (agent !== null) {
        claim(dir, id, agent);
        expect(bodyOf(filePath)).toBe(held);
      }
      run(dir, id, name, ...args);
      expect(bodyOf(filePath)).toBe(expected);
    }

    const closed = run(dir, id, "submit");
    expect(bodyOf(closed.closedPath!)).toBe("\n# accepted");
  });

  test("state_entered advances on self-loops as well as real transitions", async () => {
    const { dir, ids } = newTasks(2);
    const [main, dep] = ids as [string, string];
    addDeps(dir, main, dep);
    run(dir, main, "submit");

    const beforeSelfLoop = metaOf(dir, main).state_entered;
    await Bun.sleep(5);
    expect(run(dir, main, "submit").to).toBeNull();

    const afterSelfLoop = metaOf(dir, main).state_entered;
    expect(Date.parse(afterSelfLoop!)).toBeGreaterThan(
      Date.parse(beforeSelfLoop!),
    );

    const beforeMove = metaOf(dir, main).state_entered;
    await Bun.sleep(5);
    editTask(dir, main, (meta) => {
      meta.depends_on = [];
    });
    expect(run(dir, main, "submit").to).toBe("DESIGN");

    expect(Date.parse(metaOf(dir, main).state_entered!)).toBeGreaterThan(
      Date.parse(beforeMove!),
    );
  });
});

describe("transitions: the workspace block", () => {
  test("a task has no workspace before its first claim", () => {
    const { dir, id } = newTask();
    run(dir, id, "submit");
    expect(metaOf(dir, id).workspace).toBeNull();
  });

  test("a work claim records branch, worktree, agent and session", () => {
    const { dir, id } = planThrough();
    claim(dir, id, "pi-anthropic-claude-sonnet-4-5-2", process.pid, {
      branch: "work/000001",
      worktree: "/tmp/task-graph-server/-repo/000001/worktree",
      session: "/tmp/task-graph-server/-repo/000001/session/worker/019f.jsonl",
    });

    expect(metaOf(dir, id).workspace).toEqual({
      branch: "work/000001",
      worktree: "/tmp/task-graph-server/-repo/000001/worktree",
      agent: "pi-anthropic-claude-sonnet-4-5-2",
      session: "/tmp/task-graph-server/-repo/000001/session/worker/019f.jsonl",
    });
  });

  test("only a work claim records a session", () => {
    const { dir, id } = newTask();
    run(dir, id, "submit");
    claim(dir, id, "designer", process.pid, {
      branch: "work/000001",
      worktree: "/tmp/wt",
      session:
        "/tmp/task-graph-server/-repo/000001/session/designer/019f.jsonl",
    });

    expect(metaOf(dir, id).workspace!.session).toBeNull();
  });

  test("a review claim leaves the work session it was handed alone", () => {
    const work =
      "/tmp/task-graph-server/-repo/000001/session/worker/019f.jsonl";
    const { dir, id } = planThrough();
    claim(dir, id, "worker", process.pid, {
      branch: "work/000001",
      worktree: "/tmp/wt",
      session: work,
    });
    run(dir, id, "submit");
    run(dir, id, "pass");
    claim(dir, id, "reviewer", process.pid, {
      branch: "work/000001",
      worktree: "/tmp/wt",
      session:
        "/tmp/task-graph-server/-repo/000001/session/reviewer/01a0.jsonl",
    });

    expect(metaOf(dir, id).state).toBe("WORK_REVIEW");
    expect(metaOf(dir, id).workspace!.session).toBe(work);
  });

  test("a claim with no workspace args leaves the recorded one alone", () => {
    const { dir, id } = newTask();
    run(dir, id, "submit");
    claim(dir, id, "pi-1", process.pid, {
      branch: "work/000001",
      worktree: "/tmp/wt",
      session: "/tmp/session.jsonl",
    });
    const before = metaOf(dir, id).workspace;

    run(dir, id, "submit");

    expect(metaOf(dir, id).workspace).toEqual(before);
  });

  test("the session is null when the work claim does not carry one", () => {
    const { dir, id } = planThrough();
    claim(dir, id, "pi-1", process.pid, {
      branch: "work/000001",
      worktree: "/tmp/wt",
    });

    expect(metaOf(dir, id).workspace!.session).toBeNull();
  });

  test("a branch without a worktree is refused and writes nothing", () => {
    const { dir, id } = newTask();
    run(dir, id, "submit");

    expect(() =>
      claim(dir, id, "pi-1", process.pid, { branch: "work/000001" }),
    ).toThrow(/"worktree" must be a non-empty string/);
    expect(metaOf(dir, id).state).toBe("DESIGN");
    expect(metaOf(dir, id).workspace).toBeNull();
  });

  test("the workspace survives a cleared claim and round-trips through the schema", async () => {
    const dir = makeTasksDir();
    const workspace = {
      branch: "work/000001",
      worktree: "/tmp/task-graph-server/-repo/000001/worktree",
      agent: "pi-anthropic-claude-sonnet-4-5-2",
      session: "/tmp/task-graph-server/-repo/000001/session/work/019f.jsonl",
    };
    const id = writeTask(dir, {
      id: "000001",
      state: "WORK",
      claimed_by: "pi-anthropic-claude-sonnet-4-5-2",
      claimed_pid: await deadPid(),
      workspace,
    });

    expect(metaOf(dir, id).workspace).toEqual(workspace);
    unclaim(dir, id);
    expect(metaOf(dir, id).workspace).toEqual(workspace);
  });

  test("closing clears the workspace", () => {
    const dir = makeTasksDir();
    const id = createTask(dir, ORCHESTRATOR_DIR, "a task").id;
    run(dir, id, "submit");
    claim(dir, id, "d");
    run(dir, id, "submit");
    claim(dir, id, "dr");
    run(dir, id, "submit");
    claim(dir, id, "p");
    run(dir, id, "submit");
    claim(dir, id, "pr");
    run(dir, id, "submit");
    claim(dir, id, "pi-1", process.pid, {
      branch: "work/000001",
      worktree: "/tmp/wt",
    });
    run(dir, id, "submit");
    run(dir, id, "pass");
    claim(dir, id, "r");
    run(dir, id, "submit");
    const { closedPath } = run(dir, id, "submit");

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
