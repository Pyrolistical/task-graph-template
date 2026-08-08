import { describe, expect } from "bun:test";
import { tempDir, testInTempDirs } from "../testing/temp-dirs.ts";
import fs from "node:fs";
import path from "node:path";
import { ISSUES } from "../domain/issues.ts";
import { Prompts } from "./prompts.ts";
import { resultFromCall } from "../domain/results.ts";
import { render } from "../domain/template.ts";
import { LOOP_LIMIT } from "../domain/protocol.ts";
import { ORCHESTRATOR_DIR } from "../testing/graph-jig.ts";
import { templateOf } from "../testing/orchestrator-jig.ts";
import {
  type ClaimState,
  CLAIM_STATES,
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

async function submitOf(state: ClaimState) {
  const tools = await toolsOf(state);
  const submit = tools.get("submit")!.parameters;
  return {
    tools: [...tools.keys()].sort(),
    blocked: tools.get("blocked")!.parameters.required,
    fields: Object.keys(submit.properties),
    required: submit.required ?? [],
    closed: submit.additionalProperties,
  };
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
      render(templateOf("prompts/looping.md"), {
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

  testInTempDirs(
    "an agent that left its todos missing is nudged four times",
    () => {
      // Given the issue raised when an agent submits without a todo list
      const missing = ISSUES["missing-todos"];

      // When its budget of retries is read
      const attempts = missing.attempts;

      // Then it is nudged four times before the task is held
      expect(attempts).toBe(4);
    },
  );

  testInTempDirs(
    "an agent that left its notes missing is nudged four times",
    () => {
      // Given the issue raised when an agent submits without notes
      const missing = ISSUES["missing-notes"];

      // When its budget of retries is read
      const attempts = missing.attempts;

      // Then it is nudged four times before the task is held
      expect(attempts).toBe(4);
    },
  );

  testInTempDirs(
    "an agent that modified its assignment is nudged four times",
    () => {
      // Given the issue raised when an agent rewrites its own assignment
      const modified = ISSUES["modified-assignment"];

      // When its budget of retries is read
      const attempts = modified.attempts;

      // Then it is nudged four times before the task is held
      expect(attempts).toBe(4);
    },
  );

  testInTempDirs("an agent that did not commit is nudged four times", () => {
    // Given the issue raised when an agent submits without committing
    const uncommitted = ISSUES.uncommitted;

    // When its budget of retries is read
    const attempts = uncommitted.attempts;

    // Then it is nudged four times before the task is held
    expect(attempts).toBe(4);
  });

  testInTempDirs(
    "an agent that changed the worktree is nudged four times",
    () => {
      // Given the issue raised when an agent writes outside its branch
      const modified = ISSUES["modified-worktree"];

      // When its budget of retries is read
      const attempts = modified.attempts;

      // Then it is nudged four times before the task is held
      expect(attempts).toBe(4);
    },
  );

  testInTempDirs("a missing result is nudged the longest", () => {
    // Given the issue raised when an agent settles without a result tool call
    const missing = ISSUES["missing-result"];

    // When its budget is compared with the issues that mean a rule was broken
    const budgets = [missing.attempts, ISSUES.uncommitted.attempts];

    // Then it gets twice as many, being the cheapest thing an agent can fix
    expect(budgets).toEqual([8, 4]);
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
      // Given every issue, named for each state an agent can be raised at in
      const wanted = Object.values(ISSUES).flatMap((issue) =>
        CLAIM_STATES.map((state) =>
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

  testInTempDirs(
    "a design review submit carries the findings it was given",
    () => {
      // Given a design reviewer that found one problem
      const state = "DESIGN_REVIEW";

      // When it submits a review carrying that finding
      const result = resultFromCall(state, {
        tool: "submit",
        args: { findings: ["the null case is untested"] },
      });

      // Then the finding comes back on the result
      expect(result).toEqual({
        type: "submit",
        findings: ["the null case is untested"],
      });
    },
  );

  testInTempDirs(
    "a plan review submit carries the findings it was given",
    () => {
      // Given a plan reviewer that found one problem
      const state = "PLAN_REVIEW";

      // When it submits a review carrying that finding
      const result = resultFromCall(state, {
        tool: "submit",
        args: { findings: ["the null case is untested"] },
      });

      // Then the finding comes back on the result
      expect(result).toEqual({
        type: "submit",
        findings: ["the null case is untested"],
      });
    },
  );

  testInTempDirs(
    "a work review submit carries the findings it was given",
    () => {
      // Given a work reviewer that found one problem
      const state = "WORK_REVIEW";

      // When it submits a review carrying that finding
      const result = resultFromCall(state, {
        tool: "submit",
        args: { findings: ["the null case is untested"] },
      });

      // Then the finding comes back on the result
      expect(result).toEqual({
        type: "submit",
        findings: ["the null case is untested"],
      });
    },
  );

  testInTempDirs("a designer that is stuck can report itself blocked", () => {
    // Given a designer that cannot get past the thing in its way
    const state = "DESIGN";

    // When it calls the blocked tool
    const result = resultFromCall(state, {
      tool: "blocked",
      args: { message: "the box is down" },
    });

    // Then it reads as blocked, carrying what the agent said
    expect(result).toEqual({ type: "blocked", message: "the box is down" });
  });

  testInTempDirs(
    "a design reviewer that is stuck can report itself blocked",
    () => {
      // Given a design reviewer that cannot get past the thing in its way
      const state = "DESIGN_REVIEW";

      // When it calls the blocked tool
      const result = resultFromCall(state, {
        tool: "blocked",
        args: { message: "the box is down" },
      });

      // Then it reads as blocked, carrying what the agent said
      expect(result).toEqual({ type: "blocked", message: "the box is down" });
    },
  );

  testInTempDirs("a planner that is stuck can report itself blocked", () => {
    // Given a planner that cannot get past the thing in its way
    const state = "PLAN";

    // When it calls the blocked tool
    const result = resultFromCall(state, {
      tool: "blocked",
      args: { message: "the box is down" },
    });

    // Then it reads as blocked, carrying what the agent said
    expect(result).toEqual({ type: "blocked", message: "the box is down" });
  });

  testInTempDirs(
    "a plan reviewer that is stuck can report itself blocked",
    () => {
      // Given a plan reviewer that cannot get past the thing in its way
      const state = "PLAN_REVIEW";

      // When it calls the blocked tool
      const result = resultFromCall(state, {
        tool: "blocked",
        args: { message: "the box is down" },
      });

      // Then it reads as blocked, carrying what the agent said
      expect(result).toEqual({ type: "blocked", message: "the box is down" });
    },
  );

  testInTempDirs("a worker that is stuck can report itself blocked", () => {
    // Given a runner that cannot get past the thing in its way
    const state = "WORK";

    // When it calls the blocked tool
    const result = resultFromCall(state, {
      tool: "blocked",
      args: { message: "the box is down" },
    });

    // Then it reads as blocked, carrying what the agent said
    expect(result).toEqual({ type: "blocked", message: "the box is down" });
  });

  testInTempDirs(
    "a work reviewer that is stuck can report itself blocked",
    () => {
      // Given a work reviewer that cannot get past the thing in its way
      const state = "WORK_REVIEW";

      // When it calls the blocked tool
      const result = resultFromCall(state, {
        tool: "blocked",
        args: { message: "the box is down" },
      });

      // Then it reads as blocked, carrying what the agent said
      expect(result).toEqual({ type: "blocked", message: "the box is down" });
    },
  );

  testInTempDirs(
    "a designer is loaded with the extension its stage names",
    () => {
      // Given the DESIGN stage of an agent
      const tools = STAGE_OF.DESIGN.tools;

      // When the extension file it names is looked for on disk
      const file = path.join(ORCHESTRATOR_DIR, `result-tools-${tools}.ts`);

      // Then it is the designer extension, and it is there to load
      expect(tools).toBe("designer");
      expect(fs.existsSync(file)).toBe(true);
    },
  );

  testInTempDirs(
    "a design reviewer is loaded with the extension its stage names",
    () => {
      // Given the DESIGN_REVIEW stage of an agent
      const tools = STAGE_OF.DESIGN_REVIEW.tools;

      // When the extension file it names is looked for on disk
      const file = path.join(ORCHESTRATOR_DIR, `result-tools-${tools}.ts`);

      // Then it is the review extension, and it is there to load
      expect(tools).toBe("design-reviewer");
      expect(fs.existsSync(file)).toBe(true);
    },
  );

  testInTempDirs(
    "a planner is loaded with the extension its stage names",
    () => {
      // Given the PLAN stage of an agent
      const tools = STAGE_OF.PLAN.tools;

      // When the extension file it names is looked for on disk
      const file = path.join(ORCHESTRATOR_DIR, `result-tools-${tools}.ts`);

      // Then it is the planner extension, and it is there to load
      expect(tools).toBe("planner");
      expect(fs.existsSync(file)).toBe(true);
    },
  );

  testInTempDirs(
    "a plan reviewer is loaded with the extension its stage names",
    () => {
      // Given the PLAN_REVIEW stage of an agent
      const tools = STAGE_OF.PLAN_REVIEW.tools;

      // When the extension file it names is looked for on disk
      const file = path.join(ORCHESTRATOR_DIR, `result-tools-${tools}.ts`);

      // Then it is the review extension, and it is there to load
      expect(tools).toBe("plan-reviewer");
      expect(fs.existsSync(file)).toBe(true);
    },
  );

  testInTempDirs(
    "a worker is loaded with the extension its stage names",
    () => {
      // Given the WORK stage of an agent
      const tools = STAGE_OF.WORK.tools;

      // When the extension file it names is looked for on disk
      const file = path.join(ORCHESTRATOR_DIR, `result-tools-${tools}.ts`);

      // Then it is the runner extension, and it is there to load
      expect(tools).toBe("worker");
      expect(fs.existsSync(file)).toBe(true);
    },
  );

  testInTempDirs(
    "a work reviewer is loaded with the extension its stage names",
    () => {
      // Given the WORK_REVIEW stage of an agent
      const tools = STAGE_OF.WORK_REVIEW.tools;

      // When the extension file it names is looked for on disk
      const file = path.join(ORCHESTRATOR_DIR, `result-tools-${tools}.ts`);

      // Then it is the review extension, and it is there to load
      expect(tools).toBe("work-reviewer");
      expect(fs.existsSync(file)).toBe(true);
    },
  );

  testInTempDirs(
    "a designer's submit tool carries nothing beyond the submit",
    async () => {
      // Given a designer, whose stage produces no findings
      const state = "DESIGN";

      // When the extension it is spawned with is loaded and its submit read
      const declared = await submitOf(state);

      // Then it offers both result tools, and its submit carries no fields
      expect(declared.tools).toEqual(["blocked", "submit"]);
      expect(declared.blocked).toEqual(["message"]);
      expect(declared.fields).toEqual([]);
      expect(declared.required).toEqual([]);
      expect(declared.closed).toBe(false);
    },
  );

  testInTempDirs(
    "a design reviewer's submit tool carries findings",
    async () => {
      // Given a design reviewer, whose stage reviews the design
      const state = "DESIGN_REVIEW";

      // When the extension it is spawned with is loaded and its submit read
      const declared = await submitOf(state);

      // Then it offers both result tools, and its submit carries findings
      expect(declared.tools).toEqual(["blocked", "submit"]);
      expect(declared.blocked).toEqual(["message"]);
      expect(declared.fields).toEqual(["findings"]);
      expect(declared.required).toEqual(["findings"]);
      expect(declared.closed).toBe(false);
    },
  );

  testInTempDirs(
    "a planner's submit tool carries nothing beyond the submit",
    async () => {
      // Given a planner, whose stage produces no findings
      const state = "PLAN";

      // When the extension it is spawned with is loaded and its submit read
      const declared = await submitOf(state);

      // Then it offers both result tools, and its submit carries no fields
      expect(declared.tools).toEqual(["blocked", "submit"]);
      expect(declared.blocked).toEqual(["message"]);
      expect(declared.fields).toEqual([]);
      expect(declared.required).toEqual([]);
      expect(declared.closed).toBe(false);
    },
  );

  testInTempDirs("a plan reviewer's submit tool carries findings", async () => {
    // Given a plan reviewer, whose stage reviews the plan
    const state = "PLAN_REVIEW";

    // When the extension it is spawned with is loaded and its submit read
    const declared = await submitOf(state);

    // Then it offers both result tools, and its submit carries findings
    expect(declared.tools).toEqual(["blocked", "submit"]);
    expect(declared.blocked).toEqual(["message"]);
    expect(declared.fields).toEqual(["findings"]);
    expect(declared.required).toEqual(["findings"]);
    expect(declared.closed).toBe(false);
  });

  testInTempDirs(
    "a worker's submit tool carries nothing beyond the submit",
    async () => {
      // Given a runner, whose stage produces no findings
      const state = "WORK";

      // When the extension it is spawned with is loaded and its submit read
      const declared = await submitOf(state);

      // Then it offers both result tools, and its submit carries no fields
      expect(declared.tools).toEqual(["blocked", "submit"]);
      expect(declared.blocked).toEqual(["message"]);
      expect(declared.fields).toEqual([]);
      expect(declared.required).toEqual([]);
      expect(declared.closed).toBe(false);
    },
  );

  testInTempDirs("a work reviewer's submit tool carries findings", async () => {
    // Given a work reviewer, whose stage reviews the work
    const state = "WORK_REVIEW";

    // When the extension it is spawned with is loaded and its submit read
    const declared = await submitOf(state);

    // Then it offers both result tools, and its submit carries findings
    expect(declared.tools).toEqual(["blocked", "submit"]);
    expect(declared.blocked).toEqual(["message"]);
    expect(declared.fields).toEqual(["findings"]);
    expect(declared.required).toEqual(["findings"]);
    expect(declared.closed).toBe(false);
  });

  testInTempDirs(
    "a designer's result tools end the turn they are called in",
    async () => {
      // Given the result tools a designer is spawned with
      const tools = await toolsOf("DESIGN");

      // When each of them is called with arguments its stage accepts
      const ended = [
        await tools.get("submit")!.execute("id", { findings: [] }),
        await tools
          .get("blocked")!
          .execute("id", { message: "the box is down" }),
      ];

      // Then neither leaves the agent a turn to carry on in
      expect(ended.map((result) => result.terminate)).toEqual([true, true]);
    },
  );

  testInTempDirs(
    "a design reviewer's result tools end the turn they are called in",
    async () => {
      // Given the result tools a design reviewer is spawned with
      const tools = await toolsOf("DESIGN_REVIEW");

      // When each of them is called with arguments its stage accepts
      const ended = [
        await tools.get("submit")!.execute("id", { findings: [] }),
        await tools
          .get("blocked")!
          .execute("id", { message: "the box is down" }),
      ];

      // Then neither leaves the agent a turn to carry on in
      expect(ended.map((result) => result.terminate)).toEqual([true, true]);
    },
  );

  testInTempDirs(
    "a planner's result tools end the turn they are called in",
    async () => {
      // Given the result tools a planner is spawned with
      const tools = await toolsOf("PLAN");

      // When each of them is called with arguments its stage accepts
      const ended = [
        await tools.get("submit")!.execute("id", { findings: [] }),
        await tools
          .get("blocked")!
          .execute("id", { message: "the box is down" }),
      ];

      // Then neither leaves the agent a turn to carry on in
      expect(ended.map((result) => result.terminate)).toEqual([true, true]);
    },
  );

  testInTempDirs(
    "a plan reviewer's result tools end the turn they are called in",
    async () => {
      // Given the result tools a plan reviewer is spawned with
      const tools = await toolsOf("PLAN_REVIEW");

      // When each of them is called with arguments its stage accepts
      const ended = [
        await tools.get("submit")!.execute("id", { findings: [] }),
        await tools
          .get("blocked")!
          .execute("id", { message: "the box is down" }),
      ];

      // Then neither leaves the agent a turn to carry on in
      expect(ended.map((result) => result.terminate)).toEqual([true, true]);
    },
  );

  testInTempDirs(
    "a worker's result tools end the turn they are called in",
    async () => {
      // Given the result tools a runner is spawned with
      const tools = await toolsOf("WORK");

      // When each of them is called with arguments its stage accepts
      const ended = [
        await tools.get("submit")!.execute("id", { findings: [] }),
        await tools
          .get("blocked")!
          .execute("id", { message: "the box is down" }),
      ];

      // Then neither leaves the agent a turn to carry on in
      expect(ended.map((result) => result.terminate)).toEqual([true, true]);
    },
  );

  testInTempDirs(
    "a work reviewer's result tools end the turn they are called in",
    async () => {
      // Given the result tools a work reviewer is spawned with
      const tools = await toolsOf("WORK_REVIEW");

      // When each of them is called with arguments its stage accepts
      const ended = [
        await tools.get("submit")!.execute("id", { findings: [] }),
        await tools
          .get("blocked")!
          .execute("id", { message: "the box is down" }),
      ];

      // Then neither leaves the agent a turn to carry on in
      expect(ended.map((result) => result.terminate)).toEqual([true, true]);
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
      // Given a runner that cannot get past the thing in its way
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
