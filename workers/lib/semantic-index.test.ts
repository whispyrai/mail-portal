import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { mailboxMigrations } from "../durableObject/migrations.ts";
import { applySqliteMigrations } from "../testing/sqlite-migrations.test.ts";
import { createSemanticIndex } from "./semantic-index.ts";

function setup() {
	const database = new DatabaseSync(":memory:");
	database.exec("PRAGMA foreign_keys = ON");
	applySqliteMigrations(database, mailboxMigrations);
	let nextId = 0;
	const store = {
		sql: {
			exec(query: string, ...bindings: Array<ArrayBuffer | string | number | null>) {
				return database.prepare(query).all(...bindings);
			},
		},
		transactionSync<T>(operation: () => T): T {
			database.exec("BEGIN");
			try {
				const result = operation();
				database.exec("COMMIT");
				return result;
			} catch (error) {
				database.exec("ROLLBACK");
				throw error;
			}
		},
	};
	const createIndex = () => createSemanticIndex({
		store,
		now: () => "2026-07-13T12:00:00.000Z",
		createId: () => (++nextId).toString(16).padStart(32, "0"),
	});
	return {
		database,
		index: createIndex(),
		restartIndex: createIndex,
	};
}

function insertMessage(database: DatabaseSync, id: string, folder: string, body: string) {
	database.prepare(`
		INSERT INTO emails(id, folder_id, subject, sender, recipient, date, body)
		VALUES (?, ?, ?, 'sam@example.com', 'team@example.com', ?, ?)
	`).run(id, folder, `Subject ${id}`, "2026-07-13T08:00:00.000Z", body);
}

test("semantic projection backfills only active history and creates opaque durable jobs", async () => {
	const state = setup();
	insertMessage(state.database, "active", "inbox", "Office keys arrive Tuesday");
	insertMessage(state.database, "deleted", "trash", "Private deleted evidence");
	insertMessage(state.database, "draft", "draft", "Unsent intent");
	const readiness = await state.index.prepare();
	assert.equal(readiness.state, "building");
	assert.equal(state.database.prepare("SELECT COUNT(*) AS total FROM semantic_sources").get()?.total, 1);
	const chunk = state.database.prepare("SELECT vector_id AS vectorId, content FROM semantic_chunks").get();
	assert.match(String(chunk?.vectorId), /^sm1_[a-f0-9]{32}_[a-z0-9]{2}$/);
	assert.doesNotMatch(String(chunk?.vectorId), /active/);
	assert.match(String(chunk?.content), /Office keys/);
	assert.equal(state.database.prepare("SELECT operation FROM semantic_index_jobs").get()?.operation, "upsert");
	state.database.close();
});

test("semantic source change invalidates local evidence before eventual vector deletion", async () => {
	const state = setup();
	insertMessage(state.database, "message-1", "inbox", "Original commitment");
	await state.index.prepare();
	const vectorId = String(state.database.prepare("SELECT vector_id FROM semantic_chunks").get()?.vector_id);
	state.database.prepare("UPDATE emails SET body = ? WHERE id = ?").run("Changed commitment", "message-1");
	assert.deepEqual(state.index.resolveCandidates([{ vectorId, score: 0.9 }]), []);
	assert.equal(state.database.prepare("SELECT operation FROM semantic_index_jobs WHERE vector_id = ?").get(vectorId)?.operation, "delete");
	await state.index.prepare();
	assert.match(String(state.database.prepare("SELECT content FROM semantic_chunks").get()?.content), /Changed commitment/);
	state.database.close();
});

test("read and eligible-folder changes preserve current evidence without vector churn", async () => {
	const state = setup();
	insertMessage(state.database, "message-1", "inbox", "Stable authored evidence");
	await state.index.prepare();
	const vectorId = String(state.database.prepare("SELECT vector_id FROM semantic_chunks").get()?.vector_id);
	state.database.prepare("UPDATE emails SET read = 1, starred = 1 WHERE id = ?").run("message-1");
	await state.index.prepare();
	assert.equal(state.database.prepare("SELECT vector_id FROM semantic_chunks").get()?.vector_id, vectorId);
	assert.equal(state.index.resolveCandidates([{ vectorId, score: 0.8 }]).length, 1);
	state.database.prepare("UPDATE emails SET folder_id = 'archive' WHERE id = ?").run("message-1");
	await state.index.prepare();
	assert.equal(state.database.prepare("SELECT vector_id FROM semantic_chunks").get()?.vector_id, vectorId);
	assert.equal(state.index.resolveCandidates([{ vectorId, score: 0.8 }])[0]?.folderId, "archive");
	state.database.close();
});

test("semantic job leases fence stale owners and require visibility confirmation", async () => {
	const state = setup();
	insertMessage(state.database, "message-1", "inbox", "Evidence");
	await state.index.prepare();
	const [job] = state.index.leaseJobs("lease-1", 100, 1_000);
	assert.ok(job);
	assert.equal(job.operation, "upsert");
	assert.deepEqual(state.index.submitJobs([
		{ vectorId: job.vectorId, leaseToken: "wrong" },
	], "mutation", 200), []);
	assert.deepEqual(state.index.submitJobs([
		{ vectorId: job.vectorId, leaseToken: "lease-1" },
	], "mutation", 200), [job.vectorId]);
	assert.equal(state.index.readiness().submittedJobs, 1);
	assert.deepEqual(state.index.submittedJobs(), [{
		vectorId: job.vectorId,
		operation: "upsert",
		submittedAt: 200,
	}]);
	state.index.confirmVisibility([{ vectorId: job.vectorId, visible: true }], 100);
	assert.equal(state.index.readiness().submittedJobs, 0);
	state.database.close();
});

test("semantic jobs reject expired owners, requeue lost submissions, and stop poison retries", async () => {
	const state = setup();
	insertMessage(state.database, "message-1", "inbox", "Evidence");
	await state.index.prepare();
	const [firstJob] = state.index.leaseJobs("lease-1", 100, 100);
	assert.ok(firstJob);
	assert.deepEqual(state.index.submitJobs([
		{ vectorId: firstJob.vectorId, leaseToken: "lease-1" },
	], "late", 201), []);

	let currentTime = 201;
	let [job] = state.index.leaseJobs("lease-2", currentTime, 1_000);
	assert.ok(job);
	assert.deepEqual(state.index.submitJobs([
		{ vectorId: job.vectorId, leaseToken: job.leaseToken },
	], "accepted", currentTime + 1), [job.vectorId]);
	currentTime += 5 * 60 * 1_000 + 2;
	[job] = state.index.leaseJobs("lease-3", currentTime, 1_000);
	assert.ok(job, "a submitted mutation that never becomes visible is durably requeued");

	for (let attempt = job.attemptCount; attempt <= 5; attempt += 1) {
		state.index.retryJobs([{
			vectorId: job.vectorId,
			leaseToken: job.leaseToken,
			nextAttemptAt: currentTime,
			errorCode: "provider_shape",
			failedAt: currentTime,
		}]);
		if (attempt < 5) {
			currentTime += 1;
			[job] = state.index.leaseJobs(`lease-${attempt + 3}`, currentTime, 1_000);
			assert.ok(job);
		}
	}
	assert.equal(state.index.readiness().state, "unavailable");
	assert.equal(state.index.leaseJobs("never", currentTime + 1, 1_000).length, 0);
	state.database.close();
});

test("semantic jobs become unavailable after the final accepted mutation stays invisible", async () => {
	const state = setup();
	insertMessage(state.database, "message-1", "inbox", "Evidence");
	await state.index.prepare();
	let currentTime = 1_000;
	for (let attempt = 1; attempt <= 5; attempt += 1) {
		const [job] = state.index.leaseJobs(`lease-${attempt}`, currentTime, 1_000);
		assert.equal(job?.attemptCount, attempt);
		assert.deepEqual(state.index.submitJobs([{
			vectorId: job!.vectorId,
			leaseToken: job!.leaseToken,
		}], `mutation-${attempt}`, currentTime + 1), [job!.vectorId]);
		currentTime += 5 * 60 * 1_000 + 2;
	}
	assert.equal(state.index.leaseJobs("terminal", currentTime, 1_000).length, 0);
	const terminal = state.database.prepare(`
		SELECT state, attempt_count AS attemptCount, last_error_code AS lastErrorCode
		FROM semantic_index_jobs
	`).get();
	assert.equal(terminal?.state, "failed");
	assert.equal(terminal?.attemptCount, 5);
	assert.equal(terminal?.lastErrorCode, "visibility_unconfirmed");
	assert.equal(state.index.readiness().submittedJobs, 0);
	assert.equal(state.index.readiness().state, "unavailable");
	state.database.close();
});

test("semantic continuation clocks backfill, leases, retries, and visibility without polling", async () => {
	const state = setup();
	for (let index = 0; index < 21; index += 1) {
		insertMessage(state.database, `message-${index}`, "inbox", `Evidence ${index}`);
	}
	await state.index.prepare();
	assert.equal(state.index.nextAdvanceAt(1_000), 1_000);
	await state.index.prepare();
	assert.equal(state.index.nextAdvanceAt(1_000), 0);
	const [job] = state.index.leaseJobs("lease", 1_000, 5_000, 1);
	assert.ok(job);
	assert.equal(state.index.nextAdvanceAt(1_000), 0);
	state.index.submitJobs([{
		vectorId: job.vectorId,
		leaseToken: job.leaseToken,
	}], "mutation", 2_000);
	assert.equal(state.index.dueSubmittedJobs(31_999).length, 0);
	assert.equal(state.index.nextAdvanceAt(2_000), 0);
	const pendingIds = state.database.prepare(`
		SELECT vector_id AS vectorId FROM semantic_index_jobs WHERE state = 'pending'
	`).all();
	state.database.prepare("DELETE FROM semantic_index_jobs WHERE state = 'pending'").run();
	assert.equal(state.index.nextAdvanceAt(2_000), 32_000);
	assert.equal(state.index.dueSubmittedJobs(32_000).length, 1);
	assert.equal(state.index.nextAdvanceAt(32_000), 62_000);
	state.index.confirmVisibility([{ vectorId: job.vectorId, visible: true }], 32_000);
	assert.equal(state.index.nextAdvanceAt(32_000), null);
	assert.ok(pendingIds.length > 0);
	state.database.close();
});

test("normalization-equivalent content edits still replace the semantic source version", async () => {
	const state = setup();
	insertMessage(state.database, "message-1", "inbox", "Evidence   text");
	await state.index.prepare();
	const original = state.database.prepare(`
		SELECT c.vector_id AS vectorId, s.source_sequence AS sourceSequence
		FROM semantic_chunks c JOIN semantic_sources s ON s.source_id = c.source_id
	`).get();
	state.database.prepare("UPDATE emails SET body = ? WHERE id = ?").run(
		"Evidence text",
		"message-1",
	);
	assert.equal(state.database.prepare("SELECT COUNT(*) AS total FROM semantic_sources").get()?.total, 0);
	await state.index.prepare();
	const replacement = state.database.prepare(`
		SELECT c.vector_id AS vectorId, s.source_sequence AS sourceSequence
		FROM semantic_chunks c JOIN semantic_sources s ON s.source_id = c.source_id
	`).get();
	assert.notEqual(replacement?.vectorId, original?.vectorId);
	assert.equal(original?.sourceSequence, 1);
	assert.equal(replacement?.sourceSequence, 2);
	state.database.close();
});

test("delete visibility remains pending until the conservative observation window", async () => {
	const state = setup();
	insertMessage(state.database, "message-1", "inbox", "Evidence");
	await state.index.prepare();
	const vectorId = String(state.database.prepare("SELECT vector_id FROM semantic_chunks").get()?.vector_id);
	state.database.prepare("UPDATE emails SET folder_id = 'trash' WHERE id = ?").run("message-1");
	const [job] = state.index.leaseJobs("delete-lease", 1_000, 1_000);
	assert.equal(job?.vectorId, vectorId);
	state.index.submitJobs([{
		vectorId,
		leaseToken: "delete-lease",
	}], "delete", 1_100);
	state.index.confirmVisibility([{ vectorId, visible: false }], 1_200);
	assert.equal(state.index.submittedJobs().length, 1);
	state.index.confirmVisibility([{ vectorId, visible: false }], 1_100 + 5 * 60 * 1_000);
	assert.equal(state.index.submittedJobs().length, 0);
	state.database.close();
});

test("semantic candidate hydration drops stale fingerprints and preserves current Message truth", async () => {
	const state = setup();
	insertMessage(state.database, "message-1", "inbox", "The signed contract arrives Tuesday");
	await state.index.prepare();
	const vectorId = String(state.database.prepare("SELECT vector_id FROM semantic_chunks").get()?.vector_id);
	const [resolved] = state.index.resolveCandidates([{ vectorId, score: 0.87 }]);
	assert.equal(resolved?.messageId, "message-1");
	assert.match(resolved?.excerpt ?? "", /signed contract/);
	state.database.prepare("UPDATE emails SET folder_id = 'spam' WHERE id = ?").run("message-1");
	assert.deepEqual(state.index.resolveCandidates([{ vectorId, score: 1 }]), []);
	state.database.close();
});

test("semantic attachment evidence is exact, independently deduplicated, fenced, and immediately invalidated", async () => {
	const state = setup();
	insertMessage(state.database, "message-1", "inbox", "Parent authored evidence");
	state.database.prepare(`
		INSERT INTO attachments(id, email_id, filename, mimetype, size, disposition)
		VALUES (?, ?, ?, ?, ?, 'attachment')
	`).run("attachment-1", "message-1", "contract.md", "text/markdown", 36);
	await state.index.prepare();
	assert.equal(state.index.readiness().state, "building");
	const lease = state.index.leaseAttachmentExtraction("attachment-lease", 1_000, 10_000);
	assert.equal(lease?.attachmentId, "attachment-1");
	assert.equal(state.index.completeAttachmentExtraction({
		attachmentId: "attachment-1",
		messageId: "message-1",
		attachmentVersion: 1,
		leaseToken: "wrong-lease",
		completedAt: 2_000,
		byteSha256: "a".repeat(64),
		sourceFingerprint: "b".repeat(64),
		r2Version: "version-1",
		r2Etag: "etag-1",
		actualSize: 36,
		text: "The signed contract arrives Tuesday.",
	}), false);
	assert.equal(state.index.completeAttachmentExtraction({
		attachmentId: "attachment-1",
		messageId: "message-1",
		attachmentVersion: 1,
		leaseToken: "attachment-lease",
		completedAt: 2_000,
		byteSha256: "a".repeat(64),
		sourceFingerprint: "b".repeat(64),
		r2Version: "version-1",
		r2Etag: "etag-1",
		actualSize: 36,
		text: "The signed contract arrives Tuesday.",
	}), true);
	const rows = state.database.prepare(`
		SELECT vector_id AS vectorId, source_type AS sourceType
		FROM semantic_chunks ORDER BY source_type
	`).all();
	assert.equal(rows.length, 2);
	const attachmentVector = String(rows.find((row) => row.sourceType === "attachment")?.vectorId);
	assert.match(attachmentVector, /^sa1_[a-f0-9]{32}_[a-z0-9]{2}$/);
	const resolved = state.index.resolveCandidates([
		{ vectorId: attachmentVector, score: 0.95 },
		{ vectorId: attachmentVector, score: 0.8 },
	]);
	assert.equal(resolved.length, 1);
	assert.equal(resolved[0]?.source, "attachment");
	assert.equal(resolved[0]?.attachmentId, "attachment-1");
	assert.equal(resolved[0]?.attachmentFilename, "contract.md");
	assert.match(resolved[0]?.excerpt ?? "", /signed contract/);
	assert.equal(state.index.invalidateAttachmentAuthority({
		vectorId: attachmentVector,
		attachmentId: "attachment-1",
		sourceFingerprint: "b".repeat(64),
		r2Version: "version-1",
		r2Etag: "etag-1",
		actualSize: 36,
		errorCode: "r2_authority_changed",
	}), true);
	assert.deepEqual(state.index.resolveCandidates([{ vectorId: attachmentVector, score: 1 }]), []);
	assert.equal(state.database.prepare(
		"SELECT state FROM semantic_attachment_extractions WHERE attachment_id = 'attachment-1'",
	).get()?.state, "pending");
	assert.equal(state.index.readiness().state, "building");
	state.database.prepare("UPDATE emails SET folder_id = 'trash' WHERE id = ?").run("message-1");
	assert.deepEqual(state.index.resolveCandidates([{ vectorId: attachmentVector, score: 1 }]), []);
	assert.equal(state.database.prepare(
		"SELECT COUNT(*) AS total FROM semantic_attachment_extractions",
	).get()?.total, 0);
	assert.equal(state.database.prepare(
		"SELECT operation FROM semantic_index_jobs WHERE vector_id = ?",
	).get(attachmentVector)?.operation, "delete");
	state.database.close();
});

test("semantic candidate bounds preserve complete Unicode scalars in every visible field", async () => {
	const state = setup();
	insertMessage(state.database, "message-1", "inbox", "Parent evidence");
	state.database.prepare(`
		UPDATE emails SET subject = ?, sender = ?, recipient = ? WHERE id = 'message-1'
	`).run(
		`${"s".repeat(499)}😀tail`,
		`${"f".repeat(319)}😀tail`,
		`${"t".repeat(319)}😀tail`,
	);
	const filename = `${"a".repeat(254)}😀.txt`;
	state.database.prepare(`
		INSERT INTO attachments(id, email_id, filename, mimetype, size, disposition)
		VALUES ('attachment-1', 'message-1', ?, 'text/plain', 620, 'attachment')
	`).run(filename);
	await state.index.prepare();
	const lease = state.index.leaseAttachmentExtraction("lease", 1_000, 10_000);
	assert.ok(lease);
	assert.equal(state.index.completeAttachmentExtraction({
		attachmentId: "attachment-1",
		messageId: "message-1",
		attachmentVersion: 1,
		leaseToken: "lease",
		completedAt: 2_000,
		byteSha256: "a".repeat(64),
		sourceFingerprint: "b".repeat(64),
		r2Version: "version-1",
		r2Etag: "etag-1",
		actualSize: 620,
		text: `${"x".repeat(599)}😀tail`,
	}), true);
	const vectorId = String(state.database.prepare(`
		SELECT vector_id FROM semantic_chunks
		WHERE source_type = 'attachment' AND attachment_id = 'attachment-1'
	`).get()?.vector_id);
	const candidate = state.index.resolveCandidates([{ vectorId, score: 1 }])[0];
	assert.equal(candidate?.subject, "s".repeat(499));
	assert.equal(candidate?.sender, "f".repeat(319));
	assert.equal(candidate?.recipient, "t".repeat(319));
	assert.equal(candidate?.excerpt, "x".repeat(599));
	assert.equal(
		candidate?.source === "attachment" ? candidate.attachmentFilename : null,
		"a".repeat(254),
	);
	assert.doesNotMatch(
		JSON.stringify(candidate),
		/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u,
	);
	state.database.close();
});

test("unsupported, inline, and CID attachments never block semantic readiness", async () => {
	const state = setup();
	insertMessage(state.database, "message-1", "inbox", "Message evidence");
	for (const attachment of [
		["html", "page.html", "text/html", null, "attachment"],
		["inline", "notes.txt", "text/plain", null, "inline"],
		["cid", "notes.txt", "text/plain", "cid-1", "attachment"],
	] as const) {
		state.database.prepare(`
			INSERT INTO attachments(id, email_id, filename, mimetype, size, content_id, disposition)
			VALUES (?, 'message-1', ?, ?, 10, ?, ?)
		`).run(...attachment);
	}
	await state.index.prepare();
	assert.equal(state.database.prepare(
		"SELECT state FROM semantic_attachment_extractions WHERE attachment_id = 'html'",
	).get()?.state, "unsupported");
	assert.equal(state.database.prepare(
		"SELECT COUNT(*) AS total FROM semantic_attachment_extractions",
	).get()?.total, 1);
	const jobs = state.database.prepare("SELECT vector_id FROM semantic_index_jobs").all();
	for (const row of jobs) {
		state.database.prepare("DELETE FROM semantic_index_jobs WHERE vector_id = ?").run(row.vector_id);
	}
	assert.equal(state.index.readiness().state, "complete");
	state.database.close();
});

test("rich attachments enter the existing lifecycle with the exact four-megabyte boundary", async () => {
	const state = setup();
	insertMessage(state.database, "message-1", "inbox", "Parent evidence");
	state.database
		.prepare(
			`
		INSERT INTO attachments(id, email_id, filename, mimetype, size, disposition)
		VALUES ('rich', 'message-1', 'contract.pdf', 'application/pdf', ?, 'attachment'),
		       ('oversized', 'message-1', 'large.pdf', 'application/pdf', ?, 'attachment'),
		       ('mismatch', 'message-1', 'renamed.pdf', 'application/octet-stream', 100, 'attachment')
	`,
		)
		.run(4 * 1024 * 1024, 4 * 1024 * 1024 + 1);
	await state.index.prepare();
	assert.deepEqual(
		state.database
			.prepare(
				`
		SELECT attachment_id AS id, state, last_error_code AS errorCode
		FROM semantic_attachment_extractions ORDER BY attachment_id
	`,
			)
			.all()
			.map((row) => ({ ...row })),
		[
			{ id: "mismatch", state: "unsupported", errorCode: "unsupported_format" },
			{ id: "oversized", state: "unsupported", errorCode: "size_exceeded" },
			{ id: "rich", state: "pending", errorCode: null },
		],
	);
	const lease = state.index.leaseAttachmentExtraction("lease", 1_000, 100_000);
	assert.equal(lease?.attachmentId, "rich");
	assert.equal(
		state.index.completeAttachmentExtraction({
			attachmentId: "rich",
			messageId: "message-1",
			attachmentVersion: 1,
			leaseToken: "lease",
			completedAt: 2_000,
			byteSha256: "a".repeat(64),
			sourceFingerprint: "b".repeat(64),
			r2Version: "version-1",
			r2Etag: "etag-1",
			actualSize: 4 * 1024 * 1024,
			text: "Converted rich evidence",
		}),
		true,
	);
	assert.equal(
		state.database
			.prepare(
				"SELECT state FROM semantic_attachment_extractions WHERE attachment_id = 'rich'",
			)
			.get()?.state,
		"ready",
	);
	state.database.close();
});

test("invalid legacy attachment sizes are classified without crashing projection preparation", async () => {
	const state = setup();
	insertMessage(state.database, "message-1", "inbox", "Message evidence");
	for (const [id, size] of [["negative", -1], ["fractional", 1.5]] as const) {
		state.database.prepare(`
			INSERT INTO attachments(id, email_id, filename, mimetype, size, disposition)
			VALUES (?, 'message-1', ?, 'text/plain', ?, 'attachment')
		`).run(id, `${id}.txt`, size);
	}
	await state.index.prepare();
	assert.deepEqual(state.database.prepare(`
		SELECT attachment_id AS attachmentId, declared_size AS declaredSize,
		 state, last_error_code AS errorCode
		FROM semantic_attachment_extractions ORDER BY attachment_id
	`).all().map((row) => ({ ...row })), [
		{ attachmentId: "fractional", declaredSize: 0, state: "unsupported", errorCode: "invalid_size" },
		{ attachmentId: "negative", declaredSize: 0, state: "unsupported", errorCode: "invalid_size" },
	]);
	state.database.prepare("DELETE FROM semantic_index_jobs").run();
	assert.equal(state.index.readiness().state, "complete");
	state.database.close();
});

test("attachment extraction, policy, or chunk version drift rebuilds only attachment evidence", async () => {
	const state = setup();
	insertMessage(state.database, "message-1", "inbox", "Stable Message evidence");
	state.database.prepare(`
		INSERT INTO attachments(id, email_id, filename, mimetype, size, disposition)
		VALUES ('attachment-1', 'message-1', 'contract.md', 'text/markdown', 36, 'attachment')
	`).run();
	await state.index.prepare();
	const messageVector = String(state.database.prepare(
		"SELECT vector_id FROM semantic_chunks WHERE source_type = 'message'",
	).get()?.vector_id);
	const lease = state.index.leaseAttachmentExtraction("lease", 1_000, 10_000);
	assert.ok(lease);
	assert.equal(state.index.completeAttachmentExtraction({
		attachmentId: "attachment-1",
		messageId: "message-1",
		attachmentVersion: 1,
		leaseToken: "lease",
		completedAt: 2_000,
		byteSha256: "a".repeat(64),
		sourceFingerprint: "b".repeat(64),
		r2Version: "version-1",
		r2Etag: "etag-1",
		actualSize: 36,
		text: "The signed contract arrives Tuesday.",
	}), true);
	state.database.prepare(`
		UPDATE semantic_projection_state SET attachment_extraction_version = 99,
		 attachment_policy_version = 99, attachment_chunk_version = 99 WHERE id = 1
	`).run();
	await state.index.prepare();
	assert.equal(state.database.prepare(
		"SELECT vector_id FROM semantic_chunks WHERE source_type = 'message'",
	).get()?.vector_id, messageVector);
	assert.equal(state.database.prepare(
		"SELECT COUNT(*) AS total FROM semantic_sources WHERE source_type = 'attachment'",
	).get()?.total, 0);
	assert.equal(state.database.prepare(
		"SELECT state FROM semantic_attachment_extractions WHERE attachment_id = 'attachment-1'",
	).get()?.state, "pending");
	assert.equal(state.index.readiness().state, "building");
	assert.deepEqual({ ...state.database.prepare(`
		SELECT attachment_extraction_version AS extractionVersion,
		 attachment_policy_version AS policyVersion,
		 attachment_chunk_version AS chunkVersion
		FROM semantic_projection_state WHERE id = 1
	`).get()! }, { extractionVersion: 2, policyVersion: 2, chunkVersion: 1 });
	state.database.close();
});

test("an expired attachment extraction lease is taken over durably after restart", async () => {
	const state = setup();
	insertMessage(state.database, "message-1", "inbox", "Parent evidence");
	state.database.prepare(`
		INSERT INTO attachments(id, email_id, filename, mimetype, size, disposition)
		VALUES ('attachment-1', 'message-1', 'notes.txt', 'text/plain', 12, 'attachment')
	`).run();
	await state.index.prepare();
	const first = state.index.leaseAttachmentExtraction("lease-1", 1_000, 100);
	assert.equal(first?.attemptCount, 1);
	assert.equal(state.restartIndex().leaseAttachmentExtraction("too-early", 1_099, 100), null);
	const second = state.restartIndex().leaseAttachmentExtraction("lease-2", 1_100, 100);
	assert.equal(second?.attemptCount, 2);
	assert.equal(state.index.completeAttachmentExtraction({
		attachmentId: "attachment-1",
		messageId: "message-1",
		attachmentVersion: 1,
		leaseToken: "lease-1",
		completedAt: 1_101,
		byteSha256: "a".repeat(64),
		sourceFingerprint: "b".repeat(64),
		r2Version: "version-1",
		r2Etag: "etag-1",
		actualSize: 12,
		text: "New evidence",
	}), false);
	assert.equal(state.restartIndex().completeAttachmentExtraction({
		attachmentId: "attachment-1",
		messageId: "message-1",
		attachmentVersion: 1,
		leaseToken: "lease-2",
		completedAt: 1_101,
		byteSha256: "a".repeat(64),
		sourceFingerprint: "b".repeat(64),
		r2Version: "version-1",
		r2Etag: "etag-1",
		actualSize: 12,
		text: "New evidence",
	}), true);
	state.database.close();
});

test("a reparented attachment rejects stale work and resumes under its new Message authority", async () => {
	const state = setup();
	insertMessage(state.database, "message-1", "inbox", "First parent");
	insertMessage(state.database, "message-2", "archive", "Second parent");
	state.database.prepare(`
		INSERT INTO attachments(id, email_id, filename, mimetype, size, disposition)
		VALUES ('attachment-1', 'message-1', 'notes.txt', 'text/plain', 12, 'attachment')
	`).run();
	await state.index.prepare();
	const stale = state.index.leaseAttachmentExtraction("stale", 1_000, 10_000);
	assert.equal(stale?.messageId, "message-1");
	state.database.prepare(`
		UPDATE attachments SET email_id = 'message-2', filename = 'renamed.txt'
		WHERE id = 'attachment-1'
	`).run();
	assert.equal(state.index.completeAttachmentExtraction({
		attachmentId: "attachment-1",
		messageId: "message-1",
		attachmentVersion: 1,
		leaseToken: "stale",
		completedAt: 2_000,
		byteSha256: "a".repeat(64),
		sourceFingerprint: "b".repeat(64),
		r2Version: "version-1",
		r2Etag: "etag-1",
		actualSize: 12,
		text: "New evidence",
	}), false);
	await state.index.prepare();
	const current = state.index.leaseAttachmentExtraction("current", 2_001, 10_000);
	assert.deepEqual(current && {
		messageId: current.messageId,
		attachmentVersion: current.attachmentVersion,
		filename: current.filename,
	}, {
		messageId: "message-2",
		attachmentVersion: 2,
		filename: "renamed.txt",
	});
	assert.equal(state.database.prepare(`
		SELECT COUNT(*) AS total FROM semantic_sources
		WHERE source_type = 'attachment' AND attachment_id = 'attachment-1'
	`).get()?.total, 0);
	state.database.close();
});

test("deleting an attachment removes local evidence immediately and preserves vector deletion work", async () => {
	const state = setup();
	insertMessage(state.database, "message-1", "inbox", "Parent evidence");
	state.database.prepare(`
		INSERT INTO attachments(id, email_id, filename, mimetype, size, disposition)
		VALUES ('attachment-1', 'message-1', 'notes.txt', 'text/plain', 12, 'attachment')
	`).run();
	await state.index.prepare();
	const lease = state.index.leaseAttachmentExtraction("lease", 1_000, 10_000);
	assert.ok(lease);
	assert.equal(state.index.completeAttachmentExtraction({
		attachmentId: "attachment-1",
		messageId: "message-1",
		attachmentVersion: 1,
		leaseToken: "lease",
		completedAt: 2_000,
		byteSha256: "a".repeat(64),
		sourceFingerprint: "b".repeat(64),
		r2Version: "version-1",
		r2Etag: "etag-1",
		actualSize: 12,
		text: "New evidence",
	}), true);
	const vectorId = String(state.database.prepare(`
		SELECT vector_id FROM semantic_chunks
		WHERE source_type = 'attachment' AND attachment_id = 'attachment-1'
	`).get()?.vector_id);
	state.database.prepare("DELETE FROM attachments WHERE id = 'attachment-1'").run();
	assert.deepEqual(state.index.resolveCandidates([{ vectorId, score: 1 }]), []);
	assert.equal(state.database.prepare(`
		SELECT COUNT(*) AS total FROM semantic_sources
		WHERE source_type = 'attachment' AND attachment_id = 'attachment-1'
	`).get()?.total, 0);
	assert.equal(state.database.prepare(`
		SELECT COUNT(*) AS total FROM semantic_attachment_extractions
		WHERE attachment_id = 'attachment-1'
	`).get()?.total, 0);
	assert.equal(state.database.prepare(`
		SELECT operation FROM semantic_index_jobs WHERE vector_id = ?
	`).get(vectorId)?.operation, "delete");
	state.database.close();
});

test("a changed R2 object replaces the attachment source and its opaque vector identities", async () => {
	const state = setup();
	insertMessage(state.database, "message-1", "inbox", "Parent evidence");
	state.database.prepare(`
		INSERT INTO attachments(id, email_id, filename, mimetype, size, disposition)
		VALUES ('attachment-1', 'message-1', 'notes.txt', 'text/plain', 12, 'attachment')
	`).run();
	await state.index.prepare();
	const firstLease = state.index.leaseAttachmentExtraction("first", 1_000, 10_000);
	assert.ok(firstLease);
	assert.equal(state.index.completeAttachmentExtraction({
		attachmentId: "attachment-1",
		messageId: "message-1",
		attachmentVersion: 1,
		leaseToken: "first",
		completedAt: 2_000,
		byteSha256: "a".repeat(64),
		sourceFingerprint: "b".repeat(64),
		r2Version: "version-1",
		r2Etag: "etag-1",
		actualSize: 12,
		text: "Old evidence",
	}), true);
	const oldVectorId = String(state.database.prepare(`
		SELECT vector_id FROM semantic_chunks
		WHERE source_type = 'attachment' AND attachment_id = 'attachment-1'
	`).get()?.vector_id);
	assert.equal(state.index.invalidateAttachmentAuthority({
		vectorId: oldVectorId,
		attachmentId: "attachment-1",
		sourceFingerprint: "b".repeat(64),
		r2Version: "version-1",
		r2Etag: "etag-1",
		actualSize: 12,
		errorCode: "r2_authority_changed",
	}), true);
	const secondLease = state.restartIndex().leaseAttachmentExtraction("second", 2_001, 10_000);
	assert.equal(secondLease?.attemptCount, 1);
	assert.equal(state.index.completeAttachmentExtraction({
		attachmentId: "attachment-1",
		messageId: "message-1",
		attachmentVersion: 1,
		leaseToken: "second",
		completedAt: 3_000,
		byteSha256: "c".repeat(64),
		sourceFingerprint: "d".repeat(64),
		r2Version: "version-2",
		r2Etag: "etag-2",
		actualSize: 12,
		text: "New evidence",
	}), true);
	const newVectorId = String(state.database.prepare(`
		SELECT vector_id FROM semantic_chunks
		WHERE source_type = 'attachment' AND attachment_id = 'attachment-1'
	`).get()?.vector_id);
	assert.notEqual(newVectorId, oldVectorId);
	assert.deepEqual(state.index.resolveCandidates([{ vectorId: oldVectorId, score: 1 }]), []);
	assert.match(
		state.index.resolveCandidates([{ vectorId: newVectorId, score: 1 }])[0]?.excerpt ?? "",
		/New evidence/,
	);
	state.database.close();
});

test("attachment backfill is bounded and later attachment changes replay from the durable feed", async () => {
	const state = setup();
	insertMessage(state.database, "message-1", "inbox", "Parent evidence");
	const insertAttachment = state.database.prepare(`
		INSERT INTO attachments(id, email_id, filename, mimetype, size, disposition)
		VALUES (?, 'message-1', ?, 'text/plain', 10, 'attachment')
	`);
	for (let index = 0; index < 25; index += 1) {
		const id = `attachment-${index.toString().padStart(2, "0")}`;
		insertAttachment.run(id, `${id}.txt`);
	}
	await state.index.prepare();
	assert.deepEqual({ ...state.database.prepare(`
		SELECT attachment_status AS status, processed_attachments AS processed
		FROM semantic_projection_state WHERE id = 1
	`).get()! }, { status: "building", processed: 20 });
	assert.equal(state.database.prepare(
		"SELECT COUNT(*) AS total FROM semantic_attachment_extractions",
	).get()?.total, 20);
	await state.index.prepare();
	assert.deepEqual({ ...state.database.prepare(`
		SELECT attachment_status AS status, processed_attachments AS processed
		FROM semantic_projection_state WHERE id = 1
	`).get()! }, { status: "ready", processed: 25 });

	insertAttachment.run("attachment-25", "attachment-25.txt");
	await state.restartIndex().prepare();
	assert.equal(state.database.prepare(`
		SELECT COUNT(*) AS total FROM semantic_attachment_extractions
		WHERE attachment_id = 'attachment-25' AND state = 'pending'
	`).get()?.total, 1);
	const projection = state.database.prepare(`
		SELECT applied_change_sequence AS applied FROM semantic_projection_state WHERE id = 1
	`).get();
	const current = state.database.prepare("SELECT MAX(sequence) AS current FROM mailbox_changes").get();
	assert.equal(projection?.applied, current?.current);
	state.database.close();
});

test("exhausted attachment extraction retries make readiness unavailable without another lease", async () => {
	const state = setup();
	insertMessage(state.database, "message-1", "inbox", "Parent evidence");
	state.database.prepare(`
		INSERT INTO attachments(id, email_id, filename, mimetype, size, disposition)
		VALUES ('attachment-1', 'message-1', 'notes.txt', 'text/plain', 12, 'attachment')
	`).run();
	await state.index.prepare();
	state.database.prepare("DELETE FROM semantic_index_jobs").run();
	let currentTime = 1_000;
	for (let attempt = 1; attempt <= 5; attempt += 1) {
		const lease = state.restartIndex().leaseAttachmentExtraction(
			`lease-${attempt}`,
			currentTime,
			1_000,
		);
		assert.equal(lease?.attemptCount, attempt);
		assert.equal(state.index.retryAttachmentExtraction({
			attachmentId: "attachment-1",
			leaseToken: `lease-${attempt}`,
			failedAt: currentTime + 1,
			nextAttemptAt: currentTime + 2,
			errorCode: "r2_timeout_error",
		}), true);
		currentTime += 3;
	}
	assert.equal(state.index.readiness().state, "unavailable");
	assert.equal(
		state.restartIndex().leaseAttachmentExtraction("never", currentTime, 1_000),
		null,
	);
	assert.equal(state.index.nextAdvanceAt(currentTime), null);
	assert.deepEqual({ ...state.database.prepare(`
		SELECT state, attempt_count AS attempts, last_error_code AS errorCode
		FROM semantic_attachment_extractions WHERE attachment_id = 'attachment-1'
	`).get()! }, {
		state: "failed",
		attempts: 5,
		errorCode: "r2_timeout_error",
	});
	state.database.close();
});
