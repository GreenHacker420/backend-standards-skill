import { monitorEventLoopDelay, IntervalHistogram } from 'perf_hooks';
import v8 from 'node:v8';

export interface LoggerInterface {
    warn(message: string, ...meta: unknown[]): void;
    error(message: string, ...meta: unknown[]): void;
    info(message: string, ...meta: unknown[]): void;
}

export enum DegradationLevel {
    NORMAL = 0,     // Full features active
    ELEVATED = 1,   // Serve stale/cached recommendations only; shed Tier 3
    HIGH_LOAD = 2,  // Disable personalization; return static defaults; shed Tier 2 & 3
    EMERGENCY = 3,  // Critical survival mode: shed Tier 1, 2, 3; Tier 0 only
}

export enum ServiceTier {
    TIER_0_CRITICAL = 'TIER_0',      // Checkout, Auth, Payments, Compliance Audit
    TIER_1_CORE = 'TIER_1',          // Product catalog, inventory lookups
    TIER_2_ENRICHMENT = 'TIER_2',    // Recommendations, personalization
    TIER_3_BACKGROUND = 'TIER_3',    // Reports, batch analytics, marketing webhooks
}

export interface DegradationOptions {
    readonly checkIntervalMs?: number;
    readonly recoveryHysteresisCycles?: number; // Consecutive healthy checks needed to step down (default: 3)
    readonly autoStart?: boolean;               // Whether to start background health polling automatically (default: true)
    readonly logger?: LoggerInterface;
}

export class DegradationManager {
    private currentLevel: DegradationLevel = DegradationLevel.NORMAL;
    private consecutiveHealthyChecks = 0;
    private readonly checkIntervalMs: number;
    private readonly recoveryHysteresisCycles: number;
    private readonly logger?: LoggerInterface;
    private histogram: IntervalHistogram;
    private timer: NodeJS.Timeout | null = null;
    private isRunning = false;

    constructor(options: DegradationOptions = {}) {
        const {
            checkIntervalMs = 5000,
            recoveryHysteresisCycles = 3,
            autoStart = true,
            logger,
        } = options;

        if (!Number.isInteger(checkIntervalMs) || checkIntervalMs < 100) {
            throw new RangeError('[DegradationManager] checkIntervalMs must be an integer >= 100ms.');
        }
        if (!Number.isInteger(recoveryHysteresisCycles) || recoveryHysteresisCycles < 1) {
            throw new RangeError('[DegradationManager] recoveryHysteresisCycles must be an integer >= 1.');
        }

        this.checkIntervalMs = checkIntervalMs;
        this.recoveryHysteresisCycles = recoveryHysteresisCycles;
        this.logger = logger;
        this.histogram = monitorEventLoopDelay({ resolution: 20 });

        if (autoStart) {
            this.start();
        }
    }

    public start(): void {
        if (this.isRunning) return;
        this.isRunning = true;
        this.histogram.enable();
        this.histogram.reset();
        this.timer = setInterval(() => this.evaluateHealth(), this.checkIntervalMs);
        this.timer.unref();
    }

    public stop(): void {
        this.isRunning = false;
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = null;
        }
        this.histogram.disable();
    }

    public dispose(): void {
        this.stop();
        this.histogram.reset();
    }

    public getLevel(): DegradationLevel {
        return this.currentLevel;
    }

    public shouldExecute(tier: ServiceTier): boolean {
        // Tier 0 is inviolable and never shed
        if (tier === ServiceTier.TIER_0_CRITICAL) {
            return true;
        }

        switch (this.currentLevel) {
            case DegradationLevel.EMERGENCY:
                // Only Tier 0 executes under emergency
                return false;

            case DegradationLevel.HIGH_LOAD:
                // Shed Tier 2 (enrichment) and Tier 3 (background)
                return tier === ServiceTier.TIER_1_CORE;

            case DegradationLevel.ELEVATED:
                // Shed Tier 3 (background)
                return tier !== ServiceTier.TIER_3_BACKGROUND;

            case DegradationLevel.NORMAL:
            default:
                return true;
        }
    }

    /**
     * Evaluates system health over the current interval window.
     * Crucial: Resets the histogram at the end of each evaluation cycle so that each check
     * measures recent system performance rather than accumulated lifetime percentiles.
     */
    public evaluateHealth(): void {
        const p99EventLoopDelayMs = this.histogram.percentile(99) / 1e6;

        // Check true memory saturation against V8's configured max heap size limit
        const heapStats = v8.getHeapStatistics();
        const heapLimit = heapStats.heap_size_limit;
        const heapUsageRatio = heapLimit > 0 ? heapStats.used_heap_size / heapLimit : 0;

        try {
            if (p99EventLoopDelayMs > 250 || heapUsageRatio > 0.95) {
                // Immediate escalation to EMERGENCY
                this.consecutiveHealthyChecks = 0;
                this.setDegradationLevel(
                    DegradationLevel.EMERGENCY,
                    `Critical resource pressure: p99 lag ${p99EventLoopDelayMs.toFixed(1)}ms, heap ${(heapUsageRatio * 100).toFixed(0)}%`
                );
            } else if (p99EventLoopDelayMs > 100 || heapUsageRatio > 0.85) {
                this.consecutiveHealthyChecks = 0;
                this.setDegradationLevel(
                    DegradationLevel.HIGH_LOAD,
                    `High resource pressure: p99 lag ${p99EventLoopDelayMs.toFixed(1)}ms, heap ${(heapUsageRatio * 100).toFixed(0)}%`
                );
            } else if (p99EventLoopDelayMs > 40) {
                this.consecutiveHealthyChecks = 0;
                this.setDegradationLevel(
                    DegradationLevel.ELEVATED,
                    `Elevated event loop lag: ${p99EventLoopDelayMs.toFixed(1)}ms`
                );
            } else {
                // Healthy check: enforce hysteresis to prevent rapid flapping
                this.consecutiveHealthyChecks++;
                if (this.consecutiveHealthyChecks >= this.recoveryHysteresisCycles && this.currentLevel !== DegradationLevel.NORMAL) {
                    const previousLevel = this.currentLevel;
                    // Step down one level at a time
                    const nextLevel = (previousLevel - 1) as DegradationLevel;
                    this.consecutiveHealthyChecks = 0;
                    this.setDegradationLevel(nextLevel, `System health sustained: ${this.recoveryHysteresisCycles} consecutive healthy cycles`);
                }
            }
        } finally {
            //? Reset histogram to capture a clean measurement window for the next interval
            this.histogram.reset();
        }
    }

    public setDegradationLevel(level: DegradationLevel, reason: string): void {
        if (this.currentLevel !== level) {
            this.logger?.warn('[DegradationManager] Shifting load shedding degradation level', {
                previousLevel: DegradationLevel[this.currentLevel],
                newLevel: DegradationLevel[level],
                reason,
            });
            this.currentLevel = level;
        }
    }
}

export const degradationManager = new DegradationManager();
