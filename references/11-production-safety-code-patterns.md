# Production Safety Code Patterns

This specification covers four critical code-level reliability and security patterns: timing-safe secret comparisons, backpressured stream pipelines, transaction-bound PostgreSQL advisory locks, and cost-weighted rate limiting.

---

## 1. Timing-Attack Safe Cryptographic Comparison

### The Vulnerability: String Equality (`===`)
Standard JavaScript string comparisons (`a === b`) evaluate character by character from left to right, returning `false` on the very first mismatched byte. An attacker can measure sub-microsecond latency differences (timing attacks) to deduce valid HMAC webhook signatures or API keys byte-by-byte.

### The Production Standard: `crypto.timingSafeEqual`
Always compare HMAC signatures and secret tokens using `crypto.timingSafeEqual` over fixed-length Buffers:

```typescript
import crypto from 'crypto';

export function verifyWebhookSignature(options: {
  payload: string | Buffer;
  receivedSignature: string;
  secret: string;
}): boolean {
  const { payload, receivedSignature, secret } = options;

  // Compute expected HMAC SHA-256
  const expectedSignature = crypto
    .createHmac('sha256', secret)
    .update(payload)
    .digest('hex');

  const receivedBuffer = Buffer.from(receivedSignature, 'utf8');
  const expectedBuffer = Buffer.from(expectedSignature, 'utf8');

  // Length check is mandatory: timingSafeEqual throws an exception if buffer lengths differ
  if (receivedBuffer.length !== expectedBuffer.length) {
    return false;
  }

  // Constant-time byte-by-byte comparison
  return crypto.timingSafeEqual(receivedBuffer, expectedBuffer);
}
```

---

## 2. Backpressured Stream Pipelines (Preventing Heap OOM)

### The Vulnerability: In-Memory File Buffering
Loading large CSVs, audio files, or PDF reports into memory via `fs.readFileSync` or accumulating arrays (`records.push(row)`) causes massive V8 heap spikes. In containerized environments with 512MB-1GB limits, processing a 50MB file can expand into an 8x memory footprint, crashing Node.js with `JavaScript heap out of memory`.

### The Production Standard: `stream.pipeline` with Transform Streams
Use Node.js streams to process data in chunks. `stream.pipeline` manages **backpressure**: if downstream database insertions slow down, the upstream file reader automatically pauses reading from disk.

```typescript
import { pipeline } from 'stream/promises';
import { Transform } from 'stream';
import fs from 'fs';
import csvParser from 'csv-parser';

export async function processCsvInBatches(options: {
  filePath: string;
  batchSize?: number;
  onBatch: (rows: Record<string, string>[]) => Promise<void>;
}): Promise<number> {
  const { filePath, batchSize = 100, onBatch } = options;
  let totalProcessed = 0;
  let currentBatch: Record<string, string>[] = [];

  const batchTransformer = new Transform({
    objectMode: true,
    async transform(row, encoding, callback) {
      currentBatch.push(row);
      totalProcessed++;

      if (currentBatch.length >= batchSize) {
        try {
          await onBatch(currentBatch);
          currentBatch = [];
          callback(); // Signals upstream to deliver the next chunk
        } catch (err) {
          callback(err as Error);
        }
      } else {
        callback();
      }
    },
    async flush(callback) {
      if (currentBatch.length > 0) {
        try {
          await onBatch(currentBatch);
          callback();
        } catch (err) {
          callback(err as Error);
        }
      } else {
        callback();
      }
    }
  });

  await pipeline(
    fs.createReadStream(filePath),
    csvParser(),
    batchTransformer
  );

  return totalProcessed;
}
```

---

## 3. Transaction-Bound PostgreSQL Advisory Locks

### The Vulnerability: Orphaned Redis Distributed Locks
Standard Redis distributed locks (e.g. `SET lock:key token NX EX 30`) suffer from two failure modes:
1. **Container Crash / Node Exit:** If the process crashes before calling `redis.del()`, other workers are locked out until the TTL expires.
2. **Premature Expiry:** If a database transaction runs longer than the TTL, the lock expires while the transaction is still running, leading to race conditions.

### The Production Standard: `pg_advisory_xact_lock`
PostgreSQL provides in-memory advisory locks tied directly to the lifetime of an ACID database transaction.
* The lock is acquired via `SELECT pg_advisory_xact_lock($1)`.
* It **automatically releases** the instant the transaction executes `COMMIT` or `ROLLBACK`.
* If the Node.js server container abruptly crashes or loses network connectivity, PostgreSQL releases the lock immediately.

```typescript
import { PrismaClient, Prisma } from '@prisma/client';

export async function withPostgresAdvisoryLock<T>(
  prisma: PrismaClient,
  lockId: number, // 64-bit integer unique to the resource
  action: (tx: Prisma.TransactionClient) => Promise<T>
): Promise<T> {
  return prisma.$transaction(async (tx) => {
    //? pg_advisory_xact_lock acquires an exclusive lock tied to THIS transaction
    //? It automatically releases upon commit or rollback with zero orphaned lock risk.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${lockId})`;

    return await action(tx);
  });
}
```

---

## 4. Cost-Weighted Rate Limiting (Abuse Prevention)

### The Vulnerability: Equal-Cost Rate Limiting
A naive rate limiter gives every request the same weight (e.g. 100 requests per minute). An attacker can submit 95 heavy requests (e.g. generating a 500-page PDF export or computing dense vector embeddings), completely saturating server CPU while remaining under the rate limit.

### The Production Standard: Cost-Weighted Token Bucket
Assign a dynamic computational "cost" (points) to each route. Cheap queries cost 1 token; expensive operations cost 10-25 tokens.

```typescript
import { Request, Response, NextFunction } from 'express';
import { Redis } from 'ioredis';

export class CostWeightedRateLimiter {
  constructor(private redis: Redis) {}

  public middleware(options: {
    windowSeconds: number;
    maxPoints: number;
    costCalculator?: (req: Request) => number;
  }) {
    const { windowSeconds, maxPoints, costCalculator = () => 1 } = options;

    return async (req: Request, res: Response, next: NextFunction) => {
      const cost = Math.max(1, costCalculator(req));
      const key = req.currentOrganizationUser
        ? `ratelimit:org:${req.currentOrganizationUser.organizationId}`
        : `ratelimit:ip:${req.ip}`;

      // Atomic increment by cost with sliding expiration
      const current = await this.redis.incrby(key, cost);
      if (current === cost) {
        await this.redis.expire(key, windowSeconds);
      }

      res.setHeader('X-RateLimit-Limit', maxPoints);
      res.setHeader('X-RateLimit-Remaining', Math.max(0, maxPoints - current));

      if (current > maxPoints) {
        res.setHeader('Retry-After', windowSeconds);
        res.status(429).json({
          success: false,
          message: 'Rate limit quota exceeded. Please reduce request frequency.',
          details: { costIncurred: cost, retryAfterSeconds: windowSeconds }
        });
        return;
      }

      next();
    };
  }
}
```
