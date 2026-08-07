import fs from "node:fs";
import path from "node:path";

export function writeFindings(filePath: string, findings: string[]): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(findings, null, 2)}\n`, "utf-8");
}

export function readFindings(filePath: string): string[] {
  if (!fs.existsSync(filePath)) {
    return [];
  }
  return JSON.parse(fs.readFileSync(filePath, "utf-8")) as string[];
}

export function clearFindings(filePath: string): void {
  fs.rmSync(filePath, { force: true });
}

export function readFailureCount(filePath: string): number {
  if (!fs.existsSync(filePath)) {
    return 0;
  }
  const contents = fs.readFileSync(filePath, "utf-8").trim();
  const count = Number.parseInt(contents, 10);
  if (!Number.isInteger(count) || count < 0) {
    throw new Error(`${filePath} holds "${contents}", not a failure count`);
  }
  return count;
}

export function writeFailureCount(filePath: string, count: number): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${count}\n`, "utf-8");
}

export function clearFailureCount(filePath: string): void {
  fs.rmSync(filePath, { force: true });
}
