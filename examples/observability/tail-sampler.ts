/**
 * In-Memory Tail-Based Tracing Decision Helper (Best-Effort Heuristic Filter)
 * 
 * Production Architecture Notice:
 * For mission-critical multi-instance distributed tracing at scale, an out-of-process OpenTelemetry Collector
 * cluster with its official `tail_sampling` processor is the industry standard.
 * 
 * This in-memory sampler demonstrates the decision heuristics for buffering in-flight spans
 * within a single Node.js process and evaluating sampling decisions upon request completion.
 * Because in-process memory is bounded (`maxActiveTraces`, `maxSpansPerTrace`), it operates on a
 * BEST-EFFORT basis: during extreme traffic spikes or memory saturation, traces can be evicted
 * or marked incomplete to protect the Node.js heap from Out-Of-Memory crashes.
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
  slowThresholdMs: number;        // Latency threshold (e.g. 1000ms)
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
  droppedSpansCount: number;
}

export interface SamplingEvaluationResult {
  sampled: boolean;
  reason: string;
  incomplete: boolean;
  droppedSpansCount: number;
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

    // Validate rates and thresholds
    const rates = [
      this.policy.errorSamplingRate,
      this.policy.slowSamplingRate,
      this.policy.tier0SamplingRate,
      this.policy.baselineSamplingRate,
    ];
    for (const r of rates) {
      if (typeof r !== 'number' || Number.isNaN(r) || r < 0 || r > 1) {
        throw new RangeError('[TailSampler] Sampling rates must be numbers between 0.0 and 1.0.');
      }
    }
    if (this.policy.slowThresholdMs <= 0 || this.policy.maxActiveTraces <= 0 || this.policy.maxSpansPerTrace <= 0) {
      throw new RangeError('[TailSampler] Thresholds and capacities must be positive integers.');
    }
  }

  // Evicts abandoned traces to guarantee zero unbounded memory growth
  private pruneExpiredTraces(): void {
    const now = Date.now();
    for (const [traceId, entry] of this.inFlightTraces.entries()) {
      if (now - entry.createdAt > this.policy.traceTtlMs) {
        this.inFlightTraces.delete(traceId);
      }
    }
  }

  public recordSpan(span: Span): void {
    let entry = this.inFlightTraces.get(span.traceId);

    // Only apply trace capacity bounds when creating a brand NEW trace entry
    if (!entry) {
      if (this.inFlightTraces.size >= this.policy.maxActiveTraces) {
        this.pruneExpiredTraces();
        // If still saturated after pruning, drop the new trace to protect heap
        if (this.inFlightTraces.size >= this.policy.maxActiveTraces) {
          return;
        }
      }

      entry = {
        createdAt: Date.now(),
        spans: [],
        droppedSpansCount: 0,
      };
      this.inFlightTraces.set(span.traceId, entry);
    }

    if (entry.spans.length < this.policy.maxSpansPerTrace) {
      entry.spans.push(span);
    } else {
      entry.droppedSpansCount++;
    }
  }

  /**
   * Called when root request terminates. Evaluates heuristic policies to decide whether to flush or drop.
   */
  public evaluateTrace(
    traceId: string,
    metadata: { statusCode: number; durationMs: number; tier?: number }
  ): SamplingEvaluationResult {
    const entry = this.inFlightTraces.get(traceId);
    this.inFlightTraces.delete(traceId);

    if (!entry) {
      return {
        sampled: false,
        reason: 'trace_not_found_or_evicted',
        incomplete: true,
        droppedSpansCount: 0,
        spans: [],
      };
    }

    const isIncomplete = entry.droppedSpansCount > 0;

    // 1. Errors: Prioritize retaining error traces (HTTP 5xx or span error flag)
    const hasError = metadata.statusCode >= 500 || entry.spans.some((s) => s.error);
    if (hasError) {
      if (Math.random() < this.policy.errorSamplingRate) {
        return {
          sampled: true,
          reason: 'error_retention',
          incomplete: isIncomplete,
          droppedSpansCount: entry.droppedSpansCount,
          spans: entry.spans,
        };
      }
    }

    // 2. Slow Requests: Retain latency outliers exceeding threshold
    if (metadata.durationMs >= this.policy.slowThresholdMs) {
      if (Math.random() < this.policy.slowSamplingRate) {
        return {
          sampled: true,
          reason: 'slow_outlier_retention',
          incomplete: isIncomplete,
          droppedSpansCount: entry.droppedSpansCount,
          spans: entry.spans,
        };
      }
    }

    // 3. Tier 0 Critical Workloads
    if (metadata.tier === 0) {
      if (Math.random() < this.policy.tier0SamplingRate) {
        return {
          sampled: true,
          reason: 'tier0_revenue_retention',
          incomplete: isIncomplete,
          droppedSpansCount: entry.droppedSpansCount,
          spans: entry.spans,
        };
      }
    }

    // 4. Baseline Probabilistic Downsampling: Retain small fraction of healthy fast traces
    if (Math.random() < this.policy.baselineSamplingRate) {
      return {
        sampled: true,
        reason: 'baseline_sample',
        incomplete: isIncomplete,
        droppedSpansCount: entry.droppedSpansCount,
        spans: entry.spans,
      };
    }

    return {
      sampled: false,
      reason: 'dropped_healthy_fast_trace',
      incomplete: isIncomplete,
      droppedSpansCount: entry.droppedSpansCount,
      spans: [],
    };
  }

  public getActiveTraceCount(): number {
    return this.inFlightTraces.size;
  }
}
