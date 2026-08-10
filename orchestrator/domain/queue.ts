import { Latch } from "./latch.ts";

interface Job {
  run(): Promise<void>;
  cancel(err: Error): void;
}

const CLOSED = "the server has stopped ticking";

export class Queue {
  readonly pending: Latch = new Latch();
  private readonly jobs: Job[] = [];
  private closed = false;

  submit<T>(work: () => Promise<T>): Promise<T> {
    if (this.closed) {
      return Promise.reject(new Error(CLOSED));
    }
    const submitted = new Promise<T>((resolve, reject) => {
      this.jobs.push({
        run: async () => {
          try {
            resolve(await work());
          } catch (err) {
            reject(err);
          }
        },
        cancel: reject,
      });
    });
    this.pending.notify();
    return submitted;
  }

  async drain(): Promise<void> {
    this.pending.clear();
    for (const job of this.jobs.splice(0)) {
      await job.run();
    }
  }

  close(): void {
    this.closed = true;
    for (const job of this.jobs.splice(0)) {
      job.cancel(new Error(CLOSED));
    }
  }
}
