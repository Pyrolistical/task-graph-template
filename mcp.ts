#!/usr/bin/env bun
import fs from "node:fs";
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { z } from "zod";
import { type TaskId, isValidId } from "./orchestrator/domain/task.ts";
import type { ViewName } from "./orchestrator/app/ports.ts";
import type { Manager } from "./orchestrator/app/manager.ts";
import { Server } from "./orchestrator/app/server.ts";
import { Runtime } from "./orchestrator/adapters/runtime.ts";
import { type WiringOptions, wire } from "./orchestrator/main/compose.ts";

const TICK_MS = 500;

export interface Startup {
  server: Manager | null;
  error: string | null;
}

const taskId = z.string().refine(isValidId, {
  error: (issue) => `"${issue.input}" is not a six-digit task ID`,
});

function text(value: string) {
  return { content: [{ type: "text" as const, text: value }] };
}

function json(value: unknown) {
  return text(JSON.stringify(value, null, 2));
}

export function build(startup: Startup): McpServer {
  const mcp = new McpServer(
    { name: "task-graph-orchestrator", version: "1.0.0" },
    { capabilities: { tools: {}, resources: {} } },
  );

  function live(): Manager {
    if (startup.server === null) {
      throw new Error(
        startup.error ?? "the server did not start, and said nothing about why",
      );
    }
    return startup.server;
  }

  async function applied(result: unknown) {
    await live().writeViews();
    return json(result);
  }

  mcp.registerTool(
    "task_create",
    {
      description:
        "Create a new task and return the path of its document. The document is yours to edit directly until it leaves NEW.",
      inputSchema: z.object({ title: z.string().min(1) }),
    },
    async ({ title }) => applied(live().createTask(title)),
  );

  mcp.registerTool(
    "task_write_body",
    {
      description:
        "Replace a task document's body under the graph lock. Use this for a task you do not hold; edit the file directly for one you do.",
      inputSchema: z.object({ id: taskId, body: z.string().min(1) }),
    },
    async ({ id, body }) => applied({ filePath: live().writeBody(id, body) }),
  );

  mcp.registerTool(
    "task_submit",
    {
      description:
        "Say the task is done with the stage it is in and move it forward. From NEW or BLOCKED it is dispatched — NEW → DESIGN, or BLOCKED while dependencies remain; BLOCKED → DESIGN once they are gone. From MANAGER_REVIEW the work is landed first (rebase, recheck, fast-forward), then the task closes.",
      inputSchema: z.object({ id: taskId }),
    },
    async ({ id }) => applied(await live().submit(id)),
  );

  mcp.registerTool(
    "task_feedback",
    {
      description:
        "Send a task back to work with review findings: MANAGER_REVIEW → WORK. The findings are appended to the task body under # Review findings with a fresh Implementation Notes section for the next worker round, and the worker is reminded of them at dispatch.",
      inputSchema: z.object({
        id: taskId,
        findings: z.array(z.string().min(1)).min(1),
      }),
    },
    async ({ id, findings }) =>
      applied(live().feedback(id, findings, "manager")),
  );

  mcp.registerTool(
    "task_resume",
    {
      description:
        "Take a task out of HELD, having decided the wall is gone. Each held state returns to the phase it was held from: HELD_DESIGN → DESIGN, HELD_PLAN → PLAN, HELD_WORK → WORK. Dependencies added while it was held put it in BLOCKED instead, and a task that unblocks starts again at DESIGN.",
      inputSchema: z.object({ id: taskId }),
    },
    async ({ id }) => applied(live().resume(id)),
  );

  mcp.registerTool(
    "task_hold",
    {
      description:
        "Park a task, whether or not an agent is holding it. It lands in the held state of the phase it was in: HELD_DESIGN from DESIGN or DESIGN_REVIEW, HELD_PLAN from PLAN or PLAN_REVIEW, HELD_WORK from WORK, CHECK or WORK_REVIEW. The document is yours to edit directly while it is held; task_resume sends it back, task_abort closes it.",
      inputSchema: z.object({ id: taskId, reason: z.string().min(1) }),
    },
    async ({ id, reason }) => applied(live().hold(id, reason)),
  );

  mcp.registerTool(
    "task_abort",
    {
      description:
        "Throw the task away because it was the wrong shape, from MANAGER_REVIEW once the work is in, or from HELD_DESIGN, HELD_PLAN or HELD_WORK while it is parked. Closes it right away. To abort a task that is still in DESIGN, PLAN or WORK, task_hold it first. Refused if the branch already landed.",
      inputSchema: z.object({ id: taskId }),
    },
    async ({ id }) => applied(live().abort(id)),
  );

  mcp.registerTool(
    "enable_scheduler",
    { description: "Begin dispatching queued work. Returns immediately." },
    async () => {
      live().setSchedulerEnabled(true);
      await live().writeViews();
      return text("the scheduler is dispatching");
    },
  );

  mcp.registerTool(
    "disable_scheduler",
    {
      description:
        "Start nothing new. Running processes are still settled and their slots still released.",
    },
    async () => {
      live().setSchedulerEnabled(false);
      await live().writeViews();
      return text("the scheduler is paused; running work still settles");
    },
  );

  mcp.registerTool(
    "reload_prompts",
    {
      description:
        "Re-read every prompt and template from disk, so edits to the project's overrides take effect without restarting the server. Returns the absolute path of each file now cached.",
      inputSchema: z.object({}),
    },
    async () => json(live().reloadPrompts()),
  );

  mcp.registerTool(
    "enable_agent",
    {
      description:
        "Let an agent be dispatched to again. Names an agent, not a slot: type-provider-model, without the trailing slot number.",
      inputSchema: z.object({ agent: z.string().min(1) }),
    },
    async ({ agent }) => applied(live().setAgentEnabled(agent, true)),
  );

  mcp.registerTool(
    "disable_agent",
    {
      description:
        "Stop dispatching to every slot of an agent. Names an agent, not a slot: type-provider-model, without the trailing slot number. Slots running right now finish their task first; they read as still running with enabled false, and go DISABLED once released.",
      inputSchema: z.object({ agent: z.string().min(1) }),
    },
    async ({ agent }) => applied(live().setAgentEnabled(agent, false)),
  );

  mcp.registerTool(
    "agent_abort",
    {
      description:
        "Abort whatever a slot is doing right now. Names a slot (with the trailing number), only works while the slot is doing something. The aborted turn ends the assignment and releases the slot.",
      inputSchema: z.object({ agent: z.string().min(1) }),
    },
    async ({ agent }) => applied(live().abortAgent(agent)),
  );

  function resource(
    name: string,
    uri: string,
    description: string,
    mimeType: string,
    read: () => string,
  ): void {
    mcp.registerResource(name, uri, { description, mimeType }, async () => ({
      contents: [{ uri, mimeType, text: read() }],
    }));
  }

  function view(name: ViewName, description: string) {
    resource(
      name,
      `orchestrator://${name}`,
      description,
      "application/json",
      () => live().view(name),
    );
  }

  view(
    "inbox",
    [
      "everything waiting on the manager, most nearly closed first. Ranks and how to handle them:",
      "MANAGER_REVIEW: the work is done and the work review passed; task_submit to land it, task_feedback with findings to send it back to work, or task_abort. The document is yours to edit directly. Task graph changes the close needs are made by editing the graph yourself, at any time.",
      "HELD_DESIGN/HELD_PLAN/HELD_WORK: an agent stalled or was blocked; held_reason says why. Resolve by directly updating the task document (edit the file or task_write_body), then task_resume to re-dispatch, or task_abort to close it. Never add todos — the plan's todo list is the planner's to write.",
      "NEW: author the task (edit the file: body, checks, dependencies), then task_submit.",
    ].join(" "),
  );

  view("agents", "every agent slot, idle ones included");

  view("checks", "the check processes running right now");

  view("tasks", "the last 100 tasks to change state");

  view(
    "queue",
    "the tasks waiting on a slot, in the order the scheduler will dispatch them",
  );

  resource(
    "paths",
    "orchestrator://paths",
    "the paths the server knows at startup: task directory, agents file, prompt overrides, runtime root and logs",
    "application/json",
    () => JSON.stringify(live().paths(), null, 2),
  );

  resource(
    "error",
    "orchestrator://error",
    "why the server is not working: the failure that stopped it starting, or the last one it hit while running. Null when there is none. Every other tool and resource fails with this message while it is set.",
    "application/json",
    () =>
      JSON.stringify(
        { error: startup.error ?? startup.server?.lastError ?? null },
        null,
        2,
      ),
  );

  resource(
    "workspace_path",
    "orchestrator://workspace_path",
    "the runtime directory, for file watchers",
    "text/plain",
    () => live().paths().runtime_root,
  );

  return mcp;
}

export interface Boot extends Startup {
  server: Server | null;
}

export async function boot(options: WiringOptions): Promise<Boot> {
  try {
    return { server: await wire(options).start(), error: null };
  } catch (err) {
    return {
      server: null,
      error: `the server failed to start: ${(err as Error).message}`,
    };
  }
}

function start(): Promise<Boot> {
  return boot({
    repo: process.cwd(),
    tasksDir:
      process.argv[2] === undefined ? undefined : path.resolve(process.argv[2]),
    serverRoot: process.env.TASK_GRAPH_SERVER_ROOT,
  });
}

async function main(): Promise<void> {
  const startup = await start();
  const runtime: Runtime = new Runtime(
    process.cwd(),
    process.env.TASK_GRAPH_SERVER_ROOT,
  );
  const log = (line: string) => {
    runtime.log(line);
  };

  if (startup.server === null) {
    log(startup.error ?? "the server failed to start");
    serveStdio(() => build(startup), {
      onerror: (err) => log(`mcp failed: ${err.message}`),
    });
    return;
  }

  const server = startup.server;
  const ticker = setInterval(() => {
    void server.tick().catch((err: Error) => {
      server.fail(`tick failed: ${err.message}`);
    });
  }, TICK_MS);

  const detach = () => {
    clearInterval(ticker);
    server.detach();
    process.exit(0);
  };
  process.on("SIGINT", detach);
  process.on("SIGTERM", detach);

  serveStdio(() => build(startup), {
    onerror: (err) => log(`mcp failed: ${err.message}`),
  });
}

if (import.meta.main) {
  try {
    await main();
  } catch (err) {
    new Runtime(process.cwd(), process.env.TASK_GRAPH_SERVER_ROOT).log(
      `the server crashed: ${(err as Error).message}`,
    );
    throw err;
  }
}
