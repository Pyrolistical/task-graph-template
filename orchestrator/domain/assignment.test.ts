import { describe, expect, test } from "bun:test";
import { diffAssignment, restored } from "./assignment.ts";

const DISPATCHED = "the body\n\n## Design\n";

describe("Feature: what an agent may write in its assignment", () => {
  test("an assignment that came back untouched reads as unchanged", () => {
    // Given an assignment the agent appended nothing to
    const live = DISPATCHED;

    // When it is compared with what was dispatched
    const diff = diffAssignment(DISPATCHED, live);

    // Then the server sees an agent that wrote nothing
    expect(diff).toBe("unchanged");
  });

  test("an assignment with an appended section reads as an ordinary append", () => {
    // Given an assignment the agent appended its design to
    const live = `${DISPATCHED}the design\n`;

    // When it is compared with what was dispatched
    const diff = diffAssignment(DISPATCHED, live);

    // Then the append is allowed
    expect(diff).toBe("ok");
  });

  test("an assignment edited above the section reads as modified", () => {
    // Given an assignment whose body the agent rewrote
    const live = "the body, edited\n\n## Design\nthe design\n";

    // When it is compared with what was dispatched
    const diff = diffAssignment(DISPATCHED, live);

    // Then the server sees an agent that wrote where it may not
    expect(diff).toBe("modified");
  });
});

describe("Feature: restoring an assignment an agent modified", () => {
  test("what the agent wrote under its own section survives the restore", () => {
    // Given an agent that edited the body and appended a design
    const live = "the body, edited\n\n## Design\nthe design\n";

    // When the assignment is restored around its section
    const kept = restored(DISPATCHED, live, "## Design");

    // Then the dispatched body comes back
    expect(kept).toStartWith("the body\n");

    // Then the agent's own design is still there
    expect(kept).toBe("the body\n\n## Design\nthe design\n");
  });

  test("a section the agent renamed away leaves nothing to keep", () => {
    // Given an agent that renamed the heading it was told to write under
    const live = "the body\n\n## My Design\nthe design\n";

    // When the assignment is restored around its section
    const kept = restored(DISPATCHED, live, "## Design");

    // Then the file is exactly what was dispatched
    expect(kept).toBe(DISPATCHED);
  });

  test("the last heading is taken as the one the agent wrote under", () => {
    // Given a body that mentions the heading before the agent's real one
    const live =
      "the body cites ## Design\n\n## Design\nfirst\n\n## Design\nsecond\n";

    // When the assignment is restored around its section
    const kept = restored(DISPATCHED, live, "## Design");

    // Then only what follows the last heading is kept
    expect(kept).toBe("the body\n\n## Design\nsecond\n");
  });

  test("a reviewer keeps nothing, having no section of its own", () => {
    // Given a reviewer that appended a section it was never given
    const live = "the body\n\n## Design\nthe design\n\n## Review\nmine\n";

    // When the assignment is restored with no section to keep
    const kept = restored(DISPATCHED, live, undefined);

    // Then the whole file goes back to what was dispatched
    expect(kept).toBe(DISPATCHED);
  });
});
