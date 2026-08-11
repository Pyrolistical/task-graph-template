export const WINDOW = 10;

export interface Sample {
  timestampMs: number;
  tokens: number;
}

export type RateOf = (agent: string) => number | undefined;

export function tokensPerSecond(
  samples: Sample[],
  nowMs: number,
): number | undefined {
  const first = samples[0];
  const last = samples[samples.length - 1];
  if (!first || !last) {
    return undefined;
  }
  let durationMs = last.timestampMs - first.timestampMs;
  if (durationMs <= 0) {
    durationMs = nowMs - first.timestampMs;
  }
  if (durationMs <= 0) {
    return undefined;
  }
  let tokens = 0;
  for (const sample of samples) {
    tokens += sample.tokens;
  }
  return (tokens / durationMs) * 1000;
}

export function push(samples: Sample[], sample: Sample): void {
  samples.push(sample);
  if (samples.length > WINDOW) {
    samples.shift();
  }
}

export class Rates {
  readonly rateOf: RateOf = (agent) => this.rate(agent);

  private readonly windows = new Map<string, Sample[]>();

  record(agent: string, sample: Sample): void {
    const samples = this.windows.get(agent) ?? [];
    push(samples, sample);
    this.windows.set(agent, samples);
  }

  rate(agent: string, nowMs = Date.now()): number | undefined {
    const samples = this.windows.get(agent);
    if (!samples) {
      return undefined;
    }
    return tokensPerSecond(samples, nowMs);
  }
}
