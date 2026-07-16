import type { Env } from "../types.ts";
import type { ActivityActor } from "./activity.ts";
import {
	completeAttachmentPromotion,
	rollbackAttachmentPromotion,
	type AttachmentPromotion,
} from "./attachments.ts";
import {
	outboundEnqueueOutcome,
	type OutboundEnqueueOutcome,
	type OutboundReplayConflictReason,
} from "./outbound-delivery-service.ts";

type AuthoritativeDelivery = {
	id: string;
	emailId: string;
	status: string;
	undoUntil: string;
	scheduledFor?: string;
	commandFingerprint?: string;
};

type RecoveryStub = {
	getAttachment(id: string): Promise<{
		filename: string;
		mimetype: string;
		size: number;
		email_id: string;
	} | null>;
	resolveOutboundReplay(input: {
		idempotencyKey: string;
		commandFingerprint: string;
		sourceDraft?: { draftId: string; draftVersion: number };
	}): Promise<
		| { status: "none" }
		| { status: "exact"; delivery: AuthoritativeDelivery }
		| {
				status: "conflict";
				reason: OutboundReplayConflictReason;
				delivery: AuthoritativeDelivery;
		  }
	>;
	queueAttachmentCleanup?: (
		emailId: string,
		keys: string[],
		actor?: ActivityActor,
	) => Promise<void>;
};

export type AmbiguousEnqueueResolution =
	| {
			status: "committed";
			delivery: AuthoritativeDelivery;
			replayed: true;
			outcome: OutboundEnqueueOutcome;
	  }
	| { status: "not_committed" }
	| { status: "conflict"; reason: OutboundReplayConflictReason }
	| { status: "indeterminate" };

export function planBulkEnqueueReconciliation(
	delivery: AuthoritativeDelivery | null,
	attemptedEmailId: string,
	commandFingerprint: string,
):
	| { status: "committed"; deleteAttemptedBytes: boolean }
	| {
			status: "conflict";
			reason: OutboundReplayConflictReason;
			deleteAttemptedBytes: boolean;
	  }
	| { status: "not_committed"; deleteAttemptedBytes: true } {
	if (!delivery) {
		return { status: "not_committed", deleteAttemptedBytes: true };
	}
	if (!("commandFingerprint" in delivery) || !delivery.commandFingerprint) {
		return {
			status: "conflict",
			reason: "legacy_idempotency_unverifiable",
			deleteAttemptedBytes: delivery.emailId !== attemptedEmailId,
		};
	}
	if (delivery.commandFingerprint !== commandFingerprint) {
		return {
			status: "conflict",
			reason: "command_mismatch",
			deleteAttemptedBytes: delivery.emailId !== attemptedEmailId,
		};
	}
	return {
		status: "committed",
		deleteAttemptedBytes: delivery.emailId !== attemptedEmailId,
	};
}

/**
 * Reconcile the mailbox's idempotency ledger before deleting any promoted R2
 * bytes. An RPC can fail after its Durable Object transaction committed, so a
 * blind rollback would corrupt the authoritative immutable snapshot.
 */
export async function reconcileAmbiguousOutboundEnqueue(input: {
	bucket: Env["BUCKET"];
	stub: RecoveryStub;
	idempotencyKey: string;
	commandFingerprint: string;
	sourceDraft?: { draftId: string; draftVersion: number };
	attemptedEmailId: string;
	promotion: AttachmentPromotion;
	actor: ActivityActor;
}): Promise<AmbiguousEnqueueResolution> {
	let resolution: Awaited<ReturnType<RecoveryStub["resolveOutboundReplay"]>>;
	try {
		resolution = await input.stub.resolveOutboundReplay({
			idempotencyKey: input.idempotencyKey,
			commandFingerprint: input.commandFingerprint,
			...(input.sourceDraft ? { sourceDraft: input.sourceDraft } : {}),
		});
	} catch {
		return { status: "indeterminate" };
	}

	if (resolution.status === "none") {
		await rollbackAttachmentPromotion(
			input.bucket,
			input.stub,
			input.attemptedEmailId,
			input.promotion,
			input.actor,
		);
		return { status: "not_committed" };
	}
	const delivery = resolution.delivery;

	if (delivery.emailId !== input.attemptedEmailId) {
		await rollbackAttachmentPromotion(
			input.bucket,
			input.stub,
			input.attemptedEmailId,
			input.promotion,
			input.actor,
		);
	}
	if (resolution.status === "conflict") {
		return { status: "conflict", reason: resolution.reason };
	}
	await completeAttachmentPromotion(
		input.bucket,
		input.stub,
		input.attemptedEmailId,
		input.promotion,
		input.actor,
	);
	return {
		status: "committed",
		delivery,
		replayed: true,
		outcome: outboundEnqueueOutcome(delivery, true),
	};
}
