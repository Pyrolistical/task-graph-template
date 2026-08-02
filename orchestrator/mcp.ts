#!/usr/bin/env bun
import fs from "node:fs";
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { z } from "zod";
import {
  type TaskId,
  UPDATE_OPS,
  createTask,
  isValidId,
  openCount,
  writeTaskBody,
} from "./task.ts";
import type { TransitionArgs, TransitionName } from "./transition.ts";
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
    "task_done_create",
    {
      description:
        "Finish authoring a task and let it be dispatched: NEW → READY_PLAN. Refused while it still has dependencies, which put it in BLOCKED instead.",
      inputSchema: z.object({ id: taskId }),
    },
    async ({ id }) => judge(id, "noDependencies"),
  );

  mcp.registerTool(
    "task_add_dependencies",
    {
      description:
        "Make this task wait on others. From NEW it moves to BLOCKED; the last dependency to close releases it.",
      inputSchema: z.object({ id: taskId, task_ids: z.array(taskId).min(1) }),
    },
    async ({ id, task_ids }) =>
      judge(id, "addDependencies", { taskIds: task_ids }),
  );

  mcp.registerTool(
    "task_remove_dependencies",
    {
      description:
        "Drop dependencies you decided were not real. Removing the last one moves the task to READY_PLAN.",
      inputSchema: z.object({ id: taskId, task_ids: z.array(taskId).min(1) }),
    },
    async ({ id, task_ids }) =>
      judge(id, "removeDependencies", { taskIds: task_ids }),
  );

  mcp.registerTool(
    "task_add_check",
    {
      description:
        "Add a command the work is judged by. It is run in the worktree on every submit.",
      inputSchema: z.object({ id: taskId, command: z.string().min(1) }),
    },
    async ({ id, command }) => judge(id, "addCheck", { command }),
  );

  mcp.registerTool(
    "task_add_todo",
    {
      description:
        "Add a piece of work. From MANAGER_REVIEWING this sends the task back to READY_WORK; from HELD_WORK back to READY_WORK, and from HELD_PLAN back to READY_PLAN.",
      inputSchema: z.object({ id: taskId, message: z.string().min(1) }),
    },
    async ({ id, message }) => judge(id, "addTodo", { message }),
  );

  mcp.registerTool(
    "task_resume",
    {
      description:
        "Take a task out of HELD unchanged, having decided the wall is gone. Returns to READY_PLAN from HELD_PLAN, and to READY_WORK from HELD_WORK.",
      inputSchema: z.object({ id: taskId }),
    },
    async ({ id }) => judge(id, "resume"),
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
    "task_add_task_graph_update",
    {
      description:
        "Queue a change the graph needs before this task can close: a task to add, or one to update or delete.",
      inputSchema: z.object({
        id: taskId,
        op: z.enum(UPDATE_OPS),
        task_id: taskId.optional(),
        message: z.string().min(1),
      }),
    },
    async ({ id, op, task_id, message }) =>
      judge(id, "addTaskGraph", { op, taskId: task_id, message }),
  );

  mcp.registerTool(
    "task_done_task_graph_updates",
    {
      description:
        "Declare every queued graph update made. Marks them all done, which closes the task.",
      inputSchema: z.object({ id: taskId }),
    },
    async ({ id }) => {
      const task = server.tasks().get(id);
      if (task === undefined) {
        throw new Error(`Task "${id}" not found`);
      }
      if (openCount(task.task_graph_updates) === 0) {
        throw new Error(`Task "${id}" has no open task graph update`);
      }

      let last;
      for (const [index, update] of task.task_graph_updates.entries()) {
        if (!update.done) {
          last = server.transition(id, "doneTaskGraph", { index }, "manager");
        }
      }
      return applied(last);
    },
  );

  mcp.registerTool(
    "task_merge",
    {
      description:
        "Accept the work: rebase the branch onto the base, re-run every check, fast-forward the base onto it, then close the task or move it to READY_TASK_GRAPH_UPDATE. Any of those failing is an error back to you, with the task left in MANAGER_REVIEWING.",
      inputSchema: z.object({ id: taskId }),
    },
    async ({ id }) => applied(await server.attemptMerge(id)),
  );

  mcp.registerTool(
    "task_abort",
    {
      description:
        "Throw the task away because it was the wrong shape, from MANAGER_REVIEWING once the work is in, or from READY_WORK or READY_PLAN before an agent picks it up. Refused if the branch already landed, or if no graph update says what should replace it.",
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
      "everything waiting on the manager, most nearly closed first",
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
  const server = await Server.start({
    repo: path.resolve(repo),
    agentsPath: path.join(process.cwd(), "agents.json"),
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
