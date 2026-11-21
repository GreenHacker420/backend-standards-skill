# Modular & Vertical Slice Architecture

## Core Philosophy
In traditional Layered Architecture, code is organized horizontally (`controllers/`, `services/`, `models/`, `routes/`). As an application grows beyond 20+ endpoints, this creates high cognitive friction: touching a single feature requires jumping between 4-5 distant directories, and dead code becomes nearly impossible to track.

**Modular (Vertical Slice) Architecture** groups code around **Business Capabilities and Bounded Contexts**. Each domain module encapsulates its own routes, single-action controllers, validation schemas, business orchestrators, and direct data projections.

---

## Directory Blueprint

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

---

## Inviolable Rules of Modular Architecture

1. **Self-Contained Slices:**
   - Everything related to the `orders` domain lives inside `src/modules/orders/`.
   - Adding a new endpoint means adding one action inside `actions/` and one line in `orders.routes.ts`.

2. **No Cross-Module Database Tampering:**
   - Module A (`orders`) must **never** query Module B (`tickets`) database tables directly.
   - If `orders` needs customer data from `identity`, it must call the exported TypeScript function in `modules/identity/index.ts` or subscribe to outbox events.

3. **Single-Action Controllers Preserved:**
   - Even inside a module, never write a bloated multi-method controller class.
   - Each endpoint has a dedicated action file exporting a single handler (`create-order.action.ts`).

4. **Shared vs Module-Specific Code:**
   - If an abstraction is used across 3+ modules (e.g. database client, circuit breaker, JWT verification), it belongs in `src/core/`.
   - If an abstraction is only used by `orders`, it stays strictly inside `src/modules/orders/`.
