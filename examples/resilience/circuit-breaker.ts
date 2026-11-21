export type CircuitState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

export interface CircuitBreakerOptions {
    readonly threshold?: number;   //? Consecutive failures before tripping OPEN (default: 5)
    readonly timeoutMs?: number;   //? Cool-down duration in OPEN state before testing HALF_OPEN (default: 30000ms)
}

/**
 * Production-Grade In-Memory Circuit Breaker Pattern
 * 
 * Protects upstream services from cascading failures during downstream outages.
 * 
 * Correctness Guarantees:
 * 1. Success in CLOSED state resets consecutive failure count to 0, preventing slow cumulative tripping.
 * 2. In HALF_OPEN state, permits exactly ONE concurrent probe execution. Concurrent callers are rejected
 *    fast while downstream health is verified.
 * 3. If the probe in HALF_OPEN fails, the circuit trips back to OPEN immediately without needing multiple failures.
 * 4. If the probe in HALF_OPEN succeeds, the circuit fully resets to CLOSED.
 */
export class CircuitBreaker {
    private failureCount = 0;
    private state: CircuitState = 'CLOSED';
    private nextAttemptTime = 0;
    private isProbeInFlight = false;
    private readonly threshold: number;
    private readonly timeoutMs: number;

    constructor(options: CircuitBreakerOptions = {}) {
        const { threshold = 5, timeoutMs = 30000 } = options;

        if (!Number.isInteger(threshold) || threshold < 1) {
            throw new RangeError('[CircuitBreaker] threshold must be an integer >= 1.');
        }
        if (!Number.isInteger(timeoutMs) || timeoutMs < 100) {
            throw new RangeError('[CircuitBreaker] timeoutMs must be an integer >= 100ms.');
        }

        this.threshold = threshold;
        this.timeoutMs = timeoutMs;
    }

    public async execute<T>(action: () => Promise<T>): Promise<T> {
        const now = Date.now();

        // 1. Evaluate OPEN -> HALF_OPEN state transition
        if (this.state === 'OPEN') {
            if (now >= this.nextAttemptTime) {
                this.state = 'HALF_OPEN';
                this.isProbeInFlight = false;
            } else {
                const retryAfterSeconds = Math.max(1, Math.ceil((this.nextAttemptTime - now) / 1000));
                throw new Error(`Circuit open: downstream dependency is currently unavailable. Retry after ${retryAfterSeconds}s.`);
            }
        }

        // 2. Bound HALF_OPEN execution to a single concurrent probe
        if (this.state === 'HALF_OPEN') {
            if (this.isProbeInFlight) {
                throw new Error('Circuit probe currently in flight. Downstream service is recovering. Please retry shortly.');
            }
            this.isProbeInFlight = true;
        }

        try {
            const result = await action();

            //? Success Handling:
            if (this.state === 'HALF_OPEN') {
                // Probe succeeded: fully recover to CLOSED
                this.reset();
            } else if (this.state === 'CLOSED') {
                // Success in CLOSED resets consecutive failures
                this.failureCount = 0;
            }

            return result;
        } catch (err) {
            if (this.state === 'HALF_OPEN') {
                //? Probe failed: immediately trip back to OPEN with full timeout
                this.isProbeInFlight = false;
                this.state = 'OPEN';
                this.nextAttemptTime = Date.now() + this.timeoutMs;
            } else if (this.state === 'CLOSED') {
                this.failureCount++;
                if (this.failureCount >= this.threshold) {
                    this.state = 'OPEN';
                    this.nextAttemptTime = Date.now() + this.timeoutMs;
                }
            }
            throw err;
        }
    }

    public reset(): void {
        this.failureCount = 0;
        this.state = 'CLOSED';
        this.nextAttemptTime = 0;
        this.isProbeInFlight = false;
    }

    public getState(): CircuitState {
        // Transparently evaluate expired OPEN state on query
        if (this.state === 'OPEN' && Date.now() >= this.nextAttemptTime) {
            return 'HALF_OPEN';
        }
        return this.state;
    }

    public getFailureCount(): number {
        return this.failureCount;
    }

    public isAvailable(): boolean {
        return this.getState() !== 'OPEN';
    }
}
