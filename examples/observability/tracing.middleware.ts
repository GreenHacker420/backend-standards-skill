import { Request, Response, NextFunction } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { requestContext, TraceContext } from './request-context';

export function tracingMiddleware(req: Request, res: Response, next: NextFunction) {
    const traceparent = req.header('traceparent');
    const incomingTraceId = traceparent ? traceparent.split('-')[1] : req.header('x-trace-id');
    const incomingRequestId = req.header('x-request-id');

    const traceId = incomingTraceId || uuidv4().replace(/-/g, '');
    const requestId = incomingRequestId || uuidv4();
    const startTime = Date.now();

    const context: TraceContext = {
        traceId,
        requestId,
        startTime,
    };

    res.setHeader('x-trace-id', traceId);
    res.setHeader('x-request-id', requestId);

    requestContext.run(context, () => next());
}
