# Distributed Tracing, Correlation & Observability Architecture

## 1. The Need for Trace Context
A single client action in modern Node.js backends touches multiple subsystems: HTTP middlewares, database models, Redis pub/sub channels, background BullMQ queues, and third-party webhooks.

Without distributed tracing, error logs appear in isolation, making it impossible to correlate an asynchronous worker failure with the originating HTTP request.

---

## 2. Architecture: Node.js AsyncLocalStorage & W3C Trace Context
Instead of passing `req` down through every domain function, utility, and database layer, the system leverages Node.js native `AsyncLocalStorage`:

1. **Edge Ingestion**: The tracing middleware parses incoming W3C `traceparent` headers using standard regex validation (`^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$`). Unmatched or missing headers generate a standard 32-hex random trace ID.
2. **Context Creation**: A minimal, typed `TraceContext` object (`traceId`, `requestId`, `userId`, `organizationId`, `startTime`) is initialized and bound to the asynchronous execution branch.
3. **Automatic Log Enrichment**: Winston/Pino logger formatters query `requestContext.get()` and append trace IDs to every log line automatically.
4. **Queue Telemetry Forwarding**: When enqueuing background tasks (e.g., BullMQ jobs), attach a minimal metadata envelope `{ _trace: { traceId, parentSpanId, correlationId } }`. Never serialize the full HTTP request object. The worker extracts this envelope and rehydrates `requestContext` before running worker logic.
5. **Outbound Headers**: Validated `x-trace-id` and `x-request-id` are sent back in HTTP response headers for rapid troubleshooting by frontend clients.
6. **OpenTelemetry Interoperability**: In enterprise environments, OpenTelemetry SDK with OTLP exporter is the industry standard for telemetry collection. The `AsyncLocalStorage` store and W3C header formats detailed here align 100% with OpenTelemetry conventions.
