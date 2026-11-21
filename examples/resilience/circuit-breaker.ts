export class CircuitBreaker {
    private failureCount = 0;
    private state: 'CLOSED' | 'OPEN' | 'HALF_OPEN' = 'CLOSED';
    private nextAttemptTime = 0;

    constructor(
        private readonly threshold = 5,
        private readonly timeoutMs = 30000,
    ) {}

    public async execute<T>(action: () => Promise<T>): Promise<T> {
        const now = Date.now();

        if (this.state === 'OPEN') {
            if (now > this.nextAttemptTime) {
                this.state = 'HALF_OPEN';
            } else {
                const retryAfterSeconds = Math.ceil((this.nextAttemptTime - now) / 1000);
                throw new Error(`Circuit open: downstream dependency is currently unavailable. Retry after ${retryAfterSeconds}s.`);
            }
        }

        try {
            const result = await action();
            if (this.state === 'HALF_OPEN') {
                this.reset();
            }
            return result;
        } catch (err) {
            this.failureCount++;
            if (this.failureCount >= this.threshold) {
                this.state = 'OPEN';
                this.nextAttemptTime = Date.now() + this.timeoutMs;
            }
            throw err;
        }
    }

    public reset() {
        this.failureCount = 0;
        this.state = 'CLOSED';
    }
}
