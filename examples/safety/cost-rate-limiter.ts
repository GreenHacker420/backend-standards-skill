import { Request, Response, NextFunction } from 'express';

export interface RedisClient {
  incrby(key: string, increment: number): Promise<number>;
  expire(key: string, seconds: number): Promise<number>;
}

export interface CostRateLimiterOptions {
  windowSeconds: number;
  maxPoints: number;
  costCalculator?: (req: Request) => number;
}

/**
 * Cost-Weighted Rate Limiting Middleware
 * Protects CPU-heavy endpoints (e.g. PDF generation, embeddings, large exports)
 * by charging higher point costs against client quotas.
 * 
 * Usage:
 * const limiter = createCostRateLimiter(redis);
 * router.post('/export/pdf', limiter({ windowSeconds: 60, maxPoints: 100, costCalculator: () => 25 }), exportPdf);
 */
export function createCostRateLimiter(redis: RedisClient) {
  return function rateLimit(options: CostRateLimiterOptions) {
    const { windowSeconds, maxPoints, costCalculator = () => 1 } = options;

    return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
      const cost = Math.max(1, costCalculator(req));
      const orgId = req.currentOrganizationUser?.organizationId;
      const clientKey = orgId
        ? `ratelimit:org:${orgId}`
        : `ratelimit:ip:${req.ip || 'unknown'}`;

      const currentPoints = await redis.incrby(clientKey, cost);
      if (currentPoints === cost) {
        await redis.expire(clientKey, windowSeconds);
      }

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
