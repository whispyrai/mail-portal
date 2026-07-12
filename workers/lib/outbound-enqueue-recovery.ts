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
} from "./outbound-delivery-service.ts";

type AuthoritativeDelivery = {
	id: string;
	emailId: string;
	status: string;
	undoUntil: string;
	scheduledFor?: string;
};

type RecoveryStub = {
	getAttachment(id: string): Promise<{
		filename: string;
		mimetype: string;
		size: number;
		email_id: string;
	} | null>;
	getOutboundDeliveryByIdempotencyKey(
		key: string,
	): Promise<AuthoritativeDelivery | null>;
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
	| { status: "indeterminate" };

export function planBulkEnqueueReconciliation(
	delivery: AuthoritativeDelivery | null,
	attemptedEmailId: string,
):
	| { status: "committed"; deleteAttemptedBytes: boolean }
	| { status: "not_committed"; deleteAttemptedBytes: true } {
	if (!delivery) {
		return { status: "not_committed", deleteAttemptedBytes: true };
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
	attemptedEmailId: string;
	promotion: AttachmentPromotion;
	actor: ActivityActor;
}): Promise<AmbiguousEnqueueResolution> {
	let delivery: AuthoritativeDelivery | null;
	try {
		delivery = await input.stub.getOutboundDeliveryByIdempotencyKey(
			input.idempotencyKey,
		);
	} catch {
		return { status: "indeterminate" };
	}

	if (!delivery) {
		await rollbackAttachmentPromotion(
			input.bucket,
			input.stub,
			input.attemptedEmailId,
			input.promotion,
			input.actor,
		);
		return { status: "not_committed" };
	}

	if (delivery.emailId !== input.attemptedEmailId) {
		await rollbackAttachmentPromotion(
			input.bucket,
			input.stub,
			input.attemptedEmailId,
			input.promotion,
			input.actor,
		);
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
