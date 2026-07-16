import assert from "node:assert/strict";
import test from "node:test";
import { reconcileInboundArchives } from "./inbound-reconciliation.ts";
import {
	createInboundCleanupIntent,
	inboundCleanupIntentKey,
} from "./lib/inbound-derived-content-cleanup-intent.ts";
import {
	type InboundDerivedContentRepairAttempt,
	INBOUND_REPAIR_ATTEMPT_SCHEMA_VERSION,
	pendingRepairAttemptKey,
} from "./lib/inbound-derived-content-repair-attempt.ts";
import {
	INBOUND_RECONCILIATION_SERVICE_SUBREQUEST_BUDGET,
	INBOUND_RECONCILIATION_WORST_CASE_SERVICE_SUBREQUESTS,
} from "./lib/inbound-reconciliation-budget.ts";

const mailboxId = "hello@wiserchat.ai";
const now = new Date("2026-07-15T10:00:00.000Z");

function attemptId(index: number) {
	return `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
}

test("a maximum scheduled reconciliation shape stays within the Worker service-subrequest budget", async () => {
	let serviceSubrequests = 0;
	let etagRevision = 0;
	const stored = new Map<string, { value: string; etag: string }>();
	const repairKeys: string[] = [];
	const cleanupKeys: string[] = [];
	const archiveKeys = Array.from(
		{ length: 7 },
		(_, index) => `raw/2026/07/15/archive-${index}.eml`,
	);

	for (let index = 0; index < 20; index += 1) {
		const id = attemptId(index);
		const attempt: InboundDerivedContentRepairAttempt = {
			schemaVersion: INBOUND_REPAIR_ATTEMPT_SCHEMA_VERSION,
			kind: "inbound_derived_content_repair_attempt",
			status: "pending",
			attemptId: id,
			ingressId: `repair-${index}`,
			mailboxId,
			expectedGeneration: 2,
			markerId: `marker_${String(index).padStart(8, "0")}`,
			commandFingerprint: String(index % 10).repeat(64),
			createdAt: "2026-07-15T09:00:00.000Z",
			proof: {
				attachments: [{
					r2Key: `attachments/repair-${index}/${id}/repair-${index}-0/file.bin`,
					byteLength: 1,
				}],
				bodyObjects: [],
			},
		};
		const key = pendingRepairAttemptKey(attempt.ingressId, id);
		repairKeys.push(key);
		stored.set(key, { value: JSON.stringify(attempt), etag: `seed-repair-${index}` });
	}

	for (let index = 0; index < 7; index += 1) {
		const id = attemptId(100 + index);
		const value = {
			...createInboundCleanupIntent({
				emailId: `cleanup-${index}`,
				mailboxId,
				projectionAttemptId: id,
				createdAt: "2026-07-14T00:00:00.000Z",
				fenceToken: attemptId(200 + index),
			}),
			status: "abandoned" as const,
			revision: 1,
			leaseUntil: "2026-07-14T00:20:00.000Z",
			abandonedAt: "2026-07-14T00:20:00.000Z",
			emptyObservedAt: "2026-07-15T09:00:00.000Z",
			emptyObservations: 1,
		};
		const key = inboundCleanupIntentKey(value.emailId, id);
		cleanupKeys.push(key);
		stored.set(key, { value: JSON.stringify(value), etag: `seed-cleanup-${index}` });
	}

	for (let index = 0; index < 7; index += 1) {
		stored.set(`receipts/archive-${index}.json`, {
			value: JSON.stringify({
				state: "stored",
				updatedAt: "2026-07-15T09:00:00.000Z",
			}),
			etag: `receipt-${index}`,
		});
		stored.set(
			`system/reconciliation-anomalies/${encodeURIComponent(archiveKeys[index])}.json`,
			{
				value: JSON.stringify({
					detectedAt: "2026-07-15T09:00:00.000Z",
					errorCode: "STORED_PROJECTION_MISSING",
					ingressId: `archive-${index}`,
					mailboxId,
					rawKey: archiveKeys[index],
					status: "pending_operator_review",
				}),
				etag: `anomaly-${index}`,
			},
		);
	}

	const rawBucket = {
		async list(options: { prefix: string; limit: number }) {
			serviceSubrequests += 1;
			if (options.prefix === "system/derived-content-repair-attempts/pending/") {
				assert.equal(options.limit, 20);
				return { objects: repairKeys.map((key) => ({ key })), truncated: false };
			}
			if (options.prefix === "system/derived-content-cleanup-intents/pending/") {
				assert.equal(options.limit, 7);
				return { objects: cleanupKeys.map((key) => ({ key })), truncated: false };
			}
			assert.equal(options.prefix, "raw/");
			assert.equal(options.limit, 7);
			return { objects: archiveKeys.map((key) => ({ key })), truncated: false };
		},
		async head(key: string) {
			serviceSubrequests += 1;
			const ingressId = key.slice(key.lastIndexOf("/") + 1, -4);
			return {
				key,
				size: 1,
				etag: `raw-${ingressId}`,
				version: "raw-version",
				customMetadata: {
					archivedAt: "2026-07-15T09:00:00.000Z",
					ingressId,
					mailboxId,
					rawSize: "1",
					schemaVersion: "1",
				},
			};
		},
		async get(key: string) {
			serviceSubrequests += 1;
			const object = stored.get(key);
			return object
				? { etag: object.etag, async text() { return object.value; } }
				: null;
		},
		async put(
			key: string,
			value: string,
			options?: { onlyIf?: { etagMatches?: string; etagDoesNotMatch?: string } },
		) {
			serviceSubrequests += 1;
			const current = stored.get(key);
			if (options?.onlyIf?.etagDoesNotMatch === "*" && current) return null;
			if (options?.onlyIf?.etagMatches &&
				current?.etag !== options.onlyIf.etagMatches) return null;
			etagRevision += 1;
			stored.set(key, { value, etag: `etag-${etagRevision}` });
			return key.startsWith("system/derived-content-repair-attempts/resolved/")
				? null
				: {};
		},
		async delete(key: string) {
			serviceSubrequests += 1;
			stored.delete(key);
		},
	};

	const env = {
		DOMAINS: "wiserchat.ai",
		DB: {
			prepare() {
				throw new Error("stored archives must not query mailbox admission");
			},
		},
		BUCKET: {
			async list(options: { prefix: string; cursor?: string }) {
				serviceSubrequests += 1;
				const offset = Number(options.cursor ?? 0);
				if (offset >= 256) return { objects: [], truncated: false };
				const emailId = options.prefix.split("/")[1];
				return {
					objects: [{
						key: options.prefix.startsWith("attachments/")
							? `${options.prefix}${emailId}-${offset}/file-${offset}.bin`
							: `${options.prefix}${offset}.body`,
						size: 1,
					}],
					truncated: true,
					cursor: String(offset + 1),
				};
			},
			async head() {
				serviceSubrequests += 1;
				return null;
			},
		},
		RAW_MAIL_BUCKET: rawBucket,
		INBOUND_QUEUE: {
			async send() {
				serviceSubrequests += 1;
				throw new Error("stored archives must not enqueue");
			},
		},
		MAILBOX: {
			idFromName(value: string) {
				return value;
			},
			get() {
				return {
					async finalizeInboundDerivedContentRepairAttempt() {
						serviceSubrequests += 1;
						return { outcome: "rejected" as const };
					},
					async enqueueUnownedInboundDerivedContentCleanup(input: {
						objects: Array<unknown>;
					}) {
						serviceSubrequests += 1;
						return { queued: input.objects.length, retained: 0, absent: 0 };
					},
					async getInboundDerivedContentManifest(ingressId: string) {
						serviceSubrequests += 1;
						if (ingressId.startsWith("cleanup-")) return { status: "missing" as const };
						return {
							status: "live_inbound" as const,
							generation: 1,
							lastRepairMarkerId: null,
							attachments: Array.from({ length: 512 }, (_, index) => ({
								id: `attachment-${index}`,
								r2Key: `attachments/${ingressId}/owned-${index}.bin`,
								byteLength: 1,
							})),
							bodyObjects: [],
						};
					},
					async isEmailDeleted() {
						serviceSubrequests += 1;
						return false;
					},
					async hasEmail() {
						serviceSubrequests += 1;
						return true;
					},
					async getEmail() {
						serviceSubrequests += 1;
						return {};
					},
				};
			},
		},
	};

	const originalLog = console.log;
	const originalError = console.error;
	console.log = () => {};
	console.error = () => {};
	try {
		const result = await reconcileInboundArchives(env, { now: () => now });
		assert.equal(result.scanned, 7);
		assert.equal(result.pendingReview, 7);
	} finally {
		console.log = originalLog;
		console.error = originalError;
	}

	assert.equal(
		serviceSubrequests,
		INBOUND_RECONCILIATION_WORST_CASE_SERVICE_SUBREQUESTS,
	);
	assert.ok(serviceSubrequests <= INBOUND_RECONCILIATION_SERVICE_SUBREQUEST_BUDGET);
});
