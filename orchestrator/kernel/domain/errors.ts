export function errorOf(err: unknown): Error {
  return err instanceof Error ? err : new Error(String(err));
}

export function messageOf(err: unknown): string {
  return errorOf(err).message;
}

export function hasCode(err: unknown, code: string): boolean {
  return err instanceof Error && "code" in err && err.code === code;
}

export function uncaught(err: unknown): void {
  queueMicrotask(() => {
    throw err;
  });
}
