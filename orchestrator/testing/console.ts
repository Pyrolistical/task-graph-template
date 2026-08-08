import { type SlotRow, idleRow, parseAgents } from "../domain/agents.ts";
import type { TaskRow } from "../domain/graph.ts";
import type { Entry } from "../domain/session.ts";
import type { Line } from "../domain/text.ts";
import {
  type Layout,
  type Pane,
  type ConsoleView,
  panes,
} from "../policy/console.ts";
import type { Candidate } from "../policy/scheduler.ts";

export const SLOTS = parseAgents({
  agents: [
    {
      type: "pi",
      provider: "anthropic",
      model: "claude-sonnet-4-5",
      slots: 2,
    },
  ],
});

export function busyRow(
  overrides: Partial<SlotRow> = {},
  nowMs = Date.now(),
): SlotRow {
  return {
    ...idleRow(SLOTS[0]!),
    state: "BUSY",
    task_id: "000123",
    role: "worker",
    pid: 4242,
    started_at: new Date(1000).toISOString(),
    activity: {
      kind: "tool-call",
      tool: "bash",
      target: "bun test",
      started_at: nowMs,
    },
    tokens: 12300,
    context_percent: 41.6,
    session: "/tmp/session.jsonl",
    log: "/tmp/agent-rpc.jsonl",
    ...overrides,
  };
}

export function taskRowOf(overrides: Partial<TaskRow> = {}): TaskRow {
  return {
    id: "000123",
    title: "port the console",
    state: "WORK",
    state_entered: new Date(1000).toISOString(),
    depends_on: [],
    blocking: 0,
    claimed_by: SLOTS[0]!.name,
    held_reason: null,
    worktree: "/tmp/worktree",
    ...overrides,
  };
}

export function viewOf(overrides: Partial<ConsoleView> = {}): ConsoleView {
  return {
    agentsFile: "/tmp/tasks/agents.json",
    slots: [busyRow()],
    tasks: [taskRowOf()],
    checks: [],
    queue: [],
    scheduling: false,
    ...overrides,
  };
}

export function candidateOf(overrides: Partial<Candidate> = {}): Candidate {
  return {
    task_id: "000123",
    rank: "WORK_FRESH",
    state: "WORK",
    role: "worker",
    blocking: 0,
    prefer_slot: null,
    session: null,
    ...overrides,
  };
}

export function layoutOf(overrides: Partial<Layout> = {}): Layout {
  return {
    columns: 100,
    rows: 12,
    nowMs: 1000,
    scroll: { bases: null, offsets: [] },
    ...overrides,
  };
}

export function paneOf(view: Partial<ConsoleView> = {}): Pane {
  return panes(viewOf(view))[0]!;
}

export function entryOf(text: string, label = "text"): Entry {
  return { timestampMs: 0, label, text, error: false };
}

export function plain(line: Line): string {
  return line.map((span) => span.text).join("");
}
