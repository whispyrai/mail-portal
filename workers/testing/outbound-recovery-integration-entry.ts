import { Folders } from "../../shared/folders.ts";
import { MailboxDO } from "../durableObject/index.ts";
import {
	serializeOutboundSnapshot,
	type PendingOutboundAttachment,
} from "../durableObject/outbound-storage.ts";
import {
	attachmentKey,
	attachmentSha256,
	outboundAttachmentByteIdentities,
} from "../lib/attachments.ts";
import type {
	EnqueueOutboundCommand,
	OutboundDeliveryActor,
} from "../lib/outbound-delivery-contract.ts";
import type { Env } from "../types.ts";

export class OutboundRecoveryMailboxDO extends MailboxDO {
	async exerciseReplayAttachmentOwnershipForTest() {
		const authoritativeEmailId = "email-replay-authoritative";
		const attemptedEmailId = "email-replay-attempted";
		const attachmentId = "attachment-replay";
		const filename = "contract.txt";
		const bytes = new Uint8Array([114, 101, 112, 108, 97, 121]).buffer;
		const digest = await attachmentSha256(bytes);
		const attachment = (emailId: string): PendingOutboundAttachment => ({
			id: attachmentId,
			email_id: emailId,
			filename,
			mimetype: "text/plain",
			size: bytes.byteLength,
			disposition: "attachment",
			content_sha256: digest.hex,
		});
		const authoritativeAttachment = attachment(authoritativeEmailId);
		const attemptedAttachment = attachment(attemptedEmailId);
		const command: EnqueueOutboundCommand = {
			idempotencyKey: "send-replay-attachment-ownership",
			commandFingerprint: "d".repeat(64),
			source: "ui",
			actor: { kind: "user", id: "user-1" },
			requestedAt: "2099-01-01T00:00:00.000Z",
			undoUntil: "2099-01-01T00:00:10.000Z",
			snapshot: {
				mailboxId: "team@example.com",
				kind: "compose",
				to: ["customer@example.com"],
				cc: [],
				bcc: [],
				from: "team@example.com",
				subject: "Replay ownership",
				text: "Exact replay ownership",
				threadId: "thread-replay-ownership",
				attachmentIds: [attachmentId],
				attachmentByteIdentities:
					outboundAttachmentByteIdentities([authoritativeAttachment]),
			},
		};
		const authoritativeKey = attachmentKey(
			authoritativeEmailId,
			attachmentId,
			filename,
		);
		const attemptedKey = attachmentKey(
			attemptedEmailId,
			attachmentId,
			filename,
		);
		const put = (key: string) => this.env.BUCKET.put(key, bytes, {
			sha256: digest.binary,
			customMetadata: { contentSha256: digest.hex },
		});

		await this.recordOutboundPromotionIntent(authoritativeEmailId, [authoritativeKey]);
		await put(authoritativeKey);
		await this.enqueueOutbound(
			command,
			[authoritativeAttachment],
			authoritativeEmailId,
		);

		await this.recordOutboundPromotionIntent(attemptedEmailId, [attemptedKey]);
		await put(attemptedKey);
		const replay = await this.enqueueOutbound(
			command,
			[attemptedAttachment],
			attemptedEmailId,
		);
		await put(attemptedKey);

		return {
			replayed: replay.replayed,
			deliveryEmailId: replay.delivery.emailId,
			authoritativeEmailId,
			attemptedEmailId,
			authoritativeKey,
			attemptedKey,
		};
	}

	async replayAttachmentCleanupStateForTest(
		authoritativeKey: string,
		attemptedKey: string,
	) {
		return {
			rows: [...this.ctx.storage.sql.exec(
				`SELECT r2_key AS r2Key, email_id AS emailId, state
				 FROM r2_deletion_outbox
				 WHERE r2_key IN (?, ?)
				 ORDER BY r2_key`,
				authoritativeKey,
				attemptedKey,
			)],
			authoritativeExists:
				(await this.env.BUCKET.head(authoritativeKey)) !== null,
			attemptedExists: (await this.env.BUCKET.head(attemptedKey)) !== null,
		};
	}

	makeReplayAttachmentCleanupDueForTest(attemptedKey: string) {
		this.ctx.storage.sql.exec(
			`UPDATE r2_deletion_outbox
			 SET next_attempt_at = ?
			 WHERE r2_key = ? AND state = 'pending'`,
			new Date(Date.now() - 1).toISOString(),
			attemptedKey,
		);
		return { status: "due" as const };
	}

	async seedAcceptanceRecoveryForTest(input: {
		deliveryId: string;
		emailId: string;
		folderId: string;
		state?: "pending" | "parked";
		acceptedAt?: string;
		corruptAttemptIdentity?: boolean;
		corruptProviderEvidence?: boolean;
		corruptAttemptCore?: boolean;
		recipients?: string[];
		snapshotState?: "valid" | "missing" | "invalid";
		withSourceDraft?: boolean;
	}) {
		const at = "2026-07-16T01:00:00.000Z";
		await this.createEmail(
			input.folderId,
			{
				id: input.emailId,
				subject: "Recovery fixture",
				sender: "team@example.com",
				recipient: "customer@example.com",
				date: at,
				body: "<p>Recovery fixture</p>",
				read: true,
				starred: false,
				thread_id: "thread-recovery",
			},
			[],
			{ kind: "system" },
		);
		const validSnapshot = serializeOutboundSnapshot({
				mailboxId: "team@example.com",
				kind: "compose",
				to: input.recipients ?? ["customer@example.com"],
				cc: [],
				bcc: [],
				from: "team@example.com",
				subject: "Recovery fixture",
				html: "<p>Recovery fixture</p>",
				threadId: "thread-recovery",
				attachmentIds: [],
				attachmentByteIdentities: [],
			});
		this.ctx.storage.sql.exec(
			"UPDATE emails SET raw_headers = ? WHERE id = ?",
			input.snapshotState === "missing"
				? null
				: input.snapshotState === "invalid"
					? "{malformed"
					: validSnapshot,
			input.emailId,
		);
		const sourceDraftId = input.withSourceDraft ? `draft-${input.emailId}` : null;
		if (sourceDraftId) {
			await this.createEmail(
				Folders.DRAFT,
				{
					id: sourceDraftId,
					subject: "Source draft",
					sender: "team@example.com",
					recipient: "customer@example.com",
					date: at,
					body: "Source draft",
					read: true,
					starred: false,
					thread_id: `thread-${sourceDraftId}`,
				},
				[],
				{ kind: "system" },
			);
		}
		this.ctx.storage.sql.exec(
			`INSERT INTO outbound_deliveries (
				id, email_id, source_draft_id, source_draft_version,
				idempotency_key, command_fingerprint, kind, source,
				actor_kind, actor_id, status, available_at, undo_until,
				attempt_count, max_attempts, preflight_deferral_count,
				cancellation_recovery_attempt_count, accepted_attempt_count,
				created_at, updated_at, sent_at, ses_message_id
			) VALUES (?, ?, ?, ?, ?, ?, 'compose', 'ui', 'user', 'user-1', 'bounced',
				?, ?, 1, 4, 0, 0, 1, ?, ?, ?, 'ses-recovery-1')`,
			input.deliveryId,
			input.emailId,
			sourceDraftId,
			sourceDraftId ? 1 : null,
			`key-${input.deliveryId}`,
			"a".repeat(64),
			at,
			at,
			at,
			at,
			at,
		);
		this.ctx.storage.sql.exec(
			`INSERT INTO outbound_delivery_attempts (
				id, delivery_id, attempt_number, status, lease_token,
				started_at, finished_at, ses_message_id, provider_state,
				provider_event_at, provider_event_id
			) VALUES (?, ?, 1, 'accepted', ?, ?, ?, 'ses-recovery-1', 'bounced', ?, ?)`,
			`attempt-${input.deliveryId}`,
			input.deliveryId,
			input.corruptAttemptCore ? "" : "lease-1",
			at,
			at,
			input.corruptProviderEvidence ? null : at,
			input.corruptProviderEvidence ? null : `event-seed-${input.deliveryId}`,
		);
		if (!input.corruptProviderEvidence) {
			this.ctx.storage.sql.exec(
				`INSERT INTO outbound_provider_events (
					id, attempt_id, ses_message_id, event_class,
					recipient_hashes_json, occurred_at, received_at
				) VALUES (?, ?, 'ses-recovery-1', 'bounce', '[]', ?, ?)`,
				`event-seed-${input.deliveryId}`,
				`attempt-${input.deliveryId}`,
				at,
				at,
			);
		}
		this.ctx.storage.sql.exec(
			`INSERT INTO outbound_acceptance_recovery (
				delivery_id, email_id, attempt_id, ses_message_id, accepted_at,
				source_draft_id, source_draft_version,
				actor_kind, actor_id, state, generation, attempt_count,
				next_attempt_at, last_error_code, created_at, updated_at
			) VALUES (?, ?, ?, 'ses-recovery-1', ?, ?, ?, 'user', 'user-1', ?, 0, 0, ?, ?, ?, ?)`,
			input.deliveryId,
			input.emailId,
			input.corruptAttemptIdentity ? null : `attempt-${input.deliveryId}`,
			input.acceptedAt ?? at,
			sourceDraftId,
			sourceDraftId ? 1 : null,
			input.state ?? "pending",
			input.state === "parked" ? null : at,
			input.state === "parked" ? "outbound_projection_retry_exhausted" : null,
			at,
			at,
		);
		return { status: "seeded" as const };
	}

	restoreAcceptanceSnapshotForTest(emailId: string) {
		this.ctx.storage.sql.exec(
			"UPDATE emails SET raw_headers = ? WHERE id = ?",
			serializeOutboundSnapshot({
				mailboxId: "team@example.com",
				kind: "compose",
				to: ["customer@example.com"],
				cc: [],
				bcc: [],
				from: "team@example.com",
				subject: "Recovery fixture",
				html: "<p>Recovery fixture</p>",
				threadId: "thread-recovery",
				attachmentIds: [],
				attachmentByteIdentities: [],
			}),
			emailId,
		);
		return { status: "restored" as const };
	}

	async seedParkedCancellationForTest(input: {
		deliveryId: string;
		emailId: string;
	}) {
		const at = "2026-07-16T01:00:00.000Z";
		await this.createEmail(
			Folders.OUTBOX,
			{
				id: input.emailId,
				subject: "Cancelled fixture",
				sender: "team@example.com",
				recipient: "customer@example.com",
				date: at,
				body: "<p>Cancelled fixture</p>",
				read: true,
				starred: false,
				thread_id: `thread-${input.emailId}`,
			},
			[],
			{ kind: "system" },
		);
		this.ctx.storage.sql.exec(
			"UPDATE emails SET raw_headers = ? WHERE id = ?",
			serializeOutboundSnapshot({
				mailboxId: "team@example.com",
				kind: "compose",
				to: ["customer@example.com"],
				cc: [],
				bcc: [],
				from: "team@example.com",
				subject: "Cancelled fixture",
				html: "<p>Cancelled fixture</p>",
				threadId: `thread-${input.emailId}`,
				attachmentIds: [],
				attachmentByteIdentities: [],
			}),
			input.emailId,
		);
		this.ctx.storage.sql.exec(
			`INSERT INTO outbound_deliveries (
				id, email_id, idempotency_key, command_fingerprint, kind, source,
				actor_kind, actor_id, status, available_at, undo_until,
				attempt_count, max_attempts, preflight_deferral_count,
				cancellation_recovery_attempt_count, accepted_attempt_count,
				created_at, updated_at, cancelled_at, last_error_code, last_error_message
			) VALUES (?, ?, ?, ?, 'compose', 'ui', 'user', 'user-1', 'cancelled',
				?, ?, 0, 4, 0, 6, 0, ?, ?, ?,
				'outbound_cancellation_recovery_parked',
				'Cancellation is committed, but draft recovery requires explicit repair.')`,
			input.deliveryId,
			input.emailId,
			`key-${input.deliveryId}`,
			"b".repeat(64),
			at,
			at,
			at,
			at,
			at,
		);
		return { status: "seeded" as const };
	}

	seedSecondAcceptedAttemptForTest(input: { deliveryId: string }) {
		const at = "2026-07-16T01:02:00.000Z";
		this.ctx.storage.sql.exec(
			`INSERT INTO outbound_delivery_attempts (
				id, delivery_id, attempt_number, status, lease_token,
				started_at, finished_at, ses_message_id, provider_state
			) VALUES (?, ?, 2, 'accepted', 'lease-2', ?, ?, 'ses-recovery-2', 'none')`,
			`attempt-2-${input.deliveryId}`,
			input.deliveryId,
			at,
			at,
		);
		return { status: "seeded" as const };
	}

	seedNewerUnknownAttemptForTest(input: { deliveryId: string }) {
		const at = "2026-07-16T01:02:00.000Z";
		this.ctx.storage.sql.exec(
			`INSERT INTO outbound_delivery_attempts (
				id, delivery_id, attempt_number, status, lease_token,
				started_at, finished_at, error_code, provider_state
			) VALUES (?, ?, 2, 'unknown', 'lease-2', ?, ?, 'ses_response_unknown', 'none')`,
			`attempt-unknown-${input.deliveryId}`,
			input.deliveryId,
			at,
			at,
		);
		return { status: "seeded" as const };
	}

	poisonAcceptedTerminalForTest(input: { deliveryId: string }) {
		const at = "2026-07-16T01:02:00.000Z";
		this.ctx.storage.sql.exec(
			`UPDATE outbound_deliveries
			 SET status = 'sent', retry_origin_status = 'unknown',
				dispatch_phase = 'provider', active_attempt_id = ?,
				lease_token = 'poison-lease', lease_expires_at = ?, next_attempt_at = ?,
				accepted_attempt_count = 2, duplicate_acceptance_at = NULL,
				ses_message_id = 'ses-recovery-2', sent_at = ?, failed_at = ?,
				unknown_at = NULL, cancelled_at = ?, last_error_code = 'poisoned',
				last_error_message = 'Poisoned terminal metadata'
			 WHERE id = ?`,
			`attempt-2-${input.deliveryId}`,
			at,
			at,
			at,
			at,
			at,
			input.deliveryId,
		);
		return { status: "poisoned" as const };
	}

	acceptedAggregateStateForTest(deliveryId: string) {
		return [...this.ctx.storage.sql.exec(
			`SELECT od.status, od.retry_origin_status AS retryOriginStatus,
				od.dispatch_phase AS dispatchPhase, od.active_attempt_id AS activeAttemptId,
				od.lease_token AS leaseToken, od.lease_expires_at AS leaseExpiresAt,
				od.next_attempt_at AS nextAttemptAt,
				od.accepted_attempt_count AS acceptedAttemptCount,
				od.duplicate_acceptance_at AS duplicateAcceptanceAt,
				od.ses_message_id AS sesMessageId, od.failed_at AS failedAt,
				od.unknown_at AS unknownAt, od.cancelled_at AS cancelledAt,
				od.last_error_code AS lastErrorCode,
				od.last_error_message AS lastErrorMessage,
				ar.attempt_id AS recoveryAttemptId,
				ar.ses_message_id AS recoverySesMessageId
			 FROM outbound_deliveries od
			 JOIN outbound_acceptance_recovery ar ON ar.delivery_id = od.id
			 WHERE od.id = ?`,
			deliveryId,
		)][0];
	}

	async seedMalformedUnknownRetryForTest(input: {
		deliveryId: string;
		emailId: string;
		retryOriginStatus?: string;
	}) {
		const at = "2026-07-16T01:00:00.000Z";
		await this.createEmail(
			Folders.OUTBOX,
			{
				id: input.emailId,
				subject: "Malformed retry fixture",
				sender: "team@example.com",
				recipient: "customer@example.com",
				date: at,
				body: "<p>Malformed retry fixture</p>",
				read: true,
				starred: false,
				thread_id: `thread-${input.emailId}`,
			},
			[],
			{ kind: "system" },
		);
		this.ctx.storage.sql.exec(
			`INSERT INTO outbound_deliveries (
				id, email_id, idempotency_key, command_fingerprint, kind, source,
				actor_kind, actor_id, status, retry_origin_status, available_at,
				undo_until, next_attempt_at, attempt_count, max_attempts,
				preflight_deferral_count, cancellation_recovery_attempt_count,
				accepted_attempt_count, created_at, updated_at, unknown_at
			) VALUES (?, ?, ?, ?, 'compose', 'ui', 'user', 'user-1', 'retrying',
				?, ?, ?, 'not-a-time', 1, 4, 0, 0, 0, ?, ?, ?)`,
			input.deliveryId,
			input.emailId,
			`key-${input.deliveryId}`,
			"c".repeat(64),
			input.retryOriginStatus ?? "unknown",
			at,
			at,
			at,
			at,
			at,
		);
		return { status: "seeded" as const };
	}

	malformedRetryStateForTest(deliveryId: string) {
		return [...this.ctx.storage.sql.exec(
			`SELECT status, retry_origin_status AS retryOriginStatus,
				failed_at AS failedAt, unknown_at AS unknownAt, last_error_code AS lastErrorCode
			 FROM outbound_deliveries WHERE id = ?`,
			deliveryId,
		)][0];
	}

	async runOutboundAlarmForTest() {
		await this.alarm();
		return { status: "ran" as const };
	}

	acceptanceRecoveryStateForTest(deliveryId: string) {
		return [
			...this.ctx.storage.sql.exec(
				`SELECT ar.state, ar.generation, ar.attempt_count AS attemptCount,
					ar.last_error_code AS lastErrorCode, e.folder_id AS folderId,
					od.status AS deliveryStatus, od.last_error_code AS deliveryErrorCode,
					(SELECT COUNT(*) FROM activity_events a
					 WHERE a.entity_id = ar.email_id
						AND a.action = 'outbound_provider_accepted') AS acceptedActivities,
					(SELECT COUNT(*) FROM activity_events a
					 WHERE a.entity_id = ar.delivery_id
						AND a.action = 'outbound_acceptance_recovery_parked') AS parkedActivities,
					(SELECT COUNT(*) FROM recipient_interactions ri
					 WHERE ri.source_email_id = ar.email_id
						AND ri.direction = 'sent') AS recipientInteractions
				 FROM outbound_acceptance_recovery ar
				 JOIN emails e ON e.id = ar.email_id
				 JOIN outbound_deliveries od ON od.id = ar.delivery_id
				 WHERE ar.delivery_id = ?`,
				deliveryId,
			),
		][0];
	}

	acceptanceRecoveryIntegrityStateForTest(deliveryId: string) {
		return [...this.ctx.storage.sql.exec(
			`SELECT ar.state, ar.generation, ar.last_error_code AS lastErrorCode,
				ar.message_projected_at AS messageProjectedAt,
				ar.draft_consumed_at AS draftConsumedAt,
				ar.completed_at AS completedAt, e.folder_id AS folderId,
				(SELECT COUNT(*) FROM emails d
				 WHERE d.id = ar.source_draft_id
					AND d.folder_id = 'draft'
					AND d.draft_version = ar.source_draft_version) AS sourceDraftCount,
				(SELECT COUNT(*) FROM activity_events a
				 WHERE a.entity_id = ar.email_id
					AND a.action = 'outbound_provider_accepted') AS acceptedActivities,
				(SELECT COUNT(*) FROM recipient_interactions ri
				 WHERE ri.source_email_id = ar.email_id
					AND ri.direction = 'sent') AS recipientInteractions
			 FROM outbound_acceptance_recovery ar
			 JOIN emails e ON e.id = ar.email_id
			 WHERE ar.delivery_id = ?`,
			deliveryId,
		)][0];
	}

	listParkedAcceptanceForTest(afterDeliveryId?: string) {
		return this.listParkedOutboundAcceptanceRecoveries(afterDeliveryId, 50);
	}

	async finishCancelledRecoveryForTest(deliveryId: string) {
		return this.cancelOutboundDelivery(deliveryId, { kind: "user", id: "admin-1" });
	}

	async retryUnknownForTest(deliveryId: string) {
		return this.retryOutboundDelivery(
			deliveryId,
			{ kind: "user", id: "admin-1" },
			true,
		);
	}

	async retryThenCancelUnknownForTest(deliveryId: string) {
		await this.retryUnknownForTest(deliveryId);
		return this.cancelOutboundDelivery(deliveryId, {
			kind: "user",
			id: "admin-1",
		});
	}

	cancelledRecoveryStateForTest(deliveryId: string, emailId: string) {
		return [...this.ctx.storage.sql.exec(
			`SELECT od.cancellation_recovery_attempt_count AS attemptCount,
				od.last_error_code AS lastErrorCode,
				od.last_error_message AS lastErrorMessage,
				e.folder_id AS folderId,
				(SELECT COUNT(*) FROM emails recovered
				 WHERE recovered.id = 'draft_recovered_' || ?2
					AND recovered.folder_id = 'draft') AS recoveredDraftCount
			 FROM outbound_deliveries od
			 JOIN emails e ON e.id = od.email_id
			 WHERE od.id = ?1`,
			deliveryId,
			emailId,
		)][0];
	}

	corruptAcceptanceRecoveryForTest(deliveryId: string) {
		this.ctx.storage.sql.exec(
			`UPDATE outbound_acceptance_recovery
			 SET state = 'pending', attempt_id = NULL, next_attempt_at = ?,
				completed_at = NULL, message_projected_at = NULL
			 WHERE delivery_id = ?`,
			new Date().toISOString(),
			deliveryId,
		);
		return { status: "corrupted" as const };
	}

	async recordProviderEventForTest(input: Parameters<MailboxDO["recordSesProviderEvent"]>[0]) {
		return this.recordSesProviderEvent(input);
	}

	async repairAcceptanceForTest(
		deliveryId: string,
		expectedGeneration: number,
		actor: OutboundDeliveryActor,
	) {
		return this.recoverParkedOutboundAcceptance(
			deliveryId,
			{
				operationKey: `repair-${deliveryId}`,
				expectedGeneration,
				action: "reconcile_from_ledger",
			},
			actor,
		);
	}
}

export default {
	async fetch(request: Request, env: Env) {
		const url = new URL(request.url);
		const mailboxId = url.searchParams.get("mailbox") ?? "team@example.com";
		const stub = env.MAILBOX.get(
			env.MAILBOX.idFromName(mailboxId),
		) as DurableObjectStub<OutboundRecoveryMailboxDO>;
			if (url.pathname === "/seed") {
			return Response.json(
				await stub.seedAcceptanceRecoveryForTest(await request.json()),
			);
			}
			if (url.pathname === "/exercise-replay-attachment-ownership") {
				return Response.json(
					await stub.exerciseReplayAttachmentOwnershipForTest(),
				);
			}
			if (url.pathname === "/replay-attachment-cleanup-state") {
				return Response.json(
					await stub.replayAttachmentCleanupStateForTest(
						url.searchParams.get("authoritativeKey") ?? "",
						url.searchParams.get("attemptedKey") ?? "",
					),
				);
			}
			if (url.pathname === "/make-replay-attachment-cleanup-due") {
				const body = await request.json() as { attemptedKey: string };
				return Response.json(
					await stub.makeReplayAttachmentCleanupDueForTest(body.attemptedKey),
				);
			}
		if (url.pathname === "/seed-cancelled") {
			return Response.json(
				await stub.seedParkedCancellationForTest(await request.json()),
			);
		}
		if (url.pathname === "/seed-second-accepted") {
			return Response.json(
				await stub.seedSecondAcceptedAttemptForTest(await request.json()),
			);
		}
		if (url.pathname === "/seed-newer-unknown") {
			return Response.json(
				await stub.seedNewerUnknownAttemptForTest(await request.json()),
			);
		}
		if (url.pathname === "/poison-accepted-terminal") {
			return Response.json(
				await stub.poisonAcceptedTerminalForTest(await request.json()),
			);
		}
		if (url.pathname === "/seed-malformed-unknown-retry") {
			return Response.json(
				await stub.seedMalformedUnknownRetryForTest(await request.json()),
			);
		}
		if (url.pathname === "/alarm") {
			return Response.json(await stub.runOutboundAlarmForTest());
		}
		if (url.pathname === "/restore-snapshot") {
			const body = await request.json() as { emailId: string };
			return Response.json(await stub.restoreAcceptanceSnapshotForTest(body.emailId));
		}
		if (url.pathname === "/state") {
			return Response.json(
				await stub.acceptanceRecoveryStateForTest(url.searchParams.get("delivery") ?? ""),
			);
		}
		if (url.pathname === "/integrity-state") {
			return Response.json(
				await stub.acceptanceRecoveryIntegrityStateForTest(
					url.searchParams.get("delivery") ?? "",
				),
			);
		}
		if (url.pathname === "/malformed-retry-state") {
			return Response.json(
				await stub.malformedRetryStateForTest(
					url.searchParams.get("delivery") ?? "",
				),
			);
		}
		if (url.pathname === "/accepted-aggregate-state") {
			return Response.json(
				await stub.acceptedAggregateStateForTest(
					url.searchParams.get("delivery") ?? "",
				),
			);
		}
		if (url.pathname === "/parked") {
			return Response.json(
				await stub.listParkedAcceptanceForTest(
					url.searchParams.get("after") ?? undefined,
				),
			);
		}
		if (url.pathname === "/finish-cancelled") {
			const body = (await request.json()) as { deliveryId: string };
			return Response.json(
				await stub.finishCancelledRecoveryForTest(body.deliveryId),
			);
		}
		if (url.pathname === "/retry-then-cancel-unknown") {
			const body = (await request.json()) as { deliveryId: string };
			return Response.json(
				await stub.retryThenCancelUnknownForTest(body.deliveryId),
			);
		}
		if (url.pathname === "/cancelled-state") {
			return Response.json(
				await stub.cancelledRecoveryStateForTest(
					url.searchParams.get("delivery") ?? "",
					url.searchParams.get("email") ?? "",
				),
			);
		}
		if (url.pathname === "/corrupt-recovery") {
			const body = (await request.json()) as { deliveryId: string };
			return Response.json(
				await stub.corruptAcceptanceRecoveryForTest(body.deliveryId),
			);
		}
		if (url.pathname === "/repair") {
			const body = (await request.json()) as {
				deliveryId: string;
				expectedGeneration: number;
			};
			return Response.json(
				await stub.repairAcceptanceForTest(
					body.deliveryId,
					body.expectedGeneration,
					{ kind: "user", id: "admin-1" },
				),
			);
		}
		if (url.pathname === "/provider-event") {
			return Response.json(await stub.recordProviderEventForTest(await request.json()));
		}
		return Response.json({ error: "Not found" }, { status: 404 });
	},
};
