export function groupOf(match: RegExpMatchArray, index: number): string {
  const value = match[index];
  if (value === undefined) {
    throw new Error(`"${match[0]}" has no group ${index}`);
  }
  return value;
}
