# Reviews Cloud — Shopify reviews app on Cloudflare

A runnable Shopify reviews app MVP using Cloudflare Workers, D1, R2, Queues and a SQLite-backed Durable Object. This edition includes clean-install provisioning so the Cloudflare stack can deploy directly from a GitHub-connected Worker, like the Shopify Cloudflare Sync app.

It includes:

- Shopify OAuth installation and embedded-admin session-token verification
- HMAC-verified, deduplicated Shopify webhooks
- Public review submission, pagination and helpful voting
- Manual/automatic approval, basic spam rules, hiding and seller responses
- D1 transactional mutations with an outbox
- Product aggregate maintenance
- Product-scoped projection coalescing through a Durable Object
- Versioned R2 storefront JSON projections
- A Shopify theme app extension with review blocks and a submission form
- An admin dashboard for moderation, settings and projection rebuilding
- Local demo seeding and automated tests
- GitHub-triggered Cloudflare provisioning and deployment

The implementation covers the supplied architecture's foundations, core reviews and R2 storefront plane. Later enterprise phases are documented in `docs/ARCHITECTURE_MAPPING.md` and are not represented as complete.

## Direct deployment from GitHub

### What the first deployment does

A production-branch deployment automatically:

1. Creates or reuses the D1 database.
2. Creates or reuses the R2 projection bucket.
3. Creates or reuses the events Queue and dead-letter Queue.
4. Generates a deployment-only Wrangler configuration with the real resource IDs.
5. Applies the D1 migrations.
6. Deploys the Worker, Queue consumer, cron trigger and Durable Object migration.
7. Writes generated resource details under `.wrangler/generated/` during the build.

Later pushes reuse the same named resources and redeploy the application.

### 1. Push the project to GitHub

Place this project at the repository root, or select its directory as the Cloudflare build root when using a monorepo.

Do not commit `.dev.vars`, `.wrangler/`, credentials or generated secret files.

### 2. Import the repository in Cloudflare

In **Workers & Pages**, create/import a Worker from the GitHub repository.

Use:

```text
Production branch: main
Build command: leave empty
Deploy command: npx wrangler deploy
Root directory: /   (or the app directory in a monorepo)
```

The default deploy command is supported. You may alternatively set the deploy command to `npm run deploy`; both paths use the same provisioning script.

For an existing Worker, its Cloudflare name must match the `name` in `wrangler.jsonc` unless you deliberately set `WORKER_NAME` to the connected Worker name.

### 3. Add Cloudflare build variables

Under **Worker → Settings → Build → Variables and secrets**, add:

```text
CLOUDFLARE_ACCOUNT_ID=your Cloudflare account ID
CLOUDFLARE_API_TOKEN=an API token with permission to manage Workers, D1, R2 and Queues
CLOUDFLARE_PRODUCTION_BRANCH=main
```

Store `CLOUDFLARE_API_TOKEN` as a build secret. It is used only while provisioning and must not be added as a Worker runtime variable.

A reference with all optional values is included in `deployment-values.example`.

### 4. Configure Shopify application values

There are two supported setup modes.

#### Setup-placeholder mode

Leave the Shopify values out of the build environment. The first deployment creates normal-text Worker placeholders for:

```text
SHOPIFY_API_KEY
SHOPIFY_API_SECRET
APP_ENCRYPTION_KEY
```

After deployment, open **Worker → Settings → Variables and Secrets**, replace the placeholders, convert sensitive values to **Secret**, and deploy the settings.

Use a stable random `APP_ENCRYPTION_KEY` containing at least 32 characters. Changing it later prevents previously encrypted access tokens and guest email values from being decrypted.

Add `TURNSTILE_SECRET` only when Turnstile is enabled on the storefront form.

#### Build-secret mode

Add these to Cloudflare build variables/secrets before the first deployment:

```text
SHOPIFY_API_KEY=your Shopify client ID
SHOPIFY_API_SECRET=your Shopify client secret
APP_ENCRYPTION_KEY=your stable random encryption key
TURNSTILE_SECRET=optional
```

The provisioning script uploads supplied application values as encrypted Worker secrets.

### 5. Optional resource names and custom domains

The defaults are:

```text
Worker: shopify-reviews-cloudflare
D1: shopify-reviews-db
R2: shopify-reviews-projections
Queue: shopify-reviews-events
DLQ: shopify-reviews-events-dlq
```

Override them with build variables:

```text
WORKER_NAME
RESOURCE_PREFIX
D1_DATABASE_NAME
R2_BUCKET_NAME
EVENT_QUEUE_NAME
EVENT_DLQ_NAME
```

By default, `APP_URL` is generated from the Worker `workers.dev` URL and `PUBLIC_CDN_BASE` is set to the Worker's `/cdn` route. For custom domains, set:

```text
APPLICATION_URL=https://reviews.example.com
PUBLIC_CDN_BASE=https://reviews-cdn.example.com
```

`PUBLIC_CDN_BASE` can be an R2 custom domain. Until that is configured, the Worker `/cdn` route provides a deployable fallback.

## Configure Shopify

The repository includes `shopify.app.toml` with placeholders. Each provisioning run also creates a deployment-specific file at:

```text
.wrangler/generated/shopify.app.toml
```

For a local deployment, publish that generated config with Shopify CLI, or copy its generated URL and client ID into the root `shopify.app.toml`:

```bash
shopify app config link
shopify app deploy
```

The Cloudflare Git deployment deploys the Worker stack. The Shopify app configuration and theme extension are released through Shopify CLI.

The installation URL is:

```text
https://YOUR-WORKER-DOMAIN/auth?shop=YOUR-STORE.myshopify.com
```

In the Shopify theme editor, add **Product reviews** and optionally **Review rating summary**. Set:

- **Projection CDN base URL** to `PUBLIC_CDN_BASE`, without a trailing slash.
- **Public API base URL** to `APP_URL`, without a trailing slash.

The block requests:

```text
{cdnBase}/v1/shops/{shop.permanent_domain}/products/{product.id}.json
```

## Local development

Prerequisites:

- Node.js 22 or newer
- A Cloudflare account
- A Shopify Partner app and development store for real Shopify installation
- Shopify CLI for the app configuration and theme extension

Install and run:

```bash
npm install
cp .dev.vars.example .dev.vars
npm run db:migrate:local
npm run dev
```

Open:

```text
http://localhost:8787/admin?shop=demo-shop.myshopify.com
```

The dashboard creates demo data on first load. The demo product ID is `8750123456789`.

The local projection URL is:

```text
http://localhost:8787/cdn/v1/shops/demo-shop.myshopify.com/products/8750123456789.json
```

Run all checks:

```bash
npm run check
```

## Local or external-CI deployment

Set the same build environment values shown in `deployment-values.example`, then run:

```bash
npm install
npm run deploy
```

To provision without deploying:

```bash
npm run provision
```

To apply migrations to already provisioned resources:

```bash
npm run db:migrate:remote
```

## R2 production delivery

For high-volume storefront delivery, attach a custom domain to the projection bucket and configure public read access/CORS for `GET` and `HEAD`. Set that domain as `PUBLIC_CDN_BASE` in the Cloudflare build settings and in the theme block.

The Worker route under `/cdn/` remains available for local development and controlled fallback.

Recommended CORS response headers:

```text
Access-Control-Allow-Origin: *
Access-Control-Allow-Methods: GET, HEAD
Access-Control-Allow-Headers: Content-Type
```

## Security notes

- Never commit `.dev.vars`, build secrets or real credentials.
- Never add `CLOUDFLARE_API_TOKEN` as a Worker runtime variable.
- Production admin APIs reject the development token and require a verified Shopify session token.
- Webhooks are verified from the raw request body before parsing.
- Guest email is encrypted before storage and never enters public projection JSON.
- Public shop context is resolved from a known public key/domain; request bodies cannot choose a `shop_id`.
- The default scopes include protected customer/order data because verified-purchase support is an architectural requirement. Remove `read_orders` and `read_customers` until that feature is approved and implemented for your app.
- Use a stable encryption key and preserve it across deployments.
- Prefer a dedicated R2 custom domain for production storefront traffic.

## Project layout

```text
src/index.ts                         Worker, queue, cron and Durable Object
src/core.mjs                        Validation, policy and projection selection
migrations/0001_initial.sql         D1 schema and indexes
extensions/reviews-theme-extension  Shopify theme app extension
scripts/provision.mjs               Idempotent Cloudflare resource bootstrap
scripts/cloudflare-build-hook.mjs   Default Wrangler/GitHub deployment hook
scripts/deploy-all.mjs              Local or external-CI full deployment
shopify.app.toml                    Shopify CLI app configuration
wrangler.jsonc                      Local template and GitHub bootstrap entry
```

## Known production work before App Store submission

This package is a complete runnable MVP, not the whole enterprise roadmap. Before a public App Store launch, complete the legal/privacy review, protected-customer-data approval, email verification provider decision, billing/plan enforcement, media pipeline, load testing, alerting, backup drills, and the advanced features listed in `docs/ARCHITECTURE_MAPPING.md`.
