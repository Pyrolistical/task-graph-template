import { oneLine } from "./text.ts";

export interface Entry {
  timestampMs: number;
  label: string;
  text: string;
  error: boolean;
}

export interface Usage {
  input: number;
  output: number;
  cacheRead: number;
}

export function stamp(record: Record<string, unknown>): number {
  const value = record.timestamp;
  if (typeof value === "number") {
    return value;
  }
  if (typeof value === "string") {
    return Date.parse(value);
  }
  return 0;
}

function entry(
  timestampMs: number,
  label: string,
  text: string,
  error = false,
): Entry {
  return { timestampMs, label, text, error };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function firstLine(text: string): string {
  for (const line of text.split("\n")) {
    if (line.trim() !== "") {
      return line.trim();
    }
  }
  return "";
}

function countLines(text: string): number {
  return text.replace(/\n+$/, "").split("\n").length;
}

const TOOL_ARG_KEYS = [
  "command",
  "path",
  "file_path",
  "pattern",
  "url",
] as const;

function toolArg(args: unknown): string {
  if (!isObject(args)) {
    return String(args ?? "");
  }
  for (const key of TOOL_ARG_KEYS) {
    const value = args[key];
    if (typeof value === "string") {
      return oneLine(value);
    }
  }
  return oneLine(JSON.stringify(args));
}

function contentText(content: unknown): string {
  if (!Array.isArray(content)) {
    return typeof content === "string" ? content : "";
  }
  return content
    .filter((part) => isObject(part) && part.type === "text")
    .map((part) => String((part as Record<string, unknown>).text ?? ""))
    .join("")
    .trim();
}

function number(value: unknown): number {
  return typeof value === "number" ? value : 0;
}

function messageEntries(record: Record<string, unknown>): {
  entries: Entry[];
  usage: Usage | null;
} {
  const message = record.message;
  if (!isObject(message)) {
    return { entries: [], usage: null };
  }

  const at = stamp(record);
  const role = message.role;

  if (role === "user") {
    const text = contentText(message.content);
    return {
      entries: text === "" ? [] : [entry(at, "user", text)],
      usage: null,
    };
  }

  if (role === "toolResult") {
    const text = contentText(message.content);
    if (message.isError) {
      return {
        entries: [entry(at, "error", firstLine(text), true)],
        usage: null,
      };
    }
    const lines = countLines(text);
    return {
      entries: [
        entry(at, "result", lines > 1 ? `${lines} lines` : firstLine(text)),
      ],
      usage: null,
    };
  }

  if (role !== "assistant") {
    return { entries: [], usage: null };
  }

  const entries: Entry[] = [];
  const content = Array.isArray(message.content) ? message.content : [];

  for (const part of content) {
    if (!isObject(part)) {
      continue;
    }
    if (part.type === "thinking") {
      const text = String(part.thinking ?? "").trim();
      if (text !== "") {
        entries.push(entry(at, "thinking", text));
      }
    } else if (part.type === "text") {
      const text = String(part.text ?? "").trim();
      if (text !== "") {
        entries.push(entry(at, "text", text));
      }
    } else if (part.type === "toolCall") {
      entries.push(
        entry(at, String(part.name ?? "tool"), toolArg(part.arguments)),
      );
    }
  }

  const usage = message.usage;
  if (!isObject(usage)) {
    return { entries, usage: null };
  }

  return {
    entries,
    usage: {
      input: number(usage.input),
      output: number(usage.output),
      cacheRead: number(usage.cacheRead),
    },
  };
}

export function recordEntries(record: Record<string, unknown>): {
  entries: Entry[];
  usage: Usage | null;
} {
  const at = stamp(record);
  switch (record.type) {
    case "session": {
      return {
        entries: [entry(at, "session", `cwd ${record.cwd ?? "?"}`)],
        usage: null,
      };
    }
    case "model_change": {
      return {
        entries: [entry(at, "model", `${record.provider}/${record.modelId}`)],
        usage: null,
      };
    }
    case "thinking_level_change": {
      return {
        entries: [entry(at, "model", `thinking ${record.thinkingLevel}`)],
        usage: null,
      };
    }
    case "message": {
      return messageEntries(record);
    }
    default: {
      return { entries: [], usage: null };
    }
  }
}

export function appendEntries(
  entries: Entry[],
  result: { entries: Entry[]; usage: Usage | null },
): void {
  for (const next of result.entries) {
    const last = entries[entries.length - 1];
    if (
      next.label === "model" &&
      next.text.startsWith("thinking ") &&
      last !== undefined &&
      last.label === "model"
    ) {
      last.text = `${last.text} ${next.text}`;
      continue;
    }
    entries.push(next);
  }
}
