//& Domain Boundary: Transient Fault Resilience 🛡️

export interface LoggerInterface {
    warn(message: string, ...meta: unknown[]): void;
    error(message: string, ...meta: unknown[]): void;
    info(message: string, ...meta: unknown[]): void;
}

export interface RetryBudget {
    canRetry(): boolean;
    recordAttempt(isRetry: boolean): void;
}

export interface RetryOptions {
    readonly retries?: number;
    readonly minDelayMs?: number;
    readonly maxDelayMs?: number;
    readonly factor?: number;
    readonly jitter?: boolean;          //? When true, applies AWS Full Jitter to eliminate thundering herds
    readonly isIdempotent?: boolean;    //! CRITICAL INVARIANT: Defaults to FALSE. Mid-flight network drops (ECONNRESET, ETIMEDOUT, 502, 504) are NOT retried unless isIdempotent is true!
    readonly retryBudget?: RetryBudget; // Optional token bucket governor
    readonly logger?: LoggerInterface;
    readonly shouldRetry?: (error: unknown, attempt: number, isIdempotent: boolean) => boolean;
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

    const dateMs = Date.parse(rawVal);
    if (!Number.isNaN(dateMs)) {
        const delta = dateMs - Date.now();
        return delta > 0 ? delta : 0;
    }

    return null;
}

/**
 * Evaluates whether an error is safe to retry.
 * 
 * Strict Production Safety Rules:
 * 1. Database deadlocks (40P01) and serialization conflicts (40001, P2034) are ALWAYS safe
 *    to retry because PostgreSQL aborted the transaction with zero side-effects.
 * 2. Connection-establishment failures (ECONNREFUSED, ENOTFOUND) are safe because
 *    the remote server never received the packet.
 * 3. Mid-flight network drops (ECONNRESET, ETIMEDOUT, 502, 504) are ONLY retried if
 *    isIdempotent === true. Retrying non-idempotent mutations risks duplicate payments/orders!
 * 4. 4xx Client Errors (400, 401, 403, 404, 422) must NEVER be retried.
 */
export function isTransientError(error: unknown, attempt: number, isIdempotent: boolean): boolean {
    if (!error || typeof error !== 'object') return false;
    const err = error as ErrorWithResponse;

    // 1. Database rollbacks (Always safe to retry)
    if (err.code) {
        const dbRollbackCodes = new Set([
            '40P01', // PostgreSQL deadlock detected (transaction rolled back)
            '40001', // PostgreSQL serialization failure (transaction rolled back)
            'P2034', // Prisma transaction failed due to write conflict/deadlock
            'P1001', // Can't reach database server
            'P1002', // Database server timed out
            'P1017', // Server closed connection
            'P2024', // Timed out fetching a connection from the pool
        ]);
        if (dbRollbackCodes.has(err.code)) {
            return true;
        }

        // Connection-refused (request never reached remote host)
        if (err.code === 'ECONNREFUSED' || err.code === 'ENOTFOUND') {
            return true;
        }

        // Mid-flight drops (ONLY safe if mutation is idempotent)
        const midFlightCodes = new Set([
            'ECONNRESET',
            'ETIMEDOUT',
            'ECONNABORTED',
            'EAI_AGAIN',
            'EPIPE',
            'UND_ERR_SOCKET',
            'UND_ERR_CONNECT_TIMEOUT',
            'UND_ERR_HEADERS_TIMEOUT',
        ]);
        if (midFlightCodes.has(err.code)) {
            //! SAFETY INVARIANT: If not idempotent, a dropped connection may have already executed upstream!
            return isIdempotent;
        }
    }

    // 2. HTTP Status Codes
    if (err.response?.status !== undefined) {
        const status = err.response.status;
        
        // Rate limited: always safe because request was rejected before execution
        if (status === 429) {
            return true;
        }

        // 503 Service Unavailable: upstream declared itself overloaded before processing
        if (status === 503) {
            return true;
        }

        // 502 Bad Gateway / 504 Gateway Timeout: upstream proxy timed out waiting for origin.
        // Origin may or may not have executed mutation. Only retry if idempotent!
        if (status === 502 || status === 504) {
            return isIdempotent;
        }

        // 500 Internal Server Error: allow 1 retry ONLY if idempotent
        if (status === 500 && isIdempotent && attempt === 1) {
            return true;
        }

        // 4xx client errors (bad payload, unauthorized, forbidden) fail fast
        if (status >= 400 && status < 500) {
            return false;
        }
    }

    return false;
}

/**
 * Retries an asynchronous operation with AWS Full Jitter and strict idempotency enforcement.
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
        isIdempotent = false, //! Default: NOT idempotent. Non-idempotent operations will not retry dropped responses!
        retryBudget,
        logger,
        shouldRetry = (err, att, idemp) => isTransientError(err, att, idemp),
        onRetry,
    } = options;

    let attempt = 0;

    while (true) {
        try {
            retryBudget?.recordAttempt(attempt > 0);
            return await operation();
        } catch (error) {
            attempt++;
            
            // 1. Check max retries & transient safety
            if (attempt > retries || !shouldRetry(error, attempt, isIdempotent)) {
                throw error;
            }

            // 2. Check retry budget capacity if configured
            if (retryBudget && !retryBudget.canRetry()) {
                logger?.warn('[Retry] Retry budget exhausted; failing fast to prevent downstream cascading failure.');
                throw new Error('[RetryBudgetExhausted] Downstream service degraded. Retry quota depleted.', {
                    cause: error,
                });
            }

            // 3. Compute exponential ceiling
            const ceiling = Math.min(maxDelayMs, minDelayMs * Math.pow(factor, attempt - 1));

            // 4. Apply AWS Full Jitter: Uniform random distribution between 0 and ceiling
            let delay = jitter ? Math.random() * ceiling : ceiling;

            // 5. Honor remote Retry-After header with optional jitter smoothing
            const retryAfterMs = extractRetryAfterMs(error);
            if (retryAfterMs !== null) {
                const boundedRetryAfter = Math.min(maxDelayMs, retryAfterMs);
                delay = jitter
                    ? boundedRetryAfter + Math.random() * Math.min(1000, boundedRetryAfter * 0.1)
                    : boundedRetryAfter;
            }

            // 6. Notify observers or emit structured telemetry log
            if (onRetry) {
                onRetry(error, attempt, delay);
            } else if (logger) {
                logger.warn('[Retry] Transient operation failure; scheduling retry with jitter', {
                    attempt,
                    maxRetries: retries,
                    delayMs: Math.round(delay),
                    isIdempotent,
                    jitterEnabled: jitter,
                });
            }

            await new Promise((resolve) => setTimeout(resolve, delay));
        }
    }
}
