export type AssignmentDiff = "ok" | "unchanged" | "modified";

export function diffAssignment(
  dispatched: string,
  live: string,
): AssignmentDiff {
  if (live.trimEnd() === dispatched.trimEnd()) {
    return "unchanged";
  }
  if (live.startsWith(dispatched)) {
    return "ok";
  }
  return "modified";
}

export function restored(
  dispatched: string,
  live: string,
  section?: string,
): string {
  if (!section) {
    return dispatched;
  }
  const heading = `\n${section}\n`;
  const at = live.lastIndexOf(heading);
  if (at === -1) {
    return dispatched;
  }
  return dispatched + live.slice(at + heading.length);
}
