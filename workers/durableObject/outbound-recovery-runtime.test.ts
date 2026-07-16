import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { Log, LogLevel, Miniflare } from "miniflare";

const execFileAsync = promisify(execFile);
const ROOT = process.cwd();

async function recipientHash(value: string) {
	const digest = await crypto.subtle.digest(
		"SHA-256",
		new TextEncoder().encode(value.toLowerCase()),
	);
	return [...new Uint8Array(digest)]
		.map((byte) => byte.toString(16).padStart(2, "0"))
		.join("");
}

test(
	"accepted outbound recovery survives logical bounce, preserves user folders, parks, and repairs",
	{ timeout: 45_000 },
	async () => {
		const outputDirectory = await mkdtemp(join(tmpdir(), "mail-outbound-recovery-"));
		let runtime: Miniflare | undefined;
		try {
			await execFileAsync(
				join(ROOT, "node_modules/.bin/wrangler"),
				[
					"deploy",
					"workers/testing/outbound-recovery-integration-entry.ts",
					"--dry-run",
					"--outdir",
					outputDirectory,
					"--compatibility-date",
					"2026-07-14",
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
				join(outputDirectory, "outbound-recovery-integration-entry.js"),
				"utf8",
			);
			runtime = new Miniflare({
				log: new Log(LogLevel.ERROR),
				modules: true,
				script: bundle,
				compatibilityDate: "2026-07-14",
				compatibilityFlags: ["nodejs_compat"],
				durableObjects: {
					MAILBOX: { className: "OutboundRecoveryMailboxDO", useSQLite: true },
				},
				r2Buckets: ["BUCKET"],
				d1Databases: ["DB"],
				kvNamespaces: ["OAUTH_KV"],
				bindings: {
					BRAND: "wiser",
					FEATURES: [],
					DOMAINS: "wiserchat.ai",
					EMAIL_ADDRESSES: [],
					AWS_REGION: "eu-west-2",
					SES_CONFIGURATION_SET: "mail-portal-events",
					AI_MODEL: "test",
					AI_CHEAP_MODEL: "test",
					AI_STRONG_MODEL: "test",
					AI_COST_ALERT_USD: "25",
					AI_COST_REVIEW_USD: "50",
					VAPID_SUBJECT: "mailto:test@example.com",
				},
			});
			const request = async <T>(path: string, body?: unknown): Promise<T> => {
				const response = await runtime!.dispatchFetch(
					`http://outbound.test${path}${path.includes("?") ? "&" : "?"}mailbox=team@example.com`,
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
				};
				const replayOwnership = await request<{
					replayed: boolean;
					deliveryEmailId: string;
					authoritativeEmailId: string;
					attemptedEmailId: string;
					authoritativeKey: string;
					attemptedKey: string;
				}>("/exercise-replay-attachment-ownership");
				assert.equal(replayOwnership.replayed, true);
				assert.equal(
					replayOwnership.deliveryEmailId,
					replayOwnership.authoritativeEmailId,
				);
				const replayCleanupPath =
					`/replay-attachment-cleanup-state?authoritativeKey=${encodeURIComponent(replayOwnership.authoritativeKey)}` +
					`&attemptedKey=${encodeURIComponent(replayOwnership.attemptedKey)}`;
				const replayCleanupBefore = await request<{
					rows: Array<{ r2Key: string; emailId: string; state: string }>;
					authoritativeExists: boolean;
					attemptedExists: boolean;
				}>(replayCleanupPath);
				assert.deepEqual(replayCleanupBefore.rows, [{
					r2Key: replayOwnership.attemptedKey,
					emailId: replayOwnership.attemptedEmailId,
					state: "pending",
				}]);
				assert.equal(replayCleanupBefore.authoritativeExists, true);
				assert.equal(replayCleanupBefore.attemptedExists, true);
				await request("/make-replay-attachment-cleanup-due", {
					attemptedKey: replayOwnership.attemptedKey,
				});
				await request("/alarm");
				const replayCleanupAfter = await request<{
					rows: Array<{ r2Key: string; emailId: string; state: string }>;
					authoritativeExists: boolean;
					attemptedExists: boolean;
				}>(replayCleanupPath);
				assert.deepEqual(replayCleanupAfter.rows, []);
				assert.equal(replayCleanupAfter.authoritativeExists, true);
				assert.equal(replayCleanupAfter.attemptedExists, false);

				await request("/seed", {
				deliveryId: "delivery-bounced",
				emailId: "email-bounced",
				folderId: "outbox",
			});
			await request("/seed", {
				deliveryId: "delivery-user-moved",
				emailId: "email-user-moved",
				folderId: "archive",
			});
			await request("/seed", {
				deliveryId: "delivery-invalid",
				emailId: "email-invalid",
				folderId: "outbox",
				corruptAttemptIdentity: true,
			});
			await request("/seed-second-accepted", {
				deliveryId: "delivery-invalid",
			});
			await request("/seed", {
				deliveryId: "delivery-mixed",
				emailId: "email-mixed",
				folderId: "outbox",
				recipients: ["one@example.com", "two@example.com"],
			});
			await request("/seed", {
				deliveryId: "delivery-unscoped-bounce",
				emailId: "email-unscoped-bounce",
				folderId: "outbox",
			});
			await request("/seed", {
				deliveryId: "delivery-full-bounce",
				emailId: "email-full-bounce",
				folderId: "outbox",
				recipients: ["one@example.com", "two@example.com"],
			});
			await request("/seed", {
				deliveryId: "delivery-complaint",
				emailId: "email-complaint",
				folderId: "outbox",
			});
			await request("/seed", {
				deliveryId: "delivery-multi-accepted",
				emailId: "email-multi-accepted",
				folderId: "outbox",
			});
			await request("/seed-second-accepted", {
				deliveryId: "delivery-multi-accepted",
			});
			await request("/poison-accepted-terminal", {
				deliveryId: "delivery-multi-accepted",
			});
			await request("/seed", {
				deliveryId: "delivery-malformed-provider-evidence",
				emailId: "email-malformed-provider-evidence",
				folderId: "outbox",
				corruptProviderEvidence: true,
			});
			await request("/seed", {
				deliveryId: "delivery-bounce-then-unknown",
				emailId: "email-bounce-then-unknown",
				folderId: "outbox",
			});
			await request("/seed-newer-unknown", {
				deliveryId: "delivery-bounce-then-unknown",
			});
			await request("/seed", {
				deliveryId: "delivery-malformed-attempt-core",
				emailId: "email-malformed-attempt-core",
				folderId: "outbox",
				corruptAttemptCore: true,
			});
			await request("/seed", {
				deliveryId: "delivery-snapshot-missing",
				emailId: "email-snapshot-missing",
				folderId: "outbox",
				snapshotState: "missing",
				withSourceDraft: true,
			});
			await request("/seed", {
				deliveryId: "delivery-snapshot-invalid",
				emailId: "email-snapshot-invalid",
				folderId: "outbox",
				snapshotState: "invalid",
				withSourceDraft: true,
			});
			await request("/seed-cancelled", {
				deliveryId: "delivery-cancelled",
				emailId: "email-cancelled",
			});
			await request("/seed-malformed-unknown-retry", {
				deliveryId: "delivery-malformed-unknown-retry",
				emailId: "email-malformed-unknown-retry",
			});
			await request("/seed-malformed-unknown-retry", {
				deliveryId: "delivery-invalid-retry-origin",
				emailId: "email-invalid-retry-origin",
				retryOriginStatus: "sent",
			});
			await request("/provider-event", {
				eventId: "event-mixed-bounce",
				deliveryId: "delivery-mixed",
				attemptId: "attempt-delivery-mixed",
				sesMessageId: "ses-recovery-1",
				eventType: "bounce",
				recipientHashes: [await recipientHash("one@example.com")],
				occurredAt: "2026-07-16T01:01:00.000Z",
				receivedAt: "2026-07-16T01:01:01.000Z",
			});
			await request("/provider-event", {
				eventId: "event-unscoped-bounce",
				deliveryId: "delivery-unscoped-bounce",
				attemptId: "attempt-delivery-unscoped-bounce",
				sesMessageId: "ses-recovery-1",
				eventType: "bounce",
				recipientHashes: [],
				occurredAt: "2026-07-16T01:01:00.000Z",
				receivedAt: "2026-07-16T01:01:01.000Z",
			});
			await request("/provider-event", {
				eventId: "event-full-bounce",
				deliveryId: "delivery-full-bounce",
				attemptId: "attempt-delivery-full-bounce",
				sesMessageId: "ses-recovery-1",
				eventType: "bounce",
				recipientHashes: [
					await recipientHash("one@example.com"),
					await recipientHash("two@example.com"),
				],
				occurredAt: "2026-07-16T01:01:00.000Z",
				receivedAt: "2026-07-16T01:01:01.000Z",
			});
			await request("/provider-event", {
				eventId: "event-complaint",
				deliveryId: "delivery-complaint",
				attemptId: "attempt-delivery-complaint",
				sesMessageId: "ses-recovery-1",
				eventType: "complaint",
				recipientHashes: [],
				occurredAt: "2026-07-16T01:01:00.000Z",
				receivedAt: "2026-07-16T01:01:01.000Z",
			});
			await request("/alarm");
			const malformedRetry = await request<{
				status: string;
				retryOriginStatus: string | null;
				failedAt: string | null;
				unknownAt: string | null;
				lastErrorCode: string | null;
			}>("/malformed-retry-state?delivery=delivery-malformed-unknown-retry");
			assert.equal(malformedRetry.status, "unknown");
			assert.equal(malformedRetry.retryOriginStatus, null);
			assert.equal(malformedRetry.failedAt, null);
			assert.ok(malformedRetry.unknownAt);
			assert.equal(
				malformedRetry.lastErrorCode,
				"outbound_dispatch_metadata_invalid",
			);
			const invalidRetryOrigin = await request<{
				status: string;
				retryOriginStatus: string | null;
				failedAt: string | null;
				unknownAt: string | null;
				lastErrorCode: string | null;
			}>("/malformed-retry-state?delivery=delivery-invalid-retry-origin");
			assert.equal(invalidRetryOrigin.status, "unknown");
			assert.equal(invalidRetryOrigin.retryOriginStatus, null);
			assert.equal(invalidRetryOrigin.failedAt, null);
			assert.ok(invalidRetryOrigin.unknownAt);
			assert.equal(
				invalidRetryOrigin.lastErrorCode,
				"outbound_dispatch_metadata_invalid",
			);
			assert.deepEqual(
				await request(
					"/accepted-aggregate-state?delivery=delivery-multi-accepted",
				),
				{
					status: "sent",
					retryOriginStatus: null,
					dispatchPhase: null,
					activeAttemptId: null,
					leaseToken: null,
					leaseExpiresAt: null,
					nextAttemptAt: null,
					acceptedAttemptCount: 2,
					duplicateAcceptanceAt: "2026-07-16T01:02:00.000Z",
					sesMessageId: "ses-recovery-2",
					failedAt: null,
					unknownAt: null,
					cancelledAt: null,
					lastErrorCode: "ses_partial_bounce",
					lastErrorMessage: null,
					recoveryAttemptId: "attempt-2-delivery-multi-accepted",
					recoverySesMessageId: "ses-recovery-2",
				},
			);
			assert.deepEqual(
				await request("/state?delivery=delivery-malformed-provider-evidence"),
				{
					state: "parked",
					generation: 1,
					attemptCount: 0,
					lastErrorCode: "outbound_repair_evidence_mismatch",
					folderId: "outbox",
					deliveryStatus: "bounced",
					deliveryErrorCode: null,
					acceptedActivities: 0,
					parkedActivities: 1,
					recipientInteractions: 0,
				},
			);
			const malformedAttemptCore = await request<{
				state: string;
				lastErrorCode: string;
				deliveryStatus: string;
			}>("/state?delivery=delivery-malformed-attempt-core");
			assert.equal(malformedAttemptCore.state, "parked");
			assert.equal(
				malformedAttemptCore.lastErrorCode,
				"outbound_repair_evidence_mismatch",
			);
			assert.equal(malformedAttemptCore.deliveryStatus, "bounced");
			assert.deepEqual(
				await request("/integrity-state?delivery=delivery-snapshot-missing"),
				{
					state: "parked",
					generation: 1,
					lastErrorCode: "snapshot_missing",
					messageProjectedAt: null,
					draftConsumedAt: null,
					completedAt: null,
					folderId: "outbox",
					sourceDraftCount: 1,
					acceptedActivities: 0,
					recipientInteractions: 0,
				},
			);
			const invalidSnapshotBefore = await request<{
				state: string;
				generation: number;
				lastErrorCode: string;
				messageProjectedAt: null;
				draftConsumedAt: null;
				completedAt: null;
				folderId: string;
				sourceDraftCount: number;
				acceptedActivities: number;
				recipientInteractions: number;
			}>("/integrity-state?delivery=delivery-snapshot-invalid");
			assert.deepEqual(invalidSnapshotBefore, {
				state: "parked",
				generation: 1,
				lastErrorCode: "outbound_snapshot_invalid",
				messageProjectedAt: null,
				draftConsumedAt: null,
				completedAt: null,
				folderId: "outbox",
				sourceDraftCount: 1,
				acceptedActivities: 0,
				recipientInteractions: 0,
			});
			const bounceThenUnknown = await request<{
				deliveryStatus: string;
				deliveryErrorCode: string;
			}>("/state?delivery=delivery-bounce-then-unknown");
			assert.equal(bounceThenUnknown.deliveryStatus, "unknown");
			assert.equal(
				bounceThenUnknown.deliveryErrorCode,
				"ses_duplicate_attempt_outcome_unknown",
			);

			assert.deepEqual(
				await request("/state?delivery=delivery-bounced"),
				{
					state: "completed",
					generation: 0,
					attemptCount: 0,
					lastErrorCode: null,
					folderId: "sent",
					deliveryStatus: "bounced",
					deliveryErrorCode: "ses_bounce",
					acceptedActivities: 1,
					parkedActivities: 0,
					recipientInteractions: 1,
				},
			);
			const mixed = await request<{
				deliveryStatus: string;
				deliveryErrorCode: string | null;
				folderId: string;
			}>("/state?delivery=delivery-mixed");
			assert.equal(mixed.deliveryStatus, "sent");
			assert.equal(mixed.deliveryErrorCode, "ses_partial_bounce");
			assert.equal(mixed.folderId, "sent");
			const unscoped = await request<{
				deliveryStatus: string;
				deliveryErrorCode: string | null;
				folderId: string;
			}>("/state?delivery=delivery-unscoped-bounce");
			assert.equal(unscoped.deliveryStatus, "unknown");
			assert.equal(unscoped.deliveryErrorCode, "ses_bounce_scope_unknown");
			assert.equal(unscoped.folderId, "sent");
			const cancelledUnknownRetry = await request<{
				delivery: { status: string; lastErrorCode?: string };
				retryCancellationRestored?: boolean;
				recoveredDraftId?: string;
			}>("/retry-then-cancel-unknown", {
				deliveryId: "delivery-unscoped-bounce",
			});
			assert.equal(cancelledUnknownRetry.retryCancellationRestored, true);
			assert.equal(cancelledUnknownRetry.delivery.status, "unknown");
			assert.equal(
				cancelledUnknownRetry.delivery.lastErrorCode,
				"outbound_retry_cancelled_restored_unknown",
			);
			assert.equal(cancelledUnknownRetry.recoveredDraftId, undefined);
			const preservedUnknown = await request<{
				folderId: string;
				recoveredDraftCount: number;
			}>(
				"/cancelled-state?delivery=delivery-unscoped-bounce&email=email-unscoped-bounce",
			);
			assert.equal(preservedUnknown.folderId, "sent");
			assert.equal(preservedUnknown.recoveredDraftCount, 0);
			const fullBounce = await request<{
				deliveryStatus: string;
				deliveryErrorCode: string | null;
			}>("/state?delivery=delivery-full-bounce");
			assert.equal(fullBounce.deliveryStatus, "bounced");
			assert.equal(fullBounce.deliveryErrorCode, "ses_bounce");
			const complaint = await request<{
				deliveryStatus: string;
				deliveryErrorCode: string | null;
			}>("/state?delivery=delivery-complaint");
			assert.equal(complaint.deliveryStatus, "sent");
			assert.equal(complaint.deliveryErrorCode, "ses_complaint");
			const userMoved = await request<{
				folderId: string;
				acceptedActivities: number;
				recipientInteractions: number;
			}>("/state?delivery=delivery-user-moved");
			assert.equal(userMoved.folderId, "archive");
			assert.equal(userMoved.acceptedActivities, 1);
			assert.equal(userMoved.recipientInteractions, 1);
			assert.deepEqual(
				await request("/state?delivery=delivery-invalid"),
				{
					state: "parked",
					generation: 1,
					attemptCount: 0,
					lastErrorCode: "outbound_repair_evidence_mismatch",
					folderId: "outbox",
					deliveryStatus: "bounced",
					deliveryErrorCode: null,
					acceptedActivities: 0,
					parkedActivities: 1,
					recipientInteractions: 0,
				},
			);

			const parked = await request<{
				recoveries: Array<{
					deliveryId: string;
					generation: number;
					evidence: {
						acceptedAttemptCount: number;
						distinctProviderIdentityCount: number;
						status: string;
					};
				}>;
				nextCursor: string | null;
			}>("/parked");
			const invalidRecovery = parked.recoveries.find(
				(recovery) => recovery.deliveryId === "delivery-invalid",
			);
			assert.equal(invalidRecovery?.generation, 1);
			assert.deepEqual(invalidRecovery?.evidence, {
				acceptedAttemptCount: 2,
				distinctProviderIdentityCount: 2,
				status: "duplicate_acceptance",
			});

			const repair = await request<{
				status: string;
				generation: number;
			}>("/repair", {
				deliveryId: "delivery-invalid",
				expectedGeneration: invalidRecovery!.generation,
			});
			assert.equal(repair.status, "committed");
			assert.equal(repair.generation, 2);
			await request("/alarm");
			const repairedInvalid = await request<{
				state: string;
				deliveryStatus: string;
			}>("/state?delivery=delivery-invalid");
			assert.equal(repairedInvalid.state, "completed");
			assert.equal(repairedInvalid.deliveryStatus, "sent");

			await request("/restore-snapshot", { emailId: "email-snapshot-missing" });
			const repairedSnapshot = await request<{ status: string; generation: number }>(
				"/repair",
				{
					deliveryId: "delivery-snapshot-missing",
					expectedGeneration: 1,
				},
			);
			assert.equal(repairedSnapshot.status, "committed");
			await request("/alarm");
			const completedSnapshot = await request<{
				state: string;
				messageProjectedAt: string;
				draftConsumedAt: string;
				completedAt: string;
				folderId: string;
				sourceDraftCount: number;
				acceptedActivities: number;
				recipientInteractions: number;
			}>("/integrity-state?delivery=delivery-snapshot-missing");
			assert.equal(completedSnapshot.state, "completed");
			assert.ok(completedSnapshot.messageProjectedAt);
			assert.ok(completedSnapshot.draftConsumedAt);
			assert.ok(completedSnapshot.completedAt);
			assert.equal(completedSnapshot.folderId, "sent");
			assert.equal(completedSnapshot.sourceDraftCount, 0);
			assert.equal(completedSnapshot.acceptedActivities, 1);
			assert.equal(completedSnapshot.recipientInteractions, 1);
			assert.deepEqual(
				await request("/integrity-state?delivery=delivery-snapshot-invalid"),
				invalidSnapshotBefore,
			);

			await request("/corrupt-recovery", { deliveryId: "delivery-invalid" });
			await request("/alarm");
			const reparking = await request<{
				state: string;
				generation: number;
				parkedActivities: number;
			}>("/state?delivery=delivery-invalid");
			assert.equal(reparking.state, "parked");
			assert.equal(reparking.generation, 3);
			assert.equal(reparking.parkedActivities, 2);

			const cancelled = await request<{
				delivery: { lastErrorCode?: string };
				recoveredDraftId?: string;
			}>("/finish-cancelled", { deliveryId: "delivery-cancelled" });
			assert.equal(cancelled.delivery.lastErrorCode, undefined);
			assert.equal(cancelled.recoveredDraftId, "draft_recovered_email-cancelled");
			assert.deepEqual(
				await request(
					"/cancelled-state?delivery=delivery-cancelled&email=email-cancelled",
				),
				{
					attemptCount: 0,
					lastErrorCode: null,
					lastErrorMessage: null,
					folderId: "_cancelled_outbound",
					recoveredDraftCount: 1,
				},
			);
		} finally {
			await runtime?.dispose();
			await rm(outputDirectory, { recursive: true, force: true });
		}
	},
);
