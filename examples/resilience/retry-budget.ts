/**
 * In-Process Token-Bucket Retry Budget Governor
 * 
 * Implements a local token-bucket retry governor with a target retry ratio and burst capacity:
 * - Each regular initial request deposits fractional tokens into the bucket (e.g. 0.10 tokens = 10% target retry ratio).
 * - Retries withdraw 1.0 full token.
 * - If available tokens < 1.0, retries are forbidden and fail fast immediately.
 * - Initial bootstrap tokens (10) and a small baseline replenishment (minRetriesPerSec = 1) permit legitimate retries
 *   during cold start or low-traffic periods without starving transient recovery.
 * 
 * Fleet-Wide Governance Notice:
 * This implementation is a process-local governor per Node.js instance. Because local buckets permit bursts and baseline
 * refills, this provides an effective rate governor rather than a rigid mathematically strict 10% ceiling in every rolling second.
 * When strict fleet-wide cross-pod quota enforcement is required across hundreds of microservices, enforce retry budgets
 * at the service mesh layer (Envoy/Linkerd) or back the token bucket using an atomic Redis script.
 */

export interface RetryBudgetOptions {
  retryRatio?: number;      // Fraction of regular requests that may be retried (default: 0.10 = 10%)
  maxTokens?: number;       // Upper bound on token capacity (default: 100)
  minRetriesPerSec?: number;// Small baseline drip to allow retries during very low traffic (default: 1)
  initialTokens?: number;   // Initial bootstrap tokens (default: 10)
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
    this.tokens = options.initialTokens ?? 10;
    this.lastDripTime = Date.now();

    if (this.retryRatio < 0 || this.retryRatio > 1) {
      throw new RangeError('[TokenBucketRetryBudget] retryRatio must be between 0 and 1.');
    }
    if (this.maxTokens < 1 || !Number.isFinite(this.maxTokens)) {
      throw new RangeError('[TokenBucketRetryBudget] maxTokens must be a positive number >= 1.');
    }
    if (this.minRetriesPerSec < 0 || !Number.isFinite(this.minRetriesPerSec)) {
      throw new RangeError('[TokenBucketRetryBudget] minRetriesPerSec must be a non-negative number.');
    }
    if (this.tokens < 0 || !Number.isFinite(this.tokens)) {
      throw new RangeError('[TokenBucketRetryBudget] initialTokens must be a non-negative number.');
    }
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
    // Use epsilon (1e-9) to prevent floating-point precision drift (e.g. 10 * 0.1 = 0.9999999999999999)
    if (this.tokens >= 1.0 - 1e-9) {
      this.tokens = Math.max(0, this.tokens - 1.0);
      return true;
    }
    return false;
  }

  public getAvailableTokens(): number {
    this.replenish();
    return Math.floor(this.tokens);
  }
}
