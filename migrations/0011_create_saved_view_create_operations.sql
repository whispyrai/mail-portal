CREATE TABLE saved_view_create_operations (
  operation_key TEXT NOT NULL PRIMARY KEY CHECK (length(operation_key) = 64),
  fingerprint TEXT NOT NULL CHECK (length(fingerprint) = 64),
  owner_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  mailbox_address TEXT NOT NULL,
  view_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('active', 'superseded', 'unavailable')),
  updated_at INTEGER NOT NULL
);

CREATE INDEX idx_saved_view_create_operations_resource
  ON saved_view_create_operations(owner_user_id, mailbox_address, view_id);

CREATE INDEX idx_saved_view_create_operations_retention
  ON saved_view_create_operations(updated_at, operation_key)
  WHERE state IN ('superseded', 'unavailable');
