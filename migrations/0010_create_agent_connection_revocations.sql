CREATE TABLE agent_connection_revocations (
  id TEXT PRIMARY KEY,
  scope TEXT NOT NULL CHECK (scope IN ('ACTOR', 'MAILBOX')),
  mailbox_id TEXT NOT NULL,
  user_id TEXT,
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  next_attempt_at INTEGER NOT NULL,
  lease_token TEXT,
  lease_expires_at INTEGER,
  last_error_code TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  CHECK (
    (scope = 'ACTOR' AND user_id IS NOT NULL)
    OR (scope = 'MAILBOX' AND user_id IS NULL)
  ),
  CHECK (
    (lease_token IS NULL AND lease_expires_at IS NULL)
    OR (lease_token IS NOT NULL AND lease_expires_at IS NOT NULL)
  )
);

CREATE INDEX idx_agent_connection_revocations_due
  ON agent_connection_revocations (next_attempt_at, lease_expires_at, created_at, id);

CREATE TRIGGER users_enqueue_agent_connection_reconciliation
AFTER UPDATE OF session_version, is_active ON users
WHEN NEW.session_version <> OLD.session_version
  OR (OLD.is_active = 1 AND NEW.is_active = 0)
BEGIN
  INSERT INTO agent_connection_revocations (
    id, scope, mailbox_id, user_id, attempt_count, next_attempt_at,
    lease_token, lease_expires_at, last_error_code, created_at, updated_at
  )
  SELECT
    'acr_' || lower(hex(randomblob(16))),
    'ACTOR',
    access.mailbox_id,
    NEW.id,
    0,
    unixepoch() * 1000,
    NULL,
    NULL,
    NULL,
    unixepoch() * 1000,
    unixepoch() * 1000
  FROM (
    SELECT id AS mailbox_id FROM mailboxes WHERE owner_user_id = NEW.id
    UNION
    SELECT mailbox_id FROM mailbox_memberships WHERE user_id = NEW.id
  ) AS access;
END;

CREATE TRIGGER mailbox_memberships_enqueue_agent_connection_reconciliation
AFTER DELETE ON mailbox_memberships
BEGIN
  INSERT INTO agent_connection_revocations (
    id, scope, mailbox_id, user_id, attempt_count, next_attempt_at,
    lease_token, lease_expires_at, last_error_code, created_at, updated_at
  ) VALUES (
    'acr_' || lower(hex(randomblob(16))),
    'ACTOR',
    OLD.mailbox_id,
    OLD.user_id,
    0,
    unixepoch() * 1000,
    NULL,
    NULL,
    NULL,
    unixepoch() * 1000,
    unixepoch() * 1000
  );
END;

CREATE TRIGGER mailboxes_enqueue_agent_connection_reconciliation
AFTER UPDATE OF is_active ON mailboxes
WHEN OLD.is_active = 1 AND NEW.is_active = 0
BEGIN
  INSERT INTO agent_connection_revocations (
    id, scope, mailbox_id, user_id, attempt_count, next_attempt_at,
    lease_token, lease_expires_at, last_error_code, created_at, updated_at
  ) VALUES (
    'acr_' || lower(hex(randomblob(16))),
    'MAILBOX',
    NEW.id,
    NULL,
    0,
    unixepoch() * 1000,
    NULL,
    NULL,
    NULL,
    unixepoch() * 1000,
    unixepoch() * 1000
  );
END;
