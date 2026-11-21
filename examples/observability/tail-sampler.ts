/**
 * In-Memory Tail-Based Tracing Decision Helper (Heuristic Filter)
 * 
 * Production Architecture Notice:
 * For multi-instance distributed tracing, the OpenTelemetry Collector with its
 * `tail_sampling` processor is the industry standard.
 * 
 * This in-memory sampler demonstrates the decision heuristics for buffering in-flight spans
 * and evaluating sampling decisions upon request completion (retaining 100% of errors
 * and slow-request outliers, while downsampling healthy fast requests).
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
  attributes: Record<string, unknown>;
}

export interface TailSamplingPolicy {
  errorSamplingRate: number;      // 1.0 = 100%
  slowThresholdMs: number;        // Fixed latency threshold (e.g. 1000ms)
  slowSamplingRate: number;       // 1.0 = 100%
  tier0SamplingRate: number;      // 1.0 = 100%
  baselineSamplingRate: number;   // 0.01 = 1%
  maxActiveTraces?: number;       // Bounded memory protection (default: 5000)
  maxSpansPerTrace?: number;      // Bounded trace size protection (default: 100)
  traceTtlMs?: number;            // Eviction TTL for abandoned spans (default: 30000ms)
}

interface InFlightTraceEntry {
  createdAt: number;
  spans: Span[];
}

export class TailSampler {
  private inFlightTraces = new Map<string, InFlightTraceEntry>();
  private readonly policy: Required<TailSamplingPolicy>;

  constructor(policy: Partial<TailSamplingPolicy> = {}) {
    this.policy = {
      errorSamplingRate: 1.0,
      slowThresholdMs: 1000,
      slowSamplingRate: 1.0,
      tier0SamplingRate: 1.0,
      baselineSamplingRate: 0.01,
      maxActiveTraces: 5000,
      maxSpansPerTrace: 100,
      traceTtlMs: 30_000,
      ...policy,
    };
  }

  //? Evicts abandoned traces to guarantee zero unbounded memory growth
  private pruneExpiredTraces(): void {
    const now = Date.now();
    for (const [traceId, entry] of this.inFlightTraces.entries()) {
      if (now - entry.createdAt > this.policy.traceTtlMs) {
        this.inFlightTraces.delete(traceId);
      }
    }
  }

  public recordSpan(span: Span): void {
    // Periodic bounded eviction
    if (this.inFlightTraces.size >= this.policy.maxActiveTraces) {
      this.pruneExpiredTraces();
      // If still saturated, drop span to prevent heap exhaustion
      if (this.inFlightTraces.size >= this.policy.maxActiveTraces) {
        return;
      }
    }

    const entry = this.inFlightTraces.get(span.traceId) ?? {
      createdAt: Date.now(),
      spans: [],
    };

    if (entry.spans.length < this.policy.maxSpansPerTrace) {
      entry.spans.push(span);
    }

    this.inFlightTraces.set(span.traceId, entry);
  }

  /**
   * Called when root request terminates. Evaluates heuristic policies to decide whether to flush or drop.
   */
  public evaluateTrace(
    traceId: string,
    metadata: { statusCode: number; durationMs: number; tier?: number }
  ): { sampled: boolean; reason: string; spans: Span[] } {
    const entry = this.inFlightTraces.get(traceId);
    this.inFlightTraces.delete(traceId);

    const spans = entry?.spans ?? [];

    // Rule 1: Errors (5xx or explicit error)
    if (metadata.statusCode >= 500 || spans.some((s) => s.error)) {
      if (Math.random() < this.policy.errorSamplingRate) {
        return { sampled: true, reason: 'error_occurred', spans };
      }
    }

    // Rule 2: Latency Outliers (slow-request threshold)
    if (metadata.durationMs >= this.policy.slowThresholdMs) {
      if (Math.random() < this.policy.slowSamplingRate) {
        return { sampled: true, reason: 'latency_threshold_exceeded', spans };
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
