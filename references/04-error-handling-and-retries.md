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

### The Algorithm: Full Jitter
$$\text{ceiling} = \min(\text{maxDelay}, \text{minDelay} \times \text{factor}^{\text{attempt} - 1})$$
$$\text{delay} = \text{random}(0, \text{ceiling})$$

- **Honoring Upstream Headers**: If an HTTP 429 or 503 response includes a valid `Retry-After` header (in seconds or HTTP-date), the retry mechanism pauses for that exact duration instead of calculating jitter.
- **Idempotent 500 Retries**: If the caller explicitly marks the operation as idempotent (`isIdempotent: true`), a single cautious retry is permitted on HTTP 500 Internal Server Error (to handle transient upstream web server restarts).
- **Transient Errors**: Network drops (`ECONNRESET`, `ETIMEDOUT`, `ECONNREFUSED`, `EAI_AGAIN`), HTTP 429, 502, 503, 504, and PostgreSQL deadlocks (`40P01`) / serialization failures (`40001`). These are retried automatically.
- **Non-Transient Errors**: HTTP 400, 401, 403, 404, 422. These fail fast immediately.
