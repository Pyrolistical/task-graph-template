import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";

const ROOT = import.meta.dir;

const LAYERS = ["domain", "policy", "app", "adapters", "main"] as const;

type Layer = (typeof LAYERS)[number];

const INNER: Layer[] = ["domain", "policy"];

const INNER_TESTS: Layer[] = ["domain", "policy", "app"];

const EFFECTS =
  /from "node:|Bun\.(spawn|spawnSync|file|write|sleep|stdin|stdout|connect|listen)|process\.(env|argv|stdout|stdin|kill|exit)/;

interface Module {
  path: string;
  layer: Layer | null;
  source: string;
}

function modules(): Module[] {
  const found: Module[] = [];

  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== "prompts") {
          walk(full);
        }
        continue;
      }
      if (!entry.name.endsWith(".ts") || entry.name.endsWith(".test.ts")) {
        continue;
      }
      const relative = path.relative(ROOT, full);
      const head = relative.split(path.sep)[0]!;
      found.push({
        path: relative,
        layer: (LAYERS as readonly string[]).includes(head)
          ? (head as Layer)
          : null,
        source: fs.readFileSync(full, "utf-8"),
      });
    }
  };

  walk(ROOT);
  return found;
}

function importsOf(module: Module): string[] {
  return [...module.source.matchAll(/from "(\.[^"]*\.ts)"/g)].map((match) => {
    const target = path.join(path.dirname(module.path), match[1]!);
    return path.normalize(target);
  });
}

function layerOf(relative: string): Layer | null {
  const head = relative.split(path.sep)[0]!;
  return (LAYERS as readonly string[]).includes(head) ? (head as Layer) : null;
}

describe("Feature: the dependency rule", () => {
  test("no module imports a layer further out than its own", () => {
    // Given every module in the orchestrator, tagged with its layer
    const layered = modules().filter((module) => module.layer !== null);

    // When each module's imports are resolved to the layer they land in
    const crossings = layered.flatMap((module) =>
      importsOf(module)
        .map((target) => ({ module, target, layer: layerOf(target) }))
        .filter(
          (edge) =>
            edge.layer !== null &&
            LAYERS.indexOf(edge.layer) > LAYERS.indexOf(module.layer!),
        )
        .map((edge) => `${module.path} -> ${edge.target}`),
    );

    // Then nothing in an inner layer points outward at all
    expect(crossings).toEqual([]);
  });

  test("the domain and policy layers reach for no effect at all", () => {
    // Given the two layers that hold the pure decisions
    const inner = modules().filter(
      (module) => module.layer !== null && INNER.includes(module.layer),
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

  test("no test in an inner layer reaches for the filesystem", () => {
    // Given every suite in the layers that only decide
    const suites: string[] = [];
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full);
        } else if (entry.name.endsWith(".test.ts")) {
          suites.push(path.relative(ROOT, full));
        }
      }
    };
    for (const layer of INNER_TESTS) {
      walk(path.join(ROOT, layer));
    }

    // Given there are enough of them for the rule to mean something
    expect(suites.length).toBeGreaterThan(4);

    // When each is searched for a filesystem effect or the temp directory rig
    const impure = suites.filter((suite) => {
      const source = fs.readFileSync(path.join(ROOT, suite), "utf-8");
      return EFFECTS.test(source) || /temp-dirs\.ts/.test(source);
    });

    // Then none of them needs a repository, a task directory or a subprocess
    expect(impure).toEqual([]);
  });

  test("the only modules outside a layer are the extensions and the test rig", () => {
    // Given the modules that belong to no layer directory
    const loose = modules().filter((module) => module.layer === null);

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
