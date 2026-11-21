# Multi-Tenancy & Transactional Concurrency

This specification establishes production standards for multi-tenant data isolation, authorization boundaries, and transactional concurrency control in Node.js / PostgreSQL / Prisma applications.

---

## 1. Multi-Tenancy & Query Isolation (Preventing IDOR)

### The Threat: Insecure Direct Object Reference (IDOR)
In multi-tenant SaaS systems, allowing queries like `prisma.order.findUnique({ where: { id } })` without scoping to the authenticated user's `organizationId` exposes critical data to unauthorized cross-tenant access.

### Production Standard: Automatic Query-Level Isolation

#### Approach A: PostgreSQL Row-Level Security (RLS) with Transaction-Local Configuration
For defense-in-depth, PostgreSQL Row-Level Security (RLS) enforces tenant boundaries directly inside the database engine.

##### Critical Policy Composition Rule: Permissive vs. Restrictive
In PostgreSQL, a `RESTRICTIVE` policy can only narrow access granted by `PERMISSIVE` policies. By default, policies are `PERMISSIVE`. PostgreSQL requires at least one `PERMISSIVE` policy to grant access; if only restrictive policies are defined, **no rows will ever be accessible** (failing completely closed).

```sql
-- 1. Enable RLS on tenant-scoped tables
ALTER TABLE orders ENABLE ROW LEVEL SECURITY;

-- 2. Create PERMISSIVE policy granting tenant access based on transaction-local setting
CREATE POLICY tenant_isolation_policy ON orders
  FOR ALL
  TO app_user -- Non-superuser application role
  USING (organization_id = NULLIF(current_setting('app.current_org_id', true), '')::integer)
  WITH CHECK (organization_id = NULLIF(current_setting('app.current_org_id', true), '')::integer);
```

##### Setting Transaction-Local Tenant Context with Connection Pooling
When using connection poolers (PgBouncer, Prisma pool), connection state can bleed across requests if set globally. You must set `app.current_org_id` with `is_local = TRUE`:

```typescript
export async function executeTenantTransaction<T>(
  prisma: PrismaClient,
  organizationId: number,
  task: (tx: Prisma.TransactionClient) => Promise<T>
): Promise<T> {
  return prisma.$transaction(async (tx) => {
    //? The 3rd parameter (is_local = TRUE) binds the setting strictly to THIS transaction.
    //? When the transaction commits or aborts, the setting resets immediately.
    await tx.$executeRaw`SELECT set_config('app.current_org_id', ${organizationId.toString()}, TRUE)`;

    return await task(tx);
  });
}
```

##### ⚠️ Database Role & BYPASSRLS Invariant
Table owners, PostgreSQL superusers (`postgres`), and database roles with the `BYPASSRLS` attribute completely bypass Row-Level Security! Your Node.js application connection string must connect as a dedicated non-superuser role (`app_user`) that does not own the tables and does not have `BYPASSRLS`.

---

#### Approach B: Prisma Client Extension for Application-Level Scoping
Prisma extensions intercept client operations to inject `organizationId`:

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

##### ⚠️ Prisma Extension Limitations
Prisma `$extends` query extensions only intercept client-level model methods (`findMany`, `findFirst`, `updateMany`, etc.). They **do not** automatically protect raw SQL queries (`$queryRaw`, `$executeRaw`), model-level `$queryRaw`, bulk raw migrations, or un-intercepted methods unless comprehensively mapped. For absolute multi-tenant containment, pair application scoping with PostgreSQL RLS.

---

## 2. Transactional Concurrency & Race Condition Prevention

### Concurrency Hazards in High-Throughput Systems
1. **Lost Updates**: Two concurrent requests read inventory count `10`, deduct `1`, and both write `9`, resulting in an oversell.
2. **Double Spends**: Two checkout requests for the same wallet balance run in parallel, passing the balance check before either transaction commits.

### Mitigation Strategies

#### 1. Atomic Database Increments
For simple counter mutations (inventory, balances), use atomic database operations inside the `where` clause:
```typescript
// Atomically deducts inventory; fails if stock is insufficient
const result = await prisma.product.updateMany({
  where: {
    id: productId,
    organizationId, // Tenant boundary check
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
For state machines (order workflows, status changes), add a `version Int @default(0)` column and **always** include `organizationId` in the condition:

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
  options: {
    orderId: string;
    organizationId: number; //! Mandatory: Prevent cross-tenant mutation in OCC
    expectedVersion: number;
    newStatus: string;
  }
): Promise<void> {
  const { orderId, organizationId, expectedVersion, newStatus } = options;

  const updated = await prisma.order.updateMany({
    where: {
      id: orderId,
      organizationId, // Invariant: Tenant isolation MUST be preserved in OCC
      version: expectedVersion, // Guarantees no concurrent modification occurred
    },
    data: {
      status: newStatus,
      version: { increment: 1 },
    },
  });

  if (updated.count === 0) {
    throw new ConcurrencyConflictError(
      'Order was modified concurrently by another process or does not belong to tenant. Please refresh and retry.'
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
