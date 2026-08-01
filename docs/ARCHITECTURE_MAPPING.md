# Architecture mapping

This repository implements a runnable Cloudflare-native MVP aligned to the supplied technical architecture.

| Architecture area | Repository implementation |
|---|---|
| Cloudflare Worker control plane | `src/index.ts` routes admin, public API, OAuth, webhooks, queue, scheduled repair |
| Authoritative D1 store | `migrations/0001_initial.sql` with reviews, statuses, aggregates, settings, outbox, webhook receipts, audit data |
| Transactional outbox | Review, vote, settings, seller-response and moderation mutations write `outbox_events` in the D1 batch |
| Queue delivery | `EVENTS` producer/consumer dispatches outbox events, webhook work and projection repair |
| Product-scoped coordination | `ProductProjectionDO` coalesces desired versions and serializes publication per product |
| R2 storefront read plane | Versioned JSON objects at `v1/shops/{publicKey}/products/{productId}.json` |
| Direct storefront rendering | Theme app extension in `extensions/reviews-theme-extension` fetches projection JSON without D1 |
| Schema-driven settings | One versioned settings document drives approval, spam and display behavior |
| Webhook correctness | Raw-body HMAC verification, delivery deduplication and durable enqueue |
| Shopify embedded admin | App Bridge session-token verification plus a functional review/settings dashboard |
| Privacy | Public projections omit email, customer ID, moderation evidence and other private fields |
| Repair loop | Cron-triggered outbox publishing and lagging-projection requeue |

## Deliberately outside this MVP

The source architecture defines a multi-phase enterprise platform. This package does not claim to include every later-phase capability. The following are extension points rather than completed subsystems: large-tenant D1 promotion and product sharding, streaming million-row import/undo workflows, media transcoding, D1 FTS5 search projection, Vectorize similarity, Analytics Engine dashboards, Workers AI summaries, protected-customer-data verified-purchase reconciliation, and full enterprise RBAC.
