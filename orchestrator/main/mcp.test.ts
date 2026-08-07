import { afterEach, describe, expect } from "bun:test";
import { testInTempDirs } from "../testing/temp-dirs.ts";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import fs from "node:fs";
import path from "node:path";
import { applyTransition } from "../adapters/transition-store.ts";
import { takeClaim } from "../adapters/claim.ts";
import { readTaskFile } from "../adapters/task-store.ts";
import { repoKey } from "../adapters/runtime.ts";
import { readFindings } from "../adapters/findings.ts";
import {
  type Fixture,
  makeFixture,
  readyTask,
  setPlan,
  writeOverride,
} from "../testing/fixture.ts";
import { editTaskFile, reaches, serverFor } from "../testing/server-jig.ts";

const openClients: Client[] = [];

afterEach(async () => {
  for (const client of openClients.splice(0)) {
    await client.close().catch(() => {});
  }
});

describe("Feature: the tool surface the manager works through", () => {
  async function connect(fixture: Fixture, cwd = fixture.repo) {
    fs.mkdirSync(fixture.tasksDir, { recursive: true });
    const agentsPath = path.join(fixture.tasksDir, "agents.json");
    if (!fs.existsSync(agentsPath)) {
      fs.writeFileSync(
        agentsPath,
        JSON.stringify({
          agents: [{ type: "pi", provider: "fake", model: "fake", slots: 1 }],
        }),
      );
    }
    const client = new Client({ name: "test", version: "1.0.0" });
    openClients.push(client);
    await client.connect(
      new StdioClientTransport({
        command: "bun",
        args: [path.join(import.meta.dir, "../../mcp.ts"), fixture.tasksDir],
        cwd,
        env: {
          ...(process.env as Record<string, string>),
          TASK_GRAPH_SERVER_ROOT: fixture.serverRoot,
        },
      }),
    );
    return client;
  }

  function textOf(result: unknown): string {
    return (result as { content: { text: string }[] }).content[0]!.text;
  }

  testInTempDirs(
    "the manager gets one tool per judgement it can make, plus the views",
    async () => {
      // Given a server running over stdio against a project
      const fixture = makeFixture();
      const client = await connect(fixture);

      // When the manager asks what it can do and what it can read
      const tools = (await client.listTools()).tools.map((t) => t.name).sort();
      const resources = (await client.listResources()).resources
        .map((r) => r.uri)
        .sort();
      const paths = await client.readResource({ uri: "orchestrator://paths" });

      // Then there is one tool for each judgement only a person can make
      expect(tools).toEqual([
        "agent_abort",
        "disable_agent",
        "disable_scheduler",
        "enable_agent",
        "enable_scheduler",
        "reload_prompts",
        "task_abort",
        "task_create",
        "task_feedback",
        "task_hold",
        "task_resume",
        "task_submit",
        "task_write_body",
      ]);

      // Then every view the console draws is readable as a resource
      expect(resources).toEqual([
        "orchestrator://agents",
        "orchestrator://checks",
        "orchestrator://inbox",
        "orchestrator://paths",
        "orchestrator://queue",
        "orchestrator://tasks",
        "orchestrator://workspace_path",
      ]);

      // Then the manager is told where the graph, the pool and the prompts are
      const parsed = JSON.parse(
        (paths.contents as { text: string }[])[0]!.text,
      ) as Record<string, unknown>;
      expect(parsed.tasks_dir).toBe(fixture.tasksDir);
      expect(parsed.agents_file).toBe(
        path.join(fixture.tasksDir, "agents.json"),
      );
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
        agentName: "manager",
        pid: process.pid,
      });
      applyTransition(fixture.tasksDir, id, "submit", {
        body: readTaskFile(path.join(fixture.tasksDir, `${id}.md`)).body,
      });
      applyTransition(fixture.tasksDir, id, "pass", {});
      takeClaim(fixture.tasksDir, id, {
        agentName: "manager",
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
      const body = readTaskFile(path.join(fixture.tasksDir, `${id}.md`)).body;
      expect(body).toContain("# Review findings");
      expect(body).toContain("- the null case is untested");

      // Then the finding is also left where the next dispatch will read it
      const found = readFindings(
        path.join(
          fixture.serverRoot,
          repoKey(fixture.repo),
          id,
          "findings.json",
        ),
      );
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

      // When an override is written and the prompts are reloaded
      writeOverride(fixture, "prompts/WORK.md", "Start on ../ASSIGNMENT.md.\n");
      fs.mkdirSync(path.join(fixture.tasksDir, "prompts"), { recursive: true });
      fs.writeFileSync(override, "Start on ../ASSIGNMENT.md.\n");

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
        path.join(fixture.tasksDir, `${id}.md`),
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
        path.join(fixture.tasksDir, `${id}.md`),
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

      // When the manager creates a task, writes its goal and submits it
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
        readTaskFile(path.join(fixture.tasksDir, `${first.id}.md`)).meta.state,
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
      server.setSchedulerEnabled(false);
      const client = await connect(fixture);

      // When the manager accepts it
      const result = JSON.parse(
        textOf(
          await client.callTool({ name: "task_submit", arguments: { id } }),
        ),
      );

      // Then the task closes and its work is on the base branch
      expect(result.to).toBe("CLOSED");
      expect(
        fs.existsSync(path.join(fixture.tasksDir, "closed", `${id}.md`)),
      ).toBe(true);
      expect(fs.existsSync(path.join(fixture.repo, "a.txt"))).toBe(true);

      await client.close();
      server.shutdown();
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

      // When the manager creates another task and reads the views
      await client.callTool({
        name: "task_create",
        arguments: { title: "another" },
      });
      const view = await client.readResource({ uri: "orchestrator://tasks" });
      const workspace = await client.readResource({
        uri: "orchestrator://workspace_path",
      });

      // Then the tasks view carries rows and a cursor the manager can track
      const parsed = JSON.parse((view.contents as { text: string }[])[0]!.text);
      expect(parsed.seq).toBeGreaterThan(0);
      expect(Array.isArray(parsed.tasks)).toBe(true);

      // Then the runtime directory is named, so logs can be read from outside
      expect((workspace.contents as { text: string }[])[0]!.text).toContain(
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
        path.join(fixture.tasksDir, "agents.json"),
        JSON.stringify({
          agents: [
            { type: "pi", provider: "a", model: "a", slots: 2 },
            { type: "pi", provider: "b", model: "b", slots: 1 },
          ],
        }),
      );
      const client = await connect(fixture);

      // When the manager disables one of the agents
      const disabled = JSON.parse(
        textOf(
          await client.callTool({
            name: "disable_agent",
            arguments: { agent: "pi-a-a" },
          }),
        ),
      ) as { name: string; state: string; enabled: boolean }[];

      // Then every slot of that agent is disabled, and no other agent's is
      expect(disabled.map((row) => row.name)).toEqual(["pi-a-a-1", "pi-a-a-2"]);
      expect(disabled.every((row) => row.state === "DISABLED")).toBe(true);

      const view = await client.readResource({ uri: "orchestrator://agents" });
      const parsed = JSON.parse((view.contents as { text: string }[])[0]!.text);
      expect(
        parsed.agents.map((agent: { name: string; state: string }) => [
          agent.name,
          agent.state,
        ]),
      ).toEqual([
        ["pi-a-a-1", "DISABLED"],
        ["pi-a-a-2", "DISABLED"],
        ["pi-b-b-1", "IDLE"],
      ]);

      // Then enabling it again returns every one of its slots to the queue
      const enabled = JSON.parse(
        textOf(
          await client.callTool({
            name: "enable_agent",
            arguments: { agent: "pi-a-a" },
          }),
        ),
      ) as { state: string }[];
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
        path.join(fixture.tasksDir, "agents.json"),
        JSON.stringify({
          agents: [{ type: "pi", provider: "tasks", model: "tasks", slots: 2 }],
        }),
      );
      const client = await connect(fixture);

      // When the manager reads the agents view
      const view = await client.readResource({ uri: "orchestrator://agents" });

      // Then the slots come from that file, so the pool travels with the graph
      const parsed = JSON.parse((view.contents as { text: string }[])[0]!.text);
      expect(
        parsed.agents.map((agent: { name: string }) => agent.name),
      ).toEqual(["pi-tasks-tasks-1", "pi-tasks-tasks-2"]);

      await client.close();
    },
    60000,
  );
});
