//& Domain Boundary: Transient Fault Resilience 🛡️

export interface LoggerInterface {
    warn(message: string, ...meta: unknown[]): void;
    error(message: string, ...meta: unknown[]): void;
}

export interface RetryOptions {
    readonly retries?: number;
    readonly minDelayMs?: number;
    readonly maxDelayMs?: number;
    readonly factor?: number;
    readonly jitter?: boolean;       //? When true, applies AWS Full Jitter to eliminate thundering herds
    readonly isIdempotent?: boolean; //* Business Rule: Permits 1 cautious retry on HTTP 500 if mutation is idempotent
    readonly logger?: LoggerInterface;
    readonly shouldRetry?: (error: unknown, attempt: number) => boolean;
    readonly onRetry?: (error: unknown, attempt: number, delayMs: number) => void;
}

interface ErrorWithResponse {
    response?: {
        status?: number;
        headers?: Record<string, string | string[] | undefined>;
    };
    code?: string;
}

//? Extracts Retry-After header in milliseconds if provided by the remote server
export function extractRetryAfterMs(error: unknown): number | null {
    if (!error || typeof error !== 'object' || !('response' in error)) return null;
    const err = error as ErrorWithResponse;
    const retryHeader = err.response?.headers?.['retry-after'];
    if (!retryHeader) return null;

    const rawVal = Array.isArray(retryHeader) ? retryHeader[0] : retryHeader;
    const seconds = Number(rawVal);
    if (!Number.isNaN(seconds) && seconds > 0) {
        return seconds * 1000;
    }

    // Try parsing as HTTP date string
    const dateMs = Date.parse(rawVal);
    if (!Number.isNaN(dateMs)) {
        const delta = dateMs - Date.now();
        return delta > 0 ? delta : 0;
    }

    return null;
}

export function isTransientError(error: unknown, attempt: number, isIdempotent = false): boolean {
    if (!error || typeof error !== 'object') return false;
    const err = error as ErrorWithResponse;

    // HTTP Status Codes
    if (err.response?.status !== undefined) {
        const status = err.response.status;
        
        // 429 Too Many Requests, 502 Bad Gateway, 503 Service Unavailable, 504 Gateway Timeout
        if (status === 429 || status === 502 || status === 503 || status === 504) {
            return true;
        }

        //* On idempotent operations, allow a single cautious retry on HTTP 500 (transient web server restarts)
        if (status === 500 && isIdempotent && attempt === 1) {
            return true;
        }

        //! Hard Invariant: 4xx client errors (bad payload, forbidden) must NEVER be retried
        if (status >= 400 && status < 500) {
            return false;
        }
    }

    // Node.js network connection drops
    if (err.code) {
        const transientCodes = new Set(['ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED', 'EAI_AGAIN', 'EPIPE']);
        if (transientCodes.has(err.code)) {
            return true;
        }
        // PostgreSQL transaction deadlocks (40P01) or serialization failures (40001)
        if (err.code === '40P01' || err.code === '40001') {
            return true;
        }
    }

    return false;
}

/**
 * Retries an asynchronous operation with AWS Full Jitter.
 * 
 * Full Jitter formula: delay = Math.random() * ceiling
 * When jitter is disabled: delay = ceiling (deterministic for testing)
 * When Retry-After is present: adds smoothing jitter to prevent synchronized retry waves
 */
export async function withRetry<T>(
    operation: () => Promise<T>,
    options: RetryOptions = {},
): Promise<T> {
    const {
        retries = 3,
        minDelayMs = 1000,
        maxDelayMs = 10000,
        factor = 2,
        jitter = true,
        isIdempotent = false,
        logger,
        shouldRetry = (err, att) => isTransientError(err, att, isIdempotent),
        onRetry,
    } = options;

    let attempt = 0;

    while (true) {
        try {
            return await operation();
        } catch (error) {
            attempt++;
            
            // 1. Guard Clause: Max retries exceeded or error is non-transient
            if (attempt > retries || !shouldRetry(error, attempt)) {
                throw error;
            }

            // 2. Compute exponential ceiling
            const ceiling = Math.min(maxDelayMs, minDelayMs * Math.pow(factor, attempt - 1));

            // 3. Apply AWS Full Jitter: Uniform random distribution between 0 and ceiling
            let delay = jitter ? Math.random() * ceiling : ceiling;

            // 4. Honor remote Retry-After header with optional jitter smoothing
            const retryAfterMs = extractRetryAfterMs(error);
            if (retryAfterMs !== null) {
                const boundedRetryAfter = Math.min(maxDelayMs, retryAfterMs);
                //? Add slight jitter to Retry-After so synchronized clients don't strike concurrently
                delay = jitter
                    ? boundedRetryAfter + Math.random() * Math.min(1000, boundedRetryAfter * 0.1)
                    : boundedRetryAfter;
            }

            // 5. Notify observers or emit structured telemetry log
            if (onRetry) {
                onRetry(error, attempt, delay);
            } else if (logger) {
                logger.warn('[Retry] Transient operation failure; scheduling retry with jitter', {
                    attempt,
                    maxRetries: retries,
                    delayMs: Math.round(delay),
                    jitterEnabled: jitter,
                });
            }

            await new Promise((resolve) => setTimeout(resolve, delay));
        }
    }
}
