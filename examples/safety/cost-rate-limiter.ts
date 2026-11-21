import { Request, Response, NextFunction } from 'express';

export interface RedisClient {
  incrby(key: string, increment: number): Promise<number>;
  expire(key: string, seconds: number): Promise<number>;
}

/**
 * Cost-Weighted Rate Limiting Middleware
 * Protects CPU-heavy endpoints (e.g. PDF generation, embeddings, large exports)
 * by charging higher point costs against client quotas.
 */
export function createCostRateLimiter(redis: RedisClient) {
  return function rateLimit(options: {
    windowSeconds: number;
    maxPoints: number;
    costCalculator?: (req: Request) => number;
  }) {
    const { windowSeconds, maxPoints, costCalculator = () => 1 } = options;

    return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
      const cost = Math.max(1, costCalculator(req));
      const clientKey = (req as any).currentOrganizationUser
        ? `ratelimit:org:${(req as any).currentOrganizationUser.organizationId}`
        : `ratelimit:ip:${req.ip}`;

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
