import fs from "node:fs/promises";
import path from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { Dispatcher } from "../app/dispatcher.ts";
import { Lander } from "../app/lander.ts";
import { Pool } from "../app/pool.ts";
import { Recovery } from "../app/recovery.ts";
import { Checker } from "../app/checker.ts";
import { Server } from "../app/server.ts";
import type { ServerConfig } from "../app/config.ts";
import { Health } from "../app/health.ts";
import { Views } from "../app/views.ts";
import { Settler } from "../app/settler.ts";
import { TaskGraph } from "../app/task-graph.ts";
import { Latch } from "../domain/latch.ts";
import { branchName } from "../domain/workspace.ts";
import { loadAgents } from "../adapters/agent-pool.ts";
import { CommandFile } from "../adapters/command.ts";
import { exists } from "../adapters/files.ts";
import * as git from "../adapters/git.ts";
import { GitWorkspaces } from "../adapters/git-workspaces.ts";
import { PiAgents } from "../adapters/pi-agents.ts";
import { PromptFiles } from "../adapters/prompt-files.ts";
import { type Runtime, defaultAgentsPath } from "../adapters/runtime.ts";
import {
  LIMIT_COMMAND,
  SANDBOX_COMMAND,
  hasLimits,
  hasOverlay,
} from "../adapters/sandbox.ts";
import { SandboxedChecks } from "../adapters/sandboxed-checks.ts";
import { isProcessAlive } from "../adapters/processes.ts";
import { TaskDocuments } from "../adapters/task-documents.ts";
import { TaskFiles } from "../adapters/task-files.ts";
import { TransitionLog } from "../adapters/transition-log.ts";
import { ViewFiles } from "../adapters/view-files.ts";

const ORCHESTRATOR_DIR = path.join(import.meta.dir, "..");

export interface WiringOptions {
  runtime: Runtime;
  tasksDir: string;
  agentsPath?: string;
  orchestratorDir?: string;
  overridesDir?: string;
  piCommand?: string;
  sandboxCommand?: string;
  base?: string;
}

export interface App {
  server: Server;
  graph: TaskGraph;
  pool: Pool;
  dispatcher: Dispatcher;
  settler: Settler;
  checker: Checker;
  lander: Lander;
  recovery: Recovery;
  views: Views;
  health: Health;
}

export async function wire(options: WiringOptions): Promise<App> {
  const runtime = options.runtime;
  const repo = runtime.repo;
  if (!(await git.isRepo(repo))) {
    throw new Error(`${repo} is not a git repository`);
  }

  const tasksDir = options.tasksDir;
  if (!(await exists(tasksDir))) {
    await fs.cp(path.join(ORCHESTRATOR_DIR, "..", "tasks"), tasksDir, {
      recursive: true,
    });
  }

  const orchestratorDir = options.orchestratorDir ?? ORCHESTRATOR_DIR;
  const overridesDir = options.overridesDir ?? tasksDir;
  const config: ServerConfig = {
    repo,
    tasksDir,
    agentsPath: options.agentsPath ?? defaultAgentsPath(tasksDir),
    base: options.base ?? (await git.defaultBranch(repo)),
    promptDirs: {
      orchestrator: path.join(orchestratorDir, "prompts"),
      overrides: path.join(overridesDir, "prompts"),
    },
  };

  const piCommand = options.piCommand ?? "pi";
  const sandboxCommand = options.sandboxCommand ?? SANDBOX_COMMAND;
  const slots = await loadAgents(config.agentsPath);

  if (!(await hasLimits())) {
    console.warn(
      `no cgroup limits available: ${LIMIT_COMMAND} --user --scope failed, sandboxes run without MemoryMax/TasksMax`,
    );
  }

  if (!(await hasOverlay())) {
    console.warn(
      `no overlay mounts available: ${SANDBOX_COMMAND} --tmp-overlay failed, sandboxes read the paths they would have overlaid instead of writing to a copy`,
    );
  }

  const checks = new SandboxedChecks(runtime, slots, repo, sandboxCommand);

  const tasks = new TaskDocuments(tasksDir, orchestratorDir);

  const workspaces = new GitWorkspaces(repo);

  const agents = new PiAgents(
    runtime,
    slots,
    await ModelRuntime.create(),
    repo,
    orchestratorDir,
    piCommand,
    sandboxCommand,
  );

  const prompts = await PromptFiles.open(orchestratorDir, overridesDir);

  const files = new TaskFiles(runtime);

  const transitions = await TransitionLog.open(runtime.transitionLog);

  const publisher = new ViewFiles(runtime);

  const commands = new CommandFile(runtime);

  const wake = new Latch();

  const graph = new TaskGraph(
    tasks,
    workspaces,
    files,
    transitions,
    publisher,
    runtime,
    wake,
  );
  const pool = new Pool(
    agents,
    workspaces,
    publisher,
    isProcessAlive,
    (taskId, cost, resumed) => graph.recordCost(taskId, cost, resumed),
  );
  const settler = new Settler(
    graph,
    pool,
    files,
    files,
    prompts,
    publisher,
    workspaces,
    config.base,
  );
  const dispatcher = new Dispatcher(
    graph,
    pool,
    settler,
    workspaces,
    files,
    files,
    runtime,
    publisher,
    config.base,
    config.agentsPath,
  );
  const checker = new Checker(graph, checks, files, prompts, publisher, repo);
  const lander = new Lander(graph, pool, checker, workspaces, config.base);
  const recovery = new Recovery(
    graph,
    pool,
    workspaces,
    runtime,
    publisher,
    isProcessAlive,
    config.base,
  );

  const views = new Views(
    config,
    graph,
    pool,
    dispatcher,
    checker,
    transitions,
    publisher,
    runtime,
  );
  const health = new Health(publisher);

  const server = new Server(
    config,
    wake,
    graph,
    pool,
    dispatcher,
    settler,
    checker,
    recovery,
    commands,
    prompts,
    runtime,
    publisher,
    views,
    health,
  );

  return {
    server,
    graph,
    pool,
    dispatcher,
    settler,
    checker,
    lander,
    recovery,
    views,
    health,
  };
}

export { branchName };
