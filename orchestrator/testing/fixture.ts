import fs from "node:fs";
import { z } from "zod";
import path from "node:path";
import {
  createTask,
  nextTaskIdPath,
  readTaskFile,
  requireTaskFile,
  withLock,
  writeTaskFile,
} from "../adapters/task-store.ts";
import { applyTransition } from "../adapters/task-documents.ts";
import { takeClaim } from "../adapters/task-documents.ts";
import { git, gitOrThrow } from "../adapters/git.ts";
import { tempDir } from "./temp-dirs.ts";
import type { ClaimState } from "../domain/state-machine.ts";

const REPO_ROOT = path.join(import.meta.dir, "..", "..");

export interface Step {
  todos?: string[];
  design?: string;
  notes?: string;
  submit?: boolean;
  findings?: string[];
  blocked?: string;
  raw_final_message?: string;
  tamper?: { from: string; to: string };
  commit?: { path: string; contents: string };
  write?: { path: string; contents: string };
  clean?: string[];
  stop_reason?: string;
  output_tokens?: number;
  loop?: number;
  compact?: string;
  compact_after_result?: string;
  busy_ms?: number;
  start_delay_ms?: number;
  new_session_delay_ms?: number;
  die?: boolean;
  break_git?: boolean;
}

export type Plan = Record<string, Partial<Record<ClaimState, Step[]>>>;

export const FAKE_PI = `#!/usr/bin/env bun
import fs from "node:fs";
import path from "node:path";

const argv = process.argv.slice(2);
const flag = (name) => {
  const at = argv.indexOf(name);
  return at === -1 ? undefined : argv[at + 1];
};

const sessionDir = flag("--session-dir");
const [taskId, state] = (flag("--name") ?? "").split(" ");
const role = {
  DESIGN: "designer",
  DESIGN_REVIEW: "reviewer",
  PLAN: "planner",
  PLAN_REVIEW: "reviewer",
  WORK: "worker",
  WORK_REVIEW: "reviewer",
}[state] ?? "worker";
const plan = JSON.parse(fs.readFileSync(process.env.FAKE_PI_PLAN, "utf-8"));
const steps = (plan[taskId] ?? {})[state] ?? [];
const counter = path.join(sessionDir, "prompt-count-" + state);

let sessionFile = null;
let busy = false;
let busyTimer: ReturnType<typeof setTimeout> | null = null;
let pendingFinish: (() => void) | null = null;
let acted = false;
let toolEnded = false;
let lastText = "done";
let prompts = fs.existsSync(counter)
  ? Number(fs.readFileSync(counter, "utf-8"))
  : 0;

const emit = (record) => process.stdout.write(JSON.stringify(record) + "\\n");

function assignmentPath() {
  return path.join(path.dirname(process.cwd()), "ASSIGNMENT.md");
}

function resultCall(step) {
  if (step.blocked) {
    return { name: "blocked", args: { message: step.blocked } };
  }
  if (step.submit) {
    if (
      state === "DESIGN_REVIEW" ||
      state === "PLAN_REVIEW" ||
      state === "WORK_REVIEW"
    ) {
      return { name: "submit", args: { findings: step.findings ?? [] } };
    }
    return { name: "submit", args: {} };
  }
  return null;
}

function appendSection(text, content) {
  return text + "\\n" + content + "\\n";
}

function act(step) {
  const target = assignmentPath();
  let text = fs.readFileSync(target, "utf-8");

  if (step.todos) {
    const lines = step.todos.map((todo, i) => (i + 1) + ". " + todo);
    text = appendSection(text, lines.join("\\n"));
  }
  if (step.design) {
    text = appendSection(text, step.design);
  }
  if (step.notes) {
    text = appendSection(text, step.notes);
  }
  if (step.tamper) {
    text = text.split(step.tamper.from).join(step.tamper.to);
  }

  fs.writeFileSync(target, text);

  if (step.commit) {
    fs.writeFileSync(path.join(process.cwd(), step.commit.path), step.commit.contents);
    Bun.spawnSync(["git", "add", "-A"], { cwd: process.cwd() });
    Bun.spawnSync(["git", "commit", "-m", "work on " + taskId], {
      cwd: process.cwd(),
    });
  }

  if (step.write) {
    fs.writeFileSync(path.join(process.cwd(), step.write.path), step.write.contents);
  }

  if (step.clean) {
    for (const file of step.clean) {
      fs.rmSync(path.join(process.cwd(), file), { force: true });
    }
  }

  if (step.break_git) {
    fs.rmSync(path.join(process.cwd(), ".git"), { recursive: true, force: true });
  }
}

function endTool(isError) {
  if (toolEnded) return;
  toolEnded = true;
  emit({
    type: "tool_execution_end",
    toolCallId: "c1",
    toolName: "bash",
    isError,
  });
}

function turn(step) {
  busy = true;
  acted = false;
  toolEnded = false;
  emit({ type: "agent_start" });

  if (step.loop) {
    for (let i = 0; i < step.loop; i++) {
      emit({
        type: "tool_execution_start",
        toolCallId: "c1",
        toolName: "bash",
        args: { command: "zig build" },
      });
    }
    return;
  }

  emit({
    type: "tool_execution_start",
    toolCallId: "c1",
    toolName: "bash",
    args: { command: "git status" },
  });

  if (step.die) {
    setTimeout(() => process.exit(9), 0);
    return;
  }

  if (step.compact) {
    endTool(false);
    if (steps.length > 0) act(step);
    acted = true;
    emit({ type: "compaction_start", reason: step.compact });
  }

  const finish = () => {
    pendingFinish = null;
    endTool(false);
    if (steps.length > 0 && !acted) act(step);
    const result = resultCall(step);
    if (result !== null) {
      emit({
        type: "tool_execution_start",
        toolCallId: "c2",
        toolName: result.name,
        args: result.args,
      });
      emit({
        type: "tool_execution_end",
        toolCallId: "c2",
        toolName: result.name,
        isError: false,
      });
    }
    if (step.compact_after_result) {
      emit({ type: "compaction_start", reason: step.compact_after_result });
      emit({ type: "agent_start" });
    }
    lastText = step.raw_final_message ?? (result === null ? "done" : "submitted");
    emit({
      type: "message_end",
      message: {
        role: "assistant",
        stopReason: step.stop_reason ?? (result === null ? "stop" : "toolUse"),
        usage:
          step.output_tokens === undefined
            ? { cost: { total: 0.45 } }
            : { output: step.output_tokens, cost: { total: 0.45 } },
      },
    });
    emit({ type: "agent_end", messages: [], willRetry: false });
    busy = false;
    emit({ type: "agent_settled" });
  };

  if (step.busy_ms) {
    pendingFinish = finish;
    busyTimer = setTimeout(finish, step.busy_ms);
  } else {
    finish();
  }
}

function respond(command, id, data) {
  const record = { type: "response", command, success: true };
  if (id !== undefined) record.id = id;
  if (data !== undefined) record.data = data;
  emit(record);
}

async function handle(command) {
  switch (command.type) {
    case "new_session": {
      const delay = (steps[0] ?? {}).new_session_delay_ms;
      if (delay) await Bun.sleep(delay);
      sessionFile = path.join(sessionDir, taskId + "-" + role + ".jsonl");
      fs.mkdirSync(sessionDir, { recursive: true });
      fs.writeFileSync(sessionFile, "");
      respond("new_session", command.id, { cancelled: false });
      break;
    }
    case "switch_session": {
      sessionFile = command.sessionPath;
      respond("switch_session", command.id, { cancelled: false });
      break;
    }
    case "get_state": {
      respond("get_state", command.id, { sessionFile, isStreaming: false });
      break;
    }
    case "get_session_stats": {
      respond("get_session_stats", command.id, {
        sessionFile,
        tokens: { total: 105000 },
        cost: 0.45,
        contextUsage: { percent: 30 },
      });
      break;
    }
    case "get_last_assistant_text": {
      respond("get_last_assistant_text", command.id, { text: lastText });
      break;
    }
    case "abort": {
      respond("abort", command.id);
      if (busyTimer !== null) {
        clearTimeout(busyTimer);
        busyTimer = null;
      }
      busy = false;
      emit({
        type: "message_end",
        message: {
          role: "assistant",
          stopReason: "aborted",
        },
      });
      emit({ type: "agent_settled" });
      break;
    }
    case "abort_bash": {
      respond("abort_bash", command.id);
      endTool(true);
      if (busyTimer !== null) {
        clearTimeout(busyTimer);
        busyTimer = null;
      }
      if (pendingFinish !== null) {
        const finish = pendingFinish;
        finish();
      }
      break;
    }
    case "steer": {
      respond("steer", command.id);
      fs.mkdirSync(sessionDir, { recursive: true });
      fs.appendFileSync(
        path.join(sessionDir, "steers.jsonl"),
        JSON.stringify(command.message) + "\\n",
      );
      break;
    }
    case "prompt": {
      respond("prompt", command.id);
      const step = steps[Math.min(prompts, steps.length - 1)] ?? {};
      prompts++;
      fs.mkdirSync(sessionDir, { recursive: true });
      fs.writeFileSync(counter, String(prompts));
      fs.appendFileSync(
        path.join(sessionDir, "prompts.jsonl"),
        JSON.stringify(command.message) + "\\n",
      );
      if (busy) {
        fs.appendFileSync(
          path.join(sessionDir, "overlaps.jsonl"),
          JSON.stringify(command.message) + "\\n",
        );
      }
      if (step.start_delay_ms) {
        busy = true;
        setTimeout(() => turn(step), step.start_delay_ms);
      } else {
        turn(step);
      }
      break;
    }
    default: {
      respond(command.type, command.id);
    }
  }
}

let buffer = "";
for await (const chunk of Bun.stdin.stream()) {
  buffer += new TextDecoder().decode(chunk);
  const parts = buffer.split("\\n");
  buffer = parts.pop() ?? "";
  for (const line of parts) {
    if (line.trim() === "") continue;
    await handle(JSON.parse(line));
  }
}
`;

async function messagesIn(sessionDir: string, name: string): Promise<string[]> {
  const filePath = path.join(sessionDir, name);
  if (!(await fs.promises.exists(filePath))) {
    return [];
  }
  return (await fs.promises.readFile(filePath, "utf-8"))
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => z.string().parse(JSON.parse(line)));
}

export function promptsTo(sessionDir: string): Promise<string[]> {
  return messagesIn(sessionDir, "prompts.jsonl");
}

export function promptsOverlapping(sessionDir: string): Promise<string[]> {
  return messagesIn(sessionDir, "overlaps.jsonl");
}

export function steersTo(sessionDir: string): Promise<string[]> {
  return messagesIn(sessionDir, "steers.jsonl");
}

export interface Fixture {
  repo: string;
  tasksDir: string;
  orchestratorDir: string;
  overridesDir: string;
  agentsPath: string;
  serverRoot: string;
  piCommand: string;
  planPath: string;
}

export async function makeFixture(slots = 1): Promise<Fixture> {
  const repo = await tempDir("orchestrator-repo-");
  const tasksDir = path.join(repo, "tasks");
  const orchestratorDir = await tempDir("orchestrator-src-");
  const overridesDir = path.join(repo, "orchestrator");

  await fs.promises.mkdir(tasksDir);
  await fs.promises.writeFile(nextTaskIdPath(tasksDir), "1\n");

  await fs.promises.cp(
    path.join(REPO_ROOT, "orchestrator", "prompts"),
    path.join(orchestratorDir, "prompts"),
    { recursive: true },
  );
  await fs.promises.copyFile(
    path.join(REPO_ROOT, "orchestrator", "template.md"),
    path.join(orchestratorDir, "template.md"),
  );
  const agentsPath = path.join(repo, "agents.json");
  await fs.promises.writeFile(
    agentsPath,
    JSON.stringify({
      agents: [{ type: "pi", provider: "fake", model: "fake", slots }],
    }),
  );

  const piCommand = path.join(repo, "fake-pi.ts");
  await fs.promises.writeFile(piCommand, FAKE_PI, { mode: 0o755 });

  const planPath = path.join(repo, "plan.json");
  await fs.promises.writeFile(planPath, "{}");
  process.env.FAKE_PI_PLAN = planPath;

  gitOrThrow(repo, ["init", "-q", "-b", "master"]);
  gitOrThrow(repo, ["config", "user.email", "orchestrator@example.com"]);
  gitOrThrow(repo, ["config", "user.name", "orchestrator"]);
  gitOrThrow(repo, ["add", "-A"]);
  gitOrThrow(repo, ["commit", "-q", "-m", "initial"]);

  return {
    repo,
    tasksDir,
    orchestratorDir,
    overridesDir,
    agentsPath,
    serverRoot: await tempDir("orchestrator-root-"),
    piCommand,
    planPath,
  };
}

export async function writeOverride(
  fixture: Fixture,
  name: string,
  contents: string,
): Promise<void> {
  const file = path.join(fixture.overridesDir, name);
  await fs.promises.mkdir(path.dirname(file), { recursive: true });
  await fs.promises.writeFile(file, contents, "utf-8");
}

export async function setPlan(fixture: Fixture, plan: Plan): Promise<void> {
  await fs.promises.writeFile(fixture.planPath, JSON.stringify(plan));
  process.env.FAKE_PI_PLAN = fixture.planPath;
}

export function unplannedTask(
  fixture: Fixture,
  title: string,
  checks: string[] = [],
): string {
  const { id } = createTask(fixture.tasksDir, fixture.orchestratorDir, title);
  if (checks.length > 0) {
    withLock(fixture.tasksDir, () => {
      const filePath = requireTaskFile(id, fixture.tasksDir);
      const { meta, body } = readTaskFile(filePath);
      meta.checks = [...checks];
      writeTaskFile(filePath, meta, body);
    });
  }
  applyTransition(fixture.tasksDir, id, "submit", {});
  gitOrThrow(fixture.repo, ["add", "-A"]);
  gitOrThrow(fixture.repo, ["commit", "-q", "-m", `add task ${id}`]);
  return id;
}

export function readyTask(
  fixture: Fixture,
  title: string,
  checks: string[] = [],
): string {
  const id = unplannedTask(fixture, title, checks);
  takeClaim(fixture.tasksDir, id, { slotName: "designer", pid: process.pid });
  applyTransition(fixture.tasksDir, id, "submit", {});
  takeClaim(fixture.tasksDir, id, {
    slotName: "design-reviewer",
    pid: process.pid,
  });
  const designed = readTaskFile(requireTaskFile(id, fixture.tasksDir)).body;
  applyTransition(fixture.tasksDir, id, "submit", { body: designed });
  takeClaim(fixture.tasksDir, id, { slotName: "planner", pid: process.pid });
  applyTransition(fixture.tasksDir, id, "submit", {});
  takeClaim(fixture.tasksDir, id, {
    slotName: "plan-reviewer",
    pid: process.pid,
  });
  const body = readTaskFile(requireTaskFile(id, fixture.tasksDir)).body;
  applyTransition(fixture.tasksDir, id, "submit", { body });
  return id;
}

export function setBody(fixture: Fixture, id: string, body: string): void {
  withLock(fixture.tasksDir, () => {
    const filePath = requireTaskFile(id, fixture.tasksDir);
    const { meta } = readTaskFile(filePath);
    writeTaskFile(filePath, meta, body);
  });
}

export function commitGraph(fixture: Fixture, message: string): void {
  gitOrThrow(fixture.repo, ["add", "-A"]);
  if (git(fixture.repo, ["diff", "--cached", "--quiet"]).code !== 0) {
    gitOrThrow(fixture.repo, ["commit", "-q", "-m", message]);
  }
}
