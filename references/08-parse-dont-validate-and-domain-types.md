# Parse, Don't Validate & Advanced Domain Type Safety

## 1. The Core Philosophy: "Parse, Don't Validate"
Validation merely checks if data satisfies a condition and leaves the variable in its raw primitive type (e.g. `string`, `number`). Downstream functions must either trust blindly or defensively re-validate.

**Parsing**, in contrast, takes unstructured/raw `unknown` input and transforms it into a **guaranteed-valid branded type** (`Email`, `UserId`, `Money`) that **cannot physically exist in an invalid state**. Once parsed at the API boundary (controller), internal domain services require zero defensive checks.

---

## 2. Branded Types (Nominal Typing)
TypeScript uses structural typing. `type UserId = number` and `type OrderId = number` can be accidentally swapped in function parameters without any compiler warning. Branded types solve this:

```typescript
declare const __brand: unique symbol;
import { z } from 'zod';

export type Brand<K, T> = K & { readonly [__brand]: T };

export type UserId = Brand<number, 'UserId'>;
export type OrderId = Brand<number, 'OrderId'>;
export type Email = Brand<string, 'Email'>;

const EmailSchema = z.string().trim().email();

export function parseEmail(raw: unknown): Result<Email, 'INVALID_EMAIL'> {
  const parsed = EmailSchema.safeParse(raw);
  if (!parsed.success) return fail('INVALID_EMAIL');
  return ok(parsed.data.toLowerCase() as Email);
}
```

---

## 3. Make Illegal States Unrepresentable
Avoid "kitchen-sink" types where fields are optional based on an internal status string (`status: 'pending' | 'paid' | 'cancelled', paidAt?: Date, cancelReason?: string`).

Instead, model domain state as a **Discriminated Union** where impossible combinations cannot even compile:

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

---

## 4. Smart Constructors & Value Objects
Primitives like `number` for currency or `Date` for intervals allow invalid states (negative money, `startDate > endDate`).

Use private constructors so objects can **only** be constructed via static `.create(...)` factory methods that enforce business invariants:

```typescript
export class Money {
  private constructor(
    public readonly amountCents: number,
    public readonly currency: 'USD' | 'EUR' | 'INR'
  ) {}

  public static create(amountCents: number, currency: 'USD' | 'EUR' | 'INR'): Result<Money, string> {
    if (!Number.isInteger(amountCents)) return fail('Amount must be integer cents');
    if (amountCents < 0) return fail('Amount cannot be negative');
    return ok(new Money(amountCents, currency));
  }

  public add(other: Money): Result<Money, string> {
    if (this.currency !== other.currency) return fail('Currency mismatch');
    return ok(new Money(this.amountCents + other.amountCents, this.currency));
  }
}
```

---

## 5. Exhaustive Pattern Matching with `assertNever`
When processing unions, default cases must use `assertNever`:

```typescript
export function assertNever(value: never): never {
  throw new Error(`Unhandled union member: ${JSON.stringify(value)}`);
}

export function handleOrder(order: Order) {
  switch (order.status) {
    case 'PENDING': return handlePending(order);
    case 'PAID': return handlePaid(order);
    case 'CANCELLED': return handleCancelled(order);
    default:
      // If a new status is added to Order, TypeScript refuses to compile here!
      return assertNever(order);
  }
}
```
