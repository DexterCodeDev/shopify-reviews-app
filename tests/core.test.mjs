import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_SETTINGS,
  basicSpamDecision,
  mergeSettings,
  normalizeShopDomain,
  projectionObjectKey,
  selectProjectionReviews,
  shouldAutoApprove,
  validateReviewInput
} from "../src/core.mjs";

test("normalizes valid Shopify domains and rejects unsafe hosts", () => {
  assert.equal(normalizeShopDomain("https://Demo-Shop.myshopify.com/admin"), "demo-shop.myshopify.com");
  assert.equal(normalizeShopDomain("evil.example.com"), "");
});

test("validates review input", () => {
  const good = validateReviewInput({ rating: 5, body: "Excellent", author_name: "Sam" }, DEFAULT_SETTINGS);
  assert.equal(good.ok, true);
  const bad = validateReviewInput({ rating: 9, body: "" }, DEFAULT_SETTINGS);
  assert.equal(bad.ok, false);
  assert.ok(bad.errors.length >= 2);
});

test("basic spam checks are deterministic", () => {
  assert.equal(basicSpamDecision({ body: "Join this crypto giveaway" }, DEFAULT_SETTINGS).decision, "spam");
  assert.equal(basicSpamDecision({ body: "Useful review" }, DEFAULT_SETTINGS).decision, "passed");
});

test("approval policy honors configured modes", () => {
  assert.equal(shouldAutoApprove({}, mergeSettings({ approval: { mode: "automatic_all" } })), true);
  assert.equal(shouldAutoApprove({ is_verified_purchase: 1 }, mergeSettings({ approval: { mode: "automatic_verified" } })), true);
  assert.equal(shouldAutoApprove({}, mergeSettings({ approval: { mode: "manual" } })), false);
});

test("projection selection keeps pins first and uses deterministic helpful order", () => {
  const reviews = [
    { review_id: "a", helpful_count: 4, created_at: 10, rating: 5 },
    { review_id: "b", helpful_count: 9, created_at: 11, rating: 4 },
    { review_id: "c", helpful_count: 1, created_at: 12, rating: 3 }
  ];
  const selected = selectProjectionReviews(reviews, ["c"], mergeSettings({ display: { cachedReviewCount: 3, primarySort: "most_helpful" } }));
  assert.deepEqual(selected.map((r) => r.review_id), ["c", "b", "a"]);
});

test("projection key is predictable", () => {
  assert.equal(projectionObjectKey("demo-shop.myshopify.com", "123"), "v1/shops/demo-shop.myshopify.com/products/123.json");
});
