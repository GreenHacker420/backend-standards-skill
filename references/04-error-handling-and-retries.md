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

## 2. Exponential Backoff with Jitter (`withRetry`)
Retrying failing network operations at fixed intervals causes the "thundering herd" problem, overwhelming recovering downstream servers.

### The Algorithm
$$\text{delay} = \min(\text{maxDelay}, \text{minDelay} \times \text{factor}^{\text{attempt} - 1}) + \text{jitter}$$

- **Transient Errors**: Network drops (`ECONNRESET`, `ETIMEDOUT`), HTTP 429, 502, 503, 504, and Postgres lock deadlocks (`40P01`). These are retried automatically.
- **Non-Transient Errors**: HTTP 400, 401, 403, 404, 422. These fail fast immediately.
