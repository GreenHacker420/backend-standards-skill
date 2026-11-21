import { Result, ok, fail } from './result';

/**
 * Value Object with Smart Constructor
 * Invariants:
 * 1. Amount must be a non-negative safe integer representing minor currency units (cents).
 * 2. Currencies must match strictly for mathematical operations.
 * 3. Operations must never overflow JavaScript safe integer boundaries (Number.MAX_SAFE_INTEGER).
 */
export class Money {
  private constructor(
    public readonly amountCents: number,
    public readonly currency: 'USD' | 'EUR' | 'GBP' | 'INR'
  ) {}

  public static create(
    amountCents: number,
    currency: 'USD' | 'EUR' | 'GBP' | 'INR'
  ): Result<Money, string> {
    if (!Number.isSafeInteger(amountCents)) {
      return fail('Money amount must be a safe integer within minor units (cents)');
    }
    if (amountCents < 0) {
      return fail('Money amount cannot be negative');
    }
    return ok(new Money(amountCents, currency));
  }

  public add(other: Money): Result<Money, string> {
    if (this.currency !== other.currency) {
      return fail(`Currency mismatch: cannot add ${other.currency} to ${this.currency}`);
    }
    const sum = this.amountCents + other.amountCents;
    if (!Number.isSafeInteger(sum)) {
      return fail('Money addition exceeds maximum safe integer limits');
    }
    return ok(new Money(sum, this.currency));
  }

  public subtract(other: Money): Result<Money, string> {
    if (this.currency !== other.currency) {
      return fail(`Currency mismatch: cannot subtract ${other.currency} from ${this.currency}`);
    }
    const difference = this.amountCents - other.amountCents;
    if (difference < 0) {
      return fail('Insufficient funds: result cannot be negative');
    }
    return ok(new Money(difference, this.currency));
  }

  public format(): string {
    return `${(this.amountCents / 100).toFixed(2)} ${this.currency}`;
  }
}
