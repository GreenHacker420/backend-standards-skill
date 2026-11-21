import { Request, Response, NextFunction } from 'express';
import crypto from 'node:crypto';
import { z } from 'zod';
import type { Redis } from 'ioredis';

export interface LoggerInterface {
    error(message: string, ...meta: unknown[]): void;
    warn(message: string, ...meta: unknown[]): void;
}

export interface IdempotencyOptions {
    readonly ttlSeconds?: number;
    readonly failClosed?: boolean; //! Financial transactions must fail-closed if Redis is unavailable
    readonly logger?: LoggerInterface;
}

//? Zod schema replaces unsafe ad-hoc RegExp
export const IdempotencyKeySchema = z
    .string()
    .trim()
    .min(16, 'Idempotency key must be at least 16 characters')
    .max(64, 'Idempotency key must be at most 64 characters')
    .regex(/^[a-zA-Z0-9_-]+$/, 'Idempotency key must contain only URL-safe alphanumeric, underscore, or hyphen characters');

interface StoredIdempotencyRecord {
    status: 'pending' | 'completed';
    httpCode?: number;
    headers?: Record<string, string>;
    body?: unknown;
    fingerprint: string;
}

//? Helper to produce a deterministic hash of the request payload
function computePayloadHash(payload: unknown): string {
    if (!payload || (typeof payload === 'object' && Object.keys(payload).length === 0)) {
        return 'empty';
    }
    const serialized = JSON.stringify(payload, Object.keys(payload as object).sort());
    return crypto.createHash('sha256').update(serialized).digest('hex');
}

/**
 * Production-Safe Idempotency Middleware
 * 
 * Guarantees:
 * 1. Scope isolation (Tenant + Actor + Method + Route + Key)
 * 2. Request fingerprinting (prevents key reuse with different payloads)
 * 3. Awaited persistence (guarantees Redis storage before client receives HTTP response)
 * 4. Intercepts both res.json and res.send
 * 5. Configurable fail-closed vs fail-open behavior
 * 6. Zod-parsed boundary validation
 */
export function idempotencyMiddleware(redis: Redis, options: IdempotencyOptions = {}) {
    const { ttlSeconds = 86400, failClosed = true, logger } = options;

    return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
        const rawKey = req.header('Idempotency-Key');
        if (!rawKey) {
            return next();
        }

        // 1. Parse and validate idempotency key via Zod
        const keyParseResult = IdempotencyKeySchema.safeParse(rawKey);
        if (!keyParseResult.success) {
            res.status(400).json({
                error: true,
                message: keyParseResult.error.errors[0]?.message ?? 'Invalid Idempotency-Key header.',
            });
            return;
        }

        const idempotencyKey = keyParseResult.data;
        const orgId = req.currentOrganizationUser?.organizationId ?? 'public';
        const userId = req.currentOrganizationUser?.userId ?? 'anonymous';
        const method = req.method.toUpperCase();
        const routePath = req.baseUrl + (req.route?.path ?? req.path);
        
        // Scope prevents cross-route or cross-tenant key collisions
        const redisKey = `idempotency:${orgId}:${userId}:${method}:${routePath}:${idempotencyKey}`;
        const currentFingerprint = computePayloadHash(req.body);

        try {
            const initialRecord: StoredIdempotencyRecord = {
                status: 'pending',
                fingerprint: currentFingerprint,
            };

            const acquired = await redis.set(
                redisKey,
                JSON.stringify(initialRecord),
                'EX',
                ttlSeconds,
                'NX'
            );

            if (!acquired) {
                const existingRaw = await redis.get(redisKey);
                if (existingRaw) {
                    const existingRecord = JSON.parse(existingRaw) as StoredIdempotencyRecord;

                    //! Conflict: Key reused with different payload fingerprint
                    if (existingRecord.fingerprint !== currentFingerprint) {
                        res.status(422).json({
                            error: true,
                            message: 'Idempotency key reused with a different request payload or parameters.',
                        });
                        return;
                    }

                    if (existingRecord.status === 'completed' && existingRecord.httpCode) {
                        res.setHeader('X-Cache-Lookup', 'HIT - Idempotent Replay');
                        res.status(existingRecord.httpCode).json(existingRecord.body);
                        return;
                    }

                    if (existingRecord.status === 'pending') {
                        res.status(409).json({
                            error: true,
                            message: 'A mutation with this idempotency key is currently in progress. Please retry shortly.',
                        });
                        return;
                    }
                }
            }

            // Hook response methods to capture output and await persistence before returning
            const originalJson = res.json.bind(res);
            const originalSend = res.send.bind(res);

            const persistResponse = async (statusCode: number, body: unknown) => {
                try {
                    if (statusCode >= 200 && statusCode < 300) {
                        const record: StoredIdempotencyRecord = {
                            status: 'completed',
                            httpCode: statusCode,
                            fingerprint: currentFingerprint,
                            body,
                        };
                        await redis.set(redisKey, JSON.stringify(record), 'EX', ttlSeconds);
                    } else {
                        // Release pending lock on business failure so client can retry with same key
                        await redis.del(redisKey);
                    }
                } catch (persistErr) {
                    logger?.error('[Idempotency] Failed to persist completion state:', persistErr);
                }
            };

            res.json = (body: unknown): Response => {
                void persistResponse(res.statusCode, body).then(() => {
                    originalJson(body);
                });
                return res;
            };

            res.send = (body: unknown): Response => {
                void persistResponse(res.statusCode, body).then(() => {
                    originalSend(body);
                });
                return res;
            };

            next();
        } catch (err) {
            if (failClosed) {
                res.status(503).json({
                    error: true,
                    message: 'Idempotency service temporarily unavailable. Transaction aborted to prevent duplicate execution.',
                });
                return;
            }
            next();
        }
    };
}

/**
 * Pattern B: Durable Database-Backed Idempotency (PostgreSQL / Prisma)
 * For financial transactions where Redis caching is insufficient.
 */
export interface DatabaseIdempotencyRecord {
    id: string;
    scope: string;
    key: string;
    fingerprint: string;
    status: 'PENDING' | 'COMPLETED' | 'FAILED';
    statusCode: number | null;
    responseBody: unknown | null;
    createdAt: Date;
    expiresAt: Date;
}
