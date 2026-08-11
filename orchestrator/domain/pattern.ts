export function groupOf(match: RegExpMatchArray, index: number): string {
  const value = match[index];
  if (!value) {
    throw new Error(`"${match[0]}" has no group ${index}`);
  }
  return value;
}
