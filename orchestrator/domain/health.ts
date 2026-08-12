export const HEALTH_TIMEOUT_MS = 5000;

export interface Probe {
  url: string;
  headers: Record<string, string>;
}

type Headers = (apiKey: string) => Record<string, string>;

const bearer: Headers = (apiKey) => ({ authorization: `Bearer ${apiKey}` });

const PATHS: Record<string, string> = {
  "openai-completions": "/models",
  "openai-responses": "/models",
  "azure-openai-responses": "/models",
  "openai-codex-responses": "/models",
  "mistral-conversations": "/models",
  "google-generative-ai": "/models",
  "google-vertex": "/models",
  "anthropic-messages": "/v1/models",
};

const HEADERS: Record<string, Headers> = {
  "google-generative-ai": (apiKey) => ({ "x-goog-api-key": apiKey }),
  "google-vertex": (apiKey) => ({ "x-goog-api-key": apiKey }),
  "anthropic-messages": (apiKey) => ({
    "x-api-key": apiKey,
    "anthropic-version": "2023-06-01",
  }),
};

export function probe(baseUrl: string, api: string, apiKey?: string): Probe {
  const path = PATHS[api];
  if (!path) {
    throw new Error(
      `no health check for api "${api}"; this orchestrator knows ${Object.keys(PATHS).join(", ")}`,
    );
  }
  return {
    url: `${baseUrl.replace(/\/+$/, "")}${path}`,
    headers: !apiKey ? {} : (HEADERS[api] ?? bearer)(apiKey),
  };
}
