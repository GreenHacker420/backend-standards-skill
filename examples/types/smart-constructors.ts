import { Result, ok, fail } from './result';

/**
 * Value Object with Smart Constructor
 * Invariant: Amount must be non-negative integer cents; currencies must match for math.
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
    if (!Number.isInteger(amountCents)) {
      return fail('Money amount must be an integer (cents/minor units)');
    }
    if (amountCents < 0) {
      return fail('Money amount cannot be negative');
    }
    return ok(new Money(amountCents, currency));
  }

  public add(other: Money): Result<Money, string> {
    if (this.currency !== other.currency) {
      return fail(`Cannot add ${other.currency} to ${this.currency}`);
    }
    return ok(new Money(this.amountCents + other.amountCents, this.currency));
  }

  public format(): string {
    return `${(this.amountCents / 100).toFixed(2)} ${this.currency}`;
  }
}
