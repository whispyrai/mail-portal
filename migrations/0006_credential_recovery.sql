ALTER TABLE users ADD COLUMN recovery_email TEXT;
ALTER TABLE users ADD COLUMN ownership_confirmed_at INTEGER;

-- Accounts that existed before this feature were already controlled by their
-- owners. Backfill them as claimed inside the migration; accounts created by the
-- new application code are inserted afterward with NULL until setup is consumed.
UPDATE users SET ownership_confirmed_at = updated_at
WHERE ownership_confirmed_at IS NULL;

CREATE TABLE credential_recovery_tokens (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at INTEGER NOT NULL,
  consumed_at INTEGER,
  consumption_nonce TEXT,
  purpose TEXT NOT NULL CHECK (purpose IN ('setup', 'recovery')),
  issued_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX idx_credential_recovery_user
  ON credential_recovery_tokens(user_id, created_at DESC);
CREATE INDEX idx_credential_recovery_expiry
  ON credential_recovery_tokens(expires_at);

CREATE TABLE credential_recovery_audit (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL CHECK (
    event_type IN ('setup_issued', 'ownership_confirmed', 'recovery_issued',
                   'credentials_recovered', 'account_deactivated')
  ),
  actor_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX idx_credential_recovery_audit_user
  ON credential_recovery_audit(user_id, created_at DESC);

CREATE TRIGGER credential_recovery_audit_no_update
BEFORE UPDATE ON credential_recovery_audit
BEGIN
  SELECT RAISE(ABORT, 'credential recovery audit is immutable');
END;

CREATE TRIGGER credential_recovery_audit_no_delete
BEFORE DELETE ON credential_recovery_audit
BEGIN
  SELECT RAISE(ABORT, 'credential recovery audit is immutable');
END;

CREATE TABLE credential_recovery_request_limits (
  throttle_key TEXT PRIMARY KEY,
  request_count INTEGER NOT NULL CHECK (request_count > 0),
  window_started_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX idx_credential_recovery_request_limits_updated
  ON credential_recovery_request_limits(updated_at);
