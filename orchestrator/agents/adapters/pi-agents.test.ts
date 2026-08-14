import { describe, expect, test } from "bun:test";
import { type Catalog, type ModelAuth, PiAgents } from "./pi-agents.ts";
import { ORCHESTRATOR_DIR } from "../../testing/graph-jig.ts";
import { aSlot, fakePaths } from "../../testing/ports.ts";

function aCatalog(baseUrl: string, auth: ModelAuth = {}): Catalog {
  return {
    getModel: () => ({ api: "openai-completions", baseUrl }),
    getAuth: () => Promise.resolve({ auth }),
  };
}

function agentsOf(models: Catalog): PiAgents {
  return new PiAgents(
    fakePaths(),
    [aSlot({ healthCheck: true })],
    models,
    "/repo",
    ORCHESTRATOR_DIR,
    "pi",
    "bwrap",
  );
}

function anInferenceServer(
  respond: (request: Request) => Response,
): { url: string; paths: string[] } & Disposable {
  const paths: string[] = [];
  const server = Bun.serve({
    port: 0,
    fetch: (request) => {
      paths.push(new URL(request.url).pathname);
      return respond(request);
    },
  });
  return {
    url: `http://localhost:${server.port}/v1`,
    paths,
    [Symbol.dispose]: () => {
      void server.stop(true);
    },
  };
}

describe("Feature: asking a provider whether it is up", () => {
  test("a provider that lists its models is healthy", async () => {
    // Given an inference server answering its model list
    using inference = anInferenceServer(() => Response.json({ data: [] }));
    const agents = agentsOf(aCatalog(inference.url));

    // When the slot's provider is checked
    const reason = await agents.unhealthy(aSlot({ healthCheck: true }));

    // Then the slot may be dispatched to, and the model list is what was asked for
    expect(reason).toBeUndefined();
    expect(inference.paths).toEqual(["/v1/models"]);
  });

  test("a provider that answers with an error is not healthy", async () => {
    // Given an inference server that is up but failing every request
    using inference = anInferenceServer(
      () => new Response("no model loaded", { status: 503 }),
    );
    const agents = agentsOf(aCatalog(inference.url));

    // When the slot's provider is checked
    const reason = await agents.unhealthy(aSlot({ healthCheck: true }));

    // Then it is treated as down, and the log has the status to work from
    expect(reason).toMatch(/answered 503$/);
  });

  test("a provider nothing is listening on is not healthy", async () => {
    // Given the address of an inference server that has been stopped
    const stopped = anInferenceServer(() => new Response("never"));
    stopped[Symbol.dispose]();
    const agents = agentsOf(aCatalog(stopped.url));

    // When the slot's provider is checked
    const reason = await agents.unhealthy(aSlot({ healthCheck: true }));

    // Then the refused connection is an answer, not a crash
    expect(reason).toBeString();
  });

  test("the provider's api key is carried on the health check", async () => {
    // Given an inference server that reports back the authorization it was sent
    let seen = "";
    using inference = anInferenceServer((request) => {
      seen = request.headers.get("authorization") ?? "";
      return Response.json({ data: [] });
    });
    const agents = agentsOf(aCatalog(inference.url, { apiKey: "sk-secret" }));

    // When the slot's provider is checked
    await agents.unhealthy(aSlot({ healthCheck: true }));

    // Then the key pi would stream with is the key the health check authenticates with
    expect(seen).toBe("Bearer sk-secret");
  });

  test("a model pi does not know is an answer, not a crash", async () => {
    // Given a pool naming a model that is in no provider pi knows
    const agents = agentsOf({
      getModel: () => undefined,
      getAuth: () => Promise.resolve(undefined),
    });

    // When the slot's provider is checked
    const reason = await agents.unhealthy(
      aSlot({ provider: "cuda", model: "qwen", healthCheck: true }),
    );

    // Then the pool holds the slot back over it instead of the tick dying on it
    expect(reason).toBe('pi knows no model "qwen" on provider "cuda"');
  });

  test("an api with no model list is an answer, not a crash", async () => {
    // Given a provider whose api the orchestrator has no health check for
    const agents = agentsOf({
      getModel: () => ({ api: "some-new-api", baseUrl: "http://localhost:1" }),
      getAuth: () => Promise.resolve(undefined),
    });

    // When the slot's provider is checked
    const reason = await agents.unhealthy(aSlot({ healthCheck: true }));

    // Then the api it cannot check is named, and the tick carries on
    expect(reason).toStartWith('no health check for api "some-new-api"');
  });
});
