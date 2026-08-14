import type { Publisher } from "../../runtime/ports/publisher.ts";

export class Health {
  private failure: string | undefined = undefined;

  constructor(private readonly publisher: Publisher) {}

  get lastError(): string | undefined {
    return this.failure;
  }

  async fail(message: string): Promise<void> {
    this.failure = message;
    await this.publisher.log(message);
  }

  async recover(): Promise<void> {
    if (!this.failure) {
      return;
    }
    this.failure = undefined;
    await this.publisher.log("the tick came round cleanly; the server is up");
  }
}
