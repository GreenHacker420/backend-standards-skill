# Robust Error Handling, Async/Await & Exponential Retries

## 1. Error Classification

### Operational Errors (`APIError`)
- Expected, foreseeable conditions caused by client inputs or external environmental state.
- Examples: Invalid parameters, 404 Not Found, 409 Conflict, quota exceeded, rate limits.
- Action: Handled gracefully, mapped to appropriate HTTP status codes, returned with structured format error details.

### Programmer & System Errors (`BaseError`)
- Uncaught exceptions, connection drops, unexpected nulls, or internal database query crashes.
- Action: Masked from the client in production (`500 Internal Server Error`) to avoid leaking internal database tables or credentials. Full stack traces and correlation IDs logged internally.

---

## 2. Exponential Backoff with AWS Full Jitter (`withRetry`)
Retrying failing network operations at fixed intervals or with additive jitter causes the "thundering herd" problem, synchronizing retries and overwhelming recovering downstream servers.

### The Algorithm: Full Jitter vs Deterministic Backoff
$$\text{ceiling} = \min(\text{maxDelay}, \text{minDelay} \times \text{factor}^{\text{attempt} - 1})$$
$$\text{delay} = \begin{cases} \text{random}(0, \text{ceiling}) & \text{if } \text{jitter} = \text{true} \\ \text{ceiling} & \text{if } \text{jitter} = \text{false} \end{cases}$$

- **Configurable Jitter Toggle (`jitter: boolean`)**: Defaults to `true` (AWS Full Jitter) for production concurrency; can be set to `false` for deterministic unit testing.
- **Honoring Upstream Headers with Jitter Smoothing**: If an HTTP 429 or 503 response includes a valid `Retry-After` header (in seconds or HTTP-date), the retry mechanism pauses for that duration while adding a small random smoothing jitter (up to 1,000ms) to ensure thousands of concurrent clients do not wake up at the exact same millisecond.
- **Idempotent 500 Retries**: If the caller explicitly marks the operation as idempotent (`isIdempotent: true`), a single cautious retry is permitted on HTTP 500 Internal Server Error (to handle transient upstream web server restarts).
- **Transient Network & HTTP Errors**: Mid-flight network drops (`ECONNRESET`, `ETIMEDOUT`, `EPIPE`), and HTTP 429, 502, 503, 504 are retried **ONLY if `isIdempotent: true`**, because non-idempotent operations may have partially or fully executed on the upstream server.
- **Database Deadlocks & Pre-Query Failures**: PostgreSQL deadlocks (`40P01`), serialization failures (`40001`, Prisma `P2034`), and pre-query connection errors (`P1001`, `P2024`, `ECONNREFUSED`, `ENOTFOUND`) are retried if `isIdempotent: true` OR `isDatabaseOnlyTransaction: true`. If non-database side-effects occur before the DB call, retrying without idempotency is strictly forbidden.
- **Non-Transient Errors**: HTTP 400, 401, 403, 404, 422. These fail fast immediately.
