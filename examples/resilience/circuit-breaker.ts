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
 * 1. Epoch / Generation Token:
 *    Every state transition increments an internal `epoch` counter. Stale requests started in a previous
 *    state/epoch cannot accidentally reset or trip the circuit upon late completion.
 * 2. Designated Probe Execution in HALF_OPEN:
 *    Permits exactly ONE designated probe in `HALF_OPEN` for the current epoch. Concurrent callers are rejected
 *    fast. Only the designated probe's outcome determines whether the circuit closes or trips back to OPEN.
 * 3. Success in CLOSED resets consecutive failures to 0, preventing slow cumulative tripping.
 */
export class CircuitBreaker {
    private failureCount = 0;
    private state: CircuitState = 'CLOSED';
    private nextAttemptTime = 0;
    private isProbeInFlight = false;
    private epoch = 0; // Generation token prevents stale-request state races
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
                this.epoch++;
            } else {
                const retryAfterSeconds = Math.max(1, Math.ceil((this.nextAttemptTime - now) / 1000));
                throw new Error(`Circuit open: downstream dependency is currently unavailable. Retry after ${retryAfterSeconds}s.`);
            }
        }

        // 2. Bound HALF_OPEN execution to a single designated probe for this epoch
        let isDesignatedProbe = false;
        if (this.state === 'HALF_OPEN') {
            if (this.isProbeInFlight) {
                throw new Error('Circuit probe currently in flight. Downstream service is recovering. Please retry shortly.');
            }
            this.isProbeInFlight = true;
            isDesignatedProbe = true;
        }

        const requestEpoch = this.epoch;

        try {
            const result = await action();

            //? Success Handling:
            //? Only actions originating in the current epoch can influence circuit state.
            if (isDesignatedProbe && this.epoch === requestEpoch) {
                // Probe succeeded: fully recover to CLOSED
                this.reset();
            } else if (this.state === 'CLOSED' && this.epoch === requestEpoch) {
                // Success in CLOSED resets consecutive failures
                this.failureCount = 0;
            }

            return result;
        } catch (err) {
            if (isDesignatedProbe && this.epoch === requestEpoch) {
                //? Probe failed: immediately trip back to OPEN with full cool-down timeout
                this.state = 'OPEN';
                this.epoch++;
                this.nextAttemptTime = Date.now() + this.timeoutMs;
            } else if (this.state === 'CLOSED' && this.epoch === requestEpoch) {
                this.failureCount++;
                if (this.failureCount >= this.threshold) {
                    this.state = 'OPEN';
                    this.epoch++;
                    this.nextAttemptTime = Date.now() + this.timeoutMs;
                }
            }
            throw err;
        } finally {
            // Guarantee probe release regardless of resolve, reject, or exception
            if (isDesignatedProbe && this.epoch === requestEpoch) {
                this.isProbeInFlight = false;
            }
        }
    }

    public reset(): void {
        this.failureCount = 0;
        this.state = 'CLOSED';
        this.nextAttemptTime = 0;
        this.isProbeInFlight = false;
        this.epoch++;
    }

    public getState(): CircuitState {
        if (this.state === 'OPEN' && Date.now() >= this.nextAttemptTime) {
            return 'HALF_OPEN';
        }
        return this.state;
    }

    public getFailureCount(): number {
        return this.failureCount;
    }

    public getEpoch(): number {
        return this.epoch;
    }

    public isAvailable(): boolean {
        return this.getState() !== 'OPEN';
    }
}
