export async function eventually(
  done: () => boolean,
  what: string,
  tries = 200,
): Promise<void> {
  for (let waited = 0; waited < tries && !done(); waited++) {
    await Bun.sleep(10);
  }
  if (!done()) {
    throw new Error(`never ${what} in ${tries} tries`);
  }
}
