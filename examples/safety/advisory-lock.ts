/**
 * PostgreSQL Advisory Lock Example
 * Distributed transactional mutex tied directly to the ACID transaction lifetime.
 * Automatically releases on COMMIT or ROLLBACK.
 */

export interface TransactionClient {
  $executeRaw(query: TemplateStringsArray, ...values: any[]): Promise<any>;
}

export interface PrismaWithTransaction {
  $transaction<T>(action: (tx: TransactionClient) => Promise<T>): Promise<T>;
}

export async function executeWithAdvisoryLock<T>(
  prisma: PrismaWithTransaction,
  lockId: number,
  task: (tx: TransactionClient) => Promise<T>
): Promise<T> {
  return prisma.$transaction(async (tx) => {
    // Acquire exclusive transaction-level advisory lock
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${lockId})`;

    return await task(tx);
  });
}
