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

//? Zod v4 schemas for boundary validation
const PositiveSafeIntegerSchema = z.int().positive().refine(
  (val) => Number.isSafeInteger(val),
  { message: 'Value exceeds safe integer bounds' }
);

const EmailSchema = z.email();

/**
 * Safe Smart Constructors:
 * Validates runtime values against invariants before asserting nominal brand.
 */
export function parseUserId(raw: unknown): Result<UserId, 'INVALID_USER_ID'> {
  const parseResult = PositiveSafeIntegerSchema.safeParse(raw);
  if (!parseResult.success) {
    return fail('INVALID_USER_ID');
  }
  return ok(parseResult.data as UserId);
}

export function parseOrderId(raw: unknown): Result<OrderId, 'INVALID_ORDER_ID'> {
  const parseResult = PositiveSafeIntegerSchema.safeParse(raw);
  if (!parseResult.success) {
    return fail('INVALID_ORDER_ID');
  }
  return ok(parseResult.data as OrderId);
}

export function parseOrgId(raw: unknown): Result<OrganizationId, 'INVALID_ORGANIZATION_ID'> {
  const parseResult = PositiveSafeIntegerSchema.safeParse(raw);
  if (!parseResult.success) {
    return fail('INVALID_ORGANIZATION_ID');
  }
  return ok(parseResult.data as OrganizationId);
}

export function parseEmail(raw: unknown): Result<Email, 'INVALID_EMAIL_FORMAT'> {
  const parseResult = EmailSchema.safeParse(raw);
  if (!parseResult.success) {
    return fail('INVALID_EMAIL_FORMAT');
  }
  return ok(parseResult.data.toLowerCase() as Email);
}
