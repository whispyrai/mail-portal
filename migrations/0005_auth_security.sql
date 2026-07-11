-- Harden cookie sessions and the public login boundary.

ALTER TABLE users ADD COLUMN session_version INTEGER NOT NULL DEFAULT 1;

CREATE TABLE IF NOT EXISTS login_throttles (
  throttle_key TEXT PRIMARY KEY,
  failure_count INTEGER NOT NULL,
  window_started_at INTEGER NOT NULL,
  locked_until INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  max_failures INTEGER NOT NULL CHECK (max_failures > 0)
);

CREATE INDEX IF NOT EXISTS idx_login_throttles_updated_at
  ON login_throttles (updated_at);

CREATE TABLE IF NOT EXISTS login_attempt_leases (
  attempt_id TEXT NOT NULL,
  throttle_key TEXT NOT NULL,
  max_failures INTEGER NOT NULL CHECK (max_failures > 0),
  acquired_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  PRIMARY KEY (attempt_id, throttle_key)
);

CREATE INDEX IF NOT EXISTS idx_login_attempt_leases_expiry
  ON login_attempt_leases (expires_at);

CREATE INDEX IF NOT EXISTS idx_login_attempt_leases_bucket
  ON login_attempt_leases (throttle_key, expires_at);
