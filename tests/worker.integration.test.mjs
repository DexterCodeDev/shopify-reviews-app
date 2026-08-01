import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import worker, { ProductProjectionDO } from "../src/index.ts";

class D1StatementMock {
  constructor(db, sql, values = []) { this.db = db; this.sql = sql; this.values = values; }
  bind(...values) { return new D1StatementMock(this.db, this.sql, values); }
  async run() { return this.runSync(); }
  runSync() {
    const result = this.db.prepare(this.sql).run(...this.values);
    return { success: true, meta: { changes: Number(result.changes || 0), last_row_id: Number(result.lastInsertRowid || 0) } };
  }
  async first() { return this.db.prepare(this.sql).get(...this.values) || null; }
  async all() { return { success: true, results: this.db.prepare(this.sql).all(...this.values), meta: {} }; }
}

class D1Mock {
  constructor(schema) { this.db = new DatabaseSync(":memory:"); this.db.exec(schema); }
  prepare(sql) { return new D1StatementMock(this.db, sql); }
  async batch(statements) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const results = statements.map((statement) => statement.runSync());
      this.db.exec("COMMIT");
      return results;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
}

class R2Mock {
  constructor() { this.objects = new Map(); }
  async put(key, value, options = {}) {
    const text = typeof value === "string" ? value : new TextDecoder().decode(value);
    const etag = `etag-${this.objects.size + 1}`;
    this.objects.set(key, { text, options, etag });
    return { key, etag };
  }
  async get(key) {
    const item = this.objects.get(key);
    if (!item) return null;
    return {
      body: item.text,
      httpEtag: item.etag,
      customMetadata: item.options.customMetadata || {},
      writeHttpMetadata(headers) {
        const meta = item.options.httpMetadata || {};
        if (meta.contentType) headers.set("content-type", meta.contentType);
        if (meta.cacheControl) headers.set("cache-control", meta.cacheControl);
      }
    };
  }
  async delete(keys) {
    for (const key of Array.isArray(keys) ? keys : [keys]) this.objects.delete(key);
  }
  async list({ prefix = "", cursor } = {}) {
    if (cursor) return { objects: [], truncated: false };
    return { objects: [...this.objects.keys()].filter((key) => key.startsWith(prefix)).map((key) => ({ key })), truncated: false };
  }
}

class StorageMock {
  constructor() { this.map = new Map(); this.alarm = null; }
  async get(key) { return this.map.get(key); }
  async put(key, value) {
    if (typeof key === "object") for (const [name, item] of Object.entries(key)) this.map.set(name, item);
    else this.map.set(key, value);
  }
  async getAlarm() { return this.alarm; }
  async setAlarm(value) { this.alarm = value; }
}

class DONamespaceMock {
  constructor(env) { this.env = env; this.instances = new Map(); }
  idFromName(name) { return name; }
  get(id) {
    if (!this.instances.has(id)) {
      const state = { storage: new StorageMock() };
      this.instances.set(id, new ProductProjectionDO(state, this.env));
    }
    const instance = this.instances.get(id);
    return {
      async fetch(url, init) {
        const response = await instance.fetch(new Request(url, init));
        await instance.alarm();
        return response;
      }
    };
  }
}

function createContext() {
  const pending = [];
  return {
    waitUntil(promise) { pending.push(Promise.resolve(promise)); },
    async flush() { await Promise.all(pending.splice(0)); }
  };
}

function createEnvironment() {
  const schema = readFileSync(new URL("../migrations/0001_initial.sql", import.meta.url), "utf8");
  const queue = [];
  const env = {
    DB: new D1Mock(schema),
    PROJECTIONS: new R2Mock(),
    EVENTS: { async send(body) { queue.push(body); } },
    APP_ENV: "development",
    APP_URL: "http://local.test",
    PUBLIC_CDN_BASE: "http://local.test/cdn",
    SHOPIFY_API_KEY: "test-key",
    SHOPIFY_API_SECRET: "test-secret",
    SHOPIFY_API_VERSION: "2026-07",
    SHOPIFY_SCOPES: "read_products",
    APP_ENCRYPTION_KEY: "0123456789012345678901234567890123456789",
    DEV_SHOP_DOMAIN: "demo-shop.myshopify.com",
    DEV_ADMIN_TOKEN: "dev-token",
    PROJECTION_CACHE_SECONDS: "60"
  };
  env.PROJECTION_COORDINATOR = new DONamespaceMock(env);
  return { env, queue };
}

async function fetchWorker(env, input, init) {
  const ctx = createContext();
  const response = await worker.fetch(new Request(input, init), env, ctx);
  await ctx.flush();
  return response;
}

async function drainQueue(env, queue) {
  let guard = 0;
  while (queue.length && guard++ < 20) {
    const bodies = queue.splice(0);
    const retry = [];
    const messages = bodies.map((body, index) => ({
      id: String(index), body,
      ack() {},
      retry() { retry.push(body); }
    }));
    const ctx = createContext();
    await worker.queue({ messages }, env, ctx);
    await ctx.flush();
    queue.push(...retry);
  }
  assert.ok(guard < 20, "queue should converge");
}

test("end-to-end demo, public submission, projection and moderation", async () => {
  const { env, queue } = createEnvironment();
  const devHeaders = { "x-dev-admin-token": "dev-token", "content-type": "application/json" };

  const seed = await fetchWorker(env, "http://local.test/api/dev/seed", { method: "POST", headers: devHeaders, body: "{}" });
  assert.equal(seed.status, 201);
  const seeded = await seed.json();
  assert.equal(seeded.product_id, "8750123456789");

  const bootstrap = await fetchWorker(env, "http://local.test/api/admin/bootstrap?shop=demo-shop.myshopify.com", { headers: devHeaders });
  assert.equal(bootstrap.status, 200);
  const bootstrapData = await bootstrap.json();
  assert.deepEqual(bootstrapData.counts, { total: 3, pending: 0, approved: 3, spam: 0 });

  const projectionUrl = "http://local.test/cdn/v1/shops/demo-shop.myshopify.com/products/8750123456789.json";
  const initialProjection = await fetchWorker(env, projectionUrl);
  assert.equal(initialProjection.status, 200);
  assert.equal((await initialProjection.json()).statistics.total_review_count, 3);

  const submissionBody = JSON.stringify({ rating: 5, title: "Integration test", body: "A fully working review flow.", author_name: "Test User" });
  const submit = await fetchWorker(env, "http://local.test/api/public/demo-shop.myshopify.com/products/8750123456789/reviews", {
    method: "POST",
    headers: { "content-type": "application/json", "idempotency-key": "integration-1" },
    body: submissionBody
  });
  assert.equal(submit.status, 201);
  const submitted = await submit.json();
  assert.equal(submitted.status, "Approved Automatically");
  await drainQueue(env, queue);

  const updatedProjection = await fetchWorker(env, projectionUrl);
  const projectionData = await updatedProjection.json();
  assert.equal(projectionData.statistics.total_review_count, 4);
  assert.ok(projectionData.reviews.some((review) => review.review_id === submitted.review_id));

  const replay = await fetchWorker(env, "http://local.test/api/public/demo-shop.myshopify.com/products/8750123456789/reviews", {
    method: "POST",
    headers: { "content-type": "application/json", "idempotency-key": "integration-1" },
    body: submissionBody
  });
  assert.equal(replay.status, 200);
  assert.equal((await replay.json()).idempotent_replay, true);

  const hide = await fetchWorker(env, `http://local.test/api/admin/reviews/${submitted.review_id}?shop=demo-shop.myshopify.com`, {
    method: "PATCH", headers: devHeaders, body: JSON.stringify({ action: "hide" })
  });
  assert.equal(hide.status, 200);
  await drainQueue(env, queue);

  const hiddenProjection = await fetchWorker(env, projectionUrl);
  const hiddenData = await hiddenProjection.json();
  assert.equal(hiddenData.statistics.total_review_count, 3);
  assert.ok(!hiddenData.reviews.some((review) => review.review_id === submitted.review_id));
});

test("webhook ingestion verifies HMAC, deduplicates and processes product updates", async () => {
  const { env, queue } = createEnvironment();
  const devHeaders = { "x-dev-admin-token": "dev-token", "content-type": "application/json" };
  await fetchWorker(env, "http://local.test/api/dev/seed", { method: "POST", headers: devHeaders, body: "{}" });

  const body = JSON.stringify({ id: 99, admin_graphql_api_id: "gid://shopify/Product/99", title: "Webhook Product", handle: "webhook-product", status: "active", updated_at: "2026-08-01T00:00:00Z" });
  const hmac = createHmac("sha256", env.SHOPIFY_API_SECRET).update(body).digest("base64");
  const headers = {
    "content-type": "application/json",
    "x-shopify-hmac-sha256": hmac,
    "x-shopify-shop-domain": "demo-shop.myshopify.com",
    "x-shopify-topic": "products/update",
    "x-shopify-webhook-id": "webhook-1",
    "x-shopify-api-version": "2026-07"
  };
  const first = await fetchWorker(env, "http://local.test/webhooks/products", { method: "POST", headers, body });
  const duplicate = await fetchWorker(env, "http://local.test/webhooks/products", { method: "POST", headers, body });
  assert.equal(first.status, 200);
  assert.equal(duplicate.status, 200);
  assert.equal(queue.filter((item) => item.kind === "webhook").length, 1);
  await drainQueue(env, queue);

  const product = await env.DB.prepare("SELECT title, handle FROM products WHERE product_id='99'").first();
  assert.deepEqual({ title: product.title, handle: product.handle }, { title: "Webhook Product", handle: "webhook-product" });
});
