import type { Command } from "../../runtime/domain/command.ts";
import { holding } from "../../views/slots.ts";
import type { ConsoleSlot, ConsoleView } from "./console.ts";

export const REJECTIONS = 2;

interface Pending<T> {
  value: T;
  left: number;
}

function pendingOf<T>(value: T): Pending<T> {
  return { value, left: REJECTIONS };
}

function keep<T>(pending: Pending<T>, accepted: boolean): boolean {
  if (accepted) {
    return false;
  }
  pending.left -= 1;
  return pending.left > 0;
}

export class Toggles {
  private scheduler?: Pending<boolean>;
  private readonly agents = new Map<string, Pending<boolean>>();
  private readonly counts = new Map<string, Pending<number>>();

  push(command: Command): void {
    if (command.command === "scheduler") {
      this.scheduler = pendingOf(command.enabled);
    }
    if (command.command === "agent") {
      this.agents.set(command.agent, pendingOf(command.enabled));
    }
    if (command.command === "slots") {
      this.counts.set(command.agent, pendingOf(command.total));
    }
  }

  apply(view: ConsoleView): ConsoleView {
    const scheduler = this.scheduler;
    if (scheduler && !keep(scheduler, view.scheduling === scheduler.value)) {
      this.scheduler = undefined;
    }

    for (const [agent, pending] of [...this.agents]) {
      const rows = view.slots.filter((slot) => slot.agent === agent);
      const accepted =
        rows.length > 0 && rows.every((slot) => slot.enabled === pending.value);
      if (!keep(pending, accepted)) {
        this.agents.delete(agent);
      }
    }

    for (const [agent, pending] of [...this.counts]) {
      const rows = view.slots.filter((slot) => slot.agent === agent);
      const accepted =
        rows.length > 0 && rows.every((slot) => slot.total === pending.value);
      if (!keep(pending, accepted)) {
        this.counts.delete(agent);
      }
    }

    return {
      ...view,
      scheduling: this.scheduler?.value ?? view.scheduling,
      slots: this.resized(
        view.slots.map((slot) => ({
          ...slot,
          enabled: this.agents.get(slot.agent)?.value ?? slot.enabled,
          total: this.counts.get(slot.agent)?.value ?? slot.total,
        })),
      ),
    };
  }

  private resized(slots: ConsoleSlot[]): ConsoleSlot[] {
    const out = [...slots];

    for (const [agent, pending] of this.counts) {
      const mine = () => out.filter((slot) => slot.agent === agent);

      while (mine().length > pending.value) {
        const spare = [...mine()]
          .filter((slot) => !holding(slot))
          .sort((one, two) => two.index - one.index)[0];
        if (!spare) {
          break;
        }
        out.splice(out.indexOf(spare), 1);
      }

      while (mine().length < pending.value) {
        const last = mine()[mine().length - 1];
        if (!last) {
          break;
        }
        out.splice(out.indexOf(last) + 1, 0, loading(last, free(mine())));
      }
    }

    return out;
  }
}

function free(slots: ConsoleSlot[]): number {
  const taken = new Set(slots.map((slot) => slot.index));
  let index = 1;
  while (taken.has(index)) {
    index += 1;
  }
  return index;
}

function loading(template: ConsoleSlot, index: number): ConsoleSlot {
  return {
    ...template,
    name: `${template.agent}-${index}`,
    index,
    state: "IDLE",
    task_id: undefined,
    role: undefined,
    pid: undefined,
    started_at: undefined,
    activity: { kind: "none" },
    tokens: undefined,
    cost: undefined,
    context_percent: undefined,
    compactions: 0,
    session: undefined,
    retry: undefined,
    pending: true,
  };
}
