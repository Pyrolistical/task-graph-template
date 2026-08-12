import { describe, expect, test } from "bun:test";
import { probe } from "./health.ts";

describe("Feature: where a provider is asked whether it is up", () => {
  test("an openai-compatible provider is asked for its model list", () => {
    // Given a local llama.cpp server, whose api is openai-completions
    const baseUrl = "http://192.168.1.202:2345/v1";

    // When the health check for that provider is worked out
    const health = probe(baseUrl, "openai-completions");

    // Then it is the model list under the base url the agent would stream from
    expect(health.url).toBe("http://192.168.1.202:2345/v1/models");
  });

  test("anthropic is asked for the model list under its version prefix", () => {
    // Given the anthropic provider, whose base url carries no version segment
    const baseUrl = "https://api.anthropic.com";

    // When the health check for that provider is worked out
    const health = probe(baseUrl, "anthropic-messages");

    // Then the version prefix the messages api lives under is part of the url
    expect(health.url).toBe("https://api.anthropic.com/v1/models");
  });

  test("a base url with a trailing slash does not double it", () => {
    // Given a provider whose base url was written with a trailing slash
    const baseUrl = "http://192.168.1.88:1234/v1/";

    // When the health check for that provider is worked out
    const health = probe(baseUrl, "openai-completions");

    // Then the url has one slash between the base and the path
    expect(health.url).toBe("http://192.168.1.88:1234/v1/models");
  });

  test("a keyless provider is asked without an authorization header", () => {
    // Given a local server that takes no api key
    const baseUrl = "http://192.168.1.202:2345/v1";

    // When the health check for that provider is worked out
    const health = probe(baseUrl, "openai-completions");

    // Then nothing is sent with it
    expect(health.headers).toEqual({});
  });

  test("an openai-compatible provider carries its key as a bearer token", () => {
    // Given a provider configured with an api key
    const baseUrl = "https://api.deepseek.com";

    // When the health check for that provider is worked out
    const health = probe(baseUrl, "openai-completions", "sk-secret");

    // Then the key is sent the way that api takes it
    expect(health.headers).toEqual({ authorization: "Bearer sk-secret" });
  });

  test("anthropic carries its key as an api key and names the version", () => {
    // Given the anthropic provider configured with an api key
    const baseUrl = "https://api.anthropic.com";

    // When the health check for that provider is worked out
    const health = probe(baseUrl, "anthropic-messages", "sk-ant-secret");

    // Then the key is sent the way that api takes it, with the version it requires
    expect(health.headers).toEqual({
      "x-api-key": "sk-ant-secret",
      "anthropic-version": "2023-06-01",
    });
  });

  test("google carries its key in the header that api reads", () => {
    // Given the google provider configured with an api key
    const baseUrl = "https://generativelanguage.googleapis.com/v1beta";

    // When the health check for that provider is worked out
    const health = probe(baseUrl, "google-generative-ai", "secret");

    // Then the key is sent the way that api takes it
    expect(health.headers).toEqual({ "x-goog-api-key": "secret" });
  });

  test("an api with no known health endpoint is refused by name", () => {
    // Given bedrock, which is reached over aws signing rather than a url
    const baseUrl = "https://bedrock-runtime.us-east-1.amazonaws.com";

    // When the health check for that provider is worked out
    const attempt = () => probe(baseUrl, "bedrock-converse-stream");

    // Then it is refused, naming the apis that can be checked
    expect(attempt).toThrow(
      /no health check for api "bedrock-converse-stream".*openai-completions/s,
    );
  });
});
