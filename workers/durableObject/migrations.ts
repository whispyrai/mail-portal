// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

export interface Migration {
	name: string;
	sql: string;
}

/**
 * Minimal migration runner that replaces workers-qb's DOQB.migrations().apply().
 *
 * Uses the `d1_migrations` tracking table for backward compatibility with
 * existing deployments that were managed by workers-qb. New deployments
 * create the same table so the schema is consistent either way.
 */
export function applyMigrations(
	sql: SqlStorage,
	migrations: Migration[],
	storage?: DurableObjectStorage,
): void {
	sql.exec(`CREATE TABLE IF NOT EXISTS d1_migrations (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		name TEXT NOT NULL UNIQUE,
		applied_at TEXT NOT NULL DEFAULT (datetime('now'))
	)`);

	for (const migration of migrations) {
		const applied = [
			...sql.exec(
				`SELECT 1 FROM d1_migrations WHERE name = ?`,
				migration.name,
			),
		];
		if (applied.length > 0) continue;

		// Strip any existing BEGIN/COMMIT wrapper from the migration SQL.
		// Cloudflare's DO runtime forbids SQL-level transactions -- must use
		// the JS storage.transactionSync() API instead.
		let migrationSql = migration.sql.trim();
		migrationSql = migrationSql.replace(/^\s*BEGIN\s+TRANSACTION\s*;?\s*/i, "");
		migrationSql = migrationSql.replace(/\s*COMMIT\s*;?\s*$/i, "");

		const escapedName = migration.name.replace(/'/g, "''");
		const run = () => {
			sql.exec(migrationSql);
			sql.exec(
				`INSERT INTO d1_migrations (name) VALUES ('${escapedName}')`,
			);
		};

		if (storage) {
			// Preferred: atomic transaction via the DO JS API
			storage.transactionSync(run);
		} else {
			// Fallback: run without explicit transaction (each exec is auto-committed)
			run();
		}
	}
}

interface DurableObjectStorage {
	transactionSync: <T>(closure: () => T) => T;
}

/**
 * Wrap SQL in a transaction so multi-statement migrations are atomic.
 *
 * Without this, a migration like `1_initial_setup` (CREATE + INSERT +
 * CREATE + CREATE) could fail mid-way and leave the database in an
 * inconsistent state that the runner considers "applied" but is
 * actually broken.  SQLite transactions guarantee all-or-nothing.
 *
 * Single-statement migrations don't strictly need it but wrapping
 * uniformly costs nothing and avoids accidental omissions.
 */
function txn(sql: string): string {
	const trimmed = sql.trim();
	// Don't double-wrap if someone already added BEGIN/COMMIT
	if (/^\s*BEGIN\b/i.test(trimmed)) return trimmed;
	return `BEGIN TRANSACTION;\n${trimmed}\nCOMMIT;`;
}

export const mailboxMigrations: Migration[] = [
	{
		name: "1_initial_setup",
		sql: txn(`
            CREATE TABLE folders (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL UNIQUE,
                is_deletable INTEGER NOT NULL DEFAULT 1
            );

            INSERT INTO folders (id, name, is_deletable) VALUES
                ('inbox', 'Inbox', 0),
                ('sent', 'Sent', 0),
                ('trash', 'Trash', 0),
                ('archive', 'Archive', 0),
                ('spam', 'Spam', 0);

            CREATE TABLE emails (
                id TEXT PRIMARY KEY,
                folder_id TEXT NOT NULL,
                subject TEXT,
                sender TEXT,
                recipient TEXT,
                date TEXT,
                read INTEGER DEFAULT 0,
                starred INTEGER DEFAULT 0,
                body TEXT,
                FOREIGN KEY(folder_id) REFERENCES folders(id) ON DELETE CASCADE
            );

            CREATE TABLE attachments (
                id TEXT PRIMARY KEY,
                email_id TEXT NOT NULL,
                filename TEXT NOT NULL,
                mimetype TEXT NOT NULL,
                size INTEGER NOT NULL,
                content_id TEXT,
                disposition TEXT,
                FOREIGN KEY(email_id) REFERENCES emails(id) ON DELETE CASCADE
            );
        `),
	},
	{
		name: "2_add_email_threading",
		sql: txn(`
            ALTER TABLE emails ADD COLUMN in_reply_to TEXT;
            ALTER TABLE emails ADD COLUMN email_references TEXT;
            ALTER TABLE emails ADD COLUMN thread_id TEXT;

            CREATE INDEX idx_emails_thread_id ON emails(thread_id);
            CREATE INDEX idx_emails_in_reply_to ON emails(in_reply_to);
        `),
	},
	{
		name: "3_add_draft_folder",
		sql: txn(`INSERT INTO folders (id, name, is_deletable) VALUES ('draft', 'Drafts', 0);`),
	},
	{
		name: "4_add_message_id",
		sql: txn(`ALTER TABLE emails ADD COLUMN message_id TEXT;`),
	},
	{
		name: "5_add_raw_headers",
		sql: txn(`ALTER TABLE emails ADD COLUMN raw_headers TEXT;`),
	},
	{
		name: "6_mark_sent_emails_as_read",
		sql: txn(`UPDATE emails SET read = 1 WHERE folder_id = 'sent' AND read = 0;`),
	},
	{
		name: "7_add_cc_bcc",
		sql: txn(`
            ALTER TABLE emails ADD COLUMN cc TEXT;
            ALTER TABLE emails ADD COLUMN bcc TEXT;
        `),
	},
	{
		// No txn() wrapper: Cloudflare's DO runtime requires state.storage.transactionSync()
		// instead of SQL-level BEGIN TRANSACTION. These are idempotent CREATE INDEX IF NOT EXISTS
		// statements so they're safe to run without a transaction.
		name: "8_add_folder_date_indexes",
		sql: `
            CREATE INDEX IF NOT EXISTS idx_emails_folder_id ON emails(folder_id);
            CREATE INDEX IF NOT EXISTS idx_emails_date ON emails(date);
            CREATE INDEX IF NOT EXISTS idx_emails_folder_date ON emails(folder_id, date DESC);
        `,
	},
	{
		// Web Push per-device subscriptions for this mailbox (WISER-240). One row
		// per device: `endpoint` is the browser-minted capability URL (unique);
		// `id` is a stable client-facing handle for the device list + removal.
		// No txn() wrapper — a single idempotent CREATE ... IF NOT EXISTS (see
		// migration 8 for why DO runtime forbids SQL-level transactions).
		name: "9_add_push_subscriptions",
		sql: `
            CREATE TABLE IF NOT EXISTS push_subscriptions (
                id TEXT PRIMARY KEY,
                endpoint TEXT NOT NULL UNIQUE,
                p256dh TEXT NOT NULL,
                auth TEXT NOT NULL,
                user_agent TEXT,
                device_label TEXT,
                created_at TEXT NOT NULL DEFAULT (datetime('now')),
                last_seen_at TEXT NOT NULL DEFAULT (datetime('now'))
            );
		`,
	},
	{
		name: "10_add_safe_trash_and_activity_events",
		sql: txn(`
			ALTER TABLE emails ADD COLUMN previous_folder_id TEXT;
			ALTER TABLE emails ADD COLUMN trashed_at TEXT;

			CREATE TABLE activity_events (
				id TEXT PRIMARY KEY,
				actor_kind TEXT NOT NULL,
				actor_id TEXT,
				action TEXT NOT NULL,
				entity_type TEXT NOT NULL,
				entity_id TEXT NOT NULL,
				metadata_json TEXT,
				occurred_at TEXT NOT NULL
			);

			CREATE INDEX idx_activity_events_entity
				ON activity_events(entity_type, entity_id, occurred_at DESC);
			CREATE INDEX idx_activity_events_occurred_at
				ON activity_events(occurred_at DESC);
		`),
	},
	{
		name: "11_add_truthful_outbox_storage",
		sql: txn(`
			-- Preserve a user-created folder that already owns the reserved ID,
			-- including every message that references it.
			DROP TABLE IF EXISTS _outbox_folder_map;
			CREATE TABLE _outbox_folder_map (
				old_id TEXT PRIMARY KEY,
				new_id TEXT NOT NULL UNIQUE,
				new_name TEXT NOT NULL UNIQUE,
				is_deletable INTEGER NOT NULL
			);
			INSERT INTO _outbox_folder_map
				(old_id, new_id, new_name, is_deletable)
			SELECT id,
				'outbox_legacy_' || lower(hex(randomblob(8))),
				name || ' (Legacy ' || lower(hex(randomblob(8))) || ')',
				is_deletable
			FROM folders
			WHERE id = 'outbox';

			INSERT INTO folders (id, name, is_deletable)
			SELECT new_id, new_name, is_deletable
			FROM _outbox_folder_map;
			UPDATE emails
			SET folder_id = (
				SELECT new_id FROM _outbox_folder_map WHERE old_id = 'outbox'
			)
			WHERE folder_id = 'outbox';
			DELETE FROM folders WHERE id = 'outbox';

			-- Preserve a custom folder that already uses the reserved display name.
			UPDATE folders
			SET name = 'Outbox (Legacy ' || lower(hex(randomblob(8))) || ')'
			WHERE name = 'Outbox';

			INSERT INTO folders (id, name, is_deletable)
			VALUES ('outbox', 'Outbox', 0)
			ON CONFLICT(id) DO UPDATE SET
				name = excluded.name,
				is_deletable = 0;
			DROP TABLE _outbox_folder_map;

			ALTER TABLE emails
				ADD COLUMN draft_version INTEGER NOT NULL DEFAULT 1;

			CREATE TABLE outbound_deliveries (
				id TEXT PRIMARY KEY,
				email_id TEXT NOT NULL UNIQUE,
				source_draft_id TEXT,
				source_draft_version INTEGER,
				idempotency_key TEXT NOT NULL UNIQUE,
				kind TEXT NOT NULL,
				source TEXT NOT NULL,
				actor_kind TEXT NOT NULL,
				actor_id TEXT,
				status TEXT NOT NULL,
				available_at TEXT NOT NULL,
				undo_until TEXT NOT NULL,
				scheduled_for TEXT,
				next_attempt_at TEXT,
				attempt_count INTEGER NOT NULL DEFAULT 0,
				max_attempts INTEGER NOT NULL DEFAULT 4,
				lease_token TEXT,
				lease_expires_at TEXT,
				ses_message_id TEXT,
				last_error_code TEXT,
				last_error_message TEXT,
				created_at TEXT NOT NULL,
				updated_at TEXT NOT NULL,
				sent_at TEXT,
				failed_at TEXT,
				unknown_at TEXT,
				cancelled_at TEXT,
				FOREIGN KEY(email_id) REFERENCES emails(id) ON DELETE RESTRICT
			);

			CREATE TABLE outbound_delivery_attempts (
				id TEXT PRIMARY KEY,
				delivery_id TEXT NOT NULL,
				attempt_number INTEGER NOT NULL,
				status TEXT NOT NULL,
				lease_token TEXT NOT NULL,
				started_at TEXT NOT NULL,
				finished_at TEXT,
				ses_message_id TEXT,
				http_status INTEGER,
				error_code TEXT,
				error_message TEXT,
				FOREIGN KEY(delivery_id) REFERENCES outbound_deliveries(id) ON DELETE CASCADE,
				UNIQUE(delivery_id, attempt_number)
			);

			CREATE INDEX idx_outbound_deliveries_status_available
				ON outbound_deliveries(status, available_at);
			CREATE INDEX idx_outbound_deliveries_status_next_attempt
				ON outbound_deliveries(status, next_attempt_at);
			CREATE INDEX idx_outbound_deliveries_source_draft
				ON outbound_deliveries(source_draft_id);
			CREATE INDEX idx_outbound_deliveries_scheduled_for
				ON outbound_deliveries(scheduled_for);
			CREATE INDEX idx_outbound_deliveries_status_lease
				ON outbound_deliveries(status, lease_expires_at);
			CREATE INDEX idx_outbound_deliveries_ses_message_id
				ON outbound_deliveries(ses_message_id);
			CREATE INDEX idx_outbound_attempts_delivery
				ON outbound_delivery_attempts(delivery_id, attempt_number);
		`),
	},
	{
		name: "12_scope_push_subscriptions_to_users",
		sql: txn(`
			ALTER TABLE push_subscriptions ADD COLUMN user_id TEXT;
			-- Legacy endpoint capabilities have no trustworthy user identity. Drop
			-- them fail-closed; the authenticated client rebinds the browser's
			-- existing PushSubscription without prompting for permission again.
			DELETE FROM push_subscriptions WHERE user_id IS NULL;
			CREATE INDEX idx_push_subscriptions_user_id
				ON push_subscriptions(user_id);
		`),
	},
	{
		name: "13_index_truthful_outbox_runtime_queries",
		sql: txn(`
			CREATE INDEX IF NOT EXISTS idx_outbound_deliveries_status_lease
				ON outbound_deliveries(status, lease_expires_at);
			CREATE INDEX IF NOT EXISTS idx_outbound_deliveries_ses_message_id
				ON outbound_deliveries(ses_message_id);
		`),
	},
	{
		name: "14_add_retired_outbound_folder",
		sql: txn(`
			-- Preserve a user-created folder that already owns the reserved ID,
			-- including every message that references it.
			DROP TABLE IF EXISTS _retired_outbound_folder_map;
			CREATE TABLE _retired_outbound_folder_map (
				old_id TEXT PRIMARY KEY,
				new_id TEXT NOT NULL UNIQUE,
				new_name TEXT NOT NULL UNIQUE,
				is_deletable INTEGER NOT NULL
			);
			INSERT INTO _retired_outbound_folder_map
				(old_id, new_id, new_name, is_deletable)
			SELECT id,
				'_cancelled_outbound_legacy_' || lower(hex(randomblob(8))),
				name || ' (Legacy ' || lower(hex(randomblob(8))) || ')',
				is_deletable
			FROM folders
			WHERE id = '_cancelled_outbound';

			INSERT INTO folders (id, name, is_deletable)
			SELECT new_id, new_name, is_deletable
			FROM _retired_outbound_folder_map;
			UPDATE emails
			SET folder_id = (
				SELECT new_id FROM _retired_outbound_folder_map
				WHERE old_id = '_cancelled_outbound'
			)
			WHERE folder_id = '_cancelled_outbound';
			DELETE FROM folders WHERE id = '_cancelled_outbound';

			-- Preserve a custom folder that already uses the reserved display name.
			UPDATE folders
			SET name = 'Retired Outbound Snapshots (Legacy ' ||
				lower(hex(randomblob(8))) || ')'
			WHERE name = 'Retired Outbound Snapshots';

			INSERT INTO folders (id, name, is_deletable)
			VALUES ('_cancelled_outbound', 'Retired Outbound Snapshots', 0)
			ON CONFLICT(id) DO UPDATE SET
				name = excluded.name,
				is_deletable = 0;
			DROP TABLE _retired_outbound_folder_map;
		`),
	},
	{
		name: "15_add_mailbox_labels",
		sql: txn(`
			CREATE TABLE labels (
				id TEXT PRIMARY KEY,
				name TEXT NOT NULL,
				normalized_name TEXT NOT NULL UNIQUE,
				color TEXT NOT NULL CHECK (color IN (
					'gray', 'red', 'orange', 'yellow', 'green',
					'teal', 'blue', 'purple', 'pink'
				)),
				created_at TEXT NOT NULL,
				updated_at TEXT NOT NULL
			);

			CREATE TABLE email_labels (
				email_id TEXT NOT NULL,
				label_id TEXT NOT NULL,
				created_at TEXT NOT NULL,
				PRIMARY KEY (email_id, label_id),
				FOREIGN KEY(email_id) REFERENCES emails(id) ON DELETE CASCADE,
				FOREIGN KEY(label_id) REFERENCES labels(id) ON DELETE CASCADE
			);

			CREATE INDEX idx_email_labels_label_id
				ON email_labels(label_id, email_id);
			CREATE INDEX idx_email_labels_email_id
				ON email_labels(email_id, label_id);
		`),
	},
	{
		name: "16_add_mailbox_snooze",
		sql: txn(`
			DROP TABLE IF EXISTS _snoozed_folder_map;
			CREATE TABLE _snoozed_folder_map (
				old_id TEXT PRIMARY KEY,
				new_id TEXT NOT NULL UNIQUE,
				new_name TEXT NOT NULL UNIQUE,
				is_deletable INTEGER NOT NULL
			);
			INSERT INTO _snoozed_folder_map
				(old_id, new_id, new_name, is_deletable)
			SELECT id,
				'snoozed_legacy_' || lower(hex(randomblob(8))),
				name || ' (Legacy ' || lower(hex(randomblob(8))) || ')',
				is_deletable
			FROM folders
			WHERE id = 'snoozed';

			INSERT INTO folders (id, name, is_deletable)
			SELECT new_id, new_name, is_deletable FROM _snoozed_folder_map;
			UPDATE emails
			SET folder_id = (
				SELECT new_id FROM _snoozed_folder_map WHERE old_id = 'snoozed'
			)
			WHERE folder_id = 'snoozed';
			UPDATE emails
			SET previous_folder_id = (
				SELECT new_id FROM _snoozed_folder_map WHERE old_id = 'snoozed'
			)
			WHERE previous_folder_id = 'snoozed';
			DELETE FROM folders WHERE id = 'snoozed';

			UPDATE folders
			SET name = 'Snoozed (Legacy ' || lower(hex(randomblob(8))) || ')'
			WHERE name = 'Snoozed';
			INSERT INTO folders (id, name, is_deletable)
			VALUES ('snoozed', 'Snoozed', 0)
			ON CONFLICT(id) DO UPDATE SET
				name = excluded.name,
				is_deletable = 0;
			DROP TABLE _snoozed_folder_map;

			ALTER TABLE emails ADD COLUMN snooze_source_folder_id TEXT;
			ALTER TABLE emails ADD COLUMN snoozed_until TEXT;
			CREATE INDEX idx_emails_snoozed_until
				ON emails(snoozed_until, id);

			CREATE TABLE snooze_reply_wake_queue (
				thread_id TEXT PRIMARY KEY,
				requested_at TEXT NOT NULL
			);
			CREATE INDEX idx_snooze_reply_wake_requested
				ON snooze_reply_wake_queue(requested_at, thread_id);
		`),
	},
	{
		name: "17_add_follow_up_reply_completion_queue",
		sql: txn(`
			CREATE TABLE follow_up_reply_completion_queue (
				inbound_message_id TEXT PRIMARY KEY,
				mailbox_address TEXT NOT NULL,
				conversation_key TEXT NOT NULL,
				inbound_message_date TEXT NOT NULL,
				attempts INTEGER NOT NULL DEFAULT 0,
				next_attempt_at INTEGER NOT NULL,
				created_at INTEGER NOT NULL,
				last_error TEXT
			);
			CREATE INDEX idx_follow_up_reply_completion_due
				ON follow_up_reply_completion_queue(next_attempt_at, inbound_message_id);
		`),
	},
	{
		name: "18_add_recipient_memory",
		sql: txn(`
			ALTER TABLE emails ADD COLUMN recipient_memory_origin TEXT
				CHECK(recipient_memory_origin IN (
					'live_inbound', 'accepted_outbound', 'admin_import'
				));
			CREATE TABLE recipient_interactions (
				source_email_id TEXT NOT NULL,
				address TEXT NOT NULL COLLATE NOCASE,
				direction TEXT NOT NULL CHECK(direction IN ('sent', 'received')),
				occurred_at TEXT NOT NULL,
				PRIMARY KEY(source_email_id, address, direction),
				FOREIGN KEY(source_email_id) REFERENCES emails(id) ON DELETE CASCADE
			);
			CREATE INDEX idx_recipient_interactions_address
				ON recipient_interactions(address, direction, occurred_at DESC);
			CREATE INDEX idx_recipient_interactions_occurred
				ON recipient_interactions(occurred_at DESC, address);
			CREATE TABLE recipient_interaction_meta (
				key TEXT PRIMARY KEY,
				value TEXT NOT NULL
			);
		`),
	},
	{
		name: "19_add_draft_create_replay",
		sql: txn(`
			ALTER TABLE emails ADD COLUMN draft_create_key TEXT;
			ALTER TABLE emails ADD COLUMN draft_create_fingerprint TEXT;
			CREATE UNIQUE INDEX idx_emails_draft_create_key
				ON emails(draft_create_key)
				WHERE draft_create_key IS NOT NULL;
		`),
	},
	{
		name: "20_add_today_brief_generation_claims",
		sql: txn(`
			CREATE TABLE today_brief_generation_claims (
				cache_key TEXT PRIMARY KEY,
				owner_user_id TEXT NOT NULL,
				claim_token TEXT NOT NULL,
				expires_at INTEGER NOT NULL,
				created_at INTEGER NOT NULL
			);
			CREATE INDEX idx_today_brief_generation_claim_expiry
				ON today_brief_generation_claims(expires_at, cache_key);
		`),
	},
	{
		name: "21_index_mailbox_attachments",
		sql: `
			CREATE INDEX IF NOT EXISTS idx_attachments_email_id_id
				ON attachments(email_id, id);
		`,
	},
	{
		name: "22_add_import_generation_claims",
		sql: `
			CREATE TABLE import_generation_claims (
				message_id TEXT PRIMARY KEY,
				claim_token TEXT NOT NULL,
				expires_at INTEGER NOT NULL,
				created_at INTEGER NOT NULL
			);
			CREATE INDEX idx_import_generation_claims_expiry
				ON import_generation_claims(expires_at, message_id);
		`,
	},
	{
		name: "23_add_mailbox_change_feed",
		sql: txn(`
			CREATE TABLE mailbox_changes (
				sequence INTEGER PRIMARY KEY AUTOINCREMENT,
				schema_version INTEGER NOT NULL CHECK(schema_version = 1),
				committed_at TEXT NOT NULL,
				resource TEXT NOT NULL CHECK(resource IN (
					'message', 'attachment', 'folder', 'label', 'message_label',
					'delivery', 'delivery_attempt'
				)),
				entity_id TEXT NOT NULL,
				parent_id TEXT,
				operation TEXT NOT NULL CHECK(operation IN ('created', 'updated', 'deleted'))
			);

			CREATE TRIGGER mailbox_changes_emails_insert AFTER INSERT ON emails BEGIN
				INSERT INTO mailbox_changes(schema_version, committed_at, resource, entity_id, parent_id, operation)
				VALUES (1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), 'message', NEW.id, NULL, 'created');
			END;
			CREATE TRIGGER mailbox_changes_emails_update AFTER UPDATE ON emails BEGIN
				INSERT INTO mailbox_changes(schema_version, committed_at, resource, entity_id, parent_id, operation)
				VALUES (1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), 'message', NEW.id, NULL, 'updated');
			END;
			CREATE TRIGGER mailbox_changes_emails_delete AFTER DELETE ON emails BEGIN
				INSERT INTO mailbox_changes(schema_version, committed_at, resource, entity_id, parent_id, operation)
				VALUES (1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), 'message', OLD.id, NULL, 'deleted');
			END;

			CREATE TRIGGER mailbox_changes_attachments_insert AFTER INSERT ON attachments BEGIN
				INSERT INTO mailbox_changes(schema_version, committed_at, resource, entity_id, parent_id, operation)
				VALUES (1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), 'attachment', NEW.id, NEW.email_id, 'created');
			END;
			CREATE TRIGGER mailbox_changes_attachments_update AFTER UPDATE ON attachments BEGIN
				INSERT INTO mailbox_changes(schema_version, committed_at, resource, entity_id, parent_id, operation)
				VALUES (1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), 'attachment', NEW.id, NEW.email_id, 'updated');
			END;
			CREATE TRIGGER mailbox_changes_attachments_delete AFTER DELETE ON attachments BEGIN
				INSERT INTO mailbox_changes(schema_version, committed_at, resource, entity_id, parent_id, operation)
				VALUES (1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), 'attachment', OLD.id, OLD.email_id, 'deleted');
			END;

			CREATE TRIGGER mailbox_changes_folders_insert AFTER INSERT ON folders BEGIN
				INSERT INTO mailbox_changes(schema_version, committed_at, resource, entity_id, parent_id, operation)
				VALUES (1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), 'folder', NEW.id, NULL, 'created');
			END;
			CREATE TRIGGER mailbox_changes_folders_update AFTER UPDATE ON folders BEGIN
				INSERT INTO mailbox_changes(schema_version, committed_at, resource, entity_id, parent_id, operation)
				VALUES (1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), 'folder', NEW.id, NULL, 'updated');
			END;
			CREATE TRIGGER mailbox_changes_folders_delete AFTER DELETE ON folders BEGIN
				INSERT INTO mailbox_changes(schema_version, committed_at, resource, entity_id, parent_id, operation)
				VALUES (1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), 'folder', OLD.id, NULL, 'deleted');
			END;

			CREATE TRIGGER mailbox_changes_labels_insert AFTER INSERT ON labels BEGIN
				INSERT INTO mailbox_changes(schema_version, committed_at, resource, entity_id, parent_id, operation)
				VALUES (1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), 'label', NEW.id, NULL, 'created');
			END;
			CREATE TRIGGER mailbox_changes_labels_update AFTER UPDATE ON labels BEGIN
				INSERT INTO mailbox_changes(schema_version, committed_at, resource, entity_id, parent_id, operation)
				VALUES (1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), 'label', NEW.id, NULL, 'updated');
			END;
			CREATE TRIGGER mailbox_changes_labels_delete AFTER DELETE ON labels BEGIN
				INSERT INTO mailbox_changes(schema_version, committed_at, resource, entity_id, parent_id, operation)
				VALUES (1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), 'label', OLD.id, NULL, 'deleted');
			END;

			CREATE TRIGGER mailbox_changes_email_labels_insert AFTER INSERT ON email_labels BEGIN
				INSERT INTO mailbox_changes(schema_version, committed_at, resource, entity_id, parent_id, operation)
				VALUES (1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), 'message_label', NEW.email_id || ':' || NEW.label_id, NEW.email_id, 'created');
			END;
			CREATE TRIGGER mailbox_changes_email_labels_update AFTER UPDATE ON email_labels BEGIN
				INSERT INTO mailbox_changes(schema_version, committed_at, resource, entity_id, parent_id, operation)
				VALUES (1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), 'message_label', NEW.email_id || ':' || NEW.label_id, NEW.email_id, 'updated');
			END;
			CREATE TRIGGER mailbox_changes_email_labels_delete AFTER DELETE ON email_labels BEGIN
				INSERT INTO mailbox_changes(schema_version, committed_at, resource, entity_id, parent_id, operation)
				VALUES (1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), 'message_label', OLD.email_id || ':' || OLD.label_id, OLD.email_id, 'deleted');
			END;

			CREATE TRIGGER mailbox_changes_deliveries_insert AFTER INSERT ON outbound_deliveries BEGIN
				INSERT INTO mailbox_changes(schema_version, committed_at, resource, entity_id, parent_id, operation)
				VALUES (1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), 'delivery', NEW.id, NEW.email_id, 'created');
			END;
			CREATE TRIGGER mailbox_changes_deliveries_update AFTER UPDATE ON outbound_deliveries BEGIN
				INSERT INTO mailbox_changes(schema_version, committed_at, resource, entity_id, parent_id, operation)
				VALUES (1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), 'delivery', NEW.id, NEW.email_id, 'updated');
			END;
			CREATE TRIGGER mailbox_changes_deliveries_delete AFTER DELETE ON outbound_deliveries BEGIN
				INSERT INTO mailbox_changes(schema_version, committed_at, resource, entity_id, parent_id, operation)
				VALUES (1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), 'delivery', OLD.id, OLD.email_id, 'deleted');
			END;

			CREATE TRIGGER mailbox_changes_delivery_attempts_insert AFTER INSERT ON outbound_delivery_attempts BEGIN
				INSERT INTO mailbox_changes(schema_version, committed_at, resource, entity_id, parent_id, operation)
				VALUES (1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), 'delivery_attempt', NEW.id, NEW.delivery_id, 'created');
			END;
			CREATE TRIGGER mailbox_changes_delivery_attempts_update AFTER UPDATE ON outbound_delivery_attempts BEGIN
				INSERT INTO mailbox_changes(schema_version, committed_at, resource, entity_id, parent_id, operation)
				VALUES (1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), 'delivery_attempt', NEW.id, NEW.delivery_id, 'updated');
			END;
			CREATE TRIGGER mailbox_changes_delivery_attempts_delete AFTER DELETE ON outbound_delivery_attempts BEGIN
				INSERT INTO mailbox_changes(schema_version, committed_at, resource, entity_id, parent_id, operation)
				VALUES (1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), 'delivery_attempt', OLD.id, OLD.delivery_id, 'deleted');
			END;
		`),
	},
	{
		name: "24_add_mail_people_projection",
		sql: txn(`
			ALTER TABLE emails ADD COLUMN sender_name TEXT;
			CREATE INDEX idx_emails_people_backfill
				ON emails(date DESC, id ASC);

			CREATE TABLE mail_people (
				id TEXT PRIMARY KEY,
				address TEXT NOT NULL COLLATE NOCASE UNIQUE,
				domain TEXT NOT NULL,
				created_at TEXT NOT NULL
			);

			CREATE TABLE mail_message_participants (
				source_email_id TEXT NOT NULL,
				person_id TEXT NOT NULL,
				role TEXT NOT NULL CHECK(role IN ('from', 'to', 'cc', 'bcc')),
				direction TEXT NOT NULL CHECK(direction IN ('sent', 'received')),
				occurred_at TEXT NOT NULL,
				conversation_id TEXT NOT NULL,
				origin TEXT NOT NULL CHECK(origin IN (
					'live_inbound', 'accepted_outbound', 'admin_import'
				)),
				observed_name TEXT,
				PRIMARY KEY(source_email_id, person_id, role),
				FOREIGN KEY(source_email_id) REFERENCES emails(id) ON DELETE CASCADE,
				FOREIGN KEY(person_id) REFERENCES mail_people(id) ON DELETE CASCADE
			);

			CREATE INDEX idx_mail_participants_person_time
				ON mail_message_participants(person_id, occurred_at DESC, source_email_id);
			CREATE INDEX idx_mail_participants_conversation_person
				ON mail_message_participants(conversation_id, person_id, occurred_at DESC);
			CREATE INDEX idx_mail_people_domain_address
				ON mail_people(domain, address);

			CREATE TABLE people_projection_state (
				id INTEGER PRIMARY KEY CHECK(id = 1),
				schema_version INTEGER NOT NULL CHECK(schema_version = 1),
				status TEXT NOT NULL CHECK(status IN ('building', 'ready', 'failed')),
				baseline_change_sequence INTEGER NOT NULL,
				applied_change_sequence INTEGER NOT NULL,
				backfill_date TEXT,
				backfill_message_id TEXT,
				processed_messages INTEGER NOT NULL,
				started_at TEXT NOT NULL,
				completed_at TEXT,
				last_error TEXT
			);
		`),
	},
	{
		name: "25_add_durable_push_outbox",
		sql: txn(`
			ALTER TABLE push_subscriptions ADD COLUMN generation INTEGER NOT NULL DEFAULT 1;
			ALTER TABLE push_subscriptions ADD COLUMN last_push_attempt_at TEXT;
			ALTER TABLE push_subscriptions ADD COLUMN last_push_accepted_at TEXT;
			ALTER TABLE push_subscriptions ADD COLUMN last_push_failure_at TEXT;
			ALTER TABLE push_subscriptions ADD COLUMN last_push_failure_reason TEXT;
			ALTER TABLE push_subscriptions ADD COLUMN consecutive_push_failures INTEGER NOT NULL DEFAULT 0;

			CREATE TABLE push_notifications (
				id TEXT PRIMARY KEY,
				email_id TEXT NOT NULL UNIQUE,
				mailbox_id TEXT NOT NULL,
				payload_json TEXT NOT NULL,
				state TEXT NOT NULL CHECK(state IN ('pending', 'completed', 'no_targets', 'expired')),
				target_count INTEGER NOT NULL CHECK(target_count >= 0),
				created_at TEXT NOT NULL,
				expires_at TEXT NOT NULL,
				completed_at TEXT,
				FOREIGN KEY(email_id) REFERENCES emails(id) ON DELETE CASCADE
			);

			CREATE INDEX idx_push_notifications_state_expiry
				ON push_notifications(state, expires_at);
			CREATE INDEX idx_push_notifications_retention
				ON push_notifications(state, completed_at, created_at);

			CREATE TABLE push_notification_deliveries (
				notification_id TEXT NOT NULL,
				subscription_id TEXT NOT NULL,
				target_user_id TEXT NOT NULL,
				status TEXT NOT NULL CHECK(status IN ('pending', 'sending', 'retrying', 'accepted', 'terminal')),
				attempt_count INTEGER NOT NULL DEFAULT 0 CHECK(attempt_count >= 0),
				next_attempt_at TEXT NOT NULL,
				lease_token TEXT,
				lease_expires_at TEXT,
				attempted_subscription_generation INTEGER,
				last_reason TEXT,
				last_http_status INTEGER,
				created_at TEXT NOT NULL,
				updated_at TEXT NOT NULL,
				accepted_at TEXT,
				terminal_at TEXT,
				PRIMARY KEY(notification_id, subscription_id),
				FOREIGN KEY(notification_id) REFERENCES push_notifications(id) ON DELETE CASCADE
			);

			CREATE INDEX idx_push_deliveries_due
				ON push_notification_deliveries(status, next_attempt_at, notification_id, subscription_id);
			CREATE INDEX idx_push_deliveries_actor_health
				ON push_notification_deliveries(target_user_id, updated_at DESC, notification_id);
		`),
	},
	{
		name: "26_add_inbound_automation_rules",
		sql: txn(`
			CREATE TABLE automation_rule_state (
				id INTEGER PRIMARY KEY CHECK(id = 1),
				ruleset_generation INTEGER NOT NULL DEFAULT 0 CHECK(ruleset_generation >= 0),
				order_revision INTEGER NOT NULL DEFAULT 0 CHECK(order_revision >= 0),
				updated_at TEXT NOT NULL
			);
			INSERT INTO automation_rule_state(id, ruleset_generation, order_revision, updated_at)
			VALUES (1, 0, 0, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));

			CREATE TABLE automation_rules (
				id TEXT PRIMARY KEY,
				name TEXT NOT NULL,
				normalized_name TEXT NOT NULL,
				state TEXT NOT NULL CHECK(state IN (
					'draft', 'enabled', 'disabled', 'needs_attention', 'archived'
				)),
				active_version INTEGER,
				draft_version INTEGER,
				next_version INTEGER NOT NULL DEFAULT 1 CHECK(next_version >= 1),
				position INTEGER NOT NULL CHECK(position >= 0),
				revision INTEGER NOT NULL DEFAULT 1 CHECK(revision >= 1),
				created_by TEXT NOT NULL,
				created_at TEXT NOT NULL,
				updated_by TEXT NOT NULL,
				updated_at TEXT NOT NULL,
				archived_by TEXT,
				archived_at TEXT
			);
			CREATE UNIQUE INDEX idx_automation_rules_active_name
				ON automation_rules(normalized_name) WHERE state <> 'archived';
			CREATE INDEX idx_automation_rules_order
				ON automation_rules(state, position, id);

			CREATE TABLE automation_rule_versions (
				rule_id TEXT NOT NULL,
				version INTEGER NOT NULL CHECK(version >= 1),
				schema_version INTEGER NOT NULL CHECK(schema_version = 1),
				definition_json TEXT NOT NULL,
				definition_fingerprint TEXT NOT NULL,
				created_by TEXT NOT NULL,
				created_at TEXT NOT NULL,
				PRIMARY KEY(rule_id, version),
				FOREIGN KEY(rule_id) REFERENCES automation_rules(id) ON DELETE CASCADE
			);
			CREATE INDEX idx_automation_rule_versions_created
				ON automation_rule_versions(rule_id, created_at);

			CREATE TABLE automation_rule_label_refs (
				rule_id TEXT NOT NULL,
				version INTEGER NOT NULL,
				label_id TEXT NOT NULL,
				PRIMARY KEY(rule_id, version, label_id),
				FOREIGN KEY(rule_id, version) REFERENCES automation_rule_versions(rule_id, version) ON DELETE CASCADE,
				FOREIGN KEY(label_id) REFERENCES labels(id) ON DELETE RESTRICT
			);
			CREATE INDEX idx_automation_rule_label_target
				ON automation_rule_label_refs(label_id, rule_id);

			CREATE TABLE automation_rule_folder_refs (
				rule_id TEXT NOT NULL,
				version INTEGER NOT NULL,
				folder_id TEXT NOT NULL,
				PRIMARY KEY(rule_id, version, folder_id),
				FOREIGN KEY(rule_id, version) REFERENCES automation_rule_versions(rule_id, version) ON DELETE CASCADE,
				FOREIGN KEY(folder_id) REFERENCES folders(id) ON DELETE RESTRICT
			);
			CREATE INDEX idx_automation_rule_folder_target
				ON automation_rule_folder_refs(folder_id, rule_id);

			CREATE TABLE automation_runs (
				id TEXT PRIMARY KEY,
				trigger_kind TEXT NOT NULL CHECK(trigger_kind = 'live_inbound'),
				trigger_message_id TEXT NOT NULL UNIQUE,
				ruleset_generation INTEGER NOT NULL,
				state TEXT NOT NULL CHECK(state IN (
					'pending', 'processing', 'no_match', 'applied',
					'applied_with_skips', 'failed'
				)),
				attempt_count INTEGER NOT NULL DEFAULT 0 CHECK(attempt_count >= 0),
				next_attempt_at TEXT,
				lease_token TEXT,
				lease_expires_at TEXT,
				started_at TEXT,
				completed_at TEXT,
				evaluated_count INTEGER NOT NULL DEFAULT 0,
				matched_count INTEGER NOT NULL DEFAULT 0,
				applied_count INTEGER NOT NULL DEFAULT 0,
				stopped_by_rule_id TEXT,
				failure_category TEXT,
				created_at TEXT NOT NULL,
				updated_at TEXT NOT NULL,
				FOREIGN KEY(trigger_message_id) REFERENCES emails(id) ON DELETE CASCADE
			);
			CREATE INDEX idx_automation_runs_due
				ON automation_runs(state, next_attempt_at, id);
			CREATE INDEX idx_automation_runs_lease
				ON automation_runs(state, lease_expires_at, id);
			CREATE INDEX idx_automation_runs_history
				ON automation_runs(completed_at, id);

			CREATE TABLE automation_run_rules (
				run_id TEXT NOT NULL,
				ordinal INTEGER NOT NULL,
				rule_id TEXT NOT NULL,
				rule_name TEXT NOT NULL,
				rule_version INTEGER NOT NULL,
				definition_json TEXT NOT NULL,
				definition_fingerprint TEXT NOT NULL,
				PRIMARY KEY(run_id, ordinal),
				FOREIGN KEY(run_id) REFERENCES automation_runs(id) ON DELETE CASCADE
			);
			CREATE UNIQUE INDEX idx_automation_run_rules_identity
				ON automation_run_rules(run_id, rule_id);

			CREATE TABLE automation_run_results (
				run_id TEXT NOT NULL,
				ordinal INTEGER NOT NULL,
				rule_id TEXT NOT NULL,
				rule_name TEXT NOT NULL,
				rule_version INTEGER NOT NULL,
				outcome TEXT NOT NULL CHECK(outcome IN (
					'not_matched', 'applied', 'already_satisfied', 'skipped_conflict',
					'skipped_invalid_target', 'skipped_scope_changed', 'stopped'
				)),
				matched_condition_indexes_json TEXT NOT NULL,
				planned_actions_json TEXT NOT NULL,
				action_results_json TEXT NOT NULL,
				failure_category TEXT,
				attempt_count INTEGER NOT NULL,
				created_at TEXT NOT NULL,
				PRIMARY KEY(run_id, ordinal),
				FOREIGN KEY(run_id) REFERENCES automation_runs(id) ON DELETE CASCADE
			);

			CREATE TABLE automation_run_label_refs (
				run_id TEXT NOT NULL,
				label_id TEXT NOT NULL,
				PRIMARY KEY(run_id, label_id),
				FOREIGN KEY(run_id) REFERENCES automation_runs(id) ON DELETE CASCADE,
				FOREIGN KEY(label_id) REFERENCES labels(id) ON DELETE RESTRICT
			);
			CREATE INDEX idx_automation_run_label_target
				ON automation_run_label_refs(label_id, run_id);

			CREATE TABLE automation_run_folder_refs (
				run_id TEXT NOT NULL,
				folder_id TEXT NOT NULL,
				PRIMARY KEY(run_id, folder_id),
				FOREIGN KEY(run_id) REFERENCES automation_runs(id) ON DELETE CASCADE,
				FOREIGN KEY(folder_id) REFERENCES folders(id) ON DELETE RESTRICT
			);
			CREATE INDEX idx_automation_run_folder_target
				ON automation_run_folder_refs(folder_id, run_id);

			CREATE TABLE automation_rule_tests (
				id TEXT PRIMARY KEY,
				actor_id TEXT NOT NULL,
				rule_id TEXT,
				rule_version INTEGER,
				definition_json TEXT NOT NULL,
				definition_fingerprint TEXT NOT NULL,
				evaluated_count INTEGER NOT NULL CHECK(evaluated_count >= 0),
				matched_count INTEGER NOT NULL CHECK(matched_count >= 0),
				acknowledged_zero INTEGER NOT NULL DEFAULT 0 CHECK(acknowledged_zero IN (0, 1)),
				result_json TEXT NOT NULL,
				created_at TEXT NOT NULL,
				expires_at TEXT NOT NULL
			);
			CREATE INDEX idx_automation_rule_tests_rule_created
				ON automation_rule_tests(rule_id, created_at);
			CREATE INDEX idx_automation_rule_tests_retention
				ON automation_rule_tests(expires_at, created_at, id);

			DROP TRIGGER mailbox_changes_emails_insert;
			DROP TRIGGER mailbox_changes_emails_update;
			DROP TRIGGER mailbox_changes_emails_delete;
			DROP TRIGGER mailbox_changes_attachments_insert;
			DROP TRIGGER mailbox_changes_attachments_update;
			DROP TRIGGER mailbox_changes_attachments_delete;
			DROP TRIGGER mailbox_changes_folders_insert;
			DROP TRIGGER mailbox_changes_folders_update;
			DROP TRIGGER mailbox_changes_folders_delete;
			DROP TRIGGER mailbox_changes_labels_insert;
			DROP TRIGGER mailbox_changes_labels_update;
			DROP TRIGGER mailbox_changes_labels_delete;
			DROP TRIGGER mailbox_changes_email_labels_insert;
			DROP TRIGGER mailbox_changes_email_labels_update;
			DROP TRIGGER mailbox_changes_email_labels_delete;
			DROP TRIGGER mailbox_changes_deliveries_insert;
			DROP TRIGGER mailbox_changes_deliveries_update;
			DROP TRIGGER mailbox_changes_deliveries_delete;
			DROP TRIGGER mailbox_changes_delivery_attempts_insert;
			DROP TRIGGER mailbox_changes_delivery_attempts_update;
			DROP TRIGGER mailbox_changes_delivery_attempts_delete;

			ALTER TABLE mailbox_changes RENAME TO mailbox_changes_v1;
			CREATE TABLE mailbox_changes (
				sequence INTEGER PRIMARY KEY AUTOINCREMENT,
				schema_version INTEGER NOT NULL CHECK(schema_version = 1),
				committed_at TEXT NOT NULL,
				resource TEXT NOT NULL CHECK(resource IN (
					'message', 'attachment', 'folder', 'label', 'message_label',
					'delivery', 'delivery_attempt', 'automation_rule', 'automation_run'
				)),
				entity_id TEXT NOT NULL,
				parent_id TEXT,
				operation TEXT NOT NULL CHECK(operation IN ('created', 'updated', 'deleted'))
			);
			INSERT INTO mailbox_changes(sequence, schema_version, committed_at, resource, entity_id, parent_id, operation)
			SELECT sequence, schema_version, committed_at, resource, entity_id, parent_id, operation
			FROM mailbox_changes_v1 ORDER BY sequence;
			DROP TABLE mailbox_changes_v1;

			CREATE TRIGGER mailbox_changes_emails_insert AFTER INSERT ON emails BEGIN
				INSERT INTO mailbox_changes(schema_version, committed_at, resource, entity_id, parent_id, operation)
				VALUES (1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), 'message', NEW.id, NULL, 'created');
			END;
			CREATE TRIGGER mailbox_changes_emails_update AFTER UPDATE ON emails BEGIN
				INSERT INTO mailbox_changes(schema_version, committed_at, resource, entity_id, parent_id, operation)
				VALUES (1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), 'message', NEW.id, NULL, 'updated');
			END;
			CREATE TRIGGER mailbox_changes_emails_delete AFTER DELETE ON emails BEGIN
				INSERT INTO mailbox_changes(schema_version, committed_at, resource, entity_id, parent_id, operation)
				VALUES (1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), 'message', OLD.id, NULL, 'deleted');
			END;
			CREATE TRIGGER mailbox_changes_attachments_insert AFTER INSERT ON attachments BEGIN
				INSERT INTO mailbox_changes(schema_version, committed_at, resource, entity_id, parent_id, operation)
				VALUES (1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), 'attachment', NEW.id, NEW.email_id, 'created');
			END;
			CREATE TRIGGER mailbox_changes_attachments_update AFTER UPDATE ON attachments BEGIN
				INSERT INTO mailbox_changes(schema_version, committed_at, resource, entity_id, parent_id, operation)
				VALUES (1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), 'attachment', NEW.id, NEW.email_id, 'updated');
			END;
			CREATE TRIGGER mailbox_changes_attachments_delete AFTER DELETE ON attachments BEGIN
				INSERT INTO mailbox_changes(schema_version, committed_at, resource, entity_id, parent_id, operation)
				VALUES (1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), 'attachment', OLD.id, OLD.email_id, 'deleted');
			END;
			CREATE TRIGGER mailbox_changes_folders_insert AFTER INSERT ON folders BEGIN
				INSERT INTO mailbox_changes(schema_version, committed_at, resource, entity_id, parent_id, operation)
				VALUES (1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), 'folder', NEW.id, NULL, 'created');
			END;
			CREATE TRIGGER mailbox_changes_folders_update AFTER UPDATE ON folders BEGIN
				INSERT INTO mailbox_changes(schema_version, committed_at, resource, entity_id, parent_id, operation)
				VALUES (1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), 'folder', NEW.id, NULL, 'updated');
			END;
			CREATE TRIGGER mailbox_changes_folders_delete AFTER DELETE ON folders BEGIN
				INSERT INTO mailbox_changes(schema_version, committed_at, resource, entity_id, parent_id, operation)
				VALUES (1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), 'folder', OLD.id, NULL, 'deleted');
			END;
			CREATE TRIGGER mailbox_changes_labels_insert AFTER INSERT ON labels BEGIN
				INSERT INTO mailbox_changes(schema_version, committed_at, resource, entity_id, parent_id, operation)
				VALUES (1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), 'label', NEW.id, NULL, 'created');
			END;
			CREATE TRIGGER mailbox_changes_labels_update AFTER UPDATE ON labels BEGIN
				INSERT INTO mailbox_changes(schema_version, committed_at, resource, entity_id, parent_id, operation)
				VALUES (1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), 'label', NEW.id, NULL, 'updated');
			END;
			CREATE TRIGGER mailbox_changes_labels_delete AFTER DELETE ON labels BEGIN
				INSERT INTO mailbox_changes(schema_version, committed_at, resource, entity_id, parent_id, operation)
				VALUES (1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), 'label', OLD.id, NULL, 'deleted');
			END;
			CREATE TRIGGER mailbox_changes_email_labels_insert AFTER INSERT ON email_labels BEGIN
				INSERT INTO mailbox_changes(schema_version, committed_at, resource, entity_id, parent_id, operation)
				VALUES (1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), 'message_label', NEW.email_id || ':' || NEW.label_id, NEW.email_id, 'created');
			END;
			CREATE TRIGGER mailbox_changes_email_labels_update AFTER UPDATE ON email_labels BEGIN
				INSERT INTO mailbox_changes(schema_version, committed_at, resource, entity_id, parent_id, operation)
				VALUES (1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), 'message_label', NEW.email_id || ':' || NEW.label_id, NEW.email_id, 'updated');
			END;
			CREATE TRIGGER mailbox_changes_email_labels_delete AFTER DELETE ON email_labels BEGIN
				INSERT INTO mailbox_changes(schema_version, committed_at, resource, entity_id, parent_id, operation)
				VALUES (1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), 'message_label', OLD.email_id || ':' || OLD.label_id, OLD.email_id, 'deleted');
			END;
			CREATE TRIGGER mailbox_changes_deliveries_insert AFTER INSERT ON outbound_deliveries BEGIN
				INSERT INTO mailbox_changes(schema_version, committed_at, resource, entity_id, parent_id, operation)
				VALUES (1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), 'delivery', NEW.id, NEW.email_id, 'created');
			END;
			CREATE TRIGGER mailbox_changes_deliveries_update AFTER UPDATE ON outbound_deliveries BEGIN
				INSERT INTO mailbox_changes(schema_version, committed_at, resource, entity_id, parent_id, operation)
				VALUES (1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), 'delivery', NEW.id, NEW.email_id, 'updated');
			END;
			CREATE TRIGGER mailbox_changes_deliveries_delete AFTER DELETE ON outbound_deliveries BEGIN
				INSERT INTO mailbox_changes(schema_version, committed_at, resource, entity_id, parent_id, operation)
				VALUES (1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), 'delivery', OLD.id, OLD.email_id, 'deleted');
			END;
			CREATE TRIGGER mailbox_changes_delivery_attempts_insert AFTER INSERT ON outbound_delivery_attempts BEGIN
				INSERT INTO mailbox_changes(schema_version, committed_at, resource, entity_id, parent_id, operation)
				VALUES (1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), 'delivery_attempt', NEW.id, NEW.delivery_id, 'created');
			END;
			CREATE TRIGGER mailbox_changes_delivery_attempts_update AFTER UPDATE ON outbound_delivery_attempts BEGIN
				INSERT INTO mailbox_changes(schema_version, committed_at, resource, entity_id, parent_id, operation)
				VALUES (1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), 'delivery_attempt', NEW.id, NEW.delivery_id, 'updated');
			END;
			CREATE TRIGGER mailbox_changes_delivery_attempts_delete AFTER DELETE ON outbound_delivery_attempts BEGIN
				INSERT INTO mailbox_changes(schema_version, committed_at, resource, entity_id, parent_id, operation)
				VALUES (1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), 'delivery_attempt', OLD.id, OLD.delivery_id, 'deleted');
			END;
			CREATE TRIGGER mailbox_changes_automation_rules_insert AFTER INSERT ON automation_rules BEGIN
				INSERT INTO mailbox_changes(schema_version, committed_at, resource, entity_id, parent_id, operation)
				VALUES (1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), 'automation_rule', NEW.id, NULL, 'created');
			END;
			CREATE TRIGGER mailbox_changes_automation_rules_update AFTER UPDATE ON automation_rules BEGIN
				INSERT INTO mailbox_changes(schema_version, committed_at, resource, entity_id, parent_id, operation)
				VALUES (1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), 'automation_rule', NEW.id, NULL, 'updated');
			END;
			CREATE TRIGGER mailbox_changes_automation_runs_insert AFTER INSERT ON automation_runs BEGIN
				INSERT INTO mailbox_changes(schema_version, committed_at, resource, entity_id, parent_id, operation)
				VALUES (1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), 'automation_run', NEW.id, NEW.trigger_message_id, 'created');
			END;
			CREATE TRIGGER mailbox_changes_automation_runs_terminal_update
			AFTER UPDATE OF state ON automation_runs
			WHEN OLD.state <> NEW.state AND NEW.state IN ('no_match', 'applied', 'applied_with_skips', 'failed')
			BEGIN
				INSERT INTO mailbox_changes(schema_version, committed_at, resource, entity_id, parent_id, operation)
				VALUES (1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), 'automation_run', NEW.id, NEW.trigger_message_id, 'updated');
			END;
		`),
	},
	{
		name: "27_add_semantic_message_projection",
		sql: txn(`
			CREATE TABLE semantic_message_versions (
				message_id TEXT PRIMARY KEY,
				version INTEGER NOT NULL CHECK(version > 0),
				FOREIGN KEY(message_id) REFERENCES emails(id) ON DELETE CASCADE
			);
			INSERT INTO semantic_message_versions(message_id, version)
			SELECT id, 1 FROM emails;

			CREATE TABLE semantic_projection_state (
				id INTEGER PRIMARY KEY CHECK(id = 1),
				schema_version INTEGER NOT NULL CHECK(schema_version = 1),
				policy_version INTEGER NOT NULL CHECK(policy_version = 1),
				chunk_version INTEGER NOT NULL CHECK(chunk_version = 1),
				status TEXT NOT NULL CHECK(status IN ('building', 'ready', 'failed')),
				baseline_change_sequence INTEGER NOT NULL CHECK(baseline_change_sequence >= 0),
				applied_change_sequence INTEGER NOT NULL CHECK(applied_change_sequence >= 0),
				backfill_date TEXT,
				backfill_message_id TEXT,
				processed_messages INTEGER NOT NULL DEFAULT 0 CHECK(processed_messages >= 0),
				started_at TEXT NOT NULL,
				completed_at TEXT,
				last_error_code TEXT
			);

			CREATE TABLE semantic_sources (
				source_id TEXT PRIMARY KEY,
				message_id TEXT NOT NULL UNIQUE,
				source_fingerprint TEXT NOT NULL,
				source_sequence INTEGER NOT NULL CHECK(source_sequence >= 0),
				folder_id TEXT NOT NULL,
				created_at TEXT NOT NULL,
				updated_at TEXT NOT NULL,
				UNIQUE(source_id, message_id),
				FOREIGN KEY(message_id) REFERENCES emails(id) ON DELETE CASCADE
			);

			CREATE TABLE semantic_chunks (
				vector_id TEXT PRIMARY KEY,
				source_id TEXT NOT NULL,
				message_id TEXT NOT NULL,
				source_fingerprint TEXT NOT NULL,
				ordinal INTEGER NOT NULL CHECK(ordinal >= 0 AND ordinal < 100),
				content TEXT NOT NULL,
				created_at TEXT NOT NULL,
				UNIQUE(source_id, ordinal),
				FOREIGN KEY(source_id, message_id)
					REFERENCES semantic_sources(source_id, message_id) ON DELETE CASCADE,
				FOREIGN KEY(message_id) REFERENCES emails(id) ON DELETE CASCADE
			);

			CREATE VIRTUAL TABLE semantic_chunks_fts USING fts5(
				vector_id UNINDEXED,
				content,
				tokenize = 'unicode61 remove_diacritics 2'
			);

			CREATE TABLE semantic_index_jobs (
				vector_id TEXT PRIMARY KEY,
				operation TEXT NOT NULL CHECK(operation IN ('upsert', 'delete')),
				state TEXT NOT NULL CHECK(state IN ('pending', 'processing', 'submitted', 'failed')),
				attempt_count INTEGER NOT NULL DEFAULT 0 CHECK(attempt_count >= 0),
				next_attempt_at INTEGER NOT NULL,
				lease_token TEXT,
				lease_expires_at INTEGER,
				submitted_at INTEGER,
				mutation_id TEXT,
				last_error_code TEXT,
				created_at TEXT NOT NULL,
				updated_at TEXT NOT NULL
			);
			CREATE INDEX idx_semantic_jobs_due
				ON semantic_index_jobs(state, next_attempt_at, vector_id);
			CREATE INDEX idx_semantic_chunks_message
				ON semantic_chunks(message_id, ordinal);

			CREATE TRIGGER semantic_message_version_insert AFTER INSERT ON emails BEGIN
				INSERT INTO semantic_message_versions(message_id, version) VALUES (NEW.id, 1);
			END;
			CREATE TRIGGER semantic_message_version_content_update
			AFTER UPDATE OF subject, sender, recipient, cc, bcc, date, body ON emails
			WHEN OLD.subject IS NOT NEW.subject
			  OR OLD.sender IS NOT NEW.sender
			  OR OLD.recipient IS NOT NEW.recipient
			  OR OLD.cc IS NOT NEW.cc
			  OR OLD.bcc IS NOT NEW.bcc
			  OR OLD.date IS NOT NEW.date
			  OR OLD.body IS NOT NEW.body
			BEGIN
				UPDATE semantic_message_versions SET version = version + 1
				WHERE message_id = NEW.id;
			END;

			CREATE TRIGGER semantic_chunks_fts_insert AFTER INSERT ON semantic_chunks BEGIN
				INSERT INTO semantic_chunks_fts(vector_id, content)
				VALUES (NEW.vector_id, NEW.content);
			END;
			CREATE TRIGGER semantic_chunks_fts_delete BEFORE DELETE ON semantic_chunks BEGIN
				DELETE FROM semantic_chunks_fts WHERE vector_id = OLD.vector_id;
			END;
			CREATE TRIGGER semantic_chunks_enqueue_upsert AFTER INSERT ON semantic_chunks BEGIN
				INSERT INTO semantic_index_jobs(
					vector_id, operation, state, attempt_count, next_attempt_at,
					lease_token, lease_expires_at, submitted_at, mutation_id, last_error_code,
					created_at, updated_at
				) VALUES (
					NEW.vector_id, 'upsert', 'pending', 0, 0,
					NULL, NULL, NULL, NULL, NULL,
					strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
					strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
				)
				ON CONFLICT(vector_id) DO UPDATE SET
					operation = 'upsert', state = 'pending', attempt_count = 0,
					next_attempt_at = 0, lease_token = NULL, lease_expires_at = NULL,
					submitted_at = NULL, mutation_id = NULL, last_error_code = NULL,
					updated_at = excluded.updated_at;
			END;
			CREATE TRIGGER semantic_chunks_enqueue_delete BEFORE DELETE ON semantic_chunks BEGIN
				INSERT INTO semantic_index_jobs(
					vector_id, operation, state, attempt_count, next_attempt_at,
					lease_token, lease_expires_at, submitted_at, mutation_id, last_error_code,
					created_at, updated_at
				) VALUES (
					OLD.vector_id, 'delete', 'pending', 0, 0,
					NULL, NULL, NULL, NULL, NULL,
					strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
					strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
				)
				ON CONFLICT(vector_id) DO UPDATE SET
					operation = 'delete', state = 'pending', attempt_count = 0,
					next_attempt_at = 0, lease_token = NULL, lease_expires_at = NULL,
					submitted_at = NULL, mutation_id = NULL, last_error_code = NULL,
					updated_at = excluded.updated_at;
			END;

			CREATE TRIGGER semantic_sources_invalidate_on_message_content_change
			AFTER UPDATE OF subject, sender, recipient, cc, bcc, date, body ON emails
			WHEN OLD.subject IS NOT NEW.subject
			  OR OLD.sender IS NOT NEW.sender
			  OR OLD.recipient IS NOT NEW.recipient
			  OR OLD.cc IS NOT NEW.cc
			  OR OLD.bcc IS NOT NEW.bcc
			  OR OLD.date IS NOT NEW.date
			  OR OLD.body IS NOT NEW.body
			BEGIN
				DELETE FROM semantic_sources WHERE message_id = NEW.id;
			END;
			CREATE TRIGGER semantic_sources_invalidate_on_excluded_folder
			AFTER UPDATE OF folder_id ON emails
			WHEN OLD.folder_id IS NOT NEW.folder_id
			 AND NEW.folder_id IN ('draft', 'outbox', 'trash', 'spam', '_cancelled_outbound')
			BEGIN
				DELETE FROM semantic_sources WHERE message_id = NEW.id;
			END;
			CREATE TRIGGER semantic_sources_track_eligible_folder
			AFTER UPDATE OF folder_id ON emails
			WHEN OLD.folder_id IS NOT NEW.folder_id
			 AND NEW.folder_id NOT IN ('draft', 'outbox', 'trash', 'spam', '_cancelled_outbound')
			BEGIN
				UPDATE semantic_sources SET folder_id = NEW.folder_id,
					updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
				WHERE message_id = NEW.id;
			END;
		`),
	},
	{
		name: "28_add_semantic_attachment_evidence",
		sql: txn(`
			DROP TRIGGER semantic_chunks_fts_insert;
			DROP TRIGGER semantic_chunks_fts_delete;
			DROP TRIGGER semantic_chunks_enqueue_upsert;
			DROP TRIGGER semantic_chunks_enqueue_delete;
			DROP TRIGGER semantic_sources_invalidate_on_message_content_change;
			DROP TRIGGER semantic_sources_invalidate_on_excluded_folder;
			DROP TRIGGER semantic_sources_track_eligible_folder;

			ALTER TABLE semantic_projection_state RENAME TO semantic_projection_state_v1;
			ALTER TABLE semantic_sources RENAME TO semantic_sources_v1;
			ALTER TABLE semantic_chunks RENAME TO semantic_chunks_v1;
			DROP TABLE semantic_chunks_fts;

			CREATE TABLE semantic_projection_state (
				id INTEGER PRIMARY KEY CHECK(id = 1),
				schema_version INTEGER NOT NULL CHECK(schema_version = 2),
				policy_version INTEGER NOT NULL CHECK(policy_version = 1),
				chunk_version INTEGER NOT NULL CHECK(chunk_version = 1),
				status TEXT NOT NULL CHECK(status IN ('building', 'ready', 'failed')),
				baseline_change_sequence INTEGER NOT NULL CHECK(baseline_change_sequence >= 0),
				applied_change_sequence INTEGER NOT NULL CHECK(applied_change_sequence >= 0),
				backfill_date TEXT,
				backfill_message_id TEXT,
				processed_messages INTEGER NOT NULL DEFAULT 0 CHECK(processed_messages >= 0),
				attachment_status TEXT NOT NULL CHECK(attachment_status IN ('building', 'ready', 'failed')),
				attachment_extraction_version INTEGER NOT NULL CHECK(attachment_extraction_version > 0),
				attachment_policy_version INTEGER NOT NULL CHECK(attachment_policy_version > 0),
				attachment_chunk_version INTEGER NOT NULL CHECK(attachment_chunk_version > 0),
				attachment_backfill_date TEXT,
				attachment_backfill_message_id TEXT,
				attachment_backfill_id TEXT,
				processed_attachments INTEGER NOT NULL DEFAULT 0 CHECK(processed_attachments >= 0),
				attachment_last_error_code TEXT,
				started_at TEXT NOT NULL,
				completed_at TEXT,
				last_error_code TEXT
			);
			INSERT INTO semantic_projection_state(
				id, schema_version, policy_version, chunk_version, status,
				baseline_change_sequence, applied_change_sequence, backfill_date,
				backfill_message_id, processed_messages, attachment_status,
				attachment_extraction_version,
				attachment_policy_version, attachment_chunk_version,
				attachment_backfill_date, attachment_backfill_message_id,
				attachment_backfill_id, processed_attachments,
				attachment_last_error_code, started_at, completed_at,
				last_error_code
			)
			SELECT 1, 2, policy_version, chunk_version, status,
				baseline_change_sequence, applied_change_sequence,
				backfill_date, backfill_message_id, processed_messages, 'building', 1, 1, 1,
				NULL, NULL, NULL, 0, NULL, started_at, completed_at, last_error_code
			FROM semantic_projection_state_v1 WHERE id = 1;

			CREATE TABLE semantic_sources (
				source_id TEXT PRIMARY KEY,
				source_type TEXT NOT NULL CHECK(source_type IN ('message', 'attachment')),
				message_id TEXT NOT NULL,
				attachment_id TEXT,
				attachment_filename TEXT,
				extraction_version INTEGER NOT NULL DEFAULT 0 CHECK(extraction_version >= 0),
				attachment_policy_version INTEGER NOT NULL DEFAULT 0 CHECK(attachment_policy_version >= 0),
				attachment_chunk_version INTEGER NOT NULL DEFAULT 0 CHECK(attachment_chunk_version >= 0),
				source_fingerprint TEXT NOT NULL,
				source_sequence INTEGER NOT NULL CHECK(source_sequence >= 0),
				folder_id TEXT NOT NULL,
				created_at TEXT NOT NULL,
				updated_at TEXT NOT NULL,
				CHECK(
					(source_type = 'message' AND attachment_id IS NULL AND attachment_filename IS NULL
					 AND extraction_version = 0 AND attachment_policy_version = 0 AND attachment_chunk_version = 0)
					OR
					(source_type = 'attachment' AND attachment_id IS NOT NULL AND attachment_filename IS NOT NULL
					 AND extraction_version > 0 AND attachment_policy_version > 0 AND attachment_chunk_version > 0)
				),
				FOREIGN KEY(message_id) REFERENCES emails(id) ON DELETE CASCADE,
				FOREIGN KEY(attachment_id) REFERENCES attachments(id) ON DELETE CASCADE
			);
			INSERT INTO semantic_sources(
				source_id, source_type, message_id, attachment_id, attachment_filename,
				extraction_version, attachment_policy_version, attachment_chunk_version,
				source_fingerprint, source_sequence, folder_id,
				created_at, updated_at
			)
			SELECT source_id, 'message', message_id, NULL, NULL, 0, 0, 0,
				source_fingerprint, source_sequence, folder_id, created_at, updated_at
			FROM semantic_sources_v1;

			CREATE TABLE semantic_chunks (
				vector_id TEXT PRIMARY KEY,
				source_id TEXT NOT NULL,
				source_type TEXT NOT NULL CHECK(source_type IN ('message', 'attachment')),
				message_id TEXT NOT NULL,
				attachment_id TEXT,
				source_fingerprint TEXT NOT NULL,
				ordinal INTEGER NOT NULL CHECK(ordinal >= 0 AND ordinal < 100),
				content TEXT NOT NULL,
				excerpt TEXT NOT NULL,
				created_at TEXT NOT NULL,
				CHECK(
					(source_type = 'message' AND attachment_id IS NULL)
					OR (source_type = 'attachment' AND attachment_id IS NOT NULL)
				),
				UNIQUE(source_id, ordinal),
				FOREIGN KEY(source_id) REFERENCES semantic_sources(source_id) ON DELETE CASCADE,
				FOREIGN KEY(message_id) REFERENCES emails(id) ON DELETE CASCADE,
				FOREIGN KEY(attachment_id) REFERENCES attachments(id) ON DELETE CASCADE
			);
			INSERT INTO semantic_chunks(
				vector_id, source_id, source_type, message_id, attachment_id,
				source_fingerprint, ordinal, content, excerpt, created_at
			)
			SELECT vector_id, source_id, 'message', message_id, NULL,
				source_fingerprint, ordinal, content, content, created_at
			FROM semantic_chunks_v1;

			CREATE TABLE semantic_attachment_versions (
				attachment_id TEXT PRIMARY KEY,
				message_id TEXT NOT NULL,
				version INTEGER NOT NULL CHECK(version > 0),
				FOREIGN KEY(attachment_id) REFERENCES attachments(id) ON DELETE CASCADE,
				FOREIGN KEY(message_id) REFERENCES emails(id) ON DELETE CASCADE
			);
			INSERT INTO semantic_attachment_versions(attachment_id, message_id, version)
			SELECT id, email_id, 1 FROM attachments;

			CREATE TABLE semantic_attachment_extractions (
				attachment_id TEXT PRIMARY KEY,
				message_id TEXT NOT NULL,
				attachment_version INTEGER NOT NULL CHECK(attachment_version > 0),
				filename TEXT NOT NULL,
				mimetype TEXT NOT NULL,
				declared_size INTEGER NOT NULL CHECK(declared_size >= 0),
				content_id TEXT,
				disposition TEXT,
				state TEXT NOT NULL CHECK(state IN ('pending', 'processing', 'ready', 'unsupported', 'failed')),
				attempt_count INTEGER NOT NULL DEFAULT 0 CHECK(attempt_count >= 0),
				next_attempt_at INTEGER NOT NULL,
				lease_token TEXT,
				lease_expires_at INTEGER,
				byte_sha256 TEXT,
				r2_version TEXT,
				r2_etag TEXT,
				actual_size INTEGER CHECK(actual_size IS NULL OR actual_size >= 0),
				last_error_code TEXT,
				created_at TEXT NOT NULL,
				updated_at TEXT NOT NULL,
				FOREIGN KEY(attachment_id) REFERENCES attachments(id) ON DELETE CASCADE,
				FOREIGN KEY(message_id) REFERENCES emails(id) ON DELETE CASCADE
			);
			CREATE INDEX idx_semantic_attachment_extractions_due
				ON semantic_attachment_extractions(state, next_attempt_at, attachment_id);

			DROP TABLE semantic_chunks_v1;
			DROP TABLE semantic_sources_v1;
			DROP TABLE semantic_projection_state_v1;

			CREATE VIRTUAL TABLE semantic_chunks_fts USING fts5(
				vector_id UNINDEXED,
				content,
				tokenize = 'unicode61 remove_diacritics 2'
			);
			INSERT INTO semantic_chunks_fts(vector_id, content)
			SELECT vector_id, content FROM semantic_chunks;

			CREATE INDEX idx_semantic_chunks_message
				ON semantic_chunks(message_id, source_type, attachment_id, ordinal);
			CREATE UNIQUE INDEX idx_semantic_sources_message_unique
				ON semantic_sources(message_id) WHERE source_type = 'message';
			CREATE UNIQUE INDEX idx_semantic_sources_attachment_unique
				ON semantic_sources(message_id, attachment_id) WHERE source_type = 'attachment';

			CREATE TRIGGER semantic_sources_attachment_pair_insert
			BEFORE INSERT ON semantic_sources
			WHEN NEW.source_type = 'attachment' AND NOT EXISTS (
				SELECT 1 FROM attachments
				WHERE id = NEW.attachment_id AND email_id = NEW.message_id
			)
			BEGIN
				SELECT RAISE(ABORT, 'semantic attachment ownership mismatch');
			END;
			CREATE TRIGGER semantic_sources_attachment_pair_update
			BEFORE UPDATE OF source_type, message_id, attachment_id ON semantic_sources
			WHEN NEW.source_type = 'attachment' AND NOT EXISTS (
				SELECT 1 FROM attachments
				WHERE id = NEW.attachment_id AND email_id = NEW.message_id
			)
			BEGIN
				SELECT RAISE(ABORT, 'semantic attachment ownership mismatch');
			END;
			CREATE TRIGGER semantic_sources_identity_immutable
			BEFORE UPDATE OF source_id, source_type, message_id, attachment_id,
			 attachment_filename, extraction_version, attachment_policy_version,
			 attachment_chunk_version, source_fingerprint, source_sequence
			ON semantic_sources
			BEGIN
				SELECT RAISE(ABORT, 'semantic source identity is immutable');
			END;
			CREATE TRIGGER semantic_chunks_source_guard
			BEFORE INSERT ON semantic_chunks
			WHEN NOT EXISTS (
				SELECT 1 FROM semantic_sources
				WHERE source_id = NEW.source_id
				  AND source_type = NEW.source_type
				  AND message_id = NEW.message_id
				  AND attachment_id IS NEW.attachment_id
				  AND source_fingerprint = NEW.source_fingerprint
			)
			BEGIN
				SELECT RAISE(ABORT, 'semantic chunk source mismatch');
			END;
			CREATE TRIGGER semantic_chunks_immutable
			BEFORE UPDATE ON semantic_chunks
			BEGIN
				SELECT RAISE(ABORT, 'semantic chunks are immutable');
			END;
			CREATE TRIGGER semantic_attachment_versions_pair_insert
			BEFORE INSERT ON semantic_attachment_versions
			WHEN NOT EXISTS (
				SELECT 1 FROM attachments
				WHERE id = NEW.attachment_id AND email_id = NEW.message_id
			)
			BEGIN
				SELECT RAISE(ABORT, 'semantic attachment version ownership mismatch');
			END;
			CREATE TRIGGER semantic_attachment_versions_pair_update
			BEFORE UPDATE OF attachment_id, message_id ON semantic_attachment_versions
			WHEN NOT EXISTS (
				SELECT 1 FROM attachments
				WHERE id = NEW.attachment_id AND email_id = NEW.message_id
			)
			BEGIN
				SELECT RAISE(ABORT, 'semantic attachment version ownership mismatch');
			END;
			CREATE TRIGGER semantic_attachment_extractions_pair_insert
			BEFORE INSERT ON semantic_attachment_extractions
			WHEN NOT EXISTS (
				SELECT 1 FROM attachments
				WHERE id = NEW.attachment_id AND email_id = NEW.message_id
			)
			BEGIN
				SELECT RAISE(ABORT, 'semantic attachment extraction ownership mismatch');
			END;
			CREATE TRIGGER semantic_attachment_extractions_pair_update
			BEFORE UPDATE OF attachment_id, message_id ON semantic_attachment_extractions
			WHEN NOT EXISTS (
				SELECT 1 FROM attachments
				WHERE id = NEW.attachment_id AND email_id = NEW.message_id
			)
			BEGIN
				SELECT RAISE(ABORT, 'semantic attachment extraction ownership mismatch');
			END;

			CREATE TRIGGER semantic_chunks_fts_insert AFTER INSERT ON semantic_chunks BEGIN
				INSERT INTO semantic_chunks_fts(vector_id, content)
				VALUES (NEW.vector_id, NEW.content);
			END;
			CREATE TRIGGER semantic_chunks_fts_delete BEFORE DELETE ON semantic_chunks BEGIN
				DELETE FROM semantic_chunks_fts WHERE vector_id = OLD.vector_id;
			END;
			CREATE TRIGGER semantic_chunks_enqueue_upsert AFTER INSERT ON semantic_chunks BEGIN
				INSERT INTO semantic_index_jobs(
					vector_id, operation, state, attempt_count, next_attempt_at,
					lease_token, lease_expires_at, submitted_at, mutation_id, last_error_code,
					created_at, updated_at
				) VALUES (
					NEW.vector_id, 'upsert', 'pending', 0, 0,
					NULL, NULL, NULL, NULL, NULL,
					strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
					strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
				)
				ON CONFLICT(vector_id) DO UPDATE SET
					operation = 'upsert', state = 'pending', attempt_count = 0,
					next_attempt_at = 0, lease_token = NULL, lease_expires_at = NULL,
					submitted_at = NULL, mutation_id = NULL, last_error_code = NULL,
					updated_at = excluded.updated_at;
			END;
			CREATE TRIGGER semantic_chunks_enqueue_delete BEFORE DELETE ON semantic_chunks BEGIN
				INSERT INTO semantic_index_jobs(
					vector_id, operation, state, attempt_count, next_attempt_at,
					lease_token, lease_expires_at, submitted_at, mutation_id, last_error_code,
					created_at, updated_at
				) VALUES (
					OLD.vector_id, 'delete', 'pending', 0, 0,
					NULL, NULL, NULL, NULL, NULL,
					strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
					strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
				)
				ON CONFLICT(vector_id) DO UPDATE SET
					operation = 'delete', state = 'pending', attempt_count = 0,
					next_attempt_at = 0, lease_token = NULL, lease_expires_at = NULL,
					submitted_at = NULL, mutation_id = NULL, last_error_code = NULL,
					updated_at = excluded.updated_at;
			END;

			CREATE TRIGGER semantic_attachment_version_insert AFTER INSERT ON attachments BEGIN
				INSERT INTO semantic_attachment_versions(attachment_id, message_id, version)
				VALUES (NEW.id, NEW.email_id, 1);
			END;
			CREATE TRIGGER semantic_attachment_version_update
			AFTER UPDATE OF email_id, filename, mimetype, size, content_id, disposition ON attachments
			WHEN OLD.email_id IS NOT NEW.email_id
			  OR OLD.filename IS NOT NEW.filename
			  OR OLD.mimetype IS NOT NEW.mimetype
			  OR OLD.size IS NOT NEW.size
			  OR OLD.content_id IS NOT NEW.content_id
			  OR OLD.disposition IS NOT NEW.disposition
			BEGIN
				UPDATE semantic_attachment_versions
				SET message_id = NEW.email_id, version = version + 1
				WHERE attachment_id = NEW.id;
				DELETE FROM semantic_sources
				WHERE source_type = 'attachment' AND attachment_id = NEW.id;
				DELETE FROM semantic_attachment_extractions WHERE attachment_id = NEW.id;
			END;

			CREATE TRIGGER semantic_sources_invalidate_on_message_content_change
			AFTER UPDATE OF subject, sender, recipient, cc, bcc, date, body ON emails
			WHEN OLD.subject IS NOT NEW.subject
			  OR OLD.sender IS NOT NEW.sender
			  OR OLD.recipient IS NOT NEW.recipient
			  OR OLD.cc IS NOT NEW.cc
			  OR OLD.bcc IS NOT NEW.bcc
			  OR OLD.date IS NOT NEW.date
			  OR OLD.body IS NOT NEW.body
			BEGIN
				DELETE FROM semantic_sources
				WHERE source_type = 'message' AND message_id = NEW.id;
			END;
			CREATE TRIGGER semantic_sources_invalidate_on_excluded_folder
			AFTER UPDATE OF folder_id ON emails
			WHEN OLD.folder_id IS NOT NEW.folder_id
			 AND NEW.folder_id IN ('draft', 'outbox', 'trash', 'spam', '_cancelled_outbound')
			BEGIN
				DELETE FROM semantic_sources WHERE message_id = NEW.id;
				DELETE FROM semantic_attachment_extractions WHERE message_id = NEW.id;
			END;
			CREATE TRIGGER semantic_sources_track_eligible_folder
			AFTER UPDATE OF folder_id ON emails
			WHEN OLD.folder_id IS NOT NEW.folder_id
			 AND NEW.folder_id NOT IN ('draft', 'outbox', 'trash', 'spam', '_cancelled_outbound')
			BEGIN
				UPDATE semantic_sources SET folder_id = NEW.folder_id,
					updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
				WHERE message_id = NEW.id;
			END;
		`),
	},
	{
		name: "29_retain_draft_create_operations",
		sql: txn(`
			CREATE TABLE draft_create_operations (
				create_key TEXT PRIMARY KEY,
				fingerprint TEXT NOT NULL,
				draft_id TEXT NOT NULL,
				draft_version INTEGER NOT NULL,
				state TEXT NOT NULL CHECK(state IN (
					'active', 'discarded', 'consumed', 'deleted', 'unavailable'
				)),
				updated_at TEXT NOT NULL
			);
			CREATE INDEX idx_draft_create_operations_draft_id
				ON draft_create_operations(draft_id);
			INSERT INTO draft_create_operations(
				create_key, fingerprint, draft_id, draft_version, state, updated_at
			)
			SELECT
				draft_create_key,
				draft_create_fingerprint,
				id,
				draft_version,
				CASE WHEN folder_id = 'draft' THEN 'active' ELSE 'unavailable' END,
				COALESCE(date, datetime('now'))
			FROM emails
			WHERE draft_create_key IS NOT NULL
			  AND draft_create_fingerprint IS NOT NULL;
		`),
	},
	{
		name: "30_add_draft_save_operations",
		sql: txn(`
			CREATE TABLE draft_save_operations (
				save_key TEXT PRIMARY KEY,
				fingerprint TEXT NOT NULL,
				draft_id TEXT NOT NULL,
				expected_version INTEGER NOT NULL,
				state TEXT NOT NULL CHECK(state IN ('claimed', 'committed', 'aborted')),
				destination_keys TEXT NOT NULL DEFAULT '[]',
				committed_version INTEGER,
				claim_expires_at INTEGER NOT NULL,
				updated_at TEXT NOT NULL
			);
			CREATE INDEX idx_draft_save_operations_revision
				ON draft_save_operations(draft_id, expected_version, state);
		`),
	},
	{
		name: "31_add_draft_save_claim_token",
		sql: txn(`
			ALTER TABLE draft_save_operations ADD COLUMN claim_token TEXT;
		`),
	},
	{
		name: "32_index_draft_save_retention",
		sql: txn(`
			CREATE INDEX idx_draft_save_operations_retention
				ON draft_save_operations(updated_at, save_key)
				WHERE state IN ('committed', 'aborted');
		`),
	},
	{
		name: "33_add_draft_save_cleanup_intents",
		sql: txn(`
			CREATE TABLE draft_save_cleanup_intents (
				claim_token TEXT PRIMARY KEY,
				draft_id TEXT NOT NULL,
				destination_keys TEXT NOT NULL,
				next_attempt_at INTEGER NOT NULL,
				verify_until INTEGER NOT NULL,
				attempts INTEGER NOT NULL DEFAULT 0,
				updated_at TEXT NOT NULL
			);
			CREATE INDEX idx_draft_save_cleanup_due
				ON draft_save_cleanup_intents(next_attempt_at, claim_token);
		`),
	},
	{
		name: "34_add_draft_update_operations",
		sql: txn(`
			CREATE TABLE draft_update_operations (
				update_key TEXT PRIMARY KEY,
				fingerprint TEXT NOT NULL,
				draft_id TEXT NOT NULL,
				previous_version INTEGER NOT NULL CHECK(previous_version >= 1),
				result_version INTEGER NOT NULL
					CHECK(result_version = previous_version + 1),
				committed_at TEXT NOT NULL
			);
			CREATE INDEX idx_draft_update_operations_result
				ON draft_update_operations(draft_id, result_version);
		`),
	},
  {
    name: "35_add_resource_create_operations",
    sql: txn(`
				CREATE TABLE resource_create_operations (
					operation_key TEXT PRIMARY KEY CHECK(length(operation_key) = 64),
					resource_kind TEXT NOT NULL CHECK(resource_kind IN ('folder', 'label')),
					fingerprint TEXT NOT NULL CHECK(length(fingerprint) = 64),
				resource_id TEXT NOT NULL,
				state TEXT NOT NULL CHECK(state IN ('active', 'superseded', 'unavailable')),
				updated_at TEXT NOT NULL
			);
			CREATE INDEX idx_resource_create_operations_resource
				ON resource_create_operations(resource_kind, resource_id);
				CREATE INDEX idx_resource_create_operations_retention
					ON resource_create_operations(updated_at, operation_key)
					WHERE state IN ('superseded', 'unavailable');
		`),
  },
];
