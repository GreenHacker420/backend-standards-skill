export interface RetryOptions {
    retries?: number;
    minDelayMs?: number;
    maxDelayMs?: number;
    factor?: number;
    isIdempotent?: boolean; // When true, allows up to 1 retry on HTTP 500 internal server errors
    shouldRetry?: (error: unknown, attempt: number) => boolean;
    onRetry?: (error: unknown, attempt: number, delayMs: number) => void;
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
        
        // Rate limited or temporary gateway/service unavailability
        if (status === 429 || status === 502 || status === 503 || status === 504) {
            return true;
        }

        // On idempotent operations, allow a single cautious retry on HTTP 500
        if (status === 500 && isIdempotent && attempt === 1) {
            return true;
        }

        // 4xx errors (client errors) should never be retried
        if (status >= 400 && status < 500) {
            return false;
        }
    }

    // Node.js network drops
    if (err.code) {
        const transientCodes = new Set(['ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED', 'EAI_AGAIN', 'EPIPE']);
        if (transientCodes.has(err.code)) {
            return true;
        }
        // PostgreSQL deadlock (40P01) or serialization failure (40001)
        if (err.code === '40P01' || err.code === '40001') {
            return true;
        }
    }

    return false;
}

/**
 * Retries an asynchronous operation with AWS Full Jitter.
 * 
 * Full Jitter formula: sleep = Math.random() * Math.min(maxDelay, minDelay * factor^(attempt-1))
 * Prevents "thundering herd" and synchronized retry storms against upstream services.
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
        isIdempotent = false,
        shouldRetry = (err, att) => isTransientError(err, att, isIdempotent),
        onRetry,
    } = options;

    let attempt = 0;

    while (true) {
        try {
            return await operation();
        } catch (error) {
            attempt++;
            if (attempt > retries || !shouldRetry(error, attempt)) {
                throw error;
            }

            // Check if remote service specified a Retry-After backoff
            const retryAfterMs = extractRetryAfterMs(error);
            let delay: number;

            if (retryAfterMs !== null) {
                delay = Math.min(maxDelayMs, retryAfterMs);
            } else {
                // AWS Full Jitter: Uniformly distributed between 0 and calculated exponential ceiling
                const ceiling = Math.min(maxDelayMs, minDelayMs * Math.pow(factor, attempt - 1));
                delay = Math.random() * ceiling;
            }

            if (onRetry) {
                onRetry(error, attempt, delay);
            } else {
                console.warn(`[Retry] Attempt ${attempt}/${retries} failed. Backing off for ${Math.round(delay)}ms...`);
            }

            await new Promise((resolve) => setTimeout(resolve, delay));
        }
    }
}
