import fs from "node:fs/promises";

async function isZombie(pid: number): Promise<boolean> {
  let stat: string;
  try {
    stat = await fs.readFile(`/proc/${pid}/stat`, "utf-8");
  } catch {
    return false;
  }
  return stat.slice(stat.lastIndexOf(")") + 2).startsWith("Z");
}

export async function isProcessAlive(pid: number): Promise<boolean> {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  return !(await isZombie(pid));
}
