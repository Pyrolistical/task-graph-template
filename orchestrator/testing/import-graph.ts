import fs from "node:fs/promises";
import path from "node:path";
import { groupOf } from "../kernel/domain/pattern.ts";

const ORCHESTRATOR = path.join(import.meta.dir, "..");
const REPO_ROOT = path.join(ORCHESTRATOR, "..");
const DEFAULT_OUT = path.join(REPO_ROOT, "docs", "import-graph.md");

const ROOT_MODULES = ["mcp.ts", "console.ts"];

const ROOTS = [
  {
    module: "mcp.ts",
    title: "The server",
    blurb:
      "`mcp.ts` builds the app through `compose.ts` and serves the manager over stdio. It is the only program that holds a running piece of more than one slice.",
  },
  {
    module: "console.ts",
    title: "The console",
    blurb:
      "`console.ts` opens the runtime directory and draws what it finds. It shares the kernel, the wire contract and the runtime directory with the server, and reaches for nothing else of it.",
  },
] as const;

const IMPORT = /^import\s+([\s\S]*?)\s*from\s*"([^"]+)"/gm;

const GROUPS = [
  { dir: ".", title: "entry points", boxed: false },
  { dir: "orchestrator/main", title: "main", boxed: false },
  { dir: "orchestrator/console", title: "console", boxed: true },
  { dir: "orchestrator/tasks", title: "tasks", boxed: true },
  { dir: "orchestrator/runtime", title: "runtime", boxed: true },
  { dir: "orchestrator/checks", title: "checks", boxed: true },
  { dir: "orchestrator/agents", title: "agents", boxed: true },
  { dir: "orchestrator/prompting", title: "prompting", boxed: true },
  { dir: "orchestrator/workspaces", title: "workspaces", boxed: true },
  { dir: "orchestrator/views", title: "views", boxed: true },
  { dir: "orchestrator/vocabulary", title: "vocabulary", boxed: true },
  { dir: "orchestrator/kernel", title: "kernel", boxed: true },
] as const;

export interface Edge {
  from: string;
  to: string;
}

export function valueImport(clause: string): boolean {
  if (clause.startsWith("type ")) {
    return false;
  }
  const braced = /^\{([\s\S]*)\}$/.exec(clause.trim());
  if (!braced) {
    return true;
  }
  return groupOf(braced, 1)
    .split(",")
    .map((one) => one.trim())
    .filter((one) => one !== "")
    .some((one) => !one.startsWith("type "));
}

export function edgesIn(from: string, source: string): Edge[] {
  const found: Edge[] = [];
  for (const match of source.matchAll(IMPORT)) {
    const target = groupOf(match, 2);
    if (!target.startsWith(".") || !valueImport(groupOf(match, 1))) {
      continue;
    }
    found.push({
      from,
      to: path.normalize(path.join(path.dirname(from), target)),
    });
  }
  return found;
}

async function sources(): Promise<string[]> {
  const found: string[] = ROOT_MODULES.map((name) => name);

  const walk = async (dir: string) => {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== "testing") {
          await walk(full);
        }
      } else if (
        entry.name.endsWith(".ts") &&
        !entry.name.endsWith(".test.ts") &&
        !entry.name.startsWith("result-tools")
      ) {
        found.push(path.relative(REPO_ROOT, full));
      }
    }
  };

  await walk(ORCHESTRATOR);
  return found.sort();
}

function groupOfModule(modulePath: string): string {
  const dir = path.dirname(modulePath);
  const group = GROUPS.find(
    (one) => dir === one.dir || dir.startsWith(`${one.dir}${path.sep}`),
  );
  return group ? group.title : dir;
}

function idOf(modulePath: string): string {
  return modulePath.replace(/[^a-zA-Z0-9]/g, "_");
}

function labelOf(modulePath: string, group: string): string {
  const dir = GROUPS.find((one) => one.title === group)?.dir ?? ".";
  const inside = path.relative(dir, modulePath);
  return inside.replace(/\.ts$/, "");
}

function reachableFrom(root: string, edges: Edge[]): Set<string> {
  const out = new Map<string, string[]>();
  for (const edge of edges) {
    out.set(edge.from, [...(out.get(edge.from) ?? []), edge.to]);
  }

  const seen = new Set([root]);
  const stack = [root];
  for (let next = stack.pop(); next; next = stack.pop()) {
    for (const target of out.get(next) ?? []) {
      if (!seen.has(target)) {
        seen.add(target);
        stack.push(target);
      }
    }
  }
  return seen;
}

function drawing(modules: string[], edges: Edge[]): string[] {
  const held = new Set(modules);
  const out = ["```mermaid", "flowchart LR"];

  for (const group of GROUPS) {
    const members = modules.filter((one) => groupOfModule(one) === group.title);
    if (members.length === 0) {
      continue;
    }
    if (!group.boxed) {
      for (const member of members) {
        out.push(`  ${idOf(member)}["${path.basename(member)}"]`);
      }
      continue;
    }
    out.push(`  subgraph ${idOf(group.title)}["${group.title}"]`);
    for (const member of members) {
      out.push(`    ${idOf(member)}["${labelOf(member, group.title)}"]`);
    }
    out.push("  end");
  }

  for (const edge of edges) {
    if (held.has(edge.from) && held.has(edge.to)) {
      out.push(`  ${idOf(edge.from)} --> ${idOf(edge.to)}`);
    }
  }

  out.push("```");
  return out;
}

export function render(modules: string[], edges: Edge[]): string {
  const ungrouped = modules.filter(
    (one) => !GROUPS.some((group) => group.title === groupOfModule(one)),
  );
  if (ungrouped.length > 0) {
    throw new Error(`no group holds ${ungrouped.join(", ")}`);
  }

  const known = new Set(modules);
  const drawn = edges.filter((edge) => known.has(edge.to));
  const out: string[] = [
    "# The import graph",
    "",
    "One graph per program. `A --> B` means `A.ts` imports something from `B.ts`",
    "that survives to runtime; a type-only import is left out, because it binds no",
    "module to another. So are the test suites, the test rig in",
    "`orchestrator/testing/` and the pi extensions — neither program is built from",
    "them.",
    "",
    "Generated by `bun run import-graph` from",
    "`orchestrator/testing/import-graph.ts`; the slicing it should show is",
    "[The slices](architecture.md).",
    "",
  ];

  const shown = new Set<string>();
  for (const root of ROOTS) {
    const held = reachableFrom(root.module, drawn);
    const members = modules.filter((one) => held.has(one));
    for (const member of members) {
      shown.add(member);
    }
    const inside = drawn.filter(
      (edge) => held.has(edge.from) && held.has(edge.to),
    );
    out.push(
      `## ${root.title}`,
      "",
      root.blurb,
      "",
      `${members.length} modules, ${inside.length} imports.`,
      "",
      ...drawing(members, inside),
      "",
    );
  }

  const unbound = modules.filter((one) => !shown.has(one));
  out.push(
    "## Named but never bound",
    "",
    "In neither graph, because nothing imports them as a value: a port is an",
    "interface, so it is erased before either program runs. They are the API all",
    "the same — see [The slices](architecture.md).",
    "",
    ...unbound.map((one) => `- \`${one}\``),
  );

  return `${out.join("\n")}\n`;
}

export async function graph(): Promise<{ modules: string[]; edges: Edge[] }> {
  const modules = await sources();
  const edges: Edge[] = [];
  for (const modulePath of modules) {
    const source = await fs.readFile(path.join(REPO_ROOT, modulePath), "utf-8");
    edges.push(...edgesIn(modulePath, source));
  }
  return { modules, edges };
}

if (import.meta.main) {
  const out = process.argv[2] ?? DEFAULT_OUT;
  const { modules, edges } = await graph();
  await fs.writeFile(out, render(modules, edges), "utf-8");
  process.stdout.write(
    `${out}: ${modules.length} modules, ${edges.length} imports\n`,
  );
}
