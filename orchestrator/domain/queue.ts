import type { Awaitable } from "./awaitable.ts";

const CLOSED = "the server has stopped taking edits";

export class Queue {
  private tail: Promise<void> = Promise.resolve();
  private running = 0;
  private closed = false;

  submit<T>(work: () => Awaitable<T>): Promise<T> {
    if (this.closed) {
      return Promise.reject(new Error(CLOSED));
    }
    this.running += 1;
    const submitted = this.tail.then(work);
    this.tail = submitted.then(
      () => {
        this.running -= 1;
      },
      () => {
        this.running -= 1;
      },
    );
    return submitted;
  }

  get inflight(): number {
    return this.running;
  }

  async settled(): Promise<void> {
    while (this.running > 0) {
      await this.tail;
    }
  }

  close(): void {
    this.closed = true;
  }
}
