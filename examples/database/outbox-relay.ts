export interface OutboxPayload {
    eventType: string;
    payload: Record<string, unknown>;
}

export interface OutboxRecord {
    id: string;
    eventType: string;
    payload: Record<string, unknown>;
    status: 'PENDING' | 'PROCESSED' | 'FAILED';
    attempts: number;
    createdAt: Date;
    nextAttemptAt?: Date;
    errorReason?: string;
}

export interface OutboxTransactionClient {
    outboxEvent: {
        create(args: { data: Omit<OutboxRecord, 'id'> }): Promise<unknown>;
    };
}

export interface EventPublisherInterface {
    publish(eventType: string, payload: Record<string, unknown>): Promise<void>;
}

export interface LoggerInterface {
    error(message: string, ...meta: unknown[]): void;
    warn(message: string, ...meta: unknown[]): void;
    info(message: string, ...meta: unknown[]): void;
}

/**
 * Creates business entities and enqueues an outbox event in the same atomic database transaction.
 * Completely eliminates distributed dual-write inconsistency.
 */
export async function createWithOutbox<T, Tx extends OutboxTransactionClient>(
    prisma: { $transaction<R>(fn: (tx: Tx) => Promise<R>): Promise<R> },
    entityCreator: (tx: Tx) => Promise<T>,
    event: OutboxPayload,
): Promise<T> {
    return await prisma.$transaction(async (tx) => {
        // 1. Create primary business entity
        const entity = await entityCreator(tx);

        // 2. Append outbox event atomically
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

/**
 * Outbox Relay Worker (Background Dispatcher)
 * 
 * Safely claims and dispatches pending outbox records to message brokers (Kafka, RabbitMQ, BullMQ).
 * Uses PostgreSQL `FOR UPDATE SKIP LOCKED` to allow multiple concurrent relay instances to process
 * events without race conditions or blocking each other.
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
                const processedCount = await this.pollAndDispatchBatch();
                const pollInterval = this.options.pollIntervalMs ?? 1000;
                // If records were found, immediately poll next batch without waiting full interval
                this.scheduleNext(processedCount > 0 ? 50 : pollInterval);
            } catch (err) {
                this.options.logger?.error('[OutboxRelay] Error processing outbox batch:', err);
                this.scheduleNext(this.options.pollIntervalMs ?? 1000);
            }
        }, delayMs);
        this.timer.unref();
    }

    /**
     * Polls, locks, and dispatches a single batch of pending outbox events.
     */
    public async pollAndDispatchBatch(): Promise<number> {
        const batchSize = this.options.batchSize ?? 50;
        const maxAttempts = this.options.maxAttempts ?? 5;

        // 1. Claim batch using FOR UPDATE SKIP LOCKED
        return await this.prisma.$transaction(async (tx) => {
            const rows = await tx.$queryRaw<Array<{
                id: string;
                event_type: string;
                payload: Record<string, unknown>;
                attempts: number;
            }>>`
                SELECT id, event_type, payload, attempts
                FROM outbox_events
                WHERE status = 'PENDING'
                  AND (next_attempt_at IS NULL OR next_attempt_at <= clock_timestamp())
                ORDER BY created_at ASC
                LIMIT ${batchSize}
                FOR UPDATE SKIP LOCKED;
            `;

            if (rows.length === 0) {
                return 0;
            }

            for (const row of rows) {
                try {
                    // Dispatch to message broker
                    await this.publisher.publish(row.event_type, row.payload);

                    // Mark as PROCESSED
                    await tx.$executeRaw`
                        UPDATE outbox_events
                        SET status = 'PROCESSED',
                            processed_at = clock_timestamp()
                        WHERE id = ${row.id};
                    `;
                } catch (publishErr) {
                    const nextAttempts = row.attempts + 1;
                    const isTerminal = nextAttempts >= maxAttempts;
                    const backoffSeconds = Math.min(3600, Math.pow(2, nextAttempts) * 5); // 10s, 20s, 40s...
                    const errorReason = publishErr instanceof Error ? publishErr.message : String(publishErr);

                    if (isTerminal) {
                        // Quarantine to FAILED / Dead-Letter state
                        await tx.$executeRaw`
                            UPDATE outbox_events
                            SET status = 'FAILED',
                                attempts = ${nextAttempts},
                                error_reason = ${errorReason}
                            WHERE id = ${row.id};
                        `;
                        this.options.logger?.error('[OutboxRelay] Event exceeded max attempts; marked FAILED:', {
                            id: row.id,
                            eventType: row.event_type,
                            attempts: nextAttempts,
                        });
                    } else {
                        // Reschedule with exponential backoff
                        await tx.$executeRaw`
                            UPDATE outbox_events
                            SET attempts = ${nextAttempts},
                                error_reason = ${errorReason},
                                next_attempt_at = clock_timestamp() + (${`${backoffSeconds} seconds`})::INTERVAL
                            WHERE id = ${row.id};
                        `;
                    }
                }
            }

            return rows.length;
        });
    }
}
