// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import {
	check,
	foreignKey,
	index,
	integer,
	primaryKey,
	sqliteTable,
	text,
	uniqueIndex,
} from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";

export const folders = sqliteTable("folders", {
	id: text("id").primaryKey(),
	name: text("name").notNull().unique(),
	is_deletable: integer("is_deletable").notNull().default(1),
});

export const resourceCreateOperations = sqliteTable(
  "resource_create_operations",
  {
    operation_key: text("operation_key").primaryKey(),
    resource_kind: text("resource_kind", {
      enum: ["folder", "label"],
    }).notNull(),
    fingerprint: text("fingerprint").notNull(),
    resource_id: text("resource_id").notNull(),
    state: text("state", {
      enum: ["active", "superseded", "unavailable"],
    }).notNull(),
    updated_at: text("updated_at").notNull(),
  },
  (table) => [
    check(
      "resource_create_operations_key_length_check",
      sql`length(${table.operation_key}) = 64`,
    ),
    check(
      "resource_create_operations_fingerprint_length_check",
      sql`length(${table.fingerprint}) = 64`,
    ),
    check(
      "resource_create_operations_kind_check",
      sql`${table.resource_kind} IN ('folder', 'label')`,
    ),
    check(
      "resource_create_operations_state_check",
      sql`${table.state} IN ('active', 'superseded', 'unavailable')`,
    ),
    index("idx_resource_create_operations_resource").on(
      table.resource_kind,
      table.resource_id,
    ),
    index("idx_resource_create_operations_retention")
      .on(table.updated_at, table.operation_key)
      .where(sql`${table.state} IN ('superseded', 'unavailable')`),
  ],
);

export const emails = sqliteTable("emails", {
	id: text("id").primaryKey(),
	folder_id: text("folder_id")
		.notNull()
		.references(() => folders.id, { onDelete: "cascade" }),
	subject: text("subject"),
	sender: text("sender"),
	recipient: text("recipient"),
	cc: text("cc"),
	bcc: text("bcc"),
	date: text("date"),
	read: integer("read").default(0),
	starred: integer("starred").default(0),
	body: text("body"),
	in_reply_to: text("in_reply_to"),
	email_references: text("email_references"),
	thread_id: text("thread_id"),
	message_id: text("message_id"),
	raw_headers: text("raw_headers"),
	sender_name: text("sender_name"),
	recipient_memory_origin: text("recipient_memory_origin", {
		enum: ["live_inbound", "accepted_outbound", "admin_import"],
	}),
	previous_folder_id: text("previous_folder_id"),
	trashed_at: text("trashed_at"),
	snooze_source_folder_id: text("snooze_source_folder_id"),
	snoozed_until: text("snoozed_until"),
	draft_version: integer("draft_version").notNull().default(1),
	draft_create_key: text("draft_create_key"),
	draft_create_fingerprint: text("draft_create_fingerprint"),
});

export const draftCreateOperations = sqliteTable(
	"draft_create_operations",
	{
		create_key: text("create_key").primaryKey(),
		fingerprint: text("fingerprint").notNull(),
		draft_id: text("draft_id").notNull(),
		draft_version: integer("draft_version").notNull(),
		state: text("state", {
			enum: ["active", "discarded", "consumed", "deleted", "unavailable"],
		}).notNull(),
		updated_at: text("updated_at").notNull(),
	},
	(table) => [
		index("idx_draft_create_operations_draft_id").on(table.draft_id),
	],
);

export const draftUpdateOperations = sqliteTable(
	"draft_update_operations",
	{
		update_key: text("update_key").primaryKey(),
		fingerprint: text("fingerprint").notNull(),
		draft_id: text("draft_id").notNull(),
		previous_version: integer("previous_version").notNull(),
		result_version: integer("result_version").notNull(),
		committed_at: text("committed_at").notNull(),
	},
	(table) => [
		check(
			"draft_update_operations_previous_version_check",
			sql`${table.previous_version} >= 1`,
		),
		check(
			"draft_update_operations_result_version_check",
			sql`${table.result_version} = ${table.previous_version} + 1`,
		),
		index("idx_draft_update_operations_result").on(
			table.draft_id,
			table.result_version,
		),
	],
);

export const draftSaveOperations = sqliteTable(
	"draft_save_operations",
	{
		save_key: text("save_key").primaryKey(),
		fingerprint: text("fingerprint").notNull(),
		draft_id: text("draft_id").notNull(),
		expected_version: integer("expected_version").notNull(),
		state: text("state", {
			enum: ["claimed", "committed", "aborted"],
		}).notNull(),
		destination_keys: text("destination_keys").notNull().default("[]"),
		committed_version: integer("committed_version"),
		claim_expires_at: integer("claim_expires_at").notNull(),
		claim_token: text("claim_token"),
		updated_at: text("updated_at").notNull(),
	},
	(table) => [
		index("idx_draft_save_operations_revision").on(
			table.draft_id,
			table.expected_version,
			table.state,
		),
		index("idx_draft_save_operations_retention")
			.on(table.updated_at, table.save_key)
			.where(sql`${table.state} IN ('committed', 'aborted')`),
		index("idx_draft_save_operations_expiry")
			.on(table.state, table.claim_expires_at, table.save_key),
	],
);

export const draftSaveCleanupIntents = sqliteTable(
	"draft_save_cleanup_intents",
	{
		claim_token: text("claim_token").primaryKey(),
		draft_id: text("draft_id").notNull(),
		destination_keys: text("destination_keys").notNull(),
		next_attempt_at: integer("next_attempt_at").notNull(),
			verify_until: integer("verify_until").notNull(),
			attempts: integer("attempts").notNull().default(0),
			state: text("state", { enum: ["pending", "parked"] })
				.notNull()
				.default("pending"),
			generation: integer("generation").notNull().default(0),
			last_error_code: text("last_error_code"),
			parked_at: integer("parked_at"),
			updated_at: text("updated_at").notNull(),
		},
		(table) => [
			index("idx_draft_save_cleanup_due").on(
				table.state,
				table.next_attempt_at,
			table.claim_token,
		),
	],
);

export const snoozeReplyWakeQueue = sqliteTable("snooze_reply_wake_queue", {
	thread_id: text("thread_id").primaryKey(),
	requested_at: text("requested_at").notNull(),
});

export const followUpReplyCompletionQueue = sqliteTable(
	"follow_up_reply_completion_queue",
	{
		inbound_message_id: text("inbound_message_id").primaryKey(),
		mailbox_address: text("mailbox_address").notNull(),
		conversation_key: text("conversation_key").notNull(),
		inbound_message_date: text("inbound_message_date").notNull(),
		attempts: integer("attempts").notNull().default(0),
		next_attempt_at: integer("next_attempt_at").notNull(),
		created_at: integer("created_at").notNull(),
		last_error: text("last_error"),
	},
	(table) => [
		index("idx_follow_up_reply_completion_due").on(
			table.next_attempt_at,
			table.inbound_message_id,
		),
	],
);

export const recipientInteractions = sqliteTable(
	"recipient_interactions",
	{
		source_email_id: text("source_email_id")
			.notNull()
			.references(() => emails.id, { onDelete: "cascade" }),
		address: text("address").notNull(),
		direction: text("direction", { enum: ["sent", "received"] }).notNull(),
		occurred_at: text("occurred_at").notNull(),
	},
	(table) => [
		primaryKey({
			columns: [table.source_email_id, table.address, table.direction],
		}),
		index("idx_recipient_interactions_address").on(
			table.address,
			table.direction,
			table.occurred_at,
		),
		index("idx_recipient_interactions_occurred").on(
			table.occurred_at,
			table.address,
		),
	],
);

export const recipientInteractionMeta = sqliteTable("recipient_interaction_meta", {
	key: text("key").primaryKey(),
	value: text("value").notNull(),
});

export const attachments = sqliteTable(
	"attachments",
	{
		id: text("id").primaryKey(),
		email_id: text("email_id")
			.notNull()
			.references(() => emails.id, { onDelete: "cascade" }),
		filename: text("filename").notNull(),
		mimetype: text("mimetype").notNull(),
		size: integer("size").notNull(),
		content_id: text("content_id"),
		disposition: text("disposition"),
		r2_key: text("r2_key"),
	},
	(table) => [index("idx_attachments_email_id_id").on(table.email_id, table.id)],
);

export const emailDeletionTombstones = sqliteTable("email_deletion_tombstones", {
	id: text("id").primaryKey(),
	deleted_at: text("deleted_at").notNull().default(sql`(datetime('now'))`),
});

export const inboundTerminalFailures = sqliteTable(
	"inbound_terminal_failures",
	{
		id: text("id").primaryKey(),
		queue_ref: text("queue_ref").notNull(),
		attempts: integer("attempts").notNull(),
		error_code: text("error_code").notNull(),
		recorded_at: text("recorded_at").notNull().default(sql`(datetime('now'))`),
	},
	(table) => [
		check(
			"inbound_terminal_failures_queue_ref",
			sql`length(${table.queue_ref}) = 16 AND ${table.queue_ref} NOT GLOB '*[^0-9a-f]*'`,
		),
		check("inbound_terminal_failures_attempts_nonnegative", sql`${table.attempts} >= 0`),
		check(
			"inbound_terminal_failures_error_code",
			sql`${table.error_code} = 'QUEUE_RETRY_EXHAUSTED'`,
		),
	],
);

export const emailBodyObjects = sqliteTable(
	"email_body_objects",
	{
		id: text("id").primaryKey(),
		email_id: text("email_id")
			.notNull()
			.references(() => emails.id, { onDelete: "cascade" }),
		part_index: integer("part_index").notNull(),
		content_type: text("content_type", {
			enum: ["text/html", "text/plain"],
		}).notNull(),
		charset: text("charset").notNull(),
		r2_key: text("r2_key").notNull(),
		byte_length: integer("byte_length").notNull(),
	},
	(table) => [
		index("idx_email_body_objects_email_id").on(table.email_id, table.part_index),
		uniqueIndex("idx_email_body_objects_r2_key").on(table.r2_key),
		check("email_body_objects_part_index_nonnegative", sql`${table.part_index} >= 0`),
		check("email_body_objects_byte_length_nonnegative", sql`${table.byte_length} >= 0`),
	],
);

export const inboundDerivedContentState = sqliteTable(
	"inbound_derived_content_state",
	{
		email_id: text("email_id")
			.primaryKey()
			.references(() => emails.id, { onDelete: "cascade" }),
		generation: integer("generation").notNull().default(1),
		last_repair_marker_id: text("last_repair_marker_id"),
		last_repaired_at: text("last_repaired_at"),
	},
	(table) => [
		check("inbound_derived_content_state_generation_positive", sql`${table.generation} >= 1`),
	],
);

export const inboundDerivedContentRepairAttempts = sqliteTable(
	"inbound_derived_content_repair_attempts",
	{
		attempt_id: text("attempt_id").primaryKey(),
		email_id: text("email_id").notNull(),
		expected_generation: integer("expected_generation").notNull(),
		marker_id: text("marker_id").notNull(),
		command_fingerprint: text("command_fingerprint").notNull(),
		outcome: text("outcome", {
			enum: ["committed", "rejected", "abandoned"],
		}).notNull(),
		result_generation: integer("result_generation"),
		recorded_at: text("recorded_at").notNull(),
	},
	(table) => [
		index("idx_inbound_repair_attempts_email").on(table.email_id, table.recorded_at),
		check(
			"inbound_repair_attempts_generation_positive",
			sql`${table.expected_generation} >= 1`,
		),
		check(
			"inbound_repair_attempts_fingerprint_length",
			sql`length(${table.command_fingerprint}) = 64`,
		),
		check(
			"inbound_repair_attempts_outcome_closed",
			sql`${table.outcome} IN ('committed', 'rejected', 'abandoned')`,
		),
		check(
			"inbound_repair_attempts_result_generation",
			sql`(${table.outcome} = 'committed' AND ${table.result_generation} IS NOT NULL AND ${table.result_generation} >= 1) OR (${table.outcome} <> 'committed' AND ${table.result_generation} IS NULL)`,
		),
	],
);

export const r2DeletionOutbox = sqliteTable(
	"r2_deletion_outbox",
	{
		r2_key: text("r2_key").primaryKey(),
		email_id: text("email_id").notNull(),
		projection_attempt_id: text("projection_attempt_id"),
		state: text("state", { enum: ["pending", "deleting"] })
			.notNull()
			.default("pending"),
		claim_generation: integer("claim_generation").notNull().default(0),
		lease_token: text("lease_token"),
		lease_expires_at: text("lease_expires_at"),
		attempts: integer("attempts").notNull().default(0),
		next_attempt_at: text("next_attempt_at").notNull().default(sql`(datetime('now'))`),
		last_error: text("last_error"),
		parked_at: text("parked_at"),
		recovery_ref: text("recovery_ref"),
		created_at: text("created_at").notNull().default(sql`(datetime('now'))`),
	},
	(table) => [
		index("idx_r2_deletion_outbox_pending").on(
			table.state,
			table.next_attempt_at,
			table.r2_key,
		),
		index("idx_r2_deletion_outbox_lease").on(
			table.state,
			table.lease_expires_at,
			table.r2_key,
		),
		index("idx_r2_deletion_outbox_parked").on(
			table.parked_at,
			table.recovery_ref,
		),
		check(
			"r2_deletion_outbox_state_valid",
			sql`${table.state} IN ('pending', 'deleting')`,
		),
		check(
			"r2_deletion_outbox_claim_generation_nonnegative",
			sql`${table.claim_generation} >= 0`,
		),
		check("r2_deletion_outbox_attempts_nonnegative", sql`${table.attempts} >= 0`),
		check(
			"r2_deletion_outbox_lease_state",
			sql`(${table.state} = 'pending' AND ${table.lease_token} IS NULL AND ${table.lease_expires_at} IS NULL) OR (${table.state} = 'deleting' AND ${table.lease_token} IS NOT NULL AND ${table.lease_expires_at} IS NOT NULL)`,
		),
	],
);

export const inboundDerivedContentRetiredAttempts = sqliteTable(
	"inbound_derived_content_retired_attempts",
	{
		attempt_id: text("attempt_id").primaryKey(),
		email_id: text("email_id").notNull(),
		retired_at: text("retired_at").notNull(),
		expires_at: text("expires_at").notNull(),
		reason: text("reason", { enum: ["r2_deletion_started"] }).notNull(),
	},
	(table) => [
		index("idx_inbound_retired_attempts_expiry").on(
			table.expires_at,
			table.attempt_id,
		),
		check(
			"inbound_retired_attempts_reason",
			sql`${table.reason} = 'r2_deletion_started'`,
		),
	],
);

export const r2RetiredKeyFences = sqliteTable(
	"r2_retired_key_fences",
	{
		r2_key: text("r2_key").primaryKey(),
		email_id: text("email_id").notNull(),
		retired_at: text("retired_at").notNull(),
		reason: text("reason", { enum: ["r2_deletion_started"] }).notNull(),
	},
	(table) => [
		check(
			"r2_retired_key_fences_reason",
			sql`${table.reason} = 'r2_deletion_started'`,
		),
	],
);

export const importGenerationClaims = sqliteTable(
	"import_generation_claims",
	{
		message_id: text("message_id").primaryKey(),
		claim_token: text("claim_token").notNull(),
		expires_at: integer("expires_at").notNull(),
		created_at: integer("created_at").notNull(),
	},
	(table) => [index("idx_import_generation_claims_expiry").on(table.expires_at, table.message_id)],
);

export const importPromotionIntents = sqliteTable(
  "import_promotion_intents",
  {
    email_id: text("email_id").notNull(),
    claim_token: text("claim_token").notNull(),
    object_count: integer("object_count").notNull(),
    total_byte_length: integer("total_byte_length").notNull(),
    state: text("state", {
      enum: [
        "staging",
        "recorded",
        "reconciling",
        "abandoned_watching",
        "finalized",
        "integrity_blocked",
      ],
    }).notNull(),
    proof_fingerprint: text("proof_fingerprint"),
    recorded_count: integer("recorded_count").notNull().default(0),
    recorded_byte_length: integer("recorded_byte_length").notNull().default(0),
    rolling_fingerprint: text("rolling_fingerprint").notNull(),
    last_append_start: integer("last_append_start"),
    last_append_count: integer("last_append_count"),
    writer_closed: integer("writer_closed").notNull().default(0),
    claim_generation: integer("claim_generation").notNull().default(0),
    reconciliation_phase: text("reconciliation_phase", {
      enum: ["validation", "settlement"],
    }),
    reconciliation_cycle: integer("reconciliation_cycle").notNull().default(0),
    validation_cursor: integer("validation_cursor").notNull().default(0),
    settlement_cursor: integer("settlement_cursor").notNull().default(0),
    lease_token: text("lease_token"),
    lease_expires_at: integer("lease_expires_at"),
    next_reconcile_at: integer("next_reconcile_at").notNull(),
    retained_count: integer("retained_count"),
    outboxed_count: integer("outboxed_count"),
    absent_count: integer("absent_count"),
    created_at: integer("created_at").notNull(),
    updated_at: integer("updated_at").notNull(),
    finalized_at: integer("finalized_at"),
  },
  (table) => [
    primaryKey({ columns: [table.email_id, table.claim_token] }),
    index("idx_import_promotion_intents_due").on(
      table.state,
      table.next_reconcile_at,
      table.email_id,
      table.claim_token,
    ),
    index("idx_import_promotion_intents_lease").on(
      table.state,
      table.lease_expires_at,
      table.email_id,
      table.claim_token,
    ),
    check(
      "import_promotion_intents_object_count",
      sql`${table.object_count} >= 0`,
    ),
    check(
      "import_promotion_intents_total_bytes",
      sql`${table.total_byte_length} >= 0 AND ${table.total_byte_length} <= 26214400`,
    ),
    check(
      "import_promotion_intents_recorded_count",
      sql`${table.recorded_count} >= 0 AND ${table.recorded_count} <= ${table.object_count}`,
    ),
    check(
      "import_promotion_intents_recorded_bytes",
      sql`${table.recorded_byte_length} >= 0 AND ${table.recorded_byte_length} <= ${table.total_byte_length}`,
    ),
    check(
      "import_promotion_intents_state",
      sql`${table.state} IN ('staging', 'recorded', 'reconciling', 'abandoned_watching', 'finalized', 'integrity_blocked')`,
    ),
    check(
      "import_promotion_intents_phase",
      sql`${table.reconciliation_phase} IS NULL OR ${table.reconciliation_phase} IN ('validation', 'settlement')`,
    ),
    check(
      "import_promotion_intents_fingerprint",
      sql`(${table.proof_fingerprint} IS NULL OR (length(${table.proof_fingerprint}) = 64 AND ${table.proof_fingerprint} NOT GLOB '*[^0-9a-f]*')) AND length(${table.rolling_fingerprint}) = 64 AND ${table.rolling_fingerprint} NOT GLOB '*[^0-9a-f]*'`,
    ),
    check(
      "import_promotion_intents_last_append",
      sql`(${table.last_append_start} IS NULL AND ${table.last_append_count} IS NULL AND ${table.recorded_count} = 0) OR (${table.last_append_start} IS NOT NULL AND ${table.last_append_start} >= 0 AND ${table.last_append_count} IS NOT NULL AND ${table.last_append_count} > 0 AND ${table.last_append_start} + ${table.last_append_count} = ${table.recorded_count})`,
    ),
    check(
      "import_promotion_intents_writer",
      sql`${table.writer_closed} IN (0, 1)`,
    ),
    check(
      "import_promotion_intents_generations",
      sql`${table.claim_generation} >= 0 AND ${table.reconciliation_cycle} >= 0`,
    ),
    check(
      "import_promotion_intents_cursors",
      sql`${table.validation_cursor} >= 0 AND ${table.validation_cursor} <= ${table.object_count} AND ${table.settlement_cursor} >= 0 AND ${table.settlement_cursor} <= ${table.object_count}`,
    ),
    check(
      "import_promotion_intents_lease_state",
      sql`(${table.state} = 'reconciling' AND ${table.lease_token} IS NOT NULL AND ${table.lease_expires_at} IS NOT NULL) OR (${table.state} <> 'reconciling' AND ${table.lease_token} IS NULL AND ${table.lease_expires_at} IS NULL)`,
    ),
    check(
      "import_promotion_intents_finalized_metadata",
      sql`(${table.state} = 'finalized' AND ${table.finalized_at} IS NOT NULL AND ${table.retained_count} IS NOT NULL AND ${table.retained_count} >= 0 AND ${table.outboxed_count} IS NOT NULL AND ${table.outboxed_count} >= 0 AND ${table.absent_count} IS NOT NULL AND ${table.absent_count} >= 0 AND ${table.retained_count} + ${table.outboxed_count} + ${table.absent_count} = ${table.object_count} AND (${table.writer_closed} = 1 OR (${table.retained_count} = ${table.object_count} AND ${table.outboxed_count} = 0 AND ${table.absent_count} = 0))) OR (${table.state} <> 'finalized' AND ${table.finalized_at} IS NULL AND ${table.retained_count} IS NULL AND ${table.outboxed_count} IS NULL AND ${table.absent_count} IS NULL)`,
    ),
    check(
      "import_promotion_intents_lifecycle",
      sql`(${table.state} = 'staging' AND ${table.proof_fingerprint} IS NULL AND ${table.reconciliation_phase} IS NULL AND ${table.reconciliation_cycle} = 0 AND ${table.validation_cursor} = 0 AND ${table.settlement_cursor} = 0) OR (${table.state} IN ('recorded', 'reconciling', 'abandoned_watching') AND ${table.proof_fingerprint} = ${table.rolling_fingerprint} AND ${table.reconciliation_phase} IN ('validation', 'settlement') AND ${table.reconciliation_cycle} > 0) OR (${table.state} = 'integrity_blocked' AND ${table.proof_fingerprint} = ${table.rolling_fingerprint} AND ${table.reconciliation_phase} = 'validation' AND ${table.reconciliation_cycle} > 0) OR (${table.state} = 'finalized' AND ${table.proof_fingerprint} = ${table.rolling_fingerprint} AND ${table.reconciliation_phase} IS NULL AND ${table.reconciliation_cycle} > 0)`,
    ),
    check(
      "import_promotion_intents_phase_cursor",
      sql`(${table.reconciliation_phase} = 'validation' AND ${table.settlement_cursor} = 0) OR (${table.reconciliation_phase} = 'settlement' AND ${table.validation_cursor} = ${table.object_count}) OR ${table.reconciliation_phase} IS NULL`,
    ),
  ],
);

export const importPromotionIntentObjects = sqliteTable(
  "import_promotion_intent_objects",
  {
    email_id: text("email_id").notNull(),
    claim_token: text("claim_token").notNull(),
    ordinal: integer("ordinal").notNull(),
    r2_key: text("r2_key").notNull().unique(),
    byte_length: integer("byte_length").notNull(),
    resolution: text("resolution", {
      enum: ["pending", "retained", "outboxed", "absent", "integrity_blocked"],
    }).notNull(),
    observation_state: text("observation_state", {
      enum: ["authoritative", "unowned_present", "absent"],
    }),
    observation_cycle: integer("observation_cycle"),
    observed_byte_length: integer("observed_byte_length"),
    last_observed_at: integer("last_observed_at"),
  },
  (table) => [
    primaryKey({ columns: [table.email_id, table.claim_token, table.ordinal] }),
    foreignKey({
      columns: [table.email_id, table.claim_token],
      foreignColumns: [
        importPromotionIntents.email_id,
        importPromotionIntents.claim_token,
      ],
    }).onDelete("cascade"),
    index("idx_import_promotion_objects_resolution").on(
      table.email_id,
      table.claim_token,
      table.resolution,
      table.last_observed_at,
      table.ordinal,
    ),
    check("import_promotion_objects_ordinal", sql`${table.ordinal} >= 0`),
    check(
      "import_promotion_objects_bytes",
      sql`${table.byte_length} >= 0 AND ${table.byte_length} <= 26214400`,
    ),
    check(
      "import_promotion_objects_resolution",
      sql`${table.resolution} IN ('pending', 'retained', 'outboxed', 'absent', 'integrity_blocked')`,
    ),
    check(
      "import_promotion_objects_observation_state",
      sql`${table.observation_state} IS NULL OR ${table.observation_state} IN ('authoritative', 'unowned_present', 'absent')`,
    ),
    check(
      "import_promotion_objects_observation_bounds",
      sql`(${table.observation_cycle} IS NULL OR ${table.observation_cycle} >= 0) AND (${table.observed_byte_length} IS NULL OR ${table.observed_byte_length} >= 0)`,
    ),
    check(
      "import_promotion_objects_observation",
      sql`(${table.observation_state} IS NULL AND ${table.observation_cycle} IS NULL AND ${table.observed_byte_length} IS NULL) OR (${table.observation_state} IN ('authoritative', 'unowned_present') AND ${table.observation_cycle} IS NOT NULL AND ${table.observed_byte_length} IS NOT NULL) OR (${table.observation_state} = 'absent' AND ${table.observation_cycle} IS NOT NULL AND ${table.observed_byte_length} IS NULL)`,
    ),
  ],
);

export const pushSubscriptions = sqliteTable(
  "push_subscriptions",
  {
    id: text("id").primaryKey(),
    user_id: text("user_id"),
    endpoint: text("endpoint").notNull().unique(),
    p256dh: text("p256dh").notNull(),
    auth: text("auth").notNull(),
    user_agent: text("user_agent"),
    device_label: text("device_label"),
    created_at: text("created_at")
      .notNull()
      .default(sql`(datetime('now'))`),
    last_seen_at: text("last_seen_at")
      .notNull()
      .default(sql`(datetime('now'))`),
    generation: integer("generation").notNull().default(1),
    last_push_attempt_at: text("last_push_attempt_at"),
    last_push_accepted_at: text("last_push_accepted_at"),
    last_push_failure_at: text("last_push_failure_at"),
    last_push_failure_reason: text("last_push_failure_reason"),
    consecutive_push_failures: integer("consecutive_push_failures")
      .notNull()
      .default(0),
  },
  (table) => [index("idx_push_subscriptions_user_id").on(table.user_id)],
);

export const activityEvents = sqliteTable("activity_events", {
  id: text("id").primaryKey(),
  actor_kind: text("actor_kind").notNull(),
  actor_id: text("actor_id"),
  action: text("action").notNull(),
  entity_type: text("entity_type").notNull(),
  entity_id: text("entity_id").notNull(),
  metadata_json: text("metadata_json"),
  occurred_at: text("occurred_at").notNull(),
});

export const mailboxChanges = sqliteTable("mailbox_changes", {
  sequence: integer("sequence").primaryKey({ autoIncrement: true }),
  schema_version: integer("schema_version").notNull(),
  committed_at: text("committed_at").notNull(),
  resource: text("resource", {
    enum: [
      "message",
      "attachment",
      "folder",
      "label",
      "message_label",
      "delivery",
      "delivery_attempt",
      "automation_rule",
      "automation_run",
    ],
  }).notNull(),
  entity_id: text("entity_id").notNull(),
  parent_id: text("parent_id"),
  operation: text("operation", {
    enum: ["created", "updated", "deleted"],
  }).notNull(),
});

export const mailPeople = sqliteTable(
	"mail_people",
	{
		id: text("id").primaryKey(),
		address: text("address").notNull().unique(),
		domain: text("domain").notNull(),
		created_at: text("created_at").notNull(),
	},
	(table) => [index("idx_mail_people_domain_address").on(table.domain, table.address)],
);

export const mailMessageParticipants = sqliteTable(
	"mail_message_participants",
	{
		source_email_id: text("source_email_id")
			.notNull()
			.references(() => emails.id, { onDelete: "cascade" }),
		person_id: text("person_id")
			.notNull()
			.references(() => mailPeople.id, { onDelete: "cascade" }),
		role: text("role", { enum: ["from", "to", "cc", "bcc"] }).notNull(),
		direction: text("direction", { enum: ["sent", "received"] }).notNull(),
		occurred_at: text("occurred_at").notNull(),
		conversation_id: text("conversation_id").notNull(),
		origin: text("origin", {
			enum: ["live_inbound", "accepted_outbound", "admin_import"],
		}).notNull(),
		observed_name: text("observed_name"),
	},
	(table) => [
		primaryKey({ columns: [table.source_email_id, table.person_id, table.role] }),
		index("idx_mail_participants_person_time").on(
			table.person_id,
			table.occurred_at,
			table.source_email_id,
		),
		index("idx_mail_participants_conversation_person").on(
			table.conversation_id,
			table.person_id,
			table.occurred_at,
		),
	],
);

export const peopleProjectionState = sqliteTable("people_projection_state", {
	id: integer("id").primaryKey(),
	schema_version: integer("schema_version").notNull(),
	status: text("status", { enum: ["building", "ready", "failed"] }).notNull(),
	baseline_change_sequence: integer("baseline_change_sequence").notNull(),
	applied_change_sequence: integer("applied_change_sequence").notNull(),
	backfill_date: text("backfill_date"),
	backfill_message_id: text("backfill_message_id"),
	processed_messages: integer("processed_messages").notNull(),
	started_at: text("started_at").notNull(),
	completed_at: text("completed_at"),
	last_error: text("last_error"),
});

export const labels = sqliteTable(
	"labels",
	{
		id: text("id").primaryKey(),
		name: text("name").notNull(),
		normalized_name: text("normalized_name").notNull(),
		color: text("color").notNull(),
		created_at: text("created_at").notNull(),
		updated_at: text("updated_at").notNull(),
	},
	(table) => [
		uniqueIndex("idx_labels_normalized_name").on(table.normalized_name),
	],
);

export const emailLabels = sqliteTable(
	"email_labels",
	{
		email_id: text("email_id")
			.notNull()
			.references(() => emails.id, { onDelete: "cascade" }),
		label_id: text("label_id")
			.notNull()
			.references(() => labels.id, { onDelete: "cascade" }),
		created_at: text("created_at").notNull(),
	},
	(table) => [
		primaryKey({ columns: [table.email_id, table.label_id] }),
		index("idx_email_labels_label_id").on(table.label_id, table.email_id),
		index("idx_email_labels_email_id").on(table.email_id, table.label_id),
	],
);

export const outboundDeliveries = sqliteTable(
	"outbound_deliveries",
	{
		id: text("id").primaryKey(),
		email_id: text("email_id")
			.notNull()
			.references(() => emails.id, { onDelete: "restrict" }),
		source_draft_id: text("source_draft_id"),
		source_draft_version: integer("source_draft_version"),
		idempotency_key: text("idempotency_key").notNull(),
		command_fingerprint: text("command_fingerprint"),
		kind: text("kind").notNull(),
		source: text("source").notNull(),
		actor_kind: text("actor_kind").notNull(),
		actor_id: text("actor_id"),
		status: text("status").notNull(),
		available_at: text("available_at").notNull(),
		undo_until: text("undo_until").notNull(),
		scheduled_for: text("scheduled_for"),
		next_attempt_at: text("next_attempt_at"),
		attempt_count: integer("attempt_count").notNull().default(0),
		max_attempts: integer("max_attempts").notNull().default(4),
		preflight_deferral_count: integer("preflight_deferral_count")
			.notNull()
			.default(0),
		cancellation_recovery_attempt_count: integer(
			"cancellation_recovery_attempt_count",
		)
			.notNull()
			.default(0),
		retry_origin_status: text("retry_origin_status"),
		dispatch_phase: text("dispatch_phase"),
		active_attempt_id: text("active_attempt_id"),
		lease_token: text("lease_token"),
		lease_expires_at: text("lease_expires_at"),
		ses_message_id: text("ses_message_id"),
		last_error_code: text("last_error_code"),
		last_error_message: text("last_error_message"),
		created_at: text("created_at").notNull(),
		updated_at: text("updated_at").notNull(),
		sent_at: text("sent_at"),
		failed_at: text("failed_at"),
		unknown_at: text("unknown_at"),
		cancelled_at: text("cancelled_at"),
		accepted_attempt_count: integer("accepted_attempt_count")
			.notNull()
			.default(0),
		duplicate_acceptance_at: text("duplicate_acceptance_at"),
	},
	(table) => [
		uniqueIndex("idx_outbound_deliveries_email_id").on(table.email_id),
		uniqueIndex("idx_outbound_deliveries_idempotency_key").on(
			table.idempotency_key,
		),
		index("idx_outbound_deliveries_status_available").on(
			table.status,
			table.available_at,
		),
		index("idx_outbound_deliveries_status_next_attempt").on(
			table.status,
			table.next_attempt_at,
		),
		index("idx_outbound_deliveries_source_draft").on(
			table.source_draft_id,
		),
		index("idx_outbound_deliveries_scheduled_for").on(
			table.scheduled_for,
		),
		index("idx_outbound_deliveries_status_lease").on(
			table.status,
			table.lease_expires_at,
		),
		index("idx_outbound_deliveries_ses_message_id").on(
			table.ses_message_id,
		),
	],
);

export const outboundDeliveryAttempts = sqliteTable(
	"outbound_delivery_attempts",
	{
		id: text("id").primaryKey(),
		delivery_id: text("delivery_id")
			.notNull()
			.references(() => outboundDeliveries.id, { onDelete: "cascade" }),
		attempt_number: integer("attempt_number").notNull(),
		status: text("status").notNull(),
		lease_token: text("lease_token").notNull(),
		started_at: text("started_at").notNull(),
		finished_at: text("finished_at"),
		ses_message_id: text("ses_message_id"),
		http_status: integer("http_status"),
		error_code: text("error_code"),
		error_message: text("error_message"),
		provider_state: text("provider_state").notNull().default("none"),
		provider_event_at: text("provider_event_at"),
		provider_event_id: text("provider_event_id"),
	},
	(table) => [
		uniqueIndex("idx_outbound_attempts_delivery_number").on(
			table.delivery_id,
			table.attempt_number,
		),
		index("idx_outbound_attempts_delivery").on(
			table.delivery_id,
			table.attempt_number,
		),
	],
);

export const outboundProviderEvents = sqliteTable(
	"outbound_provider_events",
	{
		id: text("id").primaryKey(),
		attempt_id: text("attempt_id")
			.notNull()
			.references(() => outboundDeliveryAttempts.id, { onDelete: "cascade" }),
		ses_message_id: text("ses_message_id").notNull(),
		event_class: text("event_class").notNull(),
		recipient_hashes_json: text("recipient_hashes_json").notNull().default("[]"),
		occurred_at: text("occurred_at").notNull(),
		received_at: text("received_at").notNull(),
	},
	(table) => [
		index("idx_outbound_provider_events_attempt").on(
			table.attempt_id,
			table.occurred_at,
			table.id,
		),
	],
);

export const outboundAcceptanceRecovery = sqliteTable(
	"outbound_acceptance_recovery",
	{
		delivery_id: text("delivery_id")
			.primaryKey()
			.references(() => outboundDeliveries.id, { onDelete: "cascade" }),
		email_id: text("email_id").notNull(),
		attempt_id: text("attempt_id"),
		ses_message_id: text("ses_message_id"),
		accepted_at: text("accepted_at"),
		source_draft_id: text("source_draft_id"),
		source_draft_version: integer("source_draft_version"),
		actor_kind: text("actor_kind").notNull(),
		actor_id: text("actor_id"),
		state: text("state", {
			enum: ["pending", "retrying", "parked", "completed"],
		}).notNull(),
		generation: integer("generation").notNull().default(0),
		attempt_count: integer("attempt_count").notNull().default(0),
		next_attempt_at: text("next_attempt_at"),
		message_projected_at: text("message_projected_at"),
		draft_consumed_at: text("draft_consumed_at"),
		last_error_code: text("last_error_code"),
		created_at: text("created_at").notNull(),
		updated_at: text("updated_at").notNull(),
		completed_at: text("completed_at"),
	},
	(table) => [
		index("idx_outbound_acceptance_recovery_due").on(
			table.state,
			table.next_attempt_at,
			table.delivery_id,
		),
		check(
			"outbound_acceptance_recovery_attempts_nonnegative",
			sql`${table.attempt_count} >= 0`,
		),
		check(
			"outbound_acceptance_recovery_generation_nonnegative",
			sql`${table.generation} >= 0`,
		),
		check(
			"outbound_acceptance_recovery_source_pair",
			sql`(${table.source_draft_id} IS NULL AND ${table.source_draft_version} IS NULL) OR (${table.source_draft_id} IS NOT NULL AND ${table.source_draft_version} >= 1)`,
		),
	],
);

export const pushNotifications = sqliteTable(
	"push_notifications",
	{
		id: text("id").primaryKey(),
		email_id: text("email_id").notNull().unique()
			.references(() => emails.id, { onDelete: "cascade" }),
		mailbox_id: text("mailbox_id").notNull(),
		payload_json: text("payload_json").notNull(),
		state: text("state", { enum: ["pending", "completed", "no_targets", "expired"] }).notNull(),
		target_count: integer("target_count").notNull(),
		created_at: text("created_at").notNull(),
		expires_at: text("expires_at").notNull(),
		completed_at: text("completed_at"),
	},
	(table) => [
		check(
			"push_notifications_state_closed",
			sql`${table.state} IN ('pending', 'completed', 'no_targets', 'expired')`,
		),
		check("push_notifications_target_count_nonnegative", sql`${table.target_count} >= 0`),
		index("idx_push_notifications_state_expiry").on(table.state, table.expires_at),
		index("idx_push_notifications_retention").on(table.state, table.completed_at, table.created_at),
	],
);

export const pushNotificationDeliveries = sqliteTable(
	"push_notification_deliveries",
	{
		notification_id: text("notification_id").notNull()
			.references(() => pushNotifications.id, { onDelete: "cascade" }),
		subscription_id: text("subscription_id").notNull(),
		target_user_id: text("target_user_id").notNull(),
		status: text("status", { enum: ["pending", "sending", "retrying", "accepted", "terminal"] }).notNull(),
		attempt_count: integer("attempt_count").notNull().default(0),
		next_attempt_at: text("next_attempt_at").notNull(),
		lease_token: text("lease_token"),
		lease_expires_at: text("lease_expires_at"),
		attempted_subscription_generation: integer("attempted_subscription_generation"),
		last_reason: text("last_reason"),
		last_http_status: integer("last_http_status"),
		created_at: text("created_at").notNull(),
		updated_at: text("updated_at").notNull(),
		accepted_at: text("accepted_at"),
		terminal_at: text("terminal_at"),
	},
	(table) => [
		primaryKey({ columns: [table.notification_id, table.subscription_id] }),
		check(
			"push_notification_deliveries_status_closed",
			sql`${table.status} IN ('pending', 'sending', 'retrying', 'accepted', 'terminal')`,
		),
		check("push_notification_deliveries_attempt_count_nonnegative", sql`${table.attempt_count} >= 0`),
		index("idx_push_deliveries_due").on(table.status, table.next_attempt_at, table.notification_id, table.subscription_id),
		index("idx_push_deliveries_actor_health").on(
			table.target_user_id,
			sql`${table.updated_at} DESC`,
			table.notification_id,
		),
	],
);

export const automationRuleState = sqliteTable("automation_rule_state", {
	id: integer("id").primaryKey(),
	ruleset_generation: integer("ruleset_generation").notNull().default(0),
	order_revision: integer("order_revision").notNull().default(0),
	updated_at: text("updated_at").notNull(),
}, (table) => [
	check("automation_rule_state_singleton", sql`${table.id} = 1`),
	check("automation_rule_state_generation_nonnegative", sql`${table.ruleset_generation} >= 0`),
	check("automation_rule_state_order_revision_nonnegative", sql`${table.order_revision} >= 0`),
]);

export const automationRules = sqliteTable("automation_rules", {
	id: text("id").primaryKey(),
	name: text("name").notNull(),
	normalized_name: text("normalized_name").notNull(),
	state: text("state", {
		enum: ["draft", "enabled", "disabled", "needs_attention", "archived"],
	}).notNull(),
	active_version: integer("active_version"),
	draft_version: integer("draft_version"),
	next_version: integer("next_version").notNull().default(1),
	position: integer("position").notNull(),
	revision: integer("revision").notNull().default(1),
	created_by: text("created_by").notNull(),
	created_at: text("created_at").notNull(),
	updated_by: text("updated_by").notNull(),
	updated_at: text("updated_at").notNull(),
	archived_by: text("archived_by"),
	archived_at: text("archived_at"),
}, (table) => [
	check(
		"automation_rules_state_closed",
		sql`${table.state} IN ('draft', 'enabled', 'disabled', 'needs_attention', 'archived')`,
	),
	check("automation_rules_next_version_positive", sql`${table.next_version} >= 1`),
	check("automation_rules_position_nonnegative", sql`${table.position} >= 0`),
	check("automation_rules_revision_positive", sql`${table.revision} >= 1`),
	uniqueIndex("idx_automation_rules_active_name")
		.on(table.normalized_name)
		.where(sql`${table.state} <> 'archived'`),
	index("idx_automation_rules_order").on(table.state, table.position, table.id),
]);

export const automationRuleVersions = sqliteTable("automation_rule_versions", {
	rule_id: text("rule_id").notNull()
		.references(() => automationRules.id, { onDelete: "cascade" }),
	version: integer("version").notNull(),
	schema_version: integer("schema_version").notNull(),
	definition_json: text("definition_json").notNull(),
	definition_fingerprint: text("definition_fingerprint").notNull(),
	created_by: text("created_by").notNull(),
	created_at: text("created_at").notNull(),
}, (table) => [
	primaryKey({ columns: [table.rule_id, table.version] }),
	check("automation_rule_versions_version_positive", sql`${table.version} >= 1`),
	check("automation_rule_versions_schema_v1", sql`${table.schema_version} = 1`),
	index("idx_automation_rule_versions_created").on(table.rule_id, table.created_at),
]);

export const automationRuleLabelRefs = sqliteTable("automation_rule_label_refs", {
	rule_id: text("rule_id").notNull(),
	version: integer("version").notNull(),
	label_id: text("label_id").notNull()
		.references(() => labels.id, { onDelete: "restrict" }),
}, (table) => [
	primaryKey({ columns: [table.rule_id, table.version, table.label_id] }),
	foreignKey({
		columns: [table.rule_id, table.version],
		foreignColumns: [automationRuleVersions.rule_id, automationRuleVersions.version],
	}).onDelete("cascade"),
	index("idx_automation_rule_label_target").on(table.label_id, table.rule_id),
]);

export const automationRuleFolderRefs = sqliteTable("automation_rule_folder_refs", {
	rule_id: text("rule_id").notNull(),
	version: integer("version").notNull(),
	folder_id: text("folder_id").notNull()
		.references(() => folders.id, { onDelete: "restrict" }),
}, (table) => [
	primaryKey({ columns: [table.rule_id, table.version, table.folder_id] }),
	foreignKey({
		columns: [table.rule_id, table.version],
		foreignColumns: [automationRuleVersions.rule_id, automationRuleVersions.version],
	}).onDelete("cascade"),
	index("idx_automation_rule_folder_target").on(table.folder_id, table.rule_id),
]);

export const automationRuns = sqliteTable("automation_runs", {
	id: text("id").primaryKey(),
	trigger_kind: text("trigger_kind", { enum: ["live_inbound"] }).notNull(),
	trigger_message_id: text("trigger_message_id").notNull().unique()
		.references(() => emails.id, { onDelete: "cascade" }),
	ruleset_generation: integer("ruleset_generation").notNull(),
	state: text("state", {
		enum: ["pending", "processing", "no_match", "applied", "applied_with_skips", "failed"],
	}).notNull(),
	attempt_count: integer("attempt_count").notNull().default(0),
	next_attempt_at: text("next_attempt_at"),
	lease_token: text("lease_token"),
	lease_expires_at: text("lease_expires_at"),
	started_at: text("started_at"),
	completed_at: text("completed_at"),
	evaluated_count: integer("evaluated_count").notNull().default(0),
	matched_count: integer("matched_count").notNull().default(0),
	applied_count: integer("applied_count").notNull().default(0),
	stopped_by_rule_id: text("stopped_by_rule_id"),
	failure_category: text("failure_category"),
	created_at: text("created_at").notNull(),
	updated_at: text("updated_at").notNull(),
}, (table) => [
	check("automation_runs_trigger_live_inbound", sql`${table.trigger_kind} = 'live_inbound'`),
	check(
		"automation_runs_state_closed",
		sql`${table.state} IN ('pending', 'processing', 'no_match', 'applied', 'applied_with_skips', 'failed')`,
	),
	check("automation_runs_attempt_nonnegative", sql`${table.attempt_count} >= 0`),
	index("idx_automation_runs_due").on(table.state, table.next_attempt_at, table.id),
	index("idx_automation_runs_lease").on(table.state, table.lease_expires_at, table.id),
	index("idx_automation_runs_history").on(table.completed_at, table.id),
]);

export const automationRunRules = sqliteTable("automation_run_rules", {
	run_id: text("run_id").notNull()
		.references(() => automationRuns.id, { onDelete: "cascade" }),
	ordinal: integer("ordinal").notNull(),
	rule_id: text("rule_id").notNull(),
	rule_name: text("rule_name").notNull(),
	rule_version: integer("rule_version").notNull(),
	definition_json: text("definition_json").notNull(),
	definition_fingerprint: text("definition_fingerprint").notNull(),
}, (table) => [
	primaryKey({ columns: [table.run_id, table.ordinal] }),
	uniqueIndex("idx_automation_run_rules_identity").on(table.run_id, table.rule_id),
]);

export const automationRunResults = sqliteTable("automation_run_results", {
	run_id: text("run_id").notNull()
		.references(() => automationRuns.id, { onDelete: "cascade" }),
	ordinal: integer("ordinal").notNull(),
	rule_id: text("rule_id").notNull(),
	rule_name: text("rule_name").notNull(),
	rule_version: integer("rule_version").notNull(),
	outcome: text("outcome", {
		enum: [
			"not_matched",
			"applied",
			"already_satisfied",
			"skipped_conflict",
			"skipped_invalid_target",
			"skipped_scope_changed",
			"stopped",
		],
	}).notNull(),
	matched_condition_indexes_json: text("matched_condition_indexes_json").notNull(),
	planned_actions_json: text("planned_actions_json").notNull(),
	action_results_json: text("action_results_json").notNull(),
	failure_category: text("failure_category"),
	attempt_count: integer("attempt_count").notNull(),
	created_at: text("created_at").notNull(),
}, (table) => [
	primaryKey({ columns: [table.run_id, table.ordinal] }),
	check(
		"automation_run_results_outcome_closed",
		sql`${table.outcome} IN ('not_matched', 'applied', 'already_satisfied', 'skipped_conflict', 'skipped_invalid_target', 'skipped_scope_changed', 'stopped')`,
	),
]);

export const automationRunLabelRefs = sqliteTable("automation_run_label_refs", {
	run_id: text("run_id").notNull()
		.references(() => automationRuns.id, { onDelete: "cascade" }),
	label_id: text("label_id").notNull()
		.references(() => labels.id, { onDelete: "restrict" }),
}, (table) => [
	primaryKey({ columns: [table.run_id, table.label_id] }),
	index("idx_automation_run_label_target").on(table.label_id, table.run_id),
]);

export const automationRunFolderRefs = sqliteTable("automation_run_folder_refs", {
	run_id: text("run_id").notNull()
		.references(() => automationRuns.id, { onDelete: "cascade" }),
	folder_id: text("folder_id").notNull()
		.references(() => folders.id, { onDelete: "restrict" }),
}, (table) => [
	primaryKey({ columns: [table.run_id, table.folder_id] }),
	index("idx_automation_run_folder_target").on(table.folder_id, table.run_id),
]);

export const automationRuleTests = sqliteTable("automation_rule_tests", {
	id: text("id").primaryKey(),
	actor_id: text("actor_id").notNull(),
	rule_id: text("rule_id"),
	rule_version: integer("rule_version"),
	definition_json: text("definition_json").notNull(),
	definition_fingerprint: text("definition_fingerprint").notNull(),
	evaluated_count: integer("evaluated_count").notNull(),
	matched_count: integer("matched_count").notNull(),
	acknowledged_zero: integer("acknowledged_zero").notNull().default(0),
	result_json: text("result_json").notNull(),
	created_at: text("created_at").notNull(),
	expires_at: text("expires_at").notNull(),
}, (table) => [
	check("automation_rule_tests_counts_nonnegative", sql`${table.evaluated_count} >= 0 AND ${table.matched_count} >= 0`),
	check("automation_rule_tests_ack_boolean", sql`${table.acknowledged_zero} IN (0, 1)`),
	index("idx_automation_rule_tests_rule_created").on(table.rule_id, table.created_at),
	index("idx_automation_rule_tests_retention").on(table.expires_at, table.created_at, table.id),
]);
