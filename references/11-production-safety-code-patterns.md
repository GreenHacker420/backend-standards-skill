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

### The Production Standard: `stream.pipeline` with Line Framing & StringDecoder
Stream chunks arrive on arbitrary byte boundaries, not line or record boundaries, and multi-byte UTF-8 characters can be split across chunks. Use `stream.pipeline` with an async generator using `StringDecoder` and line buffering to guarantee safe parsing under backpressure:

```typescript
import { pipeline } from 'node:stream/promises';
import { StringDecoder } from 'node:string_decoder';
import fs from 'node:fs';

export async function streamLinesWithPipeline(
  inputFilePath: string,
  outputFilePath: string,
  processLine: (line: string) => Promise<string>
): Promise<void> {
  async function* lineFramingStage(source: AsyncIterable<Buffer>) {
    const decoder = new StringDecoder('utf8');
    let remainder = '';

    for await (const chunk of source) {
      // StringDecoder preserves incomplete multi-byte UTF-8 character bytes until next chunk
      remainder += decoder.write(chunk);
      const lines = remainder.split(/\r?\n/);
      remainder = lines.pop() ?? ''; // Buffer incomplete trailing fragment

      for (const line of lines) {
        const transformed = await processLine(line);
        yield Buffer.from(transformed + '\n', 'utf8');
      }
    }

    remainder += decoder.end();
    if (remainder.length > 0) {
      const transformed = await processLine(remainder);
      yield Buffer.from(transformed + '\n', 'utf8');
    }
  }

  // Automatically manages backpressure, teardown, and error propagation
  await pipeline(
    fs.createReadStream(inputFilePath),
    lineFramingStage,
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

### The Production Standard: Cost-Weighted Rate Limiting (Atomic Fixed-Window Counter)
Assign a dynamic computational "cost" (points) to each route. Cheap queries cost 1 token; expensive operations cost 10-25 tokens. Uses an atomic Redis script to increment points and bind TTL in a single operation, with fail-closed validation of calculated cost.

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
      try {
        const rawCost = costCalculator(req);
        if (!Number.isInteger(rawCost) || rawCost <= 0) {
          throw new TypeError(`[CostRateLimiter] Invalid cost calculated: ${rawCost}. Cost must be a positive integer.`);
        }
        const cost = rawCost;
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
            message: 'Rate limit exceeded. Please slow down your requests.',
            details: { costIncurred: cost, retryAfter: windowSeconds },
          });
          return;
        }

        next();
      } catch (err) {
        next(err);
      }
    };
  }
}
```
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
