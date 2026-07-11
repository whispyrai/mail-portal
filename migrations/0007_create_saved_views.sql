CREATE TABLE saved_views (
  id TEXT PRIMARY KEY,
  owner_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  mailbox_address TEXT NOT NULL,
  name TEXT NOT NULL COLLATE NOCASE,
  filter_json TEXT NOT NULL CHECK (length(filter_json) <= 4096),
  sort_column TEXT NOT NULL CHECK (
    sort_column IN ('date', 'sender', 'recipient', 'subject', 'read', 'starred')
  ),
  sort_direction TEXT NOT NULL CHECK (sort_direction IN ('ASC', 'DESC')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (owner_user_id, mailbox_address, name)
);

CREATE INDEX idx_saved_views_owner_mailbox_updated
  ON saved_views(owner_user_id, mailbox_address, updated_at DESC);
