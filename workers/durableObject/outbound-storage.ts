// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { and, desc, eq, inArray, lte, or, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/durable-sqlite";
import * as schema from "../db/schema.ts";
import type {
	OutboundDeliveryAttempt,
	OutboundDeliveryStorage,
	OutboundDeliveryTransaction,
	StoredOutboundDelivery,
} from "../lib/outbound-delivery-service.ts";
import type {
	OutboundDeliveryActor,
	OutboundDeliveryKind,
	OutboundDeliverySource,
	OutboundDeliveryStatus,
	OutboundMessageSnapshot,
} from "../lib/outbound-delivery-contract.ts";
import { cancellationRecoveryPending } from "../lib/outbound-dispatch-policy.ts";
import { contentIdForDisposition } from "../../shared/content-id.ts";

const OUTBOX_FOLDER_ID = "outbox";
const SNAPSHOT_ENVELOPE_KIND = "mail-portal/outbound-snapshot";
const SNAPSHOT_ENVELOPE_VERSION = 1;
const PUBLIC_DELIVERY_HISTORY_LIMIT = 200;

type OutboundDatabase = ReturnType<typeof drizzle>;
type DeliveryRow = typeof schema.outboundDeliveries.$inferSelect;
type AttemptRow = typeof schema.outboundDeliveryAttempts.$inferSelect;

export interface PendingOutboundAttachment {
	id: string;
	email_id?: string;
	filename: string;
	mimetype: string;
	size: number;
	contentId?: string | null;
	content_id?: string | null;
	disposition?: string;
}

export interface DurableObjectOutboundStorageOptions {
	/**
	 * Supplies attachment metadata after R2 upload/promotion and before the
	 * immutable email snapshot is inserted. The adapter rejects a snapshot if
	 * any attachment ID is missing metadata.
	 */
	resolvePendingAttachments?: (
		emailId: string,
		snapshot: OutboundMessageSnapshot,
	) => readonly PendingOutboundAttachment[];
}

interface SnapshotEnvelope {
	kind: typeof SNAPSHOT_ENVELOPE_KIND;
	version: typeof SNAPSHOT_ENVELOPE_VERSION;
	snapshot: OutboundMessageSnapshot;
}

const DELIVERY_STATUSES = new Set<OutboundDeliveryStatus>([
	"queued",
	"sending",
	"retrying",
	"sent",
	"bounced",
	"failed",
	"unknown",
	"cancelled",
]);
const DELIVERY_KINDS = new Set<OutboundDeliveryKind>([
	"compose",
	"reply",
	"forward",
	"bulk",
]);
const DELIVERY_SOURCES = new Set<OutboundDeliverySource>([
	"ui",
	"api",
	"mcp",
	"agent",
	"rule",
	"bulk",
]);
const ACTOR_KINDS = new Set<OutboundDeliveryActor["kind"]>([
	"user",
	"mcp",
	"agent",
	"rule",
	"system",
]);
const ATTEMPT_STATUSES = new Set<OutboundDeliveryAttempt["status"]>([
	"sending",
	"accepted",
	"rejected_retryable",
	"rejected_permanent",
	"unknown",
]);

function requiredEnum<T extends string>(
	value: string,
	allowed: ReadonlySet<T>,
	field: string,
): T {
	if (!allowed.has(value as T)) {
		throw new Error(`Invalid ${field} in truthful outbox storage: ${value}`);
	}
	return value as T;
}

function optional(value: string | null): string | undefined {
	return value ?? undefined;
}

function sourceDraftFromStorage(
	draftId: string | null,
	draftVersion: number | null,
): Pick<StoredOutboundDelivery, "draftId" | "draftVersion"> {
	if (draftId === null && draftVersion === null) return {};
	if (
		!draftId ||
		draftVersion === null ||
		!Number.isInteger(draftVersion) ||
		draftVersion < 1
	) {
		throw new Error(
			"Source draft ID and version must both be valid in truthful outbox storage",
		);
	}
	return { draftId, draftVersion };
}

function hasValidSourceDraftReference(
	snapshot: Partial<OutboundMessageSnapshot>,
): boolean {
	const hasDraftId = snapshot.draftId !== undefined;
	const hasDraftVersion = snapshot.draftVersion !== undefined;
	if (!hasDraftId && !hasDraftVersion) return true;
	return (
		hasDraftId &&
		hasDraftVersion &&
		typeof snapshot.draftId === "string" &&
		snapshot.draftId.length > 0 &&
		typeof snapshot.draftVersion === "number" &&
		Number.isInteger(snapshot.draftVersion) &&
		snapshot.draftVersion >= 1
	);
}

export function serializeOutboundSnapshot(
	snapshot: OutboundMessageSnapshot,
): string {
	const envelope: SnapshotEnvelope = {
		kind: SNAPSHOT_ENVELOPE_KIND,
		version: SNAPSHOT_ENVELOPE_VERSION,
		snapshot: structuredClone(snapshot),
	};
	return JSON.stringify(envelope);
}

export function deserializeOutboundSnapshot(
	rawHeaders: string | null,
): OutboundMessageSnapshot | null {
	if (!rawHeaders) return null;

	let value: unknown;
	try {
		value = JSON.parse(rawHeaders);
	} catch {
		return null;
	}
	if (!value || typeof value !== "object") return null;

	const envelope = value as Partial<SnapshotEnvelope>;
	if (
		envelope.kind !== SNAPSHOT_ENVELOPE_KIND ||
		envelope.version !== SNAPSHOT_ENVELOPE_VERSION ||
		!envelope.snapshot ||
		typeof envelope.snapshot !== "object"
	) {
		return null;
	}

	const snapshot = envelope.snapshot as Partial<OutboundMessageSnapshot>;
	if (
		typeof snapshot.mailboxId !== "string" ||
		!hasValidSourceDraftReference(snapshot) ||
		!DELIVERY_KINDS.has(snapshot.kind as OutboundDeliveryKind) ||
		!Array.isArray(snapshot.to) ||
		!Array.isArray(snapshot.cc) ||
		!Array.isArray(snapshot.bcc) ||
		typeof snapshot.from !== "string" ||
		typeof snapshot.subject !== "string" ||
		typeof snapshot.threadId !== "string" ||
		!Array.isArray(snapshot.attachmentIds)
		|| (snapshot.sourceDraftAttachmentIds !== undefined &&
			(!Array.isArray(snapshot.sourceDraftAttachmentIds) ||
				snapshot.sourceDraftAttachmentIds.some((id) => typeof id !== "string")))
	) {
		return null;
	}

	return structuredClone(snapshot as OutboundMessageSnapshot);
}

export function deliveryRowToStored(
	row: DeliveryRow,
	mailboxId: string,
): StoredOutboundDelivery {
	return {
		id: row.id,
		emailId: row.email_id,
		...sourceDraftFromStorage(
			row.source_draft_id,
			row.source_draft_version,
		),
		mailboxId,
		kind: requiredEnum(row.kind, DELIVERY_KINDS, "delivery kind"),
		status: requiredEnum(row.status, DELIVERY_STATUSES, "delivery status"),
		idempotencyKey: row.idempotency_key,
		commandFingerprint: optional(row.command_fingerprint),
		source: requiredEnum(row.source, DELIVERY_SOURCES, "delivery source"),
		actor: {
			kind: requiredEnum(row.actor_kind, ACTOR_KINDS, "actor kind"),
			...(row.actor_id ? { id: row.actor_id } : {}),
		},
		createdAt: row.created_at,
		updatedAt: row.updated_at,
		availableAt: row.available_at,
		undoUntil: row.undo_until,
		scheduledFor: optional(row.scheduled_for),
		nextAttemptAt: optional(row.next_attempt_at),
		attemptCount: row.attempt_count,
		maxAttempts: row.max_attempts,
		preflightDeferralCount: row.preflight_deferral_count,
		dispatchPhase: optional(row.dispatch_phase) as
			| StoredOutboundDelivery["dispatchPhase"]
			| undefined,
		activeAttemptId: optional(row.active_attempt_id),
		acceptedAttemptCount: row.accepted_attempt_count,
		duplicateAcceptanceAt: optional(row.duplicate_acceptance_at),
		leaseToken: optional(row.lease_token),
		leaseExpiresAt: optional(row.lease_expires_at),
		sesMessageId: optional(row.ses_message_id),
		lastErrorCode: optional(row.last_error_code),
		lastErrorMessage: optional(row.last_error_message),
		sentAt: optional(row.sent_at),
		failedAt: optional(row.failed_at),
		unknownAt: optional(row.unknown_at),
		cancelledAt: optional(row.cancelled_at),
	};
}

export function attemptRowToStored(row: AttemptRow): OutboundDeliveryAttempt {
	return {
		id: row.id,
		deliveryId: row.delivery_id,
		attemptNumber: row.attempt_number,
		status: requiredEnum(row.status, ATTEMPT_STATUSES, "attempt status"),
		leaseToken: row.lease_token,
		startedAt: row.started_at,
		finishedAt: optional(row.finished_at),
		sesMessageId: optional(row.ses_message_id),
		httpStatus: row.http_status ?? undefined,
		errorCode: optional(row.error_code),
		errorMessage: optional(row.error_message),
		providerState: requiredEnum(
			row.provider_state,
			new Set(["none", "delivered", "bounced", "complained"] as const),
			"attempt provider state",
		),
		providerEventAt: optional(row.provider_event_at),
		providerEventId: optional(row.provider_event_id),
	};
}

/**
 * Synchronous persistence adapter for a mailbox Durable Object. All service
 * commands run inside DurableObjectStorage.transactionSync, including the
 * immutable email snapshot, delivery state, and attempt ledger mutations.
 */
export class DurableObjectOutboundDeliveryStorage
	implements OutboundDeliveryStorage
{
	readonly #db: OutboundDatabase;
	readonly #storage: DurableObjectStorage;
	readonly #options: DurableObjectOutboundStorageOptions;

	constructor(
		db: OutboundDatabase,
		storage: DurableObjectStorage,
		options: DurableObjectOutboundStorageOptions = {},
	) {
		this.#db = db;
		this.#storage = storage;
		this.#options = options;
	}

	transaction<T>(
		work: (tx: OutboundDeliveryTransaction) => T,
	): T {
		return this.#storage.transactionSync(() =>
			work(
				new DurableObjectOutboundDeliveryTransaction(
					this.#db,
					this.#options,
				),
			),
		);
	}
}

export class DurableObjectOutboundDeliveryTransaction
	implements OutboundDeliveryTransaction
{
	readonly #db: OutboundDatabase;
	readonly #options: DurableObjectOutboundStorageOptions;

	constructor(
		db: OutboundDatabase,
		options: DurableObjectOutboundStorageOptions = {},
	) {
		this.#db = db;
		this.#options = options;
	}

	findDeliveryByIdempotencyKey(key: string): StoredOutboundDelivery | null {
		const row = this.#db
			.select()
			.from(schema.outboundDeliveries)
			.where(eq(schema.outboundDeliveries.idempotency_key, key))
			.get();
		return row ? this.#hydrateDelivery(row) : null;
	}

	findDeliveryBySourceDraft(
		id: string,
		version: number,
	): StoredOutboundDelivery | null {
		const row = this.#db
			.select()
			.from(schema.outboundDeliveries)
			.where(
				and(
					eq(schema.outboundDeliveries.source_draft_id, id),
					eq(schema.outboundDeliveries.source_draft_version, version),
				),
			)
			.limit(1)
			.get();
		return row ? this.#hydrateDelivery(row) : null;
	}

	assertSourceDraftVersion(id: string, version: number) {
		const draft = this.#db
			.select({
				folderId: schema.emails.folder_id,
				version: schema.emails.draft_version,
			})
			.from(schema.emails)
			.where(eq(schema.emails.id, id))
			.get();
		if (!draft) return { status: "not_found" as const };
		if (draft.folderId !== "draft") return { status: "not_draft" as const };
		return draft.version === version
			? { status: "valid" as const }
			: {
					status: "version_conflict" as const,
					currentVersion: draft.version,
				};
	}

	findDeliveryBySesMessageId(messageId: string): StoredOutboundDelivery | null {
		const row = this.#db
			.select()
			.from(schema.outboundDeliveries)
			.where(eq(schema.outboundDeliveries.ses_message_id, messageId))
			.get();
		return row ? this.#hydrateDelivery(row) : null;
	}

	getDelivery(id: string): StoredOutboundDelivery | null {
		const row = this.#db
			.select()
			.from(schema.outboundDeliveries)
			.where(eq(schema.outboundDeliveries.id, id))
			.get();
		return row ? this.#hydrateDelivery(row) : null;
	}

	listDeliveries(): StoredOutboundDelivery[] {
		return this.#db
			.select()
			.from(schema.outboundDeliveries)
			.orderBy(desc(schema.outboundDeliveries.created_at))
			.limit(PUBLIC_DELIVERY_HISTORY_LIMIT)
			.all()
			.map((row) => this.#hydrateDelivery(row));
	}

	findNextDispatchable(now: string): StoredOutboundDelivery | null {
		const row = this.#db
			.select()
			.from(schema.outboundDeliveries)
			.where(
				or(
					and(
						eq(schema.outboundDeliveries.status, "queued"),
						lte(schema.outboundDeliveries.available_at, now),
					),
					and(
						eq(schema.outboundDeliveries.status, "retrying"),
						lte(schema.outboundDeliveries.next_attempt_at, now),
					),
				),
			)
			.orderBy(
				sql`CASE
					WHEN ${schema.outboundDeliveries.status} = 'retrying'
					THEN ${schema.outboundDeliveries.next_attempt_at}
					ELSE ${schema.outboundDeliveries.available_at}
				END`,
				schema.outboundDeliveries.created_at,
			)
			.limit(1)
			.get();
		return row ? this.#hydrateDelivery(row) : null;
	}

	listExpiredSending(now: string): StoredOutboundDelivery[] {
		return this.#db
			.select()
			.from(schema.outboundDeliveries)
			.where(
				and(
					eq(schema.outboundDeliveries.status, "sending"),
					lte(schema.outboundDeliveries.lease_expires_at, now),
				),
			)
			.all()
			.map((row) => this.#hydrateDelivery(row));
	}

	listDeliveriesByStatuses(
		statuses: StoredOutboundDelivery["status"][],
	): StoredOutboundDelivery[] {
		if (statuses.length === 0) return [];
		return this.#db
			.select()
			.from(schema.outboundDeliveries)
			.where(inArray(schema.outboundDeliveries.status, statuses))
			.orderBy(desc(schema.outboundDeliveries.created_at))
			.limit(PUBLIC_DELIVERY_HISTORY_LIMIT)
			.all()
			.map((row) => this.#hydrateDelivery(row));
	}

	listUnreconciledAccepted(): StoredOutboundDelivery[] {
		return this.#db
			.select({ delivery: schema.outboundDeliveries })
			.from(schema.outboundDeliveries)
			.innerJoin(
				schema.emails,
				eq(schema.emails.id, schema.outboundDeliveries.email_id),
			)
			.where(
				and(
					eq(schema.outboundDeliveries.status, "sent"),
					or(
						eq(schema.emails.folder_id, OUTBOX_FOLDER_ID),
						// A crash can happen after the accepted email moves to Sent but
						// before its exact source-draft version is consumed. Keep that
						// delivery eligible for reconciliation only while the matching
						// draft version still exists, without scanning all sent history.
						sql`EXISTS (
							SELECT 1
							FROM emails AS source_draft
							WHERE source_draft.id = ${schema.outboundDeliveries.source_draft_id}
								AND source_draft.folder_id = 'draft'
								AND source_draft.draft_version = ${schema.outboundDeliveries.source_draft_version}
						)`,
					),
				),
			)
			.all()
			.map(({ delivery }) => this.#hydrateDelivery(delivery));
	}

	findNextActionAt(): string | null {
		const row = this.#db
			.select({
				next: sql<string | null>`MIN(CASE
					WHEN ${schema.outboundDeliveries.status} = 'queued'
						THEN ${schema.outboundDeliveries.available_at}
					WHEN ${schema.outboundDeliveries.status} = 'retrying'
						THEN ${schema.outboundDeliveries.next_attempt_at}
					WHEN ${schema.outboundDeliveries.status} = 'sending'
						THEN ${schema.outboundDeliveries.lease_expires_at}
					ELSE NULL
				END)`,
			})
			.from(schema.outboundDeliveries)
			.where(
				inArray(schema.outboundDeliveries.status, [
					"queued",
					"retrying",
					"sending",
				]),
			)
			.get();
		return row?.next ?? null;
	}

	insertDelivery(delivery: StoredOutboundDelivery): void {
		this.#db
			.insert(schema.outboundDeliveries)
			.values({
				id: delivery.id,
				email_id: delivery.emailId,
				source_draft_id: delivery.draftId ?? null,
				source_draft_version: delivery.draftVersion ?? null,
				idempotency_key: delivery.idempotencyKey,
				command_fingerprint: delivery.commandFingerprint ?? null,
				kind: delivery.kind,
				source: delivery.source,
				actor_kind: delivery.actor.kind,
				actor_id: delivery.actor.id ?? null,
				status: delivery.status,
				available_at: delivery.availableAt,
				undo_until: delivery.undoUntil,
				scheduled_for: delivery.scheduledFor ?? null,
				next_attempt_at: delivery.nextAttemptAt ?? null,
				attempt_count: delivery.attemptCount,
				max_attempts: delivery.maxAttempts,
				preflight_deferral_count: delivery.preflightDeferralCount,
				dispatch_phase: delivery.dispatchPhase ?? null,
				active_attempt_id: delivery.activeAttemptId ?? null,
				lease_token: delivery.leaseToken ?? null,
				lease_expires_at: delivery.leaseExpiresAt ?? null,
				ses_message_id: delivery.sesMessageId ?? null,
				last_error_code: delivery.lastErrorCode ?? null,
				last_error_message: delivery.lastErrorMessage ?? null,
				created_at: delivery.createdAt,
				updated_at: delivery.updatedAt,
				sent_at: delivery.sentAt ?? null,
				failed_at: delivery.failedAt ?? null,
				unknown_at: delivery.unknownAt ?? null,
				cancelled_at: delivery.cancelledAt ?? null,
				accepted_attempt_count: delivery.acceptedAttemptCount,
				duplicate_acceptance_at: delivery.duplicateAcceptanceAt ?? null,
			})
			.run();
		this.#db
			.update(schema.emails)
			.set({ date: delivery.createdAt })
			.where(eq(schema.emails.id, delivery.emailId))
			.run();
	}

	updateDelivery(delivery: StoredOutboundDelivery): void {
		// Identity, snapshot linkage, source, actor, and idempotency fields are
		// intentionally omitted so state transitions cannot rewrite history.
		this.#db
			.update(schema.outboundDeliveries)
			.set({
				status: delivery.status,
				available_at: delivery.availableAt,
				scheduled_for: delivery.scheduledFor ?? null,
				next_attempt_at: delivery.nextAttemptAt ?? null,
				attempt_count: delivery.attemptCount,
				max_attempts: delivery.maxAttempts,
				preflight_deferral_count: delivery.preflightDeferralCount,
				dispatch_phase: delivery.dispatchPhase ?? null,
				active_attempt_id: delivery.activeAttemptId ?? null,
				lease_token: delivery.leaseToken ?? null,
				lease_expires_at: delivery.leaseExpiresAt ?? null,
				ses_message_id: delivery.sesMessageId ?? null,
				last_error_code: delivery.lastErrorCode ?? null,
				last_error_message: delivery.lastErrorMessage ?? null,
				updated_at: delivery.updatedAt,
				sent_at: delivery.sentAt ?? null,
				failed_at: delivery.failedAt ?? null,
				unknown_at: delivery.unknownAt ?? null,
				cancelled_at: delivery.cancelledAt ?? null,
				accepted_attempt_count: delivery.acceptedAttemptCount,
				duplicate_acceptance_at: delivery.duplicateAcceptanceAt ?? null,
			})
			.where(eq(schema.outboundDeliveries.id, delivery.id))
			.run();
	}

	insertSnapshot(
		emailId: string,
		snapshot: OutboundMessageSnapshot,
		pendingAttachments: readonly PendingOutboundAttachment[] =
			this.#options.resolvePendingAttachments?.(emailId, snapshot) ?? [],
	): void {
		const attachments = pendingAttachmentsToRows(
			emailId,
			snapshot,
			pendingAttachments,
		);
		this.#db
			.insert(schema.emails)
			.values({
				id: emailId,
				folder_id: OUTBOX_FOLDER_ID,
				subject: snapshot.subject,
				sender: snapshot.from,
				recipient: snapshot.to.join(", "),
				cc: snapshot.cc.join(", ") || null,
				bcc: snapshot.bcc.join(", ") || null,
				date: null,
				read: 1,
				starred: 0,
				body: snapshot.html ?? snapshot.text ?? "",
				in_reply_to: snapshot.inReplyTo ?? null,
				email_references: snapshot.references
					? JSON.stringify(snapshot.references)
					: null,
				thread_id: snapshot.threadId,
				message_id: null,
				raw_headers: serializeOutboundSnapshot(snapshot),
				draft_version: snapshot.draftVersion ?? 1,
			})
			.run();
		if (attachments.length > 0) {
			this.#db.insert(schema.attachments).values(attachments).run();
		}
	}

	getSnapshot(emailId: string): OutboundMessageSnapshot | null {
		const row = this.#db
			.select({ raw_headers: schema.emails.raw_headers })
			.from(schema.emails)
			.where(eq(schema.emails.id, emailId))
			.get();
		return deserializeOutboundSnapshot(row?.raw_headers ?? null);
	}

	insertAttempt(attempt: OutboundDeliveryAttempt): void {
		this.#db
			.insert(schema.outboundDeliveryAttempts)
			.values({
				id: attempt.id,
				delivery_id: attempt.deliveryId,
				attempt_number: attempt.attemptNumber,
				status: attempt.status,
				lease_token: attempt.leaseToken,
				started_at: attempt.startedAt,
				finished_at: attempt.finishedAt ?? null,
				ses_message_id: attempt.sesMessageId ?? null,
				http_status: attempt.httpStatus ?? null,
				error_code: attempt.errorCode ?? null,
				error_message: attempt.errorMessage ?? null,
				provider_state: attempt.providerState,
				provider_event_at: attempt.providerEventAt ?? null,
				provider_event_id: attempt.providerEventId ?? null,
			})
			.run();
	}

	findAttemptByLease(
		deliveryId: string,
		leaseToken: string,
	): OutboundDeliveryAttempt | null {
		const row = this.#db
			.select()
			.from(schema.outboundDeliveryAttempts)
			.where(
				and(
					eq(schema.outboundDeliveryAttempts.delivery_id, deliveryId),
					eq(schema.outboundDeliveryAttempts.lease_token, leaseToken),
				),
			)
			.get();
		return row ? attemptRowToStored(row) : null;
	}

	updateAttempt(attempt: OutboundDeliveryAttempt): void {
		// Attempt identity, lease, ordinal, and start time remain immutable.
		this.#db
			.update(schema.outboundDeliveryAttempts)
			.set({
				status: attempt.status,
				finished_at: attempt.finishedAt ?? null,
				ses_message_id: attempt.sesMessageId ?? null,
				http_status: attempt.httpStatus ?? null,
				error_code: attempt.errorCode ?? null,
				error_message: attempt.errorMessage ?? null,
				provider_state: attempt.providerState,
				provider_event_at: attempt.providerEventAt ?? null,
				provider_event_id: attempt.providerEventId ?? null,
			})
			.where(eq(schema.outboundDeliveryAttempts.id, attempt.id))
			.run();
	}

	#hydrateDelivery(row: DeliveryRow): StoredOutboundDelivery {
		const snapshot = this.getSnapshot(row.email_id);
		if (!snapshot) {
			throw new Error(`Missing outbox snapshot for ${row.id}`);
		}
		const email = this.#db
			.select({ folderId: schema.emails.folder_id })
			.from(schema.emails)
			.where(eq(schema.emails.id, row.email_id))
			.get();
		const delivery = deliveryRowToStored(row, snapshot.mailboxId);
		return {
			...delivery,
			...(delivery.status === "cancelled"
				? { cancelRecoveryPending: cancellationRecoveryPending(
						delivery.status,
						email?.folderId,
					) }
				: {}),
		};
	}
}

export function pendingAttachmentsToRows(
	emailId: string,
	snapshot: OutboundMessageSnapshot,
	pending: readonly PendingOutboundAttachment[],
) {
	if (new Set(snapshot.attachmentIds).size !== snapshot.attachmentIds.length) {
		throw new Error("Immutable snapshot contains duplicate attachment IDs");
	}
	const byId = new Map<string, PendingOutboundAttachment>();
	for (const attachment of pending) {
		if (byId.has(attachment.id)) {
			throw new Error(`Duplicate pending attachment metadata: ${attachment.id}`);
		}
		if (!snapshot.attachmentIds.includes(attachment.id)) {
			throw new Error(
				`Pending attachment ${attachment.id} is not part of the immutable snapshot`,
			);
		}
		if (attachment.email_id && attachment.email_id !== emailId) {
			throw new Error(
				`Pending attachment ${attachment.id} belongs to a different email snapshot`,
			);
		}
		byId.set(attachment.id, attachment);
	}

	return snapshot.attachmentIds.map((id) => {
		const attachment = byId.get(id);
		if (!attachment) {
			throw new Error(`Missing pending attachment metadata for ${id}`);
		}
		const disposition = attachment.disposition ?? "attachment";
		return {
			id,
			email_id: emailId,
			filename: attachment.filename,
			mimetype: attachment.mimetype,
			size: attachment.size,
			content_id: contentIdForDisposition(
				disposition,
				attachment.contentId ?? attachment.content_id,
			),
			disposition,
		};
	});
}
