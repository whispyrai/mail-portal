-- Provider-neutral AI usage ledger and monthly cost guardrails. Each deployed
-- environment has its own D1 database, and environment remains part of the key
-- so local/shared databases cannot accidentally combine budgets.

CREATE TABLE IF NOT EXISTS ai_usage_months (
  environment TEXT NOT NULL,
  month_key TEXT NOT NULL,
  spent_micros INTEGER NOT NULL DEFAULT 0 CHECK (spent_micros >= 0),
  reserved_micros INTEGER NOT NULL DEFAULT 0 CHECK (reserved_micros >= 0),
  approved_budget_micros INTEGER NOT NULL CHECK (approved_budget_micros > 0),
  alert_emitted_at INTEGER,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (environment, month_key)
);

CREATE TABLE IF NOT EXISTS ai_usage_events (
  id TEXT PRIMARY KEY,
  environment TEXT NOT NULL,
  month_key TEXT NOT NULL,
  feature TEXT NOT NULL,
  actor_user_id TEXT,
  mailbox_id TEXT,
  requested_tier TEXT NOT NULL CHECK (requested_tier IN ('auto', 'cheap', 'strong')),
  selected_tier TEXT NOT NULL CHECK (selected_tier IN ('cheap', 'strong')),
  model TEXT NOT NULL,
  cache_key TEXT,
  escalation_reason TEXT,
  state TEXT NOT NULL CHECK (
    state IN ('reserved', 'completed', 'failed', 'blocked', 'cache_hit', 'deterministic')
  ),
  estimated_cost_micros INTEGER NOT NULL DEFAULT 0 CHECK (estimated_cost_micros >= 0),
  reservation_limit_micros INTEGER CHECK (reservation_limit_micros IS NULL OR reservation_limit_micros > 0),
  reservation_expires_at INTEGER,
  provider_started_at INTEGER,
  actual_cost_micros INTEGER NOT NULL DEFAULT 0 CHECK (actual_cost_micros >= 0),
  prompt_tokens INTEGER NOT NULL DEFAULT 0 CHECK (prompt_tokens >= 0),
  completion_tokens INTEGER NOT NULL DEFAULT 0 CHECK (completion_tokens >= 0),
  error_code TEXT,
  created_at INTEGER NOT NULL,
  completed_at INTEGER,
  FOREIGN KEY (environment, month_key)
    REFERENCES ai_usage_months(environment, month_key)
);

CREATE INDEX IF NOT EXISTS idx_ai_usage_events_month_feature
  ON ai_usage_events (environment, month_key, feature, created_at);

CREATE INDEX IF NOT EXISTS idx_ai_usage_events_mailbox
  ON ai_usage_events (mailbox_id, created_at);

CREATE INDEX IF NOT EXISTS idx_ai_usage_events_reservation_expiry
  ON ai_usage_events (state, reservation_expires_at);

-- Reservations are inserted with an INSERT ... SELECT guarded by the same
-- monthly total. These triggers keep aggregate accounting coupled to the event
-- state transition, including retries and exceptional exits.
CREATE TRIGGER IF NOT EXISTS ai_usage_reserve_after_insert
AFTER INSERT ON ai_usage_events
WHEN NEW.state = 'reserved'
BEGIN
  UPDATE ai_usage_months
  SET reserved_micros = reserved_micros + NEW.estimated_cost_micros,
      updated_at = NEW.created_at
  WHERE environment = NEW.environment
    AND month_key = NEW.month_key;
END;

CREATE TRIGGER IF NOT EXISTS ai_usage_complete_after_update
AFTER UPDATE OF state ON ai_usage_events
WHEN OLD.state = 'reserved' AND NEW.state = 'completed'
BEGIN
  UPDATE ai_usage_months
  SET reserved_micros = MAX(0, reserved_micros - OLD.estimated_cost_micros),
      spent_micros = spent_micros + NEW.actual_cost_micros,
      updated_at = COALESCE(NEW.completed_at, NEW.created_at)
  WHERE environment = NEW.environment
    AND month_key = NEW.month_key;
END;

CREATE TRIGGER IF NOT EXISTS ai_usage_fail_after_update
AFTER UPDATE OF state ON ai_usage_events
WHEN OLD.state = 'reserved' AND NEW.state = 'failed'
BEGIN
  UPDATE ai_usage_months
  SET reserved_micros = MAX(0, reserved_micros - OLD.estimated_cost_micros),
      spent_micros = spent_micros + NEW.actual_cost_micros,
      updated_at = COALESCE(NEW.completed_at, NEW.created_at)
  WHERE environment = NEW.environment
    AND month_key = NEW.month_key;
END;

CREATE TABLE IF NOT EXISTS ai_budget_reviews (
  id TEXT PRIMARY KEY,
  environment TEXT NOT NULL,
  month_key TEXT NOT NULL,
  previous_budget_micros INTEGER NOT NULL CHECK (previous_budget_micros > 0),
  approved_budget_micros INTEGER NOT NULL CHECK (approved_budget_micros > 0),
  reviewed_by TEXT NOT NULL,
  reason TEXT NOT NULL,
  reviewed_at INTEGER NOT NULL,
  FOREIGN KEY (environment, month_key)
    REFERENCES ai_usage_months(environment, month_key)
);

CREATE INDEX IF NOT EXISTS idx_ai_budget_reviews_month
  ON ai_budget_reviews (environment, month_key, reviewed_at);

CREATE TABLE IF NOT EXISTS ai_response_cache (
  cache_key TEXT NOT NULL,
  environment TEXT NOT NULL,
  mailbox_id TEXT,
  mailbox_scope TEXT NOT NULL,
  feature TEXT NOT NULL,
  value_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  PRIMARY KEY (environment, cache_key, mailbox_scope)
);

CREATE INDEX IF NOT EXISTS idx_ai_response_cache_expiry
  ON ai_response_cache (expires_at);

CREATE INDEX IF NOT EXISTS idx_ai_response_cache_mailbox_feature
  ON ai_response_cache (mailbox_id, feature, created_at);

CREATE TRIGGER IF NOT EXISTS ai_budget_review_after_insert
AFTER INSERT ON ai_budget_reviews
BEGIN
  UPDATE ai_usage_months
  SET approved_budget_micros = NEW.approved_budget_micros,
      updated_at = NEW.reviewed_at
  WHERE environment = NEW.environment
    AND month_key = NEW.month_key;
END;
