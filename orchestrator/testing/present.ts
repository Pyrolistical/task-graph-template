export function present<T>(value: T | null | undefined, what: string): T {
  if (value === null || value === undefined) {
    throw new Error(`expected ${what}, got ${String(value)}`);
  }
  return value;
}
