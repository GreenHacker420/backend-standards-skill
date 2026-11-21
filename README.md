# Production Backend Standards & Architectural Skill

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)
[![TypeScript: Strict](https://img.shields.io/badge/TypeScript-Strict-blue.svg)](https://www.typescriptlang.org/)
[![Antigravity Skill](https://img.shields.io/badge/Antigravity-Compatible-orange.svg)](https://github.com/)

An opinionated, battle-tested architectural specification, coding standard, and autonomous agent skill for building enterprise-grade, scalable, and maintainable Node.js & TypeScript backends.

---

## 🌟 Why This Standard?

Modern backends often suffer from three fatal issues:
1. **Accidental Complexity**: Monolithic 1,500-line controller classes with tangled dependency injection containers.
2. **Resource Starvation Under Overload**: Non-critical background queries (e.g. recommendations/personalization) exhausting database connection pools and bringing down critical checkout/auth flows.
3. **Observability Blind Spots**: Disconnected log lines across asynchronous queues (BullMQ) and webhooks with zero correlation to the originating user request.

This repository codifies the architectural discipline to eliminate these problems completely.

---

## 🏛️ Core Architectural Pillars

```
                                      CLIENT REQUEST
                                            │
                                            ▼
                           ┌──────────────────────────────────┐
                           │   Distributed Tracing (W3C/ALS)  │
                           └──────────────────────────────────┘
                                            │
                                            ▼
                           ┌──────────────────────────────────┐
                           │    Idempotency & Rate Limiting   │
                           └──────────────────────────────────┘
                                            │
                                            ▼
                           ┌──────────────────────────────────┐
                           │  Service Criticality & Shedding  │
                           │   [P0: Revenue | P2: Sheddable]  │
                           └──────────────────────────────────┘
                                            │
                                            ▼
                   ┌──────────────────────────────────────────────────┐
                   │ Action Controllers (1 File = 1 Action + Zod DTO) │
                   └──────────────────────────────────────────────────┘
                                            │
                                            ▼
                   ┌──────────────────────────────────────────────────┐
                   │    Domain Orchestrator (src/lib/<domain>/...)     │
                   └──────────────────────────────────────────────────┘
                         │                   │                   │
                         ▼                   ▼                   ▼
                 ┌───────────────┐   ┌───────────────┐   ┌───────────────┐
                 │  DB Bulkhead  │   │ Circuit Break │   │  BullMQ Queue │
                 │  (Prisma Tx)  │   │  (3rd Party)  │   │ (Outbox Relay)│
                 └───────────────┘   └───────────────┘   └───────────────┘
```

1. **Simplicity Over Abstraction**: Direct, readable Prisma queries and explicit functional composition.
2. **Database as the Sole Source of Truth**: Zero hardcoding. Permissions, tenant feature limits, pricing tiers, and notification templates live in Postgres tables.
3. **Service Criticality & Load Shedding**:
   - **Tier 0 (Revenue/Vital)**: Checkout, payments, auth — *never shed*, protected by reserved connection pools.
   - **Tier 2 (Sheddable Enrichment)**: Recommendations, personalization — *shed first under load* (returns static bestsellers `degraded: true`).
4. **Distributed Tracing via `AsyncLocalStorage`**: Automatic `traceId` correlation across HTTP endpoints, Winston loggers, and BullMQ worker queues.
5. **Action-Based Controllers**: 1 file per endpoint (`create.ts`, `update.ts`, `delete.ts`) with co-located Zod schemas and inferred DTOs.
6. **Dual-Write Prevention**: Transactional Outbox pattern guarantees eventual consistency between PostgreSQL and background queue dispatch.
7. **Resilient Retries & Circuit Breakers**: Exponential backoff with randomized jitter (`withRetry`) and 3-state circuit breakers for flaky vendor APIs.

---

## 📂 Repository Structure

```
.
├── SKILL.md                       # Master single-file skill for AI Agents (Antigravity / Claude Code / Cursor)
├── examples/                      # Compilable, production-ready TypeScript reference implementations
│   ├── controllers/               # 1-action controller templates with Zod DTOs
│   ├── orchestrators/             # Domain orchestrators decoupled from HTTP transport
│   ├── observability/             # AsyncLocalStorage request context, tracing middleware, logger
│   ├── resilience/                # DegradationManager, circuit breaker, retry, idempotency
│   └── database/                  # Bulkheaded Prisma pools, transactional outbox relay
├── references/                    # Deep architectural design specifications
│   ├── 01-service-criticality-and-load-shedding.md
│   ├── 02-distributed-tracing-and-observability.md
│   ├── 03-zero-hardcoding-database-rules.md
│   └── 04-error-handling-and-retries.md
└── package.json
```

---

## 🚀 How to Install & Use as an Agent Skill

### In Google Antigravity
Copy `SKILL.md` into your global or project skills directory:
```bash
# Global installation (available to all your agents)
mkdir -p ~/.gemini/config/skills/backend
cp SKILL.md ~/.gemini/config/skills/backend/

# Workspace installation (project-specific)
mkdir -p .agents/skills/backend
cp SKILL.md .agents/skills/backend/
```

### In Claude Code / Cursor / Other Coding Agents
Reference `SKILL.md` in your project's `.cursorrules`, `CLAUDE.md`, or system prompts.

---

## 📄 License
MIT License. Free for commercial and open-source use.
