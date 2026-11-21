import { describe, it, expect, vi } from 'vitest';
import { withRetry, isTransientError, calculateDelay, extractRetryAfterMs } from '../examples/resilience/retry';
import { TokenBucketRetryBudget } from '../examples/resilience/retry-budget';

describe('Resilient Retry Strategy', () => {
    describe('isTransientError classification matrix', () => {
        it('rejects 4xx client errors unconditionally', () => {
            const clientErrors = [400, 401, 403, 404, 422];
            for (const status of clientErrors) {
                expect(isTransientError({ response: { status } }, 1, true)).toBe(false);
                expect(isTransientError({ response: { status } }, 1, false)).toBe(false);
            }
        });

        it('requires isIdempotent: true for HTTP 429, 502, 503, 504', () => {
            const uncertainStatuses = [429, 502, 503, 504];
            for (const status of uncertainStatuses) {
                // If not idempotent, must NOT retry
                expect(isTransientError({ response: { status } }, 1, false)).toBe(false);
                // If idempotent, may retry
                expect(isTransientError({ response: { status } }, 1, true)).toBe(true);
            }
        });

        it('requires isIdempotent: true for uncertain mid-flight network drops', () => {
            const uncertainCodes = ['ECONNRESET', 'ETIMEDOUT', 'ECONNABORTED', 'P1002', 'P1017'];
            for (const code of uncertainCodes) {
                expect(isTransientError({ code }, 1, false)).toBe(false);
                expect(isTransientError({ code }, 1, true)).toBe(true);
            }
        });

        it('permits database deadlocks and pre-query errors if idempotent OR database-only transaction', () => {
            const dbCodes = ['40P01', '40001', 'P2034', 'P1001', 'P2024', 'ECONNREFUSED', 'ENOTFOUND'];
            for (const code of dbCodes) {
                // Non-idempotent mixed with external side effects must NOT retry
                expect(isTransientError({ code }, 1, false, false)).toBe(false);
                // Safe if marked as isolated DB transaction
                expect(isTransientError({ code }, 1, false, true)).toBe(true);
                // Safe if marked idempotent
                expect(isTransientError({ code }, 1, true, false)).toBe(true);
            }
        });

        it('permits at most one retry on HTTP 500 when idempotent', () => {
            expect(isTransientError({ response: { status: 500 } }, 1, true)).toBe(true);
            expect(isTransientError({ response: { status: 500 } }, 2, true)).toBe(false);
            expect(isTransientError({ response: { status: 500 } }, 1, false)).toBe(false);
        });
    });

    describe('calculateDelay (Full Jitter)', () => {
        it('bounds delay between 0 and min(maxDelay, minDelay * factor^(attempt - 1))', () => {
            const minDelay = 100;
            const maxDelay = 2000;
            const factor = 2;

            for (let attempt = 1; attempt <= 5; attempt++) {
                const ceiling = Math.min(maxDelay, minDelay * Math.pow(factor, attempt - 1));
                for (let i = 0; i < 50; i++) {
                    const delay = calculateDelay(attempt, minDelay, maxDelay, factor, true);
                    expect(delay).toBeGreaterThanOrEqual(0);
                    expect(delay).toBeLessThanOrEqual(ceiling);
                }
            }
        });

        it('returns deterministic ceiling when jitter is disabled', () => {
            const delay = calculateDelay(3, 100, 5000, 2, false);
            expect(delay).toBe(400); // 100 * 2^2
        });
    });

    describe('TokenBucketRetryBudget', () => {
        it('restricts retries according to retry ratio', () => {
            const budget = new TokenBucketRetryBudget({
                maxTokens: 10,
                retryRatio: 0.1, // 1 retry per 10 regular requests
                minRetriesPerSec: 0,
                initialTokens: 0,
            });

            // Initially empty
            expect(budget.canRetry()).toBe(false);

            // Record 10 regular attempts -> adds 1.0 token
            for (let i = 0; i < 10; i++) {
                budget.recordAttempt(false);
            }

            expect(budget.canRetry()).toBe(true);
            budget.recordAttempt(true); // Consumes 1.0 token

            // Now exhausted
            expect(budget.canRetry()).toBe(false);
        });
    });

    describe('withRetry execution', () => {
        it('resolves immediately when action succeeds on first try', async () => {
            const fn = vi.fn().mockResolvedValue('success');
            const result = await withRetry(fn);
            expect(result).toBe('success');
            expect(fn).toHaveBeenCalledTimes(1);
        });

        it('retries transient errors with idempotency protection', async () => {
            const fn = vi.fn()
                .mockRejectedValueOnce({ response: { status: 503 } })
                .mockResolvedValueOnce('recovered');

            const result = await withRetry(fn, {
                retries: 2,
                minDelayMs: 10,
                maxDelayMs: 50,
                isIdempotent: true,
                jitter: false,
            });

            expect(result).toBe('recovered');
            expect(fn).toHaveBeenCalledTimes(2);
        });

        it('fails fast on terminal 4xx errors without retry', async () => {
            const fn = vi.fn().mockRejectedValue({ response: { status: 400 } });

            await expect(withRetry(fn, { retries: 3, isIdempotent: true })).rejects.toEqual({
                response: { status: 400 },
            });
            expect(fn).toHaveBeenCalledTimes(1);
        });
    });
});
