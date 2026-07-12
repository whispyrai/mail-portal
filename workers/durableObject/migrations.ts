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
];
