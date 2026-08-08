import { describe, expect } from "bun:test";
import { tempDir, testInTempDirs } from "../testing/temp-dirs.ts";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { agentOf } from "../domain/agents.ts";
import { parsePool } from "./agent-pool.ts";
import { agentWrite, checkWrite, loadAgents } from "./agent-pool.ts";
import { SchemaError } from "../domain/schema.ts";
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
import { ORCHESTRATOR_DIR } from "../testing/graph-jig.ts";
import { tempRepo } from "../testing/orchestrator-jig.ts";

function issuesOf(pool: unknown): string[] {
  try {
    parsePool(pool);
    return [];
  } catch (err) {
    return (err as SchemaError).issues;
  }
}

describe("Feature: loading the pool of agents", () => {
  testInTempDirs(
    "a slot is named for its type, provider, model and number",
    () => {
      // Given a pool of two agents, one of them with three slots
      const pool = {
        agents: [
          {
            type: "pi",
            provider: "anthropic",
            model: "claude-sonnet-4-5",
            slots: 3,
          },
          { type: "pi", provider: "llama.cpp-rocm", model: "rocm", slots: 1 },
        ],
      };

      // When the pool is loaded
      const slots = parsePool(pool);

      // Then every slot has a name a person can read off the console
      expect(slots.map((slot) => slot.name)).toEqual([
        "pi-anthropic-claude-sonnet-4-5-1",
        "pi-anthropic-claude-sonnet-4-5-2",
        "pi-anthropic-claude-sonnet-4-5-3",
        "pi-llama.cpp-rocm-rocm-1",
      ]);
    },
  );

  testInTempDirs(
    "every slot of one entry shares that entry's agent key",
    () => {
      // Given a pool with two slots of one agent and one of another
      const pool = {
        agents: [
          { type: "pi", provider: "anthropic", model: "m", slots: 2 },
          { type: "pi", provider: "openai", model: "m", slots: 1 },
        ],
      };

      // When the pool is loaded
      const slots = parsePool(pool);

      // Then the slots of one entry share a key, which is their name without its number
      expect(slots.map((slot) => slot.agent)).toEqual([
        "pi-anthropic-m",
        "pi-anthropic-m",
        "pi-openai-m",
      ]);
      expect(slots.map((slot) => agentOf(slot.name))).toEqual(
        slots.map((slot) => slot.agent),
      );
    },
  );

  testInTempDirs(
    "a slot of a model whose name carries dashes belongs to that model's agent",
    () => {
      // Given the second slot of the model claude-sonnet-4-5, whose name carries dashes of its own
      const slot = "pi-anthropic-claude-sonnet-4-5-2";

      // When it is reduced to the agent it belongs to
      const reduced = agentOf(slot);

      // Then only the trailing slot number is dropped
      expect(reduced).toBe("pi-anthropic-claude-sonnet-4-5");
    },
  );

  testInTempDirs(
    "a slot of a provider whose name carries a dot belongs to that provider's agent",
    () => {
      // Given the first slot of the provider llama.cpp-rocm, whose name carries a dot
      const slot = "pi-llama.cpp-rocm-rocm-1";

      // When it is reduced to the agent it belongs to
      const reduced = agentOf(slot);

      // Then only the trailing slot number is dropped
      expect(reduced).toBe("pi-llama.cpp-rocm-rocm");
    },
  );

  testInTempDirs("an agent is enabled unless the pool says otherwise", () => {
    // Given a pool with one agent left as the file found it
    // Given the other agent in that pool turned off
    const pool = {
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
    };

    // When the pool is loaded
    const slots = parsePool(pool);

    // Then only that agent's slots start disabled
    expect(slots.map((slot) => slot.enabled)).toEqual([true, true, false]);
  });

  testInTempDirs(
    "a slot may take every role unless the pool restricts it",
    () => {
      // Given a pool with one agent that names no roles
      // Given the other agent in that pool restricted to reviewing
      const pool = {
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
      };

      // When the pool is loaded
      const slots = parsePool(pool);

      // Then the first may work, review, plan and design, and the second may only review
      expect(slots[0]!.roles).toEqual([
        "worker",
        "reviewer",
        "planner",
        "designer",
      ]);
      expect(slots[1]!.roles).toEqual(["reviewer"]);
    },
  );

  testInTempDirs("a role the pipeline does not have is refused on load", () => {
    // Given a pool naming a role no stage is run by
    const pool = {
      agents: [
        {
          type: "pi",
          provider: "anthropic",
          model: "m",
          slots: 1,
          roles: ["agent_checker"],
        },
      ],
    };

    // When the pool is loaded
    const attempt = () => parsePool(pool);

    // Then it is refused at startup rather than at the first dispatch
    expect(attempt).toThrow(/Invalid option/);
  });

  testInTempDirs("a pool entry asking for retries is refused on load", () => {
    // Given a pool entry asking for 3 retries, a setting the server does not read
    const pool = {
      agents: [
        {
          type: "pi",
          provider: "anthropic",
          model: "m",
          slots: 1,
          retries: 3,
        },
      ],
    };

    // When the pool is loaded
    const attempt = () => parsePool(pool);

    // Then it is refused by name, so a setting that would do nothing is never believed
    expect(attempt).toThrow('Unrecognized key: "retries"');
  });

  testInTempDirs("a pool entry asking for thinking is refused on load", () => {
    // Given a pool entry asking for high thinking, a setting the server does not read
    const pool = {
      agents: [
        {
          type: "pi",
          provider: "anthropic",
          model: "m",
          slots: 1,
          thinking: "high",
        },
      ],
    };

    // When the pool is loaded
    const attempt = () => parsePool(pool);

    // Then it is refused by name, so a setting that would do nothing is never believed
    expect(attempt).toThrow('Unrecognized key: "thinking"');
  });

  testInTempDirs(
    "a slot is a type, provider, model and number, and nothing more",
    () => {
      // Given a pool with one plain agent in it
      const pool = {
        agents: [{ type: "pi", provider: "anthropic", model: "m", slots: 1 }],
      };

      // When the pool is loaded
      const slot = parsePool(pool)[0];

      // Then the slot carries its name, its agent key, the type, provider and model
      // Then the slot carries its number, whether it is enabled, its write paths and its roles
      expect(slot).toEqual({
        name: "pi-anthropic-m-1",
        agent: "pi-anthropic-m",
        type: "pi",
        provider: "anthropic",
        model: "m",
        index: 1,
        enabled: true,
        write: DEFAULT_WRITE,
        roles: ["worker", "reviewer", "planner", "designer"],
      });
    },
  );

  testInTempDirs(
    "an agent writes to the toolchain cache unless told otherwise",
    () => {
      // Given a pool that declares no write paths at all
      const pool = {
        agents: [{ type: "pi", provider: "anthropic", model: "m" }],
      };

      // When the pool is loaded
      const slots = parsePool(pool);

      // Then the write path defaults to the zig cache, which is the cache home
      expect(slots[0]!.write).toEqual([ZIG_WRITE]);
      expect(DEFAULT_WRITE).toEqual([ZIG_WRITE]);
      expect(ZIG_WRITE).toBe(CACHE_HOME);
    },
  );

  testInTempDirs(
    "declared write paths replace the default rather than adding to it",
    () => {
      // Given a pool declaring the two caches its toolchains need
      const pool = {
        agents: [
          {
            type: "pi",
            provider: "anthropic",
            model: "m",
            write: ["~/.cache", "~/.cargo"],
          },
        ],
      };

      // When the pool is loaded
      const slots = parsePool(pool);

      // Then those are the only paths outside its worktree the agent may write
      expect(slots[0]!.write).toEqual(["~/.cache", "~/.cargo"]);
    },
  );

  testInTempDirs(
    "a pool declaring no write paths grants nothing but pi's home",
    () => {
      // Given a pool that declares an empty list of write paths
      const pool = {
        agents: [{ type: "pi", provider: "anthropic", model: "m", write: [] }],
      };

      // When the paths that agent may write are worked out
      const writable = agentWrite(parsePool(pool)[0]!);

      // Then only pi's own home comes along, because pi cannot run without it
      expect(writable).toEqual([PI_HOME]);
    },
  );

  testInTempDirs("a pi agent always gets its own home, declared or not", () => {
    // Given a pi agent declaring one path of its own
    const home = tempDir("pi-home-");
    const slot = parsePool({
      agents: [
        { type: "pi", provider: "anthropic", model: "m", write: [home] },
      ],
    })[0]!;

    // When the paths it may write are worked out
    const writable = agentWrite(slot);

    // Then pi's home comes on top of what it declared, because pi cannot run without it
    expect(writable).toEqual([home, PI_HOME]);
  });

  testInTempDirs("an agent of another type gets only what it declared", () => {
    // Given an agent that is not pi, declaring one path of its own
    const home = tempDir("pi-home-");
    const slot = parsePool({
      agents: [
        { type: "other", provider: "anthropic", model: "m", write: [home] },
      ],
    })[0]!;

    // When the paths it may write are worked out
    const writable = agentWrite(slot);

    // Then it is given that path and nothing besides
    expect(writable).toEqual([home]);
  });

  testInTempDirs(
    "a check may write everything any agent in the pool declared",
    () => {
      // Given a pool of two agents declaring overlapping write paths
      const one = tempDir("check-write-");
      const two = tempDir("check-write-");
      const slots = parsePool({
        agents: [
          { type: "pi", provider: "anthropic", model: "m", write: [one] },
          { type: "pi", provider: "openai", model: "m", write: [one, two] },
        ],
      });

      // When the paths a check may write are worked out
      const writable = checkWrite(slots);

      // Then every declared path is there once, and no agent's home is
      expect(writable).toEqual([one, two]);
    },
  );

  testInTempDirs(
    "everything wrong with a pool file is reported at once",
    () => {
      // Given a pool with a bad slot count in one entry and no type in another
      const pool = {
        agents: [
          { type: "pi", provider: "anthropic", model: "m", slots: 0 },
          { provider: "anthropic", model: "n", slots: 1 },
        ],
      };

      // When the pool is loaded
      const issues = issuesOf(pool);

      // Then both are named by their place in the file, so one edit fixes it
      expect(issues).toHaveLength(2);
      expect(issues[0]).toContain("agents[0].slots");
      expect(issues[1]).toContain("agents[1].type");
    },
  );

  testInTempDirs("the same model declared twice is refused", () => {
    // Given a pool naming one model in two entries
    const pool = {
      agents: [
        { type: "pi", provider: "anthropic", model: "m", slots: 1 },
        { type: "pi", provider: "anthropic", model: "m", slots: 2 },
      ],
    };

    // When the pool is loaded
    const attempt = () => parsePool(pool);

    // Then it is refused, because the two entries would share every slot name
    expect(attempt).toThrow(
      /agents\[1\]: repeats type\+provider\+model "pi\/anthropic\/m"/,
    );
  });

  testInTempDirs("a pool with no agents at all loads as no slots", () => {
    // Given a pool file with an empty list of agents
    const pool = { agents: [] };

    // When the pool is loaded
    const slots = parsePool(pool);

    // Then it holds no slots, so the manager can still author tasks with it
    expect(slots).toEqual([]);
  });

  testInTempDirs("the pool a project is seeded with ships turned off", () => {
    // Given the pool file a new project starts from
    const filePath = path.join(ORCHESTRATOR_DIR, "..", "tasks", "agents.json");

    // When the pool file is loaded
    const slots = loadAgents(filePath);

    // Then it has slots in it, and none of them will run until a person says so
    expect(slots.length).toBeGreaterThan(0);
    expect(slots.every((slot) => !slot.enabled)).toBe(true);
  });
});

describe("Feature: the sandbox an agent is spawned into", () => {
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

  testInTempDirs(
    "the whole filesystem is read-only before anything is opened",
    () => {
      // Given the policy an agent is sandboxed under
      const under = policy;

      // When the sandbox is built
      const args = sandboxArgs(under);

      // Then it starts by binding everything read-only, and ends at the command
      expect(args.slice(0, 3)).toEqual(["--ro-bind", "/", "/"]);
      expect(at(args, "--tmpfs")).toBeLessThan(at(args, "--bind"));
      expect(args.at(-1)).toBe("--");
    },
  );

  testInTempDirs(
    "the repo is re-exposed after the temporary directory is masked",
    () => {
      // Given a policy whose repo could sit anywhere, including under the mask
      const under = policy;

      // When the sandbox is built
      const args = sandboxArgs(under);

      // Then the repo is bound read-only again after the mask, so it survives
      const repo = args.indexOf("/repo");
      expect(args[repo - 1]).toBe("--ro-bind");
      expect(at(args, "--tmpfs")).toBeLessThan(repo);
    },
  );

  testInTempDirs("a writable path inside a read-only one still wins", () => {
    // Given a policy whose worktree sits inside a read-only directory
    const under = { ...policy, readable: ["/tmp/task-graph-server"] };

    // When the sandbox is built
    const args = sandboxArgs(under);

    // Then the writable bind comes last, so it is the one that takes effect
    expect(at(args, "--ro-bind")).toBeLessThan(at(args, "--bind"));
    expect(args[at(args, "--bind") + 1]).toBe(policy.writable[0]);
  });

  testInTempDirs(
    "pi's home is a throwaway overlay, so its locks never persist",
    () => {
      // Given a policy that overlays pi's home
      const under = policy;

      // When the sandbox is built
      const args = sandboxArgs(under);

      // Then the home is mounted as a temporary overlay over the real one
      expect(
        args.slice(at(args, "--overlay-src"), at(args, "--overlay-src") + 4),
      ).toEqual([
        "--overlay-src",
        "/home/model/.pi",
        "--tmp-overlay",
        "/home/model/.pi",
      ]);
    },
  );

  testInTempDirs(
    "the only namespace shared with the host is the network",
    () => {
      // Given the policy an agent is sandboxed under
      const under = policy;

      // When the sandbox is built
      const args = sandboxArgs(under);

      // Then everything but the network is unshared, because the model is remote
      expect(args).toContain("--unshare-user");
      expect(args).toContain("--unshare-pid");
      expect(args).toContain("--unshare-ipc");
      expect(args).toContain("--unshare-uts");
      expect(args).toContain("--new-session");
      expect(args).not.toContain("--unshare-net");
      expect(args).not.toContain("--unshare-all");
    },
  );

  testInTempDirs("no editor can open inside the sandbox", () => {
    // Given the policy an agent is sandboxed under
    const under = policy;

    // When the sandbox is built
    const args = sandboxArgs(under);

    // Then every editor variable is set to something that exits at once
    for (const name of ["GIT_EDITOR", "EDITOR", "VISUAL"]) {
      const where = args.indexOf(name);
      expect(args[where - 1]).toBe("--setenv");
      expect(args[where + 1]).toBe("true");
    }
    expect(args.indexOf("GIT_EDITOR")).toBeLessThan(args.indexOf("--chdir"));
  });

  testInTempDirs(
    "a commit with no message fails rather than waiting forever",
    () => {
      // Given a repository with something staged, and the sandbox's environment
      const repo = tempDir("sandbox-editor-");
      git.gitOrThrow(repo, ["init"]);
      fs.writeFileSync(path.join(repo, "a.txt"), "a", "utf-8");
      git.gitOrThrow(repo, ["add", "a.txt"]);

      // When a bare git commit is run under it
      const result = Bun.spawnSync({
        cmd: ["git", "commit"],
        cwd: repo,
        env: { ...process.env, ...NON_INTERACTIVE_ENV },
        stdout: "pipe",
        stderr: "pipe",
      });

      // Then it fails at once instead of blocking on an editor that never opens
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr.toString()).toContain("empty commit message");
    },
  );

  testInTempDirs("an agent is not killed when the manager exits", () => {
    // Given the policy an agent is sandboxed under
    const under = policy;

    // When the sandbox is built
    const args = sandboxArgs(under);

    // Then it is not tied to its parent, because agents outlive the manager
    expect(args).not.toContain("--die-with-parent");
  });

  testInTempDirs("the command starts in the workspace it was given", () => {
    // Given a policy naming the worktree the agent works in
    const under = policy;

    // When the sandbox is built
    const args = sandboxArgs(under);

    // Then the command is run from that directory
    expect(args[at(args, "--chdir") + 1]).toBe(policy.cwd);
  });

  testInTempDirs("a declared write path that does not exist is skipped", () => {
    // Given a declared path nothing has created yet
    const missing = path.join(tempDir("sandbox-missing-"), "nope");

    // When the overlays are worked out
    const mounted = overlays([missing]);

    // Then it is skipped, because there is nothing there to overlay
    expect(mounted).toEqual([]);
  });

  testInTempDirs(
    "a write path of the home shorthand alone becomes the home directory",
    () => {
      // Given a pool entry declaring the write path as the tilde alone
      const written = "~";

      // When the declared path is expanded
      const expanded = expandHome(written);

      // Then it becomes the real home directory
      expect(expanded).toBe(os.homedir());
    },
  );

  testInTempDirs(
    "a write path under the home shorthand keeps what follows it",
    () => {
      // Given a pool entry declaring the write path as the cache below the tilde
      const written = "~/.cache";

      // When the declared path is expanded
      const expanded = expandHome(written);

      // Then it becomes the cache below the real home directory
      expect(expanded).toBe(path.join(os.homedir(), ".cache"));
    },
  );

  testInTempDirs("a write path written in full is left as it stands", () => {
    // Given a pool entry declaring the absolute write path of a directory
    const written = "/abs/path";

    // When the declared path is expanded
    const expanded = expandHome(written);

    // Then it is untouched, because there is no shorthand in it
    expect(expanded).toBe("/abs/path");
  });

  testInTempDirs("a path declared twice is mounted once", () => {
    // Given the same path declared by two agents in the pool
    const dir = tempDir("sandbox-write-");

    // When the overlays are worked out
    const mounted = overlays([dir, dir]);

    // Then it is mounted once, because bwrap would refuse the second
    expect(mounted).toEqual([dir]);
  });

  testInTempDirs("a limited sandbox wraps the cgroup scope outermost", () => {
    // Given a host that can create cgroup scopes
    const limited = true;

    // When the sandbox is built
    const args = sandbox(policy, SANDBOX_COMMAND, limited);

    // Then the scope capping memory at 8G comes first, then the score of 300, then bwrap
    expect(args[0]).toBe(LIMIT_COMMAND);
    expect(args).toContain(`MemoryMax=${MEMORY_MAX}`);
    expect(args[at(args, OOM_COMMAND) + 2]).toBe(
      String(AGENT_OOM_SCORE_ADJUST),
    );
    expect(at(args, OOM_COMMAND)).toBeGreaterThan(at(args, LIMIT_COMMAND));
    expect(at(args, SANDBOX_COMMAND)).toBeGreaterThan(at(args, OOM_COMMAND));
  });

  testInTempDirs(
    "a runaway sandbox is capped on memory, swap and processes",
    () => {
      // Given the policy an agent is sandboxed under
      const under = policy;

      // When the cgroup limits are worked out
      const args = limitArgs(under);

      // Then all three caps are set, so one agent cannot take the machine down
      expect(args).toContain(`MemoryMax=${MEMORY_MAX}`);
      expect(args).toContain("MemorySwapMax=0");
      expect(args).toContain(`TasksMax=${TASKS_MAX}`);
    },
  );

  testInTempDirs("a crashed agent leaves no cgroup scope behind", () => {
    // Given the policy an agent is sandboxed under
    const under = policy;

    // When the cgroup limits are worked out
    const args = limitArgs(under);

    // Then the scope is collected when it dies, however it dies
    expect(args).toContain("--collect");
  });

  testInTempDirs(
    "checks are killed before agents, and both before the user's work",
    () => {
      // Given the oom score adjustment a check and an agent are run with
      const scores = [CHECK_OOM_SCORE_ADJUST, AGENT_OOM_SCORE_ADJUST];

      // When they are lined up against the zero the user's own processes run at
      const order = [...scores, 0];

      // Then the check is 400, the agent 300 and the user's work 0, so the check dies first
      expect(order).toEqual([400, 300, 0]);
    },
  );

  testInTempDirs(
    "the oom adjustment comes from the policy, not a constant",
    () => {
      // Given a policy asking for its own oom score
      const under = { ...policy, oomScoreAdjust: 400 };

      // When the cgroup limits are worked out
      const args = limitArgs(under);

      // Then choom is told the policy's own 400, not the 300 an agent defaults to
      expect(args[at(args, OOM_COMMAND) + 2]).toBe("400");
      expect(AGENT_OOM_SCORE_ADJUST).toBe(300);
    },
  );

  testInTempDirs("a host with no cgroup support still gets a sandbox", () => {
    // Given a host where creating a cgroup scope failed
    const limited = false;

    // When the sandbox is built
    const args = sandbox(policy, SANDBOX_COMMAND, limited);

    // Then it degrades to bare bwrap rather than refusing to run at all
    expect(args).not.toContain(LIMIT_COMMAND);
    expect(args).not.toContain(OOM_COMMAND);
  });
});

describe("Feature: the sandbox as it actually runs", () => {
  function run(policy: Parameters<typeof sandbox>[0], script: string) {
    const proc = Bun.spawnSync([...sandbox(policy), "bash", "-c", script]);
    return `${proc.stdout.toString()}${proc.stderr.toString()}`;
  }

  testInTempDirs("the caps we ask for are the caps the kernel applies", () => {
    // Given a check sandboxed with the limits a check is given
    const workspace = tempDir("sandbox-limits-");
    const policy = {
      cwd: workspace,
      writable: [workspace],
      readable: [],
      overlay: [],
      oomScoreAdjust: CHECK_OOM_SCORE_ADJUST,
    };

    // When it reads its own cgroup and oom score from inside the sandbox
    const output = run(
      policy,
      "cg=$(cut -d: -f3 /proc/self/cgroup); cat /sys/fs/cgroup$cg/memory.max /sys/fs/cgroup$cg/memory.swap.max /sys/fs/cgroup$cg/pids.max /proc/self/oom_score_adj",
    );

    // Then it is capped at 8G of memory with no swap, at 512 tasks, and at the score 400
    expect(output.split("\n").slice(0, 4)).toEqual([
      String(8 * 1024 * 1024 * 1024),
      "0",
      TASKS_MAX,
      String(CHECK_OOM_SCORE_ADJUST),
    ]);
  });

  testInTempDirs("the repository can be read but never written", () => {
    // Given a sandbox with the repository bound readable
    const repo = tempRepo();
    const workspace = tempDir("sandbox-work-");
    const policy = {
      cwd: workspace,
      writable: [workspace],
      readable: [repo],
      overlay: [],
      oomScoreAdjust: CHECK_OOM_SCORE_ADJUST,
    };

    // When a command reads from the repository and then writes to it
    const output = [
      run(policy, `cat ${repo}/a.txt`),
      run(policy, `echo x > ${repo}/poke`),
    ];

    // Then the read succeeds, the write is refused, and nothing lands on disk
    expect(output[0]).toContain("one");
    expect(output[1]).toContain("Read-only file system");
    expect(fs.existsSync(path.join(repo, "poke"))).toBe(false);
  });

  testInTempDirs(
    "the workspace is writable and the toolchain is readable",
    () => {
      // Given a sandbox with only its own workspace writable
      const workspace = tempDir("sandbox-work-");
      const policy = {
        cwd: workspace,
        writable: [workspace],
        readable: [],
        overlay: [],
        oomScoreAdjust: CHECK_OOM_SCORE_ADJUST,
      };

      // When a command writes in the workspace and reads the installed toolchain
      const output = [
        run(policy, `echo ok > ${workspace}/f && cat ${workspace}/f`),
        run(policy, "test -d /usr/local && echo readable"),
      ];

      // Then the file written in the workspace reads back, and the toolchain under /usr/local is there to read
      expect(output[0]).toContain("ok");
      expect(output[1]).toContain("readable");
    },
  );

  testInTempDirs(
    "a toolchain's cache is writable and dies with the sandbox",
    () => {
      // Given a sandbox with the toolchain cache overlaid
      const workspace = tempDir("sandbox-work-");
      const policy = {
        cwd: workspace,
        writable: [workspace],
        readable: [],
        overlay: overlays(DEFAULT_WRITE),
        oomScoreAdjust: CHECK_OOM_SCORE_ADJUST,
      };
      const probe = path.join(CACHE_HOME, "sandbox-cache-probe");

      // When a command writes into the cache
      const output = run(policy, `echo ok > ${probe} && cat ${probe}`);

      // Then it succeeds inside, and leaves nothing on the real cache afterwards
      expect(output).toContain("ok");
      expect(fs.existsSync(probe)).toBe(false);
    },
  );

  testInTempDirs(
    "an agent commits in its worktree without touching the repo",
    () => {
      // Given a worktree cloned from a repository the sandbox may only read
      const repo = tempRepo();
      const workspace = path.join(tempDir("sandbox-root-"), "worktree");
      git.createWorkspace(repo, "work/000042", workspace, "master");
      const policy = {
        cwd: workspace,
        writable: [workspace],
        readable: [repo],
        overlay: [],
        oomScoreAdjust: CHECK_OOM_SCORE_ADJUST,
      };

      // When a command commits inside the worktree
      const output = run(
        policy,
        "echo two >> a.txt && git add -A && git commit -qm 'from the sandbox' && git log --oneline -1",
      );

      // Then the commit lands in the worktree, and the repo has no branch for it yet
      expect(output).toContain("from the sandbox");
      expect(git.branchExists(repo, "work/000042")).toBe(false);
    },
  );
});
