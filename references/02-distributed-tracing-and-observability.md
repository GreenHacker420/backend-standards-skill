# Distributed Tracing, Correlation & Observability Architecture

## 1. The Need for Trace Context
A single client action in modern Node.js backends touches multiple subsystems: HTTP middlewares, database models, Redis pub/sub channels, background BullMQ queues, and third-party webhooks.

Without distributed tracing, error logs appear in isolation, making it impossible to correlate an asynchronous worker failure with the originating HTTP request.

---

## 2. Architecture: Node.js AsyncLocalStorage
Instead of passing `req` down through every domain function, utility, and database layer, the system leverages Node.js native `AsyncLocalStorage`:

1. **Edge Ingestion**: The tracing middleware intercepts incoming HTTP headers (`traceparent`, `x-trace-id`, `x-request-id`).
2. **Context Creation**: A `TraceContext` object (`traceId`, `requestId`, `userId`, `organizationId`, `startTime`) is initialized and bound to the asynchronous execution branch.
3. **Automatic Log Enrichment**: Winston/Pino logger formatters query `requestContext.get()` and append trace IDs to every log line automatically.
4. **Queue Telemetry Forwarding**: When enqueuing a BullMQ job, `_telemetry` is attached to `job.data`. The consumer rehydrates `requestContext` before running worker logic.
5. **Outbound Headers**: `x-trace-id` and `x-request-id` are sent back in HTTP response headers for rapid troubleshooting by frontend clients.
