import fs from "node:fs/promises";
import path from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { Dispatcher } from "../tasks/app/dispatcher.ts";
import { Lander } from "../tasks/app/lander.ts";
import { Pool } from "../agents/app/pool.ts";
import { Recovery } from "../tasks/app/recovery.ts";
import { Checker } from "../tasks/app/checker.ts";
import { Server } from "../tasks/app/server.ts";
import type { ServerConfig } from "../tasks/app/config.ts";
import { Health } from "../tasks/app/health.ts";
import { Reports } from "../tasks/app/reports.ts";
import { Settler } from "../tasks/app/settler.ts";
import { TaskGraph } from "../tasks/app/task-graph.ts";
import { Latch } from "../kernel/domain/latch.ts";
import { branchName } from "../workspaces/domain/workspace.ts";
import { checkWrite, loadAgents } from "../agents/adapters/agent-pool.ts";
import { CommandFile } from "../runtime/adapters/command.ts";
import { exists } from "../kernel/adapters/files.ts";
import * as git from "../workspaces/adapters/git.ts";
import { GitWorkspaces } from "../workspaces/adapters/git-workspaces.ts";
import { PiAgents } from "../agents/adapters/pi-agents.ts";
import { PromptFiles } from "../prompting/adapters/prompt-files.ts";
import {
  type Runtime,
  defaultAgentsPath,
} from "../runtime/adapters/runtime.ts";
import {
  LIMIT_COMMAND,
  SANDBOX_COMMAND,
  hasLimits,
  hasOverlay,
} from "../kernel/adapters/sandbox.ts";
import { SandboxedChecks } from "../checks/adapters/sandboxed-checks.ts";
import { isProcessAlive } from "../kernel/adapters/processes.ts";
import { TaskDocuments } from "../tasks/adapters/task-documents.ts";
import { TaskFiles } from "../runtime/adapters/task-files.ts";
import { TransitionLog } from "../runtime/adapters/transition-log.ts";
import { ViewFiles } from "../runtime/adapters/view-files.ts";

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
  reports: Reports;
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

  const checks = new SandboxedChecks(
    runtime,
    checkWrite(slots),
    repo,
    sandboxCommand,
  );

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
  const settler = new Settler({
    graph,
    pool,
    assignments: files,
    reviews: files,
    prompts,
    publisher,
    workspaces,
    base: config.base,
  });
  const dispatcher = new Dispatcher({
    graph,
    pool,
    settler,
    workspaces,
    assignments: files,
    messages: files,
    paths: runtime,
    publisher,
    base: config.base,
    agentsPath: config.agentsPath,
  });
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

  const reports = new Reports({
    config,
    graph,
    pool,
    dispatcher,
    checker,
    transitions,
    publisher,
    paths: runtime,
  });
  const health = new Health(publisher);

  const server = new Server({
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
    paths: runtime,
    publisher,
    reports,
    health,
  });

  return {
    server,
    graph,
    pool,
    dispatcher,
    settler,
    checker,
    lander,
    recovery,
    reports,
    health,
  };
}

export { branchName };
