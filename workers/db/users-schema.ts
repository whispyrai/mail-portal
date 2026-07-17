// Global users table (D1), shared across the whole app. Per-mailbox data lives
// in the MailboxDO; users + credentials are a global concern and live here.
//
// Drizzle schema for the D1 database bound as `DB`. The matching DDL lives in
// migrations/0001_create_users.sql (applied with `wrangler d1 migrations apply`).

import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

// Role vocabulary lives next to the table that uses it (no central enum dump).
export const USER_ROLES = ["AGENT", "ADMIN"] as const;
export type UserRole = (typeof USER_ROLES)[number];

export const users = sqliteTable("users", {
  id: text("id").primaryKey(), // usr_<uuid>
  email: text("email").notNull().unique(), // login identity, lowercased
  password_hash: text("password_hash").notNull(), // PBKDF2-SHA256, base64
  password_salt: text("password_salt").notNull(), // 16 random bytes, base64
  session_version: integer("session_version").notNull().default(1),
  role: text("role", { enum: USER_ROLES }).notNull().default("AGENT"),
  is_active: integer("is_active").notNull().default(1),
  mailbox_address: text("mailbox_address").notNull().unique(), // usually == email
  mcp_token_hash: text("mcp_token_hash"), // SHA-256 of the user's MCP bearer token
  recovery_email: text("recovery_email"),
  ownership_confirmed_at: integer("ownership_confirmed_at"),
  created_at: integer("created_at").notNull(), // unix ms
  updated_at: integer("updated_at").notNull(), // unix ms
});

export const credentialRecoveryTokens = sqliteTable(
  "credential_recovery_tokens",
  {
    id: text("id").primaryKey(),
    user_id: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    token_hash: text("token_hash").notNull().unique(),
    expires_at: integer("expires_at").notNull(),
    consumed_at: integer("consumed_at"),
    consumption_nonce: text("consumption_nonce"),
    purpose: text("purpose", { enum: ["setup", "recovery"] }).notNull(),
    issued_by: text("issued_by").references(() => users.id, {
      onDelete: "set null",
    }),
    created_at: integer("created_at").notNull(),
  },
  (table) => [
    index("idx_credential_recovery_user").on(table.user_id, table.created_at),
    index("idx_credential_recovery_expiry").on(table.expires_at),
  ],
);

export const credentialRecoveryAudit = sqliteTable(
  "credential_recovery_audit",
  {
    id: text("id").primaryKey(),
    user_id: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    event_type: text("event_type").notNull(),
    actor_user_id: text("actor_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    created_at: integer("created_at").notNull(),
  },
  (table) => [
    index("idx_credential_recovery_audit_user").on(
      table.user_id,
      table.created_at,
    ),
  ],
);

export const credentialRecoveryRequestLimits = sqliteTable(
  "credential_recovery_request_limits",
  {
    throttle_key: text("throttle_key").primaryKey(),
    request_count: integer("request_count").notNull(),
    window_started_at: integer("window_started_at").notNull(),
    updated_at: integer("updated_at").notNull(),
  },
);

export const CREDENTIAL_RECOVERY_JOB_STATES = [
  "pending",
  "leased",
  "completed",
  "suppressed",
  "expired",
  "parked",
] as const;

export const credentialRecoveryRequestJobs = sqliteTable(
  "credential_recovery_request_jobs",
  {
    id: text("id").primaryKey(),
    account_ref: text("account_ref").notNull(),
    payload_key_version: integer("payload_key_version"),
    payload_iv: text("payload_iv"),
    payload_ciphertext: text("payload_ciphertext"),
    state: text("state", { enum: CREDENTIAL_RECOVERY_JOB_STATES }).notNull(),
    attempt_count: integer("attempt_count").notNull().default(0),
    next_attempt_at: integer("next_attempt_at").notNull(),
    lease_token: text("lease_token"),
    lease_expires_at: integer("lease_expires_at"),
    last_error_code: text("last_error_code"),
    completed_at: integer("completed_at"),
    created_at: integer("created_at").notNull(),
    updated_at: integer("updated_at").notNull(),
  },
  (table) => [
    index("idx_credential_recovery_request_jobs_due").on(
      table.next_attempt_at,
      table.created_at,
      table.id,
    ),
  ],
);

export const CREDENTIAL_RECOVERY_DELIVERY_STATES = [
  "pending",
  "leased",
  "dispatching",
  "accepted",
  "cancelled",
  "expired",
  "parked",
] as const;

export const credentialRecoveryDeliveryOutbox = sqliteTable(
  "credential_recovery_delivery_outbox",
  {
    id: text("id").primaryKey(),
    token_id: text("token_id")
      .notNull()
      .unique()
      .references(() => credentialRecoveryTokens.id, { onDelete: "restrict" }),
    payload_key_version: integer("payload_key_version"),
    payload_iv: text("payload_iv"),
    payload_ciphertext: text("payload_ciphertext"),
    state: text("state", {
      enum: CREDENTIAL_RECOVERY_DELIVERY_STATES,
    }).notNull(),
    attempt_count: integer("attempt_count").notNull().default(0),
    next_attempt_at: integer("next_attempt_at").notNull(),
    lease_token: text("lease_token"),
    lease_expires_at: integer("lease_expires_at"),
    dispatch_started_at: integer("dispatch_started_at"),
    provider_message_id: text("provider_message_id"),
    accepted_attempt_id: text("accepted_attempt_id"),
    provider_event_status: text("provider_event_status", {
      enum: ["delivery", "bounce", "complaint"],
    }),
    provider_event_at: integer("provider_event_at"),
    last_error_code: text("last_error_code"),
    ambiguous_dispatch_count: integer("ambiguous_dispatch_count")
      .notNull()
      .default(0),
    last_ambiguity_at: integer("last_ambiguity_at"),
    cancellation_reason: text("cancellation_reason"),
    cancellation_observed_at: integer("cancellation_observed_at"),
    accepted_at: integer("accepted_at"),
    completed_at: integer("completed_at"),
    created_at: integer("created_at").notNull(),
    updated_at: integer("updated_at").notNull(),
  },
  (table) => [
    index("idx_credential_recovery_delivery_outbox_due").on(
      table.next_attempt_at,
      table.created_at,
      table.id,
    ),
  ],
);

export const credentialRecoveryDeliveryAttempts = sqliteTable(
  "credential_recovery_delivery_attempts",
  {
    attempt_id: text("attempt_id").primaryKey(),
    outbox_id: text("outbox_id")
      .notNull()
      .references(() => credentialRecoveryDeliveryOutbox.id, {
        onDelete: "restrict",
      }),
    state: text("state", {
      enum: ["dispatching", "ambiguous", "http_rejected", "accepted"],
    }).notNull(),
    provider_message_id: text("provider_message_id"),
    dispatch_started_at: integer("dispatch_started_at").notNull(),
    resolved_at: integer("resolved_at"),
    created_at: integer("created_at").notNull(),
    updated_at: integer("updated_at").notNull(),
  },
  (table) => [
    index("idx_credential_recovery_delivery_attempts_outbox").on(
      table.outbox_id,
      table.created_at,
      table.attempt_id,
    ),
    index("idx_credential_recovery_delivery_attempts_retention").on(
      table.updated_at,
      table.attempt_id,
    ),
  ],
);

export const credentialRecoveryDeliveryEvents = sqliteTable(
  "credential_recovery_delivery_events",
  {
    event_id: text("event_id").primaryKey(),
    outbox_id: text("outbox_id")
      .notNull()
      .references(() => credentialRecoveryDeliveryOutbox.id, {
        onDelete: "restrict",
      }),
    attempt_id: text("attempt_id")
      .notNull()
      .references(() => credentialRecoveryDeliveryAttempts.attempt_id, {
        onDelete: "restrict",
      }),
    provider_message_id: text("provider_message_id").notNull(),
    event_type: text("event_type", {
      enum: ["delivery", "bounce", "complaint"],
    }).notNull(),
    occurred_at: integer("occurred_at").notNull(),
    recorded_at: integer("recorded_at").notNull(),
  },
  (table) => [
    index("idx_credential_recovery_delivery_events_outbox").on(
      table.outbox_id,
      table.occurred_at,
      table.event_id,
    ),
    index("idx_credential_recovery_delivery_events_retention").on(
      table.recorded_at,
      table.event_id,
    ),
  ],
);

export type UserRow = typeof users.$inferSelect;

export const MAILBOX_TYPES = ["PERSONAL", "SHARED"] as const;
export type MailboxType = (typeof MAILBOX_TYPES)[number];

export const mailboxes = sqliteTable(
  "mailboxes",
  {
    id: text("id").primaryKey(),
    address: text("address").notNull().unique(),
    type: text("type", { enum: MAILBOX_TYPES }).notNull(),
    owner_user_id: text("owner_user_id").references(() => users.id, {
      onDelete: "cascade",
    }),
    is_active: integer("is_active").notNull().default(1),
    created_at: integer("created_at").notNull(),
    updated_at: integer("updated_at").notNull(),
  },
  (table) => [
    check(
      "mailboxes_type_owner_check",
      sql`(${table.type} = 'PERSONAL' AND ${table.owner_user_id} IS NOT NULL) OR (${table.type} = 'SHARED' AND ${table.owner_user_id} IS NULL)`,
    ),
    check("mailboxes_is_active_check", sql`${table.is_active} IN (0, 1)`),
    uniqueIndex("idx_mailboxes_personal_owner")
      .on(table.owner_user_id)
      .where(sql`${table.type} = 'PERSONAL'`),
  ],
);

export const mailboxMemberships = sqliteTable(
  "mailbox_memberships",
  {
    mailbox_id: text("mailbox_id")
      .notNull()
      .references(() => mailboxes.id, { onDelete: "cascade" }),
    user_id: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    created_at: integer("created_at").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.mailbox_id, table.user_id] }),
    index("idx_mailbox_memberships_user_id").on(table.user_id),
  ],
);

export const AGENT_CONNECTION_REVOCATION_SCOPES = ["ACTOR", "MAILBOX"] as const;

export const agentConnectionRevocations = sqliteTable(
  "agent_connection_revocations",
  {
    id: text("id").primaryKey(),
    scope: text("scope", {
      enum: AGENT_CONNECTION_REVOCATION_SCOPES,
    }).notNull(),
    mailbox_id: text("mailbox_id").notNull(),
    user_id: text("user_id"),
    attempt_count: integer("attempt_count").notNull().default(0),
    next_attempt_at: integer("next_attempt_at").notNull(),
    lease_token: text("lease_token"),
    lease_expires_at: integer("lease_expires_at"),
    last_error_code: text("last_error_code"),
    created_at: integer("created_at").notNull(),
    updated_at: integer("updated_at").notNull(),
  },
  (table) => [
    check(
      "agent_connection_revocations_scope_check",
      sql`${table.scope} IN ('ACTOR', 'MAILBOX')`,
    ),
    check(
      "agent_connection_revocations_attempt_count_check",
      sql`${table.attempt_count} >= 0`,
    ),
    check(
      "agent_connection_revocations_scope_user_check",
      sql`(${table.scope} = 'ACTOR' AND ${table.user_id} IS NOT NULL) OR (${table.scope} = 'MAILBOX' AND ${table.user_id} IS NULL)`,
    ),
    check(
      "agent_connection_revocations_lease_check",
      sql`(${table.lease_token} IS NULL AND ${table.lease_expires_at} IS NULL) OR (${table.lease_token} IS NOT NULL AND ${table.lease_expires_at} IS NOT NULL)`,
    ),
    index("idx_agent_connection_revocations_due").on(
      table.next_attempt_at,
      table.lease_expires_at,
      table.created_at,
      table.id,
    ),
  ],
);

export type MailboxRow = typeof mailboxes.$inferSelect;

export const savedViews = sqliteTable(
  "saved_views",
  {
    id: text("id").primaryKey(),
    owner_user_id: text("owner_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    mailbox_address: text("mailbox_address").notNull(),
    name: text("name").notNull(),
    filter_json: text("filter_json").notNull(),
    sort_column: text("sort_column", {
      enum: ["date", "sender", "recipient", "subject", "read", "starred"],
    }).notNull(),
    sort_direction: text("sort_direction", { enum: ["ASC", "DESC"] }).notNull(),
    created_at: integer("created_at").notNull(),
    updated_at: integer("updated_at").notNull(),
  },
  (table) => [
    uniqueIndex("sqlite_autoindex_saved_views_owner_mailbox_name").on(
      table.owner_user_id,
      table.mailbox_address,
      table.name,
    ),
    index("idx_saved_views_owner_mailbox_updated").on(
      table.owner_user_id,
      table.mailbox_address,
      table.updated_at,
    ),
  ],
);

export const savedViewCreateOperations = sqliteTable(
  "saved_view_create_operations",
  {
    operation_key: text("operation_key").notNull().primaryKey(),
    fingerprint: text("fingerprint").notNull(),
    owner_user_id: text("owner_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    mailbox_address: text("mailbox_address").notNull(),
    view_id: text("view_id").notNull(),
    state: text("state", {
      enum: ["active", "superseded", "unavailable"],
    }).notNull(),
    updated_at: integer("updated_at").notNull(),
  },
  (table) => [
    check(
      "saved_view_create_operations_key_length_check",
      sql`length(${table.operation_key}) = 64`,
    ),
    check(
      "saved_view_create_operations_fingerprint_length_check",
      sql`length(${table.fingerprint}) = 64`,
    ),
    check(
      "saved_view_create_operations_state_check",
      sql`${table.state} IN ('active', 'superseded', 'unavailable')`,
    ),
    index("idx_saved_view_create_operations_resource").on(
      table.owner_user_id,
      table.mailbox_address,
      table.view_id,
    ),
    index("idx_saved_view_create_operations_retention")
      .on(table.updated_at, table.operation_key)
      .where(sql`${table.state} IN ('superseded', 'unavailable')`),
  ],
);

export const AI_USAGE_STATES = [
  "reserved",
  "completed",
  "failed",
  "blocked",
  "cache_hit",
  "deterministic",
] as const;

export const aiUsageMonths = sqliteTable(
  "ai_usage_months",
  {
    environment: text("environment").notNull(),
    month_key: text("month_key").notNull(),
    spent_micros: integer("spent_micros").notNull().default(0),
    reserved_micros: integer("reserved_micros").notNull().default(0),
    approved_budget_micros: integer("approved_budget_micros").notNull(),
    alert_emitted_at: integer("alert_emitted_at"),
    updated_at: integer("updated_at").notNull(),
  },
  (table) => [primaryKey({ columns: [table.environment, table.month_key] })],
);

export const aiUsageEvents = sqliteTable(
  "ai_usage_events",
  {
    id: text("id").primaryKey(),
    environment: text("environment").notNull(),
    month_key: text("month_key").notNull(),
    feature: text("feature").notNull(),
    actor_user_id: text("actor_user_id"),
    mailbox_id: text("mailbox_id"),
    requested_tier: text("requested_tier", {
      enum: ["auto", "cheap", "strong"],
    }).notNull(),
    selected_tier: text("selected_tier", {
      enum: ["cheap", "strong"],
    }).notNull(),
    model: text("model").notNull(),
    cache_key: text("cache_key"),
    escalation_reason: text("escalation_reason"),
    state: text("state", { enum: AI_USAGE_STATES }).notNull(),
    estimated_cost_micros: integer("estimated_cost_micros")
      .notNull()
      .default(0),
    reservation_limit_micros: integer("reservation_limit_micros"),
    reservation_expires_at: integer("reservation_expires_at"),
    actual_cost_micros: integer("actual_cost_micros").notNull().default(0),
    prompt_tokens: integer("prompt_tokens").notNull().default(0),
    completion_tokens: integer("completion_tokens").notNull().default(0),
    error_code: text("error_code"),
    created_at: integer("created_at").notNull(),
    completed_at: integer("completed_at"),
  },
  (table) => [
    index("idx_ai_usage_events_month_feature").on(
      table.environment,
      table.month_key,
      table.feature,
      table.created_at,
    ),
    index("idx_ai_usage_events_mailbox").on(table.mailbox_id, table.created_at),
    index("idx_ai_usage_events_reservation_expiry").on(
      table.state,
      table.reservation_expires_at,
    ),
  ],
);

export const aiResponseCache = sqliteTable(
  "ai_response_cache",
  {
    cache_key: text("cache_key").notNull(),
    environment: text("environment").notNull(),
    mailbox_id: text("mailbox_id"),
    mailbox_scope: text("mailbox_scope").notNull(),
    feature: text("feature").notNull(),
    value_json: text("value_json").notNull(),
    created_at: integer("created_at").notNull(),
    expires_at: integer("expires_at").notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.environment, table.cache_key, table.mailbox_scope],
    }),
    index("idx_ai_response_cache_expiry").on(table.expires_at),
    index("idx_ai_response_cache_mailbox_feature").on(
      table.mailbox_id,
      table.feature,
      table.created_at,
    ),
  ],
);

export const aiBudgetReviews = sqliteTable(
  "ai_budget_reviews",
  {
    id: text("id").primaryKey(),
    environment: text("environment").notNull(),
    month_key: text("month_key").notNull(),
    previous_budget_micros: integer("previous_budget_micros").notNull(),
    approved_budget_micros: integer("approved_budget_micros").notNull(),
    reviewed_by: text("reviewed_by").notNull(),
    reason: text("reason").notNull(),
    reviewed_at: integer("reviewed_at").notNull(),
  },
  (table) => [
    index("idx_ai_budget_reviews_month").on(
      table.environment,
      table.month_key,
      table.reviewed_at,
    ),
  ],
);
