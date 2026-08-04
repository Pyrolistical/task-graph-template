import fs from "node:fs";

export function writeFindings(filePath: string, findings: string[]): void {
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
