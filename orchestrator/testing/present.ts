export function present<T>(value: T | null | undefined, what: string): T {
  if (value === null || value === undefined) {
    throw new Error(`expected ${what}, got ${String(value)}`);
  }
  return value;
}

export function at<T>(list: readonly T[], index: number): T {
  return present(list[index], `item ${index} of ${list.length}`);
}
