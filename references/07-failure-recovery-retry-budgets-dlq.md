# Failure Recovery: Retry Budgets, Error Matrices & DLQs

## 1. Retry Storms & Retry Multiplication
In a layered architecture (Gateway $\to$ Orders $\to$ Payments $\to$ Bank API), naive retries create a combinatorial explosion. If each layer retries 3 times:
$$\text{Max Multiplier} = 3 \times 3 \times 3 = 27\times \text{ load}$$

When an upstream dependency slows down, this surge of retries pushes it into a hard crash.

---

## 2. Inviolable Rules to Prevent Retry Storms

1. **Immediate Boundary Rule:**
   - Retry ONLY at the layer immediately above the failing dependency.
   - Intermediate proxies and orchestrators must propagate errors rather than retrying.

2. **Retry Budget (Google SRE Pattern):**
   - Target an explicit retry ratio (e.g. 10% of outbound requests) with burst capacity to absorb transient hiccups.
   - Enforce using a Token Bucket: regular requests deposit fractional tokens (e.g. 0.10 tokens per initial request); retries withdraw 1.0 token. If available tokens < 1.0, retries fail fast immediately.
   - *Architecture Note*: A process-local token bucket acts as an in-memory rate governor per Node.js instance with bootstrap burst capacity. For mathematically strict fleet-wide quotas across hundreds of distributed pods, enforce retry budgets at the service mesh layer (Envoy/Linkerd) or back the governor with an atomic Redis script.

3. **Full Jitter Exponential Backoff:**
   - Never use fixed or unjittered exponential delays (which cause synchronized client lockstep thundering herds).
   - Compute delay as:
     $$\text{delay} = \text{random}(0, \min(\text{cap}, \text{base} \times 2^{\text{attempt}}))$$

---

## 3. Strict Error Classification Matrix

| Error Category | Status / Error Codes | Action | Strategy |
| :--- | :--- | :---: | :--- |
| **Transient Network / HTTP (Idempotent)** | `503 Service Unavailable`<br>`429 Too Many Requests`<br>`502 / 504 Gateway Errors`<br>`ECONNRESET`, `ETIMEDOUT` | ✅ Retry | Requires `isIdempotent: true`! Retry with Full Jitter, deduct from Retry Budget, honor `Retry-After`. |
| **Database Deadlock / Pre-Query** | `40P01 Deadlock`<br>`40001 Serialization`<br>`P2034 Write Conflict`<br>`P1001 / P2024 Pool Timeout` | ✅ Retry | Safe if `isIdempotent: true` OR `isDatabaseOnlyTransaction: true`. |
| **Terminal / Client** | `400 Bad Request`<br>`401 Unauthorized`<br>`403 Forbidden`<br>`404 Not Found`<br>`422 Unprocessable` | ❌ Do NOT Retry | Fail fast immediately. Retrying bad input wastes CPU and bandwidth. |
| **Non-Idempotent** | Unkeyed `POST`<br>Payment authorizations | ❌ Do NOT Retry | **Never retry without a verified `Idempotency-Key`**. |
| **Internal Server Error** | `500 Internal Server Error` | ⚠️ Max 1 | Often indicative of application bugs. Retry at most once if idempotent. |

---

## 4. Poison Pill Quarantine & Dead Letter Queues (DLQ)

When processing background queues (BullMQ, Kafka, SQS):
1. **Quarantine:** If a message fails after $N$ attempts (e.g. 5 attempts) due to a schema bug or corrupt payload, eject it to a Dead Letter Queue (`{queueName}-dlq`).
2. **Metadata Retention:** Store the original payload, full stack trace, attempt timestamps, and `traceId` on the DLQ record.
3. **Re-drive Capabilities:**
   - Automated backoff re-drive for transient downstream network outages.
   - Administrative re-drive API (`POST /api/v1/admin/queues/:name/redrive`) after hotfixing code bugs.
