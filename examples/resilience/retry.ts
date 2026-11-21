export interface RetryOptions {
    retries?: number;
    minDelayMs?: number;
    maxDelayMs?: number;
    factor?: number;
    jitter?: boolean;
    shouldRetry?: (error: unknown, attempt: number) => boolean;
    onRetry?: (error: unknown, attempt: number, delayMs: number) => void;
}

export function isTransientError(error: unknown): boolean {
    if (!error || typeof error !== 'object') return false;

    // HTTP 429, 502, 503, 504
    if ('response' in error && error.response && typeof error.response === 'object') {
        const status = (error.response as { status?: number }).status;
        if (status === 429 || (status !== undefined && status >= 502 && status <= 504)) return true;
        if (status !== undefined && status >= 400 && status < 500) return false;
    }

    // Node.js network connection drops
    if ('code' in error) {
        const code = (error as { code?: string }).code;
        if (code === 'ECONNRESET' || code === 'ETIMEDOUT' || code === 'ECONNREFUSED' || code === 'EAI_AGAIN') {
            return true;
        }
        // Postgres Deadlocks (40P01) and Serialization Failures (40001)
        if (code === '40P01' || code === '40001') return true;
    }

    return false;
}

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
        shouldRetry = isTransientError,
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

            let delay = Math.min(maxDelayMs, minDelayMs * Math.pow(factor, attempt - 1));
            if (jitter) {
                delay += Math.random() * delay * 0.3;
            }

            if (onRetry) {
                onRetry(error, attempt, delay);
            } else {
                console.warn(`[Retry] Attempt ${attempt}/${retries} failed. Retrying in ${Math.round(delay)}ms...`);
            }

            await new Promise((resolve) => setTimeout(resolve, delay));
        }
    }
}
