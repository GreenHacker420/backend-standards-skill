# Service Criticality Tiering, Load Shedding & DB Bulkheading

## 1. Overview
In high-throughput e-commerce and SaaS platforms, system failures rarely occur due to a single catastrophic bug; they occur because non-critical background or enrichment workloads starve critical revenue transactions of shared resources (Postgres connections, Redis bandwidth, Node.js event loop).

This specification establishes a formal priority hierarchy and load shedding protocol to ensure vital user journeys (Checkout, Payment, Authentication) survive any volume spike.

---

## 2. Priority Tiers (P0 - P3)

### Tier 0: Vital / Revenue Operations
- **Components**: Authentication, Cart Mutation, Checkout, Payment Capture, Order Confirmation.
- **SLA**: 99.99% availability.
- **Policy**: **Capacity Reserved & Highest Priority.** Protected by dedicated database pool slices and priority reservation. Must have zero synchronous dependencies on lower-tier services. If primary database is fully saturated or impaired, Tier 0 employs graceful fallback (e.g., synchronous read with deferred asynchronous ledger sync) rather than unhandled crash.

### Tier 1: Core Product Browsing
- **Components**: Product Catalog, Item Details, Inventory Availability.
- **SLA**: 99.9% availability.
- **Policy**: **Degrade to Cache.** Under load, serve cached Redis responses with extended TTLs and skip real-time inventory count recalculations.

### Tier 2: Sheddable Enrichment
- **Components**: Real-time Recommendations, Personalization, "Customers Also Bought", AI Search Suggestions, Recently Viewed Carousels.
- **SLA**: Best-effort.
- **Policy**: **Shed First.** Automatically disabled or swapped with pre-computed static bestsellers (`degraded: true`). Strictly bounded by 150ms statement timeouts in the database.

### Tier 3: Deferred / Internal Operations
- **Components**: CSV Exports, Batch Reporting, Audit Logs, Marketing Webhooks.
- **SLA**: Asynchronous eventual consistency.
- **Policy**: **Hard Shed.** Return HTTP 503 with `Retry-After`. Pause BullMQ consumers until event loop and database connection pools normalize.

---

## 3. Database Connection Pool Bulkheading
1. **Dedicated Pool Slices**: Allocate at least 70% of available Prisma connection pool slots to Tier-0.
2. **Read Replica Routing**: Route Tier-1 and Tier-2 read queries to PostgreSQL read replicas.
3. **Statement Timeouts**: Set `statement_timeout = '150ms'` on Tier-2 sessions so runaway analytical queries are terminated by Postgres before affecting pool availability.
