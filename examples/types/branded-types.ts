import { Result, ok, fail } from './result';

/**
 * Branded Types (Nominal Typing)
 * Prevents accidental parameter swapping of identical primitive types.
 */
declare const __brand: unique symbol;
export type Brand<K, T> = K & { readonly [__brand]: T };

export type UserId = Brand<number, 'UserId'>;
export type OrderId = Brand<number, 'OrderId'>;
export type OrganizationId = Brand<number, 'OrganizationId'>;
export type Email = Brand<string, 'Email'>;

// Safe parser factories
export const asUserId = (id: number): UserId => id as UserId;
export const asOrderId = (id: number): OrderId => id as OrderId;
export const asOrgId = (id: number): OrganizationId => id as OrganizationId;

export function parseEmail(raw: unknown): Result<Email, 'INVALID_EMAIL_FORMAT'> {
  if (typeof raw !== 'string') return fail('INVALID_EMAIL_FORMAT');
  const trimmed = raw.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) {
    return fail('INVALID_EMAIL_FORMAT');
  }
  return ok(trimmed as Email);
}
