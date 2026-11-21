/**
 * In-Memory Tail-Based Tracing Sampler
 * Buffers spans during request lifecycle and evaluates sampling policy on completion.
 * Retains 100% of errors and p99 latency spikes, while downsampling healthy fast requests.
 */

export interface Span {
  traceId: string;
  spanId: string;
  name: string;
  startTime: number;
  endTime?: number;
  durationMs?: number;
  statusCode?: number;
  error?: boolean;
  attributes: Record<string, any>;
}

export interface TailSamplingPolicy {
  errorSamplingRate: number;      // 1.0 = 100%
  slowThresholdMs: number;        // e.g. 1000ms
  slowSamplingRate: number;       // 1.0 = 100%
  tier0SamplingRate: number;      // 1.0 = 100%
  baselineSamplingRate: number;   // 0.01 = 1%
}

export class TailSampler {
  private inFlightTraces = new Map<string, Span[]>();
  private readonly policy: TailSamplingPolicy;

  constructor(policy: Partial<TailSamplingPolicy> = {}) {
    this.policy = {
      errorSamplingRate: 1.0,
      slowThresholdMs: 1000,
      slowSamplingRate: 1.0,
      tier0SamplingRate: 1.0,
      baselineSamplingRate: 0.01,
      ...policy,
    };
  }

  public recordSpan(span: Span): void {
    const spans = this.inFlightTraces.get(span.traceId) ?? [];
    spans.push(span);
    this.inFlightTraces.set(span.traceId, spans);
  }

  /**
   * Called when root request terminates. Evaluates policies to decide whether to flush or drop.
   */
  public evaluateTrace(
    traceId: string,
    metadata: { statusCode: number; durationMs: number; tier?: number }
  ): { sampled: boolean; reason: string; spans: Span[] } {
    const spans = this.inFlightTraces.get(traceId) ?? [];
    this.inFlightTraces.delete(traceId);

    // Rule 1: Errors (5xx or explicit error)
    if (metadata.statusCode >= 500 || spans.some((s) => s.error)) {
      if (Math.random() < this.policy.errorSamplingRate) {
        return { sampled: true, reason: 'error_occurred', spans };
      }
    }

    // Rule 2: Latency Outliers (p95 / p99 violations)
    if (metadata.durationMs >= this.policy.slowThresholdMs) {
      if (Math.random() < this.policy.slowSamplingRate) {
        return { sampled: true, reason: 'latency_violation', spans };
      }
    }

    // Rule 3: Critical Tier 0 paths (Checkout / Auth)
    if (metadata.tier === 0) {
      if (Math.random() < this.policy.tier0SamplingRate) {
        return { sampled: true, reason: 'tier_0_critical', spans };
      }
    }

    // Rule 4: Normal Fast Baseline (e.g. 1%)
    if (Math.random() < this.policy.baselineSamplingRate) {
      return { sampled: true, reason: 'probabilistic_baseline', spans };
    }

    return { sampled: false, reason: 'dropped_healthy', spans: [] };
  }
}
