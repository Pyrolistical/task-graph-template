#!/usr/bin/env bun
import fs from "node:fs";
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { z } from "zod";
import { type TaskId, createTask, isValidId, writeTaskBody } from "./task.ts";
import type { TransitionArgs, TransitionName } from "./transition.ts";
import { append } from "./queue.ts";
import { Server } from "./server.ts";

const TICK_MS = 500;

const taskId = z.string().refine(isValidId, {
  error: (issue) => `"${issue.input}" is not a six-digit task ID`,
});

function text(value: string) {
  return { content: [{ type: "text" as const, text: value }] };
}

function json(value: unknown) {
  return text(JSON.stringify(value, null, 2));
}

export function build(server: Server): McpServer {
  const mcp = new McpServer(
    { name: "task-graph-orchestrator", version: "1.0.0" },
    { capabilities: { tools: {}, resources: {} } },
  );

  async function applied(result: unknown) {
    await server.writeViews();
    return json(result);
  }

  function judge(
    id: TaskId,
    transition: TransitionName,
    args: TransitionArgs = {},
  ) {
    return applied(server.transition(id, transition, args, "manager"));
  }

  mcp.registerTool(
    "task_create",
    {
      description:
        "Create a new task and return the path of its document. The document is yours to edit directly until it leaves NEW.",
      inputSchema: z.object({ title: z.string().min(1) }),
    },
    async ({ title }) => {
      const created = createTask(server.tasksDir, title);
      server.transitions.append({
        task_id: created.id,
        transition: "create",
        from: "NEW",
        to: "NEW",
        by: "manager",
      });
      return applied(created);
    },
  );

  mcp.registerTool(
    "task_write_body",
    {
      description:
        "Replace a task document's body under the graph lock. Use this for a task you do not hold; edit the file directly for one you do.",
      inputSchema: z.object({ id: taskId, body: z.string().min(1) }),
    },
    async ({ id, body }) =>
      applied({ filePath: writeTaskBody(server.tasksDir, id, body) }),
  );

  mcp.registerTool(
    "task_submit",
    {
      description:
        "Say the task is done with the stage it is in and move it forward. From NEW or BLOCKED it is dispatched — NEW → READY_PLAN, or BLOCKED while dependencies remain; BLOCKED → READY_PLAN once they are gone. From MANAGER_REVIEWING the work is landed first (rebase, recheck, fast-forward), then the task closes, or goes to READY_TASK_GRAPH_UPDATE when updates are queued. From TASK_GRAPH_UPDATING it closes, refused while any queued update is not marked done.",
      inputSchema: z.object({ id: taskId }),
    },
    async ({ id }) => {
      const state = server.tasks().get(id)?.state;
      if (state === "MANAGER_REVIEWING") {
        return applied(await server.attemptMerge(id));
      }
      return judge(id, "submit");
    },
  );

  mcp.registerTool(
    "task_add_feedback",
    {
      description:
        "Send a task back to work with review findings: MANAGER_REVIEWING → READY_WORK. The findings are appended to the task body under # Review findings with a fresh Implementation Notes section for the next worker round, and the worker is reminded of them at dispatch.",
      inputSchema: z.object({
        id: taskId,
        findings: z.array(z.string().min(1)).min(1),
      }),
    },
    async ({ id, findings }) => {
      const result = judge(id, "addFeedback", { findings });
      append(
        server.runtime.taskDir(id),
        "WORKING",
        server.prompts.fragment("work-findings", {
          findings: findings.map((finding) => ({ finding })),
        }),
      );
      return result;
    },
  );

  mcp.registerTool(
    "task_resume",
    {
      description:
        "Take a task out of HELD, having decided the wall is gone. Returns to READY_PLAN from HELD_PLAN and to READY_WORK from HELD_WORK; dependencies added while it was held put it in BLOCKED instead.",
      inputSchema: z.object({ id: taskId }),
    },
    async ({ id }) => judge(id, "resume"),
  );

  mcp.registerTool(
    "task_hold",
    {
      description:
        "Park a task. From the planning-phase states (READY_PLAN, PLANNING, READY_PLAN_REVIEW, PLAN_REVIEWING) it lands in HELD_PLAN; from the work-phase states (READY_WORK, WORKING, READY_CHECK, CHECKING, READY_WORK_REVIEW, WORK_REVIEWING) in HELD_WORK. The document is yours to edit directly while it is held; task_resume sends it back, task_abort closes it.",
      inputSchema: z.object({ id: taskId, reason: z.string().min(1) }),
    },
    async ({ id, reason }) => judge(id, "hold", { reason }),
  );

  mcp.registerTool(
    "task_claim",
    {
      description:
        "Take ownership of a task waiting on you: READY_MANAGER_REVIEW → MANAGER_REVIEWING, READY_TASK_GRAPH_UPDATE → TASK_GRAPH_UPDATING. The document is yours to edit directly while you hold it.",
      inputSchema: z.object({ id: taskId }),
    },
    async ({ id }) =>
      judge(id, "claim", { agentName: "manager", pid: process.pid }),
  );

  mcp.registerTool(
    "task_abort",
    {
      description:
        "Throw the task away because it was the wrong shape, from MANAGER_REVIEWING once the work is in, or from HELD_PLAN or HELD_WORK while it is parked. Closes it right away; task graph updates queued on the document are applied first. To abort a task that is still in READY_PLAN or READY_WORK, task_hold it first. Refused if the branch already landed.",
      inputSchema: z.object({ id: taskId }),
    },
    async ({ id }) => applied(server.attemptAbort(id)),
  );

  mcp.registerTool(
    "enable_scheduler",
    { description: "Begin dispatching queued work. Returns immediately." },
    async () => {
      server.setSchedulerEnabled(true);
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
      server.setSchedulerEnabled(false);
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
    async () => json(server.reloadPrompts()),
  );

  mcp.registerTool(
    "enable_agent",
    {
      description:
        "Let an agent be dispatched to again. Names an agent, not a slot: type-provider-model, without the trailing slot number.",
      inputSchema: z.object({ agent: z.string().min(1) }),
    },
    async ({ agent }) => applied(server.setAgentEnabled(agent, true)),
  );

  mcp.registerTool(
    "disable_agent",
    {
      description:
        "Stop dispatching to every slot of an agent. Names an agent, not a slot: type-provider-model, without the trailing slot number. Slots running right now finish their task first; they read as still running with enabled false, and go DISABLED once released.",
      inputSchema: z.object({ agent: z.string().min(1) }),
    },
    async ({ agent }) => applied(server.setAgentEnabled(agent, false)),
  );

  mcp.registerTool(
    "agent_abort",
    {
      description:
        "Abort whatever a slot is doing right now. Names a slot (with the trailing number), only works while the slot is doing something. The aborted turn ends the assignment and releases the slot.",
      inputSchema: z.object({ agent: z.string().min(1) }),
    },
    async ({ agent }) => applied(server.abortAgent(agent)),
  );

  const views: [string, string, string, () => string][] = [
    [
      "inbox",
      "orchestrator://inbox",
      [
        "everything waiting on the manager, most nearly closed first. Ranks and how to handle them:",
        "READY_MANAGER_REVIEW: the work is done and the work review passed; task_submit to land it, task_add_feedback with findings to send it back to work, or task_abort. Task graph changes the close needs are edited into the document directly.",
        "READY_TASK_GRAPH_UPDATE: queued graph updates await you; apply them by editing the graph, mark each update done in the document, then task_submit to close the task.",
        "HELD_PLAN/HELD_WORK: an agent stalled or was blocked; held_reason says why. Resolve by directly updating the task document (edit the file or task_write_body), then task_resume to re-dispatch, or task_abort to close it. Never add todos — the plan's todo list is the planner's to write.",
        "NEW: author the task (edit the file: body, checks, dependencies), then task_submit.",
      ].join(" "),
      () => server.runtime.inboxView,
    ],
    [
      "agents",
      "orchestrator://agents",
      "every agent slot, idle ones included",
      () => server.runtime.agentsView,
    ],
    [
      "checks",
      "orchestrator://checks",
      "the check processes running right now",
      () => server.runtime.checksView,
    ],
    [
      "tasks",
      "orchestrator://tasks",
      "the last 100 tasks to change state",
      () => server.runtime.tasksView,
    ],
    [
      "queue",
      "orchestrator://queue",
      "the tasks waiting on a slot, in the order the scheduler will dispatch them",
      () => server.runtime.queueView,
    ],
  ];

  for (const [name, uri, description, filePath] of views) {
    mcp.registerResource(
      name,
      uri,
      { description, mimeType: "application/json" },
      async () => ({
        contents: [
          {
            uri,
            mimeType: "application/json",
            text: fs.existsSync(filePath())
              ? fs.readFileSync(filePath(), "utf-8")
              : "{}",
          },
        ],
      }),
    );
  }

  mcp.registerResource(
    "paths",
    "orchestrator://paths",
    {
      description:
        "the paths the server knows at startup: task directory, agents file, prompt overrides, runtime root and logs",
      mimeType: "application/json",
    },
    async () => ({
      contents: [
        {
          uri: "orchestrator://paths",
          mimeType: "application/json",
          text: JSON.stringify(
            {
              repo: server.repo,
              tasks_dir: server.tasksDir,
              agents_file: server.agentsPath,
              overrides_prompts_dir: path.join(server.overridesDir, "prompts"),
              orchestrator_prompts_dir: path.join(
                server.orchestratorDir,
                "prompts",
              ),
              runtime_root: server.runtime.root,
              server_log: server.runtime.serverLog,
              transition_log: server.runtime.transitionLog,
              console_command: server.runtime.consoleCommand,
              views: {
                agents: server.runtime.agentsView,
                checks: server.runtime.checksView,
                tasks: server.runtime.tasksView,
                inbox: server.runtime.inboxView,
                queue: server.runtime.queueView,
              },
            },
            null,
            2,
          ),
        },
      ],
    }),
  );

  mcp.registerResource(
    "workspace_path",
    "orchestrator://workspace_path",
    {
      description: "the runtime directory, for file watchers",
      mimeType: "text/plain",
    },
    async () => ({
      contents: [
        {
          uri: "orchestrator://workspace_path",
          mimeType: "text/plain",
          text: server.runtime.root,
        },
      ],
    }),
  );

  return mcp;
}

async function main(): Promise<void> {
  const repo = process.argv[2] ?? process.cwd();
  const tasksDir =
    process.argv[3] === undefined ? undefined : path.resolve(process.argv[3]);
  const server = await Server.start({
    repo: path.resolve(repo),
    tasksDir,
    serverRoot: process.env.TASK_GRAPH_SERVER_ROOT,
  });

  const ticker = setInterval(() => {
    void server.tick().catch((err: Error) => {
      server.runtime.log(`tick failed: ${err.message}`);
    });
  }, TICK_MS);

  const detach = () => {
    clearInterval(ticker);
    server.detach();
    process.exit(0);
  };
  process.on("SIGINT", detach);
  process.on("SIGTERM", detach);

  serveStdio(() => build(server), {
    onerror: (err) => server.runtime.log(`mcp failed: ${err.message}`),
  });
}

if (import.meta.main) {
  await main();
}
