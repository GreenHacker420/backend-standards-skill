import { PrismaClient } from '@prisma/client';

export interface DatabasePoolConfig {
    readonly primaryUrl: string;
    readonly replicaUrl?: string;
    readonly criticalPoolLimit?: number;   // Max connections for Tier 0 (default: 50)
    readonly readReplicaLimit?: number;    // Max connections for Tier 1/2 read replica (default: 15)
    readonly isProduction?: boolean;
}

/**
 * Appends explicit connection pool limits to PostgreSQL datasource connection strings.
 */
function buildDatasourceUrl(baseUrl: string, limit: number): string {
    const url = new URL(baseUrl);
    url.searchParams.set('connection_limit', limit.toString());
    return url.toString();
}

/**
 * Bulkheaded Prisma Connection Pools:
 * Isolates critical revenue paths (Tier 0 Checkout/Payments) from non-critical enrichment (Tier 2 Recommendations).
 * 
 * Production Invariants:
 * 1. Dedicated Pool Slices: Tier 0 mutations use a reserved high-capacity pool.
 * 2. Strict Replica Isolation: In production, read replicas must be distinct instances. Silent fallback
 *    to primary is prohibited because analytical query spikes would starve Tier-0 checkout transactions.
 * 3. Connection Budgeting: Explicit connection limits prevent exceeding PostgreSQL max_connections.
 */
export class BulkheadedDatabase {
    // Dedicated pool for Tier-0 critical revenue mutations (auth, checkout, payment capture)
    public readonly criticalPool: PrismaClient;

    // Constrained pool on read-replica for Tier-1 browsing and Tier-2 enrichments
    public readonly readReplicaPool: PrismaClient;

    constructor(config: DatabasePoolConfig) {
        const {
            primaryUrl,
            replicaUrl,
            criticalPoolLimit = 50,
            readReplicaLimit = 15,
            isProduction = process.env.NODE_ENV === 'production',
        } = config;

        if (!primaryUrl) {
            throw new Error('[BulkheadedDatabase] primaryUrl is required for critical pool.');
        }

        if (isProduction && !replicaUrl) {
            throw new Error(
                '[BulkheadedDatabase] Security/Reliability Violation: In production, replicaUrl must be explicitly configured ' +
                'to prevent analytical queries from exhausting primary database connection slots.'
            );
        }

        const effectiveReplicaUrl = replicaUrl ?? primaryUrl;

        this.criticalPool = new PrismaClient({
            datasourceUrl: buildDatasourceUrl(primaryUrl, criticalPoolLimit),
            log: ['error', 'warn'],
        });

        this.readReplicaPool = new PrismaClient({
            datasourceUrl: buildDatasourceUrl(effectiveReplicaUrl, readReplicaLimit),
            log: ['error'],
        });
    }

    public async disconnectAll(): Promise<void> {
        await Promise.all([
            this.criticalPool.$disconnect(),
            this.readReplicaPool.$disconnect(),
        ]);
    }
}
