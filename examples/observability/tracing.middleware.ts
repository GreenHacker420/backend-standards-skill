import { Request, Response, NextFunction } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { requestContext, TraceContext } from './request-context';
import { W3CTraceparentSchema, SafeCorrelationIdSchema } from './trace-schemas';

/**
 * Validates and extracts trace ID from incoming headers using strict Zod schemas.
 * 
 * Enforces:
 * 1. W3C Trace Context spec compliance (55-char length, non-zero trace_id and parent_id)
 * 2. URL-safe, injection-safe correlation ID boundaries
 * 3. Graceful cryptographic fallback if incoming telemetry headers are missing or malformed
 */
function extractValidatedTraceId(req: Request): string {
    const rawTraceparent = req.header('traceparent');
    if (rawTraceparent) {
        const parseResult = W3CTraceparentSchema.safeParse(rawTraceparent);
        if (parseResult.success) {
            return parseResult.data.traceId;
        }
    }

    const rawCustomTraceId = req.header('x-trace-id');
    if (rawCustomTraceId) {
        const parseResult = SafeCorrelationIdSchema.safeParse(rawCustomTraceId);
        if (parseResult.success) {
            return parseResult.data;
        }
    }

    //? Generate standard 32-hex (16-byte) compliant trace identifier
    return uuidv4().replace(/-/g, '').toLowerCase();
}

function extractValidatedRequestId(req: Request): string {
    const rawRequestId = req.header('x-request-id');
    if (rawRequestId) {
        const parseResult = SafeCorrelationIdSchema.safeParse(rawRequestId);
        if (parseResult.success) {
            return parseResult.data;
        }
    }

    return uuidv4();
}

export function tracingMiddleware(req: Request, res: Response, next: NextFunction): void {
    const traceId = extractValidatedTraceId(req);
    const requestId = extractValidatedRequestId(req);
    const startTime = Date.now();

    const context: TraceContext = {
        traceId,
        requestId,
        startTime,
    };

    //? Echo standard correlation headers in HTTP response
    res.setHeader('x-trace-id', traceId);
    res.setHeader('x-request-id', requestId);

    requestContext.run(context, () => next());
}
