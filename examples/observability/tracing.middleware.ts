import { Request, Response, NextFunction } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { requestContext, TraceContext } from './request-context';

// W3C Trace Context specification regex (version 00, 32-hex trace-id, 16-hex parent-id, 2-hex flags)
const W3C_TRACEPARENT_REGEX = /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/i;
const SAFE_ID_REGEX = /^[a-zA-Z0-9_-]{16,64}$/;

/**
 * Validates and extracts trace ID from incoming headers.
 * In production, OpenTelemetry SDK handles this via TextMapPropagator;
 * this lightweight middleware demonstrates standard compliant extraction.
 */
function extractValidatedTraceId(req: Request): string {
    const traceparent = req.header('traceparent');
    if (traceparent) {
        const match = W3C_TRACEPARENT_REGEX.exec(traceparent.trim());
        if (match && match[1] !== '00000000000000000000000000000000') {
            return match[1].toLowerCase();
        }
    }

    const customTraceId = req.header('x-trace-id');
    if (customTraceId && SAFE_ID_REGEX.test(customTraceId.trim())) {
        return customTraceId.trim();
    }

    // Generate compliant 32-hex trace ID (16 bytes random hex)
    return uuidv4().replace(/-/g, '').toLowerCase();
}

export function tracingMiddleware(req: Request, res: Response, next: NextFunction): void {
    const traceId = extractValidatedTraceId(req);
    
    const incomingRequestId = req.header('x-request-id');
    const requestId = (incomingRequestId && SAFE_ID_REGEX.test(incomingRequestId.trim()))
        ? incomingRequestId.trim()
        : uuidv4();

    const startTime = Date.now();

    const context: TraceContext = {
        traceId,
        requestId,
        startTime,
    };

    // Standard response headers for correlation
    res.setHeader('x-trace-id', traceId);
    res.setHeader('x-request-id', requestId);

    requestContext.run(context, () => next());
}
