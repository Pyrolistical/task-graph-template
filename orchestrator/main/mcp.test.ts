import { afterEach, describe, expect } from "bun:test";
import { testInTempDirs } from "../testing/temp-dirs.ts";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { SlotRow, SlotsView } from "../domain/agents.ts";
import { TaskRow } from "../domain/graph.ts";
import { parse } from "../domain/schema.ts";
import { QueueView } from "../policy/scheduler.ts";
import { applyTransition } from "../adapters/task-documents.ts";
import { takeClaim } from "../adapters/task-documents.ts";
import {
  activeTaskPath,
  closedTaskPath,
  readTaskFile,
} from "../adapters/task-store.ts";
import { defaultAgentsPath } from "../adapters/runtime.ts";
import {
  type Fixture,
  makeFixture,
  readyTask,
  setPlan,
  writeOverride,
} from "../testing/fixture.ts";
import {
  editTaskFile,
  filesOf,
  reaches,
  serverFor,
} from "../testing/server-jig.ts";
import type { Server } from "../app/server.ts";
import { boot, build } from "../../mcp.ts";

const openClients: Client[] = [];
const openServers: Server[] = [];

afterEach(async () => {
  for (const client of openClients.splice(0)) {
    await client.close().catch(() => {});
  }
  for (const server of openServers.splice(0)) {
    server.shutdown();
  }
});

async function connect(fixture: Fixture) {
  fs.mkdirSync(fixture.tasksDir, { recursive: true });
  const agentsPath = defaultAgentsPath(fixture.tasksDir);
  if (!fs.existsSync(agentsPath)) {
    fs.writeFileSync(
      agentsPath,
      JSON.stringify({
        agents: [{ type: "pi", provider: "fake", model: "fake", slots: 1 }],
      }),
    );
  }

  const started = await boot({
    repo: fixture.repo,
    tasksDir: fixture.tasksDir,
    serverRoot: fixture.serverRoot,
  });
  if (started.server !== null) {
    openServers.push(started.server);
  }

  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await build(started).connect(serverSide);

  const client = new Client({ name: "test", version: "1.0.0" });
  openClients.push(client);
  await client.connect(clientSide);
  return client;
}

const TextBlocks = z.array(z.looseObject({ text: z.string() }));

function textOf(result: unknown): string {
  return z.looseObject({ content: TextBlocks }).parse(result).content[0]!.text;
}

async function resourceOf<T>(
  client: Client,
  uri: string,
  schema: z.ZodType<T>,
): Promise<T> {
  const read = await client.readResource({ uri });
  return parse(
    schema,
    JSON.parse(TextBlocks.parse(read.contents)[0]!.text),
    "resource",
    uri,
  );
}

async function schedulingOf(client: Client) {
  return (await resourceOf(client, "orchestrator://queue", QueueView))
    .scheduling;
}

describe("Feature: the tool surface the manager works through", () => {
  testInTempDirs(
    "the manager gets one tool per judgement it can make",
    async () => {
      // Given a server running over stdio against a project
      const fixture = makeFixture();
      const client = await connect(fixture);

      // When the manager asks what it can do
      const tools = await client.listTools();

      // Then there is one tool for each judgement only a person can make
      expect(tools.tools.map((t) => t.name).sort()).toEqual([
        "disable_agent",
        "disable_scheduler",
        "enable_agent",
        "enable_scheduler",
        "reload_prompts",
        "slot_abort",
        "task_abort",
        "task_create",
        "task_feedback",
        "task_hold",
        "task_resume",
        "task_submit",
        "task_write_body",
      ]);

      await client.close();
    },
    60000,
  );

  testInTempDirs(
    "every view the console draws is readable as a resource",
    async () => {
      // Given a server running over stdio against a project
      const fixture = makeFixture();
      const client = await connect(fixture);

      // When the manager asks what it can read
      const resources = await client.listResources();

      // Then every view the console draws is there to be read
      expect(resources.resources.map((r) => r.uri).sort()).toEqual([
        "orchestrator://checks",
        "orchestrator://error",
        "orchestrator://inbox",
        "orchestrator://paths",
        "orchestrator://queue",
        "orchestrator://slots",
        "orchestrator://tasks",
        "orchestrator://workspace_path",
      ]);

      await client.close();
    },
    60000,
  );

  testInTempDirs(
    "the manager is told where the graph, the pool and the prompts are",
    async () => {
      // Given a server running over stdio against a project
      const fixture = makeFixture();
      const client = await connect(fixture);

      // When the manager reads the paths resource
      const parsed = await resourceOf(
        client,
        "orchestrator://paths",
        z.looseObject({
          tasks_dir: z.string(),
          agents_file: z.string(),
          overrides_prompts_dir: z.string(),
        }),
      );

      // Then the graph, the pool and the prompts are each named in it
      expect(parsed.tasks_dir).toBe(fixture.tasksDir);
      expect(parsed.agents_file).toBe(defaultAgentsPath(fixture.tasksDir));
      expect(parsed.overrides_prompts_dir).toBe(
        path.join(fixture.tasksDir, "prompts"),
      );

      await client.close();
    },
    60000,
  );

  testInTempDirs(
    "task_feedback sends the task back with the findings in the body and the findings file",
    async () => {
      // Given a task that has reached the manager for review
      const fixture = makeFixture();
      const id = readyTask(fixture, "A task");
      takeClaim(fixture.tasksDir, id, {
        slotName: "manager",
        pid: process.pid,
      });
      applyTransition(fixture.tasksDir, id, "submit", {
        body: readTaskFile(activeTaskPath(fixture.tasksDir, id)).body,
      });
      applyTransition(fixture.tasksDir, id, "pass", {});
      takeClaim(fixture.tasksDir, id, {
        slotName: "manager",
        pid: process.pid,
      });
      applyTransition(fixture.tasksDir, id, "submit", {});
      const client = await connect(fixture);

      // When the manager sends it back with a finding
      const result = await client.callTool({
        name: "task_feedback",
        arguments: { id, findings: ["the null case is untested"] },
      });

      // Then the task goes back to work with the finding written into its body
      expect(textOf(result)).toContain('"WORK"');
      const body = readTaskFile(activeTaskPath(fixture.tasksDir, id)).body;
      expect(body).toContain("# Review findings");
      expect(body).toContain("- the null case is untested");

      // Then the finding is also left where the next dispatch will read it
      const found = filesOf(fixture).findings(id);
      expect(found).toEqual(["the null case is untested"]);

      await client.close();
    },
    60000,
  );

  testInTempDirs(
    "reload_prompts picks up an override written after startup",
    async () => {
      // Given a running server whose project overrides no prompts yet
      const fixture = makeFixture();
      readyTask(fixture, "Do a thing");
      const client = await connect(fixture);
      const before = JSON.parse(
        textOf(
          await client.callTool({ name: "reload_prompts", arguments: {} }),
        ),
      );
      const override = path.join(fixture.tasksDir, "prompts", "WORK.md");
      expect(before).not.toContain(override);

      // Given an override written after the server started
      writeOverride(fixture, "prompts/WORK.md", "Start on ../ASSIGNMENT.md.\n");
      fs.mkdirSync(path.join(fixture.tasksDir, "prompts"), { recursive: true });
      fs.writeFileSync(override, "Start on ../ASSIGNMENT.md.\n");

      // When the prompts are reloaded
      const after = JSON.parse(
        textOf(
          await client.callTool({ name: "reload_prompts", arguments: {} }),
        ),
      );

      // Then the new file is cached, without the server being restarted
      expect(after).toContain(override);

      await client.close();
    },
    60000,
  );

  testInTempDirs(
    "task_create returns a path the manager can edit directly",
    async () => {
      // Given a project with no tasks in it yet
      const fixture = makeFixture();
      const client = await connect(fixture);

      // When the manager creates one
      const created = JSON.parse(
        textOf(
          await client.callTool({
            name: "task_create",
            arguments: { title: "new work" },
          }),
        ),
      );

      // Then it takes the first id, and the manager is told which file to edit
      expect(created.id).toBe("000001");
      expect(fs.existsSync(created.filePath)).toBe(true);

      await client.close();
    },
    60000,
  );

  testInTempDirs(
    "task_write_body replaces the body and leaves the frontmatter alone",
    async () => {
      // Given a task an agent is already working on
      const fixture = makeFixture();
      const id = readyTask(fixture, "A task");
      const client = await connect(fixture);

      // When the manager rewrites its body
      await client.callTool({
        name: "task_write_body",
        arguments: { id, body: "# Goal\n\nRewritten by the manager." },
      });

      // Then the prose is replaced and the task stays where it was
      const document = fs.readFileSync(
        activeTaskPath(fixture.tasksDir, id),
        "utf-8",
      );
      expect(document).toContain("Rewritten by the manager.");
      expect(document).toContain("state: WORK");

      await client.close();
    },
    60000,
  );

  testInTempDirs(
    "a transition the state does not allow comes back as an error, not a mutation",
    async () => {
      // Given a task an agent is working on, which cannot be resumed
      const fixture = makeFixture();
      const id = readyTask(fixture, "A task");
      const client = await connect(fixture);

      // When the manager tries to resume it
      const result = await client.callTool({
        name: "task_resume",
        arguments: { id },
      });

      // Then the tool call comes back as an error naming the state
      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain(
        'Transition "resume" is not valid from state "WORK"',
      );

      // Then the document is untouched, so a refusal changes nothing
      const document = fs.readFileSync(
        activeTaskPath(fixture.tasksDir, id),
        "utf-8",
      );
      expect(document).toContain("state: WORK");

      await client.close();
    },
    60000,
  );

  testInTempDirs(
    "a task is authored by creating it, writing its body and submitting it",
    async () => {
      // Given a project with no tasks in it yet
      const fixture = makeFixture();
      const client = await connect(fixture);

      // Given a task created with a goal and a check, waiting to be submitted
      const created = JSON.parse(
        textOf(
          await client.callTool({
            name: "task_create",
            arguments: { title: "new work" },
          }),
        ),
      );
      await client.callTool({
        name: "task_write_body",
        arguments: { id: created.id, body: "# Goal\n\nDo it." },
      });
      editTaskFile(fixture, created.id, (meta) => {
        meta.checks = ["bun test"];
      });

      // When the manager submits it
      const done = JSON.parse(
        textOf(
          await client.callTool({
            name: "task_submit",
            arguments: { id: created.id },
          }),
        ),
      );

      // Then it enters the pipeline at the design phase
      expect(done.from).toBe("NEW");
      expect(done.to).toBe("DESIGN");

      await client.close();
    },
    60000,
  );

  testInTempDirs(
    "a task with dependencies is submitted into BLOCKED",
    async () => {
      // Given a task edited to depend on another that is still open
      const fixture = makeFixture();
      const dep = readyTask(fixture, "the dependency");
      const client = await connect(fixture);
      const created = JSON.parse(
        textOf(
          await client.callTool({
            name: "task_create",
            arguments: { title: "the dependent" },
          }),
        ),
      );
      editTaskFile(fixture, created.id, (meta) => {
        meta.depends_on = [dep];
      });

      // When the manager submits it
      const done = JSON.parse(
        textOf(
          await client.callTool({
            name: "task_submit",
            arguments: { id: created.id },
          }),
        ),
      );
      // Then it waits rather than being dispatched
      expect(done.from).toBe("NEW");
      expect(done.to).toBe("BLOCKED");

      await client.close();
    },
    60000,
  );

  testInTempDirs(
    "task_submit refuses a task that depends on itself in a loop",
    async () => {
      // Given two tasks edited to depend on each other
      const fixture = makeFixture();
      const client = await connect(fixture);
      const first = JSON.parse(
        textOf(
          await client.callTool({
            name: "task_create",
            arguments: { title: "the first half" },
          }),
        ),
      );
      const second = JSON.parse(
        textOf(
          await client.callTool({
            name: "task_create",
            arguments: { title: "the second half" },
          }),
        ),
      );
      editTaskFile(fixture, first.id, (meta) => {
        meta.depends_on = [second.id];
      });
      editTaskFile(fixture, second.id, (meta) => {
        meta.depends_on = [first.id];
      });

      // When the manager submits one of them
      const refused = await client.callTool({
        name: "task_submit",
        arguments: { id: first.id },
      });

      // Then it is refused, naming the cycle, and the task does not move
      expect(textOf(refused)).toContain("dependency cycle");
      expect(textOf(refused)).toContain(second.id);
      expect(
        readTaskFile(activeTaskPath(fixture.tasksDir, first.id)).meta.state,
      ).toBe("NEW");

      await client.close();
    },
    60000,
  );

  testInTempDirs(
    "task_submit from MANAGER_REVIEW lands the work and closes the task",
    async () => {
      const fixture = makeFixture();
      const id = readyTask(fixture, "A task");
      setPlan(fixture, {
        [id]: {
          WORK: [
            {
              submit: true,
              notes: "did the work",
              commit: { path: "a.txt", contents: "a" },
            },
          ],
          WORK_REVIEW: [{ submit: true }],
        },
      });

      // Given work that has been reviewed and is waiting on the manager
      const server = await serverFor(fixture);
      server.setSchedulerEnabled(true);
      await reaches(server, id, "MANAGER_REVIEW");
      server.shutdown();
      const client = await connect(fixture);

      // When the manager accepts it
      const result = JSON.parse(
        textOf(
          await client.callTool({ name: "task_submit", arguments: { id } }),
        ),
      );

      // Then the task closes and its work is on the base branch
      expect(result.to).toBe("CLOSED");
      expect(fs.existsSync(closedTaskPath(fixture.tasksDir, id))).toBe(true);
      expect(fs.existsSync(path.join(fixture.repo, "a.txt"))).toBe(true);

      await client.close();
    },
    60000,
  );

  testInTempDirs(
    "the views are readable as resources and carry a cursor",
    async () => {
      // Given a project with a task in it
      const fixture = makeFixture();
      readyTask(fixture, "A task");
      const client = await connect(fixture);

      // Given another task created beside the first
      await client.callTool({
        name: "task_create",
        arguments: { title: "another" },
      });

      // When the tasks view is read as a resource
      const parsed = await resourceOf(
        client,
        "orchestrator://tasks",
        z.looseObject({ seq: z.number(), tasks: z.array(TaskRow) }),
      );

      // Then the tasks view carries rows and a cursor the manager can track
      expect(parsed.seq).toBeGreaterThan(0);
      expect(Array.isArray(parsed.tasks)).toBe(true);

      // Then the runtime directory is named, so logs can be read from outside
      const workspace = await client.readResource({
        uri: "orchestrator://workspace_path",
      });
      expect(TextBlocks.parse(workspace.contents)[0]!.text).toContain(
        "task-graph-server",
      );

      await client.close();
    },
    60000,
  );

  testInTempDirs(
    "disable_agent and enable_agent move every slot of one agent",
    async () => {
      // Given a pool of two agents, one of them with two slots
      const fixture = makeFixture();
      fs.writeFileSync(
        defaultAgentsPath(fixture.tasksDir),
        JSON.stringify({
          agents: [
            { type: "pi", provider: "a", model: "a", slots: 2 },
            { type: "pi", provider: "b", model: "b", slots: 1 },
          ],
        }),
      );
      const client = await connect(fixture);

      // When the manager disables one of the agents
      const disabled = z.array(SlotRow).parse(
        JSON.parse(
          textOf(
            await client.callTool({
              name: "disable_agent",
              arguments: { agent: "pi-a-a" },
            }),
          ),
        ),
      );

      // Then every slot of that agent is disabled, and no other agent's is
      expect(disabled.map((row) => row.name)).toEqual(["pi-a-a-1", "pi-a-a-2"]);
      expect(disabled.every((row) => row.state === "DISABLED")).toBe(true);

      const view = await resourceOf(client, "orchestrator://slots", SlotsView);
      expect(view.slots.map((slot) => [slot.name, slot.state])).toEqual([
        ["pi-a-a-1", "DISABLED"],
        ["pi-a-a-2", "DISABLED"],
        ["pi-b-b-1", "IDLE"],
      ]);

      // Then enabling it again returns every one of its slots to the queue
      const enabled = z.array(SlotRow).parse(
        JSON.parse(
          textOf(
            await client.callTool({
              name: "enable_agent",
              arguments: { agent: "pi-a-a" },
            }),
          ),
        ),
      );
      expect(enabled.every((row) => row.state === "IDLE")).toBe(true);

      await client.close();
    },
    60000,
  );

  testInTempDirs(
    "the pool is read from the tasks directory",
    async () => {
      // Given a pool file written into the project's task directory
      const fixture = makeFixture();
      fs.writeFileSync(
        defaultAgentsPath(fixture.tasksDir),
        JSON.stringify({
          agents: [{ type: "pi", provider: "tasks", model: "tasks", slots: 2 }],
        }),
      );
      const client = await connect(fixture);

      // When the manager reads the slots view
      const view = await resourceOf(client, "orchestrator://slots", SlotsView);

      // Then the slots come from that file, so the pool travels with the graph
      expect(view.slots.map((slot) => slot.name)).toEqual([
        "pi-tasks-tasks-1",
        "pi-tasks-tasks-2",
      ]);

      await client.close();
    },
    60000,
  );

  testInTempDirs(
    "task_hold parks a task with the manager's reason on it",
    async () => {
      // Given a task an agent is working on
      const fixture = makeFixture();
      const id = readyTask(fixture, "A task");
      const client = await connect(fixture);

      // When the manager parks it
      const result = JSON.parse(
        textOf(
          await client.callTool({
            name: "task_hold",
            arguments: { id, reason: "the staging database is unreachable" },
          }),
        ),
      );

      // Then it lands in the held state of the phase it was in
      expect(result.to).toBe("HELD_WORK");

      // Then the reason it was parked is on the document for a person to read
      const document = fs.readFileSync(
        activeTaskPath(fixture.tasksDir, id),
        "utf-8",
      );
      expect(document).toContain("the staging database is unreachable");

      await client.close();
    },
    60000,
  );

  testInTempDirs(
    "task_resume sends a held task back to the phase it was held from",
    async () => {
      // Given a task the manager parked while it was being worked on
      const fixture = makeFixture();
      const id = readyTask(fixture, "A task");
      const client = await connect(fixture);
      await client.callTool({
        name: "task_hold",
        arguments: { id, reason: "the staging database is unreachable" },
      });

      // When the manager resumes it, having decided the wall is gone
      const result = JSON.parse(
        textOf(
          await client.callTool({ name: "task_resume", arguments: { id } }),
        ),
      );

      // Then it goes back to the phase it was parked from, ready to dispatch
      expect(result.from).toBe("HELD_WORK");
      expect(result.to).toBe("WORK");

      await client.close();
    },
    60000,
  );

  testInTempDirs("task_abort closes a held task for good", async () => {
    // Given a task the manager parked and has decided against
    const fixture = makeFixture();
    const id = readyTask(fixture, "A task");
    const client = await connect(fixture);
    await client.callTool({
      name: "task_hold",
      arguments: { id, reason: "the wrong shape entirely" },
    });

    // When the manager throws it away
    const result = JSON.parse(
      textOf(await client.callTool({ name: "task_abort", arguments: { id } })),
    );

    // Then it is closed, and leaves the pipeline without being worked further
    expect(result.to).toBe("CLOSED");

    await client.close();
  });

  testInTempDirs(
    "enable_scheduler is published where the console reads it",
    async () => {
      // Given a server that starts with nothing being dispatched
      const fixture = makeFixture();
      const client = await connect(fixture);

      // When the manager turns dispatching on
      await client.callTool({ name: "enable_scheduler", arguments: {} });

      // Then the next published queue says the scheduler is dispatching
      expect(await schedulingOf(client)).toBe(true);

      await client.close();
    },
    60000,
  );

  testInTempDirs(
    "disable_scheduler is published where the console reads it",
    async () => {
      // Given a server that has been dispatching
      const fixture = makeFixture();
      const client = await connect(fixture);
      await client.callTool({ name: "enable_scheduler", arguments: {} });
      expect(await schedulingOf(client)).toBe(true);

      // When the manager pauses it
      await client.callTool({ name: "disable_scheduler", arguments: {} });

      // Then the next published queue says the scheduler is paused
      expect(await schedulingOf(client)).toBe(false);

      await client.close();
    },
    60000,
  );

  testInTempDirs(
    "the error resource is empty while the server is working",
    async () => {
      // Given a server that started cleanly
      const fixture = makeFixture();
      const client = await connect(fixture);

      // When the manager reads the error resource
      const error = await resourceOf(
        client,
        "orchestrator://error",
        z.looseObject({ error: z.string().nullable() }),
      );

      // Then there is no error on it
      expect(error.error).toBeNull();

      await client.close();
    },
    60000,
  );

  testInTempDirs("slot_abort refuses a slot that is idle", async () => {
    // Given a pool whose slots are all sitting idle
    const fixture = makeFixture();
    const client = await connect(fixture);
    const slots = (await resourceOf(client, "orchestrator://slots", SlotsView))
      .slots;

    // When the manager aborts one of them
    const result = await client.callTool({
      name: "slot_abort",
      arguments: { slot: slots[0]!.name },
    });

    // Then it is refused, because there is no command of its own to kill
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain(`${slots[0]!.name} is not running`);

    await client.close();
  });

  testInTempDirs(
    "slot_abort names the pool when the slot is unknown",
    async () => {
      // Given a server whose pool holds one slot
      const fixture = makeFixture();
      const client = await connect(fixture);

      // When the manager aborts a slot that does not exist
      const result = await client.callTool({
        name: "slot_abort",
        arguments: { slot: "pi-fake-fake9" },
      });

      // Then the refusal lists the slots there are, so the name is easy to fix
      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain('no agent slot named "pi-fake-fake9"');

      await client.close();
    },
  );
});

describe("Feature: a server that could not start", () => {
  function brokenPool(): Fixture {
    const fixture = makeFixture();
    fs.mkdirSync(fixture.tasksDir, { recursive: true });
    fs.writeFileSync(
      defaultAgentsPath(fixture.tasksDir),
      '{ "agents": [{ "type": "pi" }] }',
    );
    return fixture;
  }

  testInTempDirs(
    "the error resource says why the server did not start",
    async () => {
      // Given a project whose pool file the server refuses to load
      const fixture = brokenPool();
      const client = await connect(fixture);

      // When the manager reads the error resource
      const error = await resourceOf(
        client,
        "orchestrator://error",
        z.looseObject({ error: z.string().nullable() }),
      );

      // Then it says the server failed to start, and what the pool file lacks
      expect(error.error).toContain("the server failed to start");
      expect(error.error).toContain("agents[0].provider");

      await client.close();
    },
    60000,
  );

  testInTempDirs(
    "a tool fails with that error rather than killing the server",
    async () => {
      // Given a project whose pool file the server refuses to load
      const fixture = brokenPool();
      const client = await connect(fixture);

      // When the manager creates a task
      const result = await client.callTool({
        name: "task_create",
        arguments: { title: "a task" },
      });

      // Then the call comes back as an error, and the server is still answering
      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain("the server failed to start");
      expect((await client.listTools()).tools.length).toBeGreaterThan(0);

      await client.close();
    },
    60000,
  );

  testInTempDirs(
    "a view resource fails with that error rather than reading nothing",
    async () => {
      // Given a project whose pool file the server refuses to load
      const fixture = brokenPool();
      const client = await connect(fixture);

      // When the manager reads the slots view
      const attempt = client.readResource({ uri: "orchestrator://slots" });

      // Then it is refused with why the server did not start
      await expect(attempt).rejects.toThrow(/the server failed to start/);

      await client.close();
    },
    60000,
  );
});
