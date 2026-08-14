import { describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import path from "node:path";
import { groupOf } from "./kernel/domain/pattern.ts";
import { memberOf } from "./kernel/domain/lookup.ts";
import { at } from "./testing/present.ts";
import { graph, render, valueImport } from "./testing/import-graph.ts";

const ROOT = import.meta.dir;

const SLICES = [
  "kernel",
  "vocabulary",
  "views",
  "prompting",
  "workspaces",
  "runtime",
  "agents",
  "checks",
  "tasks",
  "console",
  "main",
] as const;

type Slice = (typeof SLICES)[number];

const isSlice = memberOf(SLICES);

const LAYERS = ["domain", "policy", "ports", "app", "adapters"] as const;

type Layer = (typeof LAYERS)[number];

const isLayer = memberOf(LAYERS);

const PURE_LAYERS: Layer[] = ["domain", "policy", "ports"];

const PURE_SLICES: Slice[] = ["vocabulary", "views"];

const NOT_CODE = ["prompts"];

const EFFECTS =
  /from "node:|Bun\.(spawn|spawnSync|file|write|sleep|stdin|stdout|connect|listen)|process\.(env|argv|stdout|stdin|kill|exit)/;

interface Module {
  path: string;
  slice?: Slice;
  layer?: Layer;
  source: string;
}

function sliceOf(relative: string): Slice | undefined {
  const head = at(relative.split(path.sep), 0);
  return isSlice(head) ? head : undefined;
}

function layerOf(relative: string): Layer | undefined {
  const parts = relative.split(path.sep);
  if (parts.length < 3) {
    return undefined;
  }
  const head = at(parts, 1);
  return isLayer(head) ? head : undefined;
}

async function walk(
  dir: string,
  keep: (name: string) => boolean,
): Promise<string[]> {
  const found: string[] = [];

  const descend = async (into: string) => {
    for (const entry of await fs.readdir(into, { withFileTypes: true })) {
      const full = path.join(into, entry.name);
      if (entry.isDirectory()) {
        if (!NOT_CODE.includes(entry.name)) {
          await descend(full);
        }
        continue;
      }
      if (keep(entry.name)) {
        found.push(path.relative(ROOT, full));
      }
    }
  };

  await descend(dir);
  return found;
}

function read(files: string[]): Promise<Module[]> {
  return Promise.all(
    files.map(async (relative) => ({
      path: relative,
      slice: sliceOf(relative),
      layer: layerOf(relative),
      source: await fs.readFile(path.join(ROOT, relative), "utf-8"),
    })),
  );
}

function modules(): Promise<Module[]> {
  return walk(
    ROOT,
    (name) => name.endsWith(".ts") && !name.endsWith(".test.ts"),
  ).then(read);
}

function suites(): Promise<Module[]> {
  return walk(ROOT, (name) => name.endsWith(".test.ts")).then(read);
}

function importsOf(module: Module): string[] {
  return [...module.source.matchAll(/from "(\.[^"]*\.ts)"/g)].map((match) => {
    const target = path.join(path.dirname(module.path), groupOf(match, 1));
    return path.normalize(target);
  });
}

function valueImportsOf(module: Module): string[] {
  return [
    ...module.source.matchAll(
      /^import\s+([\s\S]*?)\s*from\s*"(\.[^"]*\.ts)";?$/gm,
    ),
  ]
    .filter((match) => valueImport(groupOf(match, 1)))
    .map((match) =>
      path.normalize(path.join(path.dirname(module.path), groupOf(match, 2))),
    );
}

function pure(module: Module): boolean {
  return (
    (module.slice ? PURE_SLICES.includes(module.slice) : false) ||
    (module.layer ? PURE_LAYERS.includes(module.layer) : false)
  );
}

describe("Feature: the slices", () => {
  test("every module belongs to a slice, bar the extensions and the test rig", async () => {
    // Given the modules that sit in no slice directory
    const loose = (await modules()).filter((module) => !module.slice);

    // When their names are collected
    const names = loose.map((module) => module.path).sort();

    // Then each is either a pi extension, which pi loads by path, or scaffolding
    const stray = names.filter(
      (name) =>
        !name.startsWith("result-tools") &&
        !name.startsWith("testing" + path.sep),
    );
    expect(stray).toEqual([]);
  });

  test("no slice imports one further out than its own", async () => {
    // Given every module in the orchestrator, tagged with the slice it sits in
    const sliced = (await modules()).filter(
      (module): module is Module & { slice: Slice } => Boolean(module.slice),
    );

    // When each module's imports are resolved to the slice they land in
    const crossings = sliced.flatMap((module) =>
      importsOf(module)
        .map((target) => ({ module, target, slice: sliceOf(target) }))
        .filter(
          (edge) =>
            edge.slice &&
            SLICES.indexOf(edge.slice) > SLICES.indexOf(module.slice),
        )
        .map((edge) => `${module.path} -> ${edge.target}`),
    );

    // Then the slices fall in a line, which is a graph with no cycle in it
    expect(crossings).toEqual([]);
  });

  test("no module imports a layer further out than its own", async () => {
    // Given every module that sits in a layer of its slice
    const layered = (await modules()).filter(
      (module): module is Module & { slice: Slice; layer: Layer } =>
        Boolean(module.slice && module.layer),
    );

    // Given the layers mean something in more than a handful of slices
    expect(new Set(layered.map((module) => module.slice)).size).toBeGreaterThan(
      4,
    );

    // When each module's imports inside its own slice are resolved to a layer
    const crossings = layered.flatMap((module) =>
      importsOf(module)
        .filter((target) => sliceOf(target) === module.slice)
        .map((target) => ({ module, target, layer: layerOf(target) }))
        .filter(
          (edge) =>
            edge.layer &&
            LAYERS.indexOf(edge.layer) > LAYERS.indexOf(module.layer),
        )
        .map((edge) => `${module.path} -> ${edge.target}`),
    );

    // Then inside a slice too, nothing points outward
    expect(crossings).toEqual([]);
  });

  test("a slice's use cases are private to it, and to the wiring", async () => {
    // Given every module outside the composition root
    const outside = (await modules()).filter(
      (module) => module.slice && module.slice !== "main",
    );

    // When each is searched for a value import of another slice's app layer
    const reaching = outside.flatMap((module) =>
      valueImportsOf(module)
        .filter(
          (target) =>
            layerOf(target) === "app" && sliceOf(target) !== module.slice,
        )
        .map((target) => `${module.path} -> ${target}`),
    );

    // Then only `main/compose.ts` holds one: a peer names the ports and the pure layers
    expect(reaching).toEqual([]);
  });

  test("the layers that only decide reach for no effect at all", async () => {
    // Given every module in a pure slice, or in a pure layer of one
    const inner = (await modules()).filter(pure);

    // Given those are the reason the decisions are testable in isolation
    expect(inner.length).toBeGreaterThan(30);

    // When each is searched for a filesystem, subprocess, network or environment effect
    const impure = inner
      .filter((module) => EFFECTS.test(module.source))
      .map((module) => module.path);

    // Then none of them reaches for one
    expect(impure).toEqual([]);
  });

  test("no test of a decision reaches for the filesystem", async () => {
    // Given every suite over a pure module, or over an application module
    const inside = (await suites()).filter(
      (suite) => pure(suite) || suite.layer === "app",
    );

    // Given there are enough of them for the rule to mean something
    expect(inside.length).toBeGreaterThan(15);

    // When each is searched for a filesystem effect or the temp directory rig
    const impure = inside
      .filter(
        (suite) =>
          EFFECTS.test(suite.source) || /temp-dirs\.ts/.test(suite.source),
      )
      .map((suite) => suite.path);

    // Then none of them needs a repository, a task directory or a subprocess
    expect(impure).toEqual([]);
  });
});

describe("Feature: what each slice keeps to itself", () => {
  test("the task documents are reached through the task graph and nothing else", async () => {
    // Given the modules that name the port over the task documents
    const naming = (await modules()).filter((module) =>
      /import[^;]*\bTasks\b[^;]*from "[^"]*ports\/tasks\.ts"/s.test(
        module.source,
      ),
    );

    // When they are listed
    const names = naming.map((module) => module.path).sort();

    // Then it is the graph, the adapter behind it, and the fake that stands in
    expect(names).toEqual(
      [
        path.join("tasks", "adapters", "task-documents.ts"),
        path.join("tasks", "app", "task-graph.ts"),
        path.join("testing", "ports.ts"),
      ].sort(),
    );
  });

  test("the queue that serialises edits is owned by the task graph alone", async () => {
    // Given every module that reaches for the edit queue
    const naming = (await modules()).filter((module) =>
      /from "[^"]*kernel\/domain\/queue\.ts"/.test(module.source),
    );

    // When they are listed
    const names = naming.map((module) => module.path).sort();

    // Then only the graph holds one, so no caller can mutate around it
    expect(names).toEqual([path.join("tasks", "app", "task-graph.ts")]);
  });

  test("nothing in the task slice points back at the server", async () => {
    // Given every module of the task slice apart from the lifecycle itself
    const inside = (await modules()).filter(
      (module) =>
        module.slice === "tasks" &&
        module.path !== path.join("tasks", "app", "server.ts"),
    );

    // When each is searched for an import of the server
    const back = inside
      .filter((module) => /from "[^"]*server\.ts"/.test(module.source))
      .map((module) => module.path);

    // Then none of them has one: the server ticks the modules, they do not call it
    expect(back).toEqual([]);
  });

  test("the console reads the published views and nothing else of the server", async () => {
    // Given every module of the console, which runs as its own process
    const inside = (await modules()).filter(
      (module) => module.slice === "console",
    );

    // Given the console is a whole program, not a corner of one
    expect(inside.length).toBeGreaterThan(4);

    // When each of its imports is resolved to the slice it lands in
    const reached = new Set(
      inside.flatMap((module) =>
        importsOf(module)
          .map((target) => sliceOf(target))
          .filter((slice): slice is Slice => Boolean(slice)),
      ),
    );

    // Then it names the wire contract and the shared plumbing, no decision of the server's
    expect([...reached].sort()).toEqual([
      "console",
      "kernel",
      "runtime",
      "views",
      "vocabulary",
    ]);
  });

  test("every view schema the console parses is declared in the wire contract", async () => {
    // Given the console, which knows the server only by what it publishes
    const drawn = (await modules()).filter(
      (module) => module.slice === "console",
    );

    // Given the schemas it names, less the ones it declares itself
    const named = new Set(
      drawn.flatMap((module) =>
        [...module.source.matchAll(/\b([A-Z]\w*View)\b/g)]
          .map((match) => groupOf(match, 1))
          .filter(
            (name) =>
              !drawn.some((one) =>
                new RegExp(`(interface|type|const) ${name}\\b`).test(
                  one.source,
                ),
              ),
          ),
      ),
    );

    // Given it parses more than one of them
    expect(named.size).toBeGreaterThan(3);

    // When each is looked for in the views slice
    const declared = (
      await Promise.all(
        (
          await walk(path.join(ROOT, "views"), (name) => name.endsWith(".ts"))
        ).map((one) => fs.readFile(path.join(ROOT, one), "utf-8")),
      )
    ).join("\n");
    const elsewhere = [...named].filter(
      (name) => !new RegExp(`export const ${name}\\b`).test(declared),
    );

    // Then each is declared there, and not in a policy the server also decides with
    expect(elsewhere).toEqual([]);
  });
});

describe("Feature: the drawing of it", () => {
  test("the import graph in the docs is the one the modules make", async () => {
    // Given the graph read out of the modules themselves
    const { modules: drawn, edges } = await graph();

    // When it is rendered
    const rendered = render(drawn, edges);

    // Then it is what docs/import-graph.md holds, because a stale diagram is a wrong one
    const published = await fs.readFile(
      path.join(ROOT, "..", "docs", "import-graph.md"),
      "utf-8",
    );
    expect(published).toBe(rendered);
  });
});
