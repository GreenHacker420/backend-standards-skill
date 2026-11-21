---
name: backend
description: >-
  Architectural patterns, coding standards, and best practices for Node.js/TypeScript backend
  services, controllers, routes, class-based infrastructure subsystems, queue workers, Prisma schemas,
  ambient type definitions, and API response handlers. Enforces simplicity, maintainability,
  robust error handling, async/await with retry strategies, distributed tracing, service criticality tiering,
  load shedding, and clean structural separation with the database as the single source of truth.
---

# Production Backend Architectural & Coding Standards

This skill prescribes the exact architectural conventions, coding patterns, commenting rules, resilience practices, error handling, async/await discipline, retry strategies, distributed tracing, service criticality tiering, and structural standards for enterprise-grade production backend systems. It provides an opinionated guide for building scalable, resilient, easily maintainable, and type-safe TypeScript backends without unnecessary abstraction.

---

## 1. Core Architectural Tenets

When authoring backend code, adhere strictly to these core principles:

1. **Simplicity Over Abstraction**: Avoid heavy enterprise patterns, complex inheritance hierarchies, or opaque dependency injection containers. Rely on explicit, readable functional composition and direct Prisma queries.
2. **Database as Single Source of Truth (Zero Hardcoding)**:
   - Business rules, feature flags, tenant quotas, role permissions, notification copy, and integration credentials must **never** be hardcoded in TypeScript.
   - Code defines structures, types, and execution engines; the Database stores the configuration, limits, and state.
3. **Service Criticality Tiering & Graceful Degradation**:
   - Classify every endpoint and service into explicit priority tiers: **Tier 0** (Checkout, Auth, Payments — *never shed*), **Tier 1** (Catalog, Cart read — *cache fallback*), **Tier 2** (Recommendations, Personalization, AI — *shed first under load*), and **Tier 3** (Reports, Batch jobs — *hard shed*).
   - Under database or CPU overload, automatically shed or degrade Tier-2/3 operations to preserve capacity for Tier-0.
4. **Database Connection Pool Bulkheading**:
   - Never allow expensive background queries or Tier-2 recommendation lookups to exhaust the primary database connection pool.
   - Constrain Tier-2 queries with strict timeouts (e.g., 150ms) and route them to bounded pools or read-replicas.
   - Core checkout paths must have reserved pool connections and zero synchronous dependencies on lower-tier services.
5. **Distributed Tracing & Context-Aware Observability**:
   - Use Node.js `AsyncLocalStorage` to propagate trace context (`traceId`, `requestId`, `userId`, `organizationId`) seamlessly across the entire call tree.
   - Ingest W3C `traceparent` and `x-trace-id` headers; echo them in all outbound HTTP responses.
   - Structured loggers must automatically attach the current `traceId` to every log line without passing `req` down through function arguments.
   - Propagate trace metadata across BullMQ queue boundaries so asynchronous worker logs correlate with the originating HTTP request.
6. **Robust Error Handling & Explicit Async/Await**:
   - Every asynchronous path must be awaited. Floating promises (`void promise` without `.catch()`) are strictly forbidden.
   - All controller endpoints must wrap execution in `try { ... } catch (error) { next(error); }`.
   - Domain operations must use `try-catch-finally` to ensure resources (temp files, locks, streams) are cleaned up in `finally` blocks.
7. **Resilient Retry Strategies with Exponential Backoff & Jitter**:
   - Network calls (AWS S3, Mailgun, WhatsApp Cloud API, AI APIs), database transaction deadlocks, and cache operations must implement intelligent retry mechanisms for transient errors.
   - Permanent errors (400, 401, 403, 404, 422) must **never** be retried.
8. **Idempotency by Design**:
   - Every state-modifying POST/PUT/PATCH endpoint handling financial transactions, ticket creations, or external integrations must support the `Idempotency-Key` header with atomic DB/Redis locking.
   - Queue consumers and webhook handlers must be strictly idempotent to tolerate at-least-once message delivery.
9. **Transactional Outbox for Dual-Write Prevention**:
   - Never update a database row and emit to a message broker/queue in two disconnected steps. Save events in an `outbox` table in the same DB transaction as the business entity, then relay asynchronously.
10. **Circuit Breaker for External Dependencies**:
    - Wrap flake-prone third-party APIs (WhatsApp, SMS, Email, AI LLMs, payment gateways) in circuit breakers to fail fast and prevent thread starvation during vendor outages.
11. **Graceful Shutdown & Health Probes**:
    - Register shutdown coordinators handling `SIGTERM` / `SIGINT` to drain in-flight requests, pause queue consumers, finish active jobs, and disconnect pools cleanly before exiting.
12. **Class-Based Subsystems for Stateful Infrastructure**: Use classes **only** for stateful components that maintain connections, lifecycles, connection pooling, or event listeners (e.g., `CacheManager`, `PubSubManager`, `MailClient`, `S3Client`, `Database`).
13. **Action-Based Controller Decomposition (1 Action = 1 File)**: Never create a monolithic 1,000-line controller class. Split each API action into its own file (`create.ts`, `update.ts`, `archive.ts`, `get-pool.ts`).
14. **Domain Orchestrator Pattern**: Complex workflows that touch multiple subsystems (DB + S3 + Cache + BullMQ + PubSub) belong in `src/lib/<domain>/`, keeping HTTP controllers slim (under 50 lines).
15. **Inline Schema Validation with Type Inference**: Define request validation schemas (using Zod or Joi) directly at the top of each controller file. Infer and export the request DTO type.
16. **Ambient Typing & Namespace Augmentation**: Extend Express's `Request` and Prisma's JSON types ambiently in `src/typings/index.d.ts` so all handlers receive typed access to auth sessions, correlation IDs, and loggers without type assertions (`as any`).
17. **Semantic Commenting Taxonomy**: Use visual semantic tags (`//?`, `//!`, `//&`, `//*`) to clearly convey rationale, critical hazards, domain boundaries, and business constraints.
18. **Fail-Fast Boot**: Validate all environment variables and secrets at application boot using Zod. The server must crash immediately on boot if configuration is missing or malformed.
19. **Type-Safe API Contracts**: Use generic response formatting helpers (`sendResponse<T>`, `sendArrayResponse<T>`, `sendError`) across all HTTP endpoints.
20. **Modular & Vertical Slice Architecture**: Structure large domain systems into feature-oriented modules (`src/modules/<feature>/`) that encapsulate their own routes, actions, orchestrators, schemas, and repositories, rather than sprawling horizontal layers.
21. **Tail-Based Tracing**: Buffer in-flight spans in-memory and evaluate sampling decisions at request completion to capture 100% of errors and p99 latency spikes while downsampling healthy fast requests.
22. **Retry Budgets & Preventing Retry Storms**: Enforce a token bucket retry budget (max 10% retries) with Full Jitter backoff and strict transient vs terminal error classification to prevent retry storms.
23. **Dead Letter Queue (DLQ) & Poison Pill Quarantine**: Quarantine unprocessable queue messages after max attempts and provide administrative re-drive capabilities.
24. **Singleflight (Cache Stampede Prevention)**: Coalesce concurrent in-flight requests for identical keys to protect downstream databases from thundering herds.

---

## 2. Directory Layout Standard

Organize all backend projects according to this folder structure:

```
src/
├── app.ts                         # Express application setup, HTTP server creation, life-cycle boot
├── bootstrap.ts                   # Global server identity, process error listeners, SSE maps, shutdown hooks
├── env.ts                         # Zod environment schema & fail-fast validation (no unvalidated process.env)
├── config/
│   ├── constants.ts               # Core system invariants, timeouts, standard headers, regexes
│   └── on-boarding-data.ts        # Seed templates (used ONLY during database seeding/migrations)
├── typings/
│   └── index.d.ts                 # Express.Request augmentation, PrismaJson types, JWT payloads
├── shared/
│   ├── classes/                   # Stateful classes (CacheManager, PubSubManager, S3Client, DB)
│   │   ├── errors/                # BaseError, APIError, and centralized ErrorHandler
│   │   ├── request-context.ts     # AsyncLocalStorage distributed tracing store
│   │   ├── degradation-manager.ts # Adaptive load shedding and service tiering coordinator
│   │   ├── circuit-breaker.ts     # Lightweight circuit breaker for external services
│   │   └── shutdown-manager.ts    # Idempotent graceful shutdown coordinator
│   ├── standard-api-responses/    # Generic response helpers (sendResponse<T>, sendArrayResponse<T>, sendError)
│   └── logger.ts                  # Context-aware structured logger (Winston/Loki/Pino)
├── middlewares/
│   ├── auth/                      # checkOrgUserAccess (DB-backed RBAC), checkAdminAccess, checkContact
│   ├── common/                    # request-id, error-middleware, check-token-limit
│   ├── tracing.ts                 # W3C traceparent and x-trace-id ingestion middleware
│   ├── idempotency.ts             # Idempotency-Key request deduplication middleware
│   ├── rate-limiter.ts            # Redis sliding-window distributed rate limiter
│   └── validators/                # File size/format validators
├── controllers/                   # Action-based controllers (grouped by domain folder)
│   └── <domain>/                  # e.g., tickets/, departments/, events/, contacts/
│       ├── create.ts
│       ├── update.ts
│       ├── delete.ts
│       └── get-<domain>.ts
├── routes/                        # Express Router modules mapping routes to actions + RBAC
│   ├── index.ts                   # Root route aggregator + health checks (/health/live, /health/ready)
│   └── <domain>.routes.ts
├── lib/                           # Domain Orchestrators & heavy business workflows
│   └── <domain>/                  # e.g., tickets/create-ticket.ts, voice-calling/call-manager.ts
├── mq-processes/                  # BullMQ asynchronous job orchestration
│   ├── index.ts                   # Centralized MQProcesses singleton & queue registry
│   └── workers/                   # Modular workers (1 worker per queue) & outbox relay
│       └── <domain>/
├── socket/                        # Socket.IO initialization and namespace handlers
└── utils/                         # Redis connection helpers, retry utilities, crypto, formatters
```

### Pattern B: Modular (Vertical Slice / Feature-First) Architecture Standard
For medium-to-large services with multiple bounded contexts, organize by **Feature Module** rather than technical layer to achieve maximum cohesion:

```
src/
├── core/                               # Cross-cutting platform infrastructure
│   ├── database/                       # Prisma client, bulkheaded pools, outbox relay
│   ├── observability/                  # AsyncLocalStorage, tracing, metrics, logger
│   ├── resilience/                     # Circuit breaker, retry budget, degradation manager
│   ├── errors/                         # AppError, error codes, global error handler
│   └── middleware/                     # Auth guard, rate limiter, idempotency, trace context
│
├── modules/                            # Domain modules (vertical slices)
│   ├── orders/
│   │   ├── orders.routes.ts            # Routes definitions for /api/v1/orders
│   │   ├── actions/                    # Single-action controllers (1 file = 1 endpoint)
│   │   │   ├── create-order.action.ts
│   │   │   ├── get-order.action.ts
│   │   │   └── cancel-order.action.ts
│   │   ├── orchestrators/              # Domain logic & transactional workflows
│   │   │   └── order-orchestrator.ts
│   │   ├── schemas/                    # Zod schemas & inferred TypeScript DTOs
│   │   │   └── order.schema.ts
│   │   ├── repositories/               # Domain-specific database queries
│   │   │   └── order.repository.ts
│   │   └── index.ts                    # Public API contract exported to other modules
│   │
│   ├── tickets/
│   │   ├── tickets.routes.ts
│   │   ├── actions/
│   │   ├── orchestrators/
│   │   └── index.ts
│   │
│   └── identity/
│       ├── identity.routes.ts
│       ├── actions/
│       └── index.ts
│
├── app.ts                              # Express app bootstrap, mounting core middleware & module routers
└── server.ts                           # HTTP server listen & graceful shutdown coordinator
```

#### Inviolable Rules of Modular Architecture
1. **High Cohesion, Low Coupling**: All files required for a feature live together inside `src/modules/<feature>/`.
2. **No Direct Cross-Module DB Queries**: Module A (`orders`) must **never** query Module B (`tickets`) database tables directly. Communicate via exported interfaces in `index.ts` or asynchronous outbox events.
3. **Preserve Single-Action Controllers**: Inside `actions/`, each file exports a single endpoint handler. Never create bloated controller classes.

---

---

## 3. Service Criticality Tiering & Graceful Degradation

High-throughput systems must protect vital transactions (checkout, payments, auth) when under stress by gracefully shedding or degrading non-critical enrichment workloads (recommendations, personalization).

### The Criticality Hierarchy

| Tier | Name | Workloads | Overload Behavior |
| :--- | :--- | :--- | :--- |
| **Tier 0** | **Vital / Revenue** | Auth, Cart, Checkout, Payments, Order State | **Never Shed.** Highest priority. Reserved connection pool. Protected by aggressive shedding of lower tiers. |
| **Tier 1** | **Core Experience** | Product details, catalog browsing, inventory read | **Degrade to Stale Cache.** Return cached data with extended TTLs. |
| **Tier 2** | **Sheddable Enrichment** | Recommendations, personalization, related items, AI suggestions | **Shed First.** Under high load, disable dynamically or return static curated bestsellers (`degraded: true`). Zero DB queries. |
| **Tier 3** | **Deferred / Background** | CSV exports, analytical reporting, marketing webhooks | **Hard Shed.** Return HTTP 503 with `Retry-After`; pause non-critical background queues. |

### Database Connection Pool Bulkheading Rules
1. **Connection Reservation**: Ensure the primary pool reserves capacity for Tier-0 transactions. Never allow Tier-2 recommendation queries to consume more than a small fraction (e.g. 20%) of database connections.
2. **Aggressive Query Timeouts**: Set a strict **150ms timeout** on Tier-2 recommendation lookups vs 5,000ms for Tier-0 transactions. If recommendations exceed 150ms, abort the query and serve cached bestsellers.
3. **Zero Synchronous Dependencies**: A Tier-0 checkout path must **never** synchronously await a Tier-2 recommendation or AI call. Any enrichment must be asynchronously fetched or statically pre-rendered.

```typescript
// src/shared/classes/degradation-manager.ts
import { monitorEventLoopDelay } from 'perf_hooks';
import { logger } from '../logger';

export enum DegradationLevel {
    NORMAL = 0,     // Full features active
    ELEVATED = 1,   // Serve stale/cached recommendations only
    HIGH_LOAD = 2,  // Disable personalization; return static defaults
    EMERGENCY = 3,  // Shed all non-essential traffic; Tier 0 only
}

export enum ServiceTier {
    TIER_0_CRITICAL = 'TIER_0',      // Checkout, Auth, Payments
    TIER_1_CORE = 'TIER_1',          // Product catalog, inventory
    TIER_2_ENRICHMENT = 'TIER_2',    // Recommendations, personalization
    TIER_3_BACKGROUND = 'TIER_3',    // Reports, batch analytics
}

class DegradationManager {
    private currentLevel: DegradationLevel = DegradationLevel.NORMAL;
    private histogram = monitorEventLoopDelay({ resolution: 20 });

    constructor() {
        this.histogram.enable();
        // Check health metrics every 5 seconds
        setInterval(() => this.evaluateHealth(), 5000).unref();
    }

    public getLevel(): DegradationLevel {
        return this.currentLevel;
    }

    public shouldExecute(tier: ServiceTier): boolean {
        if (tier === ServiceTier.TIER_0_CRITICAL) return true;
        if (this.currentLevel === DegradationLevel.EMERGENCY) return false;
        if (this.currentLevel === DegradationLevel.HIGH_LOAD && tier === ServiceTier.TIER_2_ENRICHMENT) {
            return false;
        }
        return true;
    }

    private evaluateHealth() {
        const p99EventLoopDelayMs = this.histogram.percentile(99) / 1e6;

        if (p99EventLoopDelayMs > 100) {
            this.setDegradationLevel(DegradationLevel.HIGH_LOAD, `Event loop lag high: ${p99EventLoopDelayMs.toFixed(1)}ms`);
        } else if (p99EventLoopDelayMs > 40) {
            this.setDegradationLevel(DegradationLevel.ELEVATED, `Event loop lag elevated: ${p99EventLoopDelayMs.toFixed(1)}ms`);
        } else if (this.currentLevel !== DegradationLevel.NORMAL) {
            this.setDegradationLevel(DegradationLevel.NORMAL, 'System health normalized');
        }
    }

    public setDegradationLevel(level: DegradationLevel, reason: string) {
        if (this.currentLevel !== level) {
            logger.warn(`[Degradation] Shifting from Level ${this.currentLevel} to ${level}. Reason: ${reason}`);
            this.currentLevel = level;
        }
    }
}

const degradationManager = new DegradationManager();
export default degradationManager;
```

---

## 4. Distributed Tracing & Observability Architecture

### A. The Request Context Store (`AsyncLocalStorage`)
Trace context is held in Node.js memory throughout the asynchronous execution tree, eliminating the need to pass `req` to utility functions, database services, or loggers:

```typescript
// src/shared/classes/request-context.ts
import { AsyncLocalStorage } from 'node:async_hooks';

export interface TraceContext {
    traceId: string;        // Distributed correlation ID across all services (W3C or UUIDv4)
    requestId: string;      // Specific to this HTTP request cycle
    spanId?: string;        // Current execution span
    organizationId?: number;// Tenant isolation context
    userId?: number;        // Authenticated actor
    startTime: number;      // Epoch timestamp for latency tracking
}

class RequestContextStore {
    private storage = new AsyncLocalStorage<TraceContext>();

    public run(context: TraceContext, callback: () => void) {
        this.storage.run(context, callback);
    }

    public get(): TraceContext | undefined {
        return this.storage.getStore();
    }

    public getTraceId(): string {
        return this.storage.getStore()?.traceId || 'no-trace';
    }

    public getRequestId(): string {
        return this.storage.getStore()?.requestId || 'no-request-id';
    }
}

export const requestContext = new RequestContextStore();
```

### B. Tracing Middleware (`src/middlewares/tracing.ts`)
```typescript
import { Request, Response, NextFunction } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { requestContext, TraceContext } from '@/shared/classes/request-context';

export function tracingMiddleware(req: Request, res: Response, next: NextFunction) {
    const traceparent = req.header('traceparent');
    const incomingTraceId = traceparent ? traceparent.split('-')[1] : req.header('x-trace-id');
    const incomingRequestId = req.header('x-request-id');

    const traceId = incomingTraceId || uuidv4().replace(/-/g, '');
    const requestId = incomingRequestId || uuidv4();
    const startTime = Date.now();

    const context: TraceContext = { traceId, requestId, startTime };

    res.setHeader('x-trace-id', traceId);
    res.setHeader('x-request-id', requestId);

    requestContext.run(context, () => next());
}
```

### C. Context-Aware Structured Logger
Every log line automatically embeds `traceId`, `requestId`, `userId`, and `organizationId`:

```typescript
import winston from 'winston';
import { requestContext } from './classes/request-context';

const traceFormat = winston.format((info) => {
    const store = requestContext.get();
    if (store) {
        info.traceId = store.traceId;
        info.requestId = store.requestId;
        if (store.organizationId) info.organizationId = store.organizationId;
        if (store.userId) info.userId = store.userId;
    }
    return info;
});

export const logger = winston.createLogger({
    level: process.env.LOG_LEVEL || 'info',
    format: winston.format.combine(
        traceFormat(),
        winston.format.timestamp(),
        winston.format.json(),
    ),
    transports: [new winston.transports.Console()],
});
```

### D. BullMQ Context Propagation Across Queue Boundaries
```typescript
// Producer: Adding job to queue
await queue.add('process-order', {
    orderId: 101,
    _telemetry: requestContext.get(),
});

// Consumer: Worker handling job
new Worker('orders', async (job) => {
    const telemetry = job.data._telemetry;
    await new Promise<void>((resolve, reject) => {
        requestContext.run(telemetry || { traceId: job.id, requestId: job.id, startTime: Date.now() }, async () => {
            try {
                logger.info('Processing order in background'); // Automatically outputs originating traceId!
                await processOrder(job.data);
                resolve();
            } catch (err) {
                reject(err);
            }
        });
    });
});
```

### E. Tail-Based Tracing & Adaptive Sampling
Unlike head-based sampling which makes a random sampling decision at request entry (losing critical traces when errors or latency spikes occur), **Tail-Based Sampling** buffers in-flight trace spans and evaluates them when the root request terminates:

1. **Error Rule:** Any trace with `statusCode >= 500` or an unhandled exception $\to$ **100% Sampled**.
2. **Latency Rule:** Any trace exceeding SLA/p99 duration (e.g. `> 1000ms`) $\to$ **100% Sampled**.
3. **Critical Tier Rule:** Any request touching Tier 0 services (Auth, Checkout) $\to$ **100% Sampled**.
4. **Fast Baseline Rule:** Fast `200 OK` requests (< 50ms) $\to$ **Downsampled to 1%** (sufficient for baseline percentiles).

```typescript
// See examples/observability/tail-sampler.ts for the complete implementation.
export class TailSampler {
    public evaluateTrace(traceId: string, meta: { statusCode: number; durationMs: number; tier?: number }) {
        if (meta.statusCode >= 500) return { sampled: true, reason: 'error_occurred' };
        if (meta.durationMs >= 1000) return { sampled: true, reason: 'latency_violation' };
        if (meta.tier === 0) return { sampled: true, reason: 'tier_0_critical' };
        if (Math.random() < 0.01) return { sampled: true, reason: 'probabilistic_baseline' };
        return { sampled: false, reason: 'dropped_healthy' };
    }
}
```

---

## 5. Semantic Commenting Taxonomy (`Better Comments` Style)

Use an intentional, color-coded visual commenting grammar across all files to make code self-documenting and immediately scannable:

| Tag | Meaning | Purpose | Example |
| :--- | :--- | :--- | :--- |
| `//?` | **Information & Rationale** | Explains architectural intent, subtle behavior, or external links | `//? L1 in-memory check avoids Redis round-trip for high-frequency user pings` |
| `//!` | **Critical Hazards & Invariants** | Warns of breaking changes, database risks, or third-party quirks | `//! Note: File must be uploaded with contentType, else WhatsApp rejects application/octet-stream` |
| `//&` | **Domain Boundaries** | Visual separators for sub-modules, modules, or major routing groups | `//& Customer support module 📞 📧` |
| `//*` | **Business Rule Constraints** | Specific business rules or time-window limitations | `//* Not sending followup messages outside 9 AM to 9 PM contact local time` |
| `/** ... */` | **JSDoc Rationale** | Multi-line documentation on engineering decisions | Explain why PNG is used over SVG in email, or why custom Crockford alphabet was chosen |

---

## 6. Robust Error Handling & Resilient Retry Strategies

### The Error Hierarchy (`BaseError` & `APIError`)
```typescript
// src/shared/classes/errors/base-error.ts
export class BaseError extends Error {
    public readonly httpCode: number;
    public readonly isOperational: boolean;
    public readonly methodName?: string;
    public readonly errorData?: unknown;

    constructor(opts: {
        message: string;
        httpCode?: number;
        isOperational?: boolean;
        methodName?: string;
        errorData?: unknown;
    }) {
        super(opts.message);
        Object.setPrototypeOf(this, new.target.prototype);
        this.httpCode = opts.httpCode ?? 500;
        this.isOperational = opts.isOperational ?? true;
        this.methodName = opts.methodName;
        this.errorData = opts.errorData;
        Error.captureStackTrace(this);
    }
}

// src/shared/classes/errors/api-error.ts
export class APIError extends BaseError {
    public readonly formatError?: unknown;

    constructor(opts: {
        message: string;
        httpCode: number;
        methodName?: string;
        errorData?: unknown;
        formatError?: unknown;
    }) {
        super({
            message: opts.message,
            httpCode: opts.httpCode,
            isOperational: true,
            methodName: opts.methodName,
            errorData: opts.errorData,
        });
        this.formatError = opts.formatError;
    }
}
```

### Exponential Backoff & Jitter (`withRetry`)
```typescript
// src/utils/retry.ts
import { logger } from '@/shared/logger';

export interface RetryOptions {
    retries?: number;
    minDelayMs?: number;
    maxDelayMs?: number;
    factor?: number;
    jitter?: boolean;
    shouldRetry?: (error: unknown, attempt: number) => boolean;
    onRetry?: (error: unknown, attempt: number, delayMs: number) => void;
}

export function isTransientError(error: unknown): boolean {
    if (!error || typeof error !== 'object') return false;

    // HTTP 429, 502, 503, 504
    if ('response' in error && error.response && typeof error.response === 'object') {
        const status = (error.response as { status?: number }).status;
        if (status === 429 || (status !== undefined && status >= 502 && status <= 504)) return true;
        if (status !== undefined && status >= 400 && status < 500) return false;
    }

    // Node.js network connection drops
    if ('code' in error) {
        const code = (error as { code?: string }).code;
        if (code === 'ECONNRESET' || code === 'ETIMEDOUT' || code === 'ECONNREFUSED' || code === 'EAI_AGAIN') {
            return true;
        }
        // Postgres Deadlocks (40P01) and Serialization Failures (40001)
        if (code === '40P01' || code === '40001') return true;
    }

    return false;
}

export async function withRetry<T>(
    operation: () => Promise<T>,
    options: RetryOptions = {},
): Promise<T> {
    const {
        retries = 3,
        minDelayMs = 1000,
        maxDelayMs = 10000,
        factor = 2,
        jitter = true,
        shouldRetry = isTransientError,
        onRetry,
    } = options;

    let attempt = 0;

    while (true) {
        try {
            return await operation();
        } catch (error) {
            attempt++;
            if (attempt > retries || !shouldRetry(error, attempt)) {
                throw error;
            }

            let delay = Math.min(maxDelayMs, minDelayMs * Math.pow(factor, attempt - 1));
            if (jitter) {
                delay += Math.random() * delay * 0.3;
            }

            if (onRetry) {
                onRetry(error, attempt, delay);
            } else {
                logger.warn(`[Retry] Attempt ${attempt}/${retries} failed. Retrying in ${Math.round(delay)}ms...`);
            }

            await new Promise((resolve) => setTimeout(resolve, delay));
        }
    }
}
```

### Advanced Failure Recovery: Token-Bucket Retry Budget & Full Jitter
To prevent cascading retry storms where layered services multiply retries ($3 \times 3 \times 3 = 27\times$ load), enforce Google SRE retry budgets:
1. Retries must never exceed **10% of total outbound requests** in any 60-second window.
2. Use **Full Jitter** (`random(0, min(cap, base * 2^attempt))`) so clients do not retry in synchronized waves.
3. See `examples/resilience/retry-budget.ts` for the full implementation.

### Strict Error Classification Matrix

| Category | HTTP / System Codes | Retry Action | Strategy |
| :--- | :--- | :---: | :--- |
| **Transient** | `503`, `429`, `ECONNRESET`, `ETIMEDOUT` | ✅ Retry | Retry with Full Jitter, deduct from Retry Budget, honor `Retry-After`. |
| **Terminal / Client** | `400`, `401`, `403`, `404`, `422` | ❌ Do NOT Retry | Fail fast immediately. Retrying bad input wastes CPU and bandwidth. |
| **Non-Idempotent** | Unkeyed `POST`, payment charges | ❌ Do NOT Retry | **Never retry without an `Idempotency-Key`**. |
| **Internal Server Error** | `500 Internal Server Error` | ⚠️ Max 1 | Often indicative of application bugs. Retry at most once if idempotent. |

### Dead Letter Queue (DLQ) & Poison Pill Quarantine
When consuming background queues (BullMQ, Kafka):
1. If a job fails after $N$ attempts (e.g. 5 attempts) due to a malformed payload or poison pill, eject it to `{queueName}-dlq`.
2. Store the input payload, full stack trace, attempt timestamps, and `traceId` on the DLQ record.
3. Provide an administrative re-drive API (`POST /api/v1/admin/queues/:name/redrive`) to replay failed messages once code fixes land.

### Singleflight (Cache Stampede Prevention)
When a high-traffic cache key expires, thousands of concurrent requests can overwhelm the primary database (cache stampede). Use **Singleflight** (Promise coalescing) so that concurrent requests for the same key share a single in-flight Promise:
```typescript
// See examples/resilience/singleflight.ts
import { singleflight } from '@/shared/classes/singleflight';

export async function getCachedProduct(productId: string) {
    return singleflight.do(`product:${productId}`, async () => {
        const cached = await cache.get(`product:${productId}`);
        if (cached) return cached;
        const fresh = await prisma.product.findUnique({ where: { id: productId } });
        await cache.set(`product:${productId}`, fresh, 300);
        return fresh;
    });
}
```

### Request Deadline & Cancellation Propagation
If a client disconnects before a request finishes, abort downstream work immediately to free database locks:
```typescript
export function cancellationMiddleware(req: Request, res: Response, next: NextFunction) {
    const ac = new AbortController();
    req.on('close', () => {
        if (!res.writableEnded) {
            ac.abort(); // Signals database and external fetch clients to abort execution
        }
    });
    (req as any).abortSignal = ac.signal;
    next();
}
```

---

## 7. Advanced Enterprise Patterns for Scalability

### Pattern A: Idempotency Key Middleware
```typescript
// src/middlewares/idempotency.ts
import { Request, Response, NextFunction } from 'express';
import { getRedisConnection } from '@/utils/redisConnection';
import { sendError } from '@/shared/standard-api-responses/send-error';

export function idempotencyMiddleware(ttlSeconds = 86400) {
    return async (req: Request, res: Response, next: NextFunction) => {
        const idempotencyKey = req.header('Idempotency-Key');
        if (!idempotencyKey) return next();

        const orgId = req.currentOrganizationUser?.organizationId || 'public';
        const redisKey = `idempotency:${orgId}:${idempotencyKey}`;
        const redis = getRedisConnection('cache');

        try {
            const acquired = await redis.set(redisKey, JSON.stringify({ status: 'pending' }), 'EX', ttlSeconds, 'NX');
            
            if (!acquired) {
                const existing = await redis.get(redisKey);
                if (existing) {
                    const parsed = JSON.parse(existing);
                    if (parsed.status === 'completed') {
                        return res.status(parsed.httpCode).json(parsed.body);
                    }
                    if (parsed.status === 'pending') {
                        return sendError(res, 'A request with this idempotency key is currently in flight.', 409);
                    }
                }
            }

            const originalJson = res.json.bind(res);
            res.json = (body: any) => {
                if (res.statusCode >= 200 && res.statusCode < 300) {
                    redis.set(
                        redisKey,
                        JSON.stringify({ status: 'completed', httpCode: res.statusCode, body }),
                        'EX',
                        ttlSeconds,
                    ).catch(() => null);
                } else {
                    redis.del(redisKey).catch(() => null);
                }
                return originalJson(body);
            };

            next();
        } catch (err) {
            next();
        }
    };
}
```

### Pattern B: Transactional Outbox Pattern
```typescript
// Inside a domain orchestrator (src/lib/orders/create-order.ts)
export async function createOrderWithOutbox(orderData: CreateOrderInput) {
    const prisma = getPrisma();

    return await prisma.$transaction(async (tx) => {
        const order = await tx.order.create({ data: orderData });

        await tx.outboxEvent.create({
            data: {
                eventType: 'ORDER_CONFIRMED',
                payload: { orderId: order.id, customerId: order.customerId, amount: order.total },
                status: 'PENDING',
                attempts: 0,
            },
        });

        return order;
    });
}
```

### Pattern C: Graceful Shutdown Coordinator
```typescript
// src/shared/classes/shutdown-manager.ts
import { Server } from 'http';
import { getPrisma } from './database';
import { logger } from '../logger';
import mqProcesses from '@/mq-processes';

class ShutdownManager {
    private isShuttingDown = false;

    public isTerminating(): boolean {
        return this.isShuttingDown;
    }

    public register(httpServer: Server) {
        const shutdown = async (signal: string) => {
            if (this.isShuttingDown) return;
            this.isShuttingDown = true;

            logger.info(`Received ${signal}. Starting graceful shutdown...`);

            // 1. Drain HTTP server
            httpServer.close(() => logger.info('HTTP server closed. In-flight requests drained.'));

            const forceExitTimer = setTimeout(() => {
                logger.error('Shutdown timed out. Forcing process exit.');
                process.exit(1);
            }, 15000);
            forceExitTimer.unref();

            try {
                // 2. Close BullMQ workers
                await mqProcesses.shutdown();
                logger.info('MQ workers closed.');

                // 3. Disconnect Database Pool
                const prisma = getPrisma();
                await prisma.$disconnect();
                logger.info('Prisma disconnected.');

                // 4. Disconnect Redis
                if (global._redis_connection) await global._redis_connection.quit();
                logger.info('Redis connections closed.');

                process.exit(0);
            } catch (err) {
                logger.error('Error during shutdown:', err);
                process.exit(1);
            }
        };

        process.on('SIGTERM', () => shutdown('SIGTERM'));
        process.on('SIGINT', () => shutdown('SIGINT'));
    }
}

const shutdownManager = new ShutdownManager();
export default shutdownManager;
```

---

## 8. End-to-End Type Safety Standards

### Generic API Responses
```typescript
// src/shared/standard-api-responses/send-response.ts
import { Response } from 'express';

export interface ApiResponse<T> {
    success: boolean;
    message: string;
    data: T;
}

export default function sendResponse<T>(
    res: Response,
    data: T,
    message: string = 'Success',
    httpCode: number = 200,
    customHeaders?: Record<string, string>,
): Response<ApiResponse<T>> {
    if (customHeaders) {
        Object.entries(customHeaders).forEach(([k, v]) => res.setHeader(k, v));
    }
    return res.status(httpCode).json({
        success: true,
        message,
        data,
    });
}
```

### Express Request Ambient Augmentation
```typescript
// src/typings/index.d.ts
import { OrganizationUser, Organization, AdminUser, Contact } from '@prisma/client';
import winston from 'winston';

export interface AuthorizedOrganizationUser extends OrganizationUser {
    organization: Organization;
    platform?: 'web' | 'mobile';
    checkAccess: (resource: string, action: string) => boolean;
}

declare global {
    namespace Express {
        export interface Request {
            currentOrganizationUser?: AuthorizedOrganizationUser;
            currentAdminUser?: AdminUser;
            currentContact?: Contact & { organization: Organization };
            requestId: string;
            bearerToken?: string;
            logger: winston.Logger;
        }
    }
}
```

---

## 9. Zero-Hardcoding: Database as the Sole Source of Truth

Never embed business parameters, tenant permissions, or pricing caps directly in application code.

1. **User Permissions**: Dynamic RBAC evaluated against `ResourceAccess` and `ModuleResource` tables.
2. **Feature Access & Quotas**: Computed via `FeatureAccess.check(subscription, 'feature_key', count)` against active `SubscriptionFeature` rows.
3. **Notification Copy & Templates**: Stored in `NotificationTemplate` database rows so organizations can customize copy, branding, and placeholders without code changes.
4. **Third-Party Credentials**: Stored per organization in encrypted database rows (`WhatsappIntegration`, `MailSender`, `ShopifySession`).

---

## 10. Agent Checklist & Anti-Patterns to Avoid

### ✅ DOs:
- **Do** wrap every asynchronous controller in `try { ... } catch (error) { next(error); }`.
- **Do** classify endpoints into Service Criticality Tiers (P0 to P3).
- **Do** shed or degrade Tier-2 (recommendations, personalization) under high load to protect Tier-0 (checkout).
- **Do** enforce strict query timeouts (150ms) on Tier-2 recommendation lookups.
- **Do** use `AsyncLocalStorage` to trace requests end-to-end through controllers, loggers, and BullMQ queues.
- **Do** support `Idempotency-Key` headers on state-modifying operations (payments, tickets, orders).
- **Do** use the Transactional Outbox pattern when mutating database state that requires background events.
- **Do** clean up temporary resources (files, buffers, locks) inside `finally` blocks.
- **Do** retry transient errors (network timeouts, HTTP 429/502/503/504, DB deadlocks) using `withRetry`.
- **Do** wrap flaky third-party integrations with a Circuit Breaker.
- **Do** register graceful shutdown handlers (`SIGTERM`/`SIGINT`) to drain connections before exit.
- **Do** create a single file for each controller endpoint (`src/controllers/<domain>/<action>.ts`).
- **Do** declare validation schemas (Zod or Joi) right at the top of the controller file.
- **Do** use semantic comment tags (`//?`, `//!`, `//&`, `//*`) to document rationale and constraints.
- **Do** verify feature limits and permissions dynamically from database records (zero hardcoded rules).
- **Do** use `sendResponse<T>`, `sendArrayResponse<T>`, and `sendError` for all HTTP responses.
- **Do** organize bounded contexts into Modular Vertical Slices (`src/modules/<domain>/`) for high cohesion and easy maintenance.
- **Do** implement Tail-Based Sampling to guarantee 100% trace retention for errors and p99 latency spikes.
- **Do** enforce a Token-Bucket Retry Budget (max 10% retries) to avoid retry storms during downstream degradation.
- **Do** use Full Jitter for exponential backoff to avoid synchronized client retry waves.
- **Do** quarantine poison pill payloads into a Dead Letter Queue (DLQ) with metadata.
- **Do** use Singleflight promise coalescing to prevent cache stampedes on hot keys.
- **Do** propagate request cancellations (`req.on('close')`) to abort downstream database queries when clients disconnect.

### ❌ DON'Ts:
- **Never** allow a Tier-0 checkout endpoint to synchronously await a Tier-2 recommendation or AI call.
- **Never** query another module's database tables directly in a modular architecture (use public module interfaces).
- **Never** perform dual writes (e.g. updating Postgres then publishing directly to Kafka/Rabbit/BullMQ without an outbox).
- **Never** retry without an Idempotency-Key on non-idempotent mutations.
- **Never** retry without jitter or beyond the 10% retry budget.
- **Never** rely purely on random head-based sampling if you need visibility into rare production errors.
- **Never** perform dual writes (e.g. updating Postgres then publishing directly to Kafka/Rabbit/BullMQ without an outbox).
- **Never** leave floating promises un-awaited or without a `.catch()` handler.
- **Never** swallow errors silently (`catch (e) {}`) without logging or proper handling.
- **Never** retry permanent client errors (HTTP 400, 401, 403, 404, 422).
- **Never** hardcode tenant quotas, feature flags, or permission rules in code. Query the DB.
- **Never** use `(req as any)` to access user or session data. Update `src/typings/index.d.ts` instead.
- **Never** return raw objects like `res.json({ foo: 'bar' })` or ad-hoc error formats.
- **Never** perform business logic directly inside Express route files (`.routes.ts`).
- **Never** read `process.env.*` directly throughout the codebase. Import from `@/env`.
