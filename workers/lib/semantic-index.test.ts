import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { mailboxMigrations } from "../durableObject/migrations.ts";
import { createSemanticIndex } from "./semantic-index.ts";

function setup() {
	const database = new DatabaseSync(":memory:");
	database.exec("PRAGMA foreign_keys = ON");
	for (const migration of mailboxMigrations) database.exec(migration.sql);
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
	return {
		database,
		index: createSemanticIndex({
			store,
			now: () => "2026-07-13T12:00:00.000Z",
			createId: () => (++nextId).toString(16).padStart(32, "0"),
		}),
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
