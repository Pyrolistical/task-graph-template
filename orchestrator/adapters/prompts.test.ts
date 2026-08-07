import { describe, expect } from "bun:test";
import { tempDir, testInTempDirs } from "../testing/temp-dirs.ts";
import fs from "node:fs";
import path from "node:path";
import { ISSUES } from "../domain/issues.ts";
import { Prompts } from "./prompts.ts";
import { RESULT_TOOLS, resultFromCall } from "../domain/results.ts";
import { render } from "../domain/template.ts";
import { LOOP_LIMIT } from "../domain/protocol.ts";
import { ORCHESTRATOR_DIR } from "../testing/graph-jig.ts";
import { templateOf } from "../testing/orchestrator-jig.ts";
import {
  type ClaimState,
  AGENT_STATES,
  REVIEW_STATES,
  STAGE_OF,
} from "../domain/state-machine.ts";

interface Schema {
  properties: Record<string, unknown>;
  required?: string[];
  additionalProperties?: boolean;
}

interface ToolResult {
  content: { type: string; text: string }[];
  terminate: boolean;
}

interface Tool {
  name: string;
  parameters: Schema;
  execute: (
    toolCallId: string,
    params: Record<string, unknown>,
  ) => Promise<ToolResult>;
}

async function toolsOf(state: ClaimState): Promise<Map<string, Tool>> {
  const { default: factory } = await import(
    `../result-tools-${STAGE_OF[state].tools}.ts`
  );
  const tools = new Map<string, Tool>();
  factory({
    registerTool: (tool: Tool) => tools.set(tool.name, tool),
  } as never);
  return tools;
}

function textOf(result: ToolResult): string {
  return result.content[0]!.text;
}

function overrides(files: Record<string, string>): string {
  const dir = tempDir("orchestrator-overrides-");
  for (const [name, contents] of Object.entries(files)) {
    const file = path.join(dir, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, contents, "utf-8");
  }
  return dir;
}

describe("Feature: overriding the words an agent reads", () => {
  testInTempDirs(
    "a project with no overrides reads every prompt as shipped",
    () => {
      // Given a prompt store pointed at the orchestrator and nowhere else
      const prompts = new Prompts(ORCHESTRATOR_DIR);

      // When a fragment is asked for
      const fragment = prompts.fragment("WORK");

      // Then it is the orchestrator's own copy of it
      expect(fragment).toBe(templateOf("prompts/WORK.md"));
    },
  );

  testInTempDirs("a project's own copy of a prompt wins", () => {
    // Given a project that carries its own WORK prompt
    const dir = overrides({ "prompts/WORK.md": "you are an implementer\n" });

    // When the fragment is asked for
    const fragment = new Prompts(ORCHESTRATOR_DIR, dir).fragment("WORK");

    // Then the project's words are what the agent will read
    expect(fragment).toBe("you are an implementer\n");
  });

  testInTempDirs("overriding one prompt leaves every other one alone", () => {
    // Given a project that overrides only the WORK prompt
    const dir = overrides({ "prompts/WORK.md": "do it\n" });
    const prompts = new Prompts(ORCHESTRATOR_DIR, dir);

    // When the other prompts are asked for
    const others = [
      prompts.fragment("WORK_REVIEW"),
      prompts.issue("looping", "WORK", {
        command: "bun test",
        limit: LOOP_LIMIT,
      }),
    ];

    // Then each still comes from the orchestrator, rendered as it always was
    expect(others).toEqual([
      templateOf("prompts/WORK_REVIEW.md"),
      render(templateOf("prompts/looping-WORK.md"), {
        command: "bun test",
        limit: LOOP_LIMIT,
      }),
    ]);
  });

  testInTempDirs(
    "an override is given the variables the shipped one is",
    () => {
      // Given a project override that uses the variables of the file it replaces
      const dir = overrides({
        "prompts/check-failed.md":
          "{{#failures}}\nbroke {{command}}\n{{/failures}}\n",
      });

      // When it is rendered with a failed check
      const rendered = new Prompts(ORCHESTRATOR_DIR, dir).fragment(
        "check-failed",
        {
          failures: [{ command: "bun test", exit_code: "1", output: "boom" }],
        },
      );

      // Then the project's wording is filled in from the same variables
      expect(rendered).toBe("broke bun test\n");
    },
  );

  testInTempDirs(
    "a prompt edited under a running server is not picked up",
    () => {
      // Given a prompt store that has already cached an override
      const dir = overrides({ "prompts/WORK.md": "one\n" });
      const prompts = new Prompts(ORCHESTRATOR_DIR, dir);

      // When the file on disk is edited
      fs.writeFileSync(path.join(dir, "prompts", "WORK.md"), "two\n");

      // Then agents keep reading the cached copy, so a half-saved edit cannot leak
      expect(prompts.fragment("WORK")).toBe("one\n");
    },
  );

  testInTempDirs("reloading picks up an edited override", () => {
    // Given a prompt store whose cached override has since been edited
    const dir = overrides({ "prompts/WORK.md": "one\n" });
    const prompts = new Prompts(ORCHESTRATOR_DIR, dir);
    fs.writeFileSync(path.join(dir, "prompts", "WORK.md"), "two\n");

    // When the store is reloaded
    const cached = prompts.reload();

    // Then the edit is cached and named among the files now in use
    expect(cached).toContain(path.join(dir, "prompts", "WORK.md"));
    expect(prompts.fragment("WORK")).toBe("two\n");
  });

  testInTempDirs("reloading after a deleted override falls back again", () => {
    // Given a prompt store whose override has since been deleted
    const dir = overrides({ "prompts/WORK.md": "one\n" });
    const prompts = new Prompts(ORCHESTRATOR_DIR, dir);
    fs.rmSync(path.join(dir, "prompts", "WORK.md"));

    // When the store is reloaded
    const cached = prompts.reload();

    // Then the orchestrator's own copy is back in use, and no longer named
    expect(cached).not.toContain(path.join(dir, "prompts", "WORK.md"));
    expect(prompts.fragment("WORK")).toBe(templateOf("prompts/WORK.md"));
  });

  testInTempDirs("a prompt in neither directory names both of them", () => {
    // Given a project with no overrides at all
    const dir = overrides({});

    // When a prompt that exists nowhere is asked for
    const attempt = () => new Prompts(ORCHESTRATOR_DIR, dir).fragment("nope");

    // Then both places it looked are named, so the typo is easy to find
    expect(attempt).toThrow(
      new RegExp(
        `no prompts/nope.md in ${path.join(dir, "prompts")} or ${path.join(ORCHESTRATOR_DIR, "prompts")}`,
      ),
    );
  });
});

describe("Feature: filling a prompt in", () => {
  testInTempDirs(
    "a template asking for something it was not given fails",
    () => {
      // Given a template that refers to a variable
      const template = "agent: {{agent}}\n";

      // When it is rendered without that variable
      const attempt = () => render(template, {});

      // Then it fails and names what was missing, rather than rendering a blank
      expect(attempt).toThrow(/refers to "agent"/);
    },
  );

  testInTempDirs("a section that is never closed fails", () => {
    // Given a template with an unclosed section in it
    const template = "{{#todos}}\n- x\n";

    // When the template is rendered
    const attempt = () => render(template, { todos: [] });

    // Then it fails and names the section, rather than swallowing the rest
    expect(attempt).toThrow(/never closes "todos"/);
  });
});

describe("Feature: the issues an agent is sent back for", () => {
  testInTempDirs("an agent that says it is blocked is asked only once", () => {
    // Given the issue raised when an agent reports it cannot continue
    const blocked = ISSUES.blocked;

    // When its budget of retries is read
    const attempts = blocked.attempts;

    // Then it gets a single attempt, because it is a claim about the world
    expect(attempts).toBe(1);
  });

  testInTempDirs("an agent that broke a rule is nudged four times", () => {
    // Given the issues that mean the agent broke a rule of the pipeline
    const names = [
      "missing-result",
      "missing-todos",
      "missing-notes",
      "modified-assignment",
      "uncommitted",
      "modified-worktree",
    ] as const;

    // When each budget of retries is read
    const attempts = names.map((name) => ISSUES[name].attempts);

    // Then each is nudged the same four times before the task is held
    expect(attempts).toEqual([4, 4, 4, 4, 4, 4]);
  });

  testInTempDirs("a loop is worth fewer nudges, being dearer to reach", () => {
    // Given the issue raised when an agent repeats one command
    const looping = ISSUES.looping;

    // When its budget is compared with the cheapest and the dearest issues
    const between = [
      looping.attempts < ISSUES.uncommitted.attempts,
      looping.attempts > ISSUES.blocked.attempts,
    ];

    // Then it sits between them, because each retry costs a whole turn
    expect(between).toEqual([true, true]);
  });

  testInTempDirs("a held task says which rule the agent broke", () => {
    // Given the issues raised when an agent submits without doing its part
    const issues = [
      ISSUES["missing-todos"].held(""),
      ISSUES["modified-assignment"].held(""),
      ISSUES["missing-design"].held(""),
      ISSUES["modified-worktree"].held("2 files"),
    ];

    // When each writes the reason the task will be held with
    const reasons = issues;

    // Then each reads as something a person can act on without the transcript
    expect(reasons[0]).toBe(
      "the planner submitted without appending a todo list to the assignment",
    );
    expect(reasons[1]).toContain(
      "only the section it was instructed to write may be appended",
    );
    expect(reasons[2]).toBe(
      "the designer submitted without appending a design section to the assignment",
    );
    expect(reasons[3]).toBe(
      "the agent wrote to the worktree during design or planning: 2 files",
    );
  });

  testInTempDirs("a blocked task is held with the agent's own words", () => {
    // Given an agent that reported what is standing in its way
    const message = "the box is down";

    // When the task is held for it
    const reason = ISSUES.blocked.held(message);

    // Then the manager reads what the agent said, not a paraphrase of it
    expect(reason).toBe(message);
  });

  testInTempDirs(
    "every issue has a prompt for every state that raises it",
    () => {
      // Given every issue and the states it can be raised in
      const wanted = Object.values(ISSUES).flatMap((issue) =>
        issue.states.map((state) =>
          path.join(ORCHESTRATOR_DIR, "prompts", `${issue.fragment(state)}.md`),
        ),
      );

      // When each fragment it names is looked for on disk
      const missing = wanted.filter((file) => !fs.existsSync(file));

      // Then every one of them is there, so no issue can be raised wordlessly
      expect(missing).toEqual([]);
    },
  );
});

describe("Feature: what an agent's result tool call means", () => {
  testInTempDirs(
    "a submit from WORK, which writes rather than reviews, carries nothing else",
    () => {
      // Given WORK, the state an agent writes the work in
      const writing = "WORK";

      // When an agent in that state submits its work
      const result = resultFromCall(writing, { tool: "submit", args: {} });

      // Then it is a plain submit, carrying no findings
      expect(result).toEqual({ type: "submit", findings: [] });
    },
  );

  testInTempDirs(
    "a submit from PLAN, which writes rather than reviews, carries nothing else",
    () => {
      // Given PLAN, the state an agent writes the plan in
      const writing = "PLAN";

      // When an agent in that state submits its work
      const result = resultFromCall(writing, { tool: "submit", args: {} });

      // Then it is a plain submit, carrying no findings
      expect(result).toEqual({ type: "submit", findings: [] });
    },
  );

  testInTempDirs(
    "a submit from DESIGN, which writes rather than reviews, carries nothing else",
    () => {
      // Given DESIGN, the state an agent writes the design in
      const writing = "DESIGN";

      // When an agent in that state submits its work
      const result = resultFromCall(writing, { tool: "submit", args: {} });

      // Then it is a plain submit, carrying no findings
      expect(result).toEqual({ type: "submit", findings: [] });
    },
  );

  testInTempDirs("a review submit carries the findings it was given", () => {
    // Given the states an agent reviews in
    const states = REVIEW_STATES;

    // When each submits a review that found one problem
    const results = states.map((state) =>
      resultFromCall(state, {
        tool: "submit",
        args: { findings: ["the null case is untested"] },
      }),
    );

    // Then every one of them comes back carrying that finding
    expect(results).toEqual(
      states.map(() => ({
        type: "submit",
        findings: ["the null case is untested"],
      })),
    );
  });

  testInTempDirs("an agent in any state can report itself blocked", () => {
    // Given every state an agent runs in
    const states = AGENT_STATES;

    // When each calls the blocked tool
    const results = states.map((state) =>
      resultFromCall(state, {
        tool: "blocked",
        args: { message: "the box is down" },
      }),
    );

    // Then each reads as blocked, carrying what the agent said
    expect(results).toEqual(
      states.map(() => ({ type: "blocked", message: "the box is down" })),
    );
  });

  testInTempDirs("every state loads its own extension of result tools", () => {
    // Given every state an agent runs in
    const states = AGENT_STATES;

    // When the extension each is spawned with is resolved
    const files = states.map((state) => STAGE_OF[state].tools);

    // Then no two states share one, and every file it names is on disk
    expect(new Set(files).size).toBe(states.length);
    expect(
      files.filter(
        (file) =>
          !fs.existsSync(
            path.join(ORCHESTRATOR_DIR, `result-tools-${file}.ts`),
          ),
      ),
    ).toEqual([]);
  });

  testInTempDirs(
    "each state's submit tool accepts exactly the fields its stage produces",
    async () => {
      // Given the fields each stage's submit is meant to carry
      const shapes: Record<string, string[]> = {
        DESIGN: [],
        PLAN: [],
        WORK: [],
        DESIGN_REVIEW: ["findings"],
        PLAN_REVIEW: ["findings"],
        WORK_REVIEW: ["findings"],
      };

      // When the extension of each state is loaded and its tools read
      const declared = [];
      for (const state of AGENT_STATES) {
        const tools = await toolsOf(state);
        const submit = tools.get("submit")!.parameters;
        declared.push({
          state,
          tools: [...tools.keys()].sort(),
          blocked: tools.get("blocked")!.parameters.required,
          fields: Object.keys(submit.properties),
          required: submit.required ?? [],
          closed: submit.additionalProperties,
        });
      }

      // Then each state offers both result tools, and its submit is closed
      expect(declared).toEqual(
        AGENT_STATES.map((state) => ({
          state,
          tools: [...RESULT_TOOLS].sort(),
          blocked: ["message"],
          fields: shapes[state]!,
          required: shapes[state]!,
          closed: false,
        })),
      );
    },
  );

  testInTempDirs(
    "every result tool ends the turn it is called in",
    async () => {
      // Given every result tool of every state an agent runs in
      const called = [];
      for (const state of AGENT_STATES) {
        const tools = await toolsOf(state);

        // When each is called with arguments its state accepts
        called.push(await tools.get("submit")!.execute("id", { findings: [] }));
        called.push(
          await tools
            .get("blocked")!
            .execute("id", { message: "the box is down" }),
        );
      }

      // Then not one of them leaves the agent a turn to carry on in
      expect(called.map((result) => result.terminate)).toEqual(
        called.map(() => true),
      );
    },
  );

  testInTempDirs("a reviewer is told how many findings it filed", async () => {
    // Given a work reviewer that found two defects
    const tools = await toolsOf("WORK_REVIEW");

    // When it submits both of them
    const result = await tools
      .get("submit")!
      .execute("id", { findings: ["the null case is untested", "it leaks"] });

    // Then it reads back that the work was rejected, and by how much
    expect(textOf(result)).toBe("Work rejected with 2 finding(s).");
  });

  testInTempDirs("a reviewer that files nothing accepts the work", async () => {
    // Given a work reviewer that could fault nothing
    const tools = await toolsOf("WORK_REVIEW");

    // When it submits an empty list of findings
    const result = await tools.get("submit")!.execute("id", { findings: [] });

    // Then it reads back that it has accepted the work
    expect(textOf(result)).toBe("Work accepted.");
  });

  testInTempDirs(
    "an agent that stops on a wall is told who reads it",
    async () => {
      // Given a worker that cannot get past the thing in its way
      const tools = await toolsOf("WORK");

      // When it reports itself blocked
      const result = await tools
        .get("blocked")!
        .execute("id", { message: "the staging database is unreachable" });

      // Then it reads back that a person has the turn now
      expect(textOf(result)).toBe("Stopped: awaiting a person.");
    },
  );
});
