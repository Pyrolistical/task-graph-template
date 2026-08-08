export type FragmentValue =
  | string
  | number
  | Record<string, string | number | boolean>[];

export type FragmentVars = Record<string, FragmentValue>;

const SECTION_OPEN = /^(\s*)\{\{#(\w+)\}\}\s*$/;
const SECTION_CLOSE = /^\s*\{\{\/(\w+)\}\}\s*$/;
const PLACEHOLDER = /\{\{(\w+)\}\}/g;

function substitute(line: string, vars: Record<string, unknown>): string {
  return line.replace(PLACEHOLDER, (match, name: string, offset: number) => {
    if (!(name in vars)) {
      throw new Error(`Fragment refers to "${name}", which was not given`);
    }
    const value = String(vars[name]);
    const quoted =
      line[offset - 1] === '"' && line[offset + match.length] === '"';
    return quoted ? JSON.stringify(value).slice(1, -1) : value;
  });
}

export function render(template: string, vars: FragmentVars): string {
  const out: string[] = [];
  const lines = template.split("\n");

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const open = SECTION_OPEN.exec(line);

    if (open === null) {
      out.push(substitute(line, vars));
      continue;
    }

    const name = open[2]!;
    const body: string[] = [];
    let closed = false;

    for (i++; i < lines.length; i++) {
      const inner = lines[i]!;
      const close = SECTION_CLOSE.exec(inner);
      if (close !== null) {
        if (close[1] !== name) {
          throw new Error(`Fragment closes "${close[1]}" inside "${name}"`);
        }
        closed = true;
        break;
      }
      body.push(inner);
    }

    if (!closed) {
      throw new Error(`Fragment never closes "${name}"`);
    }

    const items = vars[name];
    if (!Array.isArray(items)) {
      throw new Error(`Fragment section "${name}" needs a list`);
    }

    if (items.length === 0) {
      const previous = out[out.length - 1];
      if (previous === `${name}:`) {
        out[out.length - 1] = `${name}: []`;
      }
      continue;
    }

    for (const item of items) {
      for (const inner of body) {
        out.push(substitute(inner, item));
      }
    }
  }

  return out.join("\n");
}
