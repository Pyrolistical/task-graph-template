import fs from "node:fs";
import path from "node:path";
import type {
  Agents,
  Checks,
  Console as CommandChannel,
  Publisher,
  Workspaces,
} from "../app/ports.ts";
import { Dispatch } from "../app/dispatch.ts";
import { Land } from "../app/land.ts";
import { Pool } from "../app/pool.ts";
import { Recover } from "../app/recover.ts";
import { RunChecks } from "../app/run-checks.ts";
import { Server, type ServerConfig } from "../app/server.ts";
import { SettleAgent } from "../app/settle-agent.ts";
import { TaskGraph } from "../app/task-graph.ts";
import { branchName } from "../domain/workspace.ts";
import { STAGE_OF } from "../domain/state-machine.ts";
import { agentWrite, checkWrite, loadAgents } from "../adapters/agent-pool.ts";
import { CheckRunner } from "../adapters/check-runner.ts";
import { takeCommand, watchCommands } from "../adapters/command.ts";
import * as git from "../adapters/git.ts";
import { PiProcess } from "../adapters/pi-process.ts";
import { Prompts } from "../adapters/prompts.ts";
import {
  Runtime,
  defaultAgentsPath,
  defaultTasksDir,
  snapshot,
  writeAtomic,
} from "../adapters/runtime.ts";
import {
  AGENT_OOM_SCORE_ADJUST,
  CHECK_OOM_SCORE_ADJUST,
  LIMIT_COMMAND,
  SANDBOX_COMMAND,
  hasLimits,
  overlays,
  sandbox,
} from "../adapters/sandbox.ts";
import { isProcessAlive } from "../adapters/task-store.ts";
import { TaskDocuments } from "../adapters/task-documents.ts";
import { TaskFiles } from "../adapters/task-files.ts";
import { TransitionLog } from "../adapters/transition-log.ts";
import type { AgentRow } from "../domain/agents.ts";

const ORCHESTRATOR_DIR = path.join(import.meta.dir, "..");

export interface WiringOptions {
  repo: string;
  agentsPath?: string;
  tasksDir?: string;
  orchestratorDir?: string;
  overridesDir?: string;
  serverRoot?: string;
  piCommand?: string;
  sandboxCommand?: string;
  base?: string;
}

export function wire(options: WiringOptions): Server {
  const repo = path.resolve(options.repo);
  if (!git.isRepo(repo)) {
    throw new Error(`${repo} is not a git repository`);
  }

  const tasksDir = options.tasksDir ?? defaultTasksDir(repo);
  if (options.tasksDir === undefined) {
    fs.cpSync(path.join(ORCHESTRATOR_DIR, "..", "tasks"), tasksDir, {
      recursive: true,
      force: false,
    });
  }

  const orchestratorDir = options.orchestratorDir ?? ORCHESTRATOR_DIR;
  const overridesDir = options.overridesDir ?? tasksDir;
  const config: ServerConfig = {
    repo,
    tasksDir,
    agentsPath: options.agentsPath ?? defaultAgentsPath(tasksDir),
    base: options.base ?? git.defaultBranch(repo),
    promptDirs: {
      orchestrator: path.join(orchestratorDir, "prompts"),
      overrides: path.join(overridesDir, "prompts"),
    },
  };

  const runtime = new Runtime(repo, options.serverRoot);
  const piCommand = options.piCommand ?? "pi";
  const sandboxCommand = options.sandboxCommand ?? SANDBOX_COMMAND;
  const slots = loadAgents(config.agentsPath);

  if (!hasLimits()) {
    console.warn(
      `no cgroup limits available: ${LIMIT_COMMAND} --user --scope failed, sandboxes run without MemoryMax/TasksMax`,
    );
  }

  const checks = new CheckRunner();

  const tasks = new TaskDocuments(tasksDir, orchestratorDir);

  const workspaces: Workspaces = {
    create: (branch, worktree, base) =>
      git.addWorkspace(repo, branch, worktree, base),
    remove: (worktree) => git.removeWorkspace(worktree),
    exists: (worktree) => fs.existsSync(worktree),
    branchExists: (branch) => git.branchExists(repo, branch),
    deleteBranch: (branch) => git.deleteBranch(repo, branch),
    head: (worktree) => git.head(worktree),
    resetTo: (worktree, commit) => git.resetTo(worktree, commit),
    status: (worktree, base) => ({
      dirty: git.uncommitted(worktree),
      commits: git.commitCount(worktree, base),
    }),
    harvest: (worktree, branch) => git.harvest(repo, worktree, branch),
    syncBase: (worktree, base) => git.syncBase(worktree, base),
    rebase: (worktree, base) => git.rebase(worktree, base),
    abortRebase: (worktree) => git.abortRebase(worktree),
    fastForward: (branch) => git.mergeFastForward(repo, branch),
    isAncestor: (ref, of) => git.isAncestor(repo, ref, of),
  };

  const agents: Agents = {
    slots: () => slots,
    hasSession: (at) => fs.existsSync(at),
    spawn: (spec, onUsage, onCompaction, onResult) =>
      new PiProcess(
        {
          provider: spec.slot.provider,
          model: spec.slot.model,
          sessionDir: runtime.sessionDir(spec.taskId, spec.role),
          name: `${spec.taskId} ${spec.state}`,
          cwd: spec.cwd,
          extension: path.join(
            orchestratorDir,
            `result-tools-${STAGE_OF[spec.state].tools}.ts`,
          ),
          log: runtime.rpcLog(spec.taskId),
        },
        piCommand,
        sandbox(
          {
            cwd: spec.cwd,
            writable: [runtime.taskDir(spec.taskId)],
            readable: [repo, orchestratorDir],
            overlay: overlays(agentWrite(spec.slot)),
            oomScoreAdjust: AGENT_OOM_SCORE_ADJUST,
          },
          sandboxCommand,
        ),
        onUsage,
        onCompaction,
        onResult,
      ),
  };

  const checkPort: Checks = {
    get view() {
      return checks.view;
    },
    isRunning: (taskId) => checks.isRunning(taskId),
    run: (taskId, index, command, worktree) =>
      checks.start(
        taskId,
        index,
        command,
        worktree,
        runtime.checkLog(taskId, index),
        sandbox(
          {
            cwd: worktree,
            writable: [worktree],
            readable: [repo],
            overlay: overlays(checkWrite(slots)),
            oomScoreAdjust: CHECK_OOM_SCORE_ADJUST,
          },
          sandboxCommand,
        ),
      ),
  };

  const prompts = new Prompts(orchestratorDir, overridesDir);

  const files = new TaskFiles(runtime);

  const journal = new TransitionLog(runtime.transitionLog);

  const publisher: Publisher = {
    publish: (views) => {
      writeAtomic(
        runtime.agentsView,
        snapshot(views.seq, "agents", views.agents, {
          agents_file: views.agentsFile,
        }),
      );
      writeAtomic(
        runtime.checksView,
        snapshot(views.seq, "checks", views.checks),
      );
      writeAtomic(runtime.tasksView, snapshot(views.seq, "tasks", views.tasks));
      writeAtomic(runtime.inboxView, snapshot(views.seq, "inbox", views.inbox));
      writeAtomic(
        runtime.queueView,
        snapshot(views.seq, "queue", views.queue, {
          scheduling: views.scheduling,
        }),
      );
    },
    read: (name) => {
      const filePath = runtime.view(name);
      return fs.existsSync(filePath)
        ? fs.readFileSync(filePath, "utf-8")
        : "{}";
    },
    lastAgents: () => {
      if (!fs.existsSync(runtime.agentsView)) {
        return null;
      }
      try {
        return (
          JSON.parse(fs.readFileSync(runtime.agentsView, "utf-8")) as {
            agents: AgentRow[];
          }
        ).agents;
      } catch {
        return null;
      }
    },
    log: (line) => {
      runtime.log(line);
    },
  };

  const commands: CommandChannel = {
    take: () => takeCommand(runtime),
    watch: (apply) => watchCommands(runtime, apply),
  };

  const graph = new TaskGraph(
    tasks,
    workspaces,
    files,
    journal,
    publisher,
    runtime,
  );
  const pool = new Pool(agents, workspaces, runtime, publisher, isProcessAlive);
  const settle = new SettleAgent(
    graph,
    pool,
    files,
    files,
    prompts,
    publisher,
    workspaces,
    config.base,
  );
  const dispatch = new Dispatch(
    graph,
    pool,
    settle,
    workspaces,
    files,
    files,
    runtime,
    publisher,
    config.base,
  );
  const runChecks = new RunChecks(graph, checkPort, files, prompts, repo);
  const land = new Land(graph, pool, runChecks, workspaces, config.base);
  const recover = new Recover(
    graph,
    pool,
    workspaces,
    runtime,
    publisher,
    isProcessAlive,
    config.base,
  );

  return new Server(
    config,
    graph,
    pool,
    dispatch,
    runChecks,
    land,
    recover,
    commands,
    journal,
    prompts,
    runtime,
    publisher,
  );
}

export { branchName };
