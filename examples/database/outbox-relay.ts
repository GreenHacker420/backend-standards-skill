import crypto from 'node:crypto';

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
    claimToken?: string | null;
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

export interface PublishOptions {
    signal?: AbortSignal;
}

export interface EventPublisherInterface {
    publish(message: OutboxMessage, options?: PublishOptions): Promise<void>;
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
 * 
 * Invariants:
 * 1. ACID Atomicity: The business entity and the outbox event are inserted in the exact same database transaction.
 * 2. At-Least-Once Delivery: If a worker crashes or encounters network drops between broker dispatch and DB finalization,
 *    the event will be redelivered upon retry. Downstream message consumers MUST be idempotent and deduplicate on `eventId`.
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
                claimToken: null,
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
    claim_token: string;
}

export interface OutboxRelayOptions {
    batchSize?: number;
    pollIntervalMs?: number;
    claimLeaseSeconds?: number;
    publishTimeoutMs?: number;
    maxAttempts?: number;
    logger?: LoggerInterface;
}

/**
 * Production-Grade 2-Phase Outbox Relay Worker with Claim Fencing & Crash-Loop Recovery
 * 
 * Concurrency & Reliability Guarantees:
 * 1. Zero Network I/O Inside Database Transactions:
 *    Message broker publishing (Kafka/RabbitMQ/BullMQ) is performed strictly OUTSIDE any database transaction.
 *    Holding open database transactions or row locks during network I/O risks catastrophic connection pool starvation.
 * 2. Dynamic Batch Lease Duration:
 *    Batch lease duration scales dynamically with batch size and per-event publish timeouts to guarantee that sequential
 *    publishing never allows earlier claims to expire while the worker is actively making progress.
 * 3. Pre-Dispatch Lease Renewal & Claim Fencing:
 *    Each claimed event generates a unique `claimToken` (fencing token). Before dispatching, the worker verifies that
 *    its claim lease is still active. If an operation stalls and another worker reclaims the lease, subsequent completion
 *    or failure updates affect 0 rows, preventing stale workers from resurrecting or corrupting state.
 * 4. Crash-Loop & Poison Pill Quarantine:
 *    Events that crashed previous workers repeatedly (e.g. from OOM, broker serialization bugs, or process restarts)
 *    are quarantined to `FAILED` status before reclaiming to prevent infinite crash loops.
 * 5. Timer Leak Prevention:
 *    All timeout timers are explicitly cleared in `finally` blocks upon completion or failure.
 * 6. Cooperative AbortSignal Cancellation:
 *    Passes an `AbortSignal` to the broker publisher so that timed-out or aborted dispatches immediately terminate underlying
 *    sockets rather than leaking unmanaged background operations.
 */
export class OutboxRelayWorker {
    private isRunning = false;
    private timer: NodeJS.Timeout | null = null;
    private readonly batchSize: number;
    private readonly pollIntervalMs: number;
    private readonly claimLeaseSeconds: number;
    private readonly publishTimeoutMs: number;
    private readonly maxAttempts: number;
    private readonly logger?: LoggerInterface;

    constructor(
        private readonly prisma: OutboxRelayPrismaClient,
        private readonly publisher: EventPublisherInterface,
        options: OutboxRelayOptions = {}
    ) {
        this.batchSize = options.batchSize ?? 50;
        this.pollIntervalMs = options.pollIntervalMs ?? 1000;
        this.claimLeaseSeconds = options.claimLeaseSeconds ?? 60;
        this.publishTimeoutMs = options.publishTimeoutMs ?? 30000;
        this.maxAttempts = options.maxAttempts ?? 5;
        this.logger = options.logger;

        if (this.batchSize <= 0 || !Number.isInteger(this.batchSize)) {
            throw new RangeError('[OutboxRelay] batchSize must be an integer >= 1.');
        }
        if (this.publishTimeoutMs <= 0 || !Number.isInteger(this.publishTimeoutMs)) {
            throw new RangeError('[OutboxRelay] publishTimeoutMs must be an integer >= 1.');
        }
    }

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
                // If events were found, poll next batch immediately; otherwise wait configured interval
                this.scheduleNext(claimedCount > 0 ? 50 : this.pollIntervalMs);
            } catch (err) {
                this.logger?.error('[OutboxRelay] Error during outbox batch cycle:', err);
                this.scheduleNext(this.pollIntervalMs);
            }
        }, delayMs);
        this.timer.unref();
    }

    /**
     * Executes the 2-phase claim and dispatch cycle with dynamic leases and fencing tokens.
     */
    public async pollAndDispatchBatch(): Promise<number> {
        // Unique fencing token generated for this worker's claim cycle
        const claimToken = crypto.randomUUID();

        // Dynamically scale batch lease so sequential processing of batchSize events
        // does not expire claims while the worker is actively dispatching.
        const perItemTimeoutSec = Math.ceil(this.publishTimeoutMs / 1000);
        const calculatedBatchLeaseSeconds = (this.batchSize * perItemTimeoutSec) + 60;
        const effectiveBatchLeaseSeconds = Math.max(this.claimLeaseSeconds, calculatedBatchLeaseSeconds);

        // =========================================================================
        // PHASE 1: Claim Batch in a Short Database Transaction with Fencing Token
        // =========================================================================
        const claimedEvents = await this.prisma.$transaction(async (tx) => {
            // 1. Crash-loop quarantine: permanently fail events that exceeded maxAttempts across prior crashes
            await tx.$executeRaw`
                UPDATE outbox_events
                SET status = 'FAILED',
                    error_reason = 'Quarantined: exceeded maximum delivery attempts across worker crash or lease expiry cycles',
                    claim_expires_at = NULL,
                    claim_token = NULL
                WHERE status = 'PROCESSING'
                  AND claim_expires_at <= clock_timestamp()
                  AND attempts >= ${this.maxAttempts};
            `;

            // 2. Select eligible candidates skipping locked rows
            const candidates = await tx.$queryRaw<Array<{ id: string }>>`
                SELECT id
                FROM outbox_events
                WHERE ((status = 'PENDING' AND (next_attempt_at IS NULL OR next_attempt_at <= clock_timestamp()))
                   OR (status = 'PROCESSING' AND claim_expires_at <= clock_timestamp()))
                  AND attempts < ${this.maxAttempts}
                ORDER BY created_at ASC
                LIMIT ${this.batchSize}
                FOR UPDATE SKIP LOCKED;
            `;

            if (candidates.length === 0) {
                return [];
            }

            const candidateIds = candidates.map((c) => c.id);

            // 3. Atomically mark batch as PROCESSING with unique claim_token and scaled lease
            // Increment attempt count on claim so worker crashes/OOMs are accounted for
            const rows = await tx.$queryRaw<ClaimedOutboxRow[]>`
                UPDATE outbox_events
                SET status = 'PROCESSING',
                    claim_token = ${claimToken}::uuid,
                    claimed_at = clock_timestamp(),
                    claim_expires_at = clock_timestamp() + (${`${effectiveBatchLeaseSeconds} seconds`})::INTERVAL,
                    attempts = attempts + 1
                WHERE id = ANY(${candidateIds}::uuid[])
                RETURNING id, event_type, payload, attempts, claim_token;
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
            // Pre-dispatch fencing check & lease extension:
            // Ensure worker still owns the event lease before performing broker network I/O
            const refreshed = await this.prisma.$executeRaw`
                UPDATE outbox_events
                SET claim_expires_at = clock_timestamp() + (${`${this.claimLeaseSeconds} seconds`})::INTERVAL
                WHERE id = ${row.id}::uuid
                  AND status = 'PROCESSING'
                  AND claim_token = ${claimToken}::uuid;
            `;

            if (refreshed === 0) {
                this.logger?.warn('[OutboxRelay] Fencing Conflict: Claim expired or was reclaimed before dispatch; skipping broker call:', {
                    eventId: row.id,
                    claimToken,
                });
                continue;
            }

            const abortController = new AbortController();
            let timeoutTimer: NodeJS.Timeout | null = null;

            try {
                // Execute broker publish with bounded timeout and timer cleanup
                const timeoutPromise = new Promise<never>((_, reject) => {
                    timeoutTimer = setTimeout(() => {
                        abortController.abort(new Error(`[OutboxRelay] Broker publish timed out after ${this.publishTimeoutMs}ms`));
                        reject(new Error(`[OutboxRelay] Broker publish timed out after ${this.publishTimeoutMs}ms`));
                    }, this.publishTimeoutMs);
                    timeoutTimer.unref();
                });

                await Promise.race([
                    this.publisher.publish({
                        eventId: row.id,
                        eventType: row.event_type,
                        payload: row.payload,
                    }, { signal: abortController.signal }),
                    timeoutPromise,
                ]);

                // =====================================================================
                // PHASE 3: Finalize Successfully Published Record with Fencing Check
                // =====================================================================
                const updatedCount = await this.prisma.$executeRaw`
                    UPDATE outbox_events
                    SET status = 'PROCESSED',
                        processed_at = clock_timestamp(),
                        claim_expires_at = NULL,
                        claim_token = NULL
                    WHERE id = ${row.id}::uuid
                      AND status = 'PROCESSING'
                      AND claim_token = ${claimToken}::uuid;
                `;

                if (updatedCount === 0) {
                    this.logger?.warn('[OutboxRelay] Fencing Conflict: Event claim was lost, expired, or reclaimed by another worker. Stale completion ignored:', {
                        eventId: row.id,
                        claimToken,
                    });
                }
            } catch (publishErr) {
                const currentAttempts = row.attempts;
                const isTerminal = currentAttempts >= this.maxAttempts;
                const backoffSeconds = Math.min(3600, Math.pow(2, currentAttempts) * 5); // 10s, 20s, 40s...
                const errorReason = publishErr instanceof Error ? publishErr.message : String(publishErr);

                if (isTerminal) {
                    const updatedCount = await this.prisma.$executeRaw`
                        UPDATE outbox_events
                        SET status = 'FAILED',
                            error_reason = ${errorReason},
                            claim_expires_at = NULL,
                            claim_token = NULL
                        WHERE id = ${row.id}::uuid
                          AND status = 'PROCESSING'
                          AND claim_token = ${claimToken}::uuid;
                    `;

                    if (updatedCount === 0) {
                        this.logger?.warn('[OutboxRelay] Fencing Conflict: Stale worker terminal failure ignored; claim was already overtaken:', {
                            eventId: row.id,
                            claimToken,
                        });
                    } else {
                        this.logger?.error('[OutboxRelay] Event exceeded maximum delivery attempts; quarantined to FAILED status:', {
                            id: row.id,
                            eventType: row.event_type,
                            attempts: currentAttempts,
                            errorReason,
                        });
                    }
                } else {
                    // Return to PENDING with exponential backoff delay, guarded by fencing token
                    const updatedCount = await this.prisma.$executeRaw`
                        UPDATE outbox_events
                        SET status = 'PENDING',
                            error_reason = ${errorReason},
                            claim_expires_at = NULL,
                            claim_token = NULL,
                            next_attempt_at = clock_timestamp() + (${`${backoffSeconds} seconds`})::INTERVAL
                        WHERE id = ${row.id}::uuid
                          AND status = 'PROCESSING'
                          AND claim_token = ${claimToken}::uuid;
                    `;

                    if (updatedCount === 0) {
                        this.logger?.warn('[OutboxRelay] Fencing Conflict: Stale worker retry rescheduling ignored; claim was already overtaken:', {
                            eventId: row.id,
                            claimToken,
                        });
                    } else {
                        this.logger?.warn('[OutboxRelay] Transient publish error; rescheduled event with backoff:', {
                            id: row.id,
                            attempts: currentAttempts,
                            backoffSeconds,
                        });
                    }
                }
            } finally {
                // Prevent timer leak in Node.js event loop
                if (timeoutTimer) {
                    clearTimeout(timeoutTimer);
                    timeoutTimer = null;
                }
            }
        }

        return claimedEvents.length;
    }
}
