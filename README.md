# Production Backend Standards & Architectural Skill

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)
[![TypeScript: Strict](https://img.shields.io/badge/TypeScript-Strict-blue.svg)](https://www.typescriptlang.org/)
[![skills.sh](https://img.shields.io/badge/skills.sh-indexed-success.svg)](https://skills.sh/)
[![Antigravity](https://img.shields.io/badge/Antigravity-Compatible-orange.svg)](https://github.com/)

An opinionated, battle-tested architectural specification, coding standard, and autonomous agent skill for building enterprise-grade, scalable, and maintainable Node.js & TypeScript backends.

---

## ⚡ Quick Install

Install this skill into your project for any AI coding agent (**Google Antigravity**, **Cursor**, **Claude Code**, **Copilot**, etc.) via `npx skills`:

```bash
npx skills add GreenHacker420/backend-standards-skill
```

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
8. **Modular & Vertical Slice Architecture**: Structure complex systems into feature modules (`src/modules/<feature>/`) that encapsulate their own routes, actions, and schemas.
9. **Tail-Based Tracing**: Buffer in-flight spans and sample 100% of errors and p99 latency spikes while downsampling healthy fast paths.
10. **Retry Storm Prevention (Retry Budgets)**: Enforce a rolling token bucket (max 10% retries) with Full Jitter to avoid compounding outages.
11. **Singleflight (Cache Stampede Prevention)**: Coalesce concurrent cache-miss requests into a single database promise.
12. **"Parse, Don't Validate" & Branded Types**: Transform untrusted input into nominal branded types (`Email`, `UserId`) at API boundaries; eliminate repetitive defensive checks.
13. **Make Illegal States Unrepresentable**: Model domain lifecycle phases as state-discriminated unions so impossible combinations cannot compile.
14. **The Result Pattern**: Return `{ ok: true, data } | { ok: false, error }` for domain errors instead of throwing unchecked exceptions.
15. **Type-Safe Prisma Projections (Zero `as any`)**: Enforce exact SQL projection contracts with `satisfies Prisma.Select` and `Prisma.GetPayload`.

---

## 📂 Repository Structure

```
.
├── SKILL.md                       # Master single-file skill for AI Agents (Antigravity / Claude Code / Cursor)
├── examples/                      # Compilable, production-ready TypeScript reference implementations
│   ├── controllers/               # 1-action controller templates with Zod DTOs
│   ├── modular/                   # Modular Vertical Slice architecture example (orders module)
│   ├── orchestrators/             # Domain orchestrators decoupled from HTTP transport
│   ├── observability/             # AsyncLocalStorage request context, tracing, tail-sampler, logger
│   ├── resilience/                # Retry budget, singleflight, degradation manager, circuit breaker
│   ├── types/                     # Branded types, smart constructors, result pattern, prisma projections
│   └── database/                  # Bulkheaded Prisma pools, transactional outbox relay
├── references/                    # Deep architectural design specifications
│   ├── 01-service-criticality-and-load-shedding.md
│   ├── 02-distributed-tracing-and-observability.md
│   ├── 03-zero-hardcoding-database-rules.md
│   ├── 04-error-handling-and-retries.md
│   ├── 05-modular-vertical-slice-architecture.md
│   ├── 06-tail-sampling-and-advanced-tracing.md
│   ├── 07-failure-recovery-retry-budgets-dlq.md
│   ├── 08-parse-dont-validate-and-domain-types.md
│   └── 09-result-pattern-and-prisma-types.md
└── package.json
```

---

## 🚀 Installation & Agent Setup

### Option 1: Package Manager for Skills (`npx skills`)

The easiest way to install and keep this skill updated across your projects:

```bash
# 1. Install to current project (recommended)
npx skills add GreenHacker420/backend-standards-skill

# 2. Install globally (available across all your projects on your machine)
npx skills add GreenHacker420/backend-standards-skill -g

# 3. Target specific agents (e.g. Antigravity, Cursor, Claude Code)
npx skills add GreenHacker420/backend-standards-skill -a antigravity cursor claude-code

# 4. Non-interactive / CI setup (skip prompts)
npx skills add GreenHacker420/backend-standards-skill -y

# 5. List available skills in this repo without installing
npx skills add GreenHacker420/backend-standards-skill -l

# 6. One-off use without installing
npx skills use GreenHacker420/backend-standards-skill@backend
```

---

### Option 2: Manual Installation

#### In Google Antigravity
Copy `SKILL.md` into your global or project skills directory:
```bash
# Global installation (available to all your agents)
mkdir -p ~/.gemini/config/skills/backend
cp SKILL.md ~/.gemini/config/skills/backend/

# Workspace installation (project-specific)
mkdir -p .agents/skills/backend
cp SKILL.md .agents/skills/backend/
```

#### In Cursor / Claude Code / Windsurf / Copilot
Reference `SKILL.md` in your project's `.cursorrules`, `CLAUDE.md`, or system prompt files.

---

## 📄 License
MIT License. Free for commercial and open-source use.
