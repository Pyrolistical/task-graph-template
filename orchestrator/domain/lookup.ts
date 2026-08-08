export function memberOf<T extends string>(
  values: readonly T[],
): (value: string) => value is T {
  const members: ReadonlySet<string> = new Set(values);
  return (value: string): value is T => members.has(value);
}

export function keysOf<T extends object>(shape: T): (keyof T)[] {
  return Object.keys(shape) as (keyof T)[];
}

export function tableOf<T, K extends string, V>(
  rows: readonly T[],
  keyOf: (row: T) => K,
  valueOf: (row: T, index: number) => V,
): Record<K, V> {
  const table: Partial<Record<K, V>> = {};
  rows.forEach((row, index) => {
    table[keyOf(row)] = valueOf(row, index);
  });
  return table as Record<K, V>;
}
