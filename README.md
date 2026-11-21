# Production Backend Standards & Architectural Skill

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)
[![TypeScript: Strict](https://img.shields.io/badge/TypeScript-Strict-blue.svg)](https://www.typescriptlang.org/)
[![skills.sh](https://img.shields.io/badge/skills.sh-available-success.svg)](https://skills.sh/)
[![Node.js](https://img.shields.io/badge/Node.js-Backend-339933?logo=nodedotjs&logoColor=white)](https://nodejs.org/)
[![AI Agent Skill](https://img.shields.io/badge/AI%20Agent-Skill-8A2BE2.svg)](#installation)

An opinionated **AI-agent skill and engineering standard** for designing, implementing, and reviewing production Node.js and TypeScript backends. It brings architecture, code structure, type safety, reliability, observability, and operational practices into one practical reference—with examples you can adapt to a real codebase.

> **The goal is not to add more abstraction. The goal is to make backend systems easier to reason about, safer to change, and more resilient under failure.**

---

## Table of Contents

- [What This Repository Provides](#what-this-repository-provides)
- [Who Should Use It](#who-should-use-it)
- [Core Engineering Principles](#core-engineering-principles)
- [Architecture at a Glance](#architecture-at-a-glance)
- [Installation](#installation)
- [Using the Skill Effectively](#using-the-skill-effectively)
- [Repository Tour](#repository-tour)
- [Architecture Patterns](#architecture-patterns)
- [Engineering Checklists](#engineering-checklists)
- [Customization and Adoption](#customization-and-adoption)
- [Limitations and Design Trade-offs](#limitations-and-design-trade-offs)
- [Contributing](#contributing)
- [License](#license)

---

## What This Repository Provides

This repository contains three complementary layers:

| Layer | Purpose | Where to look |
|---|---|---|
| **Agent instructions** | A consolidated set of backend architecture and implementation rules for coding agents | [SKILL.md](./SKILL.md) |
| **Deep-dive references** | Focused explanations, trade-offs, and design guidance for major engineering topics | [references/](./references/) |
| **Code examples** | Small TypeScript implementations illustrating selected patterns | [examples/](./examples/) |

### How Agents & Engineers Should Interpret This Skill

To avoid ambiguity, the standard distinguishes between three levels of authority:

| Level | Meaning | Agent's Responsibility |
| :--- | :--- | :--- |
| **Mandatory Standards** | Security boundaries, transactional atomicity, concurrency invariants, and data-integrity guarantees | **Must follow strictly.** Never compromise correctness, ACID isolation, or safety invariants. |
| **Architectural Recommendations** | Preferred structural patterns, domain orchestrators, modular vertical slices, and single-action decomposition | **Follow unless there is a justified reason not to** (e.g. existing conventions in an established project). |
| **Examples & Reference Code** | Concrete illustrative implementations demonstrating the target patterns in code | **Understand the underlying invariant and adapt; do NOT blindly copy.** |

> **Agent Execution Mandate:**
> Examples demonstrate intended engineering principles and implementation approaches. They are not mandatory templates. Agents must understand the underlying invariant and apply it using the project's actual architecture, dependencies, and framework conventions. Do not introduce framework migrations, architectural overhauls, or new dependencies merely to match an example.

### What it is—and what it is not

- It **is** an opinionated standard, a reusable agent skill, and a collection of implementation references.
- It **is not** a backend framework, a drop-in production platform, or a guarantee that every example can be copied without adaptation.
- It **does not** replace system-specific design decisions, threat modeling, load testing, operational runbooks, or code review.

---

## Who Should Use It?

This skill is most useful for:

- Engineers building production Node.js services with TypeScript.
- Teams designing reliable HTTP endpoints, PostgreSQL + Prisma data layers, and Redis + BullMQ asynchronous pipelines.
- Developers designing modular monoliths or feature-oriented backend services.
- Teams that use AI coding agents and want consistent architecture, reliability, and coding conventions.
- Reviewers who need a shared checklist for reliability, concurrency correctness, type safety, and maintainability.

The repository is opinionated and examples are implemented using a concrete modern TypeScript stack (HTTP controllers, Prisma ORM, Redis, and BullMQ). The core reliability invariants (distributed claim leases, outbox fencing tokens, atomic rate limits, and constant-time crypto comparisons) apply across production backends, while the implementation patterns illustrate how to realize those invariants cleanly in TypeScript.

---

## Core Engineering Principles

The standard is organized around a few recurring ideas.

### 1. Keep the architecture explicit

Prefer readable functional composition, clear module boundaries, and direct data access over unnecessary abstraction layers. Stateful classes are useful for infrastructure components with lifecycles or connections; they should not become the default shape for all business logic.

### 2. Treat the database as the source of business configuration

Business configuration that changes independently of application releases—such as tenant permissions, feature entitlements, quotas, pricing configuration, and notification templates—should be modeled as data rather than scattered TypeScript constants.

This does **not** mean every constant belongs in the database. Compile-time invariants, protocol details, and genuinely static application defaults can remain in code. Keep the boundary intentional.

### 3. Protect critical workloads

Classify work by business criticality and define what happens when dependencies are slow or capacity is constrained.

| Tier | Typical workload | Preferred overload behavior |
|---|---|---|
| **Tier 0 — Vital** | Authentication, checkout, payments, order state | Protect capacity; do not synchronously depend on lower-priority enrichment |
| **Tier 1 — Core experience** | Catalog and inventory reads | Prefer bounded work and safe cache fallback where appropriate |
| **Tier 2 — Enrichment** | Recommendations, personalization, AI suggestions | Degrade or shed before critical paths are affected |
| **Tier 3 — Deferred** | Reports, exports, batch processing | Queue, pause, defer, or reject according to an explicit policy |

Tier labels are a design tool, not universal constants. Each service should define its own classification, timeouts, capacity budgets, and fallback semantics.

### 4. Make asynchronous workflows observable

Use request context and structured logs to correlate HTTP requests, domain operations, queue jobs, and external calls. The references discuss Node.js `AsyncLocalStorage`, trace propagation, and tail-based sampling.

### 5. Design failure behavior before an outage

Use bounded retries for transient failures, idempotency for repeatable mutations, circuit breakers for unstable dependencies, retry budgets to avoid retry storms, and dead-letter handling for messages that cannot be processed.

### 6. Make invalid states hard to represent

Parse untrusted inputs at system boundaries, use branded types and smart constructors where they add value, model lifecycle states with discriminated unions, and use typed results for expected domain failures.

### 7. Keep handlers small and domain logic testable

Separate transport concerns from business workflows. A route/action handler should generally parse input, enforce boundary concerns, call the relevant domain operation, and format the response. Use roughly 65 lines as an advisory review threshold, not a hard cap; longer handlers should be examined for misplaced responsibilities and simplified when that improves clarity.

### 8. Treat security and resource limits as design constraints

Use timing-safe comparisons for secrets, backpressure for large data pipelines, transaction-scoped locks for database coordination where appropriate, and cost-aware limits for expensive operations. Choose each control based on the threat or resource-exhaustion scenario it is meant to address.

---

## Architecture at a Glance

The following is the conceptual request path promoted by this standard. Exact middleware order and components depend on the application.

```text
                         INCOMING REQUEST
                                |
                                v
                   Request / Trace Context
                                |
                                v
                    Authentication & Limits
                                |
                                v
                   Idempotency (when needed)
                                |
                                v
                  Criticality / Load Policy
                                |
                                v
                   Route + Action Handler
                    (parse, authorize, map)
                                |
                                v
                    Domain Orchestrator
                     /        |        \
                    v         v         v
                 Database   External   Queue /
                 (bounded)  Services   Outbox
                    |         |         |
                    +---------+---------+
                              |
                              v
                   Structured Logs & Traces
```

A core reliability boundary is the **transactional outbox**: persist the business change and the event record in one database transaction, then publish the event asynchronously. This avoids treating a database write and a broker publish as one magically atomic operation.

---

## Installation

### Recommended: Skills CLI

Install the skill from this repository:

```bash
npx skills add GreenHacker420/backend-standards-skill
```

Useful CLI variations:

```bash
# Install globally
npx skills add GreenHacker420/backend-standards-skill -g

# Install for selected agents (check the CLI's supported agent identifiers)
npx skills add GreenHacker420/backend-standards-skill -a antigravity cursor claude-code

# Non-interactive installation
npx skills add GreenHacker420/backend-standards-skill -y

# List skills exposed by this repository
npx skills add GreenHacker420/backend-standards-skill -l
```

The Skills CLI evolves independently of this repository. Check `npx skills add --help` if an option or agent identifier differs in your installed version.

### Manual installation

The skill definition is [SKILL.md](./SKILL.md). Place it in the skill directory expected by your coding agent.

For example, to install into a separate project, clone the skill repository and copy both the skill definition and its examples into that project's skill directory:

```bash
# Clone the skill repository (use a path that does not already exist)
git clone https://github.com/GreenHacker420/backend-standards-skill.git /tmp/backend-standards-skill

# Set the absolute path to the project where you want to install the skill
PROJECT_ROOT="/absolute/path/to/your-project"
SKILL_SOURCE="/tmp/backend-standards-skill"
SKILL_TARGET="$PROJECT_ROOT/.agents/skills/backend"

mkdir -p "$SKILL_TARGET" "$SKILL_TARGET/examples"
cp "$SKILL_SOURCE/SKILL.md" "$SKILL_TARGET/SKILL.md"
cp -R "$SKILL_SOURCE/examples/." "$SKILL_TARGET/examples/"
```

Replace `/absolute/path/to/your-project` with the target project's actual absolute path. Copying `examples/` alongside `SKILL.md` preserves the relative example paths referenced by the skill instructions.

For a global Google Antigravity setup, use the skills directory configured by your installed Antigravity version. Directory conventions can change, so prefer its current documentation over assuming a path is universal.

For Cursor, Claude Code, Windsurf, Copilot, or another agent, use the agent's current skill/rules mechanism. Do not assume that simply mentioning `SKILL.md` in a prompt automatically loads it; configure the file where that agent actually reads project instructions.

---

## Using the Skill Effectively

Installation makes the instructions available to a compatible agent; a good task prompt still matters. Ask the agent to inspect the existing codebase and apply relevant standards rather than blindly rewriting the project.

### Example prompts

**Implement a new endpoint**

```text
Read the backend skill instructions first. Inspect the existing module conventions,
then implement the endpoint using the project's established patterns. Keep transport
logic separate from domain orchestration, validate input at the boundary, preserve
existing API contracts, and add focused tests.
```

**Review an existing service**

```text
Review this backend module against the installed backend standards. Identify concrete
correctness, security, reliability, type-safety, and maintainability issues. Separate
critical defects from optional improvements. Do not modify files; return findings
with file and line references.
```

**Plan a reliability improvement**

```text
Assess whether this workflow needs idempotency, an outbox, bounded retries, a circuit
breaker, or queue-level deduplication. Explain failure modes and trade-offs first.
Do not introduce patterns that do not solve a demonstrated problem.
```

### A practical workflow

1. **Inspect first.** Ask the agent to read the relevant project instructions, package scripts, module boundaries, database schema, and nearby implementations.
2. **Map the current behavior.** Identify API contracts, data ownership, transaction boundaries, queue semantics, and external dependencies before proposing changes.
3. **Apply only relevant standards.** A small CRUD endpoint does not need a circuit breaker or an outbox unless its behavior requires one.
4. **Preserve project conventions.** The skill is a baseline, not permission to overwrite established architecture without justification.
5. **Verify the result.** Run the repository's type checks, linting, tests, migrations (in the intended environment), and relevant integration checks.
6. **Report trade-offs.** The agent should state what changed, what it verified, and what remains unverified.

---

## Repository Tour

```text
.
├── .gitignore
├── LICENSE
├── README.md
├── SKILL.md
├── examples/
│   ├── clean-code/
│   ├── controllers/
│   ├── database/
│   ├── modular/
│   │   └── orders/
│   ├── observability/
│   ├── orchestrators/
│   ├── resilience/
│   ├── safety/
│   └── types/
└── references/
    ├── 01-service-criticality-and-load-shedding.md
    ├── 02-distributed-tracing-and-observability.md
    ├── 03-zero-hardcoding-database-rules.md
    ├── 04-error-handling-and-retries.md
    ├── 05-modular-vertical-slice-architecture.md
    ├── 06-tail-sampling-and-advanced-tracing.md
    ├── 07-failure-recovery-retry-budgets-dlq.md
    ├── 08-parse-dont-validate-and-domain-types.md
    ├── 09-result-pattern-and-prisma-types.md
    ├── 10-commenting-clean-code-and-readability.md
    ├── 11-production-safety-code-patterns.md
    └── 12-multi-tenancy-and-transactional-concurrency.md
```

### Reference guide

| Reference | Focus |
|---|---|
| [01 — Service criticality and load shedding](./references/01-service-criticality-and-load-shedding.md) | Priority tiers, graceful degradation, database pool protection |
| [02 — Distributed tracing and observability](./references/02-distributed-tracing-and-observability.md) | Request context, correlation IDs, structured logs |
| [03 — Zero-hardcoding database rules](./references/03-zero-hardcoding-database-rules.md) | Separating business configuration from application code |
| [04 — Error handling and retries](./references/04-error-handling-and-retries.md) | Error classification, retry behavior, resilience boundaries |
| [05 — Modular vertical-slice architecture](./references/05-modular-vertical-slice-architecture.md) | Feature modules, action handlers, public module interfaces |
| [06 — Tail sampling and advanced tracing](./references/06-tail-sampling-and-advanced-tracing.md) | Trace retention policies, bounded buffers, sampling |
| [07 — Retry budgets and dead-letter queues](./references/07-failure-recovery-retry-budgets-dlq.md) | Retry amplification, full jitter, retry budgets, DLQs |
| [08 — Domain types and parse-don't-validate](./references/08-parse-dont-validate-and-domain-types.md) | Branded types, smart constructors, discriminated unions |
| [09 — Result pattern and Prisma types](./references/09-result-pattern-and-prisma-types.md) | Typed domain failures and precise Prisma projections |
| [10 — Clean code and commenting](./references/10-commenting-clean-code-and-readability.md) | Guard clauses, semantic comments, SLAP, readable handlers |
| [11 — Production safety code patterns](./references/11-production-safety-code-patterns.md) | Timing-safe comparisons, backpressured streams, PostgreSQL advisory locks, cost-weighted rate limiting |
| [12 — Multi-tenancy and transactional concurrency](./references/12-multi-tenancy-and-transactional-concurrency.md) | Multi-tenant query isolation, IDOR prevention, optimistic concurrency control (OCC), database isolation levels |

### Example guide

| Directory | Demonstrates |
|---|---|
| [clean-code](./examples/clean-code/) | Guard clauses and semantic comments |
| [controllers](./examples/controllers/) | Single-action controller and request DTO pattern |
| [database](./examples/database/) | Bulkheaded Prisma pools and an outbox relay example |
| [modular](./examples/modular/) | A feature-oriented orders module |
| [observability](./examples/observability/) | Request context, tracing middleware, Zod-parsed W3C trace schemas, tail sampler |
| [orchestrators](./examples/orchestrators/) | Domain workflow separated from the HTTP layer |
| [resilience](./examples/resilience/) | Circuit breaker, retries, retry budgets, idempotency, singleflight, degradation |
| [safety](./examples/safety/) | Timing-safe HMAC comparison, streaming pipelines, advisory locks, cost-weighted rate limiting |
| [types](./examples/types/) | Branded types, smart constructors, Result, Prisma projections |

Examples are intentionally focused. Review imports, framework versions, configuration, error semantics, transaction boundaries, and security controls before using them in an application.

---

## Architecture Patterns

### Action handlers and domain orchestrators

Keep HTTP-specific details at the edge. A handler should not become the home for multi-step workflows, cross-service coordination, or complex database transactions.

```text
modules/
└── orders/
    ├── orders.routes.ts
    ├── actions/
    │   ├── create-order.action.ts
    │   ├── get-order.action.ts
    │   └── cancel-order.action.ts
    ├── orchestrators/
    │   └── order-orchestrator.ts
    ├── schemas/
    │   └── order.schema.ts
    ├── repositories/
    │   └── order.repository.ts
    └── index.ts
```

This is a reference layout, not a mandatory directory tree. Smaller projects can use a simpler structure; larger systems benefit from explicit ownership and public module interfaces.

### Resilience patterns: choose by failure mode

| Pattern | Use it when | Important guardrail |
|---|---|---|
| Idempotency | A mutation may be retried by a client, gateway, or provider | Scope keys correctly, persist result semantics, and handle concurrent requests atomically |
| Transactional outbox | A committed DB change must cause an asynchronous side effect | Publish at least once and make consumers idempotent |
| Retry with backoff | A dependency failure is plausibly transient | Retry only safe operations and use bounded attempts, jitter, and a budget |
| Circuit breaker | A remote dependency is repeatedly failing or timing out | Define open/half-open behavior and metrics; do not hide permanent failures |
| Dead-letter queue | A message remains unprocessable after its retry policy | Preserve payload and context; control and audit re-drive |
| Singleflight | Concurrent requests duplicate the same expensive in-flight work | Bound key cardinality and ensure errors/cleanup do not leave stale entries |
| Load shedding | Optional work threatens capacity needed by critical operations | Make degradation explicit and observable |

### Type-safety patterns

- **Parse, don't validate:** turn untrusted input into a trusted representation at the boundary.
- **Branded types:** distinguish semantically different primitive values such as `UserId` and `OrderId`.
- **Discriminated unions:** represent mutually exclusive lifecycle states explicitly.
- **Result types:** return expected business failures in the type contract.
- **Prisma projections:** derive DTOs from the actual selected database fields using generated Prisma types.
- **Options objects:** prefer named properties over long lists of positional primitive arguments.

### Observability patterns

- Carry trace/request context through asynchronous execution.
- Include useful correlation fields in structured logs.
- Propagate relevant context across queue boundaries.
- Track metrics before sampling decisions.
- Preserve error and slow traces while sampling healthy traffic according to an explicit policy.
- Bound in-memory buffers and define behavior when capacity is exceeded.

---

## Engineering Checklists

Use these as review prompts, not as a box-ticking substitute for understanding the system.

### Before implementing a backend change

- [ ] Have the existing routes, contracts, schemas, and module ownership been inspected?
- [ ] Is input parsed and validated at the trust boundary?
- [ ] Are authorization and tenant boundaries enforced server-side?
- [ ] Are database writes and side effects protected by appropriate transaction boundaries?
- [ ] Are mutation retries safe and idempotent where required?
- [ ] Are external calls bounded by timeouts and appropriate failure policies?
- [ ] Are logs and traces sufficient to diagnose the workflow?
- [ ] Are expected business failures represented clearly?
- [ ] Are tests covering success, validation, authorization, concurrency, and failure paths?

### Before shipping a reliability-sensitive workflow

- [ ] Are critical and optional workloads distinguished?
- [ ] Can optional work exhaust database pools or event-loop capacity?
- [ ] Are retries limited to transient failures and a single appropriate boundary?
- [ ] Is retry amplification controlled with budgets and jitter?
- [ ] Can queue messages be processed more than once safely?
- [ ] Is there a DLQ and an audited recovery process where needed?
- [ ] Does graceful shutdown stop accepting work and drain active operations?
- [ ] Are health/readiness signals meaningful for the dependencies the service needs?

---

## Customization and Adoption

Do not apply every rule mechanically. Adopt the standards incrementally:

1. Start with boundary correctness: validation, authorization, tenant isolation, and error handling.
2. Establish module ownership and consistent action/orchestrator separation.
3. Add correlation IDs and structured logging before adding advanced trace sampling.
4. Introduce idempotency and transactional outbox where workflows require reliable retries or asynchronous effects.
5. Add retry budgets, circuit breakers, DLQs, and load shedding based on observed dependency and capacity risks.
6. Use stronger domain types and typed results where they reduce real classes of defects.

Document intentional deviations in the project itself. A standard should make decisions more consistent—not prevent a team from making a better context-specific decision.

---

## Limitations and Design Trade-offs

This repository is deliberately opinionated. A few guidelines deserve context:

- **The 65-line controller guideline** is a heuristic for detecting responsibility leakage, not a hard quality metric.
- **Criticality tiers and timeout values** must be calibrated using business impact, service-level objectives, dependency latency, and load tests.
- **Tail-based sampling** requires bounded buffering and appropriate trace infrastructure. In-memory examples are not a complete multi-instance tracing backend.
- **A transactional outbox** still requires a reliable relay, delivery monitoring, deduplication, and operational recovery.
- **Idempotency** requires careful key scoping, request fingerprinting, atomic state transitions, retention policy, and response replay semantics.
- **Retries** can amplify incidents and duplicate side effects. They are not safe for every operation or error.
- **Database-backed configuration** needs schema ownership, validation, caching/invalidation, and secure secret handling.
- **Code examples** are illustrative reference implementations, not audited drop-in production components.

Prefer measured limits and explicit failure semantics over copying example numbers into production.

---

## Contributing

Contributions that improve correctness, clarity, practical applicability, or example quality are welcome.

When proposing a change:

1. Explain the failure mode or engineering problem the change addresses.
2. Keep the recommendation consistent with the repository's preference for explicit, minimal abstractions.
3. Include trade-offs and conditions where the pattern should **not** be used.
4. Update the relevant reference and `SKILL.md` when the agent-facing rule changes.
5. Add or update a focused TypeScript example when it materially clarifies the implementation.
6. Keep examples honest: identify assumptions, required dependencies, and any production hardening still needed.

Please avoid adding prescriptive rules without explaining the problem they solve.

---

## License

This project is licensed under the MIT License. See [LICENSE](./LICENSE) in the repository root for the complete license terms.
