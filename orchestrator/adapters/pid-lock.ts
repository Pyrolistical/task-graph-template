import fs from "node:fs/promises";
import { hasCode } from "../domain/errors.ts";
import { isProcessAlive } from "./processes.ts";

const TAKEOVER_RETRIES = 20;

export class PidLock {
  constructor(
    readonly filePath: string,
    private readonly what: string,
  ) {}

  async take(): Promise<void> {
    for (let attempt = 0; ; attempt++) {
      if (await this.claim()) {
        return;
      }
      const holder = await this.holder();
      if (holder && (await isProcessAlive(holder))) {
        throw new Error(`${this.what} is already in use by server ${holder}`);
      }
      await fs.rm(this.filePath, { force: true });
      if (attempt >= TAKEOVER_RETRIES) {
        throw new Error(`${this.what} was just taken by another server`);
      }
      await Bun.sleep(10);
    }
  }

  async clear(): Promise<void> {
    if ((await this.holder()) === process.pid) {
      await fs.rm(this.filePath, { force: true });
    }
  }

  async holder(): Promise<number | undefined> {
    let held: string;
    try {
      held = await fs.readFile(this.filePath, "utf-8");
    } catch (err) {
      if (hasCode(err, "ENOENT")) {
        return undefined;
      }
      throw err;
    }
    const holder = Number.parseInt(held, 10);
    return Number.isInteger(holder) ? holder : undefined;
  }

  private async claim(): Promise<boolean> {
    try {
      await fs.writeFile(this.filePath, `${process.pid}`, { flag: "wx" });
      return true;
    } catch (err) {
      if (hasCode(err, "EEXIST")) {
        return false;
      }
      throw err;
    }
  }
}
