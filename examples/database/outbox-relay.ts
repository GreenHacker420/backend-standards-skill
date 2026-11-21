import { PrismaClient } from '@prisma/client';

export interface OutboxPayload {
    eventType: string;
    payload: Record<string, unknown>;
}

/**
 * Creates business entities and enqueues an outbox event in the same atomic database transaction.
 * Completely eliminates distributed dual-write inconsistency.
 */
export async function createWithOutbox<T>(
    prisma: PrismaClient,
    entityCreator: (tx: any) => Promise<T>,
    event: OutboxPayload,
): Promise<T> {
    return await prisma.$transaction(async (tx) => {
        // 1. Create primary business entity
        const entity = await entityCreator(tx);

        // 2. Append outbox event atomically
        await (tx as any).outboxEvent.create({
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
