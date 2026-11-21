# Service Criticality Tiering, Load Shedding & DB Bulkheading

## 1. Overview
In high-throughput e-commerce and SaaS platforms, system failures rarely occur due to a single catastrophic bug; they occur because non-critical background or enrichment workloads starve critical revenue transactions of shared resources (Postgres connections, Redis bandwidth, Node.js event loop).

This specification establishes a formal priority hierarchy and load shedding protocol to ensure vital user journeys (Checkout, Payment, Authentication) survive any volume spike.

---

## 2. Priority Tiers (Tier 0 - Tier 3)

### Tier 0: Vital / Revenue Operations
- **Components**: Authentication, Cart Mutation, Checkout, Payment Capture, Order Confirmation, Security & Compliance Audit Logging.
- **SLA**: 99.99% availability.
- **Policy**: **Capacity Reserved & Highest Priority.**
  - Protected by dedicated database pool slices (minimum 70% connection budget) and resource reservation.
  - Must have zero synchronous dependencies on lower-tier services (e.g. recommendations, analytics).
  - **Durable Synchronous Persistence Invariant**: Authoritative financial transactions and ledger balance mutations MUST be synchronously committed to ACID PostgreSQL storage or a durable append-only write-ahead log before returning acknowledgment. Deferred asynchronous ledger syncs are strictly prohibited for financial mutations because node crashes risk silent ledger discrepancies and permanent unrecoverable data loss.
  - If the authoritative database is saturated, Tier 0 must fail fast with a retriable HTTP 503 and clear `Retry-After` header or trip circuit breakers; never silently defer financial consistency to volatile in-memory queues.

### Tier 1: Core Product Browsing
- **Components**: Product Catalog, Item Details, Inventory Availability, Price Inquiries.
- **SLA**: 99.9% availability.
- **Policy**: **Degrade to Cache.**
  - Under load, serve cached Redis responses with extended TTLs.
  - Degrade real-time inventory count recalculations to cached snapshots with advisory badges ("Limited stock remaining").

### Tier 2: Sheddable Enrichment
- **Components**: Real-time Recommendations, Personalization, "Customers Also Bought", AI Search Suggestions, Recently Viewed Carousels.
- **SLA**: Best-effort.
- **Policy**: **Shed First.**
  - Automatically disabled or swapped with pre-computed static fallback lists (`degraded: true`).
  - Strictly bounded by 150ms statement timeouts in PostgreSQL to prevent rogue analytical queries from consuming shared CPU or buffer cache.

### Tier 3: Deferred / Internal Operations
- **Components**: CSV Exports, Batch Analytical Reporting, Operational/Behavioral Analytics Telemetry, Marketing Webhooks, Background Worker Consumers.
- **SLA**: Asynchronous eventual consistency.
- **Policy**: **Hard Shed.**
  - Return HTTP 503 with `Retry-After`.
  - Pause non-critical BullMQ consumers until event loop delay and database connection pools normalize.
  - *Distinction*: Security and compliance audit logs (Tier 0) are non-sheddable; only operational telemetry and marketing analytics (Tier 3) are sheddable.

---

## 3. Database Connection Pool Bulkheading
1. **Dedicated Pool Slices**: Allocate at least 70% of available Prisma connection pool slots to Tier-0.
2. **Read Replica Routing**: Route Tier-1 browsing queries and Tier-2 read enrichments to PostgreSQL read replicas with separate, constrained pool sizes.
3. **Statement Timeouts**: Set `statement_timeout = '150ms'` on Tier-2 sessions so runaway analytical queries are terminated by Postgres before affecting pool availability.
