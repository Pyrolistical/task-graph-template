import { setTimeout as delay } from "node:timers/promises";
import { Latch } from "../domain/latch.ts";

export class Paced {
  private running = true;

  constructor(
    private readonly tickMs: number,
    private readonly wake: Latch = new Latch(),
  ) {}

  schedule(): void {
    this.wake.notify();
  }

  stop(): void {
    this.running = false;
    this.wake.notify();
  }

  async run(body: () => Promise<void>): Promise<void> {
    while (this.running) {
      this.wake.clear();
      await body();
      if (!this.running) {
        return;
      }
      await this.idle();
    }
  }

  private async idle(): Promise<void> {
    const done: AbortController = new AbortController();
    await Promise.race([this.wake.wait(done.signal), this.tick(done.signal)]);
    done.abort();
  }

  private async tick(signal: AbortSignal): Promise<void> {
    try {
      await delay(this.tickMs, undefined, { signal });
    } catch (err) {
      if (!signal.aborted) {
        throw err;
      }
    }
  }
}
