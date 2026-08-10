import type { Awaitable } from "./awaitable.ts";

export class ExclusiveLock<T> {
  private value: T;
  private locked = false;
  private waiters: Array<() => void> = [];

  constructor(value: T) {
    this.value = value;
  }

  async acquire<R>(
    callback: (state: [T, (value: T) => void]) => Awaitable<R>,
  ): Promise<R> {
    await this.lock();
    try {
      const state: [T, (value: T) => void] = [
        this.value,
        (value) => {
          this.value = value;
        },
      ];
      return await callback(state);
    } finally {
      this.unlock();
    }
  }

  private async lock(): Promise<void> {
    if (!this.locked) {
      this.locked = true;
      return;
    }
    await new Promise<void>((resolve) => {
      this.waiters.push(resolve);
    });
    this.locked = true;
  }

  private unlock(): void {
    const next = this.waiters.shift();
    if (next) {
      next();
    } else {
      this.locked = false;
    }
  }
}
