# Production Safety Code Patterns

This specification covers four critical code-level reliability and security patterns: timing-safe secret comparisons, backpressured stream pipelines, transaction-bound PostgreSQL advisory locks, and cost-weighted rate limiting.

---

## 1. Timing-Attack Safe Cryptographic Comparison

### The Vulnerability: String Equality (`===`)
Standard JavaScript string comparisons (`a === b`) evaluate character by character from left to right, returning `false` on the very first mismatched byte. An attacker can measure sub-microsecond latency differences (timing side-channel attacks) to deduce valid HMAC webhook signatures or API keys byte-by-byte.

### The Production Standard: `crypto.timingSafeEqual`
Always compare HMAC signatures and secret tokens using `crypto.timingSafeEqual` over fixed-length Buffers:

```typescript
import crypto from 'node:crypto';

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

### The Production Standard: `stream.pipeline` with Async Generators
Use Node.js `stream.pipeline` with async generators (or properly error-handled `Transform` streams). `stream.pipeline` manages **backpressure**: if downstream processing slows down, the upstream file reader automatically pauses reading from disk.

```typescript
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import fs from 'node:fs';

// Pattern A: Idiomatic Node.js Async Generator Pipeline Stage
export async function streamWithAsyncGenerator(
  inputFilePath: string,
  outputFilePath: string,
  processLine: (line: string) => Promise<string>
): Promise<void> {
  async function* transformStage(source: AsyncIterable<Buffer>) {
    for await (const chunk of source) {
      const transformed = await processLine(chunk.toString('utf8'));
      yield Buffer.from(transformed, 'utf8');
    }
  }

  await pipeline(
    fs.createReadStream(inputFilePath),
    transformStage,
    fs.createWriteStream(outputFilePath)
  );
}

// Pattern B: Transform Stream with Explicit Stream Error Handling
export async function streamWithTransform(
  inputFilePath: string,
  outputFilePath: string,
  processChunk: (raw: string) => string
): Promise<void> {
  const lineTransformer = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      try {
        const transformed = processChunk(chunk.toString('utf8'));
        callback(null, Buffer.from(transformed, 'utf8'));
      } catch (err) {
        // Enforce stream contract: error MUST be passed to callback
        callback(err instanceof Error ? err : new Error(String(err)));
      }
    },
  });

  await pipeline(
    fs.createReadStream(inputFilePath),
    lineTransformer,
    fs.createWriteStream(outputFilePath)
  );
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
* **Scope Notice**: Advisory locks operate within the scope of a single PostgreSQL database. For coordination across heterogeneous systems, use Redis locks with safe TTLs and renewal heartbeats.

```typescript
import { PrismaClient, Prisma } from '@prisma/client';

export async function withPostgresAdvisoryLock<T>(
  prisma: PrismaClient,
  lockId: number | bigint,
  action: (tx: Prisma.TransactionClient) => Promise<T>,
  options: { timeoutMs?: number } = {}
): Promise<T> {
  const { timeoutMs = 5000 } = options;
  const safeLockId = typeof lockId === 'bigint' ? lockId : BigInt(lockId);

  return prisma.$transaction(async (tx) => {
    //? 1. Prevent indefinite lock queue starvation using set_config (prepared statement safe)
    if (timeoutMs > 0) {
      await tx.$queryRaw`SELECT set_config('lock_timeout', ${`${timeoutMs}ms`}, TRUE)`;
    }

    //? 2. Acquire 64-bit advisory lock using $queryRaw (never $executeRaw for SELECTs)
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(${safeLockId})`;

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

export interface RateLimiterOptions {
  windowSeconds: number;
  maxPoints: number;
  costCalculator?: (req: Request) => number;
}

const ATOMIC_COST_LIMITER_LUA = `
local current = redis.call('INCRBY', KEYS[1], ARGV[1])
if current == tonumber(ARGV[1]) then
    redis.call('EXPIRE', KEYS[1], ARGV[2])
end
return current
`;

export class CostWeightedRateLimiter {
  constructor(private redis: Redis) {}

  public middleware(options: RateLimiterOptions) {
    const { windowSeconds, maxPoints, costCalculator = () => 1 } = options;

    return async (req: Request, res: Response, next: NextFunction) => {
      const rawCost = costCalculator(req);
      const cost = Number.isInteger(rawCost) && rawCost > 0 ? rawCost : 1;
      const orgId = req.currentOrganizationUser?.organizationId;
      const key = orgId
        ? `ratelimit:org:${orgId}`
        : `ratelimit:ip:${req.ip || 'unknown'}`;

      // Atomic execution: increments counter and binds TTL in a single Redis transaction
      const current = (await this.redis.eval(
        ATOMIC_COST_LIMITER_LUA,
        1,
        key,
        cost,
        windowSeconds
      )) as number;

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
