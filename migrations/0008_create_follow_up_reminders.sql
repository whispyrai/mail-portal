CREATE TABLE follow_up_reminders (
  id TEXT PRIMARY KEY,
  owner_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  mailbox_address TEXT NOT NULL,
  conversation_key TEXT NOT NULL,
  baseline_message_id TEXT NOT NULL,
  baseline_message_date INTEGER NOT NULL,
  remind_at INTEGER NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('active', 'completed', 'dismissed')),
  resolution_reason TEXT CHECK (
    resolution_reason IS NULL OR
    resolution_reason IN ('manual', 'inbound_reply', 'dismissed')
  ),
  create_idempotency_key TEXT NOT NULL,
  create_fingerprint TEXT NOT NULL,
  create_result_json TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  resolved_at INTEGER,
  UNIQUE (owner_user_id, create_idempotency_key),
  UNIQUE (id, owner_user_id, mailbox_address),
  CHECK (
    (state = 'active' AND resolution_reason IS NULL AND resolved_at IS NULL) OR
    (state = 'completed' AND resolution_reason IN ('manual', 'inbound_reply') AND resolved_at IS NOT NULL) OR
    (state = 'dismissed' AND resolution_reason = 'dismissed' AND resolved_at IS NOT NULL)
  )
);

CREATE UNIQUE INDEX idx_follow_up_reminders_one_active_conversation
  ON follow_up_reminders(owner_user_id, mailbox_address, conversation_key)
  WHERE state = 'active';

CREATE INDEX idx_follow_up_reminders_owner_mailbox_due
  ON follow_up_reminders(owner_user_id, mailbox_address, state, remind_at, id);

CREATE INDEX idx_follow_up_reminders_mailbox_conversation_active
  ON follow_up_reminders(mailbox_address, conversation_key, state, baseline_message_date);

CREATE TABLE follow_up_reminder_operations (
  id TEXT PRIMARY KEY,
  owner_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  mailbox_address TEXT NOT NULL,
  reminder_id TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('dismiss', 'complete', 'snooze')),
  payload_fingerprint TEXT NOT NULL,
  result_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE (owner_user_id, operation_id),
  FOREIGN KEY (reminder_id, owner_user_id, mailbox_address)
    REFERENCES follow_up_reminders(id, owner_user_id, mailbox_address)
    ON DELETE CASCADE
);

CREATE INDEX idx_follow_up_reminder_operations_reminder
  ON follow_up_reminder_operations(reminder_id, created_at DESC);
