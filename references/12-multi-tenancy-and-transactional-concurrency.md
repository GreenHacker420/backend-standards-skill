# Multi-Tenancy & Transactional Concurrency

This specification establishes production standards for multi-tenant data isolation, authorization boundaries, and transactional concurrency control in Node.js / PostgreSQL / Prisma applications.

---

## 1. Multi-Tenancy & Query Isolation (Preventing IDOR)

### The Threat: Insecure Direct Object Reference (IDOR)
In multi-tenant SaaS systems, allowing queries like `prisma.order.findUnique({ where: { id } })` without scoping to the authenticated user's `organizationId` exposes critical data to unauthorized cross-tenant access.

### Production Standard: Automatic Query-Level Isolation
Never rely on developer discipline to append `organizationId` in every query. Enforce isolation at the infrastructure layer:

#### Approach A: Prisma Client Extension for Automatic Tenant Scoping
```typescript
import { PrismaClient } from '@prisma/client';

export function createTenantPrismaClient(basePrisma: PrismaClient, organizationId: number) {
  return basePrisma.$extends({
    query: {
      $allModels: {
        async findMany({ args, query }) {
          args.where = { ...args.where, organizationId };
          return query(args);
        },
        async findFirst({ args, query }) {
          args.where = { ...args.where, organizationId };
          return query(args);
        },
        async updateMany({ args, query }) {
          args.where = { ...args.where, organizationId };
          return query(args);
        },
        async deleteMany({ args, query }) {
          args.where = { ...args.where, organizationId };
          return query(args);
        },
      },
    },
  });
}
```

#### Approach B: PostgreSQL Row-Level Security (RLS)
For high-security enterprise tiers, configure PostgreSQL RLS policies where the database itself enforces tenant separation based on session parameters:
```sql
ALTER TABLE orders ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation_policy ON orders
  AS RESTRICTIVE
  USING (organization_id = NULLIF(current_setting('app.current_org_id', true), '')::integer);
```

---

## 2. Transactional Concurrency & Race Condition Prevention

### Concurrency Hazards in High-Throughput Systems
1. **Lost Updates**: Two concurrent requests read inventory count `10`, deduct `1`, and both write `9`, resulting in an oversell.
2. **Double Spends**: Two checkout requests for the same wallet balance run in parallel, passing the balance check before either transaction commits.

### Mitigation Strategies

#### 1. Atomic Database Increments
For simple counter mutations (inventory, balances), use atomic database operations rather than in-memory read-modify-write:
```typescript
// Atomically deducts inventory; fails if stock is insufficient
const result = await prisma.product.updateMany({
  where: {
    id: productId,
    stock: { gte: quantityRequested }, // Invariant check inside WHERE clause
  },
  data: {
    stock: { decrement: quantityRequested },
  },
});

if (result.count === 0) {
  throw new InsufficientStockError('Insufficient inventory available.');
}
```

#### 2. Optimistic Concurrency Control (OCC)
For complex state machines (e.g. order workflow transitions), add a `version Int @default(0)` column:

```prisma
model Order {
  id             String   @id @default(uuid())
  organizationId Int
  status         String
  version        Int      @default(0)
  updatedAt      DateTime @updatedAt
}
```

```typescript
export async function transitionOrderStatus(
  prisma: PrismaClient,
  orderId: string,
  expectedVersion: number,
  newStatus: string
): Promise<void> {
  const updated = await prisma.order.updateMany({
    where: {
      id: orderId,
      version: expectedVersion, // Guarantees no concurrent modification occurred
    },
    data: {
      status: newStatus,
      version: { increment: 1 },
    },
  });

  if (updated.count === 0) {
    throw new ConcurrencyConflictError(
      'Order was modified concurrently by another process. Please refresh and retry.'
    );
  }
}
```

#### 3. Database Isolation Levels
- **Read Committed (Default)**: Protects against dirty reads. Acceptable for 95% of standard CRUD operations.
- **Repeatable Read / Serializable**: Use for financial ledger balancing and complex multi-row accounting where phantom reads or non-repeatable reads cannot be tolerated:
```typescript
await prisma.$transaction(
  async (tx) => {
    // Strict serializable transaction
    await performLedgerBalancing(tx);
  },
  {
    isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
    maxWait: 5000,
    timeout: 10000,
  }
);
```
