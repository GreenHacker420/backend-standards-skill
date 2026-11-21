import { Request, Response, NextFunction } from 'express';
import type { Redis } from 'ioredis';

export function idempotencyMiddleware(redis: Redis, ttlSeconds = 86400) {
    return async (req: Request, res: Response, next: NextFunction) => {
        const idempotencyKey = req.header('Idempotency-Key');
        if (!idempotencyKey) return next();

        const redisKey = `idempotency:${idempotencyKey}`;

        try {
            const acquired = await redis.set(redisKey, JSON.stringify({ status: 'pending' }), 'EX', ttlSeconds, 'NX');
            
            if (!acquired) {
                const existing = await redis.get(redisKey);
                if (existing) {
                    const parsed = JSON.parse(existing);
                    if (parsed.status === 'completed') {
                        return res.status(parsed.httpCode).json(parsed.body);
                    }
                    if (parsed.status === 'pending') {
                        return res.status(409).json({
                            error: true,
                            message: 'A request with this idempotency key is currently in flight.',
                        });
                    }
                }
            }

            const originalJson = res.json.bind(res);
            res.json = (body: any) => {
                if (res.statusCode >= 200 && res.statusCode < 300) {
                    redis.set(
                        redisKey,
                        JSON.stringify({ status: 'completed', httpCode: res.statusCode, body }),
                        'EX',
                        ttlSeconds,
                    ).catch(() => null);
                } else {
                    redis.del(redisKey).catch(() => null);
                }
                return originalJson(body);
            };

            next();
        } catch (err) {
            next();
        }
    };
}
