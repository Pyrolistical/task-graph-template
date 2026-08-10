export type Awaitable<T> = T | PromiseLike<T>;

export async function orNull<T>(value: Awaitable<T>): Promise<T | null> {
  try {
    return await value;
  } catch {
    return null;
  }
}
