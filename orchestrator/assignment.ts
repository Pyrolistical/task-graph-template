import fs from "node:fs";
import path from "node:path";

export function historyName(n: number): string {
  return `ASSIGNMENT.${n}.md`;
}

export function attemptOf(historyDir: string): number {
  if (!fs.existsSync(historyDir)) {
    return 1;
  }
  return (
    fs.readdirSync(historyDir).filter((name) => name.startsWith("ASSIGNMENT."))
      .length + 1
  );
}

export function rotate(
  assignmentPath: string,
  historyDir: string,
): string | null {
  if (!fs.existsSync(assignmentPath)) {
    return null;
  }

  fs.mkdirSync(historyDir, { recursive: true });
  const target = path.join(historyDir, historyName(attemptOf(historyDir)));
  fs.renameSync(assignmentPath, target);
  return target;
}
