import { monitorEventLoopDelay } from 'perf_hooks';

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
    readonly logger?: LoggerInterface;
}

export class DegradationManager {
    private currentLevel: DegradationLevel = DegradationLevel.NORMAL;
    private consecutiveHealthyChecks = 0;
    private readonly recoveryHysteresisCycles: number;
    private readonly logger?: LoggerInterface;
    private histogram = monitorEventLoopDelay({ resolution: 20 });

    constructor(options: DegradationOptions = {}) {
        const {
            checkIntervalMs = 5000,
            recoveryHysteresisCycles = 3,
            logger,
        } = options;

        this.recoveryHysteresisCycles = recoveryHysteresisCycles;
        this.logger = logger;
        this.histogram.enable();
        setInterval(() => this.evaluateHealth(), checkIntervalMs).unref();
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

    public evaluateHealth(): void {
        const p99EventLoopDelayMs = this.histogram.percentile(99) / 1e6;

        if (p99EventLoopDelayMs > 250) {
            // Immediate escalation to EMERGENCY
            this.consecutiveHealthyChecks = 0;
            this.setDegradationLevel(DegradationLevel.EMERGENCY, `Severe event loop lag: ${p99EventLoopDelayMs.toFixed(1)}ms`);
        } else if (p99EventLoopDelayMs > 100) {
            this.consecutiveHealthyChecks = 0;
            this.setDegradationLevel(DegradationLevel.HIGH_LOAD, `High event loop lag: ${p99EventLoopDelayMs.toFixed(1)}ms`);
        } else if (p99EventLoopDelayMs > 40) {
            this.consecutiveHealthyChecks = 0;
            this.setDegradationLevel(DegradationLevel.ELEVATED, `Elevated event loop lag: ${p99EventLoopDelayMs.toFixed(1)}ms`);
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
