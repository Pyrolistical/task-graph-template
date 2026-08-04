import { describe, expect } from "bun:test";
import { test } from "./temp.ts";
import { restored } from "./assignment.ts";

describe("restoring an assignment an agent modified", () => {
  const dispatched = "the body\n\n## Design\n";

  test("what the agent wrote under its section survives", () => {
    const live = "the body, edited\n\n## Design\nthe design\n";

    expect(restored(dispatched, live, "## Design")).toBe(
      "the body\n\n## Design\nthe design\n",
    );
  });

  test("a section the agent renamed away leaves nothing to keep", () => {
    const live = "the body\n\n## My Design\nthe design\n";

    expect(restored(dispatched, live, "## Design")).toBe(dispatched);
  });

  test("the last heading is the one the agent wrote under", () => {
    const live =
      "the body cites ## Design\n\n## Design\nfirst\n\n## Design\nsecond\n";

    expect(restored(dispatched, live, "## Design")).toBe(
      "the body\n\n## Design\nsecond\n",
    );
  });

  test("a reviewer keeps nothing, having no section of its own", () => {
    const live = "the body\n\n## Design\nthe design\n\n## Review\nmine\n";

    expect(restored(dispatched, live, null)).toBe(dispatched);
  });
});
