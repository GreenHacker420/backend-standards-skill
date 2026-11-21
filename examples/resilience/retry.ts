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
    readonly jitter?: boolean;                    //? When true, applies AWS Full Jitter to eliminate thundering herds
    readonly isIdempotent?: boolean;              //! CRITICAL INVARIANT: Defaults to FALSE. Non-idempotent operations will NOT retry dropped responses, 429, 502, 503, or 504!
    readonly isDatabaseOnlyTransaction?: boolean; //? When true, affirms operation has zero external side-effects so DB deadlocks (40P01/40001/P2034) are safe to retry even if isIdempotent is false
    readonly retryBudget?: RetryBudget;           // Optional token bucket governor
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
 * Evaluates whether an error represents a safe, transient failure eligible for retry.
 * 
 * Strict Production Safety Rules:
 * 1. Database deadlocks (40P01) and serialization conflicts (40001, P2034) are safe to retry
 *    if the operation is marked `isIdempotent: true` OR `isDatabaseOnlyTransaction: true`.
 *    If an operation performs external side-effects (e.g. notifications, payment calls) before/around
 *    the database transaction, retrying upon DB deadlock repeats those external effects!
 * 2. Pre-query connection failures (P1001, P2024, ECONNREFUSED, ENOTFOUND) are safe because
 *    the engine never received or began executing the operation.
 * 3. Uncertain mid-query database drops (P1002, P1017), HTTP 429 (RFC 6585 permits upstream work prior to 429),
 *    and network drops (ECONNRESET, ETIMEDOUT, 502, 503, 504) are ONLY retried if `isIdempotent === true`.
 * 4. 4xx Client Errors (400, 401, 403, 404, 422) must NEVER be retried.
 */
export function isTransientError(
    error: unknown,
    attempt: number,
    isIdempotent: boolean,
    isDatabaseOnlyTransaction = false
): boolean {
    if (!error || typeof error !== 'object') return false;
    const err = error as ErrorWithResponse;

    // 1. Database & Socket Error Codes
    if (err.code) {
        // Database deadlocks/serialization conflicts: Safe only if idempotent OR isolated DB-only transaction
        const dbRollbackCodes = new Set([
            '40P01', // PostgreSQL deadlock detected (transaction aborted)
            '40001', // PostgreSQL serialization failure (transaction aborted)
            'P2034', // Prisma transaction failed due to write conflict/deadlock
        ]);
        if (dbRollbackCodes.has(err.code)) {
            return isIdempotent || isDatabaseOnlyTransaction;
        }

        // Pre-query failures (query never reached or began execution on the database engine)
        const preQueryCodes = new Set([
            'P1001', // Cannot reach database server
            'P2024', // Timed out fetching a connection from the pool
            'ECONNREFUSED',
            'ENOTFOUND',
        ]);
        if (preQueryCodes.has(err.code)) {
            return true;
        }

        // Mid-flight drops & timeouts (Execution outcome uncertain; server may have committed!)
        const uncertainCodes = new Set([
            'P1002', // Database server timed out mid-query
            'P1017', // Server closed connection mid-query
            'ECONNRESET',
            'ETIMEDOUT',
            'ECONNABORTED',
            'EAI_AGAIN',
            'EPIPE',
            'UND_ERR_SOCKET',
            'UND_ERR_CONNECT_TIMEOUT',
            'UND_ERR_HEADERS_TIMEOUT',
        ]);
        if (uncertainCodes.has(err.code)) {
            //! SAFETY INVARIANT: If not idempotent, an uncertain drop may have already committed upstream!
            return isIdempotent;
        }
    }

    // 2. HTTP Status Codes
    if (err.response?.status !== undefined) {
        const status = err.response.status;
        
        // 429 Too Many Requests: RFC 6585 does not guarantee zero partial execution upstream prior to rate limiting.
        // Requires an explicit idempotency guarantee before retrying!
        if (status === 429) {
            return isIdempotent;
        }

        // 503 Service Unavailable: origin may have partially processed or timed out.
        // Requires an explicit idempotency guarantee before retrying!
        if (status === 503) {
            return isIdempotent;
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
        isDatabaseOnlyTransaction = false,
        retryBudget,
        logger,
        shouldRetry,
        onRetry,
    } = options;

    let attempt = 0;

    while (true) {
        try {
            retryBudget?.recordAttempt(attempt > 0);
            return await operation();
        } catch (error) {
            attempt++;
            
            // 1. Mandatory safety check: Base transient invariants cannot be bypassed by custom policies
            const isSafe = isTransientError(error, attempt, isIdempotent, isDatabaseOnlyTransaction);
            if (attempt > retries || !isSafe) {
                throw error;
            }

            // Custom policy can further restrict retries, but cannot override mandatory safety
            if (shouldRetry && !shouldRetry(error, attempt, isIdempotent)) {
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
                //? Do NOT shorten the provider's requested wait; hammering an overloaded service earlier than instructed violates backoff.
                //? If the requested wait exceeds maxDelayMs, fail fast immediately.
                if (retryAfterMs > maxDelayMs) {
                    logger?.warn('[Retry] Upstream Retry-After exceeds maxDelayMs; aborting retry to avoid violating upstream backoff.', {
                        retryAfterMs,
                        maxDelayMs,
                    });
                    throw error;
                }
                //? Bound jitter so it never causes total delay to exceed maxDelayMs
                const maxAllowedJitter = Math.max(0, maxDelayMs - retryAfterMs);
                const jitterDelta = jitter
                    ? Math.random() * Math.min(1000, maxAllowedJitter, retryAfterMs * 0.1)
                    : 0;
                delay = retryAfterMs + jitterDelta;
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
