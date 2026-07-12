CREATE TABLE IF NOT EXISTS global_today_brief_generation_claims (
  environment TEXT NOT NULL,
  cache_key TEXT NOT NULL,
  cache_scope TEXT NOT NULL,
  owner_user_id TEXT NOT NULL,
  claim_token TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (environment, cache_key, cache_scope)
);

CREATE INDEX IF NOT EXISTS idx_global_today_brief_claim_expiry
  ON global_today_brief_generation_claims (expires_at, environment);

CREATE INDEX IF NOT EXISTS idx_global_today_brief_cache_latest
  ON ai_response_cache (environment, mailbox_scope, feature, created_at DESC);
