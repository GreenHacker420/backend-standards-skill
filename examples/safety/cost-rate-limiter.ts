import { Request, Response, NextFunction } from 'express';

export interface RedisClient {
  eval(script: string, numkeys: number, ...args: (string | number)[]): Promise<number>;
}

export interface CostRateLimiterOptions {
  windowSeconds: number;
  maxPoints: number;
  costCalculator?: (req: Request) => number;
}

//? Atomic Lua script ensures INCRBY and EXPIRE occur atomically with zero orphaned TTL risk
const ATOMIC_COST_LIMITER_LUA = `
local current = redis.call('INCRBY', KEYS[1], ARGV[1])
if current == tonumber(ARGV[1]) then
    redis.call('EXPIRE', KEYS[1], ARGV[2])
end
return current
`;

/**
 * Cost-Weighted Rate Limiting Middleware (Atomic TTL-Based Counter)
 * 
 * Protects CPU-heavy endpoints (e.g. PDF generation, embeddings, large exports)
 * by charging higher point costs against client quotas.
 * 
 * Implementation Note:
 * This uses an atomic Redis fixed-window counter with TTL. For sub-second rolling precision,
 * pair with Redis sliding log or Envoy token-bucket rate limiters.
 */
export function createCostRateLimiter(redis: RedisClient) {
  return function rateLimit(options: CostRateLimiterOptions) {
    const { windowSeconds, maxPoints, costCalculator = () => 1 } = options;

    return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
      // Validate cost as a finite, positive integer (prevents NaN, Infinity, negative values)
      const rawCost = costCalculator(req);
      const cost = Number.isInteger(rawCost) && rawCost > 0 ? rawCost : 1;

      const orgId = req.currentOrganizationUser?.organizationId;
      const clientKey = orgId
        ? `ratelimit:org:${orgId}`
        : `ratelimit:ip:${req.ip || 'unknown'}`;

      // Atomic execution: increments counter and binds TTL in a single Redis transaction
      const currentPoints = await redis.eval(
        ATOMIC_COST_LIMITER_LUA,
        1,
        clientKey,
        cost,
        windowSeconds
      );

      res.setHeader('X-RateLimit-Limit', maxPoints);
      res.setHeader('X-RateLimit-Remaining', Math.max(0, maxPoints - currentPoints));

      if (currentPoints > maxPoints) {
        res.setHeader('Retry-After', windowSeconds);
        res.status(429).json({
          success: false,
          message: 'Rate limit exceeded. Please slow down your requests.',
          details: { costIncurred: cost, retryAfter: windowSeconds },
        });
        return;
      }

      next();
    };
  };
}
