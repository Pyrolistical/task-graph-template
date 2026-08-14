import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Awaitable } from "../domain/awaitable.ts";

export const SANDBOX_COMMAND = "bwrap";

export const LIMIT_COMMAND = "systemd-run";

export const OOM_COMMAND = "choom";

export const MEMORY_MAX = "8G";

export const TASKS_MAX = "512";

export const CACHE_HOME =
  process.env.XDG_CACHE_HOME ?? path.join(os.homedir(), ".cache");

export const NON_INTERACTIVE_ENV: Record<string, string> = {
  GIT_EDITOR: "true",
  EDITOR: "true",
  VISUAL: "true",
};

export interface SandboxPolicy {
  cwd: string;
  writable: string[];
  readable: string[];
  overlay: string[];
  oomScoreAdjust: number;
}

export function limitArgs(policy: SandboxPolicy): string[] {
  return [
    LIMIT_COMMAND,
    "--user",
    "--scope",
    "--quiet",
    "--collect",
    "-p",
    `MemoryMax=${MEMORY_MAX}`,
    "-p",
    "MemorySwapMax=0",
    "-p",
    `TasksMax=${TASKS_MAX}`,
    "--",
    OOM_COMMAND,
    "-n",
    String(policy.oomScoreAdjust),
    "--",
  ];
}

export function sandboxArgs(policy: SandboxPolicy): string[] {
  const args = [
    "--ro-bind",
    "/",
    "/",
    "--dev",
    "/dev",
    "--proc",
    "/proc",
    "--tmpfs",
    "/tmp",
  ];

  for (const target of policy.readable) {
    args.push("--ro-bind", target, target);
  }
  for (const target of policy.overlay) {
    args.push("--overlay-src", target, "--tmp-overlay", target);
  }
  for (const target of policy.writable) {
    args.push("--bind", target, target);
  }

  for (const [name, value] of Object.entries(NON_INTERACTIVE_ENV)) {
    args.push("--setenv", name, value);
  }

  args.push(
    "--unshare-user",
    "--unshare-pid",
    "--unshare-ipc",
    "--unshare-uts",
    "--new-session",
    "--chdir",
    policy.cwd,
    "--",
  );

  return args;
}

let limitsProbe: Promise<boolean> | undefined;

export function hasLimits(): Promise<boolean> {
  if (!limitsProbe) {
    const proc = Bun.spawn({
      cmd: [
        LIMIT_COMMAND,
        "--user",
        "--scope",
        "--quiet",
        "--collect",
        "-p",
        `MemoryMax=${MEMORY_MAX}`,
        "-p",
        "MemorySwapMax=0",
        "-p",
        `TasksMax=${TASKS_MAX}`,
        "--",
        OOM_COMMAND,
        "-n",
        "0",
        "--",
        "true",
      ],
      stdout: "ignore",
      stderr: "ignore",
    });
    limitsProbe = proc.exited.then((code) => code === 0);
  }
  return limitsProbe;
}

let overlayProbe: Promise<boolean> | undefined;

export function hasOverlay(): Promise<boolean> {
  if (!overlayProbe) {
    const probe = os.tmpdir();
    const proc = Bun.spawn({
      cmd: [
        SANDBOX_COMMAND,
        "--ro-bind",
        "/",
        "/",
        "--overlay-src",
        probe,
        "--tmp-overlay",
        probe,
        "--unshare-user",
        "--",
        "true",
      ],
      stdout: "ignore",
      stderr: "ignore",
    });
    overlayProbe = proc.exited.then((code) => code === 0);
  }
  return overlayProbe;
}

export async function sandbox(
  policy: SandboxPolicy,
  command = SANDBOX_COMMAND,
  limited: Awaitable<boolean> = hasLimits(),
): Promise<string[]> {
  if (!(await limited)) {
    return [command, ...sandboxArgs(policy)];
  }
  return [...limitArgs(policy), command, ...sandboxArgs(policy)];
}

export function expandHome(target: string): string {
  if (target === "~") {
    return os.homedir();
  }
  if (target.startsWith("~/")) {
    return path.join(os.homedir(), target.slice(2));
  }
  return path.resolve(target);
}

export function expandAll(targets: string[]): string[] {
  return [...new Set(targets.map(expandHome))];
}

export async function overlays(
  targets: string[],
  overlaid: Awaitable<boolean> = hasOverlay(),
): Promise<string[]> {
  if (!(await overlaid)) {
    return [];
  }
  const expanded = expandAll(targets);
  const existing: string[] = [];
  for (const target of expanded) {
    try {
      await fs.access(target);
      existing.push(target);
    } catch {
      // the target is not on disk
    }
  }
  return existing;
}
