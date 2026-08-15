import type { SlotRow } from "../../views/slots.ts";
import {
  abortable,
  describeActivity,
  describeLabel,
  elapsed,
  elapsedSuffix,
} from "../../views/activity.ts";
import type { RunningCheck } from "../../views/checks.ts";
import type { TaskRow } from "../../views/tasks.ts";
import type { Entry } from "../domain/session.ts";
import type { TaskId } from "../../vocabulary/task.ts";
import type { Candidate } from "../../views/queue.ts";
import type { Hit } from "../domain/hits.ts";
import {
  type Line,
  DIM,
  GREEN,
  RED,
  clip,
  oneLine,
  spanWidth,
  textWidth,
  wrap,
} from "../domain/text.ts";

export const SWITCH_ON = "[─●]";
export const SWITCH_OFF = "[●─]";
export const FEWER = "[-]";
export const MORE = "[+]";

export type ConsoleSlot = SlotRow & { pending?: boolean };

export interface ConsoleView {
  agentsFile: string;
  slots: ConsoleSlot[];
  tasks: TaskRow[];
  checks: RunningCheck[];
  queue: Candidate[];
  scheduling: boolean;
}

export interface Pane {
  slot: ConsoleSlot;
  number: number;
  task?: TaskRow;
  check?: RunningCheck;
  sinceMs?: number;
}

export function panes(view: ConsoleView): Pane[] {
  const tasks = new Map<TaskId, TaskRow>(
    view.tasks.map((row) => [row.id, row]),
  );
  const checks = new Map<TaskId, RunningCheck>();
  for (const check of view.checks) {
    if (!checks.has(check.task_id)) {
      checks.set(check.task_id, check);
    }
  }

  const drawn = new Map<string, number>();

  return view.slots
    .map((slot) => {
      const number = (drawn.get(slot.agent) ?? 0) + 1;
      drawn.set(slot.agent, number);
      return {
        slot,
        number,
        task: slot.task_id ? tasks.get(slot.task_id) : undefined,
        check: slot.task_id ? checks.get(slot.task_id) : undefined,
        sinceMs: !slot.started_at ? undefined : Date.parse(slot.started_at),
      };
    })
    .sort((one, two) => Number(two.slot.enabled) - Number(one.slot.enabled));
}

export function clock(timestampMs: number): string {
  const at = new Date(timestampMs);
  return [at.getHours(), at.getMinutes(), at.getSeconds()]
    .map((part) => String(part).padStart(2, "0"))
    .join(":");
}

export function thousands(n: number): string {
  if (n < 1000) {
    return String(n);
  }
  return `${(n / 1000).toFixed(1)}k`;
}

export function toggle(on: boolean, label: string): Line {
  const suffix = label === "" ? "" : ` ${label}`;
  return [
    {
      text: `${on ? SWITCH_ON : SWITCH_OFF}${suffix}`,
      sgr: on ? GREEN : DIM,
    },
  ];
}

export function abortButton(pane: Pane): Line {
  if (!abortable(pane.slot.activity)) {
    return [];
  }
  return [{ text: "[abort]", sgr: RED }];
}
export function slotLabel(slot: SlotRow, number: number): string {
  return number === 1 && slot.total === 1
    ? `slot ${number}`
    : `slot ${number} / ${slot.total}`;
}

function identity(slot: SlotRow): string {
  return [slot.type, `${slot.provider}/${slot.model}`].join(" ");
}

export function slotButtons(slot: SlotRow): Line {
  const fewer: Line = slot.total > 1 ? [{ text: FEWER, sgr: DIM }] : [];
  const more: Line =
    slot.max && slot.total >= slot.max ? [] : [{ text: MORE, sgr: DIM }];
  return [...fewer, ...more];
}

function slotHits(slot: SlotRow, at: number): Hit[] {
  let from = at;
  return slotButtons(slot).map((span) => {
    const to = from + textWidth(span.text);
    const hit: Hit = {
      row: 0,
      from,
      to,
      command: {
        command: "slots",
        agent: slot.agent,
        total: span.text === FEWER ? slot.total - 1 : slot.total + 1,
      },
    };
    from = to;
    return hit;
  });
}

export const LOADING = "loading";

function stateLine(pane: Pane, nowMs: number): string {
  if (pane.slot.pending) {
    return LOADING;
  }
  const state =
    pane.slot.state === "DISABLED"
      ? "idle"
      : pane.slot.state.toLowerCase().replace("_", " ");
  if (!pane.sinceMs) {
    return state;
  }
  const since = elapsed(nowMs - pane.sinceMs);
  return state === "busy" ? since : `${state} ${since}`;
}

export function detailLine(pane: Pane): string {
  const { slot, task } = pane;
  if (slot.pending) {
    return "waiting for the server";
  }
  if (slot.state === "UNREACHABLE") {
    return "provider not answering";
  }
  if (slot.state === "OFF_SCHEDULE") {
    return "outside its schedule";
  }
  if (!slot.task_id) {
    return "no task";
  }

  const parts = [`task ${slot.task_id}`];
  if (slot.role) {
    parts.push(slot.role);
  }
  if (task) {
    parts.push(task.state);
  }
  if (slot.pid) {
    parts.push(`pid ${slot.pid}`);
  }
  if (slot.retry) {
    parts.push(
      `retry ${slot.retry.attempt} at ${clock(Date.parse(slot.retry.at))}`,
    );
  }
  return parts.join(" ");
}

export function activityLine(pane: Pane): string {
  if (pane.check) {
    return `check ${pane.check.index}: ${oneLine(pane.check.command)}`;
  }
  return describeActivity(pane.slot.activity);
}

export function statsLine(pane: Pane, rate?: number): string {
  const parts: string[] = [];
  if (rate) {
    parts.push(`${thousands(Math.round(rate * 10) / 10)} tok/s`);
  }
  const compactions =
    pane.slot.compactions > 0 ? ` x${pane.slot.compactions}` : "";
  if (pane.slot.context_percent) {
    parts.push(`ctx ${Math.round(pane.slot.context_percent)}%${compactions}`);
  }
  if (pane.slot.cost) {
    parts.push(`$${pane.slot.cost.toFixed(2)}`);
  }
  return parts.join(" ");
}

export function header(
  pane: Pane,
  width: number,
  nowMs: number,
  rate?: number,
): { lines: Line[]; hits: Hit[] } {
  const enabled = toggle(pane.slot.enabled, "");
  const slots = slotButtons(pane.slot);
  const label = ` ${slotLabel(pane.slot, pane.number)} `;
  const right = stateLine(pane, nowMs);
  const unreachable = pane.slot.state === "UNREACHABLE";
  const room =
    width - spanWidth(enabled) - spanWidth(slots) - textWidth(right) - 1;
  const left = clip(
    [
      ...clip([{ text: ` ${identity(pane.slot)}` }], room - textWidth(label)),
      { text: label },
    ],
    room,
  );
  const gap = Math.max(
    1,
    width -
      spanWidth(enabled) -
      spanWidth(left) -
      spanWidth(slots) -
      textWidth(right),
  );
  const button = abortButton(pane);
  const buttonWidth = spanWidth(button);
  const activityRow = (() => {
    if (pane.check) {
      const text = [{ text: activityLine(pane), sgr: DIM }];
      const room = width - buttonWidth;
      const clipped = clip(text, room);
      if (buttonWidth === 0) {
        return clipped;
      }
      return [
        ...clipped,
        { text: " ".repeat(width - spanWidth(clipped) - buttonWidth) },
        ...button,
      ];
    }
    const suffix = elapsedSuffix(pane.slot.activity);
    const suffixWidth = textWidth(suffix);
    const label = [{ text: describeLabel(pane.slot.activity), sgr: DIM }];
    const labelRoom = width - buttonWidth - suffixWidth;
    const clippedLabel = clip(label, Math.max(0, labelRoom));
    const suffixSpan: Line = suffix === "" ? [] : [{ text: suffix, sgr: DIM }];
    const joined: Line = [...clippedLabel, ...suffixSpan];
    if (buttonWidth === 0) {
      return joined;
    }
    const gap = width - spanWidth(joined) - buttonWidth;
    return [
      ...joined,
      ...(gap > 0 ? [{ text: " ".repeat(gap) }] : []),
      ...button,
    ];
  })();
  const hits: Hit[] = [
    {
      row: 0,
      from: 0,
      to: spanWidth(enabled),
      command: {
        command: "agent",
        agent: pane.slot.agent,
        enabled: !pane.slot.enabled,
      },
    },
    ...slotHits(pane.slot, spanWidth(enabled) + spanWidth(left)),
  ];
  if (buttonWidth > 0) {
    hits.push({
      row: 2,
      from: width - buttonWidth,
      to: width,
      command: { command: "slot_abort", slot: pane.slot.name },
    });
  }

  return {
    lines: [
      clip(
        [
          ...enabled,
          ...left,
          ...slots,
          { text: " ".repeat(gap) },
          { text: right, sgr: unreachable ? RED : undefined },
        ],
        width,
      ),
      clip([{ text: detailLine(pane), sgr: unreachable ? RED : DIM }], width),
      activityRow,
      clip([{ text: statsLine(pane, rate), sgr: DIM }], width),
    ],
    hits,
  };
}

export function entryLines(entry: Entry, width: number): Line[] {
  const prefix = `${clock(entry.timestampMs)} ${entry.label}: `;
  const prefixWidth = textWidth(prefix);
  const sgr = entry.error ? RED : DIM;
  const room = width - prefixWidth;

  if (room < 8) {
    const head: Line = [{ text: prefix.trimEnd(), sgr }];
    const rest = wrap(entry.text, width, width);
    return [
      clip(head, width),
      ...rest.map((line) => clip([{ text: line }], width)),
    ];
  }

  return wrap(entry.text, room, width).map((line, index) =>
    clip(
      index === 0 ? [{ text: prefix, sgr }, { text: line }] : [{ text: line }],
      width,
    ),
  );
}

export class PaneLines {
  private width = 0;
  private folded = 0;
  private lines: Line[] = [];

  update(entries: Entry[], width: number): Line[] {
    if (width !== this.width || entries.length < this.folded) {
      this.width = width;
      this.folded = 0;
      this.lines = [];
    }

    const settled = Math.max(0, entries.length - 1);
    for (const entry of entries.slice(this.folded, settled)) {
      if (entry.label !== "usage") {
        this.lines.push(...entryLines(entry, width));
      }
    }
    this.folded = settled;

    const last = entries[entries.length - 1];
    if (!last || last.label === "usage") {
      return this.lines;
    }
    return [...this.lines, ...entryLines(last, width)];
  }
}
