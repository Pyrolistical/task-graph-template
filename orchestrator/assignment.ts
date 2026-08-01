import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { parse } from "./schema.ts";
import { splitDocument } from "./task.ts";
import type { Role } from "./runtime.ts";

const Text = z.string().trim().min(1);

const Todo = z.strictObject({ message: z.string().min(1), done: z.boolean() });

const Blocked = z.strictObject({
  type: z.literal("blocked"),
  message: Text,
});

function frontmatter(submit: z.ZodObject) {
  return z.strictObject({
    assignment: z
      .string({ error: "must be a quoted six-digit string" })
      .regex(/^\d{6}$/, "must be a quoted six-digit string"),
    todos: z.array(Todo),
    checks: z.array(Text),
    result: z.discriminatedUnion("type", [submit, Blocked]).nullable(),
  });
}

const SCHEMA: Record<Role, z.ZodType> = {
  agent_worker: frontmatter(z.strictObject({ type: z.literal("submit") })),
  agent_reviewer: frontmatter(
    z.strictObject({
      type: z.literal("submit"),
      findings: z.array(Text),
      delegations: z.array(Text),
    }),
  ),
};

export type AssignmentResult =
  | { type: "submit" }
  | { type: "submit"; findings: string[]; delegations: string[] }
  | { type: "blocked"; message: string };

export interface AssignmentTodo {
  message: string;
  done: boolean;
}

export interface AssignmentMeta {
  assignment: string;
  todos: AssignmentTodo[];
  checks: string[];
  result: AssignmentResult | null;
}

export function parseAssignment(
  content: string,
  role: Role,
  source = "ASSIGNMENT.md",
): { meta: AssignmentMeta; body: string } {
  const { frontmatter: head, body } = splitDocument(content);
  const meta = parse(
    SCHEMA[role],
    Bun.YAML.parse(head),
    `${role} ASSIGNMENT.md`,
    source,
  ) as AssignmentMeta;
  return { meta, body };
}

export function readAssignment(
  filePath: string,
  role: Role,
): { meta: AssignmentMeta; body: string } {
  return parseAssignment(fs.readFileSync(filePath, "utf-8"), role, filePath);
}

function list(name: string, values: string[]): string[] {
  if (values.length === 0) {
    return [`${name}: []`];
  }
  return [`${name}:`, ...values.map((value) => `  - ${JSON.stringify(value)}`)];
}

function resultLines(result: AssignmentResult | null): string[] {
  if (result === null) {
    return ["result: null"];
  }
  if (result.type === "blocked") {
    return [
      "result:",
      "  type: blocked",
      `  message: ${JSON.stringify(result.message)}`,
    ];
  }
  if (!("findings" in result)) {
    return ["result:", "  type: submit"];
  }
  return [
    "result:",
    "  type: submit",
    ...list("findings", result.findings).map((line) => `  ${line}`),
    ...list("delegations", result.delegations).map((line) => `  ${line}`),
  ];
}

export function serializeAssignment(meta: AssignmentMeta): string {
  const todos =
    meta.todos.length === 0
      ? ["todos: []"]
      : [
          "todos:",
          ...meta.todos.flatMap((todo) => [
            `  - message: ${JSON.stringify(todo.message)}`,
            `    done: ${todo.done}`,
          ]),
        ];

  return [
    `assignment: ${JSON.stringify(meta.assignment)}`,
    ...todos,
    ...list("checks", meta.checks),
    ...resultLines(meta.result),
  ].join("\n");
}

export function rewriteAssignment(
  filePath: string,
  meta: AssignmentMeta,
): void {
  const { body } = splitDocument(fs.readFileSync(filePath, "utf-8"));
  fs.writeFileSync(
    filePath,
    `---\n${serializeAssignment(meta)}\n---${body}`,
    "utf-8",
  );
}

export function resetResult(filePath: string, role: Role): void {
  rewriteAssignment(filePath, {
    ...readAssignment(filePath, role).meta,
    result: null,
  });
}

export function divergences(
  dispatched: AssignmentMeta,
  settled: AssignmentMeta,
): string[] {
  const found: string[] = [];

  if (settled.assignment !== dispatched.assignment) {
    found.push(
      `"assignment" was changed from ${JSON.stringify(dispatched.assignment)} to ${JSON.stringify(settled.assignment)}`,
    );
  }

  if (settled.todos.length !== dispatched.todos.length) {
    found.push(
      `"todos" was ${dispatched.todos.length} entries and is now ${settled.todos.length}`,
    );
  } else {
    dispatched.todos.forEach((todo, i) => {
      if (settled.todos[i]!.message !== todo.message) {
        found.push(`todos[${i}].message was reworded`);
      }
    });
  }

  if (settled.checks.length !== dispatched.checks.length) {
    found.push(
      `"checks" was ${dispatched.checks.length} entries and is now ${settled.checks.length}`,
    );
  } else {
    dispatched.checks.forEach((check, i) => {
      if (settled.checks[i] !== check) {
        found.push(`checks[${i}] was rewritten`);
      }
    });
  }

  return found;
}

export function repair(
  filePath: string,
  dispatched: AssignmentMeta,
  settled: AssignmentMeta,
): { meta: AssignmentMeta; restored: string[] } {
  const restored = divergences(dispatched, settled);
  if (restored.length === 0) {
    return { meta: settled, restored };
  }

  const done = new Map(settled.todos.map((todo) => [todo.message, todo.done]));
  const meta: AssignmentMeta = {
    assignment: dispatched.assignment,
    todos: dispatched.todos.map((todo) => ({
      message: todo.message,
      done: done.get(todo.message) ?? false,
    })),
    checks: [...dispatched.checks],
    result: settled.result,
  };

  rewriteAssignment(filePath, meta);
  return { meta, restored };
}

export function historyName(n: number): string {
  return `ASSIGNMENT.${n}.md`;
}

export function attemptOf(historyDir: string): number {
  if (!fs.existsSync(historyDir)) {
    return 1;
  }
  return (
    fs.readdirSync(historyDir).filter((name) => name.startsWith("ASSIGNMENT."))
      .length + 1
  );
}

export function rotate(
  assignmentPath: string,
  historyDir: string,
): string | null {
  if (!fs.existsSync(assignmentPath)) {
    return null;
  }

  fs.mkdirSync(historyDir, { recursive: true });
  const target = path.join(historyDir, historyName(attemptOf(historyDir)));
  fs.renameSync(assignmentPath, target);
  return target;
}
