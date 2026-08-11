export function present<T>(value?: T, what = "value"): T {
  if (!value) {
    throw new Error(`expected ${what}, got ${String(value)}`);
  }
  return value;
}

export function at<T>(list: readonly T[], index: number): T {
  return present(list[index], `item ${index} of ${list.length}`);
}
