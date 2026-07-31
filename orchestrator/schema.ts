import type { z } from "zod";

export class SchemaError extends Error {
  readonly issues: string[];

  constructor(what: string, source: string, issues: string[]) {
    super(`Invalid ${what} in ${source}:\n  - ${issues.join("\n  - ")}`);
    this.name = "SchemaError";
    this.issues = issues;
  }
}

function locate(path: PropertyKey[]): string {
  return path
    .map((key) => (typeof key === "number" ? `[${key}]` : `.${String(key)}`))
    .join("")
    .replace(/^\./, "");
}

export function parse<T>(
  schema: z.ZodType<T>,
  value: unknown,
  what: string,
  source: string,
): T {
  const result = schema.safeParse(value);
  if (result.success) {
    return result.data;
  }

  throw new SchemaError(
    what,
    source,
    result.error.issues.map((issue) => {
      const at = locate(issue.path);
      return at === "" ? issue.message : `${at}: ${issue.message}`;
    }),
  );
}
