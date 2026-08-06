import { describe, expect, test } from "bun:test";
import { recordEntries } from "./session.ts";

describe("Feature: reading a session record", () => {
  test("an assistant turn becomes one entry per thought, message and tool call", () => {
    // Given an assistant turn that thought, spoke and called a tool
    const record = {
      type: "message",
      timestamp: "1970-01-01T00:00:01.000Z",
      message: {
        role: "assistant",
        content: [
          { type: "thinking", thinking: " plan " },
          { type: "text", text: "on it" },
          { type: "toolCall", name: "bash", arguments: { command: "ls -l" } },
        ],
        usage: { input: 10, output: 2, cacheRead: 100 },
      },
    };

    // When the record is read into transcript entries
    const { entries, usage } = recordEntries(record);

    // Then each part of the turn is one labelled entry, in the order it happened
    expect(entries.map((entry) => [entry.label, entry.text])).toEqual([
      ["thinking", "plan"],
      ["text", "on it"],
      ["bash", "ls -l"],
    ]);

    // Then every entry carries the moment the turn was written
    expect(entries[0]!.timestampMs).toBe(1000);

    // Then the tokens the turn cost come back with it, for the rate meter
    expect(usage).toEqual({ input: 10, output: 2, cacheRead: 100 });
  });

  test("a tool result that ran to several lines collapses to a line count", () => {
    // Given a tool result with three lines of output
    const record = {
      type: "message",
      message: {
        role: "toolResult",
        content: [{ type: "text", text: "a\nb\nc" }],
      },
    };

    // When the record is read into transcript entries
    const { entries } = recordEntries(record);

    // Then the console is given the size of the output rather than the output
    expect(entries[0]).toMatchObject({
      label: "result",
      text: "3 lines",
      error: false,
    });
  });

  test("a tool result that failed is flagged and shows its first line", () => {
    // Given a tool result the agent's command failed on
    const record = {
      type: "message",
      message: {
        role: "toolResult",
        isError: true,
        content: [{ type: "text", text: "boom\ndetails" }],
      },
    };

    // When the record is read into transcript entries
    const { entries } = recordEntries(record);

    // Then the entry is marked as an error and reads as the first line of it
    expect(entries[0]).toMatchObject({
      label: "error",
      text: "boom",
      error: true,
    });
  });

  test("a record the console has no use for produces nothing", () => {
    // Given a session record of a kind the console does not draw
    const record = { type: "agent_settled" };

    // When the record is read into transcript entries
    const result = recordEntries(record);

    // Then it contributes neither an entry nor a usage sample
    expect(result).toEqual({ entries: [], usage: null });
  });
});
