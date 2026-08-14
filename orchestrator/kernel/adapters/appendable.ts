import fs from "node:fs/promises";
import path from "node:path";
import { ExclusiveLock } from "../domain/exclusive-lock.ts";

export class Appendable {
  private readonly open = new ExclusiveLock<fs.FileHandle | undefined>(
    undefined,
  );

  constructor(private readonly filePath: string) {}

  use<T>(fn: (handle: fs.FileHandle) => Promise<T>): Promise<T> {
    return this.open.acquire(async ([handle, set]) => {
      let current = handle;
      if (!current) {
        await fs.mkdir(path.dirname(this.filePath), { recursive: true });
        current = await fs.open(this.filePath, "a+");
        set(current);
      }
      return fn(current);
    });
  }

  close(): Promise<void> {
    return this.open.acquire(async ([handle, set]) => {
      if (handle) {
        await handle.close();
        set(undefined);
      }
    });
  }
}
