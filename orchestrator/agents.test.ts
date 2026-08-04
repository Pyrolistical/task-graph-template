import { describe, expect } from "bun:test";
import { tempDir, test } from "./temp.ts";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  agentModelKey,
  agentWrite,
  checkWrite,
  loadAgents,
  parseAgents,
} from "./agents.ts";
import { SchemaError } from "./schema.ts";
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
import { ORCHESTRATOR_DIR, tempRepo } from "./orchestrator-jig.ts";

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

    expect(slots[0]!.roles).toEqual([
      "worker",
      "reviewer",
      "planner",
      "designer",
    ]);
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
      roles: ["worker", "reviewer", "planner", "designer"],
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

  test("the seeded pool loads and ships disabled", () => {
    const slots = loadAgents(
      path.join(ORCHESTRATOR_DIR, "..", "tasks", "agents.json"),
    );
    expect(slots.length).toBeGreaterThan(0);
    expect(slots.every((slot) => !slot.enabled)).toBe(true);
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
