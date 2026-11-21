/**
 * PostgreSQL Transaction-Bound Advisory Lock Example
 * 
 * Advisory locks provide transactional mutexes tied directly to the ACID transaction lifetime.
 * They automatically release on COMMIT or ROLLBACK, even if the Node.js process crashes.
 * 
 * Note: Advisory locks protect operations within the scope of a single PostgreSQL database.
 * For coordination across distributed heterogeneous datastores, use Redis with proper TTLs
 * and singleflight/circuit breakers.
 */

export interface TransactionClient {
  $queryRaw<T = unknown>(query: TemplateStringsArray, ...values: unknown[]): Promise<T>;
  $executeRaw(query: TemplateStringsArray, ...values: unknown[]): Promise<number>;
}

export interface PrismaWithTransaction {
  $transaction<T>(action: (tx: TransactionClient) => Promise<T>): Promise<T>;
}

export interface AdvisoryLockOptions {
  timeoutMs?: number; // Optional lock_timeout to prevent indefinite waiting
}

/**
 * Executes a critical section guarded by a 64-bit transaction-level advisory lock.
 * Uses Prisma $queryRaw for SELECT pg_advisory_xact_lock() and supports 64-bit BigInt.
 */
export async function executeWithAdvisoryLock<T>(
  prisma: PrismaWithTransaction,
  lockId: number | bigint,
  task: (tx: TransactionClient) => Promise<T>,
  options: AdvisoryLockOptions = {}
): Promise<T> {
  const { timeoutMs = 5000 } = options;
  const safeLockId = typeof lockId === 'number' ? BigInt(lockId) : lockId;

  return prisma.$transaction(async (tx) => {
    // Prevent indefinite blocking if another transaction holds the lock
    if (timeoutMs > 0) {
      await tx.$executeRaw`SET LOCAL lock_timeout = ${`${timeoutMs}ms`}`;
    }

    // Acquire exclusive transaction-level advisory lock via $queryRaw
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(${safeLockId})`;

    return await task(tx);
  });
}

/**
 * String-based advisory lock using PostgreSQL's hashtext() function.
 * Allows locking on semantic keys like `tenant:123:order:456`.
 */
export async function executeWithStringAdvisoryLock<T>(
  prisma: PrismaWithTransaction,
  lockKey: string,
  task: (tx: TransactionClient) => Promise<T>,
  options: AdvisoryLockOptions = {}
): Promise<T> {
  const { timeoutMs = 5000 } = options;

  return prisma.$transaction(async (tx) => {
    if (timeoutMs > 0) {
      await tx.$executeRaw`SET LOCAL lock_timeout = ${`${timeoutMs}ms`}`;
    }

    // hashtext generates a deterministic 32-bit integer from any string
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${lockKey}))`;

    return await task(tx);
  });
}
