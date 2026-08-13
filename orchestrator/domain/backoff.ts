import type { Retry } from "./agents.ts";

export const BACKOFF_START_MS = 1000;
export const BACKOFF_CAP_MS = 64000;
export const MODEL_LOADING_MS = 5000;

export interface Wait {
  at: string;
  attempt: number;
  backoff: number;
  delayMs: number;
  loading: boolean;
}

export function loadingModel(message: string): boolean {
  return /503/.test(message) && /load/i.test(message);
}

export function nextWait(
  message: string,
  current?: Wait,
  nowMs = Date.now(),
): Wait {
  const backoff = current?.backoff ?? BACKOFF_START_MS;
  const attempt = current?.attempt ?? 0;

  if (loadingModel(message)) {
    return {
      at: new Date(nowMs + MODEL_LOADING_MS).toISOString(),
      attempt,
      backoff,
      delayMs: MODEL_LOADING_MS,
      loading: true,
    };
  }

  const delayMs = Math.min(backoff, BACKOFF_CAP_MS);
  return {
    at: new Date(nowMs + delayMs).toISOString(),
    attempt: attempt + 1,
    backoff: Math.min(backoff * 2, BACKOFF_CAP_MS),
    delayMs,
    loading: false,
  };
}

export function due(wait: Wait, nowMs = Date.now()): boolean {
  return Date.parse(wait.at) <= nowMs;
}

export function retryOf(wait: Wait): Retry {
  return { at: wait.at, attempt: wait.attempt };
}
