import { PrismaClient } from '@prisma/client';

export interface OutboxPayload {
    eventType: string;
    payload: Record<string, unknown>;
}

export interface OutboxRecord {
    eventType: string;
    payload: Record<string, unknown>;
    status: 'PENDING' | 'PROCESSED' | 'FAILED';
    attempts: number;
    createdAt: Date;
}

export interface OutboxTransactionClient {
    outboxEvent: {
        create(args: { data: OutboxRecord }): Promise<unknown>;
    };
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
