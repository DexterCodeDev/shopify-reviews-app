export const DEFAULT_SETTINGS = Object.freeze({
  schemaVersion: 1,
  revision: 1,
  reviewForm: {
    requireTitle: false,
    maxTitleLength: 120,
    maxBodyLength: 5000,
    allowGuest: true,
    requireEmail: false
  },
  approval: {
    mode: "automatic_all"
  },
  spam: {
    bannedPhrases: ["buy followers", "crypto giveaway"],
    maxLinks: 3
  },
  display: {
    cachedReviewCount: 10,
    primarySort: "most_helpful",
    fallbackSort: "newest",
    showSellerResponse: true,
    showVerifiedBadge: true
  }
});

export function normalizeShopDomain(value) {
  const raw = String(value || "").trim().toLowerCase();
  if (!raw) return "";
  const withoutProtocol = raw.replace(/^https?:\/\//, "").split("/")[0];
  if (!/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(withoutProtocol)) return "";
  return withoutProtocol;
}

export function jsonResponse(data, init = {}) {
  const headers = new Headers(init.headers || {});
  if (!headers.has("content-type")) headers.set("content-type", "application/json; charset=utf-8");
  headers.set("x-content-type-options", "nosniff");
  return new Response(JSON.stringify(data), { ...init, headers });
}

export function errorResponse(status, code, message, details) {
  return jsonResponse({ error: { code, message, ...(details ? { details } : {}) } }, { status });
}

export function corsHeaders(origin = "*") {
  return {
    "access-control-allow-origin": origin || "*",
    "access-control-allow-methods": "GET,POST,PATCH,PUT,OPTIONS",
    "access-control-allow-headers": "content-type,authorization,idempotency-key,x-dev-admin-token",
    "access-control-max-age": "86400",
    vary: "Origin"
  };
}

export function validateReviewInput(input, settings = DEFAULT_SETTINGS) {
  const errors = [];
  const rating = Number(input?.rating);
  const title = String(input?.title || "").trim();
  const body = String(input?.body || "").trim();
  const authorName = String(input?.author_name || input?.authorName || "Anonymous").trim();
  const email = String(input?.email || "").trim().toLowerCase();

  if (!Number.isInteger(rating) || rating < 1 || rating > 5) errors.push("rating must be an integer from 1 to 5");
  if (settings.reviewForm?.requireTitle && !title) errors.push("title is required");
  if (title.length > (settings.reviewForm?.maxTitleLength ?? 120)) errors.push("title is too long");
  if (!body) errors.push("body is required");
  if (body.length > (settings.reviewForm?.maxBodyLength ?? 5000)) errors.push("body is too long");
  if (authorName.length < 1 || authorName.length > 80) errors.push("author_name must be 1 to 80 characters");
  if (settings.reviewForm?.requireEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) errors.push("a valid email is required");

  return {
    ok: errors.length === 0,
    errors,
    value: { rating, title, body, authorName, email }
  };
}

export function basicSpamDecision(review, settings = DEFAULT_SETTINGS) {
  const text = `${review.title || ""}\n${review.body || ""}`.toLowerCase();
  const banned = Array.isArray(settings.spam?.bannedPhrases) ? settings.spam.bannedPhrases : [];
  const matchedPhrase = banned.find((phrase) => phrase && text.includes(String(phrase).toLowerCase()));
  const links = (text.match(/https?:\/\//g) || []).length;
  if (matchedPhrase) return { decision: "spam", reason: "banned_phrase", evidence: matchedPhrase };
  if (links > Number(settings.spam?.maxLinks ?? 3)) return { decision: "needs_review", reason: "too_many_links", evidence: String(links) };
  return { decision: "passed", reason: "basic_checks_passed" };
}

export function shouldAutoApprove(review, settings = DEFAULT_SETTINGS) {
  const mode = settings.approval?.mode || "manual";
  if (mode === "automatic_all") return true;
  if (mode === "automatic_verified" && review.is_verified_purchase) return true;
  if (mode === "automatic_registered" && review.customer_id) return true;
  return false;
}

export function mergeSettings(stored) {
  const source = stored && typeof stored === "object" ? stored : {};
  return {
    ...DEFAULT_SETTINGS,
    ...source,
    reviewForm: { ...DEFAULT_SETTINGS.reviewForm, ...(source.reviewForm || {}) },
    approval: { ...DEFAULT_SETTINGS.approval, ...(source.approval || {}) },
    spam: { ...DEFAULT_SETTINGS.spam, ...(source.spam || {}) },
    display: { ...DEFAULT_SETTINGS.display, ...(source.display || {}) }
  };
}

export function stableReviewSort(sortKey) {
  const key = String(sortKey || "newest");
  const comparators = {
    newest: (a, b) => (b.created_at - a.created_at) || String(b.review_id).localeCompare(String(a.review_id)),
    oldest: (a, b) => (a.created_at - b.created_at) || String(a.review_id).localeCompare(String(b.review_id)),
    most_helpful: (a, b) => (b.helpful_count - a.helpful_count) || (b.created_at - a.created_at) || String(b.review_id).localeCompare(String(a.review_id)),
    highest_rating: (a, b) => (b.rating - a.rating) || (b.created_at - a.created_at) || String(b.review_id).localeCompare(String(a.review_id)),
    lowest_rating: (a, b) => (a.rating - b.rating) || (b.created_at - a.created_at) || String(b.review_id).localeCompare(String(a.review_id))
  };
  return comparators[key] || comparators.newest;
}

export function selectProjectionReviews(reviews, pins = [], settings = DEFAULT_SETTINGS) {
  const config = mergeSettings(settings).display;
  const capacity = Math.max(1, Math.min(50, Number(config.cachedReviewCount || 10)));
  const byId = new Map(reviews.map((review) => [String(review.review_id), review]));
  const selected = [];
  const seen = new Set();

  for (const pin of pins) {
    const id = String(pin.review_id || pin);
    const review = byId.get(id);
    if (review && !seen.has(id)) {
      selected.push(review);
      seen.add(id);
      if (selected.length >= capacity) return selected;
    }
  }

  const primary = [...reviews].sort(stableReviewSort(config.primarySort));
  for (const review of primary) {
    const id = String(review.review_id);
    if (!seen.has(id)) {
      selected.push(review);
      seen.add(id);
      if (selected.length >= capacity) return selected;
    }
  }

  const fallback = [...reviews].sort(stableReviewSort(config.fallbackSort));
  for (const review of fallback) {
    const id = String(review.review_id);
    if (!seen.has(id)) {
      selected.push(review);
      seen.add(id);
      if (selected.length >= capacity) break;
    }
  }
  return selected;
}

export function projectionObjectKey(publicKey, productId) {
  return `v1/shops/${encodeURIComponent(String(publicKey))}/products/${encodeURIComponent(String(productId))}.json`;
}

export function nowUnix() {
  return Math.floor(Date.now() / 1000);
}

export function base64UrlEncode(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

export function base64UrlDecode(value) {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((value.length + 3) % 4);
  const binary = atob(padded);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

export function timingSafeEqual(a, b) {
  const left = typeof a === "string" ? new TextEncoder().encode(a) : a;
  const right = typeof b === "string" ? new TextEncoder().encode(b) : b;
  if (left.length !== right.length) return false;
  let diff = 0;
  for (let i = 0; i < left.length; i += 1) diff |= left[i] ^ right[i];
  return diff === 0;
}
