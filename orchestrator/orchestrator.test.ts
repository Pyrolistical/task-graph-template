import { afterAll, beforeAll, describe, expect, setSystemTime } from "bun:test";
import { tempDir, test } from "./temp.ts";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

beforeAll(() => {
  setSystemTime(new Date("2026-01-01").getTime());
});

afterAll(() => {
  setSystemTime();
});
import {
  type AgentSlot,
  agentModelKey,
  agentWrite,
  checkWrite,
  loadAgents,
  parseAgents,
} from "./agents.ts";
import { attemptOf, historyName, rotate } from "./assignment.ts";
import { CheckRunner, tailOf } from "./checks.ts";
import { blockingCounts } from "./graph.ts";
import { inbox } from "./inbox.ts";
import { ISSUES, Prompts } from "./prompts.ts";
import { RESULT_TOOLS, resultFromCall } from "./results.ts";
import { SchemaError } from "./schema.ts";
import { render } from "./template.ts";
import { TransitionLog } from "./transition-log.ts";
import { describeActivity, toolCall } from "./activity.ts";
import {
  JsonlSplitter,
  LOOP_LIMIT,
  PiProcess,
  PiStream,
  spawnArgs,
} from "./rpc.ts";
import { candidates, pickSlot, plan } from "./scheduler.ts";
import { ALL_ROLES } from "./runtime.ts";
import { type TaskMeta, isProcessAlive, splitDocument } from "./task.ts";
import {
  Runtime,
  branchName,
  defaultTasksDir,
  graphKey,
  repoKey,
  writeAtomic,
} from "./runtime.ts";
import * as git from "./git.ts";
import {
  CACHE_HOME,
  DEFAULT_WRITE,
  NON_INTERACTIVE_ENV,
  PI_HOME,
  SANDBOX_COMMAND,
  ZIG_WRITE,
  expandHome,
  overlays,
  sandbox,
  sandboxArgs,
  AGENT_OOM_SCORE_ADJUST,
  CHECK_OOM_SCORE_ADJUST,
  LIMIT_COMMAND,
  OOM_COMMAND,
  MEMORY_MAX,
  TASKS_MAX,
  limitArgs,
} from "./sandbox.ts";

const ORCHESTRATOR_DIR = import.meta.dir;

function tempRepo(): string {
  const repo = tempDir("orchestrator-repo-");
  git.gitOrThrow(repo, ["init", "-q", "-b", "master"]);
  git.gitOrThrow(repo, ["config", "user.email", "orchestrator@example.com"]);
  git.gitOrThrow(repo, ["config", "user.name", "orchestrator"]);
  fs.writeFileSync(path.join(repo, "a.txt"), "one\n");
  git.gitOrThrow(repo, ["add", "-A"]);
  git.gitOrThrow(repo, ["commit", "-q", "-m", "initial"]);
  return repo;
}

function commitIn(target: string, file: string, contents: string): void {
  fs.writeFileSync(path.join(target, file), contents);
  git.gitOrThrow(target, ["add", "-A"]);
  git.gitOrThrow(target, ["commit", "-q", "-m", `add ${file}`]);
}

function templateOf(name: string): string {
  return fs.readFileSync(path.join(ORCHESTRATOR_DIR, name), "utf-8");
}

describe("agent pool config", () => {
  test("names are derived from type, provider, model and slot", () => {
    const slots = parseAgents({
      agents: [
        {
          type: "pi",
          provider: "anthropic",
          model: "claude-sonnet-4-5",
          slots: 3,
        },
        { type: "pi", provider: "llama.cpp-rocm", model: "rocm", slots: 1 },
      ],
    });

    expect(slots.map((slot) => slot.name)).toEqual([
      "pi-anthropic-claude-sonnet-4-5-1",
      "pi-anthropic-claude-sonnet-4-5-2",
      "pi-anthropic-claude-sonnet-4-5-3",
      "pi-llama.cpp-rocm-rocm-1",
    ]);
    expect(slots[0]!.slot).toBe(1);
    expect(slots[3]!.provider).toBe("llama.cpp-rocm");
  });

  test("every slot of an entry shares one agent key", () => {
    const slots = parseAgents({
      agents: [
        { type: "pi", provider: "anthropic", model: "m", slots: 2 },
        { type: "pi", provider: "openai", model: "m", slots: 1 },
      ],
    });

    expect(slots.map((slot) => slot.agent)).toEqual([
      "pi-anthropic-m",
      "pi-anthropic-m",
      "pi-openai-m",
    ]);
    for (const slot of slots) {
      expect(slot.agent).toBe(agentModelKey(slot.name));
    }
  });

  test("an agent is enabled unless the pool says otherwise", () => {
    const slots = parseAgents({
      agents: [
        { type: "pi", provider: "anthropic", model: "m", slots: 2 },
        {
          type: "pi",
          provider: "openai",
          model: "m",
          slots: 1,
          enabled: false,
        },
      ],
    });

    expect(slots.map((slot) => slot.enabled)).toEqual([true, true, false]);
  });

  test("a slot may take every role unless the pool says otherwise", () => {
    const slots = parseAgents({
      agents: [
        { type: "pi", provider: "anthropic", model: "m", slots: 1 },
        {
          type: "pi",
          provider: "openai",
          model: "m",
          slots: 1,
          roles: ["reviewer"],
        },
      ],
    });

    expect(slots[0]!.roles).toEqual(["worker", "reviewer", "planner"]);
    expect(slots[1]!.roles).toEqual(["reviewer"]);
  });

  test("an unknown role is rejected on load", () => {
    expect(() =>
      parseAgents({
        agents: [
          {
            type: "pi",
            provider: "anthropic",
            model: "m",
            slots: 1,
            roles: ["agent_checker"],
          },
        ],
      }),
    ).toThrow(/Invalid option/);
  });

  test("the model key drops only the slot number", () => {
    expect(agentModelKey("pi-anthropic-claude-sonnet-4-5-2")).toBe(
      "pi-anthropic-claude-sonnet-4-5",
    );
    expect(agentModelKey("pi-llama.cpp-rocm-rocm-1")).toBe(
      "pi-llama.cpp-rocm-rocm",
    );
  });

  test("an unknown key is rejected on load", () => {
    expect(() =>
      parseAgents({
        agents: [
          {
            type: "pi",
            provider: "anthropic",
            model: "m",
            slots: 1,
            retries: 3,
          },
        ],
      }),
    ).toThrow(/Unrecognized key: "retries"/);
  });

  test("a slot is a type, a provider, a model and a number, and nothing else", () => {
    expect(() =>
      parseAgents({
        agents: [
          {
            type: "pi",
            provider: "anthropic",
            model: "m",
            slots: 1,
            thinking: "high",
          },
        ],
      }),
    ).toThrow(/Unrecognized key: "thinking"/);

    expect(
      parseAgents({
        agents: [{ type: "pi", provider: "anthropic", model: "m", slots: 1 }],
      })[0],
    ).toEqual({
      name: "pi-anthropic-m-1",
      agent: "pi-anthropic-m",
      type: "pi",
      provider: "anthropic",
      model: "m",
      slot: 1,
      enabled: true,
      write: DEFAULT_WRITE,
      roles: ["worker", "reviewer", "planner"],
    });
  });

  test("the declared write paths default to the toolchain cache zig builds need", () => {
    expect(DEFAULT_WRITE).toEqual([ZIG_WRITE]);
    expect(ZIG_WRITE).toBe(CACHE_HOME);
    expect(
      parseAgents({
        agents: [{ type: "pi", provider: "anthropic", model: "m" }],
      })[0]!.write,
    ).toEqual([CACHE_HOME]);
  });

  test("declared write paths replace the defaults", () => {
    const slots = parseAgents({
      agents: [
        {
          type: "pi",
          provider: "anthropic",
          model: "m",
          write: ["~/.cache", "~/.cargo"],
        },
      ],
    });

    expect(slots[0]!.write).toEqual(["~/.cache", "~/.cargo"]);
  });

  test("an empty write array is a pool that grants nothing outside its worktree", () => {
    const slots = parseAgents({
      agents: [{ type: "pi", provider: "anthropic", model: "m", write: [] }],
    });

    expect(slots[0]!.write).toEqual([]);
    expect(agentWrite(slots[0]!)).toEqual(
      fs.existsSync(PI_HOME) ? [PI_HOME] : [],
    );
  });

  test("a pi agent always gets its own home, declared or not", () => {
    const home = tempDir("pi-home-");
    const slots = parseAgents({
      agents: [
        { type: "pi", provider: "anthropic", model: "m", write: [home] },
        { type: "other", provider: "anthropic", model: "m", write: [home] },
      ],
    });

    expect(agentWrite(slots[0]!)).toEqual(
      fs.existsSync(PI_HOME) ? [home, PI_HOME] : [home],
    );
    expect(agentWrite(slots[1]!)).toEqual([home]);
  });

  test("a check gets every declared write path, and never a pi home", () => {
    const one = tempDir("check-write-");
    const two = tempDir("check-write-");
    const slots = parseAgents({
      agents: [
        { type: "pi", provider: "anthropic", model: "m", write: [one] },
        { type: "pi", provider: "openai", model: "m", write: [one, two] },
      ],
    });

    expect(checkWrite(slots)).toEqual([one, two]);
  });

  test("a missing field and a bad slot count are reported together, by path", () => {
    let issues: string[] = [];
    try {
      parseAgents({
        agents: [
          { type: "pi", provider: "anthropic", model: "m", slots: 0 },
          { provider: "anthropic", model: "n", slots: 1 },
        ],
      });
    } catch (err) {
      issues = (err as SchemaError).issues;
    }

    expect(issues).toHaveLength(2);
    expect(issues[0]).toContain("agents[0].slots");
    expect(issues[1]).toContain("agents[1].type");
  });

  test("a repeated type+provider+model triple is refused", () => {
    expect(() =>
      parseAgents({
        agents: [
          { type: "pi", provider: "anthropic", model: "m", slots: 1 },
          { type: "pi", provider: "anthropic", model: "m", slots: 2 },
        ],
      }),
    ).toThrow(/agents\[1\]: repeats type\+provider\+model "pi\/anthropic\/m"/);
  });

  test("a pool that declares no slots is refused", () => {
    expect(() => parseAgents({ agents: [] })).toThrow(/agents/);
  });

  test("the shipped example pool loads", () => {
    const slots = loadAgents(
      path.join(ORCHESTRATOR_DIR, "..", "agents.example.json"),
    );
    expect(slots.length).toBeGreaterThan(0);
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

describe("the transition log", () => {
  test("seq advances by one per applied transition", () => {
    const log = new TransitionLog(
      path.join(tempDir("orchestrator-"), "transitions.jsonl"),
    );

    const first = log.append({
      task_id: "000042",
      transition: "claim",
      from: "READY_WORK",
      to: "WORKING",
      by: "pi-1",
    });
    const second = log.append({
      task_id: "000042",
      transition: "submit",
      from: "WORKING",
      to: "READY_CHECK",
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
      transition: "claim",
      from: "READY_WORK",
      to: "WORKING",
      by: "pi-1",
    });

    expect(new TransitionLog(filePath).cursor).toBe(1);
    expect(
      new TransitionLog(filePath).append({
        task_id: "000042",
        transition: "release",
        from: "WORKING",
        to: "READY_WORK",
        by: "pi-1",
      }).seq,
    ).toBe(2);
  });

  test("since gives the manager a delta from its cursor", () => {
    const log = new TransitionLog(
      path.join(tempDir("orchestrator-"), "transitions.jsonl"),
    );
    for (const to of ["WORKING", "READY_CHECK", "CHECKING"] as const) {
      log.append({
        task_id: "000042",
        transition: "t",
        from: "READY_WORK",
        to,
        by: "pi-1",
      });
    }

    expect(log.since(1).map((e) => e.to)).toEqual(["READY_CHECK", "CHECKING"]);
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
        from: "WORKING",
        to: "WORKING",
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

describe("prompt and template overrides", () => {
  function overrides(files: Record<string, string>): string {
    const dir = tempDir("orchestrator-overrides-");
    for (const [name, contents] of Object.entries(files)) {
      const file = path.join(dir, name);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, contents, "utf-8");
    }
    return dir;
  }

  test("with no overrides directory every file comes from the orchestrator", () => {
    const prompts = new Prompts(ORCHESTRATOR_DIR);

    expect(prompts.systemPrompt("WORKING")).toBe(
      path.join(ORCHESTRATOR_DIR, "prompts", "WORKING.md"),
    );
    expect(prompts.fragment("dispatch")).toBe(
      templateOf("prompts/dispatch.md"),
    );
  });

  test("an override wins over the orchestrator's own copy", () => {
    const dir = overrides({
      "prompts/dispatch.md": "Read ../ASSIGNMENT.md and do it.\n",
      "prompts/WORKING.md": "you are an implementer\n",
    });
    const prompts = new Prompts(ORCHESTRATOR_DIR, dir);

    expect(prompts.fragment("dispatch")).toBe(
      "Read ../ASSIGNMENT.md and do it.\n",
    );
    expect(prompts.systemPrompt("WORKING")).toBe(
      path.join(dir, "prompts", "WORKING.md"),
    );
    expect(prompts.fragment("dispatch", {})).toContain("Read");
  });

  test("a directory that overrides one file leaves the rest alone", () => {
    const dir = overrides({ "prompts/dispatch.md": "do it\n" });
    const prompts = new Prompts(ORCHESTRATOR_DIR, dir);

    expect(prompts.fragment("dispatch")).toBe("do it\n");
    expect(prompts.systemPrompt("WORK_REVIEWING")).toBe(
      path.join(ORCHESTRATOR_DIR, "prompts", "WORK_REVIEWING.md"),
    );
    const vars = { command: "bun test", limit: LOOP_LIMIT };
    expect(prompts.issue("looping", "WORKING", vars)).toBe(
      render(templateOf("prompts/looping-WORKING.md"), vars),
    );
  });

  test("an override is rendered with the same variables as the file it replaces", () => {
    const dir = overrides({
      "prompts/check-failed.md":
        "{{#failures}}\nbroke {{command}}\n{{/failures}}\n",
    });

    expect(
      new Prompts(ORCHESTRATOR_DIR, dir).fragment("check-failed", {
        failures: [{ command: "bun test", exit_code: "1", output: "boom" }],
      }),
    ).toBe("broke bun test\n");
  });

  test("a file edited after construction stays the cached copy", () => {
    const dir = overrides({ "prompts/dispatch.md": "one\n" });
    const prompts = new Prompts(ORCHESTRATOR_DIR, dir);

    fs.writeFileSync(path.join(dir, "prompts", "dispatch.md"), "two\n");

    expect(prompts.fragment("dispatch")).toBe("one\n");
  });

  test("reload re-reads an edited override and falls back when one is deleted", () => {
    const dir = overrides({ "prompts/dispatch.md": "one\n" });
    const prompts = new Prompts(ORCHESTRATOR_DIR, dir);

    fs.writeFileSync(path.join(dir, "prompts", "dispatch.md"), "two\n");
    expect(prompts.reload()).toContain(
      path.join(dir, "prompts", "dispatch.md"),
    );
    expect(prompts.fragment("dispatch")).toBe("two\n");

    fs.rmSync(path.join(dir, "prompts", "dispatch.md"));
    expect(prompts.reload()).not.toContain(
      path.join(dir, "prompts", "dispatch.md"),
    );
    expect(prompts.fragment("dispatch")).toBe(
      templateOf("prompts/dispatch.md"),
    );
  });

  test("a file missing from both directories names both", () => {
    const dir = overrides({});

    expect(() => new Prompts(ORCHESTRATOR_DIR, dir).fragment("nope")).toThrow(
      new RegExp(
        `no prompts/nope.md in ${path.join(dir, "prompts")} or ${path.join(ORCHESTRATOR_DIR, "prompts")}`,
      ),
    );
  });
});

describe("result tool calls", () => {
  const STATES = [
    "PLANNING",
    "PLAN_REVIEWING",
    "WORKING",
    "WORK_REVIEWING",
  ] as const;

  test("submit is the result in PLANNING and WORKING", () => {
    expect(resultFromCall("WORKING", { tool: "submit", args: {} })).toEqual({
      type: "submit",
    });
    expect(resultFromCall("PLANNING", { tool: "submit", args: {} })).toEqual({
      type: "submit",
    });
  });

  test("a work review submit carries findings and delegations", () => {
    expect(
      resultFromCall("WORK_REVIEWING", {
        tool: "submit",
        args: {
          findings: ["the null case is untested"],
          delegations: ["the same bug lives in fetch.ts"],
        },
      }),
    ).toEqual({
      type: "submit",
      findings: ["the null case is untested"],
      delegations: ["the same bug lives in fetch.ts"],
    });
  });

  test("a plan review submit carries findings", () => {
    expect(
      resultFromCall("PLAN_REVIEWING", {
        tool: "submit",
        args: { findings: [] },
      }),
    ).toEqual({ type: "submit", findings: [] });
  });

  test("a plain submit cannot carry findings or delegations", () => {
    expect(() =>
      resultFromCall("WORKING", { tool: "submit", args: { findings: ["x"] } }),
    ).toThrow(/cannot carry findings/);
    expect(() =>
      resultFromCall("PLANNING", {
        tool: "submit",
        args: { delegations: ["x"] },
      }),
    ).toThrow(/cannot carry delegations/);
    expect(() =>
      resultFromCall("WORKING", {
        tool: "submit",
        args: { findings: ["x"], delegations: ["y"] },
      }),
    ).toThrow(/cannot carry findings/);
    expect(
      resultFromCall("WORKING", { tool: "submit", args: { findings: [] } }),
    ).toEqual({ type: "submit" });
  });

  test("a review submit without findings is rejected", () => {
    expect(() =>
      resultFromCall("PLAN_REVIEWING", { tool: "submit", args: {} }),
    ).toThrow(/findings/);
    expect(() =>
      resultFromCall("WORK_REVIEWING", { tool: "submit", args: {} }),
    ).toThrow(/findings/);
  });

  test("a work review submit without delegations is rejected", () => {
    expect(() =>
      resultFromCall("WORK_REVIEWING", {
        tool: "submit",
        args: { findings: [] },
      }),
    ).toThrow(/delegations/);
  });

  test("a plan review submit cannot carry delegations", () => {
    expect(() =>
      resultFromCall("PLAN_REVIEWING", {
        tool: "submit",
        args: { findings: [], delegations: ["x"] },
      }),
    ).toThrow(/cannot carry delegations/);
    expect(
      resultFromCall("PLAN_REVIEWING", {
        tool: "submit",
        args: { findings: [], delegations: [] },
      }),
    ).toEqual({ type: "submit", findings: [] });
  });

  test("a finding that is only whitespace is rejected", () => {
    expect(() =>
      resultFromCall("WORK_REVIEWING", {
        tool: "submit",
        args: { findings: ["  "], delegations: [] },
      }),
    ).toThrow(/non-empty string/);
  });

  test("blocked requires a message, in every state", () => {
    for (const state of STATES) {
      expect(
        resultFromCall(state, {
          tool: "blocked",
          args: { message: "the box is down" },
        }),
      ).toEqual({ type: "blocked", message: "the box is down" });
      expect(() =>
        resultFromCall(state, { tool: "blocked", args: {} }),
      ).toThrow(/message/);
    }
  });

  test("a tool outside the result tools is rejected in every state", () => {
    for (const state of STATES) {
      expect(() => resultFromCall(state, { tool: "bash", args: {} })).toThrow(
        /or blocked tool/,
      );
    }
  });

  test("each role's extension registers submit and blocked, only the reviewer's submit carries findings", async () => {
    const toolsOf = async (file: string) => {
      const { default: factory } = await import(file);
      const tools = new Map<
        string,
        { parameters: { properties: Record<string, unknown> } }
      >();
      factory({
        registerTool: (tool: {
          name: string;
          parameters: { properties: Record<string, unknown> };
        }) => tools.set(tool.name, tool),
      } as never);
      return tools;
    };

    const planner = await toolsOf("./result-tools-planner.ts");
    const worker = await toolsOf("./result-tools-worker.ts");
    const reviewer = await toolsOf("./result-tools-reviewer.ts");

    for (const tools of [planner, worker, reviewer]) {
      expect([...tools.keys()].sort()).toEqual([...RESULT_TOOLS].sort());
    }
    expect(planner.get("submit")!.parameters.properties).toEqual({});
    expect(worker.get("submit")!.parameters.properties).toEqual({});
    expect(reviewer.get("submit")!.parameters.properties).toHaveProperty(
      "findings",
    );
    expect(reviewer.get("submit")!.parameters.properties).toHaveProperty(
      "delegations",
    );
    expect(planner.get("blocked")!.parameters.properties).toHaveProperty(
      "message",
    );
  });
});

describe("template rendering", () => {
  test("a template referring to something it was not given fails loudly", () => {
    expect(() => render("agent: {{agent}}\n", {})).toThrow(/refers to "agent"/);
  });

  test("an unclosed section fails loudly", () => {
    expect(() => render("{{#todos}}\n- x\n", { todos: [] })).toThrow(
      /never closes "todos"/,
    );
  });
});

describe("the issues an agent can be sent back for", () => {
  test("only a blocked result gets a single attempt", () => {
    expect(ISSUES.blocked.attempts).toBe(1);
    for (const name of [
      "missing-result",
      "missing-todos",
      "missing-notes",
      "modified-assignment",
      "uncommitted",
      "unparsable-result",
      "modified-worktree",
    ] as const) {
      expect(ISSUES[name].attempts).toBe(4);
    }
  });

  test("the planning issues hold with reasons that name them", () => {
    expect(ISSUES["missing-todos"].held("")).toBe(
      "the planner submitted without appending a todo list to the assignment",
    );
    expect(ISSUES["modified-assignment"].held("")).toContain(
      "only the section it was instructed to write may be appended",
    );
    expect(ISSUES["modified-worktree"].held("2 files")).toBe(
      "the agent wrote to the worktree during planning: 2 files",
    );
  });

  test("a loop is worth fewer nudges than a bad result, being dearer to reach", () => {
    expect(ISSUES.looping.attempts).toBeLessThan(ISSUES.uncommitted.attempts);
    expect(ISSUES.looping.attempts).toBeGreaterThan(ISSUES.blocked.attempts);
  });

  test("each issue is scoped to the states that can raise it", () => {
    expect(ISSUES["unparsable-result"].states).toEqual([
      "PLANNING",
      "PLAN_REVIEWING",
      "WORKING",
      "WORK_REVIEWING",
    ]);
    expect(ISSUES["missing-result"].states).toEqual([
      "PLANNING",
      "PLAN_REVIEWING",
      "WORKING",
      "WORK_REVIEWING",
    ]);
    expect(ISSUES.looping.states).toEqual([
      "PLANNING",
      "PLAN_REVIEWING",
      "WORKING",
      "WORK_REVIEWING",
    ]);
    expect(ISSUES.blocked.states).toEqual([
      "PLANNING",
      "PLAN_REVIEWING",
      "WORKING",
      "WORK_REVIEWING",
    ]);
    expect(ISSUES["missing-todos"].states).toEqual(["PLANNING"]);
    expect(ISSUES["missing-notes"].states).toEqual(["WORKING"]);
    expect(ISSUES["modified-assignment"].states).toEqual([
      "PLANNING",
      "PLAN_REVIEWING",
      "WORKING",
      "WORK_REVIEWING",
    ]);
    expect(ISSUES.uncommitted.states).toEqual(["WORKING"]);
    expect(ISSUES["modified-worktree"].states).toEqual([
      "PLANNING",
      "PLAN_REVIEWING",
    ]);
  });

  test("each issue names a fragment that exists for every state that can raise it", () => {
    for (const issue of Object.values(ISSUES)) {
      for (const state of issue.states) {
        expect(
          fs.existsSync(
            path.join(
              ORCHESTRATOR_DIR,
              "prompts",
              `${issue.fragment(state)}.md`,
            ),
          ),
        ).toBe(true);
      }
    }
  });

  test("a blocked hold reason is the agent's own message", () => {
    expect(ISSUES.blocked.held("the box is down")).toBe("the box is down");
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

describe("the rpc stream", () => {
  test("records are split on newlines only, not on U+2028", () => {
    const splitter = new JsonlSplitter();
    const line = JSON.stringify({ type: "prompt", message: "a b" });

    expect(splitter.feed(`${line}\n`)).toEqual([line]);
    expect(JSON.parse(splitter.feed(`${line}\n`)[0]!).message).toBe("a b");
  });

  test("a record split across chunks is buffered until it is whole", () => {
    const splitter = new JsonlSplitter();
    expect(splitter.feed('{"type":"agent_')).toEqual([]);
    expect(splitter.pending).toBe('{"type":"agent_');
    expect(splitter.feed('settled"}\n')).toEqual(['{"type":"agent_settled"}']);
    expect(splitter.pending).toBe("");
  });

  test("a trailing carriage return is stripped", () => {
    expect(new JsonlSplitter().feed('{"a":1}\r\n')).toEqual(['{"a":1}']);
  });

  test("agent_end is not settlement; agent_settled is", () => {
    const stream = new PiStream();
    stream.feed(`${JSON.stringify({ type: "agent_start" })}\n`);
    stream.feed(`${JSON.stringify({ type: "agent_end", willRetry: true })}\n`);
    expect(stream.state.settled).toBe(false);

    stream.feed(`${JSON.stringify({ type: "agent_settled" })}\n`);
    expect(stream.state.settled).toBe(true);
  });

  test("the outcome comes from the last assistant message", () => {
    const stream = new PiStream();
    stream.feed(
      `${JSON.stringify({
        type: "message_end",
        message: {
          role: "assistant",
          stopReason: "error",
          errorMessage: "Connection error.",
          usage: { cost: { total: 0.12 } },
        },
      })}\n`,
    );

    expect(stream.state.stopReason).toBe("error");
    expect(stream.state.errorMessage).toBe("Connection error.");
    expect(stream.state).not.toHaveProperty("cost");
  });

  test("a tool result message does not become the outcome", () => {
    const stream = new PiStream();
    stream.feed(
      `${JSON.stringify({
        type: "message_end",
        message: { role: "toolResult", isError: true },
      })}\n`,
    );
    expect(stream.state.stopReason).toBeNull();
  });

  test("a response is matched to the command that carried its id", async () => {
    const stream = new PiStream();
    const expected = stream.expect("2");

    stream.feed(
      `${JSON.stringify({ type: "response", id: "1", command: "prompt", success: true })}\n`,
    );
    stream.feed(
      `${JSON.stringify({
        type: "response",
        id: "2",
        command: "get_state",
        success: true,
        data: { sessionFile: "/tmp/s.jsonl" },
      })}\n`,
    );

    expect((await expected).data!.sessionFile).toBe("/tmp/s.jsonl");
  });

  test("a dead process rejects everything still waiting", async () => {
    const stream = new PiStream();
    const expected = stream.expect("1");
    stream.fail("the pi process closed its stdout");
    expect(expected).rejects.toThrow(/closed its stdout/);
  });

  test("a dead process rejects what is asked of it afterwards", async () => {
    const stream = new PiStream();
    stream.fail("the pi process closed its stdout");
    expect(stream.expect("1")).rejects.toThrow(/closed its stdout/);
  });

  function deadProcess(): PiProcess {
    const dir = tempDir("orchestrator-");
    const command = path.join(dir, "exits.ts");
    fs.writeFileSync(command, "process.exit(0);\n");

    return new PiProcess(
      {
        provider: "fake",
        model: "fake",
        sessionDir: path.join(dir, "session"),
        name: "000001 work",
        cwd: dir,
        systemPrompt: path.join(dir, "system.md"),
        extension: path.join(dir, "result-tools-worker.ts"),
        log: path.join(dir, "rpc.jsonl"),
      },
      command,
      ["bun"],
    );
  }

  test("a request made after the child died settles instead of hanging", async () => {
    const process = deadProcess();
    await process.stream.settled();

    const outcome = await Promise.race([
      process.lastAssistantText().then(
        () => "resolved",
        () => "rejected",
      ),
      Bun.sleep(2000).then(() => "hung"),
    ]);

    expect(outcome).toBe("rejected");
  }, 10000);

  test("a process whose stdout closed is not alive, exit code or not", async () => {
    const process = deadProcess();
    await process.stream.settled();

    expect(process.alive).toBe(false);
  }, 10000);

  test("activity tracks the running tool", () => {
    const stream = new PiStream();
    stream.feed(
      `${JSON.stringify({
        type: "tool_execution_start",
        toolName: "bash",
        args: { command: "bun test\nsecond line" },
      })}\n`,
    );
    expect(stream.state.activity).toEqual({
      kind: "tool-call",
      tool: "bash",
      target: "bun test",
      started_at: Date.now(),
    });

    stream.feed(
      `${JSON.stringify({ type: "compaction_start", reason: "overflow" })}\n`,
    );
    expect(stream.state.activity).toEqual({
      kind: "compacting",
      reason: "overflow",
      started_at: Date.now(),
    });
  });

  test("tool_execution_end sets activity to thinking", () => {
    const stream = new PiStream();
    stream.feed(
      `${JSON.stringify({ type: "tool_execution_start", toolName: "bash", args: {} })}\n`,
    );
    stream.feed(
      `${JSON.stringify({ type: "tool_execution_end", toolCallId: "c1" })}\n`,
    );
    expect(stream.state.activity).toEqual({
      kind: "thinking",
      started_at: Date.now(),
    });
  });

  test("agent_settled sets activity to none", () => {
    const stream = new PiStream();
    stream.feed(
      `${JSON.stringify({ type: "tool_execution_start", toolName: "bash", args: {} })}\n`,
    );
    stream.feed(`${JSON.stringify({ type: "agent_settled" })}\n`);
    expect(stream.state.activity).toEqual({ kind: "none" });
  });

  test("starting sets activity to thinking", () => {
    const stream = new PiStream();
    stream.starting();
    expect(stream.state.activity).toEqual({
      kind: "thinking",
      started_at: Date.now(),
    });
  });

  test("a tool call with args.path but no command targets the path", () => {
    const stream = new PiStream();
    stream.feed(
      `${JSON.stringify({
        type: "tool_execution_start",
        toolName: "read",
        args: { path: "/tmp/file.ts" },
      })}\n`,
    );
    expect(stream.state.activity).toEqual({
      kind: "tool-call",
      tool: "read",
      target: "/tmp/file.ts",
      started_at: Date.now(),
    });
  });

  test("a tool call with neither command nor path falls back to the tool name", () => {
    const stream = new PiStream();
    stream.feed(
      `${JSON.stringify({
        type: "tool_execution_start",
        toolName: "think",
        args: {},
      })}\n`,
    );
    expect(stream.state.activity).toEqual({
      kind: "tool-call",
      tool: "think",
      target: "think",
      started_at: Date.now(),
    });
  });

  test("after abort, the aborting flag is set before the write", () => {
    const dir = tempDir("orchestrator-");
    const script = path.join(dir, "exits.ts");
    fs.writeFileSync(script, "process.exit(0);\n");

    const proc = new PiProcess(
      {
        provider: "fake",
        model: "fake",
        sessionDir: path.join(dir, "session"),
        name: "test",
        cwd: dir,
        systemPrompt: path.join(dir, "system.md"),
        extension: path.join(dir, "result-tools-worker.ts"),
        log: path.join(dir, "rpc.jsonl"),
      },
      script,
      ["bun"],
    );

    const aborting = () => (proc as unknown as { aborting: boolean }).aborting;

    expect(aborting()).toBe(false);
    try {
      proc.abort();
    } catch {
      // write may fail because the process is already dead
    }
    expect(aborting()).toBe(true);
    proc.kill();
  }, 10000);

  test("describeActivity formats all four kinds", () => {
    expect(
      describeActivity({
        kind: "tool-call",
        tool: "bash",
        target: "bun test",
        started_at: Date.now(),
      }),
    ).toBe("tool: bash — bun test (0s)");
    expect(
      describeActivity({
        kind: "tool-call",
        tool: "bash",
        target: "bash",
        started_at: Date.now(),
      }),
    ).toBe("tool: bash (0s)");
    expect(describeActivity({ kind: "thinking", started_at: Date.now() })).toBe(
      "thinking (0s)",
    );
    expect(
      describeActivity({
        kind: "compacting",
        reason: "overflow",
        started_at: Date.now(),
      }),
    ).toBe("compacting (overflow) (0s)");
    expect(describeActivity({ kind: "none" })).toBe("");
  });

  test("the settle of the turn just handled does not satisfy the next prompt", async () => {
    const stream = new PiStream();
    stream.feed(
      `${JSON.stringify({ type: "agent_start" })}\n${JSON.stringify({ type: "agent_settled" })}\n`,
    );
    await stream.settled();

    stream.starting();
    let settled = false;
    void stream.settled().then(() => {
      settled = true;
    });
    await Bun.sleep(5);
    expect(settled).toBe(false);

    stream.feed(`${JSON.stringify({ type: "agent_settled" })}\n`);
    await Bun.sleep(5);
    expect(settled).toBe(true);
  });

  function toolCall(command: string): string {
    return `${JSON.stringify({
      type: "tool_execution_start",
      toolName: "bash",
      args: { command },
    })}\n`;
  }

  test("the same command over and over is a loop; nine of them is not", () => {
    const stream = new PiStream();
    const build = toolCall("zig build --verbose 2>&1 | head -80");

    for (let i = 0; i < LOOP_LIMIT - 1; i++) {
      stream.feed(build);
    }
    expect(stream.state.looping).toBeNull();

    stream.feed(build);
    expect(stream.state.looping).toBe("zig build --verbose 2>&1 | head -80");
  });

  test("a command that differs at all breaks the run, arguments included", () => {
    const stream = new PiStream();

    for (let i = 0; i < LOOP_LIMIT - 1; i++) {
      stream.feed(toolCall("zig build"));
    }
    stream.feed(toolCall("zig build -Doptimize=Debug"));
    for (let i = 0; i < LOOP_LIMIT - 1; i++) {
      stream.feed(toolCall("zig build"));
    }

    expect(stream.state.looping).toBeNull();
  });

  test("the same command spread across turns is not a loop", () => {
    const stream = new PiStream();
    const build = toolCall("zig build");

    for (let turn = 0; turn < 3; turn++) {
      stream.starting();
      for (let i = 0; i < LOOP_LIMIT - 1; i++) {
        stream.feed(build);
      }
    }

    expect(stream.state.looping).toBeNull();
  });

  test("a fresh prompt clears the loop, so the agent gets a clean turn", () => {
    const stream = new PiStream();
    for (let i = 0; i < LOOP_LIMIT; i++) {
      stream.feed(toolCall("zig build"));
    }
    expect(stream.state.looping).not.toBeNull();

    stream.starting();
    expect(stream.state.looping).toBeNull();
  });

  test("a garbled line is skipped rather than killing the stream", () => {
    const stream = new PiStream();
    const records = stream.feed(
      `not json\n${JSON.stringify({ type: "agent_settled" })}\n`,
    );
    expect(records).toHaveLength(1);
    expect(stream.state.settled).toBe(true);
  });

  test("the spawn line is rpc mode with no positional message", () => {
    const args = spawnArgs({
      provider: "anthropic",
      model: "claude-sonnet-4-5",
      sessionDir: "/tmp/s",
      name: "000042 worker",
      cwd: "/tmp/wt",
      systemPrompt: "/repo/orchestrator/prompts/WORKING.md",
      extension: "/repo/orchestrator/result-tools-worker.ts",
      log: "/tmp/rpc.jsonl",
    });

    expect(args.slice(0, 2)).toEqual(["--mode", "rpc"]);
    expect(args).toContain("--approve");
    expect(args).toContain("--extension");
    expect(args).toContain("/repo/orchestrator/result-tools-worker.ts");
    expect(args).toContain("@/repo/orchestrator/prompts/WORKING.md");
    expect(args).not.toContain("-p");
    expect(args).not.toContain("--thinking");
    expect(args).not.toContain("--tools");
    expect(args[args.length - 2]).toBe("--append-system-prompt");
  });

  test("each state is given its own system prompt", () => {
    for (const state of [
      "PLANNING",
      "PLAN_REVIEWING",
      "WORKING",
      "WORK_REVIEWING",
    ] as const) {
      const prompt = fs.readFileSync(
        path.join(ORCHESTRATOR_DIR, "prompts", `${state}.md`),
        "utf-8",
      );
      expect(prompt).toContain("tool");
      expect(prompt.includes("findings")).toBe(
        state === "PLAN_REVIEWING" || state === "WORK_REVIEWING",
      );
      expect(prompt.includes("Commit as you go")).toBe(state === "WORKING");
    }
  });
});

describe("the scheduler", () => {
  function task(overrides: Partial<TaskMeta>): TaskMeta {
    return {
      id: "000001",
      title: "a task",
      state: "READY_WORK",
      state_entered: "2026-07-29T00:00:00Z",
      depends_on: [],
      claimed_by: null,
      claimed_pid: null,
      held_reason: null,
      workspace: null,
      checks: [],
      task_graph_updates: [],
      ...overrides,
    };
  }

  function graph(...tasks: TaskMeta[]): Map<string, TaskMeta> {
    return new Map(tasks.map((t) => [t.id, t]));
  }

  function workspace(agent = "pi-anthropic-m-1") {
    return {
      branch: "work/000001",
      worktree: "/tmp/wt",
      agent,
      session: "/tmp/s.jsonl",
    };
  }

  const slot = (name: string) => ({
    name,
    agent: agentModelKey(name),
    type: "pi",
    provider: name.split("-")[1]!,
    model: "m",
    slot: 1,
    enabled: true,
    write: DEFAULT_WRITE,
    roles: [...ALL_ROLES],
  });

  test("blocking counts every transitive dependent", () => {
    const counts = blockingCounts(
      graph(
        task({ id: "000001" }),
        task({ id: "000002", depends_on: ["000001"] }),
        task({ id: "000003", depends_on: ["000002"] }),
        task({ id: "000004", depends_on: ["000001"] }),
      ),
    );

    expect(counts.get("000001")).toBe(3);
    expect(counts.get("000002")).toBe(1);
    expect(counts.get("000003")).toBe(0);
  });

  test("the queue runs right to left, closest to done first", () => {
    const queue = candidates(
      graph(
        task({ id: "000001" }),
        task({ id: "000002", workspace: workspace() }),
        task({ id: "000003", state: "READY_WORK_REVIEW" }),
        task({ id: "000004", workspace: workspace() }),
      ),
      new Set(["000004"]),
    );

    expect(queue.map((c) => c.task_id)).toEqual([
      "000004",
      "000003",
      "000002",
      "000001",
    ]);
    expect(queue.map((c) => c.rank)).toEqual([
      "resume",
      "READY_WORK_REVIEW",
      "READY_WORK_STARTED",
      "READY_WORK_FRESH",
    ]);
  });

  test("within a rank the task blocking the most goes first", () => {
    const queue = candidates(
      graph(
        task({ id: "000001" }),
        task({ id: "000002" }),
        task({ id: "000003", depends_on: ["000002"] }),
        task({ id: "000004", depends_on: ["000003"] }),
      ),
      new Set(),
    );

    expect(queue[0]!.task_id).toBe("000002");
    expect(queue[0]!.blocking).toBe(2);
  });

  test("a tie on blocking breaks on the id", () => {
    const queue = candidates(
      graph(task({ id: "000001" }), task({ id: "000002" })),
      new Set(),
    );

    expect(queue.map((c) => c.task_id)).toEqual(["000001", "000002"]);
  });

  test("a held task is never a candidate", () => {
    const queue = candidates(
      graph(
        task({ id: "000001", state: "HELD_WORK", held_reason: "a wall" }),
        task({ id: "000002", state: "HELD_PLAN", held_reason: "no plan" }),
      ),
      new Set(),
    );
    expect(queue).toEqual([]);
  });

  test("neither is a task somebody else is already holding", () => {
    const queue = candidates(
      graph(
        task({
          id: "000001",
          state: "WORKING",
          claimed_by: "pi-1",
          claimed_pid: 1,
        }),
        task({
          id: "000002",
          state: "CHECKING",
          claimed_by: "server",
          claimed_pid: 1,
        }),
      ),
      new Set(),
    );
    expect(queue).toEqual([]);
  });

  test("a resume prefers a free slot of the same model", () => {
    const free = [slot("pi-openai-m-1"), slot("pi-anthropic-m-2")];
    const candidate = candidates(
      graph(task({ id: "000001", workspace: workspace("pi-anthropic-m-1") })),
      new Set(["000001"]),
    )[0]!;

    expect(pickSlot(free, candidate, true)!.name).toBe("pi-anthropic-m-2");
  });

  test("the top of the queue falls back to any free slot", () => {
    const free = [slot("pi-openai-m-1")];
    const candidate = candidates(
      graph(task({ id: "000001", workspace: workspace("pi-anthropic-m-1") })),
      new Set(["000001"]),
    )[0]!;

    expect(pickSlot(free, candidate, true)!.name).toBe("pi-openai-m-1");
    expect(pickSlot(free, candidate, false)).toBeNull();
  });

  test("one slot is never handed to two tasks", () => {
    const dispatches = plan(
      graph(task({ id: "000001" }), task({ id: "000002" })),
      new Set(),
      [slot("pi-anthropic-m-1")],
    );

    expect(dispatches).toHaveLength(1);
    expect(dispatches[0]!.candidate.task_id).toBe("000001");
  });

  test("a candidate carries the role its state claims", () => {
    const queue = candidates(
      graph(
        task({ id: "000001", state: "READY_PLAN_REVIEW" }),
        task({ id: "000002", state: "READY_PLAN" }),
      ),
      new Set(),
    );

    expect(queue.map((c) => c.role)).toEqual(["reviewer", "planner"]);
  });

  test("a slot that may not take the candidate's role is skipped", () => {
    const free: AgentSlot[] = [
      { ...slot("pi-openai-m-1"), roles: ["reviewer"] },
      slot("pi-anthropic-m-2"),
    ];
    const candidate = candidates(graph(task({ id: "000001" })), new Set())[0]!;

    expect(pickSlot(free, candidate, true)!.name).toBe("pi-anthropic-m-2");
  });

  test("nothing is planned for a role the pool cannot serve", () => {
    const free: AgentSlot[] = [
      { ...slot("pi-openai-m-1"), roles: ["reviewer"] },
    ];

    expect(
      pickSlot(
        free,
        candidates(graph(task({ id: "000001" })), new Set())[0]!,
        true,
      ),
    ).toBeNull();
    expect(plan(graph(task({ id: "000001" })), new Set(), free)).toEqual([]);
  });

  test("nothing is planned when the pool is saturated", () => {
    expect(plan(graph(task({ id: "000001" })), new Set(), [])).toEqual([]);
  });

  test("a review waiting to be redone is a resume like any other", () => {
    const queue = candidates(
      graph(
        task({ id: "000001" }),
        task({
          id: "000002",
          state: "READY_WORK_REVIEW",
          workspace: workspace(),
        }),
      ),
      new Set(["000002"]),
    );

    expect(queue[0]!.task_id).toBe("000002");
    expect(queue[0]!.rank).toBe("resume");
  });
});

describe("the manager inbox", () => {
  function task(overrides: Partial<TaskMeta>): TaskMeta {
    return {
      id: "000001",
      title: "a task",
      state: "NEW",
      state_entered: "2026-07-29T00:00:00Z",
      depends_on: [],
      claimed_by: null,
      claimed_pid: null,
      held_reason: null,
      workspace: null,
      checks: [],
      task_graph_updates: [],
      ...overrides,
    };
  }

  function graph(...tasks: TaskMeta[]): Map<string, TaskMeta> {
    return new Map(tasks.map((t) => [t.id, t]));
  }

  test("what is closest to closed comes first", () => {
    const rows = inbox(
      graph(
        task({ id: "000001", state: "NEW" }),
        task({ id: "000002", state: "HELD_WORK", held_reason: "a wall" }),
        task({ id: "000003", state: "HELD_PLAN", held_reason: "no plan" }),
        task({
          id: "000004",
          state: "READY_TASK_GRAPH_UPDATE",
          task_graph_updates: [{ op: "add", message: "m", done: false }],
        }),
        task({ id: "000005", state: "READY_MANAGER_REVIEW" }),
      ),
    );

    expect(rows.map((row) => row.task_id)).toEqual([
      "000005",
      "000004",
      "000003",
      "000002",
      "000001",
    ]);
    expect(rows.map((row) => row.rank)).toEqual([
      "READY_MANAGER_REVIEW",
      "READY_TASK_GRAPH_UPDATE",
      "HELD_PLAN",
      "HELD_WORK",
      "NEW",
    ]);
  });

  test("only what is actually waiting on a person is in it", () => {
    const rows = inbox(
      graph(
        task({ id: "000001", state: "READY_WORK" }),
        task({
          id: "000002",
          state: "WORKING",
          claimed_by: "pi-1",
          claimed_pid: 1,
        }),
        task({ id: "000003", state: "READY_WORK_REVIEW" }),
        task({ id: "000004", state: "BLOCKED", depends_on: ["000001"] }),
      ),
    );

    expect(rows).toEqual([]);
  });

  test("within a rank the task blocking the most goes first", () => {
    const rows = inbox(
      graph(
        task({ id: "000001", state: "READY_MANAGER_REVIEW" }),
        task({ id: "000002", state: "READY_MANAGER_REVIEW" }),
        task({ id: "000003", state: "BLOCKED", depends_on: ["000002"] }),
      ),
    );

    expect(rows.map((row) => row.task_id)).toEqual(["000002", "000001"]);
    expect(rows[0]!.blocking).toBe(1);
  });

  test("a held row carries the reason the manager has to answer", () => {
    const rows = inbox(
      graph(
        task({
          id: "000001",
          state: "HELD_WORK",
          held_reason: "the staging database is down",
          state_entered: "2026-07-29T01:00:00Z",
        }),
      ),
    );

    expect(rows[0]!.held_reason).toBe("the staging database is down");
    expect(rows[0]!.waiting_since).toBe("2026-07-29T01:00:00Z");
  });

  test("a row carries the branch to look at, not the worktree it was built in", () => {
    const rows = inbox(
      graph(
        task({
          id: "000001",
          state: "READY_MANAGER_REVIEW",
          workspace: {
            branch: "work/000001",
            worktree: "/tmp/orchestrator/000001/worktree",
            agent: "pi-1",
            session: null,
          },
        }),
      ),
    );

    expect(rows[0]!.branch).toBe("work/000001");
    expect(rows[0]).not.toHaveProperty("worktree");
  });
});

describe("the check runner", () => {
  test("an exit code, a log and an output tail come back", async () => {
    const dir = tempDir("orchestrator-");
    const runner = new CheckRunner();
    const log = path.join(dir, "check-0.log");

    const result = await runner.start(
      "000042",
      0,
      "echo hello; echo bad >&2; exit 2",
      dir,
      log,
    );

    expect(result.code).toBe(2);
    expect(result.tail).toContain("hello");
    expect(result.tail).toContain("bad");
    expect(fs.readFileSync(log, "utf-8")).toContain("hello");
  });

  test("a running check appears in the view and leaves it when it ends", async () => {
    const dir = tempDir("orchestrator-");
    const runner = new CheckRunner();
    const running = runner.start(
      "000042",
      1,
      "sleep 0.2",
      dir,
      path.join(dir, "c.log"),
    );

    expect(runner.view).toHaveLength(1);
    expect(runner.view[0]!.command).toBe("sleep 0.2");
    expect(runner.view[0]!.pid).toBeGreaterThan(0);
    expect(runner.isRunning("000042")).toBe(true);

    await running;
    expect(runner.view).toEqual([]);
  });

  test("the tail keeps the last lines, not the first", () => {
    const output = Array.from({ length: 100 }, (_, i) => `line ${i}`).join(
      "\n",
    );
    const tail = tailOf(output, 3);
    expect(tail).toBe("line 97\nline 98\nline 99");
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

describe("the sandbox an agent runs in", () => {
  const policy = {
    cwd: "/tmp/task-graph-server/-repo/000042/worktree",
    writable: ["/tmp/task-graph-server/-repo/000042"],
    readable: ["/repo"],
    overlay: ["/home/model/.pi"],
    oomScoreAdjust: AGENT_OOM_SCORE_ADJUST,
  };

  function at(args: string[], flag: string): number {
    return args.indexOf(flag);
  }

  test("the whole filesystem is bound read-only before anything is opened up", () => {
    const args = sandboxArgs(policy);

    expect(args.slice(0, 3)).toEqual(["--ro-bind", "/", "/"]);
    expect(at(args, "--tmpfs")).toBeLessThan(at(args, "--bind"));
    expect(args.at(-1)).toBe("--");
  });

  test("the repo is re-exposed read-only, since a repo can sit under /tmp", () => {
    const args = sandboxArgs(policy);
    const repo = args.indexOf("/repo");

    expect(args[repo - 1]).toBe("--ro-bind");
    expect(at(args, "--tmpfs")).toBeLessThan(repo);
  });

  test("the writable binds come last, so a writable path inside a read-only one wins", () => {
    const args = sandboxArgs({
      ...policy,
      readable: ["/tmp/task-graph-server"],
    });

    expect(at(args, "--ro-bind")).toBeLessThan(at(args, "--bind"));
    expect(args[at(args, "--bind") + 1]).toBe(policy.writable[0]);
  });

  test("pi's home is a throwaway overlay, so its lock files never land on disk", () => {
    const args = sandboxArgs(policy);

    expect(
      args.slice(at(args, "--overlay-src"), at(args, "--overlay-src") + 4),
    ).toEqual([
      "--overlay-src",
      "/home/model/.pi",
      "--tmp-overlay",
      "/home/model/.pi",
    ]);
  });

  test("the namespaces shared with the host are the network and nothing else", () => {
    const args = sandboxArgs(policy);

    expect(args).toContain("--unshare-user");
    expect(args).toContain("--unshare-pid");
    expect(args).toContain("--unshare-ipc");
    expect(args).toContain("--unshare-uts");
    expect(args).toContain("--new-session");
    expect(args).not.toContain("--unshare-net");
    expect(args).not.toContain("--unshare-all");
  });

  test("an editor never opens, so a bare git commit cannot wedge the agent", () => {
    const args = sandboxArgs(policy);

    for (const name of ["GIT_EDITOR", "EDITOR", "VISUAL"]) {
      const at = args.indexOf(name);
      expect(args[at - 1]).toBe("--setenv");
      expect(args[at + 1]).toBe("true");
    }
    expect(args.indexOf("GIT_EDITOR")).toBeLessThan(args.indexOf("--chdir"));
  });

  test("git commit with no message under that editor fails instead of blocking", () => {
    const repo = tempDir("sandbox-editor-");
    git.gitOrThrow(repo, ["init"]);
    fs.writeFileSync(path.join(repo, "a.txt"), "a", "utf-8");
    git.gitOrThrow(repo, ["add", "a.txt"]);

    const result = Bun.spawnSync({
      cmd: ["git", "commit"],
      cwd: repo,
      env: { ...process.env, ...NON_INTERACTIVE_ENV },
      stdout: "pipe",
      stderr: "pipe",
    });

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.toString()).toContain("empty commit message");
  });

  test("the agent outlives the manager, so the sandbox is not tied to its parent", () => {
    expect(sandboxArgs(policy)).not.toContain("--die-with-parent");
  });

  test("the command runs in its workspace", () => {
    const args = sandboxArgs(policy);

    expect(args[at(args, "--chdir") + 1]).toBe(policy.cwd);
  });

  test("a write path that does not exist is skipped, since bwrap cannot overlay it", () => {
    expect(overlays([path.join(tempDir("sandbox-missing-"), "nope")])).toEqual(
      [],
    );
  });

  test("a write path is expanded from ~ and deduplicated", () => {
    expect(expandHome("~")).toBe(os.homedir());
    expect(expandHome("~/.cache")).toBe(path.join(os.homedir(), ".cache"));
    expect(expandHome("/abs/path")).toBe("/abs/path");

    const dir = tempDir("sandbox-write-");
    expect(overlays([dir, dir])).toEqual([dir]);
  });

  test("the sandbox command is what is actually spawned", () => {
    expect(sandbox(policy, SANDBOX_COMMAND, false)[0]).toBe(SANDBOX_COMMAND);
    expect(sandbox(policy, "/usr/bin/bwrap", false)[0]).toBe("/usr/bin/bwrap");
  });

  test("a limited sandbox puts the cgroup scope outermost, then the oom score, then bwrap", () => {
    const args = sandbox(policy, SANDBOX_COMMAND, true);

    expect(args[0]).toBe(LIMIT_COMMAND);
    expect(at(args, OOM_COMMAND)).toBeGreaterThan(at(args, LIMIT_COMMAND));
    expect(at(args, SANDBOX_COMMAND)).toBeGreaterThan(at(args, OOM_COMMAND));
  });

  test("a runaway sandbox is capped on memory, swap and process count", () => {
    const args = limitArgs(policy);

    expect(args).toContain(`MemoryMax=${MEMORY_MAX}`);
    expect(args).toContain("MemorySwapMax=0");
    expect(args).toContain(`TasksMax=${TASKS_MAX}`);
  });

  test("a dead scope is collected, so a crashed agent leaves no unit behind", () => {
    expect(limitArgs(policy)).toContain("--collect");
  });

  test("checks are killed before agents, and both before anything of the user's", () => {
    expect(CHECK_OOM_SCORE_ADJUST).toBeGreaterThan(AGENT_OOM_SCORE_ADJUST);
    expect(AGENT_OOM_SCORE_ADJUST).toBeGreaterThan(0);
  });

  test("the oom score adjustment comes from the policy, not a constant", () => {
    const args = limitArgs({ ...policy, oomScoreAdjust: 400 });

    expect(args[at(args, OOM_COMMAND) + 2]).toBe("400");
  });

  test("without cgroup limits the sandbox degrades to bare bwrap", () => {
    expect(sandbox(policy, SANDBOX_COMMAND, false)).not.toContain(
      LIMIT_COMMAND,
    );
    expect(sandbox(policy, SANDBOX_COMMAND, false)).not.toContain(OOM_COMMAND);
  });
});

describe("the sandbox, actually spawned", () => {
  function run(policy: Parameters<typeof sandbox>[0], script: string) {
    const proc = Bun.spawnSync([...sandbox(policy), "bash", "-c", script]);
    return `${proc.stdout.toString()}${proc.stderr.toString()}`;
  }

  test("a runaway check is capped by a real cgroup, not just by the flags we passed", () => {
    const workspace = tempDir("sandbox-limits-");
    const output = run(
      {
        cwd: workspace,
        writable: [workspace],
        readable: [],
        overlay: [],
        oomScoreAdjust: CHECK_OOM_SCORE_ADJUST,
      },
      "cg=$(cut -d: -f3 /proc/self/cgroup); cat /sys/fs/cgroup$cg/memory.max /sys/fs/cgroup$cg/memory.swap.max /sys/fs/cgroup$cg/pids.max /proc/self/oom_score_adj",
    );

    expect(output.split("\n").slice(0, 4)).toEqual([
      String(8 * 1024 * 1024 * 1024),
      "0",
      TASKS_MAX,
      String(CHECK_OOM_SCORE_ADJUST),
    ]);
  });

  test("the repo is readable but every write to it is refused", () => {
    const repo = tempRepo();
    const workspace = tempDir("sandbox-work-");
    const policy = {
      cwd: workspace,
      writable: [workspace],
      readable: [repo],
      overlay: [],
      oomScoreAdjust: CHECK_OOM_SCORE_ADJUST,
    };

    expect(run(policy, `cat ${repo}/a.txt`)).toContain("one");
    expect(run(policy, `echo x > ${repo}/poke`)).toContain(
      "Read-only file system",
    );
    expect(fs.existsSync(path.join(repo, "poke"))).toBe(false);
  });

  test("the workspace is writable and /usr/local comes along read-only", () => {
    const workspace = tempDir("sandbox-work-");
    const policy = {
      cwd: workspace,
      writable: [workspace],
      readable: [],
      overlay: [],
      oomScoreAdjust: CHECK_OOM_SCORE_ADJUST,
    };

    expect(
      run(policy, `echo ok > ${workspace}/f && cat ${workspace}/f`),
    ).toContain("ok");
    expect(run(policy, "test -d /usr/local && echo readable")).toContain(
      "readable",
    );
  });

  test("a toolchain writes to its cache home, and the write dies with the sandbox", () => {
    const workspace = tempDir("sandbox-work-");
    const policy = {
      cwd: workspace,
      writable: [workspace],
      readable: [],
      overlay: overlays(DEFAULT_WRITE),
      oomScoreAdjust: CHECK_OOM_SCORE_ADJUST,
    };
    const probe = path.join(CACHE_HOME, "sandbox-cache-probe");

    expect(run(policy, `echo ok > ${probe} && cat ${probe}`)).toContain("ok");
    expect(fs.existsSync(probe)).toBe(false);
  });

  test("an agent commits in its workspace while the repo it came from is read-only", () => {
    const repo = tempRepo();
    const workspace = path.join(tempDir("sandbox-root-"), "worktree");
    git.addWorkspace(repo, "work/000042", workspace, "master");

    const policy = {
      cwd: workspace,
      writable: [workspace],
      readable: [repo],
      overlay: [],
      oomScoreAdjust: CHECK_OOM_SCORE_ADJUST,
    };
    const output = run(
      policy,
      "echo two >> a.txt && git add -A && git commit -qm 'from the sandbox' && git log --oneline -1",
    );

    expect(output).toContain("from the sandbox");
    expect(git.branchExists(repo, "work/000042")).toBe(false);
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
    expect(git.range(second, "master")).toBe(
      [
        git.gitOrThrow(repo, ["rev-parse", "master"]).trim(),
        git.gitOrThrow(second, ["rev-parse", "HEAD"]).trim(),
      ].join(".."),
    );
  });

  test("the commit range is the fork point, even after the base moves on", () => {
    const repo = tempRepo();
    const workspace = path.join(tempDir("clone-"), "worktree");
    git.addWorkspace(repo, "work/000001", workspace, "master");
    const forkPoint = git.gitOrThrow(workspace, ["rev-parse", "HEAD"]).trim();
    commitIn(workspace, "b.txt", "work\n");
    commitIn(repo, "c.txt", "moved on\n");
    git.syncBase(workspace, "master");

    expect(git.range(workspace, "master")).toBe(
      `${forkPoint}..${git.gitOrThrow(workspace, ["rev-parse", "HEAD"]).trim()}`,
    );
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
