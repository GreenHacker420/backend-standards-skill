import { Request, Response, NextFunction } from 'express';
import crypto from 'node:crypto';
import { requestContext, TraceContext } from './request-context';
import { W3CTraceparentSchema, SafeCorrelationIdSchema } from './trace-schemas';

interface ExtractedTraceContext {
    traceId: string;
    parentId?: string;
    traceFlags: string;
}

/**
 * Validates and extracts trace context from incoming headers using strict Zod schemas.
 * 
 * Enforces:
 * 1. W3C Trace Context spec compliance (55-char length, non-zero trace_id and parent_id)
 * 2. URL-safe, injection-safe correlation ID boundaries
 * 3. Graceful cryptographic fallback if incoming telemetry headers are missing or malformed
 */
function extractValidatedTrace(req: Request): ExtractedTraceContext {
    const rawTraceparent = req.header('traceparent');
    if (rawTraceparent) {
        const parseResult = W3CTraceparentSchema.safeParse(rawTraceparent);
        if (parseResult.success) {
            return {
                traceId: parseResult.data.traceId,
                parentId: parseResult.data.parentId,
                traceFlags: parseResult.data.flags,
            };
        }
    }

    const rawCustomTraceId = req.header('x-trace-id');
    if (rawCustomTraceId) {
        const parseResult = SafeCorrelationIdSchema.safeParse(rawCustomTraceId);
        if (parseResult.success) {
            return {
                traceId: parseResult.data,
                traceFlags: '01',
            };
        }
    }

    //? Generate standard 32-hex (16-byte) compliant trace identifier
    return {
        traceId: crypto.randomBytes(16).toString('hex'),
        traceFlags: '01',
    };
}

function extractValidatedRequestId(req: Request): string {
    const rawRequestId = req.header('x-request-id');
    if (rawRequestId) {
        const parseResult = SafeCorrelationIdSchema.safeParse(rawRequestId);
        if (parseResult.success) {
            return parseResult.data;
        }
    }

    return crypto.randomUUID();
}

export function tracingMiddleware(req: Request, res: Response, next: NextFunction): void {
    const { traceId, parentId, traceFlags } = extractValidatedTrace(req);
    const requestId = extractValidatedRequestId(req);
    const spanId = crypto.randomBytes(8).toString('hex'); // 16-hex characters for W3C span ID
    const startTime = Date.now();

    const context: TraceContext = {
        traceId,
        requestId,
        spanId,
        parentId,
        traceFlags,
        startTime,
    };

    //? Echo standard correlation headers and outbound W3C traceparent in HTTP response
    res.setHeader('x-trace-id', traceId);
    res.setHeader('x-request-id', requestId);
    res.setHeader('traceparent', `00-${traceId}-${spanId}-${traceFlags}`);

    requestContext.run(context, () => next());
}
