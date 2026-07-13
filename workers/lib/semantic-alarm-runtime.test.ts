import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { mailboxMigrations } from "../durableObject/migrations.ts";
import { attachmentKey } from "./attachments.ts";
import { createSemanticIndex } from "./semantic-index.ts";
import {
	advanceSemanticMailboxIndex,
	type SemanticMailboxIndexRuntime,
	type SemanticIndexRuntimeProvider,
} from "./semantic-index-runtime.ts";

test("the production semantic alarm turn composes extraction through final vector visibility", async () => {
	const database = new DatabaseSync(":memory:");
	database.exec("PRAGMA foreign_keys = ON");
	for (const migration of mailboxMigrations) database.exec(migration.sql);
	const pdfHeader = "%PDF-1.7\n";
	const pdfObject = "1 0 obj\n<< /Type /Catalog >>\nendobj\n";
	const xrefOffset = pdfHeader.length + pdfObject.length;
	const encodedDocument = new TextEncoder().encode([
		pdfHeader + pdfObject + "xref",
		"0 2",
		"0000000000 65535 f ",
		`${pdfHeader.length.toString().padStart(10, "0")} 00000 n `,
		"trailer",
		"<< /Size 2 /Root 1 0 R >>",
		"startxref",
		xrefOffset.toString(),
		"%%EOF",
		"",
	].join("\n"));
	const documentBytes = new Uint8Array(encodedDocument.byteLength);
	documentBytes.set(encodedDocument);
	database.prepare(`
		INSERT INTO emails(id, folder_id, subject, sender, recipient, date, body)
		VALUES ('message-1', 'inbox', 'Contract', 'sam@example.com',
		 'team@example.com', '2026-07-13T08:00:00.000Z', 'Please review the attachment.')
	`).run();
	database.prepare(`
		INSERT INTO attachments(id, email_id, filename, mimetype, size, disposition)
		VALUES ('attachment-1', 'message-1', 'contract.pdf', 'application/pdf', ?, 'attachment')
	`).run(documentBytes.byteLength);

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
	const index = createSemanticIndex({
		store,
		now: () => "2026-07-13T12:00:00.000Z",
		createId: () => (++nextId).toString(16).padStart(32, "0"),
	});
	const mailbox: SemanticMailboxIndexRuntime = {
		async prepareSemanticIndex() { return index.prepare(); },
		async readSemanticIndexReadiness() { return index.readiness(); },
		async listSubmittedSemanticIndexJobs(limit, observedAt) {
			return index.dueSubmittedJobs(observedAt, limit);
		},
		async confirmSemanticIndexVisibility(observations, observedAt) {
			index.confirmVisibility(observations, observedAt);
		},
		async leaseSemanticIndexJobs(leaseToken, nowMs, leaseMs, limit) {
			return index.leaseJobs(leaseToken, nowMs, leaseMs, limit);
		},
		async submitSemanticIndexJobs(jobs, mutationId, submittedAt) {
			return index.submitJobs(jobs, mutationId, submittedAt);
		},
		async retrySemanticIndexJobs(jobs) { return index.retryJobs(jobs); },
		async deferSemanticIndexJobs(jobs) { return index.deferJobs(jobs); },
		async leaseSemanticAttachmentExtraction(leaseToken, nowMs, leaseMs) {
			return index.leaseAttachmentExtraction(leaseToken, nowMs, leaseMs);
		},
		async completeSemanticAttachmentExtraction(completion) {
			return index.completeAttachmentExtraction(completion);
		},
		async rejectSemanticAttachmentExtraction(input) {
			return index.rejectAttachmentExtraction(input);
		},
		async retrySemanticAttachmentExtraction(input) {
			return index.retryAttachmentExtraction(input);
		},
	};
	const visible = new Set<string>();
	const embeddedFeatures: string[] = [];
	const conversionCalls: Array<{
		filename: string;
		mimetype: string;
		format: string;
		byteLength: number;
	}> = [];
	const provider: SemanticIndexRuntimeProvider = {
		async embed(texts, feature) {
			embeddedFeatures.push(feature);
			return texts.map((_, position) => [position + 1, 0.5]);
		},
		async upsert(vectors) {
			for (const vector of vectors) visible.add(vector.id);
			return { mutationId: `mutation-${visible.size}` };
		},
		async deleteByIds(ids) {
			for (const id of ids) visible.delete(id);
			return { mutationId: "delete" };
		},
		async getByIds(ids) {
			return ids.filter((id) => visible.has(id)).map((id) => ({ id }));
		},
	};
	const key = attachmentKey("message-1", "attachment-1", "contract.pdf");
	const bucket = {
		async head(candidate: string) {
			return candidate === key
				? { size: documentBytes.byteLength, version: "version-1", etag: "etag-1" }
				: null;
		},
		async get(candidate: string, etag: string) {
			if (candidate !== key || etag !== "etag-1") return null;
			return {
				size: documentBytes.byteLength,
				version: "version-1",
				etag: "etag-1",
				async arrayBuffer() { return documentBytes.buffer; },
			};
		},
	};
	let currentTime = 1_000;
	let token = 0;
	const runTurn = () => advanceSemanticMailboxIndex({
		mailbox,
		bucket,
		converter: {
			async convert(input) {
				conversionCalls.push({
					filename: input.filename,
					mimetype: input.mimetype,
					format: input.format,
					byteLength: input.bytes.byteLength,
				});
				return "The signed contract arrives Tuesday.";
			},
		},
		provider,
		namespace: "mailbox-namespace",
		now: () => currentTime,
		createLeaseToken: () => `lease-${++token}`,
		createReceiptToken: () => `receipt-${token}`,
	});

	assert.equal((await runTurn()).state, "building");
	assert.deepEqual(embeddedFeatures, ["semantic_message_index"]);
	assert.equal(database.prepare(
		"SELECT state FROM semantic_attachment_extractions WHERE attachment_id = 'attachment-1'",
	).get()?.state, "pending");

	currentTime += 60_000;
	assert.equal((await runTurn()).state, "building");
	assert.deepEqual(embeddedFeatures, [
		"semantic_message_index",
		"semantic_attachment_index",
	]);
	assert.equal(database.prepare(
		"SELECT state FROM semantic_attachment_extractions WHERE attachment_id = 'attachment-1'",
	).get()?.state, "ready");
	assert.deepEqual(conversionCalls, [{
		filename: "contract.pdf",
		mimetype: "application/pdf",
		format: "pdf",
		byteLength: documentBytes.byteLength,
	}]);
	assert.equal(database.prepare(
		"SELECT COUNT(*) AS total FROM semantic_chunks WHERE source_type = 'attachment'",
	).get()?.total, 1);

	currentTime += 60_000;
	assert.equal((await runTurn()).state, "complete");
	assert.equal(database.prepare("SELECT COUNT(*) AS total FROM semantic_index_jobs").get()?.total, 0);
	database.close();
});
