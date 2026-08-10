import fs from "node:fs/promises";
import path from "node:path";

let tempSeq = 0;

export async function exists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

export async function writeAtomic(
  filePath: string,
  contents: string,
): Promise<void> {
  const temp = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${process.pid}.${tempSeq++}.tmp`,
  );
  try {
    await fs.writeFile(temp, contents, "utf-8");
    await fs.rename(temp, filePath);
  } catch (err) {
    await fs.rm(temp, { force: true });
    throw err;
  }
}
