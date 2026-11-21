export interface SingleflightOptions {
  readonly maxInFlightKeys?: number; // Bound key cardinality (default: 10000)
  readonly timeoutMs?: number;       // Optional caller wait timeout
}

/**
 * Singleflight (Request / Promise Coalescing)
 * Suppresses duplicate concurrent calls for the same key.
 * If 1,000 requests request the same missing cache key simultaneously,
 * only ONE database query is fired, and all 1,000 callers await its result.
 * 
 * Safety Guarantees:
 * 1. Strict Generic Typing: Zero `any` casts; return types are fully preserved.
 * 2. Independent Caller Timeout from Operation Lifecycle:
 *    If an individual caller's wait times out, the shared flight remains registered in `inFlight`
 *    until the underlying operation actually settles. This prevents concurrent callers from spawning
 *    duplicate background work when operations are slow.
 * 3. Bounded Cardinality: Drops new coalescing when `maxInFlightKeys` is saturated to prevent heap exhaustion.
 */
export class Singleflight {
  private inFlight = new Map<string, Promise<unknown>>();
  private readonly maxInFlightKeys: number;
  private readonly defaultTimeoutMs?: number;

  constructor(options: SingleflightOptions = {}) {
    this.maxInFlightKeys = options.maxInFlightKeys ?? 10000;
    this.defaultTimeoutMs = options.timeoutMs;

    if (this.maxInFlightKeys < 1) {
      throw new RangeError('[Singleflight] maxInFlightKeys must be an integer >= 1.');
    }
  }

  public async do<T>(key: string, fn: () => Promise<T>, callerTimeoutMs?: number): Promise<T> {
    let flightPromise = this.inFlight.get(key) as Promise<T> | undefined;

    if (!flightPromise) {
      // Bounded capacity check: if saturated, execute directly without coalescing
      if (this.inFlight.size >= this.maxInFlightKeys) {
        return fn();
      }

      // The shared underlying execution promise manages its own lifecycle in inFlight.
      // It deletes its key ONLY when the underlying operation settles, regardless of caller timeouts.
      flightPromise = (async () => {
        try {
          return await fn();
        } finally {
          this.inFlight.delete(key);
        }
      })();

      this.inFlight.set(key, flightPromise);
    }

    const effectiveTimeoutMs = callerTimeoutMs ?? this.defaultTimeoutMs;

    if (effectiveTimeoutMs && effectiveTimeoutMs > 0) {
      let timer: NodeJS.Timeout | undefined;
      const timeoutPromise = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error(`[Singleflight] Caller wait timed out after ${effectiveTimeoutMs}ms for key: ${key}`));
        }, effectiveTimeoutMs);
        timer.unref();
      });

      try {
        return await Promise.race([flightPromise, timeoutPromise]);
      } finally {
        if (timer) clearTimeout(timer);
      }
    }

    return await flightPromise;
  }

  public activeCount(): number {
    return this.inFlight.size;
  }

  public clear(): void {
    this.inFlight.clear();
  }
}

export const singleflight = new Singleflight();
