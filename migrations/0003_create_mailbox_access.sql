-- Additive mailbox access model. Existing users.mailbox_address remains the
-- compatibility bridge to the current R2 and Durable Object mailbox identity.

CREATE TABLE IF NOT EXISTS mailboxes (
  id TEXT PRIMARY KEY,
  address TEXT NOT NULL UNIQUE,
  type TEXT NOT NULL,
  owner_user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
  is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  CONSTRAINT mailboxes_type_owner_check CHECK (
    (type = 'PERSONAL' AND owner_user_id IS NOT NULL)
    OR (type = 'SHARED' AND owner_user_id IS NULL)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_mailboxes_personal_owner
  ON mailboxes (owner_user_id)
  WHERE type = 'PERSONAL';

CREATE TABLE IF NOT EXISTS mailbox_memberships (
  mailbox_id TEXT NOT NULL REFERENCES mailboxes(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (mailbox_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_mailbox_memberships_user_id
  ON mailbox_memberships (user_id);

-- Existing accounts each own the Personal Mailbox already named by
-- users.mailbox_address. Lower-cased addresses preserve the current runtime key.
INSERT INTO mailboxes (
  id,
  address,
  type,
  owner_user_id,
  is_active,
  created_at,
  updated_at
)
SELECT
  lower(mailbox_address),
  lower(mailbox_address),
  'PERSONAL',
  id,
  is_active,
  created_at,
  updated_at
FROM users;
