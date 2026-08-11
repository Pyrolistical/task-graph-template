export type Awaitable<T> = T | PromiseLike<T>;

export async function orUndefined<T>(
  value: Awaitable<T>,
): Promise<T | undefined> {
  try {
    return await value;
  } catch {
    return undefined;
  }
}
