import { Request, Response, NextFunction } from 'express';
import crypto from 'node:crypto';
import { z } from 'zod';
import type { Redis } from 'ioredis';

export interface LoggerInterface {
    error(message: string, ...meta: unknown[]): void;
    warn(message: string, ...meta: unknown[]): void;
    info(message: string, ...meta: unknown[]): void;
}

export interface CacheIdempotencyOptions {
    readonly pendingTtlSeconds?: number;   //? Short lease for in-flight requests (default: 60s) preventing indefinite lockout on crash
    readonly completedTtlSeconds?: number; //? Retention window for completed responses (default: 86400s / 24h)
    readonly failClosed?: boolean;         //! Invariant: If completion cannot be persisted, fail to avoid untracked mutations
    readonly logger?: LoggerInterface;
}

//? Zod boundary validation prevents header injection and ReDoS
export const IdempotencyKeySchema = z
    .string()
    .trim()
    .min(16, 'Idempotency key must be at least 16 characters')
    .max(64, 'Idempotency key must be at most 64 characters')
    .regex(/^[a-zA-Z0-9_-]+$/, 'Idempotency key must contain only URL-safe alphanumeric, underscore, or hyphen characters');

interface StoredIdempotencyRecord {
    status: 'pending' | 'completed';
    ownerToken: string;
    fingerprint: string;
    httpCode?: number;
    headers?: Record<string, string>;
    body?: unknown;
}

//? Recursive canonical JSON serializer (ensures nested objects sort keys deterministically)
export function canonicalize(obj: unknown): unknown {
    if (obj === null || typeof obj !== 'object') {
        return obj;
    }
    if (Array.isArray(obj)) {
        return obj.map(canonicalize);
    }
    const sortedKeys = Object.keys(obj as Record<string, unknown>).sort();
    const result: Record<string, unknown> = {};
    for (const key of sortedKeys) {
        const val = (obj as Record<string, unknown>)[key];
        if (val !== undefined && typeof val !== 'function' && typeof val !== 'symbol') {
            result[key] = canonicalize(val);
        }
    }
    return result;
}

/**
 * Computes a deterministic SHA-256 fingerprint covering all operation-defining inputs:
 * HTTP method, route template, URL path parameters, query parameters, and canonicalized body.
 */
export function computeRequestFingerprint(req: Request): string {
    const operationPayload = {
        method: req.method.toUpperCase(),
        route: req.baseUrl + (req.route?.path ?? req.path),
        params: canonicalize(req.params),
        query: canonicalize(req.query),
        body: canonicalize(req.body),
    };
    return crypto.createHash('sha256').update(JSON.stringify(operationPayload)).digest('hex');
}

//? Atomic Lua script to complete idempotency record only if owner token matches
const COMPLETE_IDEMPOTENCY_LUA = `
local raw = redis.call('GET', KEYS[1])
if not raw then
    return 0
end
local cjson_ok, record = pcall(cjson.decode, raw)
if cjson_ok and record and record.ownerToken == ARGV[1] then
    redis.call('SET', KEYS[1], ARGV[2], 'EX', ARGV[3])
    return 1
else
    return -1
end
`;

//? Atomic Lua script to compare and delete pending lease only if owner token matches
const COMPARE_AND_DELETE_LUA = `
local raw = redis.call('GET', KEYS[1])
if not raw then
    return 0
end
local cjson_ok, record = pcall(cjson.decode, raw)
if cjson_ok and record and record.ownerToken == ARGV[1] then
    return redis.call('DEL', KEYS[1])
else
    return -1
end
`;

/**
 * Fast Cache-Layered Idempotency Middleware (Redis Acceleration)
 * 
 * Note: For authoritative financial transactions (e.g. credit transfers, ledger balance mutations),
 * use the durable PostgreSQL-backed implementation below (executeWithDbIdempotency).
 * Redis is an optional acceleration layer for rapid deduplication, not a substitute for ACID storage.
 */
export function cacheIdempotencyMiddleware(redis: Redis, options: CacheIdempotencyOptions = {}) {
    const {
        pendingTtlSeconds = 60,       // Short lease for pending execution (prevents 24h lockout on crash)
        completedTtlSeconds = 86400,  // Full 24h retention for completed responses
        failClosed = true,
        logger,
    } = options;

    return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
        const rawKey = req.header('Idempotency-Key');
        if (!rawKey) {
            return next();
        }

        // 1. Parse and validate boundary key via Zod
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
        const routePath = req.baseUrl + (req.route?.path ?? req.path);
        
        // Scope prevents cross-tenant or cross-route collision
        const redisKey = `idempotency:${orgId}:${userId}:${req.method.toUpperCase()}:${routePath}:${idempotencyKey}`;
        const currentFingerprint = computeRequestFingerprint(req);
        const ownerToken = crypto.randomUUID();

        try {
            const initialRecord: StoredIdempotencyRecord = {
                status: 'pending',
                ownerToken,
                fingerprint: currentFingerprint,
            };

            // Acquire short pending lease (NX guarantees mutual exclusion)
            const acquired = await redis.set(
                redisKey,
                JSON.stringify(initialRecord),
                'EX',
                pendingTtlSeconds,
                'NX'
            );

            if (!acquired) {
                const existingRaw = await redis.get(redisKey);
                
                //! Critical Fix: If lock wasn't acquired and key is missing (race condition), do NOT proceed to mutation!
                if (!existingRaw) {
                    res.status(409).json({
                        error: true,
                        message: 'Concurrent lock acquisition in progress. Please retry your request.',
                    });
                    return;
                }

                const existingRecord = JSON.parse(existingRaw) as StoredIdempotencyRecord;

                //! Conflict: Key reused with different operation fingerprint (params/query/body mismatch)
                if (existingRecord.fingerprint !== currentFingerprint) {
                    res.status(422).json({
                        error: true,
                        message: 'Idempotency key reused with different request parameters, query, or payload.',
                    });
                    return;
                }

                if (existingRecord.status === 'completed' && typeof existingRecord.httpCode === 'number') {
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

            // Hook response methods to capture body and await completion persistence
            const originalJson = res.json.bind(res);
            const originalSend = res.send.bind(res);
            let responseHandled = false;

            const persistCompletion = async (statusCode: number, body: unknown): Promise<boolean> => {
                try {
                    if (statusCode >= 200 && statusCode < 300) {
                        const record: StoredIdempotencyRecord = {
                            status: 'completed',
                            ownerToken,
                            fingerprint: currentFingerprint,
                            httpCode: statusCode,
                            body,
                        };
                        const result = await redis.eval(
                            COMPLETE_IDEMPOTENCY_LUA,
                            1,
                            redisKey,
                            ownerToken,
                            JSON.stringify(record),
                            completedTtlSeconds.toString()
                        );
                        return result === 1;
                    } else {
                        // Compare-and-delete: only delete if THIS ownerToken still owns the key (prevents deleting next lease)
                        await redis.eval(COMPARE_AND_DELETE_LUA, 1, redisKey, ownerToken);
                        return true;
                    }
                } catch (persistErr) {
                    logger?.error('[Idempotency] Failed to persist completion state:', persistErr);
                    return false;
                }
            };

            const captureAndSend = (
                body: unknown,
                sender: (data: unknown) => Response,
                isJson: boolean
            ): Response => {
                if (responseHandled) {
                    return sender(body);
                }
                responseHandled = true;

                void persistCompletion(res.statusCode, body).then((persisted) => {
                    //! Fail-closed: If completion cannot be persisted in Redis, report 503 using unpatched sender
                    if (!persisted && failClosed && res.statusCode >= 200 && res.statusCode < 300) {
                        res.status(503);
                        if (isJson) {
                            return originalJson({
                                error: true,
                                message: 'Operation executed but idempotency confirmation failed. Contact support before retrying.',
                            });
                        }
                        return originalSend('Operation executed but idempotency confirmation failed.');
                    }
                    sender(body);
                });

                return res;
            };

            res.json = (body: unknown): Response => captureAndSend(body, originalJson, true);
            res.send = (body: unknown): Response => captureAndSend(body, originalSend, false);

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
 * ============================================================================
 * Pattern B: Authoritative Durable PostgreSQL Idempotency (Financial Standard)
 * ============================================================================
 * 
 * PostgreSQL DDL:
 * ```sql
 * CREATE TABLE idempotency_records (
 *     id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
 *     organization_id INTEGER NOT NULL,
 *     scope VARCHAR(128) NOT NULL,
 *     idempotency_key VARCHAR(64) NOT NULL,
 *     request_fingerprint CHAR(64) NOT NULL,
 *     status VARCHAR(16) NOT NULL CHECK (status IN ('PENDING', 'COMPLETED', 'FAILED')),
 *     http_code INTEGER,
 *     response_body JSONB,
 *     created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 *     expires_at TIMESTAMPTZ NOT NULL,
 *     CONSTRAINT uq_idempotency_scope_key UNIQUE (organization_id, scope, idempotency_key)
 * );
 * CREATE INDEX idx_idempotency_cleanup ON idempotency_records (expires_at) WHERE status = 'COMPLETED';
 * ```
 */

export interface DbTransactionClient {
    $queryRaw<T = unknown>(query: TemplateStringsArray, ...values: unknown[]): Promise<T>;
    $executeRaw(query: TemplateStringsArray, ...values: unknown[]): Promise<number>;
}

export interface DbIdempotencyOptions {
    organizationId: number;
    scope: string;
    idempotencyKey: string;
    requestFingerprint: string;
    ttlMinutes?: number;
}

export interface IdempotentExecutionResult<T> {
    isReplay: boolean;
    httpCode: number;
    data: T;
}

/**
 * Executes a mission-critical business transaction inside PostgreSQL with durable idempotency.
 * Guarantees zero duplicate mutations and atomic state transitions under ACID guarantees.
 * 
 * Production Safety Rules:
 * 1. Transactional Atomicity by Construction:
 *    The `operation` callback MUST accept `tx` and execute all entity mutations through this
 *    supplied transaction client, guaranteeing atomicity between business state and the idempotency record.
 * 2. Unprotected Side Effects Prohibited:
 *    NEVER perform non-transactional external side effects (e.g. charging a payment card, publishing
 *    Kafka messages, external HTTP webhooks) directly inside `operation(tx)`. Use the Transactional
 *    Outbox Pattern so side effects only dispatch after this database transaction commits.
 * 3. Failure Rollback Semantics:
 *    When `operation(tx)` throws an error, PostgreSQL aborts the entire interactive transaction.
 *    Both partial business mutations and the PENDING idempotency record are cleanly rolled back,
 *    freeing the key for safe subsequent retries without orphaned locks.
 */
export async function executeWithDbIdempotency<T>(
    tx: DbTransactionClient,
    options: DbIdempotencyOptions,
    operation: (tx: DbTransactionClient) => Promise<{ httpCode: number; body: T }>
): Promise<IdempotentExecutionResult<T>> {
    const { organizationId, scope, idempotencyKey, requestFingerprint, ttlMinutes = 1440 } = options;

    // 1. Attempt atomic insertion of PENDING record with ON CONFLICT DO NOTHING
    const insertCount = await tx.$executeRaw`
        INSERT INTO idempotency_records (
            organization_id, scope, idempotency_key, request_fingerprint, status, expires_at
        ) VALUES (
            ${organizationId},
            ${scope},
            ${idempotencyKey},
            ${requestFingerprint},
            'PENDING',
            NOW() + (${`${ttlMinutes} minutes`})::INTERVAL
        )
        ON CONFLICT (organization_id, scope, idempotency_key) DO NOTHING;
    `;

    // 2. If record already existed (insertCount === 0), evaluate existing record
    if (insertCount === 0) {
        const rows = await tx.$queryRaw<Array<{
            status: 'PENDING' | 'COMPLETED' | 'FAILED';
            request_fingerprint: string;
            http_code: number | null;
            response_body: T | null;
            expires_at: Date;
        }>>`
            SELECT status, request_fingerprint, http_code, response_body, expires_at
            FROM idempotency_records
            WHERE organization_id = ${organizationId}
              AND scope = ${scope}
              AND idempotency_key = ${idempotencyKey}
            FOR UPDATE;
        `;

        const existing = rows[0];
        if (!existing) {
            throw new Error('Concurrent idempotency race: record not found after conflict.');
        }

        //! Invariant check: Fingerprint mismatch indicates key reuse with different input
        if (existing.request_fingerprint !== requestFingerprint) {
            throw new Error('Idempotency conflict: key was previously used with a different request payload.');
        }

        //? Fix: Safely replays valid responses with 204 No Content, null, false, 0, or empty string bodies
        if (existing.status === 'COMPLETED' && typeof existing.http_code === 'number') {
            return {
                isReplay: true,
                httpCode: existing.http_code,
                data: existing.response_body as T,
            };
        }

        if (existing.status === 'PENDING') {
            throw new Error('Mutation with this idempotency key is currently in progress.');
        }
    }

    // 3. Execute the core business operation passing tx to guarantee transactional binding
    const result = await operation(tx);

    // 4. Atomically persist COMPLETED state and response body within the same ACID transaction
    await tx.$executeRaw`
        UPDATE idempotency_records
        SET status = 'COMPLETED',
            http_code = ${result.httpCode},
            response_body = ${JSON.stringify(result.body)}::jsonb
        WHERE organization_id = ${organizationId}
          AND scope = ${scope}
          AND idempotency_key = ${idempotencyKey};
    `;

    return {
        isReplay: false,
        httpCode: result.httpCode,
        data: result.body,
    };
}
