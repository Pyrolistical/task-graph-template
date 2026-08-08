import fs from "node:fs";
import path from "node:path";
import { Dispatcher } from "../app/dispatcher.ts";
import { Lander } from "../app/lander.ts";
import { Pool } from "../app/pool.ts";
import { Recovery } from "../app/recovery.ts";
import { Checker } from "../app/checker.ts";
import { Server, type ServerConfig } from "../app/server.ts";
import { Settler } from "../app/settler.ts";
import { TaskGraph } from "../app/task-graph.ts";
import { branchName } from "../domain/workspace.ts";
import { loadAgents } from "../adapters/agent-pool.ts";
import { CommandFile } from "../adapters/command.ts";
import * as git from "../adapters/git.ts";
import { GitWorkspaces } from "../adapters/git-workspaces.ts";
import { PiAgents } from "../adapters/pi-agents.ts";
import { PromptFiles } from "../adapters/prompt-files.ts";
import {
  Runtime,
  defaultAgentsPath,
  defaultTasksDir,
} from "../adapters/runtime.ts";
import {
  LIMIT_COMMAND,
  SANDBOX_COMMAND,
  hasLimits,
} from "../adapters/sandbox.ts";
import { SandboxedChecks } from "../adapters/sandboxed-checks.ts";
import { isProcessAlive } from "../adapters/task-store.ts";
import { TaskDocuments } from "../adapters/task-documents.ts";
import { TaskFiles } from "../adapters/task-files.ts";
import { TransitionLog } from "../adapters/transition-log.ts";
import { ViewFiles } from "../adapters/view-files.ts";

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

  const checks = new SandboxedChecks(runtime, slots, repo, sandboxCommand);

  const tasks = new TaskDocuments(tasksDir, orchestratorDir);

  const workspaces = new GitWorkspaces(repo);

  const agents = new PiAgents(
    runtime,
    slots,
    repo,
    orchestratorDir,
    piCommand,
    sandboxCommand,
  );

  const prompts = new PromptFiles(orchestratorDir, overridesDir);

  const files = new TaskFiles(runtime);

  const transitions = new TransitionLog(runtime.transitionLog);

  const publisher = new ViewFiles(runtime);

  const commands = new CommandFile(runtime);

  const graph = new TaskGraph(
    tasks,
    workspaces,
    files,
    transitions,
    publisher,
    runtime,
  );
  const pool = new Pool(agents, workspaces, publisher, isProcessAlive);
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
  );
  const checker = new Checker(graph, checks, files, prompts, repo);
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

  return new Server(
    config,
    graph,
    pool,
    dispatcher,
    checker,
    lander,
    recovery,
    commands,
    transitions,
    prompts,
    runtime,
    publisher,
  );
}

export { branchName };
