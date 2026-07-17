import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
	WISER_INITIAL_SHARED_MEMBERS,
	WISER_ROLE_ADDRESSES,
	buildTransitionApplySql,
	classifyTransitionState,
	parseTransitionArguments,
	runTransition,
} from "./transition-wiser-shared-mailboxes.mjs";

const READY_STATE = Object.freeze({
	legacy_role_users: 2,
	active_legacy_role_users: 2,
	retired_role_users: 0,
	personal_role_mailboxes: 2,
	shared_role_mailboxes: 0,
	active_selected_members: 2,
	selected_personal_mailboxes: 2,
	role_mailbox_memberships: 0,
	expected_role_memberships: 0,
	active_role_recovery_tokens: 0,
	unsafe_role_recovery_deliveries: 0,
	outstanding_role_revocations: 0,
});

const APPLIED_STATE = Object.freeze({
	legacy_role_users: 2,
	active_legacy_role_users: 0,
	retired_role_users: 2,
	personal_role_mailboxes: 0,
	shared_role_mailboxes: 2,
	active_selected_members: 2,
	selected_personal_mailboxes: 2,
	role_mailbox_memberships: 4,
	expected_role_memberships: 4,
	active_role_recovery_tokens: 0,
	unsafe_role_recovery_deliveries: 0,
	outstanding_role_revocations: 0,
});

const COMMITTED_CLEANUP_PENDING_STATE = Object.freeze({
	...APPLIED_STATE,
	outstanding_role_revocations: 2,
});

function d1Result(row = {}) {
	return { result: [{ results: [row], success: true }], diagnostics: "" };
}

function memoryLogger() {
	const progressLines = [];
	const detailLines = [];
	return {
		logFilePath: "/private/test-transition.log",
		progressLines,
		detailLines,
		async progress(message) {
			progressLines.push(message);
		},
		async detail(message) {
			detailLines.push(message);
		},
	};
}

function migratedDatabase() {
	const database = new DatabaseSync(":memory:");
	database.exec("PRAGMA foreign_keys = ON");
	const migrationsDirectory = resolve(
		dirname(fileURLToPath(import.meta.url)),
		"../migrations",
	);
	for (const filename of readdirSync(migrationsDirectory).sort()) {
		database.exec(readFileSync(resolve(migrationsDirectory, filename), "utf8"));
	}
	return database;
}

function seedLegacyWiserAccounts(database) {
	database.exec(`
		INSERT INTO users (
			id, email, password_hash, password_salt, role, is_active,
			mailbox_address, mcp_token_hash, created_at, updated_at,
			session_version, recovery_email, ownership_confirmed_at
		) VALUES
			('usr_hello', 'hello@wiserchat.ai', 'hello-hash', 'hello-salt',
			 'AGENT', 1, 'hello@wiserchat.ai', 'hello-mcp', 1, 1, 3, NULL, 1),
			('usr_contact', 'contact@wiserchat.ai', 'contact-hash', 'contact-salt',
			 'AGENT', 1, 'contact@wiserchat.ai', 'contact-mcp', 1, 1, 5, NULL, 1),
			('usr_hesham', 'hesham@wiserchat.ai', 'hesham-hash', 'hesham-salt',
			 'ADMIN', 1, 'hesham@wiserchat.ai', NULL, 1, 1, 7, NULL, 1),
			('usr_ibrahem', 'ibrahem@wiserchat.ai', 'ibrahem-hash', 'ibrahem-salt',
			 'AGENT', 1, 'ibrahem@wiserchat.ai', NULL, 1, 1, 2, NULL, 1);

		INSERT INTO mailboxes (
			id, address, type, owner_user_id, is_active, created_at, updated_at
		) VALUES
			('hello@wiserchat.ai', 'hello@wiserchat.ai', 'PERSONAL', 'usr_hello', 1, 1, 1),
			('contact@wiserchat.ai', 'contact@wiserchat.ai', 'PERSONAL', 'usr_contact', 1, 1, 1),
			('hesham@wiserchat.ai', 'hesham@wiserchat.ai', 'PERSONAL', 'usr_hesham', 1, 1, 1),
			('ibrahem@wiserchat.ai', 'ibrahem@wiserchat.ai', 'PERSONAL', 'usr_ibrahem', 1, 1, 1),
			('other@wiserchat.ai', 'other@wiserchat.ai', 'SHARED', NULL, 1, 1, 1);

		INSERT INTO mailbox_memberships (mailbox_id, user_id, created_at)
		VALUES ('other@wiserchat.ai', 'usr_hello', 1);

		INSERT INTO credential_recovery_audit (
			id, user_id, event_type, actor_user_id, created_at
		) VALUES
			('audit_hello_setup', 'usr_hello', 'setup_issued', 'usr_hesham', 1),
			('audit_contact_setup', 'usr_contact', 'setup_issued', 'usr_hesham', 1);

		INSERT INTO saved_views (
			id, owner_user_id, mailbox_address, name, filter_json,
			sort_column, sort_direction, created_at, updated_at
		) VALUES (
			'view_hello', 'usr_hello', 'other@wiserchat.ai', 'Preserve me', '{}',
			'date', 'DESC', 1, 1
		);
	`);
}

function sqliteWrangler(database) {
	return async (sql) => {
		if (/^\s*SELECT\b/i.test(sql)) {
			return d1Result(database.prepare(sql).get());
		}
		try {
			database.exec(`BEGIN IMMEDIATE;\n${sql}\nCOMMIT;`);
		} catch (error) {
			try {
				database.exec("ROLLBACK");
			} catch {
				// The failing statement may already have ended the transaction.
			}
			throw error;
		}
		return { result: [{ results: [], success: true }], diagnostics: "" };
	};
}

test("transition target is the exact verified Wiser role and human roster", () => {
	assert.deepEqual(WISER_ROLE_ADDRESSES, [
		"hello@wiserchat.ai",
		"contact@wiserchat.ai",
	]);
	assert.deepEqual(WISER_INITIAL_SHARED_MEMBERS, [
		"hesham@wiserchat.ai",
		"ibrahem@wiserchat.ai",
	]);
});

test("apply mode requires an exact typed confirmation", () => {
	assert.deepEqual(parseTransitionArguments([]), { apply: false });
	assert.deepEqual(
		parseTransitionArguments([
			"--apply",
			"--confirm",
			"transition-wiser-role-mailboxes",
		]),
		{ apply: true },
	);
	for (const invalid of [
		["--apply"],
		["--apply", "--confirm", "yes"],
		["--confirm", "transition-wiser-role-mailboxes"],
	]) {
		assert.throws(() => parseTransitionArguments(invalid), /read-only preflight/i);
	}
});

test("transition state classifier fails closed on partial or widened membership", () => {
	assert.equal(classifyTransitionState(READY_STATE).kind, "ready");
	assert.equal(classifyTransitionState(APPLIED_STATE).kind, "applied");
	assert.equal(
		classifyTransitionState({
			...READY_STATE,
			shared_role_mailboxes: 1,
		}).kind,
		"blocked",
	);
	assert.equal(
		classifyTransitionState({
			...APPLIED_STATE,
			role_mailbox_memberships: 5,
		}).kind,
		"blocked",
	);
	assert.throws(
		() =>
			classifyTransitionState({
				...READY_STATE,
				legacy_role_users: "2",
			}),
		/invalid legacy_role_users count/,
	);
});

test("guarded SQL tombstones role logins and verifies exact Shared membership atomically", () => {
	const sql = buildTransitionApplySql();
	assert.match(sql, /CREATE TRIGGER _wiser_shared_mailbox_transition_abort/);
	assert.match(sql, /RAISE\(ABORT, 'Wiser Shared Mailbox transition state changed/);
	assert.match(
		sql,
		/UPDATE users[\s\S]*is_active = 0[\s\S]*session_version = session_version \+ 1/,
	);
	assert.match(sql, /INSERT INTO credential_recovery_audit/);
	assert.match(sql, /UPDATE mailboxes[\s\S]*type = 'SHARED'[\s\S]*owner_user_id = NULL/);
	assert.doesNotMatch(sql, /DELETE FROM users/);
	assert.match(sql, /INSERT INTO mailbox_memberships/);
	assert.match(sql, /hesham@wiserchat\.ai/);
	assert.match(sql, /ibrahem@wiserchat\.ai/);
	assert.match(
		sql,
		/SELECT COUNT\(\*\) FROM mailbox_memberships AS mm[\s\S]*WHERE m\.address IN \([\s\S]*\)\) = 4/,
	);
	assert.match(sql, /DROP TABLE _wiser_shared_mailbox_transition_guard/);
});

test("read-only preflight never submits the mutation batch", async () => {
	const logger = memoryLogger();
	const commands = [];
	const result = await runTransition({
		argv: [],
		logger,
		async runWrangler(command) {
			commands.push(command);
			return d1Result(READY_STATE);
		},
	});
	assert.deepEqual(result, { kind: "ready", wrote: false });
	assert.equal(commands.length, 1);
	assert.doesNotMatch(commands[0], /UPDATE users/);
	assert.match(logger.progressLines.at(-1), /^READY /);
});

test("apply executes one guarded mutation and reports durable cleanup ownership", async () => {
	const logger = memoryLogger();
	const commands = [];
	const responses = [
		d1Result(READY_STATE),
		{ result: [{ results: [], success: true }], diagnostics: "" },
		d1Result(COMMITTED_CLEANUP_PENDING_STATE),
	];
	const result = await runTransition({
		argv: [
			"--apply",
			"--confirm",
			"transition-wiser-role-mailboxes",
		],
		logger,
		async runWrangler(command) {
			commands.push(command);
			return responses.shift();
		},
	});
	assert.deepEqual(result, {
		kind: "committed_cleanup_pending",
		wrote: true,
	});
	assert.equal(commands.length, 3);
	assert.match(commands[1], /UPDATE users/);
	assert.doesNotMatch(commands[1], /DELETE FROM users/);
	assert.match(logger.progressLines.at(-1), /^COMMITTED cleanup pending/);
});

test("partial production state blocks before every mutation", async () => {
	const logger = memoryLogger();
	let calls = 0;
	await assert.rejects(
		runTransition({
			argv: [
				"--apply",
				"--confirm",
				"transition-wiser-role-mailboxes",
			],
			logger,
			async runWrangler() {
				calls += 1;
				return d1Result({
					...READY_STATE,
					legacy_role_users: 1,
				});
			},
		}),
		/neither the exact verified legacy state nor the exact completed state/,
	);
	assert.equal(calls, 1);
});

test("migration-backed transition tombstones role accounts without deleting audit or unrelated data", async () => {
	const database = migratedDatabase();
	seedLegacyWiserAccounts(database);
	const result = await runTransition({
		argv: [
			"--apply",
			"--confirm",
			"transition-wiser-role-mailboxes",
		],
		logger: memoryLogger(),
		runWrangler: sqliteWrangler(database),
	});

	assert.deepEqual(result, {
		kind: "committed_cleanup_pending",
		wrote: true,
	});
	assert.deepEqual(
		database
			.prepare(
				`SELECT email, is_active, mcp_token_hash, session_version
				 FROM users
				 WHERE email IN ('hello@wiserchat.ai', 'contact@wiserchat.ai')
				 ORDER BY email`,
			)
			.all()
			.map((row) => ({ ...row })),
		[
			{
				email: "contact@wiserchat.ai",
				is_active: 0,
				mcp_token_hash: null,
				session_version: 6,
			},
			{
				email: "hello@wiserchat.ai",
				is_active: 0,
				mcp_token_hash: null,
				session_version: 4,
			},
		],
	);
	assert.equal(
		database
			.prepare("SELECT COUNT(*) AS count FROM credential_recovery_audit")
			.get().count,
		4,
	);
	assert.equal(
		database
			.prepare("SELECT COUNT(*) AS count FROM saved_views WHERE id = 'view_hello'")
			.get().count,
		1,
	);
	assert.equal(
		database
			.prepare(
				`SELECT COUNT(*) AS count FROM mailbox_memberships
				 WHERE mailbox_id = 'other@wiserchat.ai' AND user_id = 'usr_hello'`,
			)
			.get().count,
		1,
	);
	assert.deepEqual(
		database
			.prepare(
				`SELECT address, type, owner_user_id, is_active
				 FROM mailboxes
				 WHERE address IN ('hello@wiserchat.ai', 'contact@wiserchat.ai')
				 ORDER BY address`,
			)
			.all()
			.map((row) => ({ ...row })),
		[
			{
				address: "contact@wiserchat.ai",
				type: "SHARED",
				owner_user_id: null,
				is_active: 1,
			},
			{
				address: "hello@wiserchat.ai",
				type: "SHARED",
				owner_user_id: null,
				is_active: 1,
			},
		],
	);
	database.close();
});

test("migration-backed transition consumes recovery grants and cancels unsent delivery", async () => {
	const database = migratedDatabase();
	seedLegacyWiserAccounts(database);
	database.exec(`
		INSERT INTO credential_recovery_tokens (
			id, user_id, token_hash, expires_at, consumed_at, consumption_nonce,
			purpose, issued_by, created_at
		) VALUES (
			'token_hello', 'usr_hello', 'token-hash', 999999, NULL, NULL,
			'recovery', 'usr_hesham', 1
		);
		INSERT INTO credential_recovery_delivery_outbox (
			id, token_id, payload_key_version, payload_iv, payload_ciphertext,
			state, attempt_count, next_attempt_at, lease_token, lease_expires_at,
			dispatch_started_at, provider_message_id, accepted_attempt_id,
			provider_event_status, provider_event_at, last_error_code,
			ambiguous_dispatch_count, last_ambiguity_at, cancellation_reason,
			cancellation_observed_at, accepted_at, completed_at, created_at, updated_at
		) VALUES (
			'delivery_hello', 'token_hello', 1, '1234567890abcdef',
			'123456789012345678901234', 'pending', 0, 1, NULL, NULL, NULL,
			NULL, NULL, NULL, NULL, NULL, 0, NULL, NULL, NULL, NULL, NULL, 1, 1
		);
	`);

	const result = await runTransition({
		argv: [
			"--apply",
			"--confirm",
			"transition-wiser-role-mailboxes",
		],
		logger: memoryLogger(),
		runWrangler: sqliteWrangler(database),
	});
	assert.equal(result.kind, "committed_cleanup_pending");
	assert.notEqual(
		database
			.prepare(
				"SELECT consumed_at FROM credential_recovery_tokens WHERE id = 'token_hello'",
			)
			.get().consumed_at,
		null,
	);
	const delivery = database
		.prepare(
			`SELECT state, payload_ciphertext, cancellation_reason,
			        cancellation_observed_at, completed_at
			 FROM credential_recovery_delivery_outbox
			 WHERE id = 'delivery_hello'`,
		)
		.get();
	assert.equal(delivery.state, "cancelled");
	assert.equal(delivery.payload_ciphertext, null);
	assert.equal(delivery.cancellation_reason, "ACCOUNT_DEACTIVATED");
	assert.equal(Number.isSafeInteger(delivery.cancellation_observed_at), true);
	assert.equal(delivery.completed_at, delivery.cancellation_observed_at);
	database.close();
});

test("migration-backed preflight rejects a noncanonical role Mailbox identity", async () => {
	const database = migratedDatabase();
	seedLegacyWiserAccounts(database);
	database
		.prepare(
			"UPDATE mailboxes SET id = 'legacy-hello-id' WHERE id = 'hello@wiserchat.ai'",
		)
		.run();

	await assert.rejects(
		() =>
			runTransition({
				argv: [
					"--apply",
					"--confirm",
					"transition-wiser-role-mailboxes",
				],
				logger: memoryLogger(),
				runWrangler: sqliteWrangler(database),
			}),
		/neither the exact verified legacy state nor the exact completed state/,
	);
	assert.equal(
		database
			.prepare("SELECT is_active FROM users WHERE id = 'usr_hello'")
			.get().is_active,
		1,
	);
	assert.equal(
		database
			.prepare(
				"SELECT type FROM mailboxes WHERE address = 'hello@wiserchat.ai'",
			)
			.get().type,
		"PERSONAL",
	);
	database.close();
});

test("guarded migration-backed batch rolls back every write when final state drifts", async () => {
	const database = migratedDatabase();
	seedLegacyWiserAccounts(database);
	database.exec(`
		CREATE TRIGGER simulate_member_drift
		AFTER UPDATE OF is_active ON users
		WHEN NEW.id = 'usr_hello' AND NEW.is_active = 0
		BEGIN
			UPDATE users SET is_active = 0 WHERE id = 'usr_ibrahem';
		END;
	`);

	await assert.rejects(
		() =>
			runTransition({
				argv: [
					"--apply",
					"--confirm",
					"transition-wiser-role-mailboxes",
				],
				logger: memoryLogger(),
				runWrangler: sqliteWrangler(database),
			}),
		/Wiser Shared Mailbox transition state changed or is incomplete/,
	);
	assert.deepEqual(
		{
			...database
				.prepare(
					`SELECT
					   (SELECT COUNT(*) FROM users
					    WHERE id IN ('usr_hello', 'usr_contact', 'usr_ibrahem')
					      AND is_active = 1) AS active_users,
					   (SELECT COUNT(*) FROM mailboxes
					    WHERE address IN ('hello@wiserchat.ai', 'contact@wiserchat.ai')
					      AND type = 'PERSONAL') AS personal_mailboxes,
					   (SELECT COUNT(*) FROM credential_recovery_audit) AS audits,
					   (SELECT COUNT(*) FROM agent_connection_revocations) AS revocations,
					   (SELECT COUNT(*) FROM sqlite_master
					    WHERE name = '_wiser_shared_mailbox_transition_guard') AS guard_objects`,
				)
				.get(),
		},
		{
			active_users: 3,
			personal_mailboxes: 2,
			audits: 2,
			revocations: 0,
			guard_objects: 0,
		},
	);
	database.close();
});

test("rerun after a lost apply response recognizes the committed tombstone state", async () => {
	const database = migratedDatabase();
	seedLegacyWiserAccounts(database);
	const execute = sqliteWrangler(database);
	let loseApplyResponse = true;
	const runWrangler = async (sql) => {
		const output = await execute(sql);
		if (loseApplyResponse && !/^\s*SELECT\b/i.test(sql)) {
			loseApplyResponse = false;
			throw new Error("simulated response loss");
		}
		return output;
	};

	await assert.rejects(
		() =>
			runTransition({
				argv: [
					"--apply",
					"--confirm",
					"transition-wiser-role-mailboxes",
				],
				logger: memoryLogger(),
				runWrangler,
			}),
		/simulated response loss/,
	);
	const rerun = await runTransition({
		argv: [
			"--apply",
			"--confirm",
			"transition-wiser-role-mailboxes",
		],
		logger: memoryLogger(),
		runWrangler,
	});
	assert.deepEqual(rerun, {
		kind: "committed_cleanup_pending",
		wrote: false,
	});
	assert.equal(
		database
			.prepare(
				`SELECT COUNT(*) AS count
				 FROM credential_recovery_audit
				 WHERE event_type = 'account_deactivated'`,
			)
			.get().count,
		2,
	);
	database.close();
});

test("preflight reports PASS only after every durable Agent revocation is drained", async () => {
	const database = migratedDatabase();
	seedLegacyWiserAccounts(database);
	const runWrangler = sqliteWrangler(database);
	const committed = await runTransition({
		argv: [
			"--apply",
			"--confirm",
			"transition-wiser-role-mailboxes",
		],
		logger: memoryLogger(),
		runWrangler,
	});
	assert.equal(committed.kind, "committed_cleanup_pending");

	database.exec("DELETE FROM agent_connection_revocations");
	const logger = memoryLogger();
	const completed = await runTransition({
		argv: [],
		logger,
		runWrangler,
	});
	assert.deepEqual(completed, { kind: "applied", wrote: false });
	assert.match(logger.progressLines.at(-1), /^PASS /);
	database.close();
});
