import { describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import path from "node:path";
import { groupOf } from "./domain/pattern.ts";
import { memberOf } from "./domain/lookup.ts";
import { at } from "./testing/present.ts";
import { graph, render } from "./testing/import-graph.ts";

const ROOT = import.meta.dir;

const LAYERS = ["domain", "policy", "app", "adapters", "main"] as const;

type Layer = (typeof LAYERS)[number];

const isLayer = memberOf(LAYERS);

const INNER: Layer[] = ["domain", "policy"];

const INNER_TESTS: Layer[] = ["domain", "policy", "app"];

const EFFECTS =
  /from "node:|Bun\.(spawn|spawnSync|file|write|sleep|stdin|stdout|connect|listen)|process\.(env|argv|stdout|stdin|kill|exit)/;

interface Module {
  path: string;
  layer?: Layer;
  source: string;
}

async function modules(): Promise<Module[]> {
  const found: Module[] = [];

  const walk = async (dir: string) => {
    for (const entry of await fs.readdir(dir, {
      withFileTypes: true,
    })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== "prompts") {
          await walk(full);
        }
        continue;
      }
      if (!entry.name.endsWith(".ts") || entry.name.endsWith(".test.ts")) {
        continue;
      }
      const relative = path.relative(ROOT, full);
      found.push({
        path: relative,
        layer: layerOf(relative),
        source: await fs.readFile(full, "utf-8"),
      });
    }
  };

  await walk(ROOT);
  return found;
}

async function suitesIn(layers: Layer[]): Promise<string[]> {
  const found: string[] = [];

  const walk = async (dir: string) => {
    for (const entry of await fs.readdir(dir, {
      withFileTypes: true,
    })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.name.endsWith(".test.ts")) {
        found.push(path.relative(ROOT, full));
      }
    }
  };

  for (const layer of layers) {
    await walk(path.join(ROOT, layer));
  }
  return found;
}

function importsOf(module: Module): string[] {
  return [...module.source.matchAll(/from "(\.[^"]*\.ts)"/g)].map((match) => {
    const target = path.join(path.dirname(module.path), groupOf(match, 1));
    return path.normalize(target);
  });
}

function layerOf(relative: string): Layer | undefined {
  const head = at(relative.split(path.sep), 0);
  return isLayer(head) ? head : undefined;
}

describe("Feature: the dependency rule", () => {
  test("no module imports a layer further out than its own", async () => {
    // Given every module in the orchestrator, tagged with its layer
    const layered = (await modules()).filter(
      (module): module is Module & { layer: Layer } => Boolean(module.layer),
    );

    // When each module's imports are resolved to the layer they land in
    const crossings = layered.flatMap((module) =>
      importsOf(module)
        .map((target) => ({ module, target, layer: layerOf(target) }))
        .filter(
          (edge) =>
            edge.layer &&
            LAYERS.indexOf(edge.layer) > LAYERS.indexOf(module.layer),
        )
        .map((edge) => `${module.path} -> ${edge.target}`),
    );

    // Then nothing in an inner layer points outward at all
    expect(crossings).toEqual([]);
  });

  test("the domain and policy layers reach for no effect at all", async () => {
    // Given the two layers that hold the pure decisions
    const inner = (await modules()).filter(
      (module) => module.layer && INNER.includes(module.layer),
    );

    // Given those layers are the reason the decisions are testable in isolation
    expect(inner.length).toBeGreaterThan(10);

    // When each is searched for a filesystem, subprocess, network or environment effect
    const impure = inner
      .filter((module) => EFFECTS.test(module.source))
      .map((module) => module.path);

    // Then none of them reaches for one
    expect(impure).toEqual([]);
  });

  test("no test in an inner layer reaches for the filesystem", async () => {
    // Given every suite in the layers that only decide
    const suites = await suitesIn(INNER_TESTS);

    // Given there are enough of them for the rule to mean something
    expect(suites.length).toBeGreaterThan(4);

    // When each is searched for a filesystem effect or the temp directory rig
    const impure = [];
    for (const suite of suites) {
      const source = await fs.readFile(path.join(ROOT, suite), "utf-8");
      if (EFFECTS.test(source) || /temp-dirs\.ts/.test(source)) {
        impure.push(suite);
      }
    }

    // Then none of them needs a repository, a task directory or a subprocess
    expect(impure).toEqual([]);
  });

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
        path.join("adapters", "task-documents.ts"),
        path.join("app", "task-graph.ts"),
        path.join("testing", "ports.ts"),
      ].sort(),
    );
  });

  test("the queue that serialises edits is owned by the task graph alone", async () => {
    // Given every module that reaches for the edit queue
    const naming = (await modules()).filter((module) =>
      /from "[^"]*domain\/queue\.ts"/.test(module.source),
    );

    // When they are listed
    const names = naming.map((module) => module.path).sort();

    // Then only the graph holds one, so no caller can mutate around it
    expect(names).toEqual([path.join("app", "task-graph.ts")]);
  });

  test("nothing in the application points back at the server", async () => {
    // Given every application module apart from the lifecycle itself
    const inside = (await modules()).filter(
      (module) =>
        module.layer === "app" && module.path !== path.join("app", "server.ts"),
    );

    // When each is searched for an import of the server
    const back = inside
      .filter((module) => /from "[^"]*server\.ts"/.test(module.source))
      .map((module) => module.path);

    // Then none of them has one: the server ticks the modules, they do not call it
    expect(back).toEqual([]);
  });

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

  test("the only modules outside a layer are the extensions and the test rig", async () => {
    // Given the modules that belong to no layer directory
    const loose = (await modules()).filter((module) => !module.layer);

    // When their names are collected
    const names = loose.map((module) => module.path).sort();

    // Then each is either a pi extension, which pi loads by path, or test scaffolding
    const stray = names.filter(
      (name) =>
        !name.startsWith("result-tools") &&
        !name.startsWith("testing" + path.sep),
    );
    expect(stray).toEqual([]);
  });
});
