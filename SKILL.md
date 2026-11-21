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
14. **Domain Orchestrator Pattern**: Complex workflows that touch multiple subsystems (DB + S3 + Cache + BullMQ + PubSub) belong in `src/lib/<domain>/`, keeping HTTP controllers focused; roughly 65 lines is an advisory review threshold, not a hard cap.
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
25. **Parse, Don't Validate & Smart Constructors**: Parse raw input at system boundaries into branded types (`Email`, `UserId`, `Money`) that cannot exist in an invalid state. Internal services must never defensively re-validate.
26. **Make Illegal States Unrepresentable**: Model domain entities as state-discriminated unions rather than single objects with dozens of optional properties (`status: 'pending' | 'paid'`).
27. **The Result Pattern for Expected Business Failures**: Return `{ ok: true, data } | { ok: false, error }` instead of throwing exceptions for predictable domain errors (`CouponExpired`, `InsufficientBalance`).
28. **Prisma Type Extraction (Zero `as any`)**: Use `satisfies Prisma.<Model>Select` and `Prisma.<Model>GetPayload` to extract the exact return types of database queries without type assertions.
29. **The Single Options Object Pattern**: Wrap function arguments in a single `readonly options: { ... }` object to prevent accidental parameter swapping bugs.
30. **Semantic Commenting Taxonomy (`Better Comments` Style)**: Comments must document *why*, never *what*. Use semantic tags (`//?` Rationale, `//!` Hazards/Invariants, `//*` Business Rules, `//&` Boundaries). Never state the obvious.
31. **Guard Clauses & Flat Code Hierarchy**: Eliminate deep nesting (arrow code) by validating pre-conditions early and returning immediately. Keep the happy path flat against the left margin.
32. **Controller Size Heuristic & Zero Dead Code**: Keep controllers focused on transport concerns and delegate domain workflows to orchestrators. Roughly 65 lines is an advisory review threshold, not a hard cap; longer handlers should be reviewed for misplaced responsibilities and simplified when appropriate. Never commit commented-out zombie code; rely on Git history.
33. **Timing-Safe Cryptographic Comparisons**: Never use `===` to verify HMAC webhook signatures or secret tokens. Always use `crypto.timingSafeEqual` over fixed-length Buffers to prevent timing side-channel attacks.
34. **Backpressured Stream Pipelines (OOM Prevention)**: Never load large files, CSV imports, or media buffers entirely into memory with `fs.readFileSync`. Always use Node.js `stream.pipeline` with Async Generators or properly handled `Transform` streams.
35. **Transaction-Bound PostgreSQL Advisory Locks**: Prefer `SELECT pg_advisory_xact_lock($1)` over fragile Redis mutexes for database mutations; advisory locks automatically release on `COMMIT` or `ROLLBACK` even if the process crashes.
36. **Cost-Weighted Abuse Prevention**: Enforce dynamic point costs on rate limiters so expensive operations (PDF generation, AI embeddings, large exports) consume proportionally higher quota than fast reads.
37. **Multi-Tenancy & Query-Level Isolation**: Protect against Insecure Direct Object Reference (IDOR) vulnerabilities by binding all database reads and writes to authenticated tenant IDs (`organizationId`) at the ORM/RLS level.
38. **Optimistic Concurrency Control (OCC) & Isolation Levels**: Prevent lost updates and race conditions on high-concurrency mutations using version tokens (`version Int @default(0)`) or PostgreSQL `SERIALIZABLE` transactions.

---

## 2. Directory Layout Reference Standards

Select the architectural layout that aligns with your service's domain complexity, team boundaries, and coupling profile:

### Reference Layout A: Layered Architecture (Domain-Grouped)
Organize single-domain services or microservices according to this structure:

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

### Architecture Selection Policy: Layered vs Modular Vertical Slices
- **Choose Reference Layout A (Layered Architecture)** when building focused microservices, applications with a single bounded context, low cross-domain friction, or where domain boundaries are already enforced at the independent deployment/service boundary.
- **Choose Reference Layout B (Modular Vertical Slices)** when building multi-domain platforms or modular monoliths where distinct sub-domains (e.g., Orders, Inventory, Identity, Billing) evolve at different cadences, have separate feature ownership, or require strict public module interfaces (`index.ts`) to eliminate leaky database coupling. Do not rely on arbitrary endpoint counts; base the decision on domain boundaries, change frequency, and team cohesion.

---

---

## 3. Service Criticality Tiering & Graceful Degradation

High-throughput systems must protect vital transactions (checkout, payments, auth) when under stress by gracefully shedding or degrading non-critical enrichment workloads (recommendations, personalization).

### The Criticality Hierarchy

| Tier | Name | Workloads | Overload Behavior |
| :--- | :--- | :--- | :--- |
| **Tier 0** | **Vital / Revenue** | Auth, Cart, Checkout, Payments, Order State | **Capacity Reserved & Highest Priority.** Never shed under normal or elevated load. Protected by aggressive shedding of lower tiers. Under catastrophic database degradation, gracefully degrades to queued/read-only mode. |
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
import { z } from 'zod';
import { requestContext, TraceContext } from '@/shared/classes/request-context';

//? W3C Trace Context schema enforcing RFC length and non-zero invariants
export const W3CTraceparentSchema = z
    .string()
    .trim()
    .length(55, 'W3C traceparent must be exactly 55 characters')
    .regex(/^00-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$/i, 'Invalid W3C traceparent structure')
    .superRefine((val, ctx) => {
        const parts = val.split('-');
        const traceId = parts[1]?.toLowerCase();
        const parentId = parts[2]?.toLowerCase();
        //! W3C Invariant: Trace ID and Parent ID cannot be all zeros
        if (traceId === '00000000000000000000000000000000') {
            ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'trace_id cannot be all zeros' });
        }
        if (parentId === '0000000000000000') {
            ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'parent_id cannot be all zeros' });
        }
    })
    .transform((val) => val.split('-')[1].toLowerCase());

//? Safe correlation ID schema preventing header injection and ReDoS attacks
export const SafeCorrelationIdSchema = z
    .string()
    .trim()
    .min(16, 'Correlation ID must be at least 16 characters')
    .max(64, 'Correlation ID must be at most 64 characters')
    .regex(/^[a-zA-Z0-9_-]+$/, 'Correlation ID must contain only alphanumeric, underscore, or hyphen');

function extractTraceId(req: Request): string {
    const rawTraceparent = req.header('traceparent');
    if (rawTraceparent) {
        const parseResult = W3CTraceparentSchema.safeParse(rawTraceparent);
        if (parseResult.success) {
            return parseResult.data;
        }
    }

    const rawCustomTraceId = req.header('x-trace-id');
    if (rawCustomTraceId) {
        const parseResult = SafeCorrelationIdSchema.safeParse(rawCustomTraceId);
        if (parseResult.success) {
            return parseResult.data;
        }
    }

    return uuidv4().replace(/-/g, '').toLowerCase();
}

export function tracingMiddleware(req: Request, res: Response, next: NextFunction) {
    const traceId = extractTraceId(req);
    const rawRequestId = req.header('x-request-id');
    const reqParse = rawRequestId ? SafeCorrelationIdSchema.safeParse(rawRequestId) : null;
    const requestId = reqParse?.success ? reqParse.data : uuidv4();
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
import { env } from '@/env';
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
    level: env.LOG_LEVEL || 'info',
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

## 5. Semantic Commenting, Code Cleanliness & Readability Standards

### A. The Golden Rule of Comments: Explain WHY, Never WHAT
Code tells you *how* and *what*; comments must explain **why**.
- **Never** state the obvious: `// get user by id: const user = await getUser(id);` is noise and tech debt.
- **Always** document rationale, mathematical justification, non-obvious algorithms, vendor workarounds, or race condition mitigations.

### B. Semantic Commenting Taxonomy (`Better Comments` Style)
Use an intentional, color-coded visual commenting grammar across all files to make code self-documenting and immediately scannable:

| Tag | Name | Color | Purpose & Usage | Real Example |
| :--- | :--- | :--- | :--- | :--- |
| `//?` | **Information & Rationale** | 🔵 Blue | Explains architectural intent, math formulas, or non-obvious algorithms. | `//? Each GPT query is counted as 2 interactions because it includes prompt and bot response` |
| `//!` | **Critical Hazards & Invariants** | 🔴 Red | Warns of breaking changes, database risks, or third-party quirks. | `//! Note: File must be uploaded with contentType, else WhatsApp rejects application/octet-stream` |
| `//&` | **Domain Boundaries** | 🟣 Purple | Visual separators for sub-modules, modules, or major routing groups. | `//& Customer Escalation & Ticket SLAs 🎫` |
| `//*` | **Business Rule Constraints** | 🟢 Green | Specific business rules, legal compliance, or time-window limitations. | `//* Not sending followup messages outside 9 AM to 9 PM contact local time` |
| `/** ... */` | **JSDoc Rationale** | White | Multi-line documentation on engineering decisions and interface contracts. | Explain why PNG is used over SVG in email, or why custom Crockford alphabet was chosen |

### C. Guard Clauses & Early Returns (Kill the Arrow Anti-Pattern)
Never nest code 4 levels deep in `if/else` ladders. Validate pre-conditions early and return immediately. Keep the "happy path" flat against the left margin:

```typescript
// ✅ Clean, flat guard clauses
export async function processPayment(req: Request, res: Response) {
    if (!req.currentOrganizationUser) {
        return sendError(res, 'Unauthorized', 401);
    }
    if (!req.body.items?.length) {
        return sendError(res, 'No items provided', 400);
    }
    const isAvailable = await checkStock(req.body.items);
    if (!isAvailable) {
        return sendError(res, 'Inventory out of stock', 409);
    }

    // Happy path is flat and easily readable:
    const receipt = await orderOrchestrator.checkout(req.body);
    return sendResponse(res, receipt, 'Payment processed', 201);
}
```

### D. Single Level of Abstraction Principle (SLAP)
High-level orchestrators should read like a table of contents, delegating low-level operations (raw SQL strings, S3 uploads, multi-part email construction) to dedicated helper functions.

### E. Controller Size Heuristic & Zero Zombie Code
- **Review heuristic (~65 lines)**: HTTP controllers should parse, validate, call an orchestrator, and return an envelope. Exceeding roughly 65 lines is a signal to inspect responsibility boundaries—not an automatic violation or hard cap.
- **Zero Zombie Code**: Never commit commented-out code blocks (`// const oldQuery = ...`). Trust Git history.

### F. Boolean Naming Conventions
Always use active predicate prefixes: `isValid`, `hasPermission`, `canRetry`, `shouldEscalate`, `isGuest`. Never use bare nouns (`valid`, `permission`).

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

### Exponential Backoff & AWS Full Jitter (`withRetry`)
```typescript
// src/utils/retry.ts
import { logger } from '@/shared/logger';

export interface RetryBudget {
    canRetry(): boolean;
    recordAttempt(isRetry: boolean): void;
}

export interface RetryOptions {
    readonly retries?: number;
    readonly minDelayMs?: number;
    readonly maxDelayMs?: number;
    readonly factor?: number;
    readonly jitter?: boolean;                    //? When true, applies AWS Full Jitter to eliminate thundering herds
    readonly isIdempotent?: boolean;              //! Invariant: Defaults to FALSE. Non-idempotent operations will NOT retry dropped responses, 429, 502, 503, or 504!
    readonly isDatabaseOnlyTransaction?: boolean; //? When true, affirms operation has zero external side-effects so DB deadlocks (40P01/40001/P2034) are safe to retry even if isIdempotent is false
    readonly retryBudget?: RetryBudget;           // Local token-bucket retry governor
    readonly shouldRetry?: (error: unknown, attempt: number, isIdempotent: boolean) => boolean;
    readonly onRetry?: (error: unknown, attempt: number, delayMs: number) => void;
}

export function extractRetryAfterMs(error: unknown): number | null {
    if (!error || typeof error !== 'object' || !('response' in error)) return null;
    const res = (error as { response?: { headers?: Record<string, string | string[]> } }).response;
    const header = res?.headers?.['retry-after'];
    if (!header) return null;
    const val = Array.isArray(header) ? header[0] : header;
    const seconds = Number(val);
    if (!Number.isNaN(seconds) && seconds > 0) return seconds * 1000;
    const dateMs = Date.parse(val);
    return !Number.isNaN(dateMs) && dateMs > Date.now() ? dateMs - Date.now() : null;
}

export function isTransientError(
    error: unknown,
    attempt: number,
    isIdempotent = false,
    isDatabaseOnlyTransaction = false
): boolean {
    if (!error || typeof error !== 'object') return false;

    // 1. Database & Socket Error Codes
    if ('code' in error) {
        const code = (error as { code?: string }).code;

        // Database deadlocks/serialization conflicts: Safe only if idempotent OR isolated DB-only transaction
        const dbRollbackCodes = new Set(['40P01', '40001', 'P2034']);
        if (code && dbRollbackCodes.has(code)) return isIdempotent || isDatabaseOnlyTransaction;

        // Pre-query failures (query never reached or began execution on the database engine)
        const preQueryCodes = new Set(['P1001', 'P2024', 'ECONNREFUSED', 'ENOTFOUND']);
        if (code && preQueryCodes.has(code)) return true;

        // Mid-flight drops & timeouts (Execution outcome uncertain; server may have committed!)
        const uncertainCodes = new Set([
            'P1002', 'P1017', 'ECONNRESET', 'ETIMEDOUT', 'ECONNABORTED', 'EAI_AGAIN', 'EPIPE',
            'UND_ERR_SOCKET', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT',
        ]);
        if (code && uncertainCodes.has(code)) return isIdempotent;
    }

    // 2. HTTP Status Codes
    if ('response' in error && error.response && typeof error.response === 'object') {
        const status = (error.response as { status?: number }).status;
        if (status === 429) return isIdempotent; // RFC 6585 permits upstream work prior to rate limit; retry only if idempotent
        if (status === 503) return isIdempotent; // Origin may have partially executed; retry only if idempotent
        if (status === 502 || status === 504) return isIdempotent; // Origin may have executed; retry only if idempotent
        if (status === 500 && isIdempotent && attempt === 1) return true;
        if (status !== undefined && status >= 400 && status < 500) return false;
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
        isIdempotent = false,
        isDatabaseOnlyTransaction = false,
        retryBudget,
        shouldRetry,
        onRetry,
    } = options;

    let attempt = 0;

    while (true) {
        try {
            retryBudget?.recordAttempt(attempt > 0);
            return await operation();
        } catch (error) {
            attempt++;

            // 1. Mandatory Safety Check: Base transient invariants cannot be bypassed by custom policies
            const isSafe = isTransientError(error, attempt, isIdempotent, isDatabaseOnlyTransaction);
            if (attempt > retries || !isSafe) {
                throw error;
            }

            // Custom policy can further restrict retries, but cannot override mandatory safety
            if (shouldRetry && !shouldRetry(error, attempt, isIdempotent)) {
                throw error;
            }

            // 2. Check retry budget capacity if configured
            if (retryBudget && !retryBudget.canRetry()) {
                logger.warn('[Retry] Retry budget exhausted; failing fast to prevent cascading failure.');
                throw new Error('[RetryBudgetExhausted] Downstream service degraded. Retry quota depleted.', {
                    cause: error,
                });
            }

            // 3. Bounded exponential ceiling
            const ceiling = Math.min(maxDelayMs, minDelayMs * Math.pow(factor, attempt - 1));

            // 4. AWS Full Jitter: Uniform random distribution between 0 and ceiling
            let delay = jitter ? Math.random() * ceiling : ceiling;

            // 5. Honor upstream Retry-After (fail fast if wait exceeds maxDelayMs)
            const retryAfterMs = extractRetryAfterMs(error);
            if (retryAfterMs !== null) {
                if (retryAfterMs > maxDelayMs) {
                    logger.warn('[Retry] Upstream Retry-After exceeds maxDelayMs; aborting retries.', {
                        retryAfterMs,
                        maxDelayMs,
                    });
                    throw error;
                }
                const maxAllowedJitter = Math.max(0, maxDelayMs - retryAfterMs);
                const jitterDelta = jitter ? Math.random() * Math.min(1000, maxAllowedJitter, retryAfterMs * 0.1) : 0;
                delay = retryAfterMs + jitterDelta;
            }

            if (onRetry) {
                onRetry(error, attempt, delay);
            } else {
                logger.warn(`[Retry] Attempt ${attempt}/${retries} failed. Retrying in ${Math.round(delay)}ms...`, {
                    attempt,
                    retries,
                    delayMs: Math.round(delay),
                    jitter,
                    isIdempotent,
                });
            }

            await new Promise((resolve) => setTimeout(resolve, delay));
        }
    }
}
```

### Advanced Failure Recovery: Token-Bucket Retry Budget & Full Jitter
To prevent cascading retry storms where layered services multiply retries ($3 \times 3 \times 3 = 27\times$ load):
1. **Local Token-Bucket Retry Governor**: Use a local token-bucket governor with a target retry ratio (e.g. 10%) and burst capacity to limit retry volume per instance. For fleet-wide enforcement across hundreds of nodes, back the governor with an atomic Redis script or enforce budgets at the service mesh layer (Envoy/Linkerd).
2. **Full Jitter**: Apply AWS Full Jitter (`random(0, min(cap, base * 2^attempt))`) so retrying clients do not synchronize in periodic thundering-herd waves.
3. See `examples/resilience/retry-budget.ts` and `examples/resilience/retry.ts` for the complete standalone reference implementations.

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
In modern Node.js (v16+), `req.on('close')` fires when the request payload finishes uploading, NOT when the client disconnects! Listening to `req.on('close')` prematurely aborts valid transactions.
**Correct standard**: Listen to `res.on('close')` and verify `!res.writableEnded`.

```typescript
// src/middlewares/cancellation.ts
import { Request, Response, NextFunction } from 'express';

export function cancellationMiddleware(req: Request, res: Response, next: NextFunction) {
    const ac = new AbortController();

    res.on('close', () => {
        //? Abort downstream operations only if the response did not complete cleanly
        if (!res.writableEnded) {
            ac.abort(new Error('Client disconnected before response completed'));
        }
    });

    // Strictly typed via ambient Express.Locals augmentation (zero `as any`)
    res.locals.abortSignal = ac.signal;
    next();
}
```
*Note: `AbortSignal` only cancels downstream HTTP clients (`fetch`, `axios`) and database drivers that explicitly consume `res.locals.abortSignal`. It does not magically abort uninstrumented SQL operations.*

---

## 7. Advanced Enterprise Patterns for Scalability

### Pattern A: Two-Tier Idempotency Architecture
Idempotency prevents duplicate business mutations within the defined idempotency boundary, while external event delivery and consumption require their own duplicate-handling guarantees (such as the Transactional Outbox pattern). Backends must separate rapid transport caching from mission-critical financial mutations:

1. **Fast Cache Acceleration (Redis)**: Rapid deduplication on high-throughput mutation endpoints. Must enforce:
   - **Operation Scope**: `idempotency:<orgId>:<userId>:<method>:<routePath>:<idempotencyKey>` prevents cross-tenant or cross-endpoint key collisions.
   - **Full Fingerprint**: Recursive canonical SHA-256 hash across HTTP method, route, params, query, and payload.
   - **Ownership & Best-Effort Heartbeat**: Acquire key with a random UUID `ownerToken`. While execution is in-flight, a periodic heartbeat extends the short pending lease (`pendingTtlSeconds = 60`). If heartbeat renewal encounters repeated network failures, the lease is marked lost and fails closed (503). *Note: Redis heartbeats provide best-effort lease extension rather than a strict distributed fencing token.*
   - **Comprehensive Response Interception**: Intercepts `res.json`, `res.send`, and `res.end` (supporting 204 No Content), with terminal lifecycle listeners (`finish`, `close`) guaranteeing heartbeat cleanup.
   - **Atomic Lua Completion & Cleanup**: Completion is committed via Lua only if `ownerToken` matches. Failed requests release their lease via compare-and-delete Lua only if `ownerToken` matches.
   - **Fail-Closed Persistence**: If completed state cannot be persisted to Redis, return 503 so clients do not proceed with untracked side-effects.
   - **Canonical Implementation**: See `examples/resilience/idempotency.ts` (`cacheIdempotencyMiddleware`).

2. **Durable Financial Standard (PostgreSQL Interactive Transactions)**: Authoritative standard for ledger balance changes, payment charges, and order checkouts:
   - **Transactional by Construction**: `executeWithDbIdempotency(prisma, options, operation)` accepts the root Prisma client and creates an interactive `$transaction` internally. The generic `operation(tx)` callback retains full Prisma model delegates (e.g. `tx.order.create()`).
   - **Atomic Database-Clock Expiration & Reclamation**: Checks `expires_at <= clock_timestamp()` inside PostgreSQL. If an existing record is expired, it is atomically reclaimed and reset to PENDING with the new fingerprint, eliminating reliance on external cleanup crons or server clock drift.
   - **Safe Replay**: Evaluates `typeof http_code === 'number'` to correctly replay 204 No Content, null, 0, or empty string responses.
   - **Allowlisted Response Headers**: Replays safe metadata (`location`, `content-type`, `x-request-id`) while strictly excluding sensitive headers (`set-cookie`).
   - **Outbox Invariant**: Never execute non-transactional external side-effects (e.g. Stripe card charges) directly inside `operation(tx)`; use the Transactional Outbox pattern.

```typescript
// Usage in Controllers & Routes (Canonical implementation: examples/resilience/idempotency.ts)
import { cacheIdempotencyMiddleware, executeWithDbIdempotency } from '@/shared/resilience/idempotency';

// 1. Redis Cache Middleware (for fast deduplication on API gateway routes)
router.post(
    '/orders/instant',
    cacheIdempotencyMiddleware(redisClient, { pendingTtlSeconds: 60, completedTtlSeconds: 86400 }),
    createInstantOrderAction
);

// 2. Authoritative PostgreSQL Durable Idempotency (for financial mutations)
export async function checkoutOrderAction(req: Request, res: Response) {
    const result = await executeWithDbIdempotency(prisma, {
        organizationId: req.currentOrganizationUser.organizationId,
        scope: 'orders.checkout',
        idempotencyKey: req.headers['idempotency-key'] as string,
        requestFingerprint: computeRequestFingerprint(req),
        ttlMinutes: 1440,
    }, async (tx) => {
        // All business mutations MUST use tx to guarantee ACID atomicity
        const order = await tx.order.create({ data: req.body });
        return { httpCode: 201, body: order, headers: { location: `/orders/${order.id}` } };
    });

    if (result.headers) {
        Object.entries(result.headers).forEach(([k, v]) => res.setHeader(k, v));
    }
    if (result.isReplay) {
        res.setHeader('X-Cache-Lookup', 'HIT - Idempotent Replay');
    }
    return res.status(result.httpCode).json(result.data);
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

    public register(httpServer: Server, drainTimeoutMs = 15000) {
        const shutdown = async (signal: string) => {
            if (this.isShuttingDown) return;
            this.isShuttingDown = true;

            logger.info(`Received ${signal}. Starting coordinated graceful shutdown...`);

            // Emergency safety timer
            const forceExitTimer = setTimeout(() => {
                logger.error('Shutdown exceeded timeout. Forcing process exit.');
                process.exit(1);
            }, drainTimeoutMs);
            forceExitTimer.unref();

            try {
                // Step 1: Pause background queue consumers (preventing new job pickup)
                await mqProcesses.pause();
                logger.info('MQ queue consumers paused.');

                // Step 2: Drain in-flight HTTP requests (PROMISE-AWAITED)
                logger.info('Draining in-flight HTTP requests...');
                await new Promise<void>((resolve, reject) => {
                    httpServer.close((err) => (err ? reject(err) : resolve()));
                });
                logger.info('HTTP server closed. All in-flight requests drained.');

                // Step 3: Complete or abort background workers
                await mqProcesses.shutdown();
                logger.info('MQ workers closed.');

                // Step 4: Disconnect Database connection pool (AFTER HTTP & workers are idle!)
                const prisma = getPrisma();
                await prisma.$disconnect();
                logger.info('Database pool closed.');

                // Step 5: Disconnect Redis cache and pub/sub
                if (global._redis_connection) await global._redis_connection.quit();
                logger.info('Redis connections closed.');

                logger.info('Graceful shutdown resource cleanup completed successfully.');

                // Step 6: Flush logger transports & pending telemetry buffers while emergency timer is still active!
                if (logger.flush) {
                    try {
                        await logger.flush();
                    } catch {
                        // Suppress flush error on shutdown
                    }
                }

                // Only clear emergency fallback timer once ALL cleanup and telemetry flushing has completed
                clearTimeout(forceExitTimer);

                // Set exitCode and allow event loop to drain naturally (zero abruptly dropped logs)
                process.exitCode = 0;
            } catch (err) {
                logger.error('Error during shutdown:', err);
                if (logger.flush) {
                    try {
                        await logger.flush();
                    } catch {}
                }
                clearTimeout(forceExitTimer);
                process.exit(1);
            }
        };

        process.on('SIGTERM', () => void shutdown('SIGTERM'));
        process.on('SIGINT', () => void shutdown('SIGINT'));
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

## 9. Advanced Domain Modeling & Extreme Type Safety Standards

### A. "Parse, Don't Validate" & Branded Types
Never pass raw primitives (`string`, `number`) through deep service layers after performing a boolean check. Parse inputs at system boundaries into branded types that cannot exist in an invalid state:

```typescript
// src/shared/types/branded.ts
declare const __brand: unique symbol;
export type Brand<K, T> = K & { readonly [__brand]: T };

export type UserId = Brand<number, 'UserId'>;
export type OrderId = Brand<number, 'OrderId'>;
export type Email = Brand<string, 'Email'>;

//? Boundary validation uses Zod's RFC-compliant email parser
const EmailSchema = z.string().trim().email();

export function parseEmail(raw: unknown): Result<Email, 'INVALID_EMAIL_FORMAT'> {
    const parsed = EmailSchema.safeParse(raw);
    if (!parsed.success) return fail('INVALID_EMAIL_FORMAT');
    return ok(parsed.data.toLowerCase() as Email);
}
```

### B. Make Illegal States Unrepresentable
Never model multi-phase domain objects as a single interface with dozens of optional properties (`paidAt?`, `refundedAt?`, `cancelReason?`). Model them as **State-Discriminated Unions**:

```typescript
export interface BaseOrder {
    readonly id: string;
    readonly createdAt: Date;
    readonly totalCents: number;
}

export type PendingOrder = BaseOrder & {
    readonly status: 'PENDING';
    readonly paymentDueAt: Date;
};

export type PaidOrder = BaseOrder & {
    readonly status: 'PAID';
    readonly paidAt: Date;
    readonly transactionId: string;
};

export type CancelledOrder = BaseOrder & {
    readonly status: 'CANCELLED';
    readonly cancelledAt: Date;
    readonly cancelReason: string;
};

export type Order = PendingOrder | PaidOrder | CancelledOrder;
```

### C. Smart Constructors & Value Objects
Primitives like `number` for currency or `Date` for intervals allow invalid states (e.g. negative prices, float rounding bugs). Use private constructors and static `.create(...)` factory methods:

```typescript
// See examples/types/smart-constructors.ts
export class Money {
    private constructor(
        public readonly amountCents: number,
        public readonly currency: 'USD' | 'EUR' | 'GBP' | 'INR'
    ) {}

    public static create(amountCents: number, currency: 'USD' | 'EUR' | 'GBP' | 'INR'): Result<Money, string> {
        if (!Number.isInteger(amountCents)) return fail('Amount must be integer cents');
        if (amountCents < 0) return fail('Amount cannot be negative');
        return ok(new Money(amountCents, currency));
    }

    public add(other: Money): Result<Money, string> {
        if (this.currency !== other.currency) return fail(`Currency mismatch`);
        return ok(new Money(this.amountCents + other.amountCents, this.currency));
    }
}
```

### D. Exhaustive Pattern Matching with `assertNever`
Always include `assertNever` in switch default blocks so adding a new state or event variant causes a compile-time failure:

```typescript
export function assertNever(value: never, message = 'Unhandled union member'): never {
    throw new Error(`${message}: ${JSON.stringify(value)}`);
}

export function handleOrderState(order: Order) {
    switch (order.status) {
        case 'PENDING': return handlePending(order);
        case 'PAID': return handlePaid(order);
        case 'CANCELLED': return handleCancelled(order);
        default:
            return assertNever(order); // Compiler fails if any variant is unhandled!
    }
}
```

### E. Precise Prisma Type Extraction (Zero `as any`)
Use `satisfies Prisma.<Model>Select` and `Prisma.<Model>GetPayload` to extract the exact return types of database queries without type assertions:

```typescript
// See examples/types/prisma-projections.ts
export const userWithOrgSelect = {
    id: true,
    email: true,
    firstName: true,
    organization: { select: { id: true, codeName: true, timezone: true } },
} as const satisfies Prisma.OrganizationUserSelect;

export type UserWithOrgDTO = Prisma.OrganizationUserGetPayload<{ select: typeof userWithOrgSelect }>;
```

### F. The Result Pattern for Predictable Business Failures
Throwing exceptions for expected domain states (`CouponExpired`, `InsufficientFunds`) breaks type safety and degrades V8 runtime performance. Return typed Result objects:

```typescript
// See examples/types/result.ts
export type Result<T, E = Error> =
    | { readonly ok: true; readonly data: T }
    | { readonly ok: false; readonly error: E };

export const ok = <T>(data: T): Result<T, never> => ({ ok: true, data });
export const fail = <E>(error: E): Result<never, E> => ({ ok: false, error });
```

### G. The Single Options Object Rule
Never declare functions with multiple positional parameters of the same primitive type (`fn(id1, id2, str1, bool)`). Wrap all arguments in a single `readonly options: { ... }` object:

```typescript
export interface TransferTicketOptions {
    readonly ticketId: number;
    readonly targetUserId: number;
    readonly departmentId: number;
    readonly notifyCustomer?: boolean;
}

export async function transferTicket(options: TransferTicketOptions): Promise<Ticket> {
    const { ticketId, targetUserId, departmentId, notifyCustomer = false } = options;
    // ...
}
```

---

## 10. Separation of Concerns: Code, Secrets & Database State

Never embed business parameters, tenant permissions, or pricing caps directly in application code, while strictly maintaining security and invariant boundaries:

1. **Immutable Invariants & Domain Rules (Code in Git)**: Business state-machine transitions, domain invariants, cryptographic routines, and input validation schemas belong in version-controlled TypeScript code (`src/modules/*/`). Core security logic must not be bypassed via unvetted database mutations.
2. **Master Secrets & Infrastructure Credentials (KMS / Secret Vaults)**: Database credentials, master encryption keys, and third-party platform secrets must live in environment managers / AWS KMS / GCP Secret Manager and validate via `@/env` at boot. Master infrastructure keys must **never** be stored in application database rows.
3. **Dynamic Business State & Tenant Settings (Database as Source of Truth)**:
   - **User Permissions**: Dynamic RBAC evaluated against `ResourceAccess` and `ModuleResource` tables.
   - **Feature Access & Quotas**: Computed via `FeatureAccess.check(subscription, 'feature_key', count)` against active `SubscriptionFeature` rows.
   - **Notification Copy & Templates**: Stored in `NotificationTemplate` database rows so organizations can customize copy, branding, and placeholders without code changes.
   - **Tenant-Level Integrations**: Stored per organization in encrypted database rows (`WhatsappIntegration`, `MailSender`, `ShopifySession`) using tenant-scoped encryption.

---

## 11. Production-Safe Code & Security Patterns

### A. Timing-Safe Cryptographic Comparison
Never compare HMAC signatures or tokens with `===`. String comparison exits on the first mismatched byte, creating timing side-channel vulnerabilities:

```typescript
// See examples/safety/timing-safe.ts
import crypto from 'node:crypto';

export function verifySignature(received: string, expected: string): boolean {
    const a = Buffer.from(received, 'utf8');
    const b = Buffer.from(expected, 'utf8');
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
}
```

### B. Backpressured Stream Pipelines (OOM Prevention)
Never load large CSVs, audio files, or PDF reports into memory via `fs.readFileSync` or accumulators (`records.push(row)`). An unbounded 50MB file expands in V8 memory and triggers `JavaScript heap out of memory`. Use `stream.pipeline` with explicit line framing to handle arbitrary chunk boundaries and multi-byte UTF-8 characters:

```typescript
// See examples/safety/streaming-pipeline.ts
import { pipeline } from 'node:stream/promises';
import { StringDecoder } from 'node:string_decoder';
import fs from 'node:fs';

async function* lineFramingStage(source: AsyncIterable<Buffer>) {
    const decoder = new StringDecoder('utf8');
    let remainder = '';
    for await (const chunk of source) {
        // Preserves incomplete multi-byte UTF-8 character bytes across stream chunks
        remainder += decoder.write(chunk);
        const lines = remainder.split(/\r?\n/);
        remainder = lines.pop() ?? ''; // Buffer incomplete trailing line fragment
        for (const line of lines) {
            const transformed = await processLine(line);
            yield Buffer.from(transformed + '\n', 'utf8');
        }
    }
    remainder += decoder.end();
    if (remainder.length > 0) {
        yield Buffer.from((await processLine(remainder)) + '\n', 'utf8');
    }
}

// Automatically manages backpressure and safely closes file handles on error
await pipeline(
    fs.createReadStream(inputFilePath),
    lineFramingStage,
    fs.createWriteStream(outputFilePath)
);
```

### C. Transaction-Bound PostgreSQL Advisory Locks
Unlike Redis distributed locks (which risk becoming orphaned if a container crashes before `redis.del()`), PostgreSQL advisory locks bind to the ACID transaction lifecycle. They **automatically release** on `COMMIT` or `ROLLBACK`:

```typescript
// See examples/safety/advisory-lock.ts
await prisma.$transaction(async (tx) => {
    // 1. Set transaction-local timeout via set_config (prepared statements reject dynamic SET LOCAL)
    await tx.$queryRaw`SELECT set_config('lock_timeout', '5000ms', TRUE)`;

    // 2. Safe 64-bit integer conversion (rejects unsafe floats; 64-bit SHA-256 substantially reduces collision probability)
    const safeLockId = toSafeLockId(entityId); // or hashStringToLockId(semanticKey)
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(${safeLockId})`;

    await performSensitiveMutation(tx);
});
```

### D. Cost-Weighted Abuse Prevention
Generic rate limiters (e.g. 100 req/min) leave backends vulnerable to CPU exhaustion if an attacker spams expensive routes (PDF exports, vector embeddings). Charge higher points per route using atomic Lua scripts:

```typescript
// See examples/safety/cost-rate-limiter.ts
const limiter = createCostRateLimiter(redis);

router.post(
    '/export/pdf',
    limiter({ windowSeconds: 60, maxPoints: 100, costCalculator: () => 25 }),
    exportPdfAction
);
```

---

## 12. Multi-Tenancy & Transactional Concurrency Control

### Multi-Tenancy & Query Isolation (Preventing IDOR)
Every query touching tenant-scoped tables must enforce tenant isolation at the infrastructure level. Pair application-level scoping with PostgreSQL Row-Level Security (RLS) using PERMISSIVE policies and transaction-local `set_config`:

```sql
-- PostgreSQL RLS requires at least one PERMISSIVE policy to grant tenant access
ALTER TABLE orders ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation_policy ON orders
  FOR ALL
  TO app_user
  USING (organization_id = NULLIF(current_setting('app.current_org_id', true), '')::integer)
  WITH CHECK (organization_id = NULLIF(current_setting('app.current_org_id', true), '')::integer);
```

```typescript
// See references/12-multi-tenancy-and-transactional-concurrency.md
export async function executeTenantTransaction<T>(
    prisma: PrismaClient,
    organizationId: number,
    task: (tx: Prisma.TransactionClient) => Promise<T>
): Promise<T> {
    return prisma.$transaction(async (tx) => {
        // Third argument (is_local = TRUE) binds setting strictly to this transaction, preventing pool leakage
        // Prisma Rule: SELECT set_config returns a row, so $queryRaw must be used (not $executeRaw)
        await tx.$queryRaw`SELECT set_config('app.current_org_id', ${organizationId.toString()}, TRUE)`;
        return await task(tx);
    });
}
```

### Optimistic Concurrency Control (OCC)
Prevent lost updates on inventory counts, wallet balances, and state machine transitions by maintaining a `version Int @default(0)` token, **always including `organizationId`** to maintain tenant isolation:

```typescript
const updated = await prisma.order.updateMany({
    where: {
        id: orderId,
        organizationId: currentTenantId, //! Mandatory: Never omit tenant boundary in OCC queries
        version: currentVersion,          // Fails if another concurrent mutation incremented version
    },
    data: {
        status: 'PAID',
        version: { increment: 1 },
    },
});

if (updated.count === 0) {
    throw new ConcurrencyConflictError('Order was concurrently modified or does not belong to tenant.');
}
```

---

## 13. Agent Checklist & Anti-Patterns to Avoid

### ✅ DOs:
- **Do** wrap every asynchronous controller in `try { ... } catch (error) { next(error); }`.
- **Do** classify endpoints into Service Criticality Tiers (P0 to P3).
- **Do** shed or degrade Tier-2 (recommendations, personalization) under high load to protect Tier-0 (checkout).
- **Do** enforce strict query timeouts (150ms) on Tier-2 recommendation lookups.
- **Do** use `AsyncLocalStorage` to trace requests end-to-end through controllers, loggers, and BullMQ queues.
- **Do** support `Idempotency-Key` headers on state-modifying operations (payments, tickets, orders).
- **Do** use the Transactional Outbox pattern when mutating database state that requires background events.
- **Do** clean up temporary resources (files, buffers, locks) inside `finally` blocks.
- **Do** retry transient errors (network timeouts, HTTP 429/502/503/504, DB deadlocks) using `withRetry` with AWS Full Jitter, ensuring non-idempotent operations do NOT retry mid-flight network drops or unverified rate limits.
- **Do** honor `Retry-After` headers on rate limits before calculating backoff delays, applying jitter smoothing.
- **Do** wrap flaky third-party integrations with a Circuit Breaker.
- **Do** register graceful shutdown handlers (`SIGTERM`/`SIGINT`) to drain connections, flush logs, and set `process.exitCode = 0` rather than calling `process.exit(0)`.
- **Do** create a single file for each controller endpoint (`src/controllers/<domain>/<action>.ts`).
- **Do** declare validation schemas (Zod or Joi) right at the top of the controller file.
- **Do** use semantic comment tags (`//?`, `//!`, `//&`, `//*`) to document rationale and constraints.
- **Do** verify feature limits and permissions dynamically from database records (zero hardcoded rules).
- **Do** use `sendResponse<T>`, `sendArrayResponse<T>`, and `sendError` for all HTTP responses.
- **Do** organize bounded contexts into Modular Vertical Slices (`src/modules/<domain>/`) for high cohesion and easy maintenance.
- **Do** implement Tail-Based Sampling to guarantee 100% trace retention for errors and slow-request latency outliers.
- **Do** enforce a Token-Bucket Retry Budget (max 10% retries) to avoid retry storms during downstream degradation.
- **Do** use Full Jitter for exponential backoff to avoid synchronized client retry waves.
- **Do** quarantine poison pill payloads into a Dead Letter Queue (DLQ) with metadata.
- **Do** use Singleflight promise coalescing to prevent cache stampedes on hot keys.
- **Do** propagate request cancellations via `res.on('close')` (when `!res.writableEnded`) to abort downstream work when clients disconnect.
- **Do** parse raw inputs into Branded Types (`Email`, `UserId`) at system boundaries ("Parse, Don't Validate").
- **Do** model domain states as Discriminated Unions so impossible states cannot compile.
- **Do** wrap function arguments in a single `readonly options: { ... }` object to prevent parameter swapping bugs.
- **Do** use `satisfies Prisma.Select` and `Prisma.GetPayload` to extract database DTOs with zero `as any`.
- **Do** return `Result<T, DomainError>` for predictable business failures instead of throwing exceptions.
- **Do** use `assertNever(x)` in `default:` branches of switch statements for exhaustive compile-time verification.
- **Do** explain *why* in comments, never *what* (no obvious restatements of code).
- **Do** use guard clauses with early returns to keep the happy path completely flat against the left margin.
- **Do** keep HTTP controllers focused on transport concerns; use roughly 65 lines as an advisory review signal and delegate domain logic to orchestrators.
- **Do** prefix boolean variables with active predicates (`isValid`, `hasPermission`, `canRetry`).
- **Do** use `crypto.timingSafeEqual` for all webhook signature and token comparisons.
- **Do** process large files and CSVs using `stream.pipeline` and Async Generators to prevent heap OOM crashes.
- **Do** use PostgreSQL transaction-level advisory locks (`pg_advisory_xact_lock`) with `set_config('lock_timeout', ..., TRUE)`.
- **Do** assign dynamic point costs to rate limiters using atomic Lua scripts on CPU-heavy endpoints (PDF, AI, exports).
- **Do** scope all multi-tenant queries to `organizationId` at the ORM and RLS level (using PERMISSIVE policies) to eliminate IDOR risks.
- **Do** include `organizationId` in Optimistic Concurrency Control (`version`) updates to prevent cross-tenant mutations.

### ❌ DON'Ts:
- **Never** allow a Tier-0 checkout endpoint to synchronously await a Tier-2 recommendation or AI call.
- **Never** query another module's database tables directly in a modular architecture (use public module interfaces).
- **Never** perform dual writes (e.g. updating Postgres then publishing directly to Kafka/Rabbit/BullMQ without an outbox).
- **Never** retry non-idempotent mutations on uncertain responses (HTTP 429, 502, 503, 504, `ECONNRESET`, `ETIMEDOUT`) without verified idempotency protection.
- **Never** retry without jitter or beyond the 10% retry budget.
- **Never** use `SET LOCAL lock_timeout` in prepared statements (use `SELECT set_config('lock_timeout', ..., TRUE)`).
- **Never** omit `organizationId` from Optimistic Concurrency Control (`version`) updates.
- **Never** rely on restrictive-only RLS policies without a permissive base policy (blocks all tenant rows).
- **Never** terminate graceful shutdown with raw `process.exit(0)` before flushing logger transports.
- **Never** rely purely on random head-based sampling if you need visibility into rare production errors.
- **Never** compare cryptographic signatures or tokens using standard `===` (vulnerable to timing attacks).
- **Never** read entire large files into memory with `fs.readFileSync` or accumulate unbounded arrays.
- **Never** rely on Redis distributed locks for operations that require ACID rollback guarantees.
- **Never** write redundant comments that state the obvious (`// get user by id: await getUserById()`).
- **Never** nest logic 3+ levels deep inside `if/else` ladders (arrow code anti-pattern).
- **Never** commit commented-out zombie code (`// const oldLogic = ...`). Rely on Git history.
- **Don't** let business workflows or persistence logic accumulate in controllers; review unusually long handlers and refactor when it improves clarity.
- **Never** use positional arguments with multiple primitives of the same type (`fn(id1, id2, str1, str2)`).
- **Never** throw exceptions for ordinary expected domain states (e.g. `CouponExpired`, `InsufficientBalance`).
- **Never** use type assertions (`as unknown as TargetType`) to bypass Prisma or TypeScript type checking.
- **Never** create "kitchen-sink" interfaces with dozens of optional fields (`paidAt?`, `refundedAt?`) when state is mutually exclusive.
- **Never** leave floating promises un-awaited or without a `.catch()` handler.
- **Never** swallow errors silently (`catch (e) {}`) without logging or proper handling.
- **Never** retry permanent client errors (HTTP 400, 401, 403, 404, 422).
- **Never** hardcode tenant quotas, feature flags, or permission rules in code. Query the DB.
- **Never** use `(req as any)` to access user or session data. Update `src/typings/index.d.ts` instead.
- **Never** return raw objects like `res.json({ foo: 'bar' })` or ad-hoc error formats.
- **Never** perform business logic directly inside Express route files (`.routes.ts`).
- **Never** read `process.env.*` directly throughout the codebase. Import from `@/env`.
- **Never** use positional arguments with multiple primitives of the same type (`fn(id1, id2, str1, str2)`).
- **Never** throw exceptions for ordinary expected domain states (e.g. `CouponExpired`, `InsufficientBalance`).
- **Never** use type assertions (`as unknown as TargetType`) to bypass Prisma or TypeScript type checking.
- **Never** create "kitchen-sink" interfaces with dozens of optional fields (`paidAt?`, `refundedAt?`) when state is mutually exclusive.
- **Never** leave floating promises un-awaited or without a `.catch()` handler.
- **Never** swallow errors silently (`catch (e) {}`) without logging or proper handling.
- **Never** retry permanent client errors (HTTP 400, 401, 403, 404, 422).
- **Never** hardcode tenant quotas, feature flags, or permission rules in code. Query the DB.
- **Never** use `(req as any)` to access user or session data. Update `src/typings/index.d.ts` instead.
- **Never** return raw objects like `res.json({ foo: 'bar' })` or ad-hoc error formats.
- **Never** perform business logic directly inside Express route files (`.routes.ts`).
- **Never** read `process.env.*` directly throughout the codebase. Import from `@/env`.

### ❌ DON'Ts:
- **Never** allow a Tier-0 checkout endpoint to synchronously await a Tier-2 recommendation or AI call.
- **Never** query another module's database tables directly in a modular architecture (use public module interfaces).
- **Never** perform dual writes (e.g. updating Postgres then publishing directly to Kafka/Rabbit/BullMQ without an outbox).
- **Never** retry without an Idempotency-Key on non-idempotent mutations.
- **Never** retry without jitter or beyond the 10% retry budget.
- **Never** rely purely on random head-based sampling if you need visibility into rare production errors.
- **Never** compare cryptographic signatures or tokens using standard `===` (vulnerable to timing attacks).
- **Never** read entire large files into memory with `fs.readFileSync` or accumulate unbounded arrays.
- **Never** rely on Redis distributed locks for operations that require ACID rollback guarantees.
- **Never** write redundant comments that state the obvious (`// get user by id: await getUserById()`).
- **Never** nest logic 3+ levels deep inside `if/else` ladders (arrow code anti-pattern).
- **Never** commit commented-out zombie code (`// const oldLogic = ...`). Rely on Git history.
- **Don't** let business workflows or persistence logic accumulate in controllers; review unusually long handlers and refactor when it improves clarity.
- **Never** use positional arguments with multiple primitives of the same type (`fn(id1, id2, str1, str2)`).
- **Never** throw exceptions for ordinary expected domain states (e.g. `CouponExpired`, `InsufficientBalance`).
- **Never** use type assertions (`as unknown as TargetType`) to bypass Prisma or TypeScript type checking.
- **Never** create "kitchen-sink" interfaces with dozens of optional fields (`paidAt?`, `refundedAt?`) when state is mutually exclusive.
- **Never** leave floating promises un-awaited or without a `.catch()` handler.
- **Never** swallow errors silently (`catch (e) {}`) without logging or proper handling.
- **Never** retry permanent client errors (HTTP 400, 401, 403, 404, 422).
- **Never** hardcode tenant quotas, feature flags, or permission rules in code. Query the DB.
- **Never** use `(req as any)` to access user or session data. Update `src/typings/index.d.ts` instead.
- **Never** return raw objects like `res.json({ foo: 'bar' })` or ad-hoc error formats.
- **Never** perform business logic directly inside Express route files (`.routes.ts`).
- **Never** read `process.env.*` directly throughout the codebase. Import from `@/env`.
