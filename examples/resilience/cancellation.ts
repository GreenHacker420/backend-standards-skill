import { Request, Response, NextFunction } from 'express';

/**
 * Production-Safe HTTP Request Cancellation Middleware
 * 
 * In modern Node.js (v16+), req.on('close') is emitted when the incoming request body
 * finishes uploading, NOT when the client disconnects! Listening to req.on('close')
 * prematurely aborts successful business transactions.
 * 
 * Correct Pattern: Listen to res.on('close') and check if !res.writableEnded.
 * If res.writableEnded is false when close fires, the client disconnected prematurely.
 */
export function cancellationMiddleware(req: Request, res: Response, next: NextFunction): void {
    const abortController = new AbortController();

    res.on('close', () => {
        //? Only abort if the response has NOT ended cleanly
        if (!res.writableEnded) {
            abortController.abort(new Error('Client closed HTTP connection prematurely'));
        }
    });

    // Provide strictly typed AbortSignal in res.locals
    res.locals.abortSignal = abortController.signal;

    next();
}

/**
 * Example usage in an orchestrator or downstream client:
 * 
 * Note: AbortSignal does NOT automatically cancel uninstrumented database calls.
 * Downstream HTTP clients (fetch, axios) or Prisma raw queries must explicitly
 * consume signal:
 * 
 * async function callExternalGateway(url: string, signal?: AbortSignal) {
 *     return fetch(url, { signal });
 * }
 */
