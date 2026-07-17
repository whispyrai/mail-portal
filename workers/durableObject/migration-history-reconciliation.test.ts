import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { Log, LogLevel, Miniflare } from "miniflare";
import { mailboxMigrations } from "./migrations.ts";

const execFileAsync = promisify(execFile);
const ROOT = process.cwd();
const PRODUCTION_COMPATIBILITY_DATE = "2025-11-28";
let outputDirectory: string | undefined;
let runtime: Miniflare | undefined;

test.before(async () => {
	outputDirectory = await mkdtemp(join(tmpdir(), "mail-migration-history-"));
	const wranglerConfig = await readFile(join(ROOT, "wrangler.jsonc"), "utf8");
	const configuredCompatibilityDate = wranglerConfig.match(
		/^\s*"compatibility_date"\s*:\s*"(\d{4}-\d{2}-\d{2})"\s*,?\s*$/m,
	)?.[1];
	assert.equal(
		configuredCompatibilityDate,
		PRODUCTION_COMPATIBILITY_DATE,
		"migration test compatibility date must match production wrangler.jsonc",
	);
	await execFileAsync(
		join(ROOT, "node_modules/.bin/wrangler"),
		[
			"deploy",
			"workers/testing/migration-history-integration-entry.ts",
			"--dry-run",
			"--outdir",
			outputDirectory,
			"--compatibility-date",
			PRODUCTION_COMPATIBILITY_DATE,
			"--compatibility-flag",
			"nodejs_compat",
			"--config",
			"wrangler.jsonc",
			"--env=",
			"--upload-source-maps=false",
		],
		{
			cwd: ROOT,
			env: {
				...process.env,
				WRANGLER_LOG_PATH: join(outputDirectory, "wrangler.log"),
			},
		},
	);
	const bundle = await readFile(
		join(outputDirectory, "migration-history-integration-entry.js"),
		"utf8",
	);
	runtime = new Miniflare({
		log: new Log(LogLevel.ERROR),
		modules: true,
		script: bundle,
		compatibilityDate: PRODUCTION_COMPATIBILITY_DATE,
		compatibilityFlags: ["nodejs_compat"],
		durableObjects: {
			MIGRATIONS: {
				className: "MigrationHistoryTestDO",
				useSQLite: true,
			},
		},
	});
});

test.after(async () => {
	await runtime?.dispose();
	if (outputDirectory !== undefined) {
		await rm(outputDirectory, { recursive: true, force: true });
	}
});

async function request<T>(
	database: string,
	path: string,
	body?: unknown,
): Promise<T> {
	assert.ok(runtime, "migration-history workerd runtime is initialized");
	const response = await runtime.dispatchFetch(
		`http://migration.test${path}?database=${encodeURIComponent(database)}`,
		body === undefined
			? undefined
			: {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify(body),
				},
	);
	const text = await response.text();
	assert.equal(response.status, 200, text);
	return JSON.parse(text) as T;
}

function apply(database: string, names?: Set<string>) {
	return request<{ applied: true }>(database, "/apply", {
		names: names === undefined ? undefined : [...names],
	});
}

function execute(
	database: string,
	query: string,
	bindings?: unknown[],
): Promise<Record<string, unknown>[]> {
	return request(database, "/execute", { query, bindings });
}

function columns(database: string, table: string) {
	return request<string[]>(database, "/columns", { table });
}

const DEPLOYED_MAIN_MIGRATIONS = new Set([
	"1_initial_setup",
	"2_add_email_threading",
	"3_add_draft_folder",
	"4_add_message_id",
	"5_add_raw_headers",
	"6_mark_sent_emails_as_read",
	"7_add_cc_bcc",
	"8_add_folder_date_indexes",
	"9_add_push_subscriptions",
	"10_add_inbound_delivery_ledgers",
	"11_add_external_email_bodies",
	"12_add_r2_deletion_outbox",
	"13_add_attachment_object_key",
]);

test("exact deployed-main history upgrades without collisions or data loss", async () => {
	const database = "deployed-main";
	await apply(database, DEPLOYED_MAIN_MIGRATIONS);
	assert.equal((await execute(database, "PRAGMA foreign_keys"))[0]?.foreign_keys, 1);
	await execute(database, `
		INSERT INTO emails (id, folder_id, subject, sender, recipient, date, body)
		VALUES ('email-1', 'inbox', 'Subject', 'sender@example.com',
			'team@example.com', '2026-07-16T00:00:00.000Z', 'Body');
		INSERT INTO attachments (
			id, email_id, filename, mimetype, size, content_id, disposition, r2_key
		) VALUES (
			'attachment-1', 'email-1', 'file.pdf', 'application/pdf', 3,
			NULL, 'attachment', 'attachments/email-1/attachment-1/file.pdf'
		);
		INSERT INTO inbound_terminal_failures (
			id, queue_message_id, attempts, error_code, recorded_at
		) VALUES (
			'email-terminal', 'provider-queue-message-id', 11,
			'QUEUE_RETRY_EXHAUSTED', '2026-07-16T00:00:00.000Z'
		);
		INSERT INTO email_body_objects (
			id, email_id, part_index, content_type, charset, r2_key, byte_length
		) VALUES (
			'body-1', 'email-1', 0, 'text/plain', 'utf-8',
			'email-bodies/email-1/0.body', 4
		);
		INSERT INTO r2_deletion_outbox (
			r2_key, email_id, attempts, next_attempt_at, last_error, created_at
		) VALUES (
			'orphan/key', 'email-1', 2, '2026-07-16T00:00:00.000Z',
			'legacy-error', '2026-07-15T00:00:00.000Z'
		);
	`);

	await apply(database);
	await apply(database);

	assert.equal(
		(await execute(database, "SELECT r2_key FROM attachments WHERE id = 'attachment-1'"))[0]?.r2_key,
		"attachments/email-1/attachment-1/file.pdf",
	);
	assert.deepEqual(
		(await execute(database, `
			SELECT attempts, state, claim_generation, lease_token, lease_expires_at,
				next_attempt_at, last_error, parked_at, recovery_ref
			FROM r2_deletion_outbox WHERE r2_key = 'orphan/key'
		`))[0],
		{
			attempts: 2,
			state: "pending",
			claim_generation: 0,
			lease_token: null,
			lease_expires_at: null,
			next_attempt_at: "2026-07-16T00:00:00.000Z",
			last_error: "legacy-error",
			parked_at: null,
			recovery_ref: null,
		},
	);
	const terminal = (await execute(database, `
		SELECT queue_ref, attempts, error_code, recorded_at
		FROM inbound_terminal_failures WHERE id = 'email-terminal'
	`))[0] as { queue_ref: string; attempts: number };
	assert.match(terminal.queue_ref, /^[0-9a-f]{16}$/);
	assert.equal(terminal.attempts, 11);
	assert.equal(
		(await columns(database, "inbound_terminal_failures")).includes("queue_message_id"),
		false,
	);
	assert.equal(
		(await execute(database, "SELECT COUNT(*) AS count FROM email_body_objects WHERE id = 'body-1'"))[0]?.count,
		1,
	);
	for (const name of [
		"10_add_inbound_delivery_ledgers",
		"11_add_external_email_bodies",
		"12_add_r2_deletion_outbox",
		"13_add_attachment_object_key",
		"36_add_inbound_durability",
		"37_harden_outbound_reliability",
		"38_reconcile_deployed_inbound_durability",
		"39_complete_outbound_reliability",
		"40_add_cleanup_parking",
		"41_add_exact_import_source_identity",
	]) {
		assert.equal(
			(await execute(database, "SELECT COUNT(*) AS count FROM d1_migrations WHERE name = ?", [name]))[0]?.count,
			1,
		);
	}
});

test("fresh migration history converges to the same final contracts", async () => {
	const database = "fresh";
	await apply(database);
	assert.equal((await execute(database, "PRAGMA foreign_keys"))[0]?.foreign_keys, 1);
	assert.equal((await columns(database, "r2_deletion_outbox")).includes("parked_at"), true);
	assert.equal((await columns(database, "outbound_provider_events")).includes("recipient_hashes_json"), true);
	assert.equal((await columns(database, "draft_save_cleanup_intents")).includes("state"), true);
	assert.equal((await columns(database, "outbound_acceptance_recovery")).includes("generation"), true);
	assert.deepEqual(
		await columns(database, "import_source_identities"),
		["email_id", "raw_sha256", "created_at"],
	);
	for (const column of ["legacy_id", "identity_source", "raw_sha256"]) {
		assert.equal(
			(await columns(database, "import_generation_claims")).includes(column),
			true,
		);
	}
	await execute(database, `
		INSERT INTO import_source_identities (email_id, raw_sha256, created_at)
		VALUES ('retained-source', '${"a".repeat(64)}', 1);
		INSERT INTO emails (id, folder_id, subject, sender, recipient, date, body)
		VALUES ('retained-source', 'inbox', 'Subject', 'sender@example.com',
			'team@example.com', '2026-07-17T00:00:00.000Z', 'Body');
		DELETE FROM emails WHERE id = 'retained-source';
	`);
	assert.equal(
		(await execute(database, "SELECT raw_sha256 FROM import_source_identities WHERE email_id = 'retained-source'"))[0]?.raw_sha256,
		"a".repeat(64),
	);
	await apply(database);
});

test("branch-local databases already through committed migration 37 upgrade safely", async () => {
	const database = "branch-local-through-37";
	const deployedNames = new Set([
		"10_add_inbound_delivery_ledgers",
		"11_add_external_email_bodies",
		"12_add_r2_deletion_outbox",
		"13_add_attachment_object_key",
	]);
	const through37 = new Set(
		mailboxMigrations
			.slice(0, mailboxMigrations.findIndex((migration) =>
				migration.name === "37_harden_outbound_reliability") + 1)
			.map((migration) => migration.name)
			.filter((name) => !deployedNames.has(name)),
	);
	await apply(database, through37);
	assert.equal((await execute(database, "PRAGMA foreign_keys"))[0]?.foreign_keys, 1);
	assert.equal(await hasMigration(database, "36_add_inbound_durability"), true);
	assert.equal(await hasMigration(database, "37_harden_outbound_reliability"), true);

	await apply(database);
	assert.equal(await hasMigration(database, "10_add_inbound_delivery_ledgers"), true);
	assert.equal(await hasMigration(database, "38_reconcile_deployed_inbound_durability"), true);
	assert.equal((await columns(database, "outbound_acceptance_recovery")).includes("generation"), true);
	assert.equal((await columns(database, "r2_deletion_outbox")).includes("recovery_ref"), true);
	assert.equal(await hasMigration(database, "41_add_exact_import_source_identity"), true);
});

async function hasMigration(database: string, name: string): Promise<boolean> {
	return (await execute(
		database,
		"SELECT COUNT(*) AS count FROM d1_migrations WHERE name = ?",
		[name],
	))[0]?.count === 1;
}
