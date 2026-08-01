PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS shops (
  shop_id TEXT PRIMARY KEY,
  shop_domain TEXT NOT NULL UNIQUE,
  public_key TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled','deleted')),
  access_token_enc TEXT,
  scopes TEXT NOT NULL DEFAULT '',
  installed_at INTEGER,
  uninstalled_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS oauth_states (
  state_hash TEXT PRIMARY KEY,
  shop_domain TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS products (
  shop_id TEXT NOT NULL,
  product_id TEXT NOT NULL,
  product_gid TEXT,
  handle TEXT,
  title TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  shopify_updated_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (shop_id, product_id),
  FOREIGN KEY (shop_id) REFERENCES shops(shop_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS guest_identities (
  guest_identity_id TEXT PRIMARY KEY,
  shop_id TEXT NOT NULL,
  email_enc TEXT,
  email_hash TEXT,
  verification_status TEXT NOT NULL DEFAULT 'unverified',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (shop_id) REFERENCES shops(shop_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS reviews (
  shop_id TEXT NOT NULL,
  review_id TEXT NOT NULL,
  product_id TEXT NOT NULL,
  variant_id TEXT,
  customer_id TEXT,
  guest_identity_id TEXT,
  author_name TEXT NOT NULL,
  author_mode TEXT NOT NULL DEFAULT 'display_name',
  rating INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 5),
  title TEXT NOT NULL DEFAULT '',
  body TEXT NOT NULL,
  is_verified_purchase INTEGER NOT NULL DEFAULT 0 CHECK (is_verified_purchase IN (0,1)),
  recommend_product INTEGER CHECK (recommend_product IN (0,1)),
  language_code TEXT NOT NULL DEFAULT 'en',
  approval_status TEXT NOT NULL DEFAULT 'pending' CHECK (approval_status IN ('pending','approved','rejected')),
  approval_method TEXT NOT NULL DEFAULT 'manual' CHECK (approval_method IN ('manual','automatic_all','automatic_verified','automatic_registered','automatic_trust_rule')),
  moderation_status TEXT NOT NULL DEFAULT 'pending' CHECK (moderation_status IN ('pending','passed','spam','needs_review')),
  visibility_status TEXT NOT NULL DEFAULT 'visible' CHECK (visibility_status IN ('visible','hidden','deleted')),
  helpful_count INTEGER NOT NULL DEFAULT 0,
  not_helpful_count INTEGER NOT NULL DEFAULT 0,
  submission_idempotency_key TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'storefront',
  version INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER,
  PRIMARY KEY (shop_id, review_id),
  UNIQUE (shop_id, submission_idempotency_key),
  FOREIGN KEY (shop_id) REFERENCES shops(shop_id) ON DELETE CASCADE,
  FOREIGN KEY (shop_id, product_id) REFERENCES products(shop_id, product_id) ON DELETE CASCADE,
  FOREIGN KEY (guest_identity_id) REFERENCES guest_identities(guest_identity_id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS seller_responses (
  shop_id TEXT NOT NULL,
  review_id TEXT NOT NULL,
  response_version INTEGER NOT NULL DEFAULT 1,
  body TEXT NOT NULL,
  responder_user_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER,
  PRIMARY KEY (shop_id, review_id),
  FOREIGN KEY (shop_id, review_id) REFERENCES reviews(shop_id, review_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS review_status_history (
  history_id TEXT PRIMARY KEY,
  shop_id TEXT NOT NULL,
  review_id TEXT NOT NULL,
  from_state TEXT,
  to_state TEXT NOT NULL,
  reason_code TEXT,
  actor_type TEXT NOT NULL,
  actor_id TEXT,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (shop_id, review_id) REFERENCES reviews(shop_id, review_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS review_votes (
  shop_id TEXT NOT NULL,
  review_id TEXT NOT NULL,
  voter_fingerprint_hash TEXT NOT NULL,
  vote_type TEXT NOT NULL CHECK (vote_type IN ('helpful','not_helpful')),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (shop_id, review_id, voter_fingerprint_hash),
  FOREIGN KEY (shop_id, review_id) REFERENCES reviews(shop_id, review_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS product_review_aggregates (
  shop_id TEXT NOT NULL,
  product_id TEXT NOT NULL,
  approved_count INTEGER NOT NULL DEFAULT 0,
  rating_sum INTEGER NOT NULL DEFAULT 0,
  rating_1 INTEGER NOT NULL DEFAULT 0,
  rating_2 INTEGER NOT NULL DEFAULT 0,
  rating_3 INTEGER NOT NULL DEFAULT 0,
  rating_4 INTEGER NOT NULL DEFAULT 0,
  rating_5 INTEGER NOT NULL DEFAULT 0,
  verified_count INTEGER NOT NULL DEFAULT 0,
  media_count INTEGER NOT NULL DEFAULT 0,
  recommended_count INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (shop_id, product_id),
  FOREIGN KEY (shop_id, product_id) REFERENCES products(shop_id, product_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS product_projection_state (
  shop_id TEXT NOT NULL,
  product_id TEXT NOT NULL,
  desired_version INTEGER NOT NULL DEFAULT 0,
  published_version INTEGER NOT NULL DEFAULT 0,
  published_at INTEGER,
  object_etag TEXT,
  last_error TEXT,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (shop_id, product_id),
  FOREIGN KEY (shop_id, product_id) REFERENCES products(shop_id, product_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS product_pins (
  shop_id TEXT NOT NULL,
  product_id TEXT NOT NULL,
  review_id TEXT NOT NULL,
  position INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (shop_id, product_id, review_id),
  FOREIGN KEY (shop_id, review_id) REFERENCES reviews(shop_id, review_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS settings_documents (
  shop_id TEXT NOT NULL,
  domain TEXT NOT NULL,
  schema_version INTEGER NOT NULL DEFAULT 1,
  revision INTEGER NOT NULL DEFAULT 1,
  document_json TEXT NOT NULL,
  updated_by TEXT,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (shop_id, domain),
  FOREIGN KEY (shop_id) REFERENCES shops(shop_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS settings_change_log (
  change_id TEXT PRIMARY KEY,
  shop_id TEXT NOT NULL,
  domain TEXT NOT NULL,
  before_json TEXT,
  after_json TEXT NOT NULL,
  actor_id TEXT,
  reason TEXT,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (shop_id) REFERENCES shops(shop_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS outbox_events (
  event_id TEXT PRIMARY KEY,
  shop_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  schema_version INTEGER NOT NULL DEFAULT 1,
  aggregate_id TEXT,
  aggregate_version INTEGER,
  payload_json TEXT NOT NULL,
  occurred_at INTEGER NOT NULL,
  delivered_at INTEGER,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  FOREIGN KEY (shop_id) REFERENCES shops(shop_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS webhook_receipts (
  delivery_id TEXT PRIMARY KEY,
  shop_domain TEXT NOT NULL,
  topic TEXT NOT NULL,
  api_version TEXT,
  payload_hash TEXT NOT NULL,
  received_at INTEGER NOT NULL,
  processed_at INTEGER,
  status TEXT NOT NULL DEFAULT 'received',
  attempt_count INTEGER NOT NULL DEFAULT 0,
  last_error TEXT
);

CREATE TABLE IF NOT EXISTS audit_events (
  audit_id TEXT PRIMARY KEY,
  shop_id TEXT,
  actor_type TEXT NOT NULL,
  actor_id TEXT,
  action TEXT NOT NULL,
  resource_type TEXT,
  resource_id TEXT,
  request_id TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS reviews_product_visible_newest
ON reviews (shop_id, product_id, created_at DESC, review_id DESC)
WHERE approval_status='approved' AND moderation_status='passed'
  AND visibility_status='visible' AND deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS reviews_product_visible_helpful
ON reviews (shop_id, product_id, helpful_count DESC, created_at DESC, review_id DESC)
WHERE approval_status='approved' AND moderation_status='passed'
  AND visibility_status='visible' AND deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS reviews_moderation_queue
ON reviews (shop_id, moderation_status, created_at, review_id)
WHERE moderation_status IN ('pending','needs_review');

CREATE INDEX IF NOT EXISTS reviews_admin_status
ON reviews (shop_id, approval_status, moderation_status, visibility_status, created_at DESC, review_id DESC);

CREATE INDEX IF NOT EXISTS outbox_unsent
ON outbox_events (shop_id, occurred_at, event_id)
WHERE delivered_at IS NULL;

CREATE INDEX IF NOT EXISTS projection_lag
ON product_projection_state (updated_at, shop_id, product_id)
WHERE desired_version > published_version;
