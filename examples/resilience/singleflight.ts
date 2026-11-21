/**
 * Singleflight (Request / Promise Coalescing)
 * Suppresses duplicate concurrent calls for the same key.
 * If 1,000 requests request the same missing cache key simultaneously,
 * only ONE database query is fired, and all 1,000 callers await its result.
 */

export class Singleflight {
  private inFlight = new Map<string, Promise<any>>();

  public async do<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const existing = this.inFlight.get(key);
    if (existing) {
      return existing as Promise<T>;
    }

    const promise = fn()
      .then((res) => {
        this.inFlight.delete(key);
        return res;
      })
      .catch((err) => {
        this.inFlight.delete(key);
        throw err;
      });

    this.inFlight.set(key, promise);
    return promise;
  }

  public activeCount(): number {
    return this.inFlight.size;
  }
}

export const singleflight = new Singleflight();
