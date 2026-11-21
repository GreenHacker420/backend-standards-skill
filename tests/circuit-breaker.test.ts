import { describe, it, expect, vi } from 'vitest';
import { CircuitBreaker } from '../examples/resilience/circuit-breaker';

describe('CircuitBreaker', () => {
    it('initializes in CLOSED state and executes successful calls', async () => {
        const cb = new CircuitBreaker({ threshold: 3, timeoutMs: 1000 });
        expect(cb.getState()).toBe('CLOSED');
        expect(cb.isAvailable()).toBe(true);

        const result = await cb.execute(async () => 'hello');
        expect(result).toBe('hello');
        expect(cb.getFailureCount()).toBe(0);
    });

    it('resets consecutive failures on successful execution in CLOSED state', async () => {
        const cb = new CircuitBreaker({ threshold: 3, timeoutMs: 1000 });

        // Two failures
        await expect(cb.execute(async () => { throw new Error('fail 1'); })).rejects.toThrow();
        await expect(cb.execute(async () => { throw new Error('fail 2'); })).rejects.toThrow();
        expect(cb.getFailureCount()).toBe(2);

        // One success
        await cb.execute(async () => 'ok');
        // Must reset to 0 to prevent slow cumulative tripping
        expect(cb.getFailureCount()).toBe(0);
        expect(cb.getState()).toBe('CLOSED');
    });

    it('trips to OPEN state when threshold is reached', async () => {
        const cb = new CircuitBreaker({ threshold: 2, timeoutMs: 1000 });

        await expect(cb.execute(async () => { throw new Error('err 1'); })).rejects.toThrow();
        await expect(cb.execute(async () => { throw new Error('err 2'); })).rejects.toThrow();

        expect(cb.getState()).toBe('OPEN');
        expect(cb.isAvailable()).toBe(false);

        // Subsequent call is rejected fast with circuit open error
        await expect(cb.execute(async () => 'should not run')).rejects.toThrow(/Circuit open/);
    });

    it('transitions to HALF_OPEN after timeout and recovers to CLOSED on probe success', async () => {
        const cb = new CircuitBreaker({ threshold: 1, timeoutMs: 100 });

        await expect(cb.execute(async () => { throw new Error('boom'); })).rejects.toThrow();
        expect(cb.getState()).toBe('OPEN');

        // Wait for timeout to expire
        await new Promise((resolve) => setTimeout(resolve, 110));
        expect(cb.getState()).toBe('HALF_OPEN');

        // Probe succeeds
        const res = await cb.execute(async () => 'recovered');
        expect(res).toBe('recovered');
        expect(cb.getState()).toBe('CLOSED');
        expect(cb.getFailureCount()).toBe(0);
    });

    it('trips back to OPEN immediately if probe in HALF_OPEN fails', async () => {
        const cb = new CircuitBreaker({ threshold: 3, timeoutMs: 100 });

        // Trip to OPEN
        await expect(cb.execute(async () => { throw new Error('1'); })).rejects.toThrow();
        await expect(cb.execute(async () => { throw new Error('2'); })).rejects.toThrow();
        await expect(cb.execute(async () => { throw new Error('3'); })).rejects.toThrow();
        expect(cb.getState()).toBe('OPEN');

        // Wait for cool-down
        await new Promise((resolve) => setTimeout(resolve, 110));
        expect(cb.getState()).toBe('HALF_OPEN');

        // Probe fails -> should immediately trip back to OPEN
        await expect(cb.execute(async () => { throw new Error('probe failed'); })).rejects.toThrow();
        expect(cb.getState()).toBe('OPEN');
    });
});
