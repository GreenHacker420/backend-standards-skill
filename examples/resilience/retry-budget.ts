/**
 * In-Process Token-Bucket Retry Budget Governor
 * 
 * Based on Google SRE and Finagle retry budget standards:
 * - Each regular initial request deposits fractional tokens into the bucket (e.g. 0.10 tokens = 10%).
 * - Retries withdraw 1.0 token.
 * - If available tokens < 1.0, retries are forbidden and fail fast immediately.
 * 
 * Multi-Instance Architecture Notice:
 * This implementation is an in-memory governor per Node.js process. In large distributed fleets,
 * either enforce retry budgets at the service mesh layer (Envoy/Linkerd) or back the token bucket with Redis.
 */

export interface RetryBudgetOptions {
  retryRatio?: number;      // Fraction of regular requests that may be retried (default: 0.10 = 10%)
  maxTokens?: number;       // Upper bound on token capacity (default: 100)
  minRetriesPerSec?: number;// Small baseline drip to allow retries during very low traffic (default: 1)
}

export class TokenBucketRetryBudget {
  private tokens: number;
  private lastDripTime: number;
  private readonly retryRatio: number;
  private readonly maxTokens: number;
  private readonly minRetriesPerSec: number;

  constructor(options: RetryBudgetOptions = {}) {
    this.retryRatio = options.retryRatio ?? 0.10;
    this.maxTokens = options.maxTokens ?? 100;
    this.minRetriesPerSec = options.minRetriesPerSec ?? 1;
    this.tokens = 10; // Initial bootstrap burst
    this.lastDripTime = Date.now();
  }

  //? Replenish baseline drip tokens over time
  private replenish(): void {
    const now = Date.now();
    const elapsedSeconds = (now - this.lastDripTime) / 1000;
    if (elapsedSeconds > 0) {
      const addedTokens = elapsedSeconds * this.minRetriesPerSec;
      this.tokens = Math.min(this.maxTokens, this.tokens + addedTokens);
      this.lastDripTime = now;
    }
  }

  /**
   * Called by the request runner for every attempt.
   * Only initial requests (isRetry = false) deposit tokens! Retries never generate tokens.
   */
  public recordAttempt(isRetry: boolean): void {
    this.replenish();
    if (!isRetry) {
      // Normal request earns fractional retry capacity
      this.tokens = Math.min(this.maxTokens, this.tokens + this.retryRatio);
    }
  }

  /**
   * Returns true if there is sufficient token capacity to permit a retry attempt.
   */
  public canRetry(): boolean {
    this.replenish();
    if (this.tokens >= 1.0) {
      this.tokens -= 1.0;
      return true;
    }
    return false;
  }

  public getAvailableTokens(): number {
    this.replenish();
    return Math.floor(this.tokens);
  }
}
