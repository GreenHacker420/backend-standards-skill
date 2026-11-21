/**
 * Railway-Oriented Programming: Type-Safe Result Tuples
 * Eliminates unhandled exceptions for expected domain failures.
 */

export type Result<T, E = Error> =
  | { readonly ok: true; readonly data: T }
  | { readonly ok: false; readonly error: E };

export const ok = <T>(data: T): Result<T, never> => ({ ok: true, data });
export const fail = <E>(error: E): Result<never, E> => ({ ok: false, error });

/**
 * Asserts that a value has type 'never' at compile time.
 * Used in switch default blocks for exhaustive discriminated union checking.
 */
export function assertNever(value: never, message = 'Unhandled union member'): never {
  throw new Error(`${message}: ${JSON.stringify(value)}`);
}
