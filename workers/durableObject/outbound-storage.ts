// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { and, desc, eq, inArray, isNull, lte, or, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/durable-sqlite";
import * as schema from "../db/schema.ts";
import type {
	DispatchableDeliveryCandidate,
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
	OutboundAttachmentByteIdentity,
	OutboundMessageSnapshot,
} from "../lib/outbound-delivery-contract.ts";
import { cancellationRecoveryPending } from "../lib/outbound-dispatch-policy.ts";
import { contentIdForDisposition } from "../../shared/content-id.ts";
import { normalizeMailAddress } from "../lib/mail-address.ts";

const OUTBOX_FOLDER_ID = "outbox";
const SNAPSHOT_ENVELOPE_KIND = "mail-portal/outbound-snapshot";
const SNAPSHOT_ENVELOPE_VERSION = 2;
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
	content_sha256?: string;
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
	version: 1 | typeof SNAPSHOT_ENVELOPE_VERSION;
	snapshot: OutboundMessageSnapshot;
}

function isAttachmentByteIdentity(
	value: unknown,
): value is OutboundAttachmentByteIdentity {
	if (!value || typeof value !== "object") return false;
	const identity = value as Partial<OutboundAttachmentByteIdentity>;
	return (
		typeof identity.id === "string" &&
		identity.id.length > 0 &&
		typeof identity.byteLength === "number" &&
		Number.isInteger(identity.byteLength) &&
		identity.byteLength >= 0 &&
		typeof identity.sha256 === "string" &&
		/^[a-f0-9]{64}$/.test(identity.sha256) &&
		typeof identity.filename === "string" &&
		identity.filename.length > 0 &&
		typeof identity.mimetype === "string" &&
		identity.mimetype.length > 0 &&
		(identity.disposition === "attachment" ||
			identity.disposition === "inline") &&
		(identity.contentId === undefined ||
			(typeof identity.contentId === "string" &&
				identity.contentId.length > 0)) &&
		(identity.disposition === "inline" || identity.contentId === undefined)
	);
}

function hasExactAttachmentByteManifest(
	attachmentIds: readonly string[],
	value: unknown,
): value is OutboundAttachmentByteIdentity[] {
	if (!Array.isArray(value) || !value.every(isAttachmentByteIdentity)) {
		return false;
	}
	const manifestIds = value.map((identity) => identity.id);
	return (
		new Set(manifestIds).size === manifestIds.length &&
		manifestIds.length === attachmentIds.length &&
		[...manifestIds]
			.sort()
			.every((id, index) => id === [...attachmentIds].sort()[index])
	);
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
const DISPATCH_PHASES = new Set<
	NonNullable<StoredOutboundDelivery["dispatchPhase"]>
>(["preflight", "provider"]);

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

export function isCanonicalUtcTimestamp(value: unknown): value is string {
	if (typeof value !== "string" || value.length === 0) return false;
	const timestamp = Date.parse(value);
	return (
		Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value
	);
}

function optionalEnum<T extends string>(
	value: string | null,
	allowed: ReadonlySet<T>,
	field: string,
): T | undefined {
	return value === null ? undefined : requiredEnum(value, allowed, field);
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

function isStringArray(
	value: unknown,
	options: { unique?: boolean; allowEmpty?: boolean } = {},
): value is string[] {
	return (
		Array.isArray(value) &&
		value.every(
			(item) =>
				typeof item === "string" && (options.allowEmpty || item.length > 0),
		) &&
		(!options.unique || new Set(value).size === value.length)
	);
}

function isAddressArray(value: unknown): value is string[] {
	return (
		Array.isArray(value) &&
		value.every(
			(item) => typeof item === "string" && normalizeMailAddress(item) === item,
		)
	);
}

export function serializeOutboundSnapshot(
	snapshot: OutboundMessageSnapshot,
): string {
	if (
		!hasExactAttachmentByteManifest(
			snapshot.attachmentIds,
			snapshot.attachmentByteIdentities,
		)
	) {
		throw new Error(
			"Outbound snapshot requires an exact attachment byte manifest",
		);
	}
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
		(envelope.version !== 1 &&
			envelope.version !== SNAPSHOT_ENVELOPE_VERSION) ||
		!envelope.snapshot ||
		typeof envelope.snapshot !== "object"
	) {
		return null;
	}

	const snapshot = envelope.snapshot as Partial<OutboundMessageSnapshot>;
	const mailboxId =
		typeof snapshot.mailboxId === "string"
			? normalizeMailAddress(snapshot.mailboxId)
			: null;
	if (
		!mailboxId ||
		mailboxId !== snapshot.mailboxId ||
		!hasValidSourceDraftReference(snapshot) ||
		!DELIVERY_KINDS.has(snapshot.kind as OutboundDeliveryKind) ||
		!isAddressArray(snapshot.to) ||
		!isAddressArray(snapshot.cc) ||
		!isAddressArray(snapshot.bcc) ||
		snapshot.to.length + snapshot.cc.length + snapshot.bcc.length === 0 ||
		typeof snapshot.from !== "string" ||
		normalizeMailAddress(snapshot.from) !== mailboxId ||
		typeof snapshot.subject !== "string" ||
		(snapshot.html !== undefined && typeof snapshot.html !== "string") ||
		(snapshot.text !== undefined && typeof snapshot.text !== "string") ||
		(snapshot.inReplyTo !== undefined &&
			(typeof snapshot.inReplyTo !== "string" || !snapshot.inReplyTo)) ||
		(snapshot.references !== undefined &&
			!isStringArray(snapshot.references, {
				allowEmpty: envelope.version === 1,
			})) ||
		typeof snapshot.threadId !== "string" ||
		!snapshot.threadId ||
		!isStringArray(snapshot.attachmentIds, { unique: true }) ||
		(snapshot.sourceDraftAttachmentIds !== undefined &&
			!isStringArray(snapshot.sourceDraftAttachmentIds, { unique: true }))
	) {
		return null;
	}
	if (
		envelope.version === SNAPSHOT_ENVELOPE_VERSION &&
		!hasExactAttachmentByteManifest(
			snapshot.attachmentIds,
			snapshot.attachmentByteIdentities,
		)
	) {
		return null;
	}
	if (envelope.version === 1) {
		delete snapshot.attachmentByteIdentities;
	}

	return structuredClone(snapshot as OutboundMessageSnapshot);
}

export function deliveryRowToStored(
	row: DeliveryRow,
	mailboxId: string,
): StoredOutboundDelivery {
	const retryOriginStatus =
		row.retry_origin_status === "failed" || row.retry_origin_status === "unknown"
			? row.retry_origin_status
			: undefined;
	const requiredTimes = [
		row.created_at,
		row.updated_at,
		row.available_at,
		row.undo_until,
	];
	const optionalTimes = [
		row.scheduled_for,
		row.next_attempt_at,
		row.lease_expires_at,
		row.duplicate_acceptance_at,
		row.sent_at,
		row.failed_at,
		row.unknown_at,
		row.cancelled_at,
	];
	if (
		requiredTimes.some((value) => !isCanonicalUtcTimestamp(value)) ||
		optionalTimes.some(
			(value) => value !== null && !isCanonicalUtcTimestamp(value),
		) ||
		!Number.isInteger(row.attempt_count) ||
		row.attempt_count < 0 ||
		!Number.isInteger(row.max_attempts) ||
		row.max_attempts < 1 ||
		!Number.isInteger(row.preflight_deferral_count) ||
		row.preflight_deferral_count < 0 ||
		!Number.isInteger(row.cancellation_recovery_attempt_count) ||
		row.cancellation_recovery_attempt_count < 0 ||
		(row.retry_origin_status !== null && retryOriginStatus === undefined) ||
		(retryOriginStatus !== undefined &&
			!new Set(["queued", "retrying", "sending"]).has(row.status)) ||
		!Number.isInteger(row.accepted_attempt_count) ||
		row.accepted_attempt_count < 0 ||
		(row.status === "sent" &&
			(!row.ses_message_id?.trim() || !isCanonicalUtcTimestamp(row.sent_at)))
	) {
		throw new Error("Invalid core fields in truthful outbox storage");
	}
	const dispatchPhase =
		row.dispatch_phase === null
			? undefined
			: DISPATCH_PHASES.has(
						row.dispatch_phase as NonNullable<
							StoredOutboundDelivery["dispatchPhase"]
						>,
				  )
				? (row.dispatch_phase as NonNullable<
						StoredOutboundDelivery["dispatchPhase"]
					>)
				: undefined;
	return {
		id: row.id,
		emailId: row.email_id,
		...sourceDraftFromStorage(row.source_draft_id, row.source_draft_version),
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
		cancellationRecoveryAttemptCount:
			row.cancellation_recovery_attempt_count,
		retryOriginStatus,
		dispatchPhase,
		activeAttemptId: optional(row.active_attempt_id),
		acceptedAttemptCount: row.accepted_attempt_count,
		duplicateAcceptanceAt: optional(row.duplicate_acceptance_at),
		...(row.dispatch_phase !== null && dispatchPhase === undefined
			? { recoveryIntegrityCode: "outbound_dispatch_phase_invalid" as const }
			: {}),
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
	const status = ATTEMPT_STATUSES.has(
		row.status as OutboundDeliveryAttempt["status"],
	)
		? (row.status as OutboundDeliveryAttempt["status"])
		: "unknown";
	const providerStates = new Set([
		"none",
		"delivered",
		"bounced",
		"complained",
		"bounce_scope_unknown",
	] as const);
	const providerState = providerStates.has(
		row.provider_state as OutboundDeliveryAttempt["providerState"],
	)
		? (row.provider_state as OutboundDeliveryAttempt["providerState"])
		: "none";
	const providerEventPairValid =
		(row.provider_event_at === null && row.provider_event_id === null) ||
		(isCanonicalUtcTimestamp(row.provider_event_at) &&
			typeof row.provider_event_id === "string" &&
			row.provider_event_id.length > 0);
	const stateShapeInvalid =
		(row.status === "sending" &&
			(row.finished_at !== null ||
				row.ses_message_id !== null ||
				row.http_status !== null ||
				row.error_code !== null ||
				row.error_message !== null ||
				row.provider_state !== "none" ||
				row.provider_event_at !== null ||
				row.provider_event_id !== null)) ||
		(row.status !== "sending" && !isCanonicalUtcTimestamp(row.finished_at)) ||
		(row.status === "accepted" && !row.ses_message_id?.trim()) ||
		(row.status !== "accepted" && row.provider_state !== "none") ||
		(row.provider_state !== "none" && !providerEventPairValid) ||
		(row.provider_state === "none" && !providerEventPairValid) ||
		(row.http_status !== null &&
			(!Number.isInteger(row.http_status) ||
				row.http_status < 100 ||
				row.http_status > 599));
	const integrityInvalid =
		!row.id ||
		!row.delivery_id ||
		!Number.isInteger(row.attempt_number) ||
		row.attempt_number < 1 ||
		!row.lease_token ||
		stateShapeInvalid ||
		!isCanonicalUtcTimestamp(row.started_at) ||
		(row.finished_at !== null && !isCanonicalUtcTimestamp(row.finished_at)) ||
		(row.provider_event_at !== null &&
			!isCanonicalUtcTimestamp(row.provider_event_at)) ||
		!ATTEMPT_STATUSES.has(row.status as OutboundDeliveryAttempt["status"]) ||
		!providerStates.has(
			row.provider_state as OutboundDeliveryAttempt["providerState"],
		);
	return {
		id: row.id,
		deliveryId: row.delivery_id,
		attemptNumber: row.attempt_number,
		status,
		leaseToken: row.lease_token,
		startedAt: row.started_at,
		finishedAt: optional(row.finished_at),
		sesMessageId: optional(row.ses_message_id),
		httpStatus: row.http_status ?? undefined,
		errorCode: optional(row.error_code),
		errorMessage: optional(row.error_message),
		providerState,
		providerEventAt: optional(row.provider_event_at),
		providerEventId: optional(row.provider_event_id),
		...(integrityInvalid
			? { storageIntegrityCode: "outbound_attempt_record_invalid" as const }
			: {}),
	};
}

/**
 * Synchronous persistence adapter for a mailbox Durable Object. All service
 * commands run inside DurableObjectStorage.transactionSync, including the
 * immutable email snapshot, delivery state, and attempt ledger mutations.
 */
export class DurableObjectOutboundDeliveryStorage implements OutboundDeliveryStorage {
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

	transaction<T>(work: (tx: OutboundDeliveryTransaction) => T): T {
		return this.#storage.transactionSync(() =>
			work(
				new DurableObjectOutboundDeliveryTransaction(this.#db, this.#options),
			),
		);
	}
}

export class DurableObjectOutboundDeliveryTransaction implements OutboundDeliveryTransaction {
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

	findNextDispatchableCandidate(
		now: string,
	): DispatchableDeliveryCandidate | null {
		const row = this.#findNextDispatchableRow(now);
		if (!row) return null;
		const preserveUnknownRetryOrigin = (outcome: "failed" | "unknown") =>
			row.retry_origin_status !== null && row.retry_origin_status !== "failed"
				? "unknown"
				: outcome;
		if (row.status !== "queued" && row.status !== "retrying") {
			throw new Error(`Invalid dispatchable delivery status: ${row.status}`);
		}
		if (
			row.dispatch_phase !== null ||
			row.active_attempt_id !== null ||
			row.lease_token !== null ||
			row.lease_expires_at !== null
		) {
			const providerDispatchCannotBeExcluded =
				row.dispatch_phase === "provider" ||
				row.active_attempt_id !== null ||
				(row.dispatch_phase === null &&
					(row.lease_token !== null || row.lease_expires_at !== null));
			return {
				state: "integrity_failure",
				deliveryId: row.id,
				status: requiredEnum(
					row.status,
					new Set(["queued", "retrying"] as const),
					"dispatchable delivery status",
				),
				code: "outbound_dispatch_metadata_invalid",
				outcome: preserveUnknownRetryOrigin(
					providerDispatchCannotBeExcluded ? "unknown" : "failed",
				),
			};
		}
		const dispatchAt =
			row.status === "queued" ? row.available_at : row.next_attempt_at;
		if (!isCanonicalUtcTimestamp(dispatchAt)) {
			return {
				state: "integrity_failure",
				deliveryId: row.id,
				status: requiredEnum(
					row.status,
					new Set(["queued", "retrying"] as const),
					"dispatchable delivery status",
				),
				code: "outbound_dispatch_metadata_invalid",
				outcome: preserveUnknownRetryOrigin("failed"),
			};
		}
		try {
			const delivery = this.#hydrateDelivery(row);
			if (delivery.storageIntegrityCode) {
				return {
					state: "integrity_failure",
					deliveryId: row.id,
					status: row.status,
					code: "outbound_dispatch_metadata_invalid",
					outcome: preserveUnknownRetryOrigin("failed"),
				};
			}
			return { state: "ready", delivery };
		} catch {
			return {
				state: "integrity_failure",
				deliveryId: row.id,
				status: requiredEnum(
					row.status,
					new Set(["queued", "retrying"] as const),
					"dispatchable delivery status",
				),
				code: "outbound_dispatch_metadata_invalid",
				outcome: preserveUnknownRetryOrigin("failed"),
			};
		}
	}

	findNextDispatchable(now: string): StoredOutboundDelivery | null {
		const candidate = this.findNextDispatchableCandidate(now);
		if (!candidate) return null;
		if (candidate.state === "integrity_failure") {
			throw new Error(`Invalid dispatch metadata for ${candidate.deliveryId}`);
		}
		return candidate.delivery;
	}

	failDispatchableIntegrity(
		candidate: Extract<
			DispatchableDeliveryCandidate,
			{ state: "integrity_failure" }
		>,
		at: string,
	): void {
		this.#db
			.update(schema.outboundDeliveries)
			.set({
				status: candidate.outcome,
				retry_origin_status: null,
				next_attempt_at: null,
				dispatch_phase: null,
				active_attempt_id: null,
				lease_token: null,
				lease_expires_at: null,
				failed_at: candidate.outcome === "failed" ? at : null,
				unknown_at: candidate.outcome === "unknown" ? at : null,
				updated_at: at,
				last_error_code: candidate.code,
				last_error_message:
					candidate.outcome === "unknown"
						? "A prior provider dispatch cannot be excluded. Retry only with duplicate-risk acknowledgement."
						: "The local dispatch record is inconsistent and cannot be sent safely.",
			})
			.where(
					and(
					eq(schema.outboundDeliveries.id, candidate.deliveryId),
					eq(schema.outboundDeliveries.status, candidate.status),
				),
			)
			.run();
		const repaired = this.#db
			.select({ status: schema.outboundDeliveries.status })
			.from(schema.outboundDeliveries)
			.where(eq(schema.outboundDeliveries.id, candidate.deliveryId))
			.get();
		if (repaired?.status !== candidate.outcome) {
			throw new Error(
				`Dispatch integrity repair lost ownership for ${candidate.deliveryId}`,
			);
		}
	}

	listExpiredSending(now: string): StoredOutboundDelivery[] {
		const rows = this.#db
			.select()
			.from(schema.outboundDeliveries)
			.where(
				and(
					eq(schema.outboundDeliveries.status, "sending"),
					or(
					lte(schema.outboundDeliveries.lease_expires_at, now),
						isNull(schema.outboundDeliveries.lease_expires_at),
						isNull(schema.outboundDeliveries.lease_token),
						sql`TRIM(${schema.outboundDeliveries.lease_token}) = ''`,
						sql`strftime('%s', ${schema.outboundDeliveries.lease_expires_at}) IS NULL`,
						sql`strftime('%Y-%m-%dT%H:%M:%fZ', ${schema.outboundDeliveries.lease_expires_at}) <> ${schema.outboundDeliveries.lease_expires_at}`,
					),
				),
			)
			.all();
		const deliveries: StoredOutboundDelivery[] = [];
		for (const row of rows) {
			try {
				deliveries.push(this.#hydrateExpiredDelivery(row));
			} catch {
				this.#markUnknownWithoutHydration(
					row,
					now,
					"outbound_delivery_record_invalid",
				);
			}
		}
		return deliveries;
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

	listUnreconciledAccepted(
		now: string,
		limit: number,
	): StoredOutboundDelivery[] {
		const rows = this.#db
			.select({ delivery: schema.outboundDeliveries })
			.from(schema.outboundDeliveries)
			.innerJoin(
				schema.emails,
				eq(schema.emails.id, schema.outboundDeliveries.email_id),
			)
			.where(
				and(
					eq(schema.outboundDeliveries.status, "sent"),
					sql`NOT EXISTS (
						SELECT 1 FROM outbound_acceptance_recovery AS recovery
						WHERE recovery.delivery_id = ${schema.outboundDeliveries.id}
					)`,
					or(
						isNull(schema.outboundDeliveries.next_attempt_at),
						lte(schema.outboundDeliveries.next_attempt_at, now),
						sql`strftime('%Y-%m-%dT%H:%M:%fZ', ${schema.outboundDeliveries.next_attempt_at}) IS NULL`,
						sql`strftime('%Y-%m-%dT%H:%M:%fZ', ${schema.outboundDeliveries.next_attempt_at}) <> ${schema.outboundDeliveries.next_attempt_at}`,
					),
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
			.orderBy(schema.outboundDeliveries.updated_at)
			.limit(Math.max(1, Math.min(limit, 25)))
			.all();
		const deliveries: StoredOutboundDelivery[] = [];
		for (const { delivery } of rows) {
			try {
				const hydrated = this.#hydrateDelivery(delivery);
				if (hydrated.storageIntegrityCode) {
					this.deferAcceptedReconciliation(
						delivery.id,
						new Date(Date.parse(now) + 5 * 60_000).toISOString(),
						"outbound_reconciliation_record_invalid",
						"Provider acceptance is preserved, but the local projection requires audited repair.",
					);
					continue;
				}
				deliveries.push(hydrated);
			} catch {
				this.deferAcceptedReconciliation(
					delivery.id,
					new Date(Date.parse(now) + 5 * 60_000).toISOString(),
					"outbound_reconciliation_record_invalid",
					"Provider acceptance is preserved, but the local projection requires audited repair.",
				);
				continue;
			}
		}
		return deliveries;
	}

	listPendingCancellationRecovery(
		now: string,
		limit: number,
	): StoredOutboundDelivery[] {
		return this.#db
			.select({ delivery: schema.outboundDeliveries })
			.from(schema.outboundDeliveries)
			.innerJoin(
				schema.emails,
				eq(schema.emails.id, schema.outboundDeliveries.email_id),
			)
			.where(
				and(
					eq(schema.outboundDeliveries.status, "cancelled"),
					eq(schema.emails.folder_id, OUTBOX_FOLDER_ID),
					or(
						isNull(schema.outboundDeliveries.last_error_code),
						sql`${schema.outboundDeliveries.last_error_code} <> 'outbound_cancellation_recovery_parked'`,
					),
					or(
						isNull(schema.outboundDeliveries.next_attempt_at),
						lte(schema.outboundDeliveries.next_attempt_at, now),
						sql`strftime('%Y-%m-%dT%H:%M:%fZ', ${schema.outboundDeliveries.next_attempt_at}) IS NULL`,
						sql`strftime('%Y-%m-%dT%H:%M:%fZ', ${schema.outboundDeliveries.next_attempt_at}) <> ${schema.outboundDeliveries.next_attempt_at}`,
					),
				),
			)
			.orderBy(schema.outboundDeliveries.updated_at)
			.limit(Math.max(1, Math.min(limit, 25)))
			.all()
			.map(({ delivery }) => this.#hydrateDelivery(delivery));
	}

	deferAcceptedReconciliation(
		deliveryId: string,
		retryAt: string,
		code: string,
		message: string,
	): void {
		this.#db
			.update(schema.outboundDeliveries)
			.set({
				next_attempt_at: retryAt,
				last_error_code: code,
				last_error_message: message,
			})
			.where(
				and(
					eq(schema.outboundDeliveries.id, deliveryId),
					eq(schema.outboundDeliveries.status, "sent"),
				),
			)
			.run();
	}

	completeAcceptedReconciliation(deliveryId: string): void {
		this.#db
			.update(schema.outboundDeliveries)
			.set({
				next_attempt_at: null,
				last_error_code: sql`CASE
					WHEN ${schema.outboundDeliveries.last_error_code} IN (
						'outbound_reconciliation_record_invalid',
						'outbound_acceptance_identity_missing',
						'outbound_reconciliation_deferred'
					) THEN NULL
					ELSE ${schema.outboundDeliveries.last_error_code}
				END`,
				last_error_message: sql`CASE
					WHEN ${schema.outboundDeliveries.last_error_code} IN (
						'outbound_reconciliation_record_invalid',
						'outbound_acceptance_identity_missing',
						'outbound_reconciliation_deferred'
					) THEN NULL
					ELSE ${schema.outboundDeliveries.last_error_message}
				END`,
			})
			.where(
				and(
					eq(schema.outboundDeliveries.id, deliveryId),
					eq(schema.outboundDeliveries.status, "sent"),
				),
			)
			.run();
	}

	findNextActionAt(): string | null {
		const row = this.#db
			.select({
				next: sql<string | null>`MIN(CASE
					WHEN ${schema.outboundDeliveries.status} = 'queued'
						THEN CASE
							WHEN strftime('%Y-%m-%dT%H:%M:%fZ', ${schema.outboundDeliveries.available_at}) IS NULL
								OR strftime('%Y-%m-%dT%H:%M:%fZ', ${schema.outboundDeliveries.available_at}) <> ${schema.outboundDeliveries.available_at}
							THEN '1970-01-01T00:00:00.000Z'
							ELSE ${schema.outboundDeliveries.available_at}
						END
					WHEN ${schema.outboundDeliveries.status} = 'retrying'
						THEN CASE
							WHEN strftime('%Y-%m-%dT%H:%M:%fZ', ${schema.outboundDeliveries.next_attempt_at}) IS NULL
								OR strftime('%Y-%m-%dT%H:%M:%fZ', ${schema.outboundDeliveries.next_attempt_at}) <> ${schema.outboundDeliveries.next_attempt_at}
							THEN '1970-01-01T00:00:00.000Z'
							ELSE ${schema.outboundDeliveries.next_attempt_at}
						END
					WHEN ${schema.outboundDeliveries.status} = 'sending'
						THEN CASE
							WHEN ${schema.outboundDeliveries.lease_token} IS NULL
								OR TRIM(${schema.outboundDeliveries.lease_token}) = ''
								OR strftime('%Y-%m-%dT%H:%M:%fZ', ${schema.outboundDeliveries.lease_expires_at}) IS NULL
								OR strftime('%Y-%m-%dT%H:%M:%fZ', ${schema.outboundDeliveries.lease_expires_at}) <> ${schema.outboundDeliveries.lease_expires_at}
							THEN '1970-01-01T00:00:00.000Z'
							ELSE ${schema.outboundDeliveries.lease_expires_at}
						END
					WHEN ${schema.outboundDeliveries.status} = 'sent'
						AND NOT EXISTS (
							SELECT 1 FROM outbound_acceptance_recovery AS recovery
							WHERE recovery.delivery_id = ${schema.outboundDeliveries.id}
						)
						AND (
							EXISTS (
								SELECT 1 FROM emails AS accepted_email
								WHERE accepted_email.id = ${schema.outboundDeliveries.email_id}
									AND accepted_email.folder_id = 'outbox'
							)
							OR EXISTS (
								SELECT 1 FROM emails AS source_draft
								WHERE source_draft.id = ${schema.outboundDeliveries.source_draft_id}
									AND source_draft.folder_id = 'draft'
									AND source_draft.draft_version = ${schema.outboundDeliveries.source_draft_version}
							)
						)
						THEN CASE
							WHEN ${schema.outboundDeliveries.next_attempt_at} IS NULL
								THEN ${schema.outboundDeliveries.updated_at}
							WHEN strftime('%Y-%m-%dT%H:%M:%fZ', ${schema.outboundDeliveries.next_attempt_at}) IS NULL
								OR strftime('%Y-%m-%dT%H:%M:%fZ', ${schema.outboundDeliveries.next_attempt_at}) <> ${schema.outboundDeliveries.next_attempt_at}
								THEN '1970-01-01T00:00:00.000Z'
							ELSE ${schema.outboundDeliveries.next_attempt_at}
						END
					WHEN ${schema.outboundDeliveries.status} = 'cancelled'
						AND (${schema.outboundDeliveries.last_error_code} IS NULL
							OR ${schema.outboundDeliveries.last_error_code} <> 'outbound_cancellation_recovery_parked')
						AND EXISTS (
							SELECT 1 FROM emails AS cancelled_email
							WHERE cancelled_email.id = ${schema.outboundDeliveries.email_id}
								AND cancelled_email.folder_id = 'outbox'
						)
						THEN CASE
							WHEN ${schema.outboundDeliveries.next_attempt_at} IS NULL
								THEN ${schema.outboundDeliveries.updated_at}
							WHEN strftime('%Y-%m-%dT%H:%M:%fZ', ${schema.outboundDeliveries.next_attempt_at}) IS NULL
								OR strftime('%Y-%m-%dT%H:%M:%fZ', ${schema.outboundDeliveries.next_attempt_at}) <> ${schema.outboundDeliveries.next_attempt_at}
								THEN '1970-01-01T00:00:00.000Z'
							ELSE ${schema.outboundDeliveries.next_attempt_at}
						END
					ELSE NULL
				END)`,
			})
			.from(schema.outboundDeliveries)
			.where(
				inArray(schema.outboundDeliveries.status, [
					"queued",
					"retrying",
					"sending",
					"sent",
					"cancelled",
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
				cancellation_recovery_attempt_count:
					delivery.cancellationRecoveryAttemptCount,
				retry_origin_status: delivery.retryOriginStatus ?? null,
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
		// Snapshot linkage, source, and idempotency fields remain immutable. The
		// actor changes only for an explicit teammate retry and becomes the actor
		// authorized and attributed at the next provider boundary.
		this.#db
			.update(schema.outboundDeliveries)
			.set({
				actor_kind: delivery.actor.kind,
				actor_id: delivery.actor.id ?? null,
				status: delivery.status,
				available_at: delivery.availableAt,
				scheduled_for: delivery.scheduledFor ?? null,
				next_attempt_at: delivery.nextAttemptAt ?? null,
				attempt_count: delivery.attemptCount,
				max_attempts: delivery.maxAttempts,
				preflight_deferral_count: delivery.preflightDeferralCount,
				cancellation_recovery_attempt_count:
					delivery.cancellationRecoveryAttemptCount,
				retry_origin_status: delivery.retryOriginStatus ?? null,
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
		pendingAttachments: readonly PendingOutboundAttachment[] = this.#options.resolvePendingAttachments?.(
			emailId,
			snapshot,
		) ?? [],
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

	listAttemptsByDelivery(deliveryId: string): OutboundDeliveryAttempt[] {
		return this.#db
			.select()
			.from(schema.outboundDeliveryAttempts)
			.where(eq(schema.outboundDeliveryAttempts.delivery_id, deliveryId))
			.orderBy(desc(schema.outboundDeliveryAttempts.attempt_number))
			.all()
			.map(attemptRowToStored);
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

	recordAcceptedRecovery(
		delivery: StoredOutboundDelivery,
		attempt: OutboundDeliveryAttempt,
	): void {
		if (!attempt.sesMessageId || !attempt.finishedAt) {
			throw new Error("Accepted recovery requires immutable provider identity");
		}
		this.#db
			.insert(schema.outboundAcceptanceRecovery)
			.values({
				delivery_id: delivery.id,
				email_id: delivery.emailId,
				attempt_id: attempt.id,
				ses_message_id: attempt.sesMessageId,
				accepted_at: attempt.finishedAt,
				source_draft_id: delivery.draftId ?? null,
				source_draft_version: delivery.draftVersion ?? null,
				actor_kind: delivery.actor.kind,
				actor_id: delivery.actor.id ?? null,
				state: "pending",
				generation: 0,
				attempt_count: 0,
				next_attempt_at: attempt.finishedAt,
				created_at: attempt.finishedAt,
				updated_at: attempt.finishedAt,
			})
			.onConflictDoNothing()
			.run();
	}

	#findNextDispatchableRow(now: string): DeliveryRow | undefined {
		return this.#db
			.select()
			.from(schema.outboundDeliveries)
			.where(
				or(
					and(
						eq(schema.outboundDeliveries.status, "queued"),
						or(
							lte(schema.outboundDeliveries.available_at, now),
							sql`strftime('%Y-%m-%dT%H:%M:%fZ', ${schema.outboundDeliveries.available_at}) IS NULL`,
							sql`strftime('%Y-%m-%dT%H:%M:%fZ', ${schema.outboundDeliveries.available_at}) <> ${schema.outboundDeliveries.available_at}`,
						),
					),
					and(
						eq(schema.outboundDeliveries.status, "retrying"),
						or(
							lte(schema.outboundDeliveries.next_attempt_at, now),
							isNull(schema.outboundDeliveries.next_attempt_at),
							sql`strftime('%Y-%m-%dT%H:%M:%fZ', ${schema.outboundDeliveries.next_attempt_at}) IS NULL`,
							sql`strftime('%Y-%m-%dT%H:%M:%fZ', ${schema.outboundDeliveries.next_attempt_at}) <> ${schema.outboundDeliveries.next_attempt_at}`,
						),
					),
				),
			)
			.orderBy(
				sql`CASE
					WHEN ${schema.outboundDeliveries.status} = 'retrying'
						AND strftime('%Y-%m-%dT%H:%M:%fZ', ${schema.outboundDeliveries.next_attempt_at}) = ${schema.outboundDeliveries.next_attempt_at}
					THEN ${schema.outboundDeliveries.next_attempt_at}
					WHEN ${schema.outboundDeliveries.status} = 'queued'
						AND strftime('%Y-%m-%dT%H:%M:%fZ', ${schema.outboundDeliveries.available_at}) = ${schema.outboundDeliveries.available_at}
					THEN ${schema.outboundDeliveries.available_at}
					ELSE '1970-01-01T00:00:00.000Z'
				END`,
				schema.outboundDeliveries.created_at,
				schema.outboundDeliveries.id,
			)
			.limit(1)
			.get();
	}

	#hydrateExpiredDelivery(row: DeliveryRow): StoredOutboundDelivery {
		const hydrated = this.#hydrateDelivery(row);
		if (hydrated.storageIntegrityCode) {
			return {
				...hydrated,
				recoveryIntegrityCode: "outbound_delivery_record_invalid",
			};
		}
		const phaseMetadataValid =
			(row.dispatch_phase === null && row.active_attempt_id === null) ||
			(row.dispatch_phase === "preflight" && row.active_attempt_id === null) ||
			(row.dispatch_phase === "provider" && row.active_attempt_id !== null);
		const leaseMetadataValid =
			typeof row.lease_token === "string" &&
			row.lease_token.trim().length > 0 &&
			typeof row.lease_expires_at === "string" &&
			isCanonicalUtcTimestamp(row.lease_expires_at);
		if (phaseMetadataValid && leaseMetadataValid) return hydrated;
		return {
			...hydrated,
			...(phaseMetadataValid
				? {}
				: { dispatchPhase: undefined, activeAttemptId: undefined }),
			recoveryIntegrityCode: phaseMetadataValid
				? "outbound_sending_lease_invalid"
				: "outbound_dispatch_phase_invalid",
		};
	}

	#markUnknownWithoutHydration(
		row: DeliveryRow,
		at: string,
		code:
			| "outbound_delivery_record_invalid"
			| "outbound_reconciliation_record_invalid",
	): void {
		this.#db
			.update(schema.outboundDeliveries)
			.set({
				status: "unknown",
				dispatch_phase: null,
				active_attempt_id: null,
				lease_token: null,
				lease_expires_at: null,
				next_attempt_at: null,
				unknown_at: at,
				updated_at: at,
				last_error_code: code,
				last_error_message:
					"The local outbound record is inconsistent and requires audited repair.",
			})
			.where(
				and(
					eq(schema.outboundDeliveries.id, row.id),
					eq(schema.outboundDeliveries.status, row.status),
				),
			)
			.run();
		this.#db
			.update(schema.outboundDeliveryAttempts)
			.set({
				status: "unknown",
				finished_at: at,
				error_code: code,
			})
			.where(
				and(
					eq(schema.outboundDeliveryAttempts.delivery_id, row.id),
					eq(schema.outboundDeliveryAttempts.status, "sending"),
				),
			)
			.run();
	}

	#hydrateDelivery(row: DeliveryRow): StoredOutboundDelivery {
		const snapshot = this.getSnapshot(row.email_id);
		const email = this.#db
			.select({
				folderId: schema.emails.folder_id,
				sender: schema.emails.sender,
			})
			.from(schema.emails)
			.where(eq(schema.emails.id, row.email_id))
			.get();
		const mailboxId =
			snapshot?.mailboxId ?? normalizeMailAddress(email?.sender ?? "");
		let delivery: StoredOutboundDelivery;
		try {
			if (!mailboxId) {
				throw new Error(
					`Missing mailbox identity for outbox delivery ${row.id}`,
				);
			}
			delivery = deliveryRowToStored(row, mailboxId);
		} catch {
			const epoch = "1970-01-01T00:00:00.000Z";
			const updatedAt = isCanonicalUtcTimestamp(row.updated_at)
				? row.updated_at
				: epoch;
			delivery = {
				id: row.id,
				emailId: row.email_id,
				mailboxId: mailboxId ?? "",
				kind: DELIVERY_KINDS.has(row.kind as OutboundDeliveryKind)
					? (row.kind as OutboundDeliveryKind)
					: "compose",
				status: "unknown",
				idempotencyKey: row.idempotency_key,
				commandFingerprint: optional(row.command_fingerprint),
				source: DELIVERY_SOURCES.has(row.source as OutboundDeliverySource)
					? (row.source as OutboundDeliverySource)
					: "api",
				actor: { kind: "system" },
				createdAt: isCanonicalUtcTimestamp(row.created_at)
					? row.created_at
					: epoch,
				updatedAt,
				availableAt: isCanonicalUtcTimestamp(row.available_at)
					? row.available_at
					: epoch,
				undoUntil: isCanonicalUtcTimestamp(row.undo_until)
					? row.undo_until
					: epoch,
				attemptCount:
					Number.isInteger(row.attempt_count) && row.attempt_count >= 0
						? row.attempt_count
						: 0,
				maxAttempts:
					Number.isInteger(row.max_attempts) && row.max_attempts > 0
						? row.max_attempts
						: 1,
				preflightDeferralCount:
					Number.isInteger(row.preflight_deferral_count) &&
					row.preflight_deferral_count >= 0
						? row.preflight_deferral_count
						: 0,
				cancellationRecoveryAttemptCount:
					Number.isInteger(row.cancellation_recovery_attempt_count) &&
					row.cancellation_recovery_attempt_count >= 0
						? row.cancellation_recovery_attempt_count
						: 0,
				acceptedAttemptCount:
					Number.isInteger(row.accepted_attempt_count) &&
					row.accepted_attempt_count >= 0
						? row.accepted_attempt_count
						: 0,
				unknownAt: updatedAt,
				lastErrorCode: "outbound_delivery_record_invalid",
				lastErrorMessage:
					"The local outbound record is inconsistent and requires audited repair.",
				storageIntegrityCode: "outbound_delivery_record_invalid",
			};
		}
		return {
			...delivery,
			...(delivery.status === "cancelled"
				? {
						cancelRecoveryPending: cancellationRecoveryPending(
						delivery.status,
						email?.folderId,
						),
					}
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
			throw new Error(
				`Duplicate pending attachment metadata: ${attachment.id}`,
			);
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
		const contentId = contentIdForDisposition(
			disposition,
			attachment.contentId ?? attachment.content_id,
		);
		const identity = snapshot.attachmentByteIdentities?.find(
			(candidate) => candidate.id === id,
		);
		if (
			!identity ||
			identity.byteLength !== attachment.size ||
			identity.sha256 !== attachment.content_sha256 ||
			identity.filename !== attachment.filename ||
			identity.mimetype !== attachment.mimetype ||
			identity.disposition !== disposition ||
			(identity.contentId ?? null) !== contentId
		) {
			throw new Error(
				`Pending attachment ${id} does not match the immutable manifest`,
			);
		}
		return {
			id,
			email_id: emailId,
			filename: attachment.filename,
			mimetype: attachment.mimetype,
			size: attachment.size,
			content_id: contentId,
			disposition,
		};
	});
}
