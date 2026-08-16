import type { Log } from "../../runtime/ports/log.ts";

export class Health {
  private failure: string | undefined = undefined;

  constructor(private readonly log: Log) {}

  get lastError(): string | undefined {
    return this.failure;
  }

  async fail(message: string): Promise<void> {
    this.failure = message;
    await this.log(message);
  }

  async recover(): Promise<void> {
    if (!this.failure) {
      return;
    }
    this.failure = undefined;
    await this.log("the tick came round cleanly; the server is up");
  }
}
