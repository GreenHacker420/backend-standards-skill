import crypto from 'node:crypto';

/**
 * PostgreSQL Transaction-Bound Advisory Lock Example
 * 
 * Advisory locks provide transactional mutexes tied directly to the ACID transaction lifetime.
 * They automatically release on COMMIT or ROLLBACK, even if the Node.js process crashes.
 * 
 * Scope Notice:
 * Advisory locks operate within the scope of a single PostgreSQL database.
 * For distributed coordination across disparate systems or datastores, use Redis with safe TTLs
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

//? Safe lock ID conversion: rejects unsafe JavaScript floats/doubles that already lost precision
export function toSafeLockId(lockId: number | bigint): bigint {
  if (typeof lockId === 'bigint') {
    return lockId;
  }
  if (!Number.isSafeInteger(lockId)) {
    throw new TypeError(
      `Lock ID number ${lockId} exceeds Number.MAX_SAFE_INTEGER. Pass a BigInt directly to prevent precision loss.`
    );
  }
  return BigInt(lockId);
}

//? Derives a 64-bit integer from a string using SHA-256 (eliminates 32-bit hashtext collision risks)
export function hashStringToLockId(key: string): bigint {
  const hash = crypto.createHash('sha256').update(key).digest();
  return hash.readBigInt64BE(0);
}

/**
 * Executes a critical section guarded by a 64-bit transaction-level advisory lock.
 * Uses PostgreSQL's set_config('lock_timeout', ..., TRUE) for valid dynamic parameterization.
 */
export async function executeWithAdvisoryLock<T>(
  prisma: PrismaWithTransaction,
  lockId: number | bigint,
  task: (tx: TransactionClient) => Promise<T>,
  options: AdvisoryLockOptions = {}
): Promise<T> {
  const { timeoutMs = 5000 } = options;
  const safeLockId = toSafeLockId(lockId);

  return prisma.$transaction(async (tx) => {
    //? PostgreSQL prepared statement rule: Dynamic lock_timeout cannot be set via 'SET LOCAL' prepared statements.
    //? set_config(..., TRUE) correctly sets transaction-local parameterization.
    if (timeoutMs > 0) {
      await tx.$queryRaw`SELECT set_config('lock_timeout', ${`${timeoutMs}ms`}, TRUE)`;
    }

    // Acquire exclusive transaction-level advisory lock via $queryRaw
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(${safeLockId})`;

    return await task(tx);
  });
}

/**
 * String-based advisory lock using 64-bit SHA-256 hash digest.
 * Allows safe locking on semantic keys like `tenant:123:order:456` across the entire 64-bit namespace.
 */
export async function executeWithStringAdvisoryLock<T>(
  prisma: PrismaWithTransaction,
  lockKey: string,
  task: (tx: TransactionClient) => Promise<T>,
  options: AdvisoryLockOptions = {}
): Promise<T> {
  const safeLockId = hashStringToLockId(lockKey);
  return executeWithAdvisoryLock(prisma, safeLockId, task, options);
}
