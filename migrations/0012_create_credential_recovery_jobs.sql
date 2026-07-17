-- Fail closed before changing schema if a legacy destination remains. Rollout
-- must first reconcile every legacy value into ACCOUNT_RECOVERY_DIRECTORY and
-- execute the separately approved scrub.
CREATE TABLE credential_recovery_legacy_destination_guard (
  remaining_count INTEGER NOT NULL
);
CREATE TRIGGER credential_recovery_legacy_destination_guard_abort
BEFORE INSERT ON credential_recovery_legacy_destination_guard
WHEN NEW.remaining_count <> 0
BEGIN
  SELECT RAISE(ABORT, 'legacy users.recovery_email rows must be reconciled and scrubbed before migration 0012');
END;
INSERT INTO credential_recovery_legacy_destination_guard(remaining_count)
SELECT COUNT(*) FROM users WHERE recovery_email IS NOT NULL;
DROP TRIGGER credential_recovery_legacy_destination_guard_abort;
DROP TABLE credential_recovery_legacy_destination_guard;

-- A missing table/row or any value other than exact 1 is disabled in code. The
-- row starts disabled so migration and callback proof cannot activate recovery.
CREATE TABLE credential_recovery_control (
  control_id TEXT PRIMARY KEY CHECK (control_id = 'global'),
  enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
  updated_at INTEGER NOT NULL
);
INSERT INTO credential_recovery_control(control_id, enabled, updated_at)
VALUES ('global', 0, 0);

-- Durable privacy-safe intake. The account identity remains inside the
-- authenticated ciphertext; account_ref is an HMAC used only for correlation.
CREATE TABLE credential_recovery_request_jobs (
  id TEXT PRIMARY KEY,
  account_ref TEXT NOT NULL CHECK (length(account_ref) = 43),
  payload_key_version INTEGER CHECK (payload_key_version = 1),
  payload_iv TEXT CHECK (payload_iv IS NULL OR length(payload_iv) = 16),
  payload_ciphertext TEXT CHECK (
    payload_ciphertext IS NULL
    OR (length(payload_ciphertext) BETWEEN 24 AND 2048)
  ),
  state TEXT NOT NULL CHECK (
    state IN ('pending', 'leased', 'completed', 'suppressed', 'expired', 'parked')
  ),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  next_attempt_at INTEGER NOT NULL,
  lease_token TEXT,
  lease_expires_at INTEGER,
  last_error_code TEXT CHECK (last_error_code IS NULL OR length(last_error_code) <= 64),
  completed_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  CHECK (
    (payload_key_version IS NULL AND payload_iv IS NULL AND payload_ciphertext IS NULL)
    OR (payload_key_version IS NOT NULL AND payload_iv IS NOT NULL AND payload_ciphertext IS NOT NULL)
  ),
  CHECK (
    (state = 'leased' AND lease_token IS NOT NULL AND lease_expires_at IS NOT NULL)
    OR (state <> 'leased' AND lease_token IS NULL AND lease_expires_at IS NULL)
  ),
  CHECK (
    (state IN ('completed', 'suppressed', 'expired', 'parked') AND completed_at IS NOT NULL)
    OR (state IN ('pending', 'leased') AND completed_at IS NULL)
  ),
  CHECK (state NOT IN ('pending', 'leased') OR payload_ciphertext IS NOT NULL),
  CHECK (state NOT IN ('completed', 'suppressed', 'expired') OR payload_ciphertext IS NULL)
);

CREATE INDEX idx_credential_recovery_request_jobs_due
  ON credential_recovery_request_jobs(next_attempt_at, created_at, id)
  WHERE state IN ('pending', 'leased');
CREATE INDEX idx_credential_recovery_request_jobs_terminal
  ON credential_recovery_request_jobs(completed_at, id)
  WHERE state IN ('completed', 'suppressed', 'expired', 'parked');

-- The recipient, login identity, raw token and recovery URL are held only in
-- payload_ciphertext. token_id permits an authoritative validity check at the
-- final dispatch boundary.
CREATE TABLE credential_recovery_delivery_outbox (
  id TEXT PRIMARY KEY,
  token_id TEXT NOT NULL UNIQUE
    REFERENCES credential_recovery_tokens(id) ON DELETE RESTRICT,
  payload_key_version INTEGER CHECK (payload_key_version = 1),
  payload_iv TEXT CHECK (payload_iv IS NULL OR length(payload_iv) = 16),
  payload_ciphertext TEXT CHECK (
    payload_ciphertext IS NULL
    OR (length(payload_ciphertext) BETWEEN 24 AND 8192)
  ),
  state TEXT NOT NULL CHECK (
    state IN ('pending', 'leased', 'dispatching', 'accepted', 'cancelled', 'expired', 'parked')
  ),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  next_attempt_at INTEGER NOT NULL,
  lease_token TEXT,
  lease_expires_at INTEGER,
  dispatch_started_at INTEGER,
  provider_message_id TEXT CHECK (
    provider_message_id IS NULL OR length(provider_message_id) BETWEEN 1 AND 255
  ),
  accepted_attempt_id TEXT CHECK (
    accepted_attempt_id IS NULL OR length(accepted_attempt_id) BETWEEN 1 AND 255
  ),
  provider_event_status TEXT CHECK (
    provider_event_status IS NULL OR provider_event_status IN ('delivery', 'bounce', 'complaint')
  ),
  provider_event_at INTEGER,
  last_error_code TEXT CHECK (last_error_code IS NULL OR length(last_error_code) <= 64),
  ambiguous_dispatch_count INTEGER NOT NULL DEFAULT 0 CHECK (ambiguous_dispatch_count >= 0),
  last_ambiguity_at INTEGER,
  cancellation_reason TEXT CHECK (
    cancellation_reason IS NULL OR length(cancellation_reason) <= 64
  ),
  cancellation_observed_at INTEGER,
  accepted_at INTEGER,
  completed_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  CHECK (
    (payload_key_version IS NULL AND payload_iv IS NULL AND payload_ciphertext IS NULL)
    OR (payload_key_version IS NOT NULL AND payload_iv IS NOT NULL AND payload_ciphertext IS NOT NULL)
  ),
  CHECK (
    (state IN ('leased', 'dispatching') AND lease_token IS NOT NULL AND lease_expires_at IS NOT NULL)
    OR (state NOT IN ('leased', 'dispatching') AND lease_token IS NULL AND lease_expires_at IS NULL)
  ),
  CHECK (state <> 'dispatching' OR dispatch_started_at IS NOT NULL),
  CHECK (
    (state IN ('accepted', 'cancelled', 'expired', 'parked') AND completed_at IS NOT NULL)
    OR (state IN ('pending', 'leased', 'dispatching') AND completed_at IS NULL)
  ),
  CHECK (
    (state = 'accepted' AND provider_message_id IS NOT NULL
      AND accepted_attempt_id IS NOT NULL AND accepted_at IS NOT NULL)
    OR (state <> 'accepted' AND provider_message_id IS NULL
      AND accepted_attempt_id IS NULL AND accepted_at IS NULL)
  ),
  CHECK (state NOT IN ('pending', 'leased', 'dispatching') OR payload_ciphertext IS NOT NULL),
  CHECK (state NOT IN ('accepted', 'cancelled', 'expired') OR payload_ciphertext IS NULL),
  CHECK (
    (last_ambiguity_at IS NULL AND ambiguous_dispatch_count = 0)
    OR (last_ambiguity_at IS NOT NULL AND ambiguous_dispatch_count > 0)
  ),
  CHECK (
    (cancellation_reason IS NULL AND cancellation_observed_at IS NULL)
    OR (cancellation_reason IS NOT NULL AND cancellation_observed_at IS NOT NULL)
  ),
  CHECK (
    (provider_event_status IS NULL AND provider_event_at IS NULL)
    OR (provider_event_status IS NOT NULL AND provider_event_at IS NOT NULL)
  )
);

CREATE INDEX idx_credential_recovery_delivery_outbox_due
  ON credential_recovery_delivery_outbox(next_attempt_at, created_at, id)
  WHERE state IN ('pending', 'leased');
CREATE INDEX idx_credential_recovery_delivery_outbox_dispatching
  ON credential_recovery_delivery_outbox(lease_expires_at, created_at, id)
  WHERE state = 'dispatching';
CREATE INDEX idx_credential_recovery_delivery_outbox_terminal
  ON credential_recovery_delivery_outbox(completed_at, id)
  WHERE state IN ('accepted', 'cancelled', 'expired', 'parked');
CREATE INDEX idx_credential_recovery_delivery_provider_message
  ON credential_recovery_delivery_outbox(provider_message_id)
  WHERE provider_message_id IS NOT NULL;

-- Every request that crossed the provider-I/O fence has a durable correlation
-- row. Ambiguous attempts remain correlatable after the outbox returns to
-- pending, so a late SES event can establish provider truth without a resend.
CREATE TABLE credential_recovery_delivery_attempts (
  attempt_id TEXT PRIMARY KEY CHECK (length(attempt_id) BETWEEN 1 AND 255),
  outbox_id TEXT NOT NULL
    REFERENCES credential_recovery_delivery_outbox(id) ON DELETE RESTRICT,
  state TEXT NOT NULL CHECK (
    state IN ('dispatching', 'ambiguous', 'http_rejected', 'accepted')
  ),
  provider_message_id TEXT CHECK (
    provider_message_id IS NULL OR length(provider_message_id) BETWEEN 1 AND 255
  ),
  dispatch_started_at INTEGER NOT NULL,
  resolved_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  CHECK (
    (state = 'accepted' AND provider_message_id IS NOT NULL AND resolved_at IS NOT NULL)
    OR (state <> 'accepted' AND provider_message_id IS NULL)
  )
);

CREATE INDEX idx_credential_recovery_delivery_attempts_outbox
  ON credential_recovery_delivery_attempts(outbox_id, created_at, attempt_id);
CREATE INDEX idx_credential_recovery_delivery_attempts_retention
  ON credential_recovery_delivery_attempts(updated_at, attempt_id);

-- Provider events are an idempotent evidence ledger. Acceptance remains on the
-- outbox row even if a later delivery, bounce, or complaint event is recorded.
CREATE TABLE credential_recovery_delivery_events (
  event_id TEXT PRIMARY KEY CHECK (length(event_id) BETWEEN 1 AND 255),
  outbox_id TEXT NOT NULL
    REFERENCES credential_recovery_delivery_outbox(id) ON DELETE RESTRICT,
  attempt_id TEXT NOT NULL
    REFERENCES credential_recovery_delivery_attempts(attempt_id) ON DELETE RESTRICT,
  provider_message_id TEXT NOT NULL CHECK (length(provider_message_id) BETWEEN 1 AND 255),
  event_type TEXT NOT NULL CHECK (event_type IN ('delivery', 'bounce', 'complaint')),
  occurred_at INTEGER NOT NULL,
  recorded_at INTEGER NOT NULL
);

CREATE INDEX idx_credential_recovery_delivery_events_outbox
  ON credential_recovery_delivery_events(outbox_id, occurred_at, event_id);
CREATE INDEX idx_credential_recovery_delivery_events_retention
  ON credential_recovery_delivery_events(recorded_at, event_id);

CREATE TRIGGER credential_recovery_email_reject_insert
BEFORE INSERT ON users
WHEN NEW.recovery_email IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'users.recovery_email is retired');
END;

CREATE TRIGGER credential_recovery_email_reject_update
BEFORE UPDATE OF recovery_email ON users
WHEN NEW.recovery_email IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'users.recovery_email is retired');
END;
