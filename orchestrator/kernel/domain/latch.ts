export class Latch {
  private raised = false;
  private readonly waiting = new Set<() => void>();

  notify(): void {
    this.raised = true;
    for (const wake of [...this.waiting]) {
      wake();
    }
  }

  clear(): void {
    this.raised = false;
  }

  wait(signal?: AbortSignal): Promise<void> {
    if (this.raised || signal?.aborted === true) {
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      const wake = () => {
        this.waiting.delete(wake);
        signal?.removeEventListener("abort", wake);
        resolve();
      };
      this.waiting.add(wake);
      signal?.addEventListener("abort", wake, { once: true });
    });
  }
}
