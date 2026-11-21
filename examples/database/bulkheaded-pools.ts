import { PrismaClient } from '@prisma/client';

/**
 * Bulkheaded Prisma connection pools:
 * Isolates critical revenue paths (Tier 0 Checkout/Payments) from non-critical enrichment (Tier 2 Recommendations).
 */
export class BulkheadedDatabase {
    // Dedicated pool for Tier-0 critical revenue mutations (auth, checkout, payment capture)
    public readonly criticalPool: PrismaClient;

    // Constrained pool or read-replica connection for Tier-2 enrichments and reporting
    public readonly readReplicaPool: PrismaClient;

    constructor() {
        this.criticalPool = new PrismaClient({
            datasourceUrl: process.env.DATABASE_URL_PRIMARY,
            log: ['error', 'warn'],
        });

        this.readReplicaPool = new PrismaClient({
            datasourceUrl: process.env.DATABASE_URL_REPLICA || process.env.DATABASE_URL_PRIMARY,
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

export const db = new BulkheadedDatabase();
