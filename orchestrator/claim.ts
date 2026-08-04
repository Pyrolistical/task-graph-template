import {
  type TaskId,
  type TaskMeta,
  findTaskFile,
  isProcessAlive,
  readTaskFile,
  withLock,
  writeTaskFile,
} from "./task.ts";
import { AGENT_STATES, isAgentState } from "./states.ts";

export interface ClaimArgs {
  agentName: string;
  pid: number;
  branch?: string;
  worktree?: string;
  session?: string;
}

function requireText(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(
      `"${label}" must be a non-empty string, got ${JSON.stringify(value)}`,
    );
  }
  return value;
}

function requirePid(value: unknown): number {
  if (!Number.isInteger(value) || (value as number) <= 0) {
    throw new Error(
      `"pid" must be a positive integer, got ${JSON.stringify(value)}`,
    );
  }
  return value as number;
}

function workSession(
  meta: TaskMeta,
  session: string | undefined,
): string | null {
  if (meta.state !== "WORK") {
    return meta.workspace?.session ?? null;
  }
  return session === undefined ? null : session;
}

export function takeClaim(
  tasksDir: string,
  taskId: TaskId,
  args: ClaimArgs,
): void {
  withLock(tasksDir, () => {
    const filePath = findTaskFile(taskId, tasksDir);
    if (!filePath) {
      throw new Error(`Task "${taskId}" not found`);
    }

    const { meta, body } = readTaskFile(filePath);

    if (!isAgentState(meta.state)) {
      throw new Error(
        `Task "${taskId}" is in ${meta.state}, which no agent runs. Claimable states: ${AGENT_STATES.join(", ")}`,
      );
    }
    if (meta.claimed_by !== null) {
      throw new Error(
        `Task "${taskId}" is already claimed by "${meta.claimed_by}" (PID ${meta.claimed_pid})`,
      );
    }

    meta.claimed_by = requireText(args.agentName, "agentName");
    meta.claimed_pid = requirePid(args.pid);

    if (args.branch !== undefined || args.worktree !== undefined) {
      const session = workSession(meta, args.session);
      meta.workspace = {
        branch: requireText(args.branch, "branch"),
        worktree: requireText(args.worktree, "worktree"),
        agent: meta.claimed_by,
        session,
      };
    }

    writeTaskFile(filePath, meta, body);
  });
}

export function clearClaim(tasksDir: string, taskId: TaskId): void {
  withLock(tasksDir, () => {
    const filePath = findTaskFile(taskId, tasksDir);
    if (!filePath) {
      throw new Error(`Task "${taskId}" not found`);
    }

    const { meta, body } = readTaskFile(filePath);

    if (meta.claimed_pid === null) {
      throw new Error(
        `Task "${taskId}" is in ${meta.state} with no claim to clear`,
      );
    }
    if (isProcessAlive(meta.claimed_pid)) {
      throw new Error(
        `Task "${taskId}" is still claimed by a live process (PID ${meta.claimed_pid}); a claim is only cleared once its process is gone`,
      );
    }

    meta.claimed_by = null;
    meta.claimed_pid = null;

    writeTaskFile(filePath, meta, body);
  });
}
