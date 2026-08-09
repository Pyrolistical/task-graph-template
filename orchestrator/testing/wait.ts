export async function eventually(
  done: () => boolean | Promise<boolean>,
  what: string,
  tries = 200,
): Promise<void> {
  for (let waited = 0; waited < tries && !(await done()); waited++) {
    await Bun.sleep(10);
  }
  if (!(await done())) {
    throw new Error(`never ${what} in ${tries} tries`);
  }
}
