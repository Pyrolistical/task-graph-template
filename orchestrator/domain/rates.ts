export const WINDOW = 10;

export interface Sample {
  timestampMs: number;
  tokens: number;
}

export type RateOf = (agent: string) => number | null;

export function tokensPerSecond(
  samples: Sample[],
  nowMs: number,
): number | null {
  const first = samples[0];
  const last = samples[samples.length - 1];
  if (first === undefined || last === undefined) {
    return null;
  }
  let durationMs = last.timestampMs - first.timestampMs;
  if (durationMs <= 0) {
    durationMs = nowMs - first.timestampMs;
  }
  if (durationMs <= 0) {
    return null;
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

  rate(agent: string, nowMs = Date.now()): number | null {
    const samples = this.windows.get(agent);
    if (samples === undefined) {
      return null;
    }
    return tokensPerSecond(samples, nowMs);
  }
}
