// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Proposed contract for truthful outbound delivery.
 *
 * This module is intentionally not wired into production yet. It defines the
 * vocabulary and invariants the API, Durable Object, SES transport, UI, MCP,
 * agent, and bulk sender must share before the current send paths are replaced.
 */

export const OUTBOUND_DELIVERY_STATUSES = [
	"queued",
	"sending",
	"retrying",
	"sent",
	"bounced",
	"failed",
	"unknown",
	"cancelled",
] as const;

export type OutboundDeliveryStatus =
	(typeof OUTBOUND_DELIVERY_STATUSES)[number];

export type OutboundDeliveryKind = "compose" | "reply" | "forward" | "bulk";
export type OutboundDeliverySource =
	| "ui"
	| "api"
	| "mcp"
	| "agent"
	| "rule"
	| "bulk";

export interface OutboundDeliveryActor {
	kind: "user" | "mcp" | "agent" | "rule" | "system";
	id?: string;
}

/**
 * Immutable snapshot accepted into the outbox. Implementations must resolve
 * attachment bytes before enqueueing and must never re-read mutable draft text
 * when a queued or scheduled delivery eventually runs.
 */
export interface OutboundMessageSnapshot {
	mailboxId: string;
	/** Present together only when this send originated from a saved draft. */
	draftId?: string;
	draftVersion?: number;
	kind: OutboundDeliveryKind;
	to: string[];
	cc: string[];
	bcc: string[];
	from: string;
	subject: string;
	html?: string;
	text?: string;
	inReplyTo?: string;
	references?: string[];
	threadId: string;
	attachmentIds: string[];
	/** Original source-draft attachment IDs represented by this exact send. */
	sourceDraftAttachmentIds?: string[];
}

export interface EnqueueOutboundCommand {
	/** Unique per logical user action and required on every send entry point. */
	idempotencyKey: string;
	source: OutboundDeliverySource;
	actor: OutboundDeliveryActor;
	snapshot: OutboundMessageSnapshot;
	requestedAt: string;
	/** The initial undo snackbar deadline. */
	undoUntil: string;
	/** Optional Send Later time. */
	scheduledFor?: string;
}

export interface OutboundDeliveryRecord {
	id: string;
	emailId: string;
	draftId?: string;
	mailboxId: string;
	status: OutboundDeliveryStatus;
	idempotencyKey: string;
	source: OutboundDeliverySource;
	actor: OutboundDeliveryActor;
	createdAt: string;
	updatedAt: string;
	availableAt: string;
	undoUntil: string;
	scheduledFor?: string;
	nextAttemptAt?: string;
	attemptCount: number;
	leaseExpiresAt?: string;
	sesMessageId?: string;
	lastErrorCode?: string;
	lastErrorMessage?: string;
	sentAt?: string;
	failedAt?: string;
	unknownAt?: string;
	cancelledAt?: string;
	/** True only while cancellation committed but snapshot recovery still needs retry. */
	cancelRecoveryPending?: boolean;
}

export type DeliveryTransition =
	| "start_sending"
	| "provider_accepted"
	| "provider_bounced"
	| "schedule_retry"
	| "retry_ready"
	| "exhaust_retries"
	| "definitive_failure"
	| "ambiguous_outcome"
	| "lease_expired"
	| "cancel"
	| "retry_failed"
	| "force_retry_unknown";

const TRANSITIONS: Record<
	OutboundDeliveryStatus,
	Partial<Record<DeliveryTransition, OutboundDeliveryStatus>>
> = {
	queued: {
		start_sending: "sending",
		cancel: "cancelled",
	},
	sending: {
		provider_accepted: "sent",
		schedule_retry: "retrying",
		exhaust_retries: "failed",
		definitive_failure: "failed",
		ambiguous_outcome: "unknown",
		// A worker disappearing while the SES request may have been in flight is
		// ambiguous. It must never silently return to the automatic retry queue.
		lease_expired: "unknown",
	},
	retrying: {
		retry_ready: "queued",
		cancel: "cancelled",
	},
	failed: {
		retry_failed: "queued",
	},
	unknown: {
		// This transition requires an explicit duplicate-risk acknowledgement.
		force_retry_unknown: "queued",
		// A later authenticated provider bounce proves the ambiguous request was
		// accepted, while also proving final delivery failure.
		provider_bounced: "bounced",
	},
	sent: {
		provider_bounced: "bounced",
	},
	bounced: {},
	cancelled: {},
};

export class InvalidDeliveryTransitionError extends Error {
	constructor(status: OutboundDeliveryStatus, transition: DeliveryTransition) {
		super(`Cannot apply ${transition} to outbound delivery in ${status}`);
		this.name = "InvalidDeliveryTransitionError";
	}
}

export function transitionDelivery(
	status: OutboundDeliveryStatus,
	transition: DeliveryTransition,
): OutboundDeliveryStatus {
	const next = TRANSITIONS[status][transition];
	if (!next) throw new InvalidDeliveryTransitionError(status, transition);
	return next;
}

/** Delivery cannot begin before both the undo delay and Send Later time pass. */
export function computeAvailableAt(
	undoUntil: string,
	scheduledFor?: string,
): string {
	if (!scheduledFor) return undoUntil;
	return Date.parse(scheduledFor) > Date.parse(undoUntil)
		? scheduledFor
		: undoUntil;
}

/** A queued delivery remains cancellable until the worker claims it. */
export function canCancelDelivery(status: OutboundDeliveryStatus): boolean {
	return status === "queued" || status === "retrying";
}

/**
 * When a source draft exists, it is retained for every outcome except confirmed
 * SES acceptance. Deleting a draft on enqueue, HTTP 202, failure, or unknown
 * loses recoverable user work and makes the UI claim more certainty than the
 * transport provides.
 */
export function shouldRetainSourceDraft(
	status: OutboundDeliveryStatus,
): boolean {
	return status !== "sent" && status !== "bounced";
}

export type SesObservedOutcome =
	| { kind: "accepted"; messageId: string }
	| { kind: "http_error"; status: number; detail?: string }
	| { kind: "not_dispatched"; detail?: string }
	| { kind: "transport_ambiguous"; detail?: string }
	| { kind: "invalid_success_response"; detail?: string };

export type ClassifiedSesOutcome =
	| { kind: "sent"; sesMessageId: string; automaticRetry: false }
	| {
			kind: "definitive_failure";
			automaticRetry: boolean;
			code: string;
	  }
	| { kind: "unknown"; automaticRetry: false; code: string };

/**
 * Classify only what the caller can prove. A thrown fetch after dispatch, a
 * timeout, a lost response, or a 2xx response without a parseable SES MessageId
 * may represent an accepted email. Those outcomes are UNKNOWN and are never
 * automatically retried because SES SendEmail has no idempotency token.
 */
export function classifySesOutcome(
	outcome: SesObservedOutcome,
): ClassifiedSesOutcome {
	switch (outcome.kind) {
		case "accepted":
			return {
				kind: "sent",
				sesMessageId: outcome.messageId,
				automaticRetry: false,
			};
		case "not_dispatched":
			return {
				kind: "definitive_failure",
				automaticRetry: true,
				code: "not_dispatched",
			};
		case "transport_ambiguous":
			return {
				kind: "unknown",
				automaticRetry: false,
				code: "transport_ambiguous",
			};
		case "invalid_success_response":
			return {
				kind: "unknown",
				automaticRetry: false,
				code: "invalid_success_response",
			};
		case "http_error": {
			const retryable = outcome.status === 429 || outcome.status >= 500;
			return {
				kind: "definitive_failure",
				automaticRetry: retryable,
				code: `ses_http_${outcome.status}`,
			};
		}
	}
}

export interface OutboundDeliveryService {
	/** Atomically snapshot the message and enqueue, or return the prior result. */
	enqueue(command: EnqueueOutboundCommand): Promise<OutboundDeliveryRecord>;
	get(deliveryId: string): Promise<OutboundDeliveryRecord | null>;
	/** Valid only while queued, including scheduled mail not yet claimed. */
	cancel(
		deliveryId: string,
		actor: OutboundDeliveryActor,
	): Promise<OutboundDeliveryRecord>;
	/** Retry a proven failure. Reuses the logical delivery, adding an attempt. */
	retryFailed(
		deliveryId: string,
		actor: OutboundDeliveryActor,
	): Promise<OutboundDeliveryRecord>;
	/**
	 * Retry an ambiguous outcome only after the caller acknowledges that the
	 * recipient may receive a duplicate.
	 */
	retryUnknown(
		deliveryId: string,
		actor: OutboundDeliveryActor,
		acknowledgeDuplicateRisk: true,
	): Promise<OutboundDeliveryRecord>;
}
