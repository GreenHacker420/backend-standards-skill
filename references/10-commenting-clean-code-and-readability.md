# Code Cleanliness, Readability & Commenting Standards

## 1. The Golden Rule of Comments: Explain WHY, Never WHAT
Code tells you *how* and *what*; comments must explain **why**.

### ❌ The Noise Anti-Pattern (Stating the Obvious)
```typescript
// ❌ Useless comment that adds visual noise and drifts out of sync
// Get user by id
const user = await getUserById(userId);

// Check if user is null
if (!user) {
  // Return 404 error
  return sendError(res, 'User not found', 404);
}
```

### ✅ The Production Standard (Explaining Rationale & Quirks)
```typescript
//? L1 in-memory cache check avoids a Redis round-trip for high-frequency heartbeat pings
const cachedSession = localMemoryCache.get(sessionId);

//! S3 upload must explicitly set ContentType; Meta WhatsApp Cloud API rejects media with application/octet-stream
const { fileKey } = await s3Client.upload({ file, contentType: 'audio/ogg; codecs=opus' });

//* Compliance rule: Never trigger automated marketing SMS outside 9:00 AM to 9:00 PM in customer local timezone
if (!isWithinCustomerBusinessHours(customer.timezone)) {
  await scheduleFollowupForNextMorning(customer.id);
  return;
}
```

---

## 2. Semantic Commenting Taxonomy (`Better Comments` Style)

Use an intentional, color-coded visual grammar across all TypeScript files:

| Tag | Name | Color | Purpose & Usage | Example |
| :--- | :--- | :--- | :--- | :--- |
| `//?` | **Rationale / Logic** | 🔵 Blue | Explains architectural intent, math formulas, or non-obvious algorithms. | `//? Each GPT query is counted as 2 interactions because it includes prompt and bot response` |
| `//!` | **Hazard / Invariant** | 🔴 Red | Warns of breaking changes, third-party API quirks, security risks, or race conditions. | `//! Crucial: Must re-throw error in worker catch block so BullMQ activates retry backoff` |
| `//*` | **Business Rule** | 🟢 Green | Documents legal compliance, SLA timers, domain constraints, or financial rules. | `//* Indian GSTIN rules require 18% IGST on inter-state electronic services` |
| `//&` | **Domain Boundary** | 🟣 Purple | Visual banner separating major functional sections within a module. | `//& Ticket Escalation & SLA Engine 🎫` |
| `//TODO:`| **Debt / Next** | 🟡 Yellow | Actionable task with issue ticket reference. Must never be anonymous. | `//TODO(COMM-402): Migrate from polling table to PostgreSQL WAL CDC replication` |

---

## 3. Code Cleanliness & Readability Invariants

### A. Guard Clauses & Early Returns (Eliminate Arrow Anti-Pattern)
Never nest code 4 levels deep inside `if/else` ladders. Handle errors and edge cases upfront with guard clauses, keeping the "happy path" flat against the left margin:

```typescript
// ❌ Arrow Anti-Pattern (Deep nesting, high cognitive load)
async function processOrder(req: Request, res: Response) {
  if (req.user) {
    if (req.body.items && req.body.items.length > 0) {
      const stock = await checkStock(req.body.items);
      if (stock.available) {
        // ... happy path nested 5 tabs deep
      } else {
        return sendError(res, 'Out of stock', 400);
      }
    } else {
      return sendError(res, 'No items', 400);
    }
  } else {
    return sendError(res, 'Unauthorized', 401);
  }
}

// ✅ Clean Guard Clauses (Flat, scannable, unnested)
async function processOrder(req: Request, res: Response) {
  if (!req.user) {
    return sendError(res, 'Unauthorized', 401);
  }

  const items = req.body.items;
  if (!items?.length) {
    return sendError(res, 'No items provided', 400);
  }

  const stock = await checkStock(items);
  if (!stock.available) {
    return sendError(res, 'Out of stock', 400);
  }

  // Happy path is completely flat:
  const order = await orderOrchestrator.createOrder({ userId: req.user.id, items });
  return sendResponse(res, order, 'Order created', 201);
}
```

### B. Single Level of Abstraction Principle (SLAP)
A high-level orchestrator function should read like a table of contents. It must not mix high-level business steps with low-level SQL strings or HTTP byte stream manipulations:

```typescript
// ✅ Orchestrator reads like high-level narrative:
export async function completeCheckout(input: CheckoutInput): Promise<Order> {
  await lockInventory(input.items);
  const payment = await chargePaymentMethod(input.payment);
  const order = await persistOrderRecord(input, payment.id);
  await emitOrderPlacedOutboxEvent(order.id);
  return order;
}
```

### C. The ~65-Line Controller Guideline (Advisory Review Threshold)
HTTP controllers must focus strictly on transport concerns: parse and validate the request, check session pre-conditions, delegate to a domain orchestrator, and return a standardized envelope. Use roughly 65 lines as an advisory review threshold—an unusually long controller is a signal that domain orchestration or database queries may have leaked into the transport layer and should be refactored when it improves clarity.

### D. Boolean Naming Conventions
Booleans must always use active predicate prefixes:
* ✅ `isValid`, `hasPermission`, `canRetry`, `shouldEscalate`, `isGuest`
* ❌ `valid`, `permission`, `retry`, `guest`

### E. Zero Commented-Out Zombie Code
Never leave blocks of commented-out legacy code (`// const oldPrismaQuery = ...`). Trust Git history. Dead code in files confuses AI agents and fellow engineers.
