# Tail-Based Tracing & Advanced Observability

## Why Head-Based Sampling Fails
Head-based sampling makes the decision to keep or drop a trace at the root span when the request first enters the system (e.g. 5% probabilistic sampling).

**The Production Failure Mode:**
If an outage, unexpected exception (`500 Internal Server Error`), or catastrophic database lock occurs during an unsampled request, **the trace is discarded forever**. Engineers are left with blank APM dashboards during an active incident.

---

## Tail-Based Sampling Architecture
Tail-based sampling records all spans for an in-flight trace into an in-memory buffer ring. When the request lifecycle terminates, the tail sampler inspects the completed trace against evaluation rules:

1. **Error Rule:** Any trace where `status_code >= 500` or an unhandled exception occurred $\to$ **100% Sampled**.
2. **Latency Rule:** Any trace whose execution duration exceeded SLA/p99 thresholds (e.g. `> 1000ms`) $\to$ **100% Sampled**.
3. **Criticality Tier Rule:** Any request touching Tier 0 services (Auth, Checkout) $\to$ **100% Sampled**.
4. **Fast Baseline Rule:** Fast `200 OK` requests (< 50ms) $\to$ **Downsampled to 1%** (sufficient for baseline percentiles).

```
Incoming Request ──▶ [In-Memory Span Buffer] ──▶ Request Completes
                                                       │
                           ┌───────────────────────────┴───────────────────────────┐
                           ▼                                                       ▼
                Error / p99 Latency / Tier 0                            Fast 200 OK (< 50ms)
                           │                                                       │
                           ▼                                                       ▼
                 KEEP TRACE (100% Sample)                                KEEP TRACE (1% Sample)
```

---

## Implementation Guidelines
1. **Span Aggregation:** In multi-service architectures, route spans using consistent hashing on `traceId` (e.g., OpenTelemetry Load-Balancing Exporter) so all spans for a single trace reach the same collector node.
2. **Buffer Limits:** Maintain a bounded FIFO ring buffer (e.g. max 10,000 in-flight traces) with a timeout threshold (`decision_wait = 15s`) to prevent memory exhaustion under sustained spikes.
3. **Span Metrics Before Sampling:** Always calculate RED metrics (Rate, Errors, Duration) on 100% of raw spans *before* sampling is applied, guaranteeing accurate dashboards.
