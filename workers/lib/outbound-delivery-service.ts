// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import {
	InvalidDeliveryTransitionError,
	canCancelDelivery,
	canRetryFailedDelivery,
	computeAvailableAt,
	transitionDelivery,
	type EnqueueOutboundCommand,
	type OutboundDeliveryActor,
	type OutboundDeliveryKind,
	type OutboundDeliveryRecord,
	type OutboundMessageSnapshot,
} from "./outbound-delivery-contract.ts";

export interface StoredOutboundDelivery extends OutboundDeliveryRecord {
	kind: OutboundDeliveryKind;
	draftVersion?: number;
	maxAttempts: number;
	commandFingerprint?: string;
	preflightDeferralCount: number;
	cancellationRecoveryAttemptCount: number;
	retryOriginStatus?: "failed" | "unknown";
	dispatchPhase?: "preflight" | "provider";
	activeAttemptId?: string;
	acceptedAttemptCount: number;
	duplicateAcceptanceAt?: string;
	leaseToken?: string;
	/** Transient adapter signal used only while recovering malformed storage. */
	recoveryIntegrityCode?:
		| "outbound_dispatch_phase_invalid"
		| "outbound_sending_lease_invalid"
		| "outbound_delivery_record_invalid";
	storageIntegrityCode?: "outbound_delivery_record_invalid";
}

export type DispatchableDeliveryCandidate =
	| { state: "ready"; delivery: StoredOutboundDelivery }
	| {
			state: "integrity_failure";
			deliveryId: string;
			status: "queued" | "retrying";
			code: "outbound_dispatch_metadata_invalid";
			outcome: "failed" | "unknown";
	  };

export type OutboundDeliveryAttemptStatus =
	| "sending"
	| "accepted"
	| "rejected_retryable"
	| "rejected_permanent"
	| "unknown";

export interface OutboundDeliveryAttempt {
	id: string;
	deliveryId: string;
	attemptNumber: number;
	status: OutboundDeliveryAttemptStatus;
	leaseToken: string;
	startedAt: string;
	finishedAt?: string;
	sesMessageId?: string;
	httpStatus?: number;
	errorCode?: string;
	errorMessage?: string;
	providerState:
		| "none"
		| "delivered"
		| "bounced"
		| "complained"
		| "bounce_scope_unknown";
	providerEventAt?: string;
	providerEventId?: string;
	/** Transient adapter signal. Invalid persisted attempt metadata is never sendable. */
	storageIntegrityCode?: "outbound_attempt_record_invalid";
}

export type AcceptedAttemptProviderState =
	| "none"
	| "delivered"
	| "bounced"
	| "complained"
	| "bounce_scope_unknown";

export function aggregateAcceptedAttemptProviderTruth(
	states: readonly string[],
): "sent" | "bounced" | "unknown" {
	const validStates = new Set<AcceptedAttemptProviderState>([
		"none",
		"delivered",
		"bounced",
		"complained",
		"bounce_scope_unknown",
	]);
	if (
		states.length === 0 ||
		states.some((state) => !validStates.has(state as AcceptedAttemptProviderState))
	) {
		return "unknown";
	}
	if (
		states.some(
			(state) =>
				state === "none" || state === "delivered" || state === "complained",
		)
	) {
		return "sent";
	}
	if (states.some((state) => state === "bounce_scope_unknown")) {
		return "unknown";
	}
	return "bounced";
}

export function canReconcileConcurrentProviderTerminal(
	status: OutboundDeliveryRecord["status"] | undefined,
): status is "sent" | "bounced" | "unknown" {
	return status === "sent" || status === "bounced" || status === "unknown";
}

/**
 * Persistence seam for the Durable Object adapter. Every command below is
 * executed inside one adapter-owned transaction.
 */
export interface OutboundDeliveryTransaction {
	findDeliveryByIdempotencyKey(key: string): StoredOutboundDelivery | null;
	findDeliveryBySourceDraft?(
		id: string,
		version: number,
	): StoredOutboundDelivery | null;
	/** Must execute in the same transaction as snapshot + delivery insertion. */
	assertSourceDraftVersion(
		id: string,
		version: number,
	):
		| { status: "valid" }
		| { status: "not_found" | "not_draft" }
		| { status: "version_conflict"; currentVersion: number };
	findDeliveryBySesMessageId?(messageId: string): StoredOutboundDelivery | null;
	getDelivery(id: string): StoredOutboundDelivery | null;
	listDeliveries(): StoredOutboundDelivery[];
	/** Optional indexed production seams. In-memory test stores may use fallbacks. */
	findNextDispatchableCandidate?(
		now: string,
	): DispatchableDeliveryCandidate | null;
	findNextDispatchable?(now: string): StoredOutboundDelivery | null;
	failDispatchableIntegrity?(
		candidate: Extract<
			DispatchableDeliveryCandidate,
			{ state: "integrity_failure" }
		>,
		at: string,
	): void;
	listExpiredSending?(now: string): StoredOutboundDelivery[];
	listDeliveriesByStatuses?(
		statuses: StoredOutboundDelivery["status"][],
	): StoredOutboundDelivery[];
	listUnreconciledAccepted?(now: string, limit: number): StoredOutboundDelivery[];
	listPendingCancellationRecovery?(
		now: string,
		limit: number,
	): StoredOutboundDelivery[];
	deferAcceptedReconciliation?(
		deliveryId: string,
		retryAt: string,
		code: string,
		message: string,
	): void;
	completeAcceptedReconciliation?(deliveryId: string): void;
	findNextActionAt?(): string | null;
	insertDelivery(delivery: StoredOutboundDelivery): void;
	updateDelivery(delivery: StoredOutboundDelivery): void;
	insertSnapshot(emailId: string, snapshot: OutboundMessageSnapshot): void;
	getSnapshot(emailId: string): OutboundMessageSnapshot | null;
	insertAttempt(attempt: OutboundDeliveryAttempt): void;
	listAttemptsByDelivery(deliveryId: string): OutboundDeliveryAttempt[];
	updateAttempt(attempt: OutboundDeliveryAttempt): void;
	recordAcceptedRecovery?(
		delivery: StoredOutboundDelivery,
		attempt: OutboundDeliveryAttempt,
	): void;
}

export interface OutboundDeliveryStorage {
	transaction<T>(work: (tx: OutboundDeliveryTransaction) => T): T;
}

export interface TruthfulOutboxServiceOptions {
	createId: (prefix: "delivery" | "email" | "attempt" | "lease") => string;
	defaultMaxAttempts?: number;
}

export interface EnqueuedDelivery {
	delivery: StoredOutboundDelivery;
	snapshot: OutboundMessageSnapshot;
	replayed: boolean;
	outcome: OutboundEnqueueOutcome;
}

export type OutboundEnqueueOutcome =
	| "enqueued"
	| "active_replay"
	| "terminal_replay";

export function outboundEnqueueOutcome(
	delivery: { status: string },
	replayed: boolean,
): OutboundEnqueueOutcome {
	if (!replayed) return "enqueued";
	return delivery.status === "queued" ||
		delivery.status === "sending" ||
		delivery.status === "retrying"
		? "active_replay"
		: "terminal_replay";
}

export type ClaimedPreflight = {
	delivery: StoredOutboundDelivery;
	snapshot: OutboundMessageSnapshot;
};

export interface ClaimedDelivery {
	delivery: StoredOutboundDelivery;
	attempt: OutboundDeliveryAttempt;
	snapshot: OutboundMessageSnapshot;
}

export type RecoveredDeliveryLease =
	| { phase: "preflight"; delivery: StoredOutboundDelivery }
	| {
			phase: "provider";
	delivery: StoredOutboundDelivery;
			attempt?: OutboundDeliveryAttempt;
	  };

export interface FinalizedDeliveryAttempt {
	delivery: StoredOutboundDelivery;
	attempt: OutboundDeliveryAttempt;
	sourceDraftAction: SourceDraftAction;
}

export interface DeliveryMutationResult {
	delivery: StoredOutboundDelivery;
	actor: OutboundDeliveryActor;
	sourceDraftAction: SourceDraftAction;
	retryCancellationRestored?: boolean;
}

export type PreflightMutationResult = {
	delivery: StoredOutboundDelivery;
	sourceDraftAction: SourceDraftAction;
};

export type SourceDraftAction = "retain" | "consume" | "none";

export interface RetryableFailureDetails {
	at: string;
	retryAt: string;
	code: string;
	message?: string;
	httpStatus?: number;
}

export interface DefinitiveFailureDetails {
	at: string;
	code: string;
	message?: string;
	httpStatus?: number;
}

export class DeliveryLeaseError extends Error {
	constructor(deliveryId: string) {
		super(`No active delivery lease matches ${deliveryId}`);
		this.name = "DeliveryLeaseError";
	}
}

export class OutboundDeliveryNotFoundError extends Error {
	constructor(deliveryId: string) {
		super(`Outbound delivery ${deliveryId} was not found`);
		this.name = "OutboundDeliveryNotFoundError";
	}
}

export class OutboundDeliveryIntegrityError extends Error {
	constructor(deliveryId: string) {
		super(`Outbound delivery ${deliveryId} requires audited storage repair`);
		this.name = "OutboundDeliveryIntegrityError";
	}
}

export class OutboundDeliveryNotRetryableError extends Error {
	constructor(deliveryId: string) {
		super(
			`Outbound delivery ${deliveryId} cannot be retried without rebuilding its immutable message snapshot`,
		);
		this.name = "OutboundDeliveryNotRetryableError";
	}
}

export class DuplicateRiskAcknowledgementRequiredError extends Error {
	constructor(deliveryId: string) {
		super(
			`Retrying unknown delivery ${deliveryId} requires duplicate-risk acknowledgement`,
		);
		this.name = "DuplicateRiskAcknowledgementRequiredError";
	}
}

export class OutboundRetryCapacityError extends Error {
	constructor() {
		super("This Mailbox has the maximum safe bulk backlog.");
		this.name = "OutboundRetryCapacityError";
	}
}

export class OutboundIdempotencyConflictError extends Error {
	readonly reason: "command_mismatch" | "legacy_idempotency_unverifiable";

	constructor(reason: OutboundIdempotencyConflictError["reason"]) {
		super(
			reason === "command_mismatch"
				? "This send identity is already bound to different content."
				: "This legacy send identity cannot be verified for safe replay.",
		);
		this.name = "OutboundIdempotencyConflictError";
		this.reason = reason;
	}
}

export type OutboundReplayConflictReason =
	| "command_mismatch"
	| "legacy_idempotency_unverifiable";

export type OutboundReplayResolution =
	| { status: "none" }
	| { status: "exact"; delivery: StoredOutboundDelivery }
	| {
			status: "conflict";
			reason: OutboundReplayConflictReason;
			delivery: StoredOutboundDelivery;
	  };

export function assertOutboundCommandFingerprint(
	commandFingerprint: string,
): void {
	if (!/^[0-9a-f]{64}$/.test(commandFingerprint)) {
		throw new Error("Outbound command fingerprint is invalid");
	}
}

function assertReplayFingerprint(
	delivery: StoredOutboundDelivery,
	command: EnqueueOutboundCommand,
): void {
	const resolution = classifyOutboundReplay(
		delivery,
		command.commandFingerprint,
	);
	if (resolution.status === "conflict") {
		throw new OutboundIdempotencyConflictError(resolution.reason);
	}
}

export function classifyOutboundReplay(
	delivery: StoredOutboundDelivery | null,
	commandFingerprint: string,
): OutboundReplayResolution {
	if (!delivery) return { status: "none" };
	if (!delivery.commandFingerprint) {
		return {
			status: "conflict",
			reason: "legacy_idempotency_unverifiable",
			delivery,
		};
	}
	if (delivery.commandFingerprint !== commandFingerprint) {
		return {
			status: "conflict",
			reason: "command_mismatch",
			delivery,
		};
	}
	return { status: "exact", delivery };
}

export class SourceDraftConflictError extends Error {
	readonly reason: "not_found" | "not_draft" | "version_conflict";
	readonly currentVersion?: number;

	constructor(
		draftId: string,
		reason: SourceDraftConflictError["reason"],
		currentVersion?: number,
	) {
		super(
			`Source draft ${draftId} ${reason}${currentVersion === undefined ? "" : ` (current ${currentVersion})`}`,
		);
		this.name = "SourceDraftConflictError";
		this.reason = reason;
		this.currentVersion = currentVersion;
	}
}

export class TruthfulOutboxService {
	static readonly MAX_PREFLIGHT_INTEGRITY_FAILURES_PER_CLAIM = 25;

	readonly #storage: OutboundDeliveryStorage;
	readonly #createId: TruthfulOutboxServiceOptions["createId"];
	readonly #defaultMaxAttempts: number;

	constructor(
		storage: OutboundDeliveryStorage,
		options: TruthfulOutboxServiceOptions,
	) {
		this.#storage = storage;
		this.#createId = options.createId;
		this.#defaultMaxAttempts = options.defaultMaxAttempts ?? 4;
	}

	enqueue(
		command: EnqueueOutboundCommand,
		onCommitted?: (result: EnqueuedDelivery) => void,
	): EnqueuedDelivery {
		return this.#storage.transaction((tx) => {
			assertOutboundCommandFingerprint(command.commandFingerprint);
			const finish = (result: EnqueuedDelivery): EnqueuedDelivery => {
				onCommitted?.(result);
				return result;
			};
			const existing = tx.findDeliveryByIdempotencyKey(command.idempotencyKey);
			if (existing) {
				assertReplayFingerprint(existing, command);
				const snapshot = tx.getSnapshot(existing.emailId);
				if (!snapshot) {
					throw new Error(`Missing outbox snapshot for ${existing.id}`);
				}
				return finish({
					delivery: existing,
					snapshot,
					replayed: true,
					outcome: outboundEnqueueOutcome(existing, true),
				});
			}
			const sourceDraft = validateSourceDraftReference(command.snapshot);
			if (sourceDraft.draftId !== undefined) {
				const sameDraft = tx.findDeliveryBySourceDraft
					? tx.findDeliveryBySourceDraft(
							sourceDraft.draftId,
							sourceDraft.draftVersion!,
						)
					: (tx
							.listDeliveries()
							.find(
							(delivery) =>
								delivery.draftId === sourceDraft.draftId &&
								delivery.draftVersion === sourceDraft.draftVersion,
							) ?? null);
				if (sameDraft) {
					assertReplayFingerprint(sameDraft, command);
					const snapshot = tx.getSnapshot(sameDraft.emailId);
					if (!snapshot) {
						throw new Error(`Missing outbox snapshot for ${sameDraft.id}`);
					}
					return finish({
						delivery: sameDraft,
						snapshot,
						replayed: true,
						outcome: outboundEnqueueOutcome(sameDraft, true),
					});
				}
			}

			const deliveryId = this.#createId("delivery");
			const emailId = this.#createId("email");
			const snapshot = structuredClone(command.snapshot);
			if (sourceDraft.draftId !== undefined) {
				const assertion = tx.assertSourceDraftVersion(
					sourceDraft.draftId,
					sourceDraft.draftVersion!,
				);
				if (assertion.status !== "valid") {
					throw new SourceDraftConflictError(
						sourceDraft.draftId,
						assertion.status,
						assertion.status === "version_conflict"
							? assertion.currentVersion
							: undefined,
					);
				}
			}
			const actor: OutboundDeliveryActor = { ...command.actor };
			const delivery: StoredOutboundDelivery = {
				id: deliveryId,
				emailId,
				...sourceDraft,
				mailboxId: snapshot.mailboxId,
				kind: snapshot.kind,
				status: "queued",
				idempotencyKey: command.idempotencyKey,
				commandFingerprint: command.commandFingerprint,
				source: command.source,
				actor,
				createdAt: command.requestedAt,
				updatedAt: command.requestedAt,
				availableAt: computeAvailableAt(
					command.undoUntil,
					command.scheduledFor,
				),
				undoUntil: command.undoUntil,
				scheduledFor: command.scheduledFor,
				attemptCount: 0,
				maxAttempts: this.#defaultMaxAttempts,
				preflightDeferralCount: 0,
				cancellationRecoveryAttemptCount: 0,
				acceptedAttemptCount: 0,
			};

			tx.insertSnapshot(emailId, snapshot);
			tx.insertDelivery(delivery);
			return finish({
				delivery,
				snapshot,
				replayed: false,
				outcome: "enqueued",
			});
		});
	}

	list(): StoredOutboundDelivery[] {
		return this.#storage.transaction((tx) => tx.listDeliveries());
	}

	get(deliveryId: string): StoredOutboundDelivery | null {
		return this.#storage.transaction((tx) => tx.getDelivery(deliveryId));
	}

	getByIdempotencyKey(key: string): StoredOutboundDelivery | null {
		return this.#storage.transaction((tx) =>
			tx.findDeliveryByIdempotencyKey(key),
		);
	}

	getBySourceDraft(id: string, version: number): StoredOutboundDelivery | null {
		return this.#storage.transaction((tx) =>
			tx.findDeliveryBySourceDraft
				? tx.findDeliveryBySourceDraft(id, version)
				: (tx
						.listDeliveries()
						.find(
							(delivery) =>
								delivery.draftId === id && delivery.draftVersion === version,
						) ?? null),
		);
	}

	getBySesMessageId(messageId: string): StoredOutboundDelivery | null {
		return this.#storage.transaction((tx) => {
			if (tx.findDeliveryBySesMessageId) {
				return tx.findDeliveryBySesMessageId(messageId);
			}
			return (
				tx
					.listDeliveries()
					.find((delivery) => delivery.sesMessageId === messageId) ?? null
			);
		});
	}

	listByStatuses(
		statuses: StoredOutboundDelivery["status"][],
	): StoredOutboundDelivery[] {
		return this.#storage.transaction((tx) =>
			tx.listDeliveriesByStatuses
				? tx.listDeliveriesByStatuses(statuses)
				: tx
						.listDeliveries()
						.filter((delivery) => statuses.includes(delivery.status)),
		);
	}

	listUnreconciledAccepted(
		now: string,
		limit = 10,
	): StoredOutboundDelivery[] {
		return this.#storage.transaction((tx) =>
			tx.listUnreconciledAccepted
				? tx.listUnreconciledAccepted(now, limit)
				: tx
						.listDeliveries()
						.filter((delivery) => delivery.status === "sent")
						.slice(0, limit),
		);
	}

	listPendingCancellationRecovery(
		now: string,
		limit = 10,
	): StoredOutboundDelivery[] {
		return this.#storage.transaction((tx) =>
			tx.listPendingCancellationRecovery
				? tx.listPendingCancellationRecovery(now, limit)
				: tx
						.listDeliveries()
						.filter(
							(delivery) =>
								delivery.status === "cancelled" &&
								delivery.cancelRecoveryPending === true &&
								(delivery.nextAttemptAt === undefined ||
									delivery.nextAttemptAt <= now),
						)
						.slice(0, limit),
		);
	}

	deferAcceptedReconciliation(
		deliveryId: string,
		retryAt: string,
		code: string,
		message: string,
	): void {
		this.#storage.transaction((tx) => {
			if (!tx.deferAcceptedReconciliation) {
				const delivery = tx.getDelivery(deliveryId);
				if (!delivery || delivery.status !== "sent") return;
				tx.updateDelivery({
					...delivery,
					nextAttemptAt: retryAt,
					lastErrorCode: code,
					lastErrorMessage: message,
				});
				return;
			}
			tx.deferAcceptedReconciliation(deliveryId, retryAt, code, message);
		});
	}

	completeAcceptedReconciliation(deliveryId: string): void {
		this.#storage.transaction((tx) => {
			if (tx.completeAcceptedReconciliation) {
				tx.completeAcceptedReconciliation(deliveryId);
				return;
			}
			const delivery = tx.getDelivery(deliveryId);
			if (!delivery || delivery.status !== "sent") return;
			tx.updateDelivery({
				...delivery,
				nextAttemptAt: undefined,
				...([
					"outbound_reconciliation_record_invalid",
					"outbound_acceptance_identity_missing",
					"outbound_reconciliation_deferred",
				].includes(delivery.lastErrorCode ?? "")
					? { lastErrorCode: undefined, lastErrorMessage: undefined }
					: {}),
			});
		});
	}

	nextActionAt(): string | null {
		return this.#storage.transaction((tx) => {
			if (tx.findNextActionAt) return tx.findNextActionAt();
			const candidates = tx.listDeliveries().flatMap((delivery) => {
				if (delivery.status === "queued") return [delivery.availableAt];
				if (delivery.status === "retrying" && delivery.nextAttemptAt) {
					return [delivery.nextAttemptAt];
				}
				if (delivery.status === "sending" && delivery.leaseExpiresAt) {
					return [delivery.leaseExpiresAt];
				}
				if (delivery.status === "cancelled" && delivery.cancelRecoveryPending) {
					return [delivery.nextAttemptAt ?? delivery.updatedAt];
				}
				return [];
			});
			return candidates.sort((a, b) => a.localeCompare(b))[0] ?? null;
		});
	}

	cancel(
		deliveryId: string,
		actor: OutboundDeliveryActor,
		at: string,
		onCommitted?: (
			delivery: StoredOutboundDelivery,
			outcome: "delivery_cancelled" | "retry_restored",
		) => void,
	): DeliveryMutationResult {
		return this.#storage.transaction((tx) => {
			const delivery = tx.getDelivery(deliveryId);
			if (!delivery) throw new OutboundDeliveryNotFoundError(deliveryId);
			assertDeliveryStorageIntegrity(delivery);
			if (!canCancelDelivery(delivery.status)) {
				throw new InvalidDeliveryTransitionError(delivery.status, "cancel");
			}
			if (delivery.retryOriginStatus) {
				const retryOriginStatus = delivery.retryOriginStatus;
				const restored: StoredOutboundDelivery = {
					...delivery,
					actor: { ...actor },
					status: retryOriginStatus,
					retryOriginStatus: undefined,
					dispatchPhase: undefined,
					activeAttemptId: undefined,
					leaseToken: undefined,
					leaseExpiresAt: undefined,
					nextAttemptAt: undefined,
					failedAt:
						retryOriginStatus === "failed" ? delivery.failedAt ?? at : undefined,
					unknownAt:
						retryOriginStatus === "unknown" ? delivery.unknownAt ?? at : undefined,
					cancelledAt: undefined,
					lastErrorCode: `outbound_retry_cancelled_restored_${retryOriginStatus}`,
					lastErrorMessage:
						retryOriginStatus === "unknown"
							? "The retry was cancelled. The prior provider outcome remains unknown."
							: "The retry was cancelled. The prior failed outcome remains authoritative.",
					updatedAt: at,
				};
				tx.updateDelivery(restored);
				onCommitted?.(restored, "retry_restored");
				return {
					delivery: restored,
					actor: { ...actor },
					sourceDraftAction: sourceDraftAction(restored, "retain"),
					retryCancellationRestored: true,
				};
			}
			const cancelled: StoredOutboundDelivery = {
				...delivery,
				actor: { ...actor },
				status: transitionDelivery(delivery.status, "cancel"),
				nextAttemptAt: at,
				cancellationRecoveryAttemptCount: 0,
				cancelledAt: at,
				updatedAt: at,
			};
			tx.updateDelivery(cancelled);
			onCommitted?.(cancelled, "delivery_cancelled");
			return {
				delivery: cancelled,
				actor: { ...actor },
				sourceDraftAction: sourceDraftAction(cancelled, "retain"),
			};
		});
	}

	claimNextForPreflight(
		now: string,
		leaseDurationMs: number,
	): ClaimedPreflight | null {
		return this.#storage.transaction((tx) => {
			for (
				let inspected = 0;
				inspected <
				TruthfulOutboxService.MAX_PREFLIGHT_INTEGRITY_FAILURES_PER_CLAIM;
				inspected += 1
			) {
				const indexedCandidate = tx.findNextDispatchableCandidate?.(now);
				if (indexedCandidate?.state === "integrity_failure") {
					if (!tx.failDispatchableIntegrity) {
						throw new Error("Outbox storage cannot repair dispatch integrity");
					}
					tx.failDispatchableIntegrity(indexedCandidate, now);
					continue;
				}
				const delivery =
					indexedCandidate?.state === "ready"
						? indexedCandidate.delivery
						: (tx.findNextDispatchable
				? [tx.findNextDispatchable(now)].filter(
							(candidate): candidate is StoredOutboundDelivery =>
								Boolean(candidate),
						)
					: tx.listDeliveries()
					)
				.filter(
					(candidate) =>
										(candidate.status === "queued" &&
											candidate.availableAt <= now) ||
						(candidate.status === "retrying" &&
							candidate.nextAttemptAt !== undefined &&
							candidate.nextAttemptAt <= now),
				)
				.sort(
					(a, b) =>
						(a.nextAttemptAt ?? a.availableAt).localeCompare(
							b.nextAttemptAt ?? b.availableAt,
						) || a.createdAt.localeCompare(b.createdAt),
				)[0];
			if (!delivery) return null;

			const snapshot = tx.getSnapshot(delivery.emailId);
			if (!snapshot) {
						const failed: StoredOutboundDelivery = {
							...delivery,
							status:
								delivery.retryOriginStatus === "unknown" ? "unknown" : "failed",
							retryOriginStatus: undefined,
						dispatchPhase: undefined,
						activeAttemptId: undefined,
						nextAttemptAt: undefined,
						leaseToken: undefined,
						leaseExpiresAt: undefined,
							failedAt:
								delivery.retryOriginStatus === "unknown" ? undefined : now,
							unknownAt:
								delivery.retryOriginStatus === "unknown"
									? delivery.unknownAt ?? now
									: undefined,
							lastErrorCode:
								delivery.retryOriginStatus === "unknown"
									? "outbound_retry_failed_original_unknown"
									: "outbound_snapshot_invalid",
							lastErrorMessage:
								delivery.retryOriginStatus === "unknown"
									? "The retry could not run, but an earlier provider outcome remains unknown."
									: "The immutable outbound snapshot is unavailable or invalid.",
						updatedAt: now,
					};
					tx.updateDelivery(failed);
					continue;
			}

			const leaseToken = this.#createId("lease");
			const leaseExpiresAt = new Date(
				Date.parse(now) + leaseDurationMs,
			).toISOString();
			const readyStatus =
				delivery.status === "retrying"
					? transitionDelivery(delivery.status, "retry_ready")
					: delivery.status;
			const claimed: StoredOutboundDelivery = {
				...delivery,
				status: transitionDelivery(readyStatus, "start_sending"),
					dispatchPhase: "preflight",
					activeAttemptId: undefined,
				nextAttemptAt: undefined,
				leaseToken,
				leaseExpiresAt,
				updatedAt: now,
			};
				tx.updateDelivery(claimed);
				return { delivery: claimed, snapshot };
			}
			return null;
		});
	}

	deferPreflight(
		deliveryId: string,
		leaseToken: string,
		details: RetryableFailureDetails,
	): PreflightMutationResult {
		return this.#storage.transaction((tx) => {
			const delivery = this.#requirePreflightLease(tx, deliveryId, leaseToken);
			if (hasUnsafeProviderAttempt(tx, deliveryId, leaseToken)) {
				throw new DeliveryLeaseError(deliveryId);
			}
			const deferred: StoredOutboundDelivery = {
				...delivery,
				status: transitionDelivery(delivery.status, "schedule_retry"),
				dispatchPhase: undefined,
				activeAttemptId: undefined,
				leaseToken: undefined,
				leaseExpiresAt: undefined,
				nextAttemptAt: details.retryAt,
				preflightDeferralCount: delivery.preflightDeferralCount + 1,
				lastErrorCode: details.code,
				lastErrorMessage: details.message,
				updatedAt: details.at,
			};
			tx.updateDelivery(deferred);
			return {
				delivery: deferred,
				sourceDraftAction: sourceDraftAction(deferred, "retain"),
			};
		});
	}

	failPreflight(
		deliveryId: string,
		leaseToken: string,
		details: DefinitiveFailureDetails,
	): PreflightMutationResult {
		return this.#storage.transaction((tx) => {
			const delivery = this.#requirePreflightLease(tx, deliveryId, leaseToken);
			if (hasUnsafeProviderAttempt(tx, deliveryId, leaseToken)) {
				throw new DeliveryLeaseError(deliveryId);
			}
			const failed: StoredOutboundDelivery = {
				...delivery,
				status:
					delivery.retryOriginStatus === "unknown" ? "unknown" : "failed",
				retryOriginStatus: undefined,
				dispatchPhase: undefined,
				activeAttemptId: undefined,
				leaseToken: undefined,
				leaseExpiresAt: undefined,
				failedAt:
					delivery.retryOriginStatus === "unknown" ? undefined : details.at,
				unknownAt:
					delivery.retryOriginStatus === "unknown"
						? delivery.unknownAt ?? details.at
						: undefined,
				lastErrorCode:
					delivery.retryOriginStatus === "unknown"
						? "outbound_retry_failed_original_unknown"
						: details.code,
				lastErrorMessage:
					delivery.retryOriginStatus === "unknown"
						? "The retry failed before provider acceptance, but an earlier provider outcome remains unknown."
						: details.message,
				updatedAt: details.at,
			};
			tx.updateDelivery(failed);
			return {
				delivery: failed,
				sourceDraftAction: sourceDraftAction(failed, "retain"),
			};
		});
	}

	beginProviderAttempt(
		deliveryId: string,
		leaseToken: string,
		attemptId: string,
		at: string,
		providerLeaseDurationMs: number,
	): ClaimedDelivery {
		return this.#storage.transaction((tx) => {
			const delivery = this.#requirePreflightLease(tx, deliveryId, leaseToken);
			if (hasUnsafeProviderAttempt(tx, deliveryId, leaseToken)) {
				throw new DeliveryLeaseError(deliveryId);
			}
			const startedAt = Date.parse(at);
			const preflightLeaseExpiresAt = Date.parse(delivery.leaseExpiresAt ?? "");
			if (
				!Number.isFinite(startedAt) ||
				!Number.isFinite(preflightLeaseExpiresAt) ||
				startedAt >= preflightLeaseExpiresAt ||
				!attemptId.trim() ||
				!Number.isFinite(providerLeaseDurationMs) ||
				providerLeaseDurationMs <= 0
			) {
				throw new DeliveryLeaseError(deliveryId);
			}
			const snapshot = tx.getSnapshot(delivery.emailId);
			if (!snapshot)
				throw new Error(`Missing outbox snapshot for ${delivery.id}`);
			const attempt: OutboundDeliveryAttempt = {
				id: attemptId,
				deliveryId,
				attemptNumber: delivery.attemptCount + 1,
				status: "sending",
				leaseToken,
				startedAt: at,
				providerState: "none",
			};
			const dispatching: StoredOutboundDelivery = {
				...delivery,
				attemptCount: attempt.attemptNumber,
				dispatchPhase: "provider",
				activeAttemptId: attempt.id,
				leaseExpiresAt: new Date(
					startedAt + providerLeaseDurationMs,
				).toISOString(),
				updatedAt: at,
			};
			tx.updateDelivery(dispatching);
			tx.insertAttempt(attempt);
			return { delivery: dispatching, attempt, snapshot };
		});
	}

	finalizeRetryableFailure(
		deliveryId: string,
		leaseToken: string,
		details: RetryableFailureDetails,
	): FinalizedDeliveryAttempt {
		return this.#storage.transaction((tx) => {
			const { delivery, attempt } = this.#requireLease(
				tx,
				deliveryId,
				leaseToken,
			);
			const exhausted = delivery.attemptCount >= delivery.maxAttempts;
			const finalizedDelivery: StoredOutboundDelivery = {
				...delivery,
				status:
					exhausted && delivery.retryOriginStatus === "unknown"
						? "unknown"
						: transitionDelivery(
								delivery.status,
								exhausted ? "exhaust_retries" : "schedule_retry",
							),
				retryOriginStatus: exhausted
					? undefined
					: delivery.retryOriginStatus,
				dispatchPhase: undefined,
				activeAttemptId: undefined,
				leaseToken: undefined,
				leaseExpiresAt: undefined,
				nextAttemptAt: exhausted ? undefined : details.retryAt,
				failedAt:
					exhausted && delivery.retryOriginStatus !== "unknown"
						? details.at
						: delivery.failedAt,
				unknownAt:
					exhausted && delivery.retryOriginStatus !== "unknown"
						? undefined
						: delivery.unknownAt,
				lastErrorCode:
					exhausted && delivery.retryOriginStatus === "unknown"
						? "outbound_retry_failed_original_unknown"
						: details.code,
				lastErrorMessage:
					exhausted && delivery.retryOriginStatus === "unknown"
						? "The retry was rejected, but an earlier provider outcome remains unknown."
						: details.message,
				updatedAt: details.at,
			};
			const finalizedAttempt: OutboundDeliveryAttempt = {
				...attempt,
				status: "rejected_retryable",
				finishedAt: details.at,
				httpStatus: details.httpStatus,
				errorCode: details.code,
				errorMessage: details.message,
			};

			tx.updateDelivery(finalizedDelivery);
			tx.updateAttempt(finalizedAttempt);
			return {
				delivery: finalizedDelivery,
				attempt: finalizedAttempt,
				sourceDraftAction: sourceDraftAction(finalizedDelivery, "retain"),
			};
		});
	}

	finalizeDefinitiveFailure(
		deliveryId: string,
		leaseToken: string,
		details: DefinitiveFailureDetails,
	): FinalizedDeliveryAttempt {
		return this.#storage.transaction((tx) => {
			const { delivery, attempt } = this.#requireLease(
				tx,
				deliveryId,
				leaseToken,
			);
			const failedDelivery: StoredOutboundDelivery = {
				...delivery,
				status:
					delivery.retryOriginStatus === "unknown" ? "unknown" : "failed",
				retryOriginStatus: undefined,
				dispatchPhase: undefined,
				activeAttemptId: undefined,
				leaseToken: undefined,
				leaseExpiresAt: undefined,
				failedAt:
					delivery.retryOriginStatus === "unknown" ? undefined : details.at,
				unknownAt:
					delivery.retryOriginStatus === "unknown"
						? delivery.unknownAt ?? details.at
						: undefined,
				lastErrorCode:
					delivery.retryOriginStatus === "unknown"
						? "outbound_retry_failed_original_unknown"
						: details.code,
				lastErrorMessage:
					delivery.retryOriginStatus === "unknown"
						? "The retry was rejected, but an earlier provider outcome remains unknown."
						: details.message,
				updatedAt: details.at,
			};
			const failedAttempt: OutboundDeliveryAttempt = {
				...attempt,
				status: "rejected_permanent",
				finishedAt: details.at,
				httpStatus: details.httpStatus,
				errorCode: details.code,
				errorMessage: details.message,
			};

			tx.updateDelivery(failedDelivery);
			tx.updateAttempt(failedAttempt);
			return {
				delivery: failedDelivery,
				attempt: failedAttempt,
				sourceDraftAction: sourceDraftAction(failedDelivery, "retain"),
			};
		});
	}

	retryFailed(
		deliveryId: string,
		actor: OutboundDeliveryActor,
		at: string,
		assertRetryAllowed?: (delivery: StoredOutboundDelivery) => void,
	): DeliveryMutationResult {
		return this.#storage.transaction((tx) => {
			const delivery = tx.getDelivery(deliveryId);
			if (!delivery) throw new OutboundDeliveryNotFoundError(deliveryId);
			assertDeliveryStorageIntegrity(delivery);
			if (!canRetryFailedDelivery(delivery.lastErrorCode)) {
				throw new OutboundDeliveryNotRetryableError(deliveryId);
			}
			const queued: StoredOutboundDelivery = {
				...delivery,
				actor: { ...actor },
				status: transitionDelivery(delivery.status, "retry_failed"),
				retryOriginStatus: "failed",
				availableAt: at,
				nextAttemptAt: undefined,
				lastErrorCode: undefined,
				lastErrorMessage: undefined,
				updatedAt: at,
			};
			assertRetryAllowed?.(delivery);
			tx.updateDelivery(queued);
			return {
				delivery: queued,
				actor: { ...actor },
				sourceDraftAction: sourceDraftAction(queued, "retain"),
			};
		});
	}

	finalizeUnknown(
		deliveryId: string,
		leaseToken: string,
		details: Omit<DefinitiveFailureDetails, "httpStatus">,
	): FinalizedDeliveryAttempt {
		return this.#storage.transaction((tx) => {
			const { delivery, attempt } = this.#requireLease(
				tx,
				deliveryId,
				leaseToken,
			);
			const unknownDelivery: StoredOutboundDelivery = {
				...delivery,
				status: transitionDelivery(delivery.status, "ambiguous_outcome"),
				retryOriginStatus: undefined,
				dispatchPhase: undefined,
				activeAttemptId: undefined,
				leaseToken: undefined,
				leaseExpiresAt: undefined,
				unknownAt: details.at,
				failedAt: undefined,
				lastErrorCode: details.code,
				lastErrorMessage: details.message,
				updatedAt: details.at,
			};
			const unknownAttempt: OutboundDeliveryAttempt = {
				...attempt,
				status: "unknown",
				finishedAt: details.at,
				errorCode: details.code,
				errorMessage: details.message,
			};

			tx.updateDelivery(unknownDelivery);
			tx.updateAttempt(unknownAttempt);
			return {
				delivery: unknownDelivery,
				attempt: unknownAttempt,
				sourceDraftAction: sourceDraftAction(unknownDelivery, "retain"),
			};
		});
	}

	retryUnknown(
		deliveryId: string,
		actor: OutboundDeliveryActor,
		acknowledgeDuplicateRisk: true,
		at: string,
		assertRetryAllowed?: (delivery: StoredOutboundDelivery) => void,
	): DeliveryMutationResult {
		if (acknowledgeDuplicateRisk !== true) {
			throw new DuplicateRiskAcknowledgementRequiredError(deliveryId);
		}
		return this.#storage.transaction((tx) => {
			const delivery = tx.getDelivery(deliveryId);
			if (!delivery) throw new OutboundDeliveryNotFoundError(deliveryId);
			assertDeliveryStorageIntegrity(delivery);
			const queued: StoredOutboundDelivery = {
				...delivery,
				actor: { ...actor },
				status: transitionDelivery(delivery.status, "force_retry_unknown"),
				retryOriginStatus: "unknown",
				availableAt: at,
				lastErrorCode: undefined,
				lastErrorMessage: undefined,
				updatedAt: at,
			};
			assertRetryAllowed?.(delivery);
			tx.updateDelivery(queued);
			return {
				delivery: queued,
				actor: { ...actor },
				sourceDraftAction: sourceDraftAction(queued, "retain"),
			};
		});
	}

	finalizeAccepted(
		deliveryId: string,
		leaseToken: string,
		sesMessageId: string,
		at: string,
	): FinalizedDeliveryAttempt {
		if (!sesMessageId.trim()) {
			throw new Error("SES acceptance requires a MessageId");
		}
		return this.#storage.transaction((tx) => {
			const { delivery, attempt } = this.#requireLease(
				tx,
				deliveryId,
				leaseToken,
			);
			const sentDelivery: StoredOutboundDelivery = {
				...delivery,
				status: transitionDelivery(delivery.status, "provider_accepted"),
				retryOriginStatus: undefined,
				dispatchPhase: undefined,
				activeAttemptId: undefined,
				leaseToken: undefined,
				leaseExpiresAt: undefined,
				sesMessageId,
				sentAt: at,
				failedAt: undefined,
				unknownAt: undefined,
				lastErrorCode: undefined,
				lastErrorMessage: undefined,
				updatedAt: at,
			};
			const acceptedAttempt: OutboundDeliveryAttempt = {
				...attempt,
				status: "accepted",
				finishedAt: at,
				sesMessageId,
			};

			tx.updateDelivery(sentDelivery);
			tx.updateAttempt(acceptedAttempt);
			tx.recordAcceptedRecovery?.(sentDelivery, acceptedAttempt);
			return {
				delivery: sentDelivery,
				attempt: acceptedAttempt,
				sourceDraftAction: sourceDraftAction(sentDelivery, "consume"),
			};
		});
	}

	markBounced(
		deliveryId: string,
		details: {
			at: string;
			code: string;
			message?: string;
			sesMessageId?: string;
		},
	): StoredOutboundDelivery {
		return this.#storage.transaction((tx) => {
			const delivery = tx.getDelivery(deliveryId);
			if (!delivery) throw new OutboundDeliveryNotFoundError(deliveryId);
			assertDeliveryStorageIntegrity(delivery);
			const bounced: StoredOutboundDelivery = {
				...delivery,
				status: transitionDelivery(delivery.status, "provider_bounced"),
				retryOriginStatus: undefined,
				sesMessageId: details.sesMessageId ?? delivery.sesMessageId,
				failedAt: undefined,
				unknownAt: undefined,
				lastErrorCode: details.code,
				lastErrorMessage: details.message,
				updatedAt: details.at,
			};
			tx.updateDelivery(bounced);
			return bounced;
		});
	}

	recoverExpiredLeases(now: string): RecoveredDeliveryLease[] {
		return this.#storage.transaction((tx) => {
			const recovered: RecoveredDeliveryLease[] = [];
			const candidates = tx.listExpiredSending
				? tx.listExpiredSending(now)
				: tx.listDeliveries();
			for (const delivery of candidates) {
				if (delivery.status !== "sending") {
					continue;
				}
				const integrityFailure = delivery.recoveryIntegrityCode !== undefined;
				if (
					!integrityFailure &&
					(!delivery.leaseToken ||
					!delivery.leaseExpiresAt ||
						delivery.leaseExpiresAt > now)
				) {
					continue;
				}
				const attempts = tx.listAttemptsByDelivery(delivery.id);
				const currentLeaseAttempts = delivery.leaseToken
					? attempts.filter(
							(attempt) => attempt.leaseToken === delivery.leaseToken,
						)
					: [];
				const unsafeAttempts = attempts.filter(
					(attempt) =>
						attempt.storageIntegrityCode !== undefined ||
						currentLeaseAttempts.includes(attempt) ||
						attempt.status === "sending" ||
						attempt.status === "accepted",
				);
				const activeAttempt = unsafeAttempts[0];

				if (
					delivery.dispatchPhase === "preflight" &&
					!integrityFailure &&
					!activeAttempt
				) {
					const retrying: StoredOutboundDelivery = {
						...delivery,
						status: transitionDelivery(delivery.status, "schedule_retry"),
						dispatchPhase: undefined,
						activeAttemptId: undefined,
						leaseToken: undefined,
						leaseExpiresAt: undefined,
						nextAttemptAt: now,
						preflightDeferralCount: delivery.preflightDeferralCount + 1,
						updatedAt: now,
						lastErrorCode: "preflight_lease_expired",
						lastErrorMessage:
							"Local preflight lease expired before provider dispatch.",
					};
					tx.updateDelivery(retrying);
					recovered.push({ phase: "preflight", delivery: retrying });
					continue;
				}

				const recoveryCode =
					delivery.recoveryIntegrityCode ??
					(activeAttempt
						? "lease_expired"
						: "provider_attempt_integrity_missing");

				const unknownDelivery: StoredOutboundDelivery = {
					...delivery,
					status: transitionDelivery(delivery.status, "lease_expired"),
					retryOriginStatus: undefined,
					dispatchPhase: undefined,
					activeAttemptId: undefined,
					leaseToken: undefined,
					leaseExpiresAt: undefined,
					unknownAt: now,
					failedAt: undefined,
					updatedAt: now,
					lastErrorCode: recoveryCode,
					lastErrorMessage: delivery.recoveryIntegrityCode
						? "The provider result is ambiguous because dispatch metadata is invalid."
						: activeAttempt
							? "The provider result is ambiguous because the send lease expired."
							: "The provider result is ambiguous because its attempt record is unavailable.",
				};

				tx.updateDelivery(unknownDelivery);
				const unknownAttempts = unsafeAttempts
					.filter((candidate) => candidate.status !== "accepted")
					.map((candidate) => ({
						...candidate,
						status: "unknown" as const,
						finishedAt: now,
						errorCode: recoveryCode,
					}));
				for (const unknownAttempt of unknownAttempts) {
				tx.updateAttempt(unknownAttempt);
				}
				const reportedAttempt = unknownAttempts[0] ?? activeAttempt;
				recovered.push({
					phase: "provider",
					delivery: unknownDelivery,
					...(reportedAttempt ? { attempt: reportedAttempt } : {}),
				});
			}
			return recovered;
		});
	}

	#requireLease(
		tx: OutboundDeliveryTransaction,
		deliveryId: string,
		leaseToken: string,
	): {
		delivery: StoredOutboundDelivery;
		attempt: OutboundDeliveryAttempt;
	} {
		const delivery = tx.getDelivery(deliveryId);
		if (
			!delivery ||
			delivery.status !== "sending" ||
			delivery.leaseToken !== leaseToken ||
			delivery.dispatchPhase !== "provider" ||
			delivery.activeAttemptId === undefined
		) {
			throw new DeliveryLeaseError(deliveryId);
		}
		const matchingAttempts = tx
			.listAttemptsByDelivery(deliveryId)
			.filter(
				(candidate) =>
					candidate.storageIntegrityCode === undefined &&
					candidate.leaseToken === leaseToken &&
					candidate.status === "sending",
			);
		if (matchingAttempts.length !== 1) {
			throw new DeliveryLeaseError(deliveryId);
		}
		const attempt = matchingAttempts[0]!;
		if (delivery.activeAttemptId !== attempt.id) {
			throw new DeliveryLeaseError(deliveryId);
		}
		return { delivery, attempt };
	}

	#requirePreflightLease(
		tx: OutboundDeliveryTransaction,
		deliveryId: string,
		leaseToken: string,
	): StoredOutboundDelivery {
		const delivery = tx.getDelivery(deliveryId);
		if (
			!delivery ||
			delivery.status !== "sending" ||
			delivery.dispatchPhase !== "preflight" ||
			delivery.leaseToken !== leaseToken ||
			delivery.activeAttemptId !== undefined
		) {
			throw new DeliveryLeaseError(deliveryId);
		}
		return delivery;
	}
}

function hasUnsafeProviderAttempt(
	tx: OutboundDeliveryTransaction,
	deliveryId: string,
	leaseToken: string,
): boolean {
	return tx
		.listAttemptsByDelivery(deliveryId)
		.some(
			(attempt) =>
				attempt.storageIntegrityCode !== undefined ||
				attempt.leaseToken === leaseToken ||
				attempt.status === "sending" ||
				attempt.status === "accepted",
		);
}

function assertDeliveryStorageIntegrity(
	delivery: StoredOutboundDelivery,
): void {
	if (delivery.storageIntegrityCode) {
		throw new OutboundDeliveryIntegrityError(delivery.id);
	}
}

function validateSourceDraftReference(
	snapshot: OutboundMessageSnapshot,
): Pick<StoredOutboundDelivery, "draftId" | "draftVersion"> {
	const hasDraftId = snapshot.draftId !== undefined;
	const hasDraftVersion = snapshot.draftVersion !== undefined;
	if (hasDraftId !== hasDraftVersion) {
		throw new Error("Source draft ID and version must be provided together");
	}
	if (!hasDraftId) return {};
	if (
		!snapshot.draftId?.trim() ||
		!Number.isInteger(snapshot.draftVersion) ||
		(snapshot.draftVersion ?? 0) < 1
	) {
		throw new Error("Source draft reference is invalid");
	}
	return {
		draftId: snapshot.draftId,
		draftVersion: snapshot.draftVersion,
	};
}

function sourceDraftAction(
	delivery: StoredOutboundDelivery,
	whenLinked: Exclude<SourceDraftAction, "none">,
): SourceDraftAction {
	return delivery.draftId === undefined ? "none" : whenLinked;
}
