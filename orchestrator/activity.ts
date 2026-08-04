export type Activity =
  | { kind: "tool-call"; tool: string; target: string; started_at: number }
  | { kind: "thinking"; started_at: number }
  | { kind: "compacting"; reason: string; started_at: number }
  | { kind: "none" };

export type ToolCall = Extract<Activity, { kind: "tool-call" }>;

export const ABORTABLE_TOOL = "bash";

export function abortable(activity: Activity): activity is ToolCall {
  return activity.kind === "tool-call" && activity.tool === ABORTABLE_TOOL;
}

export function toolTarget(
  toolName: string,
  args: Record<string, unknown>,
): string {
  const command = args?.command;
  if (typeof command === "string") {
    const newline = command.indexOf("\n");
    return newline === -1 ? command : command.slice(0, newline);
  }
  const file = args?.path;
  if (typeof file === "string") {
    return file;
  }
  return toolName;
}

export function toolCall(
  toolName: string,
  args: Record<string, unknown>,
): Activity {
  return {
    kind: "tool-call",
    tool: toolName,
    target: toolTarget(toolName, args),
    started_at: Date.now(),
  };
}

export function elapsed(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) {
    return `${seconds}s`;
  }
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    return `${minutes}m${String(seconds % 60).padStart(2, "0")}s`;
  }
  return `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, "0")}m`;
}

export function describeLabel(activity: Activity): string {
  switch (activity.kind) {
    case "tool-call": {
      return activity.target === activity.tool
        ? `tool: ${activity.tool}`
        : `tool: ${activity.tool} — ${activity.target}`;
    }
    case "thinking": {
      return "thinking";
    }
    case "compacting": {
      return `compacting (${activity.reason})`;
    }
    case "none": {
      return "";
    }
  }
}

export function elapsedSuffix(activity: Activity): string {
  if (activity.kind === "none") {
    return "";
  }
  return ` (${elapsed(Date.now() - activity.started_at)})`;
}

export function describeActivity(activity: Activity): string {
  const label = describeLabel(activity);
  const suffix = elapsedSuffix(activity);
  return suffix === "" ? "" : `${label}${suffix}`;
}
