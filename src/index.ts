import {
  DEFAULT_SETTINGS,
  base64UrlDecode,
  base64UrlEncode,
  basicSpamDecision,
  corsHeaders,
  errorResponse,
  jsonResponse,
  mergeSettings,
  normalizeShopDomain,
  nowUnix,
  projectionObjectKey,
  selectProjectionReviews,
  shouldAutoApprove,
  timingSafeEqual,
  validateReviewInput
} from "./core.mjs";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export default {
  async fetch(request, env, ctx) {
    try {
      return await routeRequest(request, env, ctx);
    } catch (error) {
      console.error("unhandled_request_error", safeError(error));
      return errorResponse(500, "internal_error", "The request could not be completed.");
    }
  },

  async queue(batch, env, ctx) {
    for (const message of batch.messages) {
      try {
        await handleQueueMessage(message.body, env, ctx);
        message.ack();
      } catch (error) {
        console.error("queue_message_failed", { id: message.id, error: safeError(error) });
        message.retry();
      }
    }
  },

  async scheduled(_controller, env, ctx) {
    ctx.waitUntil(publishPendingOutbox(env));
    ctx.waitUntil(repairLaggingProjections(env));
    ctx.waitUntil(deleteExpiredOAuthStates(env));
  }
};

export class ProductProjectionDO {
  constructor(state, env) {
    this.state = state;
    this.env = env;
  }

  async fetch(request) {
    if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });
    const payload = await request.json();
    const shopId = String(payload.shopId || "");
    const productId = String(payload.productId || "");
    const desiredVersion = Math.max(0, Number(payload.desiredVersion || 0));
    if (!shopId || !productId) return new Response("Bad request", { status: 400 });

    const current = Number((await this.state.storage.get("desiredVersion")) || 0);
    await this.state.storage.put({
      shopId,
      productId,
      desiredVersion: Math.max(current, desiredVersion)
    });
    const alarm = await this.state.storage.getAlarm();
    if (alarm === null) await this.state.storage.setAlarm(Date.now() + 100);

    return jsonResponse({ accepted: true });
  }

  async alarm() {
    const shopId = await this.state.storage.get("shopId");
    const productId = await this.state.storage.get("productId");
    const requested = Number((await this.state.storage.get("desiredVersion")) || 0);
    if (!shopId || !productId) return;

    try {
      const result = await rebuildProjection(this.env, String(shopId), String(productId), requested);
      await this.state.storage.put("publishedVersion", result.publishedVersion);
      const storedDesired = Number((await this.state.storage.get("desiredVersion")) || 0);
      const latest = Math.max(storedDesired, Number(result.retryVersion || 0));
      if (latest > storedDesired) await this.state.storage.put("desiredVersion", latest);
      if (latest > result.publishedVersion) await this.state.storage.setAlarm(Date.now() + 100);
    } catch (error) {
      console.error("projection_do_failed", { shopId, productId, error: safeError(error) });
      await this.state.storage.setAlarm(Date.now() + 5000);
      throw error;
    }
  }
}

async function routeRequest(request, env, ctx) {
  const url = new URL(request.url);
  const path = url.pathname;

  if (request.method === "OPTIONS" && (path.startsWith("/api/public/") || path.startsWith("/cdn/"))) {
    return new Response(null, { status: 204, headers: corsHeaders(request.headers.get("origin") || "*") });
  }

  if (path === "/health") return jsonResponse({ ok: true, service: "shopify-reviews-cloudflare", environment: env.APP_ENV || "unknown" });
  if (path === "/") return Response.redirect(`${url.origin}/admin${url.search}`, 302);
  if (path === "/admin") return renderAdminPage(env, url);
  if (path === "/auth") return startOAuth(request, env);
  if (path === "/auth/callback") return finishOAuth(request, env);
  if (path.startsWith("/webhooks/")) return receiveWebhook(request, env);
  if (path.startsWith("/cdn/")) return serveProjectionObject(request, env);
  if (path.startsWith("/api/public/")) return handlePublicApi(request, env, ctx);
  if (path.startsWith("/api/admin/")) return handleAdminApi(request, env, ctx);
  if (path.startsWith("/api/dev/")) return handleDevApi(request, env, ctx);

  return errorResponse(404, "not_found", "Route not found.");
}

async function startOAuth(request, env) {
  const url = new URL(request.url);
  const shop = normalizeShopDomain(url.searchParams.get("shop"));
  if (!shop) return errorResponse(400, "invalid_shop", "A valid *.myshopify.com shop is required.");
  if (!env.SHOPIFY_API_KEY || !env.SHOPIFY_API_SECRET) return errorResponse(500, "missing_configuration", "Shopify credentials are not configured.");

  const state = crypto.randomUUID();
  const stateHash = await sha256Hex(state);
  const now = nowUnix();
  await env.DB.prepare("INSERT INTO oauth_states (state_hash, shop_domain, expires_at, created_at) VALUES (?, ?, ?, ?)")
    .bind(stateHash, shop, now + 600, now)
    .run();

  const redirectUri = `${env.APP_URL}/auth/callback`;
  const auth = new URL(`https://${shop}/admin/oauth/authorize`);
  auth.searchParams.set("client_id", env.SHOPIFY_API_KEY);
  auth.searchParams.set("scope", env.SHOPIFY_SCOPES || "read_products");
  auth.searchParams.set("redirect_uri", redirectUri);
  auth.searchParams.set("state", state);
  return Response.redirect(auth.toString(), 302);
}

async function finishOAuth(request, env) {
  const url = new URL(request.url);
  const shop = normalizeShopDomain(url.searchParams.get("shop"));
  const code = String(url.searchParams.get("code") || "");
  const state = String(url.searchParams.get("state") || "");
  if (!shop || !code || !state) return errorResponse(400, "invalid_oauth_callback", "Missing OAuth callback values.");
  if (!(await verifyShopifyQueryHmac(url.searchParams, env.SHOPIFY_API_SECRET))) return errorResponse(401, "invalid_hmac", "OAuth signature verification failed.");

  const stateHash = await sha256Hex(state);
  const stateRow = await env.DB.prepare("SELECT shop_domain, expires_at FROM oauth_states WHERE state_hash = ?").bind(stateHash).first();
  if (!stateRow || stateRow.shop_domain !== shop || Number(stateRow.expires_at) < nowUnix()) {
    return errorResponse(401, "invalid_state", "OAuth state is invalid or expired.");
  }

  const tokenResponse = await fetch(`https://${shop}/admin/oauth/access_token`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ client_id: env.SHOPIFY_API_KEY, client_secret: env.SHOPIFY_API_SECRET, code })
  });
  if (!tokenResponse.ok) {
    console.error("shopify_token_exchange_failed", await tokenResponse.text());
    return errorResponse(502, "token_exchange_failed", "Shopify access token exchange failed.");
  }
  const tokenData = await tokenResponse.json();
  const tokenEnc = await encryptString(String(tokenData.access_token), env.APP_ENCRYPTION_KEY || env.SHOPIFY_API_SECRET);
  const now = nowUnix();
  const shopId = crypto.randomUUID();
  const settingsJson = JSON.stringify(DEFAULT_SETTINGS);

  await env.DB.batch([
    env.DB.prepare(`INSERT INTO shops (shop_id, shop_domain, public_key, status, access_token_enc, scopes, installed_at, created_at, updated_at)
      VALUES (?, ?, ?, 'active', ?, ?, ?, ?, ?)
      ON CONFLICT(shop_domain) DO UPDATE SET status='active', access_token_enc=excluded.access_token_enc, scopes=excluded.scopes,
      installed_at=excluded.installed_at, uninstalled_at=NULL, updated_at=excluded.updated_at`)
      .bind(shopId, shop, shop, tokenEnc, String(tokenData.scope || env.SHOPIFY_SCOPES || ""), now, now, now),
    env.DB.prepare(`INSERT INTO settings_documents (shop_id, domain, schema_version, revision, document_json, updated_by, updated_at)
      SELECT shop_id, 'all', 1, 1, ?, 'system', ? FROM shops WHERE shop_domain=?
      ON CONFLICT(shop_id, domain) DO NOTHING`).bind(settingsJson, now, shop),
    env.DB.prepare("DELETE FROM oauth_states WHERE state_hash = ?").bind(stateHash)
  ]);

  return Response.redirect(`${env.APP_URL}/admin?shop=${encodeURIComponent(shop)}&host=${encodeURIComponent(url.searchParams.get("host") || "")}`, 302);
}

async function receiveWebhook(request, env) {
  if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });
  const rawBody = await request.arrayBuffer();
  const hmac = request.headers.get("x-shopify-hmac-sha256") || "";
  if (!(await verifyHmacBase64(rawBody, hmac, env.SHOPIFY_API_SECRET))) return new Response("Unauthorized", { status: 401 });

  const shopDomain = normalizeShopDomain(request.headers.get("x-shopify-shop-domain"));
  const topic = request.headers.get("x-shopify-topic") || new URL(request.url).pathname.split("/").pop() || "unknown";
  const deliveryId = request.headers.get("x-shopify-webhook-id") || request.headers.get("x-shopify-event-id") || crypto.randomUUID();
  const apiVersion = request.headers.get("x-shopify-api-version") || env.SHOPIFY_API_VERSION || "2026-07";
  if (!shopDomain) return new Response("Invalid shop", { status: 400 });

  const payloadText = decoder.decode(rawBody);
  const payloadHash = await sha256Hex(payloadText);
  const now = nowUnix();
  const insert = await env.DB.prepare(`INSERT OR IGNORE INTO webhook_receipts
    (delivery_id, shop_domain, topic, api_version, payload_hash, received_at, status)
    VALUES (?, ?, ?, ?, ?, ?, 'received')`)
    .bind(deliveryId, shopDomain, topic, apiVersion, payloadHash, now)
    .run();

  if (insert.meta?.changes) {
    await env.EVENTS.send({ kind: "webhook", deliveryId, shopDomain, topic, payloadText });
  }
  return new Response("OK", { status: 200 });
}

async function handlePublicApi(request, env, ctx) {
  const url = new URL(request.url);
  const parts = url.pathname.split("/").filter(Boolean);
  const origin = request.headers.get("origin") || "*";
  const headers = corsHeaders(origin);

  // /api/public/:shopKey/products/:productId/reviews
  if (parts.length === 6 && parts[3] === "products" && parts[5] === "reviews") {
    const shopKey = decodeURIComponent(parts[2]);
    const productId = decodeURIComponent(parts[4]);
    if (request.method === "GET") return withHeaders(await listPublicReviews(env, shopKey, productId, url), headers);
    if (request.method === "POST") return withHeaders(await submitReview(request, env, ctx, shopKey, productId), headers);
  }

  // /api/public/:shopKey/products/:productId/projection
  if (parts.length === 6 && parts[3] === "products" && parts[5] === "projection" && request.method === "GET") {
    const shopKey = decodeURIComponent(parts[2]);
    const productId = decodeURIComponent(parts[4]);
    const shop = await findShopByPublicKey(env, shopKey);
    if (!shop) return withHeaders(errorResponse(404, "shop_not_found", "Shop not found."), headers);
    const object = await env.PROJECTIONS.get(projectionObjectKey(shop.public_key, productId));
    if (!object) return withHeaders(errorResponse(404, "projection_not_found", "Projection not found."), headers);
    const responseHeaders = new Headers(headers);
    object.writeHttpMetadata(responseHeaders);
    responseHeaders.set("etag", object.httpEtag);
    return new Response(object.body, { headers: responseHeaders });
  }

  // /api/public/:shopKey/reviews/:reviewId/votes
  if (parts.length === 6 && parts[3] === "reviews" && parts[5] === "votes" && request.method === "POST") {
    const shopKey = decodeURIComponent(parts[2]);
    const reviewId = decodeURIComponent(parts[4]);
    return withHeaders(await submitVote(request, env, ctx, shopKey, reviewId), headers);
  }

  return withHeaders(errorResponse(404, "not_found", "Public API route not found."), headers);
}

async function listPublicReviews(env, shopKey, productId, url) {
  const shop = await findShopByPublicKey(env, shopKey);
  if (!shop) return errorResponse(404, "shop_not_found", "Shop not found.");
  const limit = Math.max(1, Math.min(50, Number(url.searchParams.get("limit") || 20)));
  const rating = Number(url.searchParams.get("rating") || 0);
  const cursor = decodeCursor(url.searchParams.get("cursor"));
  const params = [shop.shop_id, productId];
  let cursorSql = "";
  if (cursor) {
    cursorSql = "AND (r.created_at < ? OR (r.created_at = ? AND r.review_id < ?))";
    params.push(cursor.created_at, cursor.created_at, cursor.review_id);
  }
  let ratingSql = "";
  if (rating >= 1 && rating <= 5) {
    ratingSql = "AND r.rating = ?";
    params.push(rating);
  }
  params.push(limit + 1);

  const result = await env.DB.prepare(`SELECT r.review_id, r.product_id, r.rating, r.title, r.body, r.author_name,
      r.is_verified_purchase, r.helpful_count, r.not_helpful_count, r.language_code, r.created_at,
      sr.body AS seller_response_body, sr.updated_at AS seller_response_updated_at
    FROM reviews r
    LEFT JOIN seller_responses sr ON sr.shop_id=r.shop_id AND sr.review_id=r.review_id AND sr.deleted_at IS NULL
    WHERE r.shop_id=? AND r.product_id=? AND r.approval_status='approved' AND r.moderation_status='passed'
      AND r.visibility_status='visible' AND r.deleted_at IS NULL ${cursorSql} ${ratingSql}
    ORDER BY r.created_at DESC, r.review_id DESC LIMIT ?`)
    .bind(...params)
    .all();

  const rows = result.results || [];
  const hasMore = rows.length > limit;
  const items = rows.slice(0, limit).map(publicReviewDto);
  const last = items[items.length - 1];
  return jsonResponse({ reviews: items, next_cursor: hasMore && last ? encodeCursor({ created_at: last.created_at, review_id: last.review_id }) : null });
}

async function submitReview(request, env, ctx, shopKey, productId) {
  const shop = await findShopByPublicKey(env, shopKey);
  if (!shop || shop.status !== "active") return errorResponse(404, "shop_not_found", "Shop not found.");
  let body;
  try { body = await request.json(); } catch { return errorResponse(400, "invalid_json", "Request body must be JSON."); }
  const settings = await loadSettings(env, shop.shop_id);
  const validated = validateReviewInput(body, settings);
  if (!validated.ok) return errorResponse(422, "validation_failed", "Review validation failed.", validated.errors);
  if (!(await verifyTurnstileIfConfigured(request, body, env))) return errorResponse(403, "turnstile_failed", "Bot verification failed.");

  const idempotencyKey = String(request.headers.get("idempotency-key") || body.idempotency_key || "").trim();
  if (!idempotencyKey || idempotencyKey.length > 200) return errorResponse(400, "missing_idempotency_key", "Provide an Idempotency-Key header or idempotency_key field.");

  const existing = await env.DB.prepare("SELECT review_id, approval_status, approval_method, moderation_status, visibility_status FROM reviews WHERE shop_id=? AND submission_idempotency_key=?")
    .bind(shop.shop_id, idempotencyKey).first();
  if (existing) return jsonResponse({ review_id: existing.review_id, status: derivedStatus(existing), idempotent_replay: true }, { status: 200 });

  const now = nowUnix();
  const reviewId = crypto.randomUUID();
  const guestId = validated.value.email ? crypto.randomUUID() : null;
  const spam = basicSpamDecision(validated.value, settings);
  const autoApprove = spam.decision === "passed" && shouldAutoApprove({}, settings);
  const approvalStatus = autoApprove ? "approved" : (spam.decision === "spam" ? "rejected" : "pending");
  const approvalMethod = autoApprove ? settings.approval.mode : "manual";
  const moderationStatus = spam.decision;
  const outboxId = crypto.randomUUID();

  const statements = [
    env.DB.prepare(`INSERT INTO products (shop_id, product_id, created_at, updated_at)
      VALUES (?, ?, ?, ?) ON CONFLICT(shop_id, product_id) DO UPDATE SET updated_at=excluded.updated_at`)
      .bind(shop.shop_id, productId, now, now)
  ];
  if (guestId) {
    const encryptedEmail = await encryptString(validated.value.email, env.APP_ENCRYPTION_KEY || env.SHOPIFY_API_SECRET || "development-only-key");
    statements.push(env.DB.prepare(`INSERT INTO guest_identities
      (guest_identity_id, shop_id, email_enc, email_hash, verification_status, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'unverified', ?, ?)`)
      .bind(guestId, shop.shop_id, encryptedEmail, await sha256Hex(validated.value.email), now, now));
  }
  statements.push(
    env.DB.prepare(`INSERT INTO reviews
      (shop_id, review_id, product_id, guest_identity_id, author_name, rating, title, body,
       approval_status, approval_method, moderation_status, visibility_status, submission_idempotency_key,
       source, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'visible', ?, 'storefront', ?, ?)`)
      .bind(shop.shop_id, reviewId, productId, guestId, validated.value.authorName, validated.value.rating,
        validated.value.title, validated.value.body, approvalStatus, approvalMethod, moderationStatus, idempotencyKey, now, now),
    env.DB.prepare(`INSERT INTO review_status_history
      (history_id, shop_id, review_id, from_state, to_state, reason_code, actor_type, created_at)
      VALUES (?, ?, ?, NULL, ?, ?, 'system', ?)`)
      .bind(crypto.randomUUID(), shop.shop_id, reviewId, derivedStatus({ approval_status: approvalStatus, approval_method: approvalMethod, moderation_status: moderationStatus, visibility_status: "visible" }), spam.reason, now)
  );

  if (autoApprove) addApprovedAggregateStatements(statements, env, shop.shop_id, productId, validated.value.rating, 0, 0, now);
  statements.push(
    env.DB.prepare(`INSERT INTO outbox_events
      (event_id, shop_id, event_type, aggregate_id, aggregate_version, payload_json, occurred_at)
      VALUES (?, ?, ?, ?, 1, ?, ?)`)
      .bind(outboxId, shop.shop_id, autoApprove ? "ReviewDisplayEligibilityChanged" : "ReviewSubmitted", reviewId,
        JSON.stringify({ reviewId, productId, approvalStatus, moderationStatus }), now),
    auditStatement(env, shop.shop_id, "customer", null, "review.submit", "review", reviewId, { productId, approvalStatus, moderationStatus }, now)
  );

  try {
    await env.DB.batch(statements);
  } catch (error) {
    if (String(error).toLowerCase().includes("unique")) {
      const replay = await env.DB.prepare("SELECT review_id, approval_status, approval_method, moderation_status, visibility_status FROM reviews WHERE shop_id=? AND submission_idempotency_key=?")
        .bind(shop.shop_id, idempotencyKey).first();
      if (replay) return jsonResponse({ review_id: replay.review_id, status: derivedStatus(replay), idempotent_replay: true });
    }
    throw error;
  }
  ctx.waitUntil(env.EVENTS.send({ kind: "outbox", eventId: outboxId }).catch((error) => console.error("queue_send_failed", safeError(error))));
  return jsonResponse({ review_id: reviewId, status: derivedStatus({ approval_status: approvalStatus, approval_method: approvalMethod, moderation_status: moderationStatus, visibility_status: "visible" }), moderation_reason: spam.reason }, { status: 201 });
}

async function submitVote(request, env, ctx, shopKey, reviewId) {
  const shop = await findShopByPublicKey(env, shopKey);
  if (!shop) return errorResponse(404, "shop_not_found", "Shop not found.");
  let body;
  try { body = await request.json(); } catch { return errorResponse(400, "invalid_json", "Request body must be JSON."); }
  const voteType = body.vote_type === "not_helpful" ? "not_helpful" : "helpful";
  const fingerprintSource = String(body.voter_token || request.headers.get("cf-connecting-ip") || request.headers.get("user-agent") || "anonymous");
  const fingerprint = await sha256Hex(`${shop.shop_id}:${reviewId}:${fingerprintSource}`);
  const review = await env.DB.prepare("SELECT product_id FROM reviews WHERE shop_id=? AND review_id=? AND deleted_at IS NULL")
    .bind(shop.shop_id, reviewId).first();
  if (!review) return errorResponse(404, "review_not_found", "Review not found.");

  const now = nowUnix();
  const insert = await env.DB.prepare(`INSERT OR IGNORE INTO review_votes
      (shop_id, review_id, voter_fingerprint_hash, vote_type, created_at) VALUES (?, ?, ?, ?, ?)`)
    .bind(shop.shop_id, reviewId, fingerprint, voteType, now).run();
  if (!insert.meta?.changes) return jsonResponse({ accepted: true, changed: false });

  const eventId = crypto.randomUUID();
  await env.DB.batch([
    env.DB.prepare(`UPDATE reviews SET helpful_count=helpful_count+?, not_helpful_count=not_helpful_count+?, version=version+1, updated_at=?
      WHERE shop_id=? AND review_id=?`)
      .bind(voteType === "helpful" ? 1 : 0, voteType === "not_helpful" ? 1 : 0, now, shop.shop_id, reviewId),
    env.DB.prepare(`INSERT INTO product_projection_state (shop_id, product_id, desired_version, updated_at)
      VALUES (?, ?, 1, ?) ON CONFLICT(shop_id, product_id) DO UPDATE SET desired_version=desired_version+1, updated_at=excluded.updated_at`)
      .bind(shop.shop_id, review.product_id, now),
    env.DB.prepare(`INSERT INTO outbox_events (event_id, shop_id, event_type, aggregate_id, payload_json, occurred_at)
      VALUES (?, ?, 'ReviewVoteChanged', ?, ?, ?)`)
      .bind(eventId, shop.shop_id, reviewId, JSON.stringify({ reviewId, productId: review.product_id, voteType }), now)
  ]);
  ctx.waitUntil(env.EVENTS.send({ kind: "outbox", eventId }).catch(() => undefined));
  return jsonResponse({ accepted: true, changed: true });
}

async function handleAdminApi(request, env, ctx) {
  const auth = await authenticateAdmin(request, env);
  if (!auth.ok) return errorResponse(auth.status || 401, "unauthorized", auth.message || "Admin authentication failed.");
  const url = new URL(request.url);
  const path = url.pathname;
  const shop = auth.shop;

  if (path === "/api/admin/bootstrap" && request.method === "GET") {
    const counts = await env.DB.prepare(`SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN approval_status='pending' THEN 1 ELSE 0 END) AS pending,
      SUM(CASE WHEN approval_status='approved' AND moderation_status='passed' AND visibility_status='visible' THEN 1 ELSE 0 END) AS approved,
      SUM(CASE WHEN moderation_status='spam' THEN 1 ELSE 0 END) AS spam
      FROM reviews WHERE shop_id=? AND deleted_at IS NULL`).bind(shop.shop_id).first();
    const products = await env.DB.prepare("SELECT product_id, title, handle FROM products WHERE shop_id=? ORDER BY updated_at DESC LIMIT 100")
      .bind(shop.shop_id).all();
    return jsonResponse({ shop: publicShopDto(shop), counts: normalizeCountRow(counts), products: products.results || [], settings: await loadSettings(env, shop.shop_id) });
  }

  if (path === "/api/admin/reviews" && request.method === "GET") {
    const status = String(url.searchParams.get("status") || "all");
    const productId = String(url.searchParams.get("product_id") || "");
    const limit = Math.max(1, Math.min(100, Number(url.searchParams.get("limit") || 50)));
    const params = [shop.shop_id];
    let where = "r.shop_id=? AND r.deleted_at IS NULL";
    if (status === "pending") where += " AND r.approval_status='pending'";
    if (status === "approved") where += " AND r.approval_status='approved' AND r.moderation_status='passed' AND r.visibility_status='visible'";
    if (status === "spam") where += " AND r.moderation_status='spam'";
    if (status === "hidden") where += " AND r.visibility_status='hidden'";
    if (productId) { where += " AND r.product_id=?"; params.push(productId); }
    params.push(limit);
    const result = await env.DB.prepare(`SELECT r.*, sr.body AS seller_response_body FROM reviews r
      LEFT JOIN seller_responses sr ON sr.shop_id=r.shop_id AND sr.review_id=r.review_id AND sr.deleted_at IS NULL
      WHERE ${where} ORDER BY r.created_at DESC, r.review_id DESC LIMIT ?`).bind(...params).all();
    return jsonResponse({ reviews: (result.results || []).map(adminReviewDto) });
  }

  const reviewMatch = path.match(/^\/api\/admin\/reviews\/([^/]+)$/);
  if (reviewMatch && request.method === "PATCH") {
    const reviewId = decodeURIComponent(reviewMatch[1]);
    let body;
    try { body = await request.json(); } catch { return errorResponse(400, "invalid_json", "Request body must be JSON."); }
    const result = await mutateReviewStatus(env, shop, reviewId, body.action, auth.actorId);
    if (!result) return errorResponse(404, "review_not_found", "Review not found.");
    ctx.waitUntil(env.EVENTS.send({ kind: "outbox", eventId: result.eventId }).catch(() => undefined));
    return jsonResponse({ review: result.review });
  }

  const responseMatch = path.match(/^\/api\/admin\/reviews\/([^/]+)\/response$/);
  if (responseMatch && request.method === "PUT") {
    const reviewId = decodeURIComponent(responseMatch[1]);
    const body = await request.json();
    const text = String(body.body || "").trim();
    if (!text || text.length > 2000) return errorResponse(422, "validation_failed", "Seller response must be 1 to 2000 characters.");
    const review = await env.DB.prepare("SELECT product_id FROM reviews WHERE shop_id=? AND review_id=? AND deleted_at IS NULL").bind(shop.shop_id, reviewId).first();
    if (!review) return errorResponse(404, "review_not_found", "Review not found.");
    const now = nowUnix();
    const eventId = crypto.randomUUID();
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO seller_responses (shop_id, review_id, body, responder_user_id, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(shop_id, review_id) DO UPDATE SET body=excluded.body,
        response_version=response_version+1, responder_user_id=excluded.responder_user_id, updated_at=excluded.updated_at, deleted_at=NULL`)
        .bind(shop.shop_id, reviewId, text, auth.actorId, now, now),
      env.DB.prepare(`INSERT INTO product_projection_state (shop_id, product_id, desired_version, updated_at)
        VALUES (?, ?, 1, ?) ON CONFLICT(shop_id, product_id) DO UPDATE SET desired_version=desired_version+1, updated_at=excluded.updated_at`)
        .bind(shop.shop_id, review.product_id, now),
      env.DB.prepare(`INSERT INTO outbox_events (event_id, shop_id, event_type, aggregate_id, payload_json, occurred_at)
        VALUES (?, ?, 'SellerResponseChanged', ?, ?, ?)`)
        .bind(eventId, shop.shop_id, reviewId, JSON.stringify({ reviewId, productId: review.product_id }), now)
    ]);
    ctx.waitUntil(env.EVENTS.send({ kind: "outbox", eventId }).catch(() => undefined));
    return jsonResponse({ saved: true });
  }

  if (path === "/api/admin/settings" && request.method === "GET") return jsonResponse({ settings: await loadSettings(env, shop.shop_id) });
  if (path === "/api/admin/settings" && request.method === "PUT") {
    let input;
    try { input = await request.json(); } catch { return errorResponse(400, "invalid_json", "Request body must be JSON."); }
    const existing = await loadSettingsRow(env, shop.shop_id);
    const merged = mergeSettings(input.settings || input);
    const validation = validateSettings(merged);
    if (validation.length) return errorResponse(422, "validation_failed", "Settings are invalid.", validation);
    const now = nowUnix();
    const nextRevision = Number(existing?.revision || 0) + 1;
    const eventId = crypto.randomUUID();
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO settings_documents (shop_id, domain, schema_version, revision, document_json, updated_by, updated_at)
        VALUES (?, 'all', 1, ?, ?, ?, ?) ON CONFLICT(shop_id, domain) DO UPDATE SET
        revision=excluded.revision, document_json=excluded.document_json, updated_by=excluded.updated_by, updated_at=excluded.updated_at`)
        .bind(shop.shop_id, nextRevision, JSON.stringify(merged), auth.actorId, now),
      env.DB.prepare(`INSERT INTO settings_change_log (change_id, shop_id, domain, before_json, after_json, actor_id, reason, created_at)
        VALUES (?, ?, 'all', ?, ?, ?, 'admin_save', ?)`)
        .bind(crypto.randomUUID(), shop.shop_id, existing?.document_json || null, JSON.stringify(merged), auth.actorId, now),
      env.DB.prepare(`INSERT INTO outbox_events (event_id, shop_id, event_type, aggregate_id, aggregate_version, payload_json, occurred_at)
        VALUES (?, ?, 'SettingsChanged', ?, ?, ?, ?)`)
        .bind(eventId, shop.shop_id, shop.shop_id, nextRevision, JSON.stringify({ effects: ["REBUILD_PRODUCT_CACHE"] }), now),
      auditStatement(env, shop.shop_id, "admin", auth.actorId, "settings.update", "settings", "all", { revision: nextRevision }, now)
    ]);
    ctx.waitUntil(env.EVENTS.send({ kind: "outbox", eventId }).catch(() => undefined));
    return jsonResponse({ settings: merged, revision: nextRevision });
  }

  if (path === "/api/admin/rebuild" && request.method === "POST") {
    const body = await request.json();
    const productId = String(body.product_id || "").trim();
    if (!productId) return errorResponse(422, "missing_product_id", "product_id is required.");
    const desiredVersion = await bumpProjectionVersion(env, shop.shop_id, productId);
    ctx.waitUntil(requestProjection(env, shop.shop_id, productId, desiredVersion));
    return jsonResponse({ queued: true, product_id: productId, desired_version: desiredVersion });
  }

  return errorResponse(404, "not_found", "Admin API route not found.");
}

async function handleDevApi(request, env, ctx) {
  if (env.APP_ENV !== "development") return errorResponse(404, "not_found", "Route not found.");
  if (!timingSafeEqual(request.headers.get("x-dev-admin-token") || "", env.DEV_ADMIN_TOKEN || "")) {
    return errorResponse(401, "unauthorized", "Invalid development token.");
  }
  const path = new URL(request.url).pathname;
  if (path === "/api/dev/seed" && request.method === "POST") {
    const result = await seedDemoData(env, ctx);
    return jsonResponse(result, { status: 201 });
  }
  return errorResponse(404, "not_found", "Development route not found.");
}

async function authenticateAdmin(request, env) {
  const url = new URL(request.url);
  if (env.APP_ENV === "development" && timingSafeEqual(request.headers.get("x-dev-admin-token") || "", env.DEV_ADMIN_TOKEN || "")) {
    const domain = normalizeShopDomain(url.searchParams.get("shop") || env.DEV_SHOP_DOMAIN);
    const shop = domain ? await findShopByDomain(env, domain) : null;
    if (!shop) return { ok: false, status: 404, message: "Development shop is not seeded." };
    return { ok: true, shop, actorId: "dev-admin" };
  }

  const authHeader = request.headers.get("authorization") || "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
  if (!token) return { ok: false, status: 401, message: "A Shopify session token is required." };
  const payload = await verifyShopifySessionToken(token, env);
  if (!payload) return { ok: false, status: 401, message: "Shopify session token is invalid." };
  const domain = normalizeShopDomain(String(payload.dest || ""));
  const shop = await findShopByDomain(env, domain);
  if (!shop || shop.status !== "active") return { ok: false, status: 403, message: "Shop is not installed." };
  return { ok: true, shop, actorId: String(payload.sub || "shopify-user") };
}

async function mutateReviewStatus(env, shop, reviewId, action, actorId) {
  const review = await env.DB.prepare("SELECT * FROM reviews WHERE shop_id=? AND review_id=? AND deleted_at IS NULL").bind(shop.shop_id, reviewId).first();
  if (!review) return null;
  const beforeEligible = isDisplayEligible(review);
  const next = { approval_status: review.approval_status, moderation_status: review.moderation_status, visibility_status: review.visibility_status, approval_method: review.approval_method };
  if (action === "approve") { next.approval_status = "approved"; next.moderation_status = "passed"; next.visibility_status = "visible"; next.approval_method = "manual"; }
  else if (action === "reject") next.approval_status = "rejected";
  else if (action === "spam") { next.moderation_status = "spam"; next.approval_status = "rejected"; }
  else if (action === "hide") next.visibility_status = "hidden";
  else if (action === "unhide") next.visibility_status = "visible";
  else return null;
  const afterEligible = isDisplayEligible(next);
  const now = nowUnix();
  const statements = [
    env.DB.prepare(`UPDATE reviews SET approval_status=?, approval_method=?, moderation_status=?, visibility_status=?, version=version+1, updated_at=?
      WHERE shop_id=? AND review_id=?`)
      .bind(next.approval_status, next.approval_method, next.moderation_status, next.visibility_status, now, shop.shop_id, reviewId),
    env.DB.prepare(`INSERT INTO review_status_history (history_id, shop_id, review_id, from_state, to_state, reason_code, actor_type, actor_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?, 'admin', ?, ?)`)
      .bind(crypto.randomUUID(), shop.shop_id, reviewId, derivedStatus(review), derivedStatus(next), `admin_${action}`, actorId, now)
  ];

  if (beforeEligible !== afterEligible) {
    const direction = afterEligible ? 1 : -1;
    addApprovedAggregateStatements(statements, env, shop.shop_id, review.product_id, Number(review.rating), Number(review.is_verified_purchase || 0), Number(review.recommend_product || 0), now, direction);
  } else if (beforeEligible && afterEligible) {
    statements.push(env.DB.prepare(`INSERT INTO product_projection_state (shop_id, product_id, desired_version, updated_at)
      VALUES (?, ?, 1, ?) ON CONFLICT(shop_id, product_id) DO UPDATE SET desired_version=desired_version+1, updated_at=excluded.updated_at`)
      .bind(shop.shop_id, review.product_id, now));
  }

  const eventId = crypto.randomUUID();
  statements.push(
    env.DB.prepare(`INSERT INTO outbox_events (event_id, shop_id, event_type, aggregate_id, aggregate_version, payload_json, occurred_at)
      VALUES (?, ?, 'ReviewDisplayEligibilityChanged', ?, ?, ?, ?)`)
      .bind(eventId, shop.shop_id, reviewId, Number(review.version || 1) + 1, JSON.stringify({ reviewId, productId: review.product_id, action }), now),
    auditStatement(env, shop.shop_id, "admin", actorId, `review.${action}`, "review", reviewId, {}, now)
  );
  await env.DB.batch(statements);
  const updated = await env.DB.prepare("SELECT * FROM reviews WHERE shop_id=? AND review_id=?").bind(shop.shop_id, reviewId).first();
  return { eventId, review: adminReviewDto(updated) };
}

function addApprovedAggregateStatements(statements, env, shopId, productId, rating, verified, recommended, now, direction = 1) {
  const buckets = [1, 2, 3, 4, 5].map((value) => value === rating ? direction : 0);
  statements.push(
    env.DB.prepare(`INSERT INTO product_review_aggregates
      (shop_id, product_id, approved_count, rating_sum, rating_1, rating_2, rating_3, rating_4, rating_5, verified_count, recommended_count, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(shop_id, product_id) DO UPDATE SET
        approved_count=MAX(0, approved_count+excluded.approved_count),
        rating_sum=MAX(0, rating_sum+excluded.rating_sum),
        rating_1=MAX(0, rating_1+excluded.rating_1), rating_2=MAX(0, rating_2+excluded.rating_2),
        rating_3=MAX(0, rating_3+excluded.rating_3), rating_4=MAX(0, rating_4+excluded.rating_4),
        rating_5=MAX(0, rating_5+excluded.rating_5), verified_count=MAX(0, verified_count+excluded.verified_count),
        recommended_count=MAX(0, recommended_count+excluded.recommended_count), updated_at=excluded.updated_at`)
      .bind(shopId, productId, direction, direction * rating, ...buckets, direction * verified, direction * recommended, now),
    env.DB.prepare(`INSERT INTO product_projection_state (shop_id, product_id, desired_version, updated_at)
      VALUES (?, ?, 1, ?) ON CONFLICT(shop_id, product_id) DO UPDATE SET desired_version=desired_version+1, updated_at=excluded.updated_at`)
      .bind(shopId, productId, now)
  );
}

async function handleQueueMessage(body, env, ctx) {
  if (!body || typeof body !== "object") return;
  if (body.kind === "webhook") return processWebhookMessage(body, env, ctx);
  if (body.kind === "projection") return requestProjection(env, body.shopId, body.productId, body.desiredVersion);
  if (body.kind !== "outbox") return;

  const event = await env.DB.prepare("SELECT * FROM outbox_events WHERE event_id=?").bind(body.eventId).first();
  if (!event || event.delivered_at) return;
  const payload = parseJson(event.payload_json, {});
  try {
    if (["ReviewDisplayEligibilityChanged", "ReviewVoteChanged", "SellerResponseChanged"].includes(event.event_type)) {
      const version = await currentDesiredVersion(env, event.shop_id, payload.productId);
      await requestProjection(env, event.shop_id, payload.productId, version);
    } else if (event.event_type === "SettingsChanged") {
      await queueShopProjectionRebuilds(env, event.shop_id);
    }
    await env.DB.prepare("UPDATE outbox_events SET delivered_at=?, attempt_count=attempt_count+1, last_error=NULL WHERE event_id=?")
      .bind(nowUnix(), event.event_id).run();
  } catch (error) {
    await env.DB.prepare("UPDATE outbox_events SET attempt_count=attempt_count+1, last_error=? WHERE event_id=?")
      .bind(safeError(error).slice(0, 500), event.event_id).run();
    throw error;
  }
}

async function processWebhookMessage(message, env, ctx) {
  const payload = parseJson(message.payloadText, {});
  const topic = String(message.topic || "").toLowerCase();
  const shop = await findShopByDomain(env, message.shopDomain);
  const now = nowUnix();
  try {
    if (topic === "app/uninstalled" && shop) {
      await env.DB.prepare("UPDATE shops SET status='disabled', uninstalled_at=?, updated_at=? WHERE shop_id=?").bind(now, now, shop.shop_id).run();
    } else if ((topic === "products/create" || topic === "products/update") && shop) {
      const productId = String(payload.id || "");
      if (productId) {
        await env.DB.prepare(`INSERT INTO products (shop_id, product_id, product_gid, handle, title, status, shopify_updated_at, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(shop_id, product_id) DO UPDATE SET
          product_gid=excluded.product_gid, handle=excluded.handle, title=excluded.title, status=excluded.status,
          shopify_updated_at=excluded.shopify_updated_at, updated_at=excluded.updated_at`)
          .bind(shop.shop_id, productId, payload.admin_graphql_api_id || null, payload.handle || null, payload.title || null,
            payload.status || "active", Math.floor(new Date(payload.updated_at || Date.now()).getTime() / 1000), now, now).run();
      }
    } else if (topic === "products/delete" && shop) {
      const productId = String(payload.id || "");
      if (productId) {
        await env.DB.prepare("DELETE FROM products WHERE shop_id=? AND product_id=?").bind(shop.shop_id, productId).run();
        await env.PROJECTIONS.delete(projectionObjectKey(shop.public_key, productId));
      }
    } else if ((topic === "customers/redact" || topic === "customers/data_request") && shop) {
      const customerId = payload.customer?.id ? String(payload.customer.id) : null;
      if (topic === "customers/redact" && customerId) {
        await env.DB.prepare("UPDATE reviews SET customer_id=NULL, updated_at=? WHERE shop_id=? AND customer_id=?").bind(now, shop.shop_id, customerId).run();
      }
      await env.DB.prepare(`INSERT INTO audit_events (audit_id, shop_id, actor_type, action, resource_type, resource_id, metadata_json, created_at)
        VALUES (?, ?, 'shopify', ?, 'privacy_request', ?, ?, ?)`)
        .bind(crypto.randomUUID(), shop.shop_id, topic, message.deliveryId, JSON.stringify({ customerId }), now).run();
    } else if (topic === "shop/redact" && shop) {
      await deleteShopProjectionObjects(env, shop.public_key);
      await env.DB.prepare("DELETE FROM shops WHERE shop_id=?").bind(shop.shop_id).run();
    }
    await env.DB.prepare("UPDATE webhook_receipts SET status='processed', processed_at=?, attempt_count=attempt_count+1, last_error=NULL WHERE delivery_id=?")
      .bind(now, message.deliveryId).run();
  } catch (error) {
    await env.DB.prepare("UPDATE webhook_receipts SET status='failed', attempt_count=attempt_count+1, last_error=? WHERE delivery_id=?")
      .bind(safeError(error).slice(0, 500), message.deliveryId).run();
    throw error;
  }
}

async function requestProjection(env, shopId, productId, desiredVersion) {
  if (!shopId || !productId) return;
  const id = env.PROJECTION_COORDINATOR.idFromName(`${shopId}:${productId}`);
  const stub = env.PROJECTION_COORDINATOR.get(id);
  const response = await stub.fetch("https://projection/request", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ shopId, productId, desiredVersion: Number(desiredVersion || 0) })
  });
  if (!response.ok) throw new Error(`Projection coordinator returned ${response.status}`);
}

async function rebuildProjection(env, shopId, productId, requestedVersion) {
  const state = await env.DB.prepare("SELECT * FROM product_projection_state WHERE shop_id=? AND product_id=?").bind(shopId, productId).first();
  if (!state) return { publishedVersion: 0 };
  const desiredVersion = Math.max(Number(state.desired_version || 0), Number(requestedVersion || 0));
  if (Number(state.published_version || 0) >= desiredVersion) return { publishedVersion: Number(state.published_version) };
  const shop = await env.DB.prepare("SELECT * FROM shops WHERE shop_id=? AND status='active'").bind(shopId).first();
  const product = await env.DB.prepare("SELECT * FROM products WHERE shop_id=? AND product_id=?").bind(shopId, productId).first();
  if (!shop || !product) return { publishedVersion: Number(state.published_version || 0) };
  const settings = await loadSettings(env, shopId);
  const aggregate = await env.DB.prepare("SELECT * FROM product_review_aggregates WHERE shop_id=? AND product_id=?").bind(shopId, productId).first();
  const rows = await env.DB.prepare(`SELECT r.review_id, r.rating, r.title, r.body, r.author_name, r.is_verified_purchase,
      r.helpful_count, r.language_code, r.created_at, sr.body AS seller_response_body, sr.updated_at AS seller_response_updated_at
    FROM reviews r LEFT JOIN seller_responses sr ON sr.shop_id=r.shop_id AND sr.review_id=r.review_id AND sr.deleted_at IS NULL
    WHERE r.shop_id=? AND r.product_id=? AND r.approval_status='approved' AND r.moderation_status='passed'
      AND r.visibility_status='visible' AND r.deleted_at IS NULL
    ORDER BY r.created_at DESC, r.review_id DESC LIMIT 500`)
    .bind(shopId, productId).all();
  const pins = await env.DB.prepare("SELECT review_id, position FROM product_pins WHERE shop_id=? AND product_id=? ORDER BY position ASC")
    .bind(shopId, productId).all();
  const selected = selectProjectionReviews(rows.results || [], pins.results || [], settings);
  const count = Number(aggregate?.approved_count || 0);
  const ratingSum = Number(aggregate?.rating_sum || 0);
  const projection = {
    schema_version: 1,
    cache_version: desiredVersion,
    shop_public_id: shop.public_key,
    product_id: productId,
    product_handle: product.handle || null,
    product_title: product.title || null,
    statistics: {
      average_rating: count ? Number((ratingSum / count).toFixed(2)) : 0,
      total_review_count: count,
      rating_distribution: {
        "1": Number(aggregate?.rating_1 || 0), "2": Number(aggregate?.rating_2 || 0), "3": Number(aggregate?.rating_3 || 0),
        "4": Number(aggregate?.rating_4 || 0), "5": Number(aggregate?.rating_5 || 0)
      },
      verified_purchase_percentage: count ? Number((Number(aggregate?.verified_count || 0) * 100 / count).toFixed(1)) : 0,
      media_review_percentage: count ? Number((Number(aggregate?.media_count || 0) * 100 / count).toFixed(1)) : 0,
      recommend_percentage: count ? Number((Number(aggregate?.recommended_count || 0) * 100 / count).toFixed(1)) : 0
    },
    ai_summary: { enabled: false, text: null },
    reviews: selected.map(publicReviewDto),
    selection: {
      mode: "hybrid",
      primary: settings.display.primarySort,
      fallback: settings.display.fallbackSort,
      pinned_review_ids: (pins.results || []).map((pin) => pin.review_id)
    },
    last_updated: new Date().toISOString()
  };

  const latestBeforePut = await currentDesiredVersion(env, shopId, productId);
  if (latestBeforePut > desiredVersion) {
    return { publishedVersion: Number(state.published_version || 0), retryVersion: latestBeforePut };
  }
  const key = projectionObjectKey(shop.public_key, productId);
  const object = await env.PROJECTIONS.put(key, JSON.stringify(projection), {
    httpMetadata: {
      contentType: "application/json; charset=utf-8",
      cacheControl: `public, max-age=${Math.max(10, Number(env.PROJECTION_CACHE_SECONDS || 60))}`
    },
    customMetadata: { cacheVersion: String(desiredVersion), shopId, productId }
  });
  const now = nowUnix();
  await env.DB.prepare(`UPDATE product_projection_state SET published_version=?, published_at=?, object_etag=?, last_error=NULL, updated_at=?
    WHERE shop_id=? AND product_id=? AND desired_version<=? AND published_version<?`)
    .bind(desiredVersion, now, object?.etag || null, now, shopId, productId, desiredVersion, desiredVersion).run();
  const desiredAfterPut = await currentDesiredVersion(env, shopId, productId);
  return { publishedVersion: desiredVersion, key, retryVersion: desiredAfterPut > desiredVersion ? desiredAfterPut : 0 };
}

async function serveProjectionObject(request, env) {
  if (request.method !== "GET" && request.method !== "HEAD") return new Response("Method not allowed", { status: 405 });
  const path = new URL(request.url).pathname.replace(/^\/cdn\//, "");
  if (!path.startsWith("v1/shops/") || path.includes("..")) return errorResponse(400, "invalid_key", "Invalid projection key.");
  const object = await env.PROJECTIONS.get(path);
  if (!object) return errorResponse(404, "not_found", "Projection not found.");
  const headers = new Headers(corsHeaders("*"));
  object.writeHttpMetadata(headers);
  headers.set("etag", object.httpEtag);
  headers.set("x-cache-version", object.customMetadata?.cacheVersion || "0");
  return new Response(request.method === "HEAD" ? null : object.body, { headers });
}

async function publishPendingOutbox(env) {
  const rows = await env.DB.prepare("SELECT event_id FROM outbox_events WHERE delivered_at IS NULL ORDER BY occurred_at ASC LIMIT 100").all();
  for (const row of rows.results || []) {
    try { await env.EVENTS.send({ kind: "outbox", eventId: row.event_id }); }
    catch (error) { console.error("outbox_publish_failed", { eventId: row.event_id, error: safeError(error) }); }
  }
}

async function repairLaggingProjections(env) {
  const rows = await env.DB.prepare(`SELECT shop_id, product_id, desired_version FROM product_projection_state
    WHERE desired_version>published_version ORDER BY updated_at ASC LIMIT 100`).all();
  for (const row of rows.results || []) {
    try { await env.EVENTS.send({ kind: "projection", shopId: row.shop_id, productId: row.product_id, desiredVersion: row.desired_version }); }
    catch (error) { console.error("projection_repair_enqueue_failed", safeError(error)); }
  }
}

async function queueShopProjectionRebuilds(env, shopId) {
  const products = await env.DB.prepare("SELECT product_id FROM products WHERE shop_id=? ORDER BY updated_at DESC LIMIT 500").bind(shopId).all();
  for (const product of products.results || []) {
    const desiredVersion = await bumpProjectionVersion(env, shopId, product.product_id);
    await env.EVENTS.send({ kind: "projection", shopId, productId: product.product_id, desiredVersion });
  }
}

async function bumpProjectionVersion(env, shopId, productId) {
  const now = nowUnix();
  await env.DB.prepare(`INSERT INTO product_projection_state (shop_id, product_id, desired_version, updated_at)
    VALUES (?, ?, 1, ?) ON CONFLICT(shop_id, product_id) DO UPDATE SET desired_version=desired_version+1, updated_at=excluded.updated_at`)
    .bind(shopId, productId, now).run();
  return currentDesiredVersion(env, shopId, productId);
}

async function currentDesiredVersion(env, shopId, productId) {
  if (!productId) return 0;
  const row = await env.DB.prepare("SELECT desired_version FROM product_projection_state WHERE shop_id=? AND product_id=?").bind(shopId, productId).first();
  return Number(row?.desired_version || 0);
}

async function loadSettingsRow(env, shopId) {
  return env.DB.prepare("SELECT revision, document_json FROM settings_documents WHERE shop_id=? AND domain='all'").bind(shopId).first();
}

async function loadSettings(env, shopId) {
  const row = await loadSettingsRow(env, shopId);
  return mergeSettings(row ? parseJson(row.document_json, {}) : {});
}

function validateSettings(settings) {
  const errors = [];
  const validApproval = ["manual", "automatic_all", "automatic_verified", "automatic_registered"];
  const validSort = ["newest", "oldest", "most_helpful", "highest_rating", "lowest_rating"];
  if (!validApproval.includes(settings.approval.mode)) errors.push("approval.mode is invalid");
  if (!validSort.includes(settings.display.primarySort)) errors.push("display.primarySort is invalid");
  if (!validSort.includes(settings.display.fallbackSort)) errors.push("display.fallbackSort is invalid");
  if (Number(settings.display.cachedReviewCount) < 1 || Number(settings.display.cachedReviewCount) > 50) errors.push("display.cachedReviewCount must be 1 to 50");
  if (!Array.isArray(settings.spam.bannedPhrases) || settings.spam.bannedPhrases.length > 200) errors.push("spam.bannedPhrases must be an array of at most 200 phrases");
  return errors;
}

async function seedDemoData(env, ctx) {
  const domain = normalizeShopDomain(env.DEV_SHOP_DOMAIN || "demo-shop.myshopify.com");
  const existing = await findShopByDomain(env, domain);
  const shopId = existing?.shop_id || crypto.randomUUID();
  const now = nowUnix();
  const productId = "8750123456789";
  const reviews = [
    { id: "demo-review-1", rating: 5, title: "Excellent fit", body: "Comfortable, true to size, and the fabric feels premium.", author: "A. Customer", helpful: 18, age: 86400 },
    { id: "demo-review-2", rating: 4, title: "Great everyday shirt", body: "The color matches the photos and it has held up well after washing.", author: "M. Patel", helpful: 7, age: 172800 },
    { id: "demo-review-3", rating: 5, title: "Would buy again", body: "Fast delivery and a very clean finish. I ordered another color.", author: "Jordan", helpful: 11, age: 259200 }
  ];
  const statements = [
    env.DB.prepare(`INSERT INTO shops (shop_id, shop_domain, public_key, status, scopes, installed_at, created_at, updated_at)
      VALUES (?, ?, ?, 'active', 'read_products', ?, ?, ?) ON CONFLICT(shop_domain) DO UPDATE SET status='active', updated_at=excluded.updated_at`)
      .bind(shopId, domain, domain, now, now, now),
    env.DB.prepare(`INSERT INTO products (shop_id, product_id, product_gid, handle, title, status, created_at, updated_at)
      VALUES (?, ?, ?, 'classic-tee', 'Classic Tee', 'active', ?, ?) ON CONFLICT(shop_id, product_id) DO UPDATE SET title=excluded.title, handle=excluded.handle, updated_at=excluded.updated_at`)
      .bind(shopId, productId, `gid://shopify/Product/${productId}`, now, now),
    env.DB.prepare(`INSERT INTO settings_documents (shop_id, domain, schema_version, revision, document_json, updated_by, updated_at)
      VALUES (?, 'all', 1, 1, ?, 'seed', ?) ON CONFLICT(shop_id, domain) DO UPDATE SET document_json=excluded.document_json, updated_at=excluded.updated_at`)
      .bind(shopId, JSON.stringify(DEFAULT_SETTINGS), now),
    env.DB.prepare("DELETE FROM reviews WHERE shop_id=? AND product_id=? AND source='demo'").bind(shopId, productId),
    env.DB.prepare("DELETE FROM product_review_aggregates WHERE shop_id=? AND product_id=?").bind(shopId, productId)
  ];
  for (const review of reviews) {
    statements.push(env.DB.prepare(`INSERT INTO reviews
      (shop_id, review_id, product_id, author_name, rating, title, body, approval_status, approval_method,
       moderation_status, visibility_status, helpful_count, submission_idempotency_key, source, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'approved', 'automatic_all', 'passed', 'visible', ?, ?, 'demo', ?, ?)`)
      .bind(shopId, review.id, productId, review.author, review.rating, review.title, review.body, review.helpful,
        `demo-${review.id}`, now - review.age, now - review.age));
  }
  const counts = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  for (const review of reviews) counts[review.rating] += 1;
  statements.push(
    env.DB.prepare(`INSERT INTO product_review_aggregates
      (shop_id, product_id, approved_count, rating_sum, rating_1, rating_2, rating_3, rating_4, rating_5, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(shopId, productId, reviews.length, reviews.reduce((sum, review) => sum + review.rating, 0), counts[1], counts[2], counts[3], counts[4], counts[5], now),
    env.DB.prepare(`INSERT INTO product_projection_state (shop_id, product_id, desired_version, published_version, updated_at)
      VALUES (?, ?, 1, 0, ?) ON CONFLICT(shop_id, product_id) DO UPDATE SET desired_version=desired_version+1, updated_at=excluded.updated_at`)
      .bind(shopId, productId, now)
  );
  await env.DB.batch(statements);
  const desiredVersion = await currentDesiredVersion(env, shopId, productId);
  ctx.waitUntil(requestProjection(env, shopId, productId, desiredVersion));
  return { seeded: true, shop: domain, product_id: productId, admin_url: `${env.APP_URL}/admin?shop=${encodeURIComponent(domain)}`, projection_url: `${env.PUBLIC_CDN_BASE}/${projectionObjectKey(domain, productId)}` };
}

async function findShopByPublicKey(env, key) {
  const decoded = decodeURIComponent(String(key || "")).toLowerCase();
  return env.DB.prepare("SELECT * FROM shops WHERE (public_key=? OR shop_domain=?) AND status='active'").bind(decoded, decoded).first();
}

async function findShopByDomain(env, domain) {
  return env.DB.prepare("SELECT * FROM shops WHERE shop_domain=?").bind(domain).first();
}

async function verifyTurnstileIfConfigured(request, body, env) {
  if (!env.TURNSTILE_SECRET) return true;
  const token = String(body.turnstile_token || body["cf-turnstile-response"] || "");
  if (!token) return false;
  const form = new FormData();
  form.set("secret", env.TURNSTILE_SECRET);
  form.set("response", token);
  const ip = request.headers.get("cf-connecting-ip");
  if (ip) form.set("remoteip", ip);
  const response = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", { method: "POST", body: form });
  const result = await response.json();
  return result.success === true;
}

async function verifyShopifySessionToken(token, env) {
  const parts = token.split(".");
  if (parts.length !== 3 || !env.SHOPIFY_API_SECRET) return null;
  const [headerPart, payloadPart, signaturePart] = parts;
  const header = parseJson(decoder.decode(base64UrlDecode(headerPart)), {});
  const payload = parseJson(decoder.decode(base64UrlDecode(payloadPart)), {});
  if (header.alg !== "HS256") return null;
  const key = await crypto.subtle.importKey("raw", encoder.encode(env.SHOPIFY_API_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(`${headerPart}.${payloadPart}`)));
  if (!timingSafeEqual(signature, base64UrlDecode(signaturePart))) return null;
  const now = nowUnix();
  if (Number(payload.exp || 0) < now || Number(payload.nbf || 0) > now + 30) return null;
  const audiences = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!audiences.includes(env.SHOPIFY_API_KEY)) return null;
  if (!normalizeShopDomain(payload.dest)) return null;
  return payload;
}

async function verifyShopifyQueryHmac(searchParams, secret) {
  if (!secret) return false;
  const provided = searchParams.get("hmac") || "";
  const pairs = [];
  for (const [key, value] of searchParams.entries()) {
    if (key !== "hmac" && key !== "signature") pairs.push([key, value]);
  }
  pairs.sort(([a], [b]) => a.localeCompare(b));
  const message = pairs.map(([key, value]) => `${key}=${value}`).join("&");
  const expected = await hmacHex(message, secret);
  return timingSafeEqual(expected, provided);
}

async function verifyHmacBase64(data, provided, secret) {
  if (!secret || !provided) return false;
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = new Uint8Array(await crypto.subtle.sign("HMAC", key, data));
  return timingSafeEqual(base64UrlDecode(provided.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "")), signature);
}

async function hmacHex(message, secret) {
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(message)));
  return [...signature].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function sha256Hex(value) {
  const bytes = value instanceof ArrayBuffer ? new Uint8Array(value) : encoder.encode(String(value));
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function encryptString(value, secret) {
  const keyBytes = new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(String(secret))));
  const key = await crypto.subtle.importKey("raw", keyBytes, "AES-GCM", false, ["encrypt"]);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, encoder.encode(value)));
  return `${base64UrlEncode(iv)}.${base64UrlEncode(ciphertext)}`;
}

async function deleteShopProjectionObjects(env, publicKey) {
  const prefix = `v1/shops/${encodeURIComponent(publicKey)}/`;
  let cursor;
  do {
    const list = await env.PROJECTIONS.list({ prefix, cursor, limit: 1000 });
    if (list.objects.length) await env.PROJECTIONS.delete(list.objects.map((object) => object.key));
    cursor = list.truncated ? list.cursor : undefined;
  } while (cursor);
}

async function deleteExpiredOAuthStates(env) {
  await env.DB.prepare("DELETE FROM oauth_states WHERE expires_at<?").bind(nowUnix()).run();
}

function auditStatement(env, shopId, actorType, actorId, action, resourceType, resourceId, metadata, now) {
  return env.DB.prepare(`INSERT INTO audit_events
    (audit_id, shop_id, actor_type, actor_id, action, resource_type, resource_id, metadata_json, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(crypto.randomUUID(), shopId, actorType, actorId, action, resourceType, resourceId, JSON.stringify(metadata || {}), now);
}

function isDisplayEligible(review) {
  return review.approval_status === "approved" && review.moderation_status === "passed" && review.visibility_status === "visible" && !review.deleted_at;
}

function derivedStatus(review) {
  if (review.visibility_status === "hidden") return "Hidden";
  if (review.moderation_status === "spam") return "Spam";
  if (review.approval_status === "rejected") return "Rejected";
  if (review.approval_status === "approved") return review.approval_method && review.approval_method !== "manual" ? "Approved Automatically" : "Approved";
  return "Pending";
}

function publicReviewDto(row) {
  return {
    review_id: row.review_id,
    rating: Number(row.rating),
    title: row.title || "",
    body: row.body || "",
    author: { display_name: row.author_name || "Anonymous", avatar_url: null },
    is_verified_purchase: Boolean(row.is_verified_purchase),
    helpful_count: Number(row.helpful_count || 0),
    seller_response: row.seller_response_body ? { body: row.seller_response_body, responded_at: new Date(Number(row.seller_response_updated_at || 0) * 1000).toISOString() } : null,
    language_code: row.language_code || "en",
    created_at: Number(row.created_at)
  };
}

function adminReviewDto(row) {
  return {
    review_id: row.review_id,
    product_id: row.product_id,
    rating: Number(row.rating),
    title: row.title,
    body: row.body,
    author_name: row.author_name,
    is_verified_purchase: Boolean(row.is_verified_purchase),
    helpful_count: Number(row.helpful_count || 0),
    approval_status: row.approval_status,
    moderation_status: row.moderation_status,
    visibility_status: row.visibility_status,
    status: derivedStatus(row),
    seller_response_body: row.seller_response_body || null,
    created_at: Number(row.created_at),
    updated_at: Number(row.updated_at)
  };
}

function publicShopDto(shop) {
  return { shop_id: shop.shop_id, shop_domain: shop.shop_domain, public_key: shop.public_key, status: shop.status };
}

function normalizeCountRow(row) {
  return { total: Number(row?.total || 0), pending: Number(row?.pending || 0), approved: Number(row?.approved || 0), spam: Number(row?.spam || 0) };
}

function encodeCursor(value) {
  return base64UrlEncode(encoder.encode(JSON.stringify(value)));
}

function decodeCursor(value) {
  if (!value) return null;
  try {
    const parsed = JSON.parse(decoder.decode(base64UrlDecode(value)));
    return parsed && Number.isFinite(Number(parsed.created_at)) && parsed.review_id ? { created_at: Number(parsed.created_at), review_id: String(parsed.review_id) } : null;
  } catch { return null; }
}

function parseJson(value, fallback) {
  try { return JSON.parse(value); } catch { return fallback; }
}

function withHeaders(response, extra) {
  const headers = new Headers(response.headers);
  for (const [key, value] of Object.entries(extra)) headers.set(key, value);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

function safeError(error) {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

function renderAdminPage(env, url) {
  const shop = normalizeShopDomain(url.searchParams.get("shop") || env.DEV_SHOP_DOMAIN || "");
  const config = JSON.stringify({
    shop,
    apiKey: env.SHOPIFY_API_KEY || "",
    isDevelopment: env.APP_ENV === "development",
    devToken: env.APP_ENV === "development" ? env.DEV_ADMIN_TOKEN || "" : "",
    appUrl: env.APP_URL || url.origin,
    cdnBase: env.PUBLIC_CDN_BASE || `${url.origin}/cdn`
  }).replace(/</g, "\\u003c");
  return new Response(`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="shopify-api-key" content="${escapeHtml(env.SHOPIFY_API_KEY || "")}">
<title>Reviews Cloud</title>
<script src="https://cdn.shopify.com/shopifycloud/app-bridge.js"></script>
<style>
:root{font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#202223;background:#f6f6f7}*{box-sizing:border-box}body{margin:0}.shell{max-width:1180px;margin:0 auto;padding:28px 20px 64px}.top{display:flex;align-items:center;justify-content:space-between;gap:16px;margin-bottom:22px}.brand{display:flex;gap:12px;align-items:center}.logo{width:42px;height:42px;border-radius:12px;background:#111827;color:#fff;display:grid;place-items:center;font-weight:800}.muted{color:#6d7175}.grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:14px}.card{background:#fff;border:1px solid #e1e3e5;border-radius:14px;padding:18px;box-shadow:0 1px 2px rgba(0,0,0,.04)}.metric{font-size:28px;font-weight:750;margin-top:8px}.main{display:grid;grid-template-columns:minmax(0,2fr) minmax(300px,1fr);gap:18px;margin-top:18px}h1,h2,h3{margin:0}h2{font-size:18px}.toolbar{display:flex;gap:10px;flex-wrap:wrap;align-items:center;margin:16px 0}.btn{border:1px solid #c9cccf;background:#fff;border-radius:8px;padding:9px 13px;font-weight:650;cursor:pointer}.btn:hover{background:#f6f6f7}.btn.primary{background:#008060;color:#fff;border-color:#008060}.btn.danger{color:#b42318}.btn:disabled{opacity:.5;cursor:wait}select,input,textarea{width:100%;border:1px solid #c9cccf;border-radius:8px;padding:10px;background:#fff;font:inherit}.field{margin:12px 0}.field label{display:block;font-weight:650;margin-bottom:6px}.review{border-top:1px solid #e1e3e5;padding:16px 0}.review:first-child{border-top:0}.review-head{display:flex;justify-content:space-between;gap:12px}.stars{color:#b98900;letter-spacing:1px}.badge{display:inline-block;border-radius:999px;padding:4px 9px;font-size:12px;font-weight:700;background:#e4e5e7}.badge.Approved,.badge.Approved-Automatically{background:#aee9d1}.badge.Pending{background:#ffd79d}.badge.Spam,.badge.Rejected{background:#fed3d1}.actions{display:flex;gap:8px;flex-wrap:wrap;margin-top:12px}.notice{padding:12px;border-radius:9px;background:#f1f8f5;border:1px solid #95c9b4;margin-bottom:16px}.error{background:#fff1f0;border-color:#f0a6a0}.empty{padding:30px;text-align:center;color:#6d7175}.small{font-size:12px}.projection{word-break:break-all;background:#f6f6f7;padding:10px;border-radius:8px;font-family:ui-monospace,monospace;font-size:12px}@media(max-width:850px){.grid{grid-template-columns:repeat(2,1fr)}.main{grid-template-columns:1fr}}@media(max-width:520px){.grid{grid-template-columns:1fr}.top{align-items:flex-start;flex-direction:column}}
</style></head><body><div class="shell">
<div class="top"><div class="brand"><div class="logo">★</div><div><h1>Reviews Cloud</h1><div class="muted" id="shop-label">Loading shop…</div></div></div><button class="btn" id="refresh">Refresh</button></div>
<div id="notice"></div><div class="grid"><div class="card"><div class="muted">All reviews</div><div class="metric" id="m-total">—</div></div><div class="card"><div class="muted">Pending</div><div class="metric" id="m-pending">—</div></div><div class="card"><div class="muted">Approved</div><div class="metric" id="m-approved">—</div></div><div class="card"><div class="muted">Spam</div><div class="metric" id="m-spam">—</div></div></div>
<div class="main"><section class="card"><div class="review-head"><h2>Review operations</h2><select id="status-filter" style="width:auto"><option value="all">All</option><option value="pending">Pending</option><option value="approved">Approved</option><option value="spam">Spam</option><option value="hidden">Hidden</option></select></div><div id="reviews"><div class="empty">Loading reviews…</div></div></section>
<aside><section class="card"><h2>Storefront projection</h2><div class="field"><label>Product ID</label><input id="product-id" value="8750123456789"></div><button class="btn primary" id="rebuild">Rebuild R2 JSON</button><div class="field"><label>Direct URL</label><div class="projection" id="projection-url">—</div></div></section>
<section class="card" style="margin-top:18px"><h2>Settings</h2><div class="field"><label>Approval mode</label><select id="approval-mode"><option value="manual">Manual</option><option value="automatic_all">Automatic: all passed reviews</option><option value="automatic_verified">Automatic: verified purchases</option><option value="automatic_registered">Automatic: registered customers</option></select></div><div class="field"><label>Cached reviews (1–50)</label><input id="cache-count" type="number" min="1" max="50"></div><div class="field"><label>Primary sort</label><select id="primary-sort"><option value="most_helpful">Most helpful</option><option value="newest">Newest</option><option value="highest_rating">Highest rating</option><option value="lowest_rating">Lowest rating</option></select></div><div class="field"><label>Banned phrases (one per line)</label><textarea id="banned-phrases" rows="5"></textarea></div><button class="btn primary" id="save-settings">Save settings</button></section></aside></div></div>
<script>const CONFIG=${config};
const state={bootstrap:null};const $=id=>document.getElementById(id);function notice(text,error=false){$('notice').innerHTML=text?'<div class="notice '+(error?'error':'')+'">'+escapeHtml(text)+'</div>':''}function escapeHtml(s){return String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))}async function api(path,options={}){const headers=new Headers(options.headers||{});headers.set('content-type','application/json');if(CONFIG.isDevelopment)headers.set('x-dev-admin-token',CONFIG.devToken);else if(window.shopify?.idToken){const token=await window.shopify.idToken();headers.set('authorization','Bearer '+token)}const sep=path.includes('?')?'&':'?';const response=await fetch(path+sep+'shop='+encodeURIComponent(CONFIG.shop),{...options,headers});const data=await response.json().catch(()=>({}));if(!response.ok)throw new Error(data.error?.message||('Request failed: '+response.status));return data}
function stars(n){return '★★★★★'.slice(0,n)+'☆☆☆☆☆'.slice(0,5-n)}function badge(s){return '<span class="badge '+String(s).replace(/\s+/g,'-')+'">'+escapeHtml(s)+'</span>'}async function load(){notice('');try{const b=await api('/api/admin/bootstrap');state.bootstrap=b;$('shop-label').textContent=b.shop.shop_domain;$('m-total').textContent=b.counts.total;$('m-pending').textContent=b.counts.pending;$('m-approved').textContent=b.counts.approved;$('m-spam').textContent=b.counts.spam;const first=b.products?.[0]?.product_id;if(first)$('product-id').value=first;fillSettings(b.settings);updateProjectionUrl();await loadReviews()}catch(e){if(CONFIG.isDevelopment&&/not seeded/i.test(e.message)){notice('No demo store exists yet. Creating one now…');try{await api('/api/dev/seed',{method:'POST',body:'{}'});await new Promise(r=>setTimeout(r,500));return load()}catch(seedError){notice(seedError.message,true)}}else notice(e.message,true)}}async function loadReviews(){const status=$('status-filter').value;const data=await api('/api/admin/reviews?status='+encodeURIComponent(status));const target=$('reviews');if(!data.reviews.length){target.innerHTML='<div class="empty">No reviews in this view.</div>';return}target.innerHTML=data.reviews.map(r=>'<article class="review"><div class="review-head"><div><div class="stars">'+stars(r.rating)+'</div><strong>'+escapeHtml(r.title||'Untitled review')+'</strong><div class="muted small">'+escapeHtml(r.author_name)+' · Product '+escapeHtml(r.product_id)+' · '+new Date(r.created_at*1000).toLocaleDateString()+'</div></div>'+badge(r.status)+'</div><p>'+escapeHtml(r.body)+'</p>'+(r.seller_response_body?'<div class="notice"><strong>Seller response:</strong> '+escapeHtml(r.seller_response_body)+'</div>':'')+'<div class="actions">'+(r.status==='Pending'?'<button class="btn primary" data-action="approve" data-id="'+r.review_id+'">Approve</button>':'')+'<button class="btn" data-action="hide" data-id="'+r.review_id+'">Hide</button><button class="btn danger" data-action="spam" data-id="'+r.review_id+'">Mark spam</button><button class="btn" data-response="'+r.review_id+'">Respond</button></div></article>').join('');target.querySelectorAll('[data-action]').forEach(button=>button.onclick=async()=>{button.disabled=true;try{await api('/api/admin/reviews/'+button.dataset.id,{method:'PATCH',body:JSON.stringify({action:button.dataset.action})});await load()}catch(e){notice(e.message,true)}finally{button.disabled=false}});target.querySelectorAll('[data-response]').forEach(button=>button.onclick=async()=>{const body=prompt('Seller response');if(!body)return;try{await api('/api/admin/reviews/'+button.dataset.response+'/response',{method:'PUT',body:JSON.stringify({body})});await loadReviews()}catch(e){notice(e.message,true)}})}function fillSettings(s){$('approval-mode').value=s.approval.mode;$('cache-count').value=s.display.cachedReviewCount;$('primary-sort').value=s.display.primarySort;$('banned-phrases').value=(s.spam.bannedPhrases||[]).join('\n')}function updateProjectionUrl(){const p=$('product-id').value.trim();$('projection-url').textContent=CONFIG.cdnBase.replace(/\/$/,'')+'/v1/shops/'+encodeURIComponent(CONFIG.shop)+'/products/'+encodeURIComponent(p)+'.json'}$('refresh').onclick=load;$('status-filter').onchange=loadReviews;$('product-id').oninput=updateProjectionUrl;$('rebuild').onclick=async()=>{try{await api('/api/admin/rebuild',{method:'POST',body:JSON.stringify({product_id:$('product-id').value.trim()})});notice('Projection rebuild queued. The R2 object should update shortly.')}catch(e){notice(e.message,true)}};$('save-settings').onclick=async()=>{const current=state.bootstrap.settings;const settings={...current,approval:{...current.approval,mode:$('approval-mode').value},display:{...current.display,cachedReviewCount:Number($('cache-count').value),primarySort:$('primary-sort').value},spam:{...current.spam,bannedPhrases:$('banned-phrases').value.split('\n').map(x=>x.trim()).filter(Boolean)}};try{await api('/api/admin/settings',{method:'PUT',body:JSON.stringify({settings})});notice('Settings saved and projection rebuilds queued.');await load()}catch(e){notice(e.message,true)}};load();</script></body></html>`, { headers: { "content-type": "text/html; charset=utf-8", "content-security-policy": "default-src 'self' https://cdn.shopify.com; script-src 'self' 'unsafe-inline' https://cdn.shopify.com; style-src 'self' 'unsafe-inline'; connect-src 'self' https://*.shopify.com; frame-ancestors https://admin.shopify.com https://*.myshopify.com; img-src 'self' data: https:;", "x-frame-options": "ALLOWALL", "referrer-policy": "strict-origin-when-cross-origin" } });
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]));
}
