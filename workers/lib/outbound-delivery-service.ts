// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import {
	InvalidDeliveryTransitionError,
	canCancelDelivery,
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
	leaseToken?: string;
}

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
	findNextDispatchable?(now: string): StoredOutboundDelivery | null;
	listExpiredSending?(now: string): StoredOutboundDelivery[];
	listDeliveriesByStatuses?(
		statuses: StoredOutboundDelivery["status"][],
	): StoredOutboundDelivery[];
	listUnreconciledAccepted?(): StoredOutboundDelivery[];
	findNextActionAt?(): string | null;
	insertDelivery(delivery: StoredOutboundDelivery): void;
	updateDelivery(delivery: StoredOutboundDelivery): void;
	insertSnapshot(emailId: string, snapshot: OutboundMessageSnapshot): void;
	getSnapshot(emailId: string): OutboundMessageSnapshot | null;
	insertAttempt(attempt: OutboundDeliveryAttempt): void;
	findAttemptByLease(
		deliveryId: string,
		leaseToken: string,
	): OutboundDeliveryAttempt | null;
	updateAttempt(attempt: OutboundDeliveryAttempt): void;
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

export interface ClaimedDelivery {
	delivery: StoredOutboundDelivery;
	attempt: OutboundDeliveryAttempt;
	snapshot: OutboundMessageSnapshot;
}

export interface RecoveredDeliveryLease {
	delivery: StoredOutboundDelivery;
	attempt: OutboundDeliveryAttempt;
}

export interface FinalizedDeliveryAttempt {
	delivery: StoredOutboundDelivery;
	attempt: OutboundDeliveryAttempt;
	sourceDraftAction: SourceDraftAction;
}

export interface DeliveryMutationResult {
	delivery: StoredOutboundDelivery;
	actor: OutboundDeliveryActor;
	sourceDraftAction: SourceDraftAction;
}

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
			const finish = (result: EnqueuedDelivery): EnqueuedDelivery => {
				onCommitted?.(result);
				return result;
			};
			const existing = tx.findDeliveryByIdempotencyKey(command.idempotencyKey);
			if (existing) {
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

	listUnreconciledAccepted(): StoredOutboundDelivery[] {
		return this.#storage.transaction((tx) =>
			tx.listUnreconciledAccepted
				? tx.listUnreconciledAccepted()
				: tx.listDeliveries().filter((delivery) => delivery.status === "sent"),
		);
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
				return [];
			});
			return candidates.sort((a, b) => a.localeCompare(b))[0] ?? null;
		});
	}

	cancel(
		deliveryId: string,
		actor: OutboundDeliveryActor,
		at: string,
	): DeliveryMutationResult {
		return this.#storage.transaction((tx) => {
			const delivery = tx.getDelivery(deliveryId);
			if (!delivery) throw new OutboundDeliveryNotFoundError(deliveryId);
			if (!canCancelDelivery(delivery.status)) {
				throw new InvalidDeliveryTransitionError(delivery.status, "cancel");
			}
			const cancelled: StoredOutboundDelivery = {
				...delivery,
				status: transitionDelivery(delivery.status, "cancel"),
				cancelledAt: at,
				updatedAt: at,
			};
			tx.updateDelivery(cancelled);
			return {
				delivery: cancelled,
				actor: { ...actor },
				sourceDraftAction: sourceDraftAction(cancelled, "retain"),
			};
		});
	}

	claimNext(now: string, leaseDurationMs: number): ClaimedDelivery | null {
		return this.#storage.transaction((tx) => {
			const delivery = (
				tx.findNextDispatchable
				? [tx.findNextDispatchable(now)].filter(
							(candidate): candidate is StoredOutboundDelivery =>
								Boolean(candidate),
						)
					: tx.listDeliveries()
					)
				.filter(
					(candidate) =>
						(candidate.status === "queued" && candidate.availableAt <= now) ||
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
				throw new Error(`Missing outbox snapshot for ${delivery.id}`);
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
				attemptCount: delivery.attemptCount + 1,
				nextAttemptAt: undefined,
				leaseToken,
				leaseExpiresAt,
				updatedAt: now,
			};
			const attempt: OutboundDeliveryAttempt = {
				id: this.#createId("attempt"),
				deliveryId: delivery.id,
				attemptNumber: claimed.attemptCount,
				status: "sending",
				leaseToken,
				startedAt: now,
			};

			tx.updateDelivery(claimed);
			tx.insertAttempt(attempt);
			return { delivery: claimed, attempt, snapshot };
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
				status: transitionDelivery(
					delivery.status,
					exhausted ? "exhaust_retries" : "schedule_retry",
				),
				leaseToken: undefined,
				leaseExpiresAt: undefined,
				nextAttemptAt: exhausted ? undefined : details.retryAt,
				failedAt: exhausted ? details.at : undefined,
				lastErrorCode: details.code,
				lastErrorMessage: details.message,
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
				status: transitionDelivery(delivery.status, "definitive_failure"),
				leaseToken: undefined,
				leaseExpiresAt: undefined,
				failedAt: details.at,
				lastErrorCode: details.code,
				lastErrorMessage: details.message,
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
			const queued: StoredOutboundDelivery = {
				...delivery,
				status: transitionDelivery(delivery.status, "retry_failed"),
				availableAt: at,
				nextAttemptAt: undefined,
				failedAt: undefined,
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
				leaseToken: undefined,
				leaseExpiresAt: undefined,
				unknownAt: details.at,
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
			const queued: StoredOutboundDelivery = {
				...delivery,
				status: transitionDelivery(delivery.status, "force_retry_unknown"),
				availableAt: at,
				unknownAt: undefined,
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
				leaseToken: undefined,
				leaseExpiresAt: undefined,
				sesMessageId,
				sentAt: at,
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
			const bounced: StoredOutboundDelivery = {
				...delivery,
				status: transitionDelivery(delivery.status, "provider_bounced"),
				sesMessageId: details.sesMessageId ?? delivery.sesMessageId,
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
				if (
					delivery.status !== "sending" ||
					!delivery.leaseToken ||
					!delivery.leaseExpiresAt ||
					delivery.leaseExpiresAt > now
				) {
					continue;
				}

				const attempt = tx.findAttemptByLease(delivery.id, delivery.leaseToken);
				if (!attempt) {
					throw new Error(`Missing leased attempt for ${delivery.id}`);
				}

				const unknownDelivery: StoredOutboundDelivery = {
					...delivery,
					status: transitionDelivery(delivery.status, "lease_expired"),
					leaseToken: undefined,
					leaseExpiresAt: undefined,
					unknownAt: now,
					updatedAt: now,
					lastErrorCode: "lease_expired",
					lastErrorMessage:
						"The provider result is ambiguous because the send lease expired.",
				};
				const unknownAttempt: OutboundDeliveryAttempt = {
					...attempt,
					status: "unknown",
					finishedAt: now,
					errorCode: "lease_expired",
				};

				tx.updateDelivery(unknownDelivery);
				tx.updateAttempt(unknownAttempt);
				recovered.push({
					delivery: unknownDelivery,
					attempt: unknownAttempt,
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
			delivery.leaseToken !== leaseToken
		) {
			throw new DeliveryLeaseError(deliveryId);
		}
		const attempt = tx.findAttemptByLease(deliveryId, leaseToken);
		if (!attempt || attempt.status !== "sending") {
			throw new DeliveryLeaseError(deliveryId);
		}
		return { delivery, attempt };
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
