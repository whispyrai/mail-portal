-- Global users table for the sales mail portal (D1, binding `DB`).
-- Apply with: npx wrangler d1 migrations apply sales_portal_users [--remote]

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  password_salt TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'AGENT',
  is_active INTEGER NOT NULL DEFAULT 1,
  mailbox_address TEXT NOT NULL UNIQUE,
  mcp_token_hash TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_users_mcp_token_hash ON users (mcp_token_hash);
