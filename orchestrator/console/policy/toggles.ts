import type { Command } from "../../runtime/domain/command.ts";
import type { ConsoleView } from "./console.ts";

export const REJECTIONS = 2;

interface Pending {
  enabled: boolean;
  left: number;
}

function pendingOf(enabled: boolean): Pending {
  return { enabled, left: REJECTIONS };
}

function keep(pending: Pending, accepted: boolean): boolean {
  if (accepted) {
    return false;
  }
  pending.left -= 1;
  return pending.left > 0;
}

export class Toggles {
  private scheduler?: Pending;
  private readonly agents = new Map<string, Pending>();

  push(command: Command): void {
    if (command.command === "scheduler") {
      this.scheduler = pendingOf(command.enabled);
    }
    if (command.command === "agent") {
      this.agents.set(command.agent, pendingOf(command.enabled));
    }
  }

  apply(view: ConsoleView): ConsoleView {
    const scheduler = this.scheduler;
    if (scheduler && !keep(scheduler, view.scheduling === scheduler.enabled)) {
      this.scheduler = undefined;
    }

    for (const [agent, pending] of [...this.agents]) {
      const rows = view.slots.filter((slot) => slot.agent === agent);
      const accepted =
        rows.length > 0 &&
        rows.every((slot) => slot.enabled === pending.enabled);
      if (!keep(pending, accepted)) {
        this.agents.delete(agent);
      }
    }

    return {
      ...view,
      scheduling: this.scheduler?.enabled ?? view.scheduling,
      slots: view.slots.map((slot) => {
        const pending = this.agents.get(slot.agent);
        return !pending ? slot : { ...slot, enabled: pending.enabled };
      }),
    };
  }
}
