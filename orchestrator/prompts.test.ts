import { describe, expect } from "bun:test";
import { tempDir, test } from "./temp.ts";
import fs from "node:fs";
import path from "node:path";
import { ISSUES, Prompts } from "./prompts.ts";
import { RESULT_TOOLS, resultFromCall } from "./results.ts";
import { render } from "./template.ts";
import { LOOP_LIMIT } from "./rpc.ts";
import { plan } from "./scheduler.ts";
import { ORCHESTRATOR_DIR, templateOf } from "./orchestrator-jig.ts";
import { STATE_TOOLS } from "./states.ts";

interface Schema {
  properties: Record<string, unknown>;
  required?: string[];
  additionalProperties?: boolean;
}

describe("prompt and template overrides", () => {
  function overrides(files: Record<string, string>): string {
    const dir = tempDir("orchestrator-overrides-");
    for (const [name, contents] of Object.entries(files)) {
      const file = path.join(dir, name);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, contents, "utf-8");
    }
    return dir;
  }

  test("with no overrides directory every file comes from the orchestrator", () => {
    const prompts = new Prompts(ORCHESTRATOR_DIR);

    expect(prompts.fragment("WORK")).toBe(templateOf("prompts/WORK.md"));
  });

  test("an override wins over the orchestrator's own copy", () => {
    const dir = overrides({
      "prompts/WORK.md": "you are an implementer\n",
    });
    const prompts = new Prompts(ORCHESTRATOR_DIR, dir);

    expect(prompts.fragment("WORK")).toBe("you are an implementer\n");
    expect(prompts.fragment("WORK", {})).toContain("implementer");
  });

  test("a directory that overrides one file leaves the rest alone", () => {
    const dir = overrides({ "prompts/WORK.md": "do it\n" });
    const prompts = new Prompts(ORCHESTRATOR_DIR, dir);

    expect(prompts.fragment("WORK")).toBe("do it\n");
    expect(prompts.fragment("WORK_REVIEW")).toBe(
      templateOf("prompts/WORK_REVIEW.md"),
    );
    const vars = { command: "bun test", limit: LOOP_LIMIT };
    expect(prompts.issue("looping", "WORK", vars)).toBe(
      render(templateOf("prompts/looping-WORK.md"), vars),
    );
  });

  test("an override is rendered with the same variables as the file it replaces", () => {
    const dir = overrides({
      "prompts/check-failed.md":
        "{{#failures}}\nbroke {{command}}\n{{/failures}}\n",
    });

    expect(
      new Prompts(ORCHESTRATOR_DIR, dir).fragment("check-failed", {
        failures: [{ command: "bun test", exit_code: "1", output: "boom" }],
      }),
    ).toBe("broke bun test\n");
  });

  test("a file edited after construction stays the cached copy", () => {
    const dir = overrides({ "prompts/WORK.md": "one\n" });
    const prompts = new Prompts(ORCHESTRATOR_DIR, dir);

    fs.writeFileSync(path.join(dir, "prompts", "WORK.md"), "two\n");

    expect(prompts.fragment("WORK")).toBe("one\n");
  });

  test("reload re-reads an edited override and falls back when one is deleted", () => {
    const dir = overrides({ "prompts/WORK.md": "one\n" });
    const prompts = new Prompts(ORCHESTRATOR_DIR, dir);

    fs.writeFileSync(path.join(dir, "prompts", "WORK.md"), "two\n");
    expect(prompts.reload()).toContain(path.join(dir, "prompts", "WORK.md"));
    expect(prompts.fragment("WORK")).toBe("two\n");

    fs.rmSync(path.join(dir, "prompts", "WORK.md"));
    expect(prompts.reload()).not.toContain(
      path.join(dir, "prompts", "WORK.md"),
    );
    expect(prompts.fragment("WORK")).toBe(templateOf("prompts/WORK.md"));
  });

  test("a file missing from both directories names both", () => {
    const dir = overrides({});

    expect(() => new Prompts(ORCHESTRATOR_DIR, dir).fragment("nope")).toThrow(
      new RegExp(
        `no prompts/nope.md in ${path.join(dir, "prompts")} or ${path.join(ORCHESTRATOR_DIR, "prompts")}`,
      ),
    );
  });
});

describe("template rendering", () => {
  test("a template referring to something it was not given fails loudly", () => {
    expect(() => render("agent: {{agent}}\n", {})).toThrow(/refers to "agent"/);
  });

  test("an unclosed section fails loudly", () => {
    expect(() => render("{{#todos}}\n- x\n", { todos: [] })).toThrow(
      /never closes "todos"/,
    );
  });
});

describe("the issues an agent can be sent back for", () => {
  test("only a blocked result gets a single attempt", () => {
    expect(ISSUES.blocked.attempts).toBe(1);
    for (const name of [
      "missing-result",
      "missing-todos",
      "missing-notes",
      "modified-assignment",
      "uncommitted",
      "modified-worktree",
    ] as const) {
      expect(ISSUES[name].attempts).toBe(4);
    }
  });

  test("the planning issues hold with reasons that name them", () => {
    expect(ISSUES["missing-todos"].held("")).toBe(
      "the planner submitted without appending a todo list to the assignment",
    );
    expect(ISSUES["modified-assignment"].held("")).toContain(
      "only the section it was instructed to write may be appended",
    );
    expect(ISSUES["missing-design"].held("")).toBe(
      "the designer submitted without appending a design section to the assignment",
    );
    expect(ISSUES["modified-worktree"].held("2 files")).toBe(
      "the agent wrote to the worktree during design or planning: 2 files",
    );
  });

  test("a loop is worth fewer nudges than a bad result, being dearer to reach", () => {
    expect(ISSUES.looping.attempts).toBeLessThan(ISSUES.uncommitted.attempts);
    expect(ISSUES.looping.attempts).toBeGreaterThan(ISSUES.blocked.attempts);
  });

  test("each issue names a fragment that exists for every state that can raise it", () => {
    for (const issue of Object.values(ISSUES)) {
      for (const state of issue.states) {
        expect(
          fs.existsSync(
            path.join(
              ORCHESTRATOR_DIR,
              "prompts",
              `${issue.fragment(state)}.md`,
            ),
          ),
        ).toBe(true);
      }
    }
  });

  test("a blocked hold reason is the agent's own message", () => {
    expect(ISSUES.blocked.held("the box is down")).toBe("the box is down");
  });
});

describe("result tool calls", () => {
  const STATES = [
    "DESIGN",
    "DESIGN_REVIEW",
    "PLAN",
    "PLAN_REVIEW",
    "WORK",
    "WORK_REVIEW",
  ] as const;

  test("submit is the result in DESIGN, PLAN and WORK", () => {
    expect(resultFromCall("WORK", { tool: "submit", args: {} })).toEqual({
      type: "submit",
    });
    expect(resultFromCall("PLAN", { tool: "submit", args: {} })).toEqual({
      type: "submit",
    });
    expect(resultFromCall("DESIGN", { tool: "submit", args: {} })).toEqual({
      type: "submit",
    });
  });

  test("a work review submit carries findings and delegations", () => {
    expect(
      resultFromCall("WORK_REVIEW", {
        tool: "submit",
        args: {
          findings: ["the null case is untested"],
          delegations: ["the same bug lives in fetch.ts"],
        },
      }),
    ).toEqual({
      type: "submit",
      findings: ["the null case is untested"],
      delegations: ["the same bug lives in fetch.ts"],
    });
  });

  test("a design or plan review submit carries findings", () => {
    expect(
      resultFromCall("PLAN_REVIEW", {
        tool: "submit",
        args: { findings: [] },
      }),
    ).toEqual({ type: "submit", findings: [] });
    expect(
      resultFromCall("DESIGN_REVIEW", {
        tool: "submit",
        args: { findings: ["it names no modules"] },
      }),
    ).toEqual({ type: "submit", findings: ["it names no modules"] });
  });

  test("blocked is the result in every state", () => {
    for (const state of STATES) {
      expect(
        resultFromCall(state, {
          tool: "blocked",
          args: { message: "the box is down" },
        }),
      ).toEqual({ type: "blocked", message: "the box is down" });
    }
  });

  test("every state gets its own result tools, and no two states share a submit", () => {
    const files = STATES.map((state) => STATE_TOOLS[state]);

    expect(new Set(files).size).toBe(STATES.length);
    for (const file of files) {
      expect(
        fs.existsSync(path.join(ORCHESTRATOR_DIR, `result-tools-${file}.ts`)),
      ).toBe(true);
    }
  });

  test("each state's submit schema is the only shape its state accepts", async () => {
    const submitOf = async (state: (typeof STATES)[number]) => {
      const { default: factory } = await import(
        `./result-tools-${STATE_TOOLS[state]}.ts`
      );
      const tools = new Map<string, Schema>();
      factory({
        registerTool: (tool: { name: string; parameters: Schema }) =>
          tools.set(tool.name, tool.parameters),
      } as never);
      expect([...tools.keys()].sort()).toEqual([...RESULT_TOOLS].sort());
      expect(tools.get("blocked")!.required).toEqual(["message"]);
      return tools.get("submit")!;
    };

    const shapes: Record<string, string[]> = {
      DESIGN: [],
      PLAN: [],
      WORK: [],
      DESIGN_REVIEW: ["findings"],
      PLAN_REVIEW: ["findings"],
      WORK_REVIEW: ["findings", "delegations"],
    };

    for (const state of STATES) {
      const submit = await submitOf(state);
      const fields = shapes[state]!;

      expect(Object.keys(submit.properties)).toEqual(fields);
      expect(submit.required ?? []).toEqual(fields);
      expect(submit.additionalProperties).toBe(false);
    }
  });
});
