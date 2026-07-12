// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import {
	index,
	integer,
	primaryKey,
	sqliteTable,
	text,
	uniqueIndex,
} from "drizzle-orm/sqlite-core";

export const folders = sqliteTable("folders", {
	id: text("id").primaryKey(),
	name: text("name").notNull().unique(),
	is_deletable: integer("is_deletable").notNull().default(1),
});

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
	},
	(table) => [index("idx_attachments_email_id_id").on(table.email_id, table.id)],
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
		],
	}).notNull(),
	entity_id: text("entity_id").notNull(),
	parent_id: text("parent_id"),
	operation: text("operation", {
		enum: ["created", "updated", "deleted"],
	}).notNull(),
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
