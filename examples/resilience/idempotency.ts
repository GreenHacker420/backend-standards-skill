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
    readonly failClosed?: boolean;         //! If lock cannot be checked at entry, reject with 503 to avoid uncoordinated mutation
    readonly sessionValidator?: (token: string) => string | null; //? Validates server-signed session identity for anonymous requests
    readonly logger?: LoggerInterface;
}

//? Zod boundary validation prevents header injection and ReDoS
export const IdempotencyKeySchema = z
    .string()
    .trim()
    .min(16, 'Idempotency key must be at least 16 characters')
    .max(64, 'Idempotency key must be at most 64 characters')
    .regex(/^[a-zA-Z0-9_-]+$/, 'Idempotency key must contain only URL-safe alphanumeric, underscore, or hyphen characters');

export const ClientSessionIdSchema = z
    .string()
    .trim()
    .min(16, 'Client session token must be at least 16 characters')
    .max(256, 'Client session token must be at most 256 characters');

interface StoredIdempotencyRecord {
    status: 'pending' | 'completed';
    ownerToken: string;
    fingerprint: string;
    httpCode?: number;
    headers?: Record<string, string>;
    contentType?: string;
    body?: unknown;
}

//? Safe response header allowlist for replay (prevents replaying sensitive Set-Cookie headers)
const ALLOWED_REPLAY_HEADERS = new Set(['location', 'content-type', 'x-request-id', 'content-language']);
function filterReplayHeaders(headers?: Record<string, string>): Record<string, string> | null {
    if (!headers) return null;
    const filtered: Record<string, string> = {};
    for (const [k, v] of Object.entries(headers)) {
        if (ALLOWED_REPLAY_HEADERS.has(k.toLowerCase())) {
            filtered[k.toLowerCase()] = v;
        }
    }
    return Object.keys(filtered).length > 0 ? filtered : null;
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

//? Atomic Lua script to extend pending lease only if owner token matches and status is pending
const EXTEND_LEASE_LUA = `
local raw = redis.call('GET', KEYS[1])
if not raw then
    return 0
end
local cjson_ok, record = pcall(cjson.decode, raw)
if cjson_ok and record and record.ownerToken == ARGV[1] and record.status == 'pending' then
    return redis.call('EXPIRE', KEYS[1], ARGV[2])
else
    return -1
end
`;

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
        sessionValidator,
        logger,
    } = options;

    //? Configuration boundary validation
    if (!Number.isInteger(pendingTtlSeconds) || pendingTtlSeconds < 5) {
        throw new RangeError('[Idempotency] pendingTtlSeconds must be an integer >= 5 seconds.');
    }
    if (!Number.isInteger(completedTtlSeconds) || completedTtlSeconds < pendingTtlSeconds) {
        throw new RangeError('[Idempotency] completedTtlSeconds must be an integer >= pendingTtlSeconds.');
    }

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
                message: keyParseResult.error.issues[0]?.message ?? 'Invalid Idempotency-Key header.',
            });
            return;
        }

        const idempotencyKey = keyParseResult.data;

        //? Tenant & Actor Isolation:
        //? For authenticated requests, scope by organization AND verified user ID.
        //? For unauthenticated public mutations, require a server-verified session token
        //? (e.g. via sessionValidator) to prevent client-spoofed namespace collisions.
        let tenantScope: string;
        if (req.currentOrganizationUser?.organizationId && req.currentOrganizationUser?.userId) {
            tenantScope = `org:${req.currentOrganizationUser.organizationId}:usr:${req.currentOrganizationUser.userId}`;
        } else {
            // Unauthenticated requests MUST provide a cryptographically verified session token
            if (!sessionValidator) {
                res.status(500).json({
                    error: true,
                    message: 'Misconfigured idempotency: unauthenticated endpoints require a configured sessionValidator (e.g. HMAC-signed cookie or JWT) to prevent client-spoofed namespace collisions.',
                });
                return;
            }

            const rawSessionToken = req.header('X-Client-Session-Id') ?? req.header('Authorization');
            const sessionParseResult = ClientSessionIdSchema.safeParse(rawSessionToken);
            if (!sessionParseResult.success) {
                res.status(400).json({
                    error: true,
                    message: 'Unauthenticated requests using Idempotency-Key must provide a signed session identity in X-Client-Session-Id.',
                });
                return;
            }

            const verifiedSessionId = sessionValidator(sessionParseResult.data);
            if (!verifiedSessionId) {
                res.status(401).json({
                    error: true,
                    message: 'Invalid or forged session identity for unauthenticated idempotency key.',
                });
                return;
            }

            tenantScope = `session:${verifiedSessionId}`;
        }

        const routePath = req.baseUrl + (req.route?.path ?? req.path);
        
        // Scope prevents cross-tenant, cross-actor, or cross-route collision
        const redisKey = `idempotency:${tenantScope}:${req.method.toUpperCase()}:${routePath}:${idempotencyKey}`;
        const currentFingerprint = computeRequestFingerprint(req);
        const ownerToken = crypto.randomUUID();
        let stopHeartbeat = () => {};

        //? Create AbortController to signal cancelable downstream tasks
        const abortController = new AbortController();
        (req as unknown as { idempotencyAbortSignal?: AbortSignal }).idempotencyAbortSignal = abortController.signal;

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
                    
                    // Replay allowlisted headers
                    if (existingRecord.headers) {
                        for (const [headerName, headerValue] of Object.entries(existingRecord.headers)) {
                            res.setHeader(headerName, headerValue);
                        }
                    }

                    // Replay 204 No Content
                    if (existingRecord.httpCode === 204 || existingRecord.body === null || existingRecord.body === undefined) {
                        res.status(existingRecord.httpCode).end();
                        return;
                    }

                    // Replay plain text or JSON
                    if (typeof existingRecord.body === 'string') {
                        res.status(existingRecord.httpCode).send(existingRecord.body);
                        return;
                    }

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
            const originalEnd = res.end.bind(res);
            let responseHandled = false;
            let isCompleted = false;

            //? Lease health tracker: tracks whether this request still securely holds the Redis lease
            let leaseHealthValid = true;
            let consecutiveHeartbeatFailures = 0;
            const leaseStartTime = Date.now();
            const maxHoldTimeoutMs = 120000; // 2 minutes hard limit for active lease renewal

            //? Heartbeat lease renewal: extends lease every pendingTtlSeconds / 3 while operation is running.
            const heartbeatIntervalMs = Math.max(1000, Math.floor((pendingTtlSeconds * 1000) / 3));
            let heartbeatTimer: NodeJS.Timeout | null = setInterval(async () => {
                // Hard deadline guard: abort mutation if handler hangs indefinitely
                if (Date.now() - leaseStartTime > maxHoldTimeoutMs) {
                    leaseHealthValid = false;
                    abortController.abort();
                    stopHeartbeat();
                    logger?.error('[Idempotency] Max lease duration exceeded; dispatched AbortSignal to cancel running operation.', {
                        redisKey,
                        maxHoldTimeoutMs,
                    });
                    return;
                }

                try {
                    const extended = await redis.eval(
                        EXTEND_LEASE_LUA,
                        1,
                        redisKey,
                        ownerToken,
                        pendingTtlSeconds.toString()
                    );
                    if (extended === 1) {
                        consecutiveHeartbeatFailures = 0;
                    } else {
                        // Key expired or was overtaken in Redis
                        leaseHealthValid = false;
                        abortController.abort(); // Cancel the running operation immediately to prevent duplicate state corruption
                        stopHeartbeat();
                        logger?.error('[Idempotency] Pending lease lost or overtaken in Redis; dispatched AbortSignal to cancel running operation.', {
                            redisKey,
                            ownerToken,
                        });
                    }
                } catch (heartbeatErr) {
                    consecutiveHeartbeatFailures++;
                    if (consecutiveHeartbeatFailures >= 2) {
                        // Repeated failures: cannot guarantee lease ownership
                        leaseHealthValid = false;
                        abortController.abort(); // Cancel the running operation when lease can no longer be guaranteed
                        stopHeartbeat();
                        logger?.error('[Idempotency] Repeated heartbeat extension failures; lease considered lost; dispatched AbortSignal.', {
                            redisKey,
                            consecutiveHeartbeatFailures,
                            heartbeatErr,
                        });
                    } else {
                        logger?.warn('[Idempotency] Transient heartbeat failure renewing pending lease:', heartbeatErr);
                    }
                }
            }, heartbeatIntervalMs);
            heartbeatTimer.unref();

            stopHeartbeat = () => {
                if (heartbeatTimer) {
                    clearInterval(heartbeatTimer);
                    heartbeatTimer = null;
                }
            };

            //? Disconnect Safety Invariant:
            //? On client disconnect (!res.writableEnded), we signal cooperative cancellation via abortController.abort().
            //? We DO NOT immediately delete the Redis key!
            //? Furthermore, if an ongoing handler requires a graceful abort/rollback period, we maintain
            //? heartbeat renewal for a short bounded grace period (or until handler completes) so a concurrent retry
            //? cannot acquire the lease while the database connection is still rolling back.
            let disconnectGraceTimer: NodeJS.Timeout | null = null;

            res.once('finish', () => {
                if (disconnectGraceTimer) clearTimeout(disconnectGraceTimer);
                stopHeartbeat();
            });

            res.once('close', () => {
                if (!res.writableEnded && !isCompleted) {
                    abortController.abort();
                    logger?.warn('[Idempotency] Client disconnected with mutation in flight. Dispatched AbortSignal; maintaining lease for graceful cancellation grace period.', {
                        redisKey,
                        ownerToken,
                    });

                    // Allow a 5-second graceful abort/rollback window before terminating heartbeat
                    disconnectGraceTimer = setTimeout(() => {
                        stopHeartbeat();
                    }, 5000);
                    disconnectGraceTimer.unref();
                } else {
                    stopHeartbeat();
                }
            });

            const extractResponseHeaders = (): Record<string, string> => {
                const captured: Record<string, string> = {};
                for (const headerName of ALLOWED_REPLAY_HEADERS) {
                    const val = res.getHeader(headerName);
                    if (typeof val === 'string') {
                        captured[headerName] = val;
                    } else if (typeof val === 'number') {
                        captured[headerName] = val.toString();
                    }
                }
                return captured;
            };

            const persistCompletion = async (statusCode: number, body: unknown): Promise<boolean> => {
                if (disconnectGraceTimer) clearTimeout(disconnectGraceTimer);
                stopHeartbeat();
                isCompleted = true;

                // If lease health was lost during execution, do not attempt completion persistence
                if (!leaseHealthValid) {
                    logger?.error('[Idempotency] Aborting completion persistence: lease health was lost during execution.');
                    return false;
                }

                try {
                    if (statusCode >= 200 && statusCode < 300) {
                        const capturedHeaders = extractResponseHeaders();
                        const record: StoredIdempotencyRecord = {
                            status: 'completed',
                            ownerToken,
                            fingerprint: currentFingerprint,
                            httpCode: statusCode,
                            headers: Object.keys(capturedHeaders).length > 0 ? capturedHeaders : undefined,
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
                        // Compare-and-delete for failed operations (e.g. 4xx validation errors)
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
                sender: () => Response | void,
                mode: 'json' | 'send' | 'end'
            ): Response => {
                if (responseHandled) {
                    sender();
                    return res;
                }
                responseHandled = true;

                void persistCompletion(res.statusCode, body).then((persisted) => {
                    //? Correctness Guarantee on Redis Write Failure:
                    //? If the downstream business mutation succeeded (2xx), but Redis completion persistence failed,
                    //? the mutation HAS already committed in PostgreSQL!
                    //? NEVER report 503 Service Unavailable here, as doing so misleads the client into believing
                    //? the transaction failed and triggers duplicate retries. Instead, deliver the committed response
                    //? and set an observability warning header.
                    if (!persisted && res.statusCode >= 200 && res.statusCode < 300) {
                        logger?.error('[Idempotency] Redis completion cache write failed for successfully committed mutation. Delivering committed response to client to prevent duplicate retry.', {
                            redisKey,
                            statusCode: res.statusCode,
                        });
                        res.setHeader('X-Idempotency-Cache', 'WRITE_FAILED');
                    }
                    sender();
                });

                return res;
            };

            res.json = (body: unknown): Response => captureAndSend(body, () => originalJson(body), 'json');
            res.send = (body: unknown): Response => captureAndSend(body, () => originalSend(body), 'send');
            res.end = (chunk?: unknown, encoding?: unknown, cb?: unknown): Response => {
                let actualCb = cb;
                let actualChunk = chunk;
                if (typeof actualChunk === 'function') {
                    actualCb = actualChunk;
                    actualChunk = undefined;
                }
                return captureAndSend(
                    actualChunk ?? null,
                    () => (originalEnd as (chunk?: unknown, encoding?: unknown, cb?: unknown) => Response)(actualChunk, encoding, actualCb),
                    'end'
                );
            };

            next();
        } catch (err) {
            stopHeartbeat();
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
 *     user_id VARCHAR(64) NOT NULL,
 *     scope VARCHAR(128) NOT NULL,
 *     idempotency_key VARCHAR(64) NOT NULL,
 *     request_fingerprint CHAR(64) NOT NULL,
 *     status VARCHAR(16) NOT NULL CHECK (status IN ('PENDING', 'COMPLETED', 'FAILED')),
 *     http_code INTEGER,
 *     response_headers JSONB,
 *     response_body JSONB,
 *     created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
 *     expires_at TIMESTAMPTZ NOT NULL,
 *     CONSTRAINT uq_idempotency_scope_key UNIQUE (organization_id, user_id, scope, idempotency_key)
 * );
 * CREATE INDEX idx_idempotency_cleanup ON idempotency_records (expires_at) WHERE status = 'COMPLETED';
 * ```
 */

export interface DbRawTransactionClient {
    $queryRaw<T = unknown>(query: TemplateStringsArray, ...values: unknown[]): Promise<T>;
    $executeRaw(query: TemplateStringsArray, ...values: unknown[]): Promise<number>;
}

export interface PrismaClientLike<TTx extends DbRawTransactionClient = DbRawTransactionClient> {
    $transaction<T>(
        action: (tx: TTx) => Promise<T>,
        options?: { maxWait?: number; timeout?: number; isolationLevel?: string }
    ): Promise<T>;
}

export interface DbIdempotencyOptions {
    organizationId: number;
    userId: string | number;
    scope: string;
    idempotencyKey: string;
    requestFingerprint: string;
    ttlMinutes?: number;
    transactionTimeoutMs?: number;
}

export interface IdempotentExecutionResult<T> {
    isReplay: boolean;
    httpCode: number;
    headers?: Record<string, string>;
    data: T;
}

/**
 * Executes a mission-critical business transaction inside PostgreSQL with durable idempotency.
 * Guarantees zero duplicate mutations and atomic state transitions under ACID guarantees.
 * 
 * Correctness Invariants:
 * 1. Actor-Scoped Uniqueness: Scoped to (organization_id, user_id, scope, idempotency_key) so actor-specific
 *    responses are never replayed cross-user.
 * 2. Transactional Atomicity by Construction: Interactive $transaction created internally.
 * 3. Expiration by Database Clock: Expiration strictly evaluated against clock_timestamp().
 */
export async function executeWithDbIdempotency<TResult, TTx extends DbRawTransactionClient = DbRawTransactionClient>(
    prisma: PrismaClientLike<TTx>,
    options: DbIdempotencyOptions,
    operation: (tx: TTx) => Promise<{
        httpCode: number;
        body: TResult;
        headers?: Record<string, string>;
    }>
): Promise<IdempotentExecutionResult<TResult>> {
    const {
        organizationId,
        userId,
        scope,
        idempotencyKey,
        requestFingerprint,
        ttlMinutes = 1440,
        transactionTimeoutMs = 10000,
    } = options;

    const normalizedUserId = String(userId);

    // Boundary Validation
    if (!Number.isInteger(organizationId) || organizationId <= 0) {
        throw new TypeError('[DbIdempotency] organizationId must be a positive integer.');
    }
    if (!normalizedUserId || normalizedUserId.length > 64) {
        throw new TypeError('[DbIdempotency] userId must be a non-empty string <= 64 characters.');
    }
    if (!scope || typeof scope !== 'string' || scope.length > 128) {
        throw new TypeError('[DbIdempotency] scope must be a non-empty string <= 128 characters.');
    }
    if (!idempotencyKey || typeof idempotencyKey !== 'string' || idempotencyKey.length > 64) {
        throw new TypeError('[DbIdempotency] idempotencyKey must be a non-empty string <= 64 characters.');
    }
    if (!requestFingerprint || typeof requestFingerprint !== 'string' || !/^[a-f0-9]{64}$/i.test(requestFingerprint)) {
        throw new TypeError('[DbIdempotency] requestFingerprint must be a 64-character hexadecimal SHA-256 string.');
    }
    if (!Number.isInteger(ttlMinutes) || ttlMinutes <= 0 || ttlMinutes > 525600) {
        throw new RangeError('[DbIdempotency] ttlMinutes must be a positive integer <= 525600 (1 year).');
    }
    if (!Number.isInteger(transactionTimeoutMs) || transactionTimeoutMs < 100 || transactionTimeoutMs > 120000) {
        throw new RangeError('[DbIdempotency] transactionTimeoutMs must be an integer between 100 and 120000ms.');
    }

    return prisma.$transaction(async (tx) => {
        // 1. Attempt atomic insertion of PENDING record with ON CONFLICT DO NOTHING
        const insertCount = await tx.$executeRaw`
            INSERT INTO idempotency_records (
                organization_id, user_id, scope, idempotency_key, request_fingerprint, status, expires_at
            ) VALUES (
                ${organizationId},
                ${normalizedUserId},
                ${scope},
                ${idempotencyKey},
                ${requestFingerprint},
                'PENDING',
                clock_timestamp() + (${`${ttlMinutes} minutes`})::INTERVAL
            )
            ON CONFLICT (organization_id, user_id, scope, idempotency_key) DO NOTHING;
        `;

        // 2. If record already existed (insertCount === 0), evaluate existing record
        if (insertCount === 0) {
            const rows = await tx.$queryRaw<Array<{
                status: 'PENDING' | 'COMPLETED' | 'FAILED';
                request_fingerprint: string;
                http_code: number | null;
                response_headers: Record<string, string> | null;
                response_body: TResult | null;
                is_expired: boolean;
            }>>`
                SELECT status, request_fingerprint, http_code, response_headers, response_body,
                       (expires_at <= clock_timestamp()) AS is_expired
                FROM idempotency_records
                WHERE organization_id = ${organizationId}
                  AND user_id = ${normalizedUserId}
                  AND scope = ${scope}
                  AND idempotency_key = ${idempotencyKey}
                FOR UPDATE;
            `;

            const existing = rows[0];
            if (!existing) {
                throw new Error('Concurrent idempotency race: record not found after conflict.');
            }

            // Expiration Enforcement via PostgreSQL clock_timestamp()
            if (existing.is_expired) {
                await tx.$executeRaw`
                    UPDATE idempotency_records
                    SET status = 'PENDING',
                        request_fingerprint = ${requestFingerprint},
                        http_code = NULL,
                        response_headers = NULL,
                        response_body = NULL,
                        expires_at = clock_timestamp() + (${`${ttlMinutes} minutes`})::INTERVAL,
                        created_at = clock_timestamp()
                    WHERE organization_id = ${organizationId}
                      AND user_id = ${normalizedUserId}
                      AND scope = ${scope}
                      AND idempotency_key = ${idempotencyKey};
                `;
            } else {
                if (existing.request_fingerprint !== requestFingerprint) {
                    throw new Error('Idempotency conflict: key was previously used with a different request payload.');
                }

                if (existing.status === 'COMPLETED' && typeof existing.http_code === 'number') {
                    return {
                        isReplay: true,
                        httpCode: existing.http_code,
                        headers: existing.response_headers ?? undefined,
                        data: existing.response_body as TResult,
                    };
                }

                if (existing.status === 'PENDING') {
                    throw new Error('Mutation with this idempotency key is currently in progress.');
                }
            }
        }

        // 3. Execute the core business operation passing tx to guarantee transactional binding
        const result = await operation(tx);

        // 4. Safely serialize body and allowlisted headers
        const serializedBody = result.body === undefined ? null : JSON.stringify(result.body);
        const filteredHeaders = filterReplayHeaders(result.headers);
        const serializedHeaders = filteredHeaders ? JSON.stringify(filteredHeaders) : null;

        // 5. Atomically persist COMPLETED state within the same ACID transaction
        await tx.$executeRaw`
            UPDATE idempotency_records
            SET status = 'COMPLETED',
                http_code = ${result.httpCode},
                response_headers = ${serializedHeaders}::jsonb,
                response_body = ${serializedBody}::jsonb
            WHERE organization_id = ${organizationId}
              AND user_id = ${normalizedUserId}
              AND scope = ${scope}
              AND idempotency_key = ${idempotencyKey};
        `;

        return {
            isReplay: false,
            httpCode: result.httpCode,
            headers: filteredHeaders ?? undefined,
            data: result.body,
        };
    }, { timeout: transactionTimeoutMs });
}
