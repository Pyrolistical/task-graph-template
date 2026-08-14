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
    const healthy = await agents.healthy(aSlot({ healthCheck: true }));

    // Then the slot may be dispatched to, and the model list is what was asked for
    expect(healthy).toBe(true);
    expect(inference.paths).toEqual(["/v1/models"]);
  });

  test("a provider that answers with an error is not healthy", async () => {
    // Given an inference server that is up but failing every request
    using inference = anInferenceServer(
      () => new Response("no model loaded", { status: 503 }),
    );
    const agents = agentsOf(aCatalog(inference.url));

    // When the slot's provider is checked
    const healthy = await agents.healthy(aSlot({ healthCheck: true }));

    // Then it is treated as down, because a slot dispatched into it would only fail
    expect(healthy).toBe(false);
  });

  test("a provider nothing is listening on is not healthy", async () => {
    // Given the address of an inference server that has been stopped
    const stopped = anInferenceServer(() => new Response("never"));
    stopped[Symbol.dispose]();
    const agents = agentsOf(aCatalog(stopped.url));

    // When the slot's provider is checked
    const healthy = await agents.healthy(aSlot({ healthCheck: true }));

    // Then the refused connection is an answer, not a crash
    expect(healthy).toBe(false);
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
    await agents.healthy(aSlot({ healthCheck: true }));

    // Then the key pi would stream with is the key the health check authenticates with
    expect(seen).toBe("Bearer sk-secret");
  });
});
