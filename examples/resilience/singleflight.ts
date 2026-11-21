export interface SingleflightOptions {
  readonly maxInFlightKeys?: number; // Bound key cardinality (default: 10000)
  readonly timeoutMs?: number;       // Optional execution timeout per coalesced flight
}

/**
 * Singleflight (Request / Promise Coalescing)
 * Suppresses duplicate concurrent calls for the same key.
 * If 1,000 requests request the same missing cache key simultaneously,
 * only ONE database query is fired, and all 1,000 callers await its result.
 * 
 * Safety Guarantees:
 * 1. Strict Generic Typing: Zero `any` casts; return types are fully preserved.
 * 2. Guaranteed Cleanup: Always removes keys in `finally` blocks, even on cancellation or error.
 * 3. Bounded Cardinality: Drops new coalescing when `maxInFlightKeys` is saturated to prevent heap exhaustion.
 * 4. Optional Timeout Protection: Prevents hung promises from wedging keys indefinitely.
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

  public async do<T>(key: string, fn: () => Promise<T>, timeoutMs?: number): Promise<T> {
    const existing = this.inFlight.get(key);
    if (existing) {
      return existing as Promise<T>;
    }

    // Bounded capacity check: if saturated, execute directly without coalescing
    if (this.inFlight.size >= this.maxInFlightKeys) {
      return fn();
    }

    const effectiveTimeoutMs = timeoutMs ?? this.defaultTimeoutMs;

    const flightPromise = (async () => {
      let timer: NodeJS.Timeout | undefined;
      try {
        if (effectiveTimeoutMs && effectiveTimeoutMs > 0) {
          const timeoutPromise = new Promise<never>((_, reject) => {
            timer = setTimeout(() => {
              reject(new Error(`[Singleflight] Operation timed out after ${effectiveTimeoutMs}ms for key: ${key}`));
            }, effectiveTimeoutMs);
            timer.unref();
          });
          return await Promise.race([fn(), timeoutPromise]);
        }
        return await fn();
      } finally {
        if (timer) clearTimeout(timer);
        this.inFlight.delete(key);
      }
    })();

    this.inFlight.set(key, flightPromise);
    return flightPromise;
  }

  public activeCount(): number {
    return this.inFlight.size;
  }

  public clear(): void {
    this.inFlight.clear();
  }
}

export const singleflight = new Singleflight();
