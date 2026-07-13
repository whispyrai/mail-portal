import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { mailboxMigrations } from "./migrations.ts";

function migrateThrough26(database: DatabaseSync) {
	database.exec("PRAGMA foreign_keys = ON");
	for (const migration of mailboxMigrations) {
		if (migration.name === "27_add_semantic_message_projection") break;
		database.exec(migration.sql);
	}
}

function migrateThrough27(database: DatabaseSync) {
	migrateThrough26(database);
	const migration = mailboxMigrations.find(
		(candidate) => candidate.name === "27_add_semantic_message_projection",
	);
	assert.ok(migration);
	database.exec(migration.sql);
}

test("migration 27 installs a rebuildable FTS5 projection and opaque vector outbox", () => {
	const database = new DatabaseSync(":memory:");
	migrateThrough26(database);
	const migration = mailboxMigrations.find(
		(candidate) => candidate.name === "27_add_semantic_message_projection",
	);
	assert.ok(migration);
	database.exec(migration.sql);

	const tables = database.prepare(`
		SELECT name FROM sqlite_master
		WHERE type = 'table' AND name LIKE 'semantic_%'
		ORDER BY name
	`).all().map((row) => row.name);
	assert.deepEqual(tables.filter((name) => !String(name).startsWith("semantic_chunks_fts_")), [
		"semantic_chunks",
		"semantic_chunks_fts",
		"semantic_index_jobs",
		"semantic_message_versions",
		"semantic_projection_state",
		"semantic_sources",
	]);

	database.prepare(`
		INSERT INTO emails(id, folder_id, subject, sender, recipient, date, body)
		VALUES (?, 'inbox', 'Keys', 'sam@example.com', 'team@example.com', ?, ?)
	`).run("message-1", "2026-07-13T08:00:00.000Z", "Office keys arrive Tuesday");
	database.prepare(`
		INSERT INTO semantic_sources(
			source_id, message_id, source_fingerprint, source_sequence,
			folder_id, created_at, updated_at
		) VALUES (?, ?, ?, 1, 'inbox', ?, ?)
	`).run("0123456789abcdef0123456789abcdef", "message-1", "fingerprint", "now", "now");
	database.prepare(`
		INSERT INTO semantic_chunks(
			vector_id, source_id, message_id, source_fingerprint, ordinal, content, created_at
		) VALUES (?, ?, ?, ?, 0, ?, ?)
	`).run(
		"sm1_0123456789abcdef0123456789abcdef_00",
		"0123456789abcdef0123456789abcdef",
		"message-1",
		"fingerprint",
		"Office keys arrive Tuesday",
		"now",
	);
	assert.equal(
		database.prepare("SELECT operation FROM semantic_index_jobs").get()?.operation,
		"upsert",
	);
	assert.equal(
		database.prepare("SELECT COUNT(*) AS total FROM semantic_chunks_fts WHERE semantic_chunks_fts MATCH 'Tuesday'").get()?.total,
		1,
	);

	database.prepare("UPDATE emails SET folder_id = 'trash' WHERE id = ?").run("message-1");
	assert.equal(database.prepare("SELECT COUNT(*) AS total FROM semantic_sources").get()?.total, 0);
	assert.equal(database.prepare("SELECT COUNT(*) AS total FROM semantic_chunks").get()?.total, 0);
	assert.equal(database.prepare("SELECT COUNT(*) AS total FROM semantic_chunks_fts").get()?.total, 0);
	assert.equal(
		database.prepare("SELECT operation FROM semantic_index_jobs").get()?.operation,
		"delete",
	);
	database.close();
});

test("migration 27 has no constraint dependency on existing Message rows", () => {
	const database = new DatabaseSync(":memory:");
	migrateThrough26(database);
	database.prepare(`
		INSERT INTO emails(id, folder_id, subject, sender, recipient, date, body)
		VALUES (?, 'inbox', 'Existing', 'sender@example.com', 'team@example.com', ?, '')
	`).run("existing-message", "2026-07-13T07:00:00.000Z");
	const before = Number(database.prepare("SELECT COUNT(*) AS total FROM emails").get()?.total);
	const migration = mailboxMigrations.find(
		(candidate) => candidate.name === "27_add_semantic_message_projection",
	);
	assert.ok(migration);
	database.exec(migration.sql);
	assert.equal(database.prepare("SELECT COUNT(*) AS total FROM emails").get()?.total, before);
	assert.equal(database.prepare("SELECT COUNT(*) AS total FROM semantic_sources").get()?.total, 0);
	database.close();
});

test("migration 28 preserves Message vectors and jobs while installing exact attachment authority", () => {
	const database = new DatabaseSync(":memory:");
	migrateThrough27(database);
	database.prepare(`
		INSERT INTO emails(id, folder_id, subject, sender, recipient, date, body)
		VALUES (?, 'inbox', 'Existing', 'sender@example.com', 'team@example.com', ?, ?)
	`).run("message-1", "2026-07-13T07:00:00.000Z", "Existing evidence");
	database.prepare(`
		INSERT INTO attachments(id, email_id, filename, mimetype, size, disposition)
		VALUES ('attachment-1', 'message-1', 'notes.md', 'text/markdown', 12, 'attachment')
	`).run();
	database.prepare(`
		INSERT INTO semantic_sources(
			source_id, message_id, source_fingerprint, source_sequence,
			folder_id, created_at, updated_at
		) VALUES (?, ?, ?, 1, 'inbox', ?, ?)
	`).run("0123456789abcdef0123456789abcdef", "message-1", "fingerprint", "now", "now");
	const vectorId = "sm1_0123456789abcdef0123456789abcdef_00";
	database.prepare(`
		INSERT INTO semantic_chunks(
			vector_id, source_id, message_id, source_fingerprint, ordinal, content, created_at
		) VALUES (?, ?, ?, ?, 0, ?, ?)
	`).run(
		vectorId,
		"0123456789abcdef0123456789abcdef",
		"message-1",
		"fingerprint",
		"Existing evidence",
		"now",
	);
	database.prepare(`
		UPDATE semantic_index_jobs SET state = 'submitted', attempt_count = 2,
		 submitted_at = 100, mutation_id = 'mutation', next_attempt_at = 200,
		 updated_at = 'submitted' WHERE vector_id = ?
	`).run(vectorId);
	const migration = mailboxMigrations.find(
		(candidate) => candidate.name === "28_add_semantic_attachment_evidence",
	);
	assert.ok(migration);
	database.exec(migration.sql);

	assert.deepEqual({ ...database.prepare(`
		SELECT source_id AS sourceId, source_type AS sourceType, message_id AS messageId,
		 attachment_id AS attachmentId, source_fingerprint AS fingerprint
		FROM semantic_sources
	`).get() }, {
		sourceId: "0123456789abcdef0123456789abcdef",
		sourceType: "message",
		messageId: "message-1",
		attachmentId: null,
		fingerprint: "fingerprint",
	});
	assert.deepEqual({ ...database.prepare(`
		SELECT vector_id AS vectorId, content, excerpt FROM semantic_chunks
	`).get() }, { vectorId, content: "Existing evidence", excerpt: "Existing evidence" });
	assert.deepEqual({ ...database.prepare(`
		SELECT operation, state, attempt_count AS attemptCount, submitted_at AS submittedAt,
		 mutation_id AS mutationId, next_attempt_at AS nextAttemptAt, updated_at AS updatedAt
		FROM semantic_index_jobs WHERE vector_id = ?
	`).get(vectorId) }, {
		operation: "upsert",
		state: "submitted",
		attemptCount: 2,
		submittedAt: 100,
		mutationId: "mutation",
		nextAttemptAt: 200,
		updatedAt: "submitted",
	});
	assert.equal(database.prepare(
		"SELECT COUNT(*) AS total FROM semantic_chunks_fts WHERE semantic_chunks_fts MATCH 'Existing'",
	).get()?.total, 1);
	assert.equal(database.prepare(
		"SELECT version FROM semantic_attachment_versions WHERE attachment_id = 'attachment-1'",
	).get()?.version, 1);
	assert.deepEqual(database.prepare("PRAGMA foreign_key_check").all(), []);

	assert.throws(() => database.prepare(`
		INSERT INTO semantic_sources(
		 source_id, source_type, message_id, attachment_id, attachment_filename,
		 extraction_version, attachment_policy_version, attachment_chunk_version,
		 source_fingerprint, source_sequence, folder_id, created_at, updated_at
		) VALUES ('11111111111111111111111111111111', 'attachment', 'wrong-message',
		 'attachment-1', 'notes.md', 1, 1, 1, 'fingerprint-2', 1, 'inbox', 'now', 'now')
	`).run(), /ownership mismatch|FOREIGN KEY/);
	database.prepare(`
		INSERT INTO semantic_sources(
		 source_id, source_type, message_id, attachment_id, attachment_filename,
		 extraction_version, attachment_policy_version, attachment_chunk_version,
		 source_fingerprint, source_sequence, folder_id, created_at, updated_at
		) VALUES ('22222222222222222222222222222222', 'attachment', 'message-1',
		 'attachment-1', 'notes.md', 1, 1, 1, 'fingerprint-2', 1, 'inbox', 'now', 'now')
	`).run();
	assert.equal(database.prepare(
		"SELECT COUNT(*) AS total FROM semantic_sources WHERE message_id = 'message-1'",
	).get()?.total, 2);
	assert.throws(() => database.prepare(
		"UPDATE semantic_chunks SET message_id = 'wrong-message' WHERE vector_id = ?",
	).run(vectorId), /immutable/);
	assert.throws(() => database.prepare(
		"UPDATE semantic_sources SET message_id = 'wrong-message' WHERE source_id = ?",
	).run("0123456789abcdef0123456789abcdef"), /immutable/);
	database.prepare(`
		INSERT INTO emails(id, folder_id, subject, sender, recipient, date, body)
		VALUES ('message-2', 'inbox', '', '', '', '', '')
	`).run();
	database.prepare(`
		INSERT INTO attachments(id, email_id, filename, mimetype, size, disposition)
		VALUES ('attachment-2', 'message-2', 'other.txt', 'text/plain', 5, 'attachment')
	`).run();
	assert.throws(() => database.prepare(`
		UPDATE semantic_attachment_versions SET message_id = 'message-1'
		WHERE attachment_id = 'attachment-2'
	`).run(), /ownership mismatch/);
	assert.throws(() => database.prepare(`
		INSERT INTO semantic_attachment_extractions(
		 attachment_id, message_id, attachment_version, filename, mimetype,
		 declared_size, state, next_attempt_at, created_at, updated_at
		) VALUES ('attachment-1', 'message-2', 1, 'notes.md', 'text/markdown',
		 12, 'pending', 0, 'now', 'now')
	`).run(), /ownership mismatch/);
	database.prepare("UPDATE attachments SET filename = 'renamed.md' WHERE id = 'attachment-1'").run();
	assert.equal(database.prepare(
		"SELECT COUNT(*) AS total FROM semantic_sources WHERE source_type = 'attachment'",
	).get()?.total, 0);
	assert.equal(database.prepare(
		"SELECT version FROM semantic_attachment_versions WHERE attachment_id = 'attachment-1'",
	).get()?.version, 2);
	database.close();
});
