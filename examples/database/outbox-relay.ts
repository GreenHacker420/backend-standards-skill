export interface OutboxPayload {
    eventType: string;
    payload: Record<string, unknown>;
}

export interface OutboxRecord {
    id: string;
    eventType: string;
    payload: Record<string, unknown>;
    status: 'PENDING' | 'PROCESSING' | 'PROCESSED' | 'FAILED';
    attempts: number;
    createdAt: Date;
    claimedAt?: Date;
    claimExpiresAt?: Date;
    processedAt?: Date;
    nextAttemptAt?: Date;
    errorReason?: string;
}

export interface OutboxTransactionClient {
    outboxEvent: {
        create(args: { data: Omit<OutboxRecord, 'id'> }): Promise<unknown>;
    };
}

export interface OutboxMessage<T = Record<string, unknown>> {
    eventId: string;
    eventType: string;
    payload: T;
}

export interface EventPublisherInterface {
    publish(message: OutboxMessage): Promise<void>;
}

export interface LoggerInterface {
    error(message: string, ...meta: unknown[]): void;
    warn(message: string, ...meta: unknown[]): void;
    info(message: string, ...meta: unknown[]): void;
}

/**
 * Creates business entities and enqueues an outbox event in the same atomic database transaction.
 * 
 * Guarantee:
 * Completely eliminates distributed dual-write inconsistency between database persistence and event emission.
 * Note: Transactional Outbox provides AT-LEAST-ONCE delivery semantics; message consumers must be idempotent!
 */
export async function createWithOutbox<T, Tx extends OutboxTransactionClient>(
    prisma: { $transaction<R>(fn: (tx: Tx) => Promise<R>): Promise<R> },
    entityCreator: (tx: Tx) => Promise<T>,
    event: OutboxPayload,
): Promise<T> {
    return await prisma.$transaction(async (tx) => {
        // 1. Create primary business entity
        const entity = await entityCreator(tx);

        // 2. Append outbox event atomically within the same ACID transaction
        await tx.outboxEvent.create({
            data: {
                eventType: event.eventType,
                payload: event.payload,
                status: 'PENDING',
                attempts: 0,
                createdAt: new Date(),
            },
        });

        return entity;
    });
}

export interface OutboxRelayPrismaClient {
    $queryRaw<T = unknown>(query: TemplateStringsArray, ...values: unknown[]): Promise<T>;
    $executeRaw(query: TemplateStringsArray, ...values: unknown[]): Promise<number>;
    $transaction<T>(action: (tx: OutboxRelayPrismaClient) => Promise<T>): Promise<T>;
}

export interface ClaimedOutboxRow {
    id: string;
    event_type: string;
    payload: Record<string, unknown>;
    attempts: number;
}

/**
 * Production-Grade 2-Phase Outbox Relay Worker
 * 
 * Reliability & Concurrency Rules:
 * 1. Zero Network I/O Inside Database Transactions:
 *    Message broker publishing (Kafka/RabbitMQ/BullMQ) is performed strictly OUTSIDE the database transaction.
 *    Holding open database transactions or row locks during network I/O risks catastrophic connection pool starvation.
 * 2. Short Claim Leases with FOR UPDATE SKIP LOCKED:
 *    Phase 1 atomically claims a batch of pending/expired events and commits immediately.
 *    Multiple concurrent worker instances process independent event batches without lock contention.
 * 3. Stable Event Identifiers for Consumer Deduplication:
 *    Passes stable `eventId` (`row.id`) to the broker so downstream consumers can enforce idempotency.
 * 4. At-Least-Once Delivery:
 *    Network drops or worker crashes after broker publish but before DB acknowledgment can cause redelivery.
 */
export class OutboxRelayWorker {
    private isRunning = false;
    private timer: NodeJS.Timeout | null = null;

    constructor(
        private readonly prisma: OutboxRelayPrismaClient,
        private readonly publisher: EventPublisherInterface,
        private readonly options: {
            batchSize?: number;
            pollIntervalMs?: number;
            claimLeaseSeconds?: number;
            maxAttempts?: number;
            logger?: LoggerInterface;
        } = {}
    ) {}

    public start(): void {
        if (this.isRunning) return;
        this.isRunning = true;
        this.scheduleNext(0);
    }

    public stop(): void {
        this.isRunning = false;
        if (this.timer) {
            clearTimeout(this.timer);
            this.timer = null;
        }
    }

    private scheduleNext(delayMs: number): void {
        if (!this.isRunning) return;
        this.timer = setTimeout(async () => {
            try {
                const claimedCount = await this.pollAndDispatchBatch();
                const pollInterval = this.options.pollIntervalMs ?? 1000;
                // If events were found, poll next batch immediately; otherwise wait configured interval
                this.scheduleNext(claimedCount > 0 ? 50 : pollInterval);
            } catch (err) {
                this.options.logger?.error('[OutboxRelay] Error during outbox batch cycle:', err);
                this.scheduleNext(this.options.pollIntervalMs ?? 1000);
            }
        }, delayMs);
        this.timer.unref();
    }

    /**
     * Executes the 2-phase claim and dispatch cycle.
     */
    public async pollAndDispatchBatch(): Promise<number> {
        const batchSize = this.options.batchSize ?? 50;
        const claimLeaseSeconds = this.options.claimLeaseSeconds ?? 60;
        const maxAttempts = this.options.maxAttempts ?? 5;

        // =========================================================================
        // PHASE 1: Claim Batch in a Short Database Transaction
        // =========================================================================
        const claimedEvents = await this.prisma.$transaction(async (tx) => {
            // Select candidates with row locks skipping locked rows
            const candidates = await tx.$queryRaw<Array<{ id: string }>>`
                SELECT id
                FROM outbox_events
                WHERE (status = 'PENDING' AND (next_attempt_at IS NULL OR next_attempt_at <= clock_timestamp()))
                   OR (status = 'PROCESSING' AND claim_expires_at <= clock_timestamp())
                ORDER BY created_at ASC
                LIMIT ${batchSize}
                FOR UPDATE SKIP LOCKED;
            `;

            if (candidates.length === 0) {
                return [];
            }

            const candidateIds = candidates.map((c) => c.id);

            // Atomically mark batch as PROCESSING with a timed lease
            const rows = await tx.$queryRaw<ClaimedOutboxRow[]>`
                UPDATE outbox_events
                SET status = 'PROCESSING',
                    claimed_at = clock_timestamp(),
                    claim_expires_at = clock_timestamp() + (${`${claimLeaseSeconds} seconds`})::INTERVAL
                WHERE id = ANY(${candidateIds}::uuid[])
                RETURNING id, event_type, payload, attempts;
            `;

            return rows;
        });

        if (claimedEvents.length === 0) {
            return 0;
        }

        // =========================================================================
        // PHASE 2: Dispatch to Message Broker OUTSIDE Any Database Transaction
        // =========================================================================
        for (const row of claimedEvents) {
            try {
                // Publish with stable eventId for consumer-side idempotency
                await this.publisher.publish({
                    eventId: row.id,
                    eventType: row.event_type,
                    payload: row.payload,
                });

                // =====================================================================
                // PHASE 3: Finalize Successfully Published Record in Database
                // =====================================================================
                await this.prisma.$executeRaw`
                    UPDATE outbox_events
                    SET status = 'PROCESSED',
                        processed_at = clock_timestamp(),
                        claim_expires_at = NULL
                    WHERE id = ${row.id}::uuid;
                `;
            } catch (publishErr) {
                const nextAttempts = row.attempts + 1;
                const isTerminal = nextAttempts >= maxAttempts;
                const backoffSeconds = Math.min(3600, Math.pow(2, nextAttempts) * 5); // 10s, 20s, 40s...
                const errorReason = publishErr instanceof Error ? publishErr.message : String(publishErr);

                if (isTerminal) {
                    await this.prisma.$executeRaw`
                        UPDATE outbox_events
                        SET status = 'FAILED',
                            attempts = ${nextAttempts},
                            error_reason = ${errorReason},
                            claim_expires_at = NULL
                        WHERE id = ${row.id}::uuid;
                    `;
                    this.options.logger?.error('[OutboxRelay] Event exceeded maximum delivery attempts; quarantined to FAILED status:', {
                        id: row.id,
                        eventType: row.event_type,
                        attempts: nextAttempts,
                        errorReason,
                    });
                } else {
                    // Return to PENDING with exponential backoff delay
                    await this.prisma.$executeRaw`
                        UPDATE outbox_events
                        SET status = 'PENDING',
                            attempts = ${nextAttempts},
                            error_reason = ${errorReason},
                            claim_expires_at = NULL,
                            next_attempt_at = clock_timestamp() + (${`${backoffSeconds} seconds`})::INTERVAL
                        WHERE id = ${row.id}::uuid;
                    `;
                    this.options.logger?.warn('[OutboxRelay] Transient publish error; rescheduled event with backoff:', {
                        id: row.id,
                        nextAttempts,
                        backoffSeconds,
                    });
                }
            }
        }

        return claimedEvents.length;
    }
}
