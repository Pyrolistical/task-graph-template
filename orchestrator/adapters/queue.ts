import fs from "node:fs";
import path from "node:path";
import type { ClaimState } from "../domain/state-machine.ts";

export function queueDir(taskDir: string): string {
  return path.join(taskDir, "queue");
}

export function queueFile(taskDir: string, state: ClaimState): string {
  return path.join(queueDir(taskDir), `${state}.md`);
}

export function append(
  taskDir: string,
  state: ClaimState,
  entry: string,
): void {
  const filePath = queueFile(taskDir, state);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const previous = fs.existsSync(filePath)
    ? fs.readFileSync(filePath, "utf-8")
    : "";
  const separator = previous.trim().length === 0 ? "" : "\n\n---\n\n";
  fs.writeFileSync(
    filePath,
    `${previous}${separator}${entry.trim()}\n`,
    "utf-8",
  );
}

export function drain(taskDir: string, state: ClaimState): string {
  const filePath = queueFile(taskDir, state);
  if (!fs.existsSync(filePath)) {
    return "";
  }
  const contents = fs.readFileSync(filePath, "utf-8");
  fs.rmSync(filePath, { force: true });
  return contents.trim();
}
