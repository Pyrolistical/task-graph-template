import { describe, expect, test } from "bun:test";
import { type Entry, appendEntries, recordEntries } from "./session.ts";
import { at } from "../testing/present.ts";

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
    expect(at(entries, 0).timestampMs).toBe(1000);

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
    expect(result).toEqual({ entries: [], usage: undefined });
  });

  test("the prompt an agent was given becomes one user entry", () => {
    // Given a session record holding the prompt the server sent the agent
    const record = {
      type: "message",
      message: {
        role: "user",
        content: [{ type: "text", text: "Start on ../ASSIGNMENT.md." }],
      },
    };

    // When the record is read into transcript entries
    const { entries } = recordEntries(record);

    // Then the prompt is shown as the agent's own turn, labelled as the user
    expect(entries.map((one) => [one.label, one.text])).toEqual([
      ["user", "Start on ../ASSIGNMENT.md."],
    ]);
  });

  test("a prompt with nothing in it is not drawn at all", () => {
    // Given a session record whose user message carries no text
    const record = { type: "message", message: { role: "user", content: [] } };

    // When the record is read into transcript entries
    const { entries } = recordEntries(record);

    // Then the console is given no entry to draw for it
    expect(entries).toEqual([]);
  });

  test("the start of a session says where the agent is working", () => {
    // Given the record that opens every session file
    const record = { type: "session", cwd: "/tmp/work/000042" };

    // When the record is read into transcript entries
    const { entries } = recordEntries(record);

    // Then the transcript opens by naming the working directory
    expect(entries.map((one) => [one.label, one.text])).toEqual([
      ["session", "cwd /tmp/work/000042"],
    ]);
  });

  test("a session that opens without a working directory says so", () => {
    // Given a session record that names no working directory
    const record = { type: "session" };

    // When the record is read into transcript entries
    const { entries } = recordEntries(record);

    // Then the entry still draws, with the directory marked unknown
    expect(at(entries, 0).text).toBe("cwd ?");
  });

  test("changing model is announced as the provider and the model", () => {
    // Given a record saying the session moved to another model
    const record = {
      type: "model_change",
      provider: "anthropic",
      modelId: "claude-opus-5",
    };

    // When the record is read into transcript entries
    const { entries } = recordEntries(record);

    // Then the transcript names both halves of what it moved to
    expect(entries.map((one) => [one.label, one.text])).toEqual([
      ["model", "anthropic/claude-opus-5"],
    ]);
  });

  test("changing the thinking level is announced against the model", () => {
    // Given a record saying the session changed how hard it thinks
    const record = { type: "thinking_level_change", thinkingLevel: "high" };

    // When the record is read into transcript entries
    const { entries } = recordEntries(record);

    // Then the change is labelled as a model change too
    expect(entries.map((one) => [one.label, one.text])).toEqual([
      ["model", "thinking high"],
    ]);
  });

  test("a role the console does not know produces nothing", () => {
    // Given a message from a role the transcript has no row for
    const record = { type: "message", message: { role: "system" } };

    // When the record is read into transcript entries
    const result = recordEntries(record);

    // Then it contributes neither an entry nor a usage sample
    expect(result).toEqual({ entries: [], usage: undefined });
  });

  test("a record whose message is not an object is ignored", () => {
    // Given a message record written with a string where the message goes
    const record = { type: "message", message: "truncated" };

    // When the record is read into transcript entries
    const result = recordEntries(record);

    // Then the console draws nothing rather than failing on it
    expect(result).toEqual({ entries: [], usage: undefined });
  });

  test("an assistant turn that reports no tokens still draws", () => {
    // Given an assistant turn whose record carries no usage at all
    const record = {
      type: "message",
      message: { role: "assistant", content: [{ type: "text", text: "done" }] },
    };

    // When the record is read into transcript entries
    const { entries, usage } = recordEntries(record);

    // Then the turn is drawn, and the rate meter is given no sample
    expect(entries.map((one) => one.text)).toEqual(["done"]);
    expect(usage).toBeUndefined();
  });

  test("a tool call names the argument worth reading", () => {
    // Given an assistant turn calling a tool with a path among its arguments
    const record = {
      type: "message",
      message: {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            name: "read",
            arguments: { offset: 10, path: "src/main.ts" },
          },
        ],
      },
    };

    // When the record is read into transcript entries
    const { entries } = recordEntries(record);

    // Then the row shows the path rather than the whole argument object
    expect(at(entries, 0).text).toBe("src/main.ts");
  });

  test("a tool call with no argument worth reading shows all of them", () => {
    // Given an assistant turn calling a tool with only arguments it cannot rank
    const record = {
      type: "message",
      message: {
        role: "assistant",
        content: [
          { type: "toolCall", name: "submit", arguments: { findings: [] } },
        ],
      },
    };

    // When the record is read into transcript entries
    const { entries } = recordEntries(record);

    // Then the row falls back to the arguments as they were written
    expect(at(entries, 0).text).toBe('{"findings":[]}');
  });

  test("a tool call whose arguments are not an object still draws a row", () => {
    // Given an assistant turn calling a tool with a bare string for arguments
    const record = {
      type: "message",
      message: {
        role: "assistant",
        content: [{ type: "toolCall", name: "bash", arguments: "ls -l" }],
      },
    };

    // When the record is read into transcript entries
    const { entries } = recordEntries(record);

    // Then the argument is shown as it stands, named by the tool that took it
    expect(entries.map((one) => [one.label, one.text])).toEqual([
      ["bash", "ls -l"],
    ]);
  });

  test("a tool result of nothing but blank lines reads as empty", () => {
    // Given a tool result whose only output is whitespace
    const record = {
      type: "message",
      message: { role: "toolResult", content: [{ type: "text", text: "  " }] },
    };

    // When the record is read into transcript entries
    const { entries } = recordEntries(record);

    // Then the row is drawn with no text rather than with the whitespace
    expect(entries[0]).toMatchObject({ label: "result", text: "" });
  });
});

describe("Feature: gathering session records into a transcript", () => {
  test("a thinking level change is folded onto the model it belongs to", () => {
    // Given a transcript whose last entry is the model the session moved to
    const entries: Entry[] = [];
    appendEntries(
      entries,
      recordEntries({
        type: "model_change",
        provider: "anthropic",
        modelId: "claude-opus-5",
      }),
    );

    // When the thinking level that came with it is gathered in
    appendEntries(
      entries,
      recordEntries({ type: "thinking_level_change", thinkingLevel: "high" }),
    );

    // Then the two are drawn as one row rather than two
    expect(entries.map((one) => one.text)).toEqual([
      "anthropic/claude-opus-5 thinking high",
    ]);
  });

  test("a thinking level change after other work stands on its own", () => {
    // Given a transcript whose last entry is something the agent said
    const entries: Entry[] = [];
    appendEntries(
      entries,
      recordEntries({
        type: "message",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "on it" }],
        },
      }),
    );

    // When a thinking level change is gathered in after it
    appendEntries(
      entries,
      recordEntries({ type: "thinking_level_change", thinkingLevel: "low" }),
    );

    // Then it is drawn as its own row, having no model row to join
    expect(entries.map((one) => one.text)).toEqual(["on it", "thinking low"]);
  });
});
