# API reference

## Public API

### Submit a review

`POST /api/public/{shopKey}/products/{productId}/reviews`

Headers:

- `Content-Type: application/json`
- `Idempotency-Key: <unique value>`

Body:

```json
{
  "rating": 5,
  "title": "Excellent fit",
  "body": "Comfortable and true to size.",
  "author_name": "A. Customer",
  "email": "optional@example.com"
}
```

### List reviews

`GET /api/public/{shopKey}/products/{productId}/reviews?limit=20&rating=5&cursor=...`

### Vote on a review

`POST /api/public/{shopKey}/reviews/{reviewId}/votes`

```json
{
  "vote_type": "helpful",
  "voter_token": "stable-browser-token"
}
```

### Read a projection through the Worker during local development

`GET /cdn/v1/shops/{shopKey}/products/{productId}.json`

In production, configure an R2 custom domain and let the storefront read the same object key directly from R2.

## Admin API

Admin endpoints require either a Shopify App Bridge session token in `Authorization: Bearer <token>` or the configured development token in `X-Dev-Admin-Token` when `APP_ENV=development`.

- `GET /api/admin/bootstrap`
- `GET /api/admin/reviews?status=all|pending|approved|spam|hidden`
- `PATCH /api/admin/reviews/{reviewId}` with `{ "action": "approve|reject|spam|hide|unhide" }`
- `PUT /api/admin/reviews/{reviewId}/response`
- `GET /api/admin/settings`
- `PUT /api/admin/settings`
- `POST /api/admin/rebuild` with `{ "product_id": "..." }`

## Development helper

`POST /api/dev/seed` creates a demo shop, a product, three approved reviews, aggregates, and a queued projection rebuild. It exists only when `APP_ENV=development` and requires `X-Dev-Admin-Token`.
