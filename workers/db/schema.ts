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
		updated_at: text("updated_at").notNull(),
	},
	(table) => [
		index("idx_draft_save_cleanup_due").on(
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

export const pushSubscriptions = sqliteTable("push_subscriptions", {
	id: text("id").primaryKey(),
	user_id: text("user_id"),
	endpoint: text("endpoint").notNull().unique(),
	p256dh: text("p256dh").notNull(),
	auth: text("auth").notNull(),
	user_agent: text("user_agent"),
	device_label: text("device_label"),
	created_at: text("created_at").notNull().default(sql`(datetime('now'))`),
	last_seen_at: text("last_seen_at").notNull().default(sql`(datetime('now'))`),
	generation: integer("generation").notNull().default(1),
	last_push_attempt_at: text("last_push_attempt_at"),
	last_push_accepted_at: text("last_push_accepted_at"),
	last_push_failure_at: text("last_push_failure_at"),
	last_push_failure_reason: text("last_push_failure_reason"),
	consecutive_push_failures: integer("consecutive_push_failures").notNull().default(0),
}, (table) => [index("idx_push_subscriptions_user_id").on(table.user_id)]);

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
