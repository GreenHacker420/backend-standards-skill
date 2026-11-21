import { monitorEventLoopDelay } from 'perf_hooks';

export enum DegradationLevel {
    NORMAL = 0,     // Full features active
    ELEVATED = 1,   // Serve stale/cached recommendations only
    HIGH_LOAD = 2,  // Disable personalization; return static defaults
    EMERGENCY = 3,  // Shed all non-essential traffic; Tier 0 only
}

export enum ServiceTier {
    TIER_0_CRITICAL = 'TIER_0',      // Checkout, Auth, Payments
    TIER_1_CORE = 'TIER_1',          // Product catalog, inventory
    TIER_2_ENRICHMENT = 'TIER_2',    // Recommendations, personalization
    TIER_3_BACKGROUND = 'TIER_3',    // Reports, batch analytics
}

export class DegradationManager {
    private currentLevel: DegradationLevel = DegradationLevel.NORMAL;
    private histogram = monitorEventLoopDelay({ resolution: 20 });

    constructor() {
        this.histogram.enable();
        setInterval(() => this.evaluateHealth(), 5000).unref();
    }

    public getLevel(): DegradationLevel {
        return this.currentLevel;
    }

    public shouldExecute(tier: ServiceTier): boolean {
        if (tier === ServiceTier.TIER_0_CRITICAL) return true;
        if (this.currentLevel === DegradationLevel.EMERGENCY) return false;
        if (this.currentLevel === DegradationLevel.HIGH_LOAD && tier === ServiceTier.TIER_2_ENRICHMENT) {
            return false;
        }
        return true;
    }

    private evaluateHealth() {
        const p99EventLoopDelayMs = this.histogram.percentile(99) / 1e6;

        if (p99EventLoopDelayMs > 100) {
            this.setDegradationLevel(DegradationLevel.HIGH_LOAD, `Event loop lag high: ${p99EventLoopDelayMs.toFixed(1)}ms`);
        } else if (p99EventLoopDelayMs > 40) {
            this.setDegradationLevel(DegradationLevel.ELEVATED, `Event loop lag elevated: ${p99EventLoopDelayMs.toFixed(1)}ms`);
        } else if (this.currentLevel !== DegradationLevel.NORMAL) {
            this.setDegradationLevel(DegradationLevel.NORMAL, 'System health normalized');
        }
    }

    public setDegradationLevel(level: DegradationLevel, reason: string) {
        if (this.currentLevel !== level) {
            console.warn(`[Degradation] Shifting from Level ${this.currentLevel} to ${level}. Reason: ${reason}`);
            this.currentLevel = level;
        }
    }
}

export const degradationManager = new DegradationManager();
