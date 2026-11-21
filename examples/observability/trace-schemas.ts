import { z } from 'zod';

/**
 * Zod-Powered W3C Trace Context & Correlation ID Schemas
 * 
 * Complies with W3C Trace Context Recommendation (https://www.w3.org/TR/trace-context/):
 * - version: 2 hex characters ('00' current standard, 'ff' strictly forbidden).
 * - trace-id: 32 hex characters (16 bytes). MUST NOT be all zeros.
 * - parent-id: 16 hex characters (8 bytes). MUST NOT be all zeros.
 * - trace-flags: 2 hex characters (8-bit field, e.g. 01 = sampled).
 * - Total exact length for version 00: 55 characters.
 */

//? Validates standalone 32-character hexadecimal trace ID
export const TraceIdSchema = z
  .string()
  .trim()
  .length(32, 'Trace ID must be exactly 32 hexadecimal characters')
  .regex(/^[0-9a-f]{32}$/i, 'Trace ID must contain only hexadecimal characters')
  .refine(
    (val) => val.toLowerCase() !== '00000000000000000000000000000000',
    { message: 'W3C Violation: Trace ID cannot be all zeros' }
  )
  .transform((val) => val.toLowerCase());

//? Validates full W3C traceparent header string
export const W3CTraceparentSchema = z
  .string()
  .trim()
  .length(55, 'W3C version 00 traceparent must be exactly 55 characters')
  .regex(
    /^00-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$/i,
    'Invalid W3C traceparent structure (must be: 00-{trace_id}-{parent_id}-{flags})'
  )
  .superRefine((val, ctx) => {
    const parts = val.split('-');
    const traceId = parts[1]?.toLowerCase();
    const parentId = parts[2]?.toLowerCase();

    //! W3C Invariant: Neither trace_id nor parent_id may be all zeros
    if (traceId === '00000000000000000000000000000000') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'W3C Violation: trace_id cannot be all zeros',
      });
    }

    if (parentId === '0000000000000000') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'W3C Violation: parent_id cannot be all zeros',
      });
    }
  })
  .transform((val) => {
    const [version, traceId, parentId, flags] = val.split('-');
    return {
      version,
      traceId: traceId.toLowerCase(),
      parentId: parentId.toLowerCase(),
      flags,
    };
  });

//? Safe alphanumeric correlation identifier (prevents header injection and ReDoS)
export const SafeCorrelationIdSchema = z
  .string()
  .trim()
  .min(16, 'Correlation ID must be at least 16 characters')
  .max(64, 'Correlation ID must be at most 64 characters')
  .regex(
    /^[a-zA-Z0-9_-]+$/,
    'Correlation ID must contain only URL-safe alphanumeric, underscore, or hyphen characters'
  );

export type ParsedTraceparent = z.infer<typeof W3CTraceparentSchema>;
