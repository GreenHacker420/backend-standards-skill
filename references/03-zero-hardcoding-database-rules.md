# Dynamic Configuration: Clear Separation of Concerns

## 1. Principles & Separation of Concerns
Hardcoding tenant configurations, permissions, pricing limits, notification text, or business flags inside TypeScript files creates rigid, unmaintainable codebases that require code deployments for business changes.

However, treating the database as the "sole source of truth" for everything must be qualified with strict architectural boundaries:

1. **Immutable Invariants & Domain Rules (Code in Version Control)**:
   - Business state-machine transitions, domain invariants, cryptographic protocols, and input validation schemas belong in version-controlled TypeScript code (`src/modules/*/`).
   - Core security logic must not be dynamically loaded or bypassed via unvetted database mutations.

2. **Master Secrets & Infrastructure Credentials (KMS / Secret Vaults)**:
   - Database passwords, master encryption keys, and service secrets must live in environment managers / AWS KMS / GCP Secret Manager and validate via `@/env` at boot.
   - Master infrastructure keys must **never** be stored in application database rows.

3. **Dynamic Business State & Tenant Settings (Database as Source of Truth)**:
   - Dynamic parameters, tenant quotas, role-permission matrices, localized templates, and feature flags live in the database as the sole source of truth for runtime business state.

---

## 2. Dynamic Systems Breakdown

### 1. Dynamic RBAC
Permissions are not hardcoded in TypeScript switches. The `checkOrgUserAccess` middleware evaluates user roles against `ResourceAccess` and `ModuleResource` tables, allowing dynamic permission grants per organization.

### 2. Tenant Quotas & Feature Access
Features are evaluated dynamically against active `SubscriptionFeature` records. Plan upgrades take effect instantly without restarting servers or re-deploying code.

### 3. Notification Copy & Templates
Customer-facing emails and WhatsApp messages are stored in `NotificationTemplate` records. Organizations can customize branding, placeholders, and copy through admin dashboards.

### 4. Tenant-Level Third-Party Credentials
Tenant-specific API keys and OAuth tokens for Shopify, WhatsApp Cloud, and Razorpay are stored in encrypted database columns (using AES-GCM with keys managed by KMS), scoped strictly to the tenant's `organizationId`.
