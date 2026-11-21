import { z } from 'zod';
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

//? Robust RFC-compliant email parsing via Zod
const EmailSchema = z.string().trim().email();

export function parseEmail(raw: unknown): Result<Email, 'INVALID_EMAIL_FORMAT'> {
  const parseResult = EmailSchema.safeParse(raw);
  if (!parseResult.success) {
    return fail('INVALID_EMAIL_FORMAT');
  }
  return ok(parseResult.data.toLowerCase() as Email);
}
