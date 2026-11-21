# Zero Hardcoding: The Database as the Sole Source of Truth

## 1. Principles
Hardcoding business configurations, tenant permissions, pricing limits, notification text, or integration secrets inside TypeScript files creates rigid, unmaintainable codebases that require code deployments for business changes.

In this architecture:
- **Code defines structure, validation, execution logic, and types.**
- **The Database defines configuration, parameters, permissions, copy, and state.**

---

## 2. Dynamic Systems Breakdown

### 1. Dynamic RBAC
Permissions are not hardcoded in TypeScript switches. The `checkOrgUserAccess` middleware evaluates user roles against `ResourceAccess` and `ModuleResource` tables, allowing dynamic permission grants per user.

### 2. Tenant Quotas & Feature Access
Features are evaluated via `FeatureAccess.check(subscription, 'voice_minutes', count)` against active `SubscriptionFeature` records. Plan upgrades take effect instantly without restarting servers.

### 3. Notification Copy & Templates
Customer-facing emails and WhatsApp messages are stored in `NotificationTemplate` records. Organizations can customize branding, placeholders, and copy through admin dashboards.

### 4. Integration Credentials
API keys, OAuth tokens, and webhooks for Shopify, WhatsApp Cloud, Mailgun, and Razorpay are stored in encrypted database columns per tenant.
