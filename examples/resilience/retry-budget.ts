/**
 * Token-Bucket Retry Budget & Full Jitter Exponential Backoff
 * Prevents retry storms by capping retries to at most 10% of total outbound requests.
 */

export interface RetryBudgetOptions {
  windowMs?: number;        // Rolling window duration (default: 60s)
  ratio?: number;           // Max allowed retry-to-request ratio (default: 0.10 -> 10%)
  minRetriesPerSec?: number;// Minimum baseline retries permitted during low traffic (default: 2)
}

export class RetryBudget {
  private requestCount = 0;
  private retryCount = 0;
  private lastReset = Date.now();
  private readonly windowMs: number;
  private readonly ratio: number;
  private readonly minRetriesPerSec: number;

  constructor(options: RetryBudgetOptions = {}) {
    this.windowMs = options.windowMs ?? 60_000;
    this.ratio = options.ratio ?? 0.10;
    this.minRetriesPerSec = options.minRetriesPerSec ?? 2;
  }

  private rollWindow(): void {
    const now = Date.now();
    if (now - this.lastReset >= this.windowMs) {
      this.requestCount = 0;
      this.retryCount = 0;
      this.lastReset = now;
    }
  }

  public recordRequest(): void {
    this.rollWindow();
    this.requestCount++;
  }

  public canRetry(): boolean {
    this.rollWindow();
    const allowedRetries = Math.max(
      Math.floor(this.requestCount * this.ratio),
      Math.floor((this.minRetriesPerSec * this.windowMs) / 1000)
    );

    if (this.retryCount < allowedRetries) {
      this.retryCount++;
      return true;
    }

    return false;
  }

  public getStats() {
    return {
      requestCount: this.requestCount,
      retryCount: this.retryCount,
      windowAgeMs: Date.now() - this.lastReset
    };
  }
}

export interface BackoffOptions {
  baseMs?: number;
  maxMs?: number;
  maxAttempts?: number;
}

export function computeFullJitterDelay(attempt: number, baseMs = 100, maxMs = 5000): number {
  const exponentialCap = Math.min(maxMs, baseMs * Math.pow(2, attempt));
  // Full Jitter: random value between 0 and exponentialCap
  return Math.floor(Math.random() * exponentialCap);
}

/**
 * Executes an operation with retry budget enforcement and full jitter backoff.
 */
export async function executeWithRetryBudget<T>(
  operation: (attempt: number) => Promise<T>,
  budget: RetryBudget,
  options: BackoffOptions = {},
  isRetryable: (err: any) => boolean = (err) => err?.status >= 500 || err?.code === 'ECONNRESET'
): Promise<T> {
  const baseMs = options.baseMs ?? 100;
  const maxMs = options.maxMs ?? 5000;
  const maxAttempts = options.maxAttempts ?? 3;

  let attempt = 0;

  while (true) {
    try {
      budget.recordRequest();
      return await operation(attempt);
    } catch (err: any) {
      attempt++;

      if (attempt >= maxAttempts) {
        throw err;
      }

      if (!isRetryable(err)) {
        throw err; // Terminal error (e.g. 400 Bad Request) - fail fast immediately
      }

      if (!budget.canRetry()) {
        throw new Error('[RetryBudgetExhausted] Downstream under load. Max retry ratio exceeded.', {
          cause: err,
        });
      }

      // Check for explicit Retry-After header
      let delayMs: number;
      if (err?.headers?.['retry-after']) {
        const seconds = parseInt(err.headers['retry-after'], 10);
        delayMs = !isNaN(seconds) ? seconds * 1000 : computeFullJitterDelay(attempt, baseMs, maxMs);
      } else {
        delayMs = computeFullJitterDelay(attempt, baseMs, maxMs);
      }

      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
}
