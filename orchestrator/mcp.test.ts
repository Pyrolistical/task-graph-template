import { afterEach, describe, expect } from "bun:test";
import { test } from "./temp.ts";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import fs from "node:fs";
import path from "node:path";
import { applyTransition } from "./transition.ts";
import { takeClaim } from "./claim.ts";
import { readTaskFile } from "./task.ts";
import { repoKey } from "./runtime.ts";
import {
  type Fixture,
  makeFixture,
  readyTask,
  setPlan,
  writeOverride,
} from "./fixture.ts";
import { editTaskFile, reaches, serverFor } from "./server-jig.ts";

const openClients: Client[] = [];

afterEach(async () => {
  for (const client of openClients.splice(0)) {
    await client.close().catch(() => {});
  }
});

describe("the mcp surface", () => {
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
        args: [path.join(import.meta.dir, "mcp.ts"), fixture.tasksDir],
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

  test("the manager gets one tool per judgement it can make, plus the views", async () => {
    const fixture = makeFixture();
    const client = await connect(fixture);

    expect((await client.listTools()).tools.map((t) => t.name).sort()).toEqual([
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
    expect(
      (await client.listResources()).resources.map((r) => r.uri).sort(),
    ).toEqual([
      "orchestrator://agents",
      "orchestrator://checks",
      "orchestrator://inbox",
      "orchestrator://paths",
      "orchestrator://queue",
      "orchestrator://tasks",
      "orchestrator://workspace_path",
    ]);

    const paths = await client.readResource({ uri: "orchestrator://paths" });
    const parsed = JSON.parse(
      (paths.contents as { text: string }[])[0]!.text,
    ) as Record<string, unknown>;
    expect(parsed.tasks_dir).toBe(fixture.tasksDir);
    expect(parsed.agents_file).toBe(path.join(fixture.tasksDir, "agents.json"));
    expect(parsed.overrides_prompts_dir).toBe(
      path.join(fixture.tasksDir, "prompts"),
    );

    await client.close();
  }, 60000);

  test("task_feedback sends the task back with the findings in the body and the queue", async () => {
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
    const result = await client.callTool({
      name: "task_feedback",
      arguments: { id, findings: ["the null case is untested"] },
    });
    expect(textOf(result)).toContain('"WORK"');

    const body = readTaskFile(path.join(fixture.tasksDir, `${id}.md`)).body;
    expect(body).toContain("# Review findings");
    expect(body).toContain("- the null case is untested");

    const queued = fs.readFileSync(
      path.join(
        fixture.serverRoot,
        repoKey(fixture.repo),
        id,
        "queue",
        "WORK.md",
      ),
      "utf-8",
    );
    expect(queued).toContain("the null case is untested");

    await client.close();
  }, 60000);

  test("reload_prompts picks up an override written after startup", async () => {
    const fixture = makeFixture();
    readyTask(fixture, "Do a thing");
    const client = await connect(fixture);

    const before = JSON.parse(
      textOf(await client.callTool({ name: "reload_prompts", arguments: {} })),
    );
    const override = path.join(fixture.tasksDir, "prompts", "WORK.md");
    expect(before).not.toContain(override);

    writeOverride(fixture, "prompts/WORK.md", "Start on ../ASSIGNMENT.md.\n");
    fs.mkdirSync(path.join(fixture.tasksDir, "prompts"), { recursive: true });
    fs.writeFileSync(override, "Start on ../ASSIGNMENT.md.\n");

    const after = JSON.parse(
      textOf(await client.callTool({ name: "reload_prompts", arguments: {} })),
    );
    expect(after).toContain(override);

    await client.close();
  }, 60000);

  test("task_create returns a path the manager can edit directly", async () => {
    const fixture = makeFixture();
    const client = await connect(fixture);

    const created = JSON.parse(
      textOf(
        await client.callTool({
          name: "task_create",
          arguments: { title: "new work" },
        }),
      ),
    );
    expect(created.id).toBe("000001");
    expect(fs.existsSync(created.filePath)).toBe(true);

    await client.close();
  }, 60000);

  test("task_write_body replaces the body and leaves the frontmatter alone", async () => {
    const fixture = makeFixture();
    const id = readyTask(fixture, "A task");
    const client = await connect(fixture);

    await client.callTool({
      name: "task_write_body",
      arguments: { id, body: "# Goal\n\nRewritten by the manager." },
    });

    const document = fs.readFileSync(
      path.join(fixture.tasksDir, `${id}.md`),
      "utf-8",
    );
    expect(document).toContain("Rewritten by the manager.");
    expect(document).toContain("state: WORK");

    await client.close();
  }, 60000);

  test("a transition the state does not allow comes back as an error, not a mutation", async () => {
    const fixture = makeFixture();
    const id = readyTask(fixture, "A task");
    const client = await connect(fixture);

    const result = await client.callTool({
      name: "task_resume",
      arguments: { id },
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain(
      'Transition "resume" is not valid from state "WORK"',
    );

    const document = fs.readFileSync(
      path.join(fixture.tasksDir, `${id}.md`),
      "utf-8",
    );
    expect(document).toContain("state: WORK");

    await client.close();
  }, 60000);

  test("authoring runs create → write body → submit", async () => {
    const fixture = makeFixture();
    const client = await connect(fixture);

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

    expect(done.from).toBe("NEW");
    expect(done.to).toBe("DESIGN");

    await client.close();
  }, 60000);

  test("a task with dependencies is submitted into BLOCKED", async () => {
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

    const done = JSON.parse(
      textOf(
        await client.callTool({
          name: "task_submit",
          arguments: { id: created.id },
        }),
      ),
    );
    expect(done.from).toBe("NEW");
    expect(done.to).toBe("BLOCKED");

    await client.close();
  }, 60000);

  test("task_submit refuses a task that depends on itself in a loop", async () => {
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

    const refused = await client.callTool({
      name: "task_submit",
      arguments: { id: first.id },
    });

    expect(textOf(refused)).toContain("dependency cycle");
    expect(textOf(refused)).toContain(second.id);
    expect(
      readTaskFile(path.join(fixture.tasksDir, `${first.id}.md`)).meta.state,
    ).toBe("NEW");

    await client.close();
  }, 60000);

  test("task_submit from MANAGER_REVIEW lands the work and closes the task", async () => {
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

    const server = await serverFor(fixture);
    server.setSchedulerEnabled(true);
    await reaches(server, id, "MANAGER_REVIEW");
    server.setSchedulerEnabled(false);

    const client = await connect(fixture);
    const result = JSON.parse(
      textOf(await client.callTool({ name: "task_submit", arguments: { id } })),
    );

    expect(result.to).toBe("CLOSED");
    expect(
      fs.existsSync(path.join(fixture.tasksDir, "closed", `${id}.md`)),
    ).toBe(true);
    expect(fs.existsSync(path.join(fixture.repo, "a.txt"))).toBe(true);

    await client.close();
    server.shutdown();
  }, 60000);

  test("the views are readable as resources and carry a cursor", async () => {
    const fixture = makeFixture();
    readyTask(fixture, "A task");
    const client = await connect(fixture);

    await client.callTool({
      name: "task_create",
      arguments: { title: "another" },
    });

    const view = await client.readResource({ uri: "orchestrator://tasks" });
    const parsed = JSON.parse((view.contents as { text: string }[])[0]!.text);
    expect(parsed.seq).toBeGreaterThan(0);
    expect(Array.isArray(parsed.tasks)).toBe(true);

    const workspace = await client.readResource({
      uri: "orchestrator://workspace_path",
    });
    expect((workspace.contents as { text: string }[])[0]!.text).toContain(
      "task-graph-server",
    );

    await client.close();
  }, 60000);

  test("disable_agent and enable_agent move every slot of one agent", async () => {
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

    const disabled = JSON.parse(
      textOf(
        await client.callTool({
          name: "disable_agent",
          arguments: { agent: "pi-a-a" },
        }),
      ),
    ) as { name: string; state: string; enabled: boolean }[];

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
  }, 60000);

  test("the pool is read from the tasks directory", async () => {
    const fixture = makeFixture();
    fs.writeFileSync(
      path.join(fixture.tasksDir, "agents.json"),
      JSON.stringify({
        agents: [{ type: "pi", provider: "tasks", model: "tasks", slots: 2 }],
      }),
    );
    const client = await connect(fixture);

    const view = await client.readResource({ uri: "orchestrator://agents" });
    const parsed = JSON.parse((view.contents as { text: string }[])[0]!.text);
    expect(parsed.agents.map((agent: { name: string }) => agent.name)).toEqual([
      "pi-tasks-tasks-1",
      "pi-tasks-tasks-2",
    ]);

    await client.close();
  }, 60000);
});
