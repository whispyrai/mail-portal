import type { AttachmentRef } from "../types/index.ts";
import {
	evaluateComposeAttachments,
	type ComposeAttachmentRecord,
} from "./compose-attachment-policy.ts";
import {
	composeMissingAttachmentFingerprint,
	shouldWarnMissingAttachment,
} from "./compose-missing-attachment.ts";
import { validateScheduledDate } from "./send-later.ts";

export interface ComposeDeliverySnapshot {
	to: string;
	cc: string;
	bcc: string;
	subject: string;
	body: string;
	attachments: ComposeAttachmentRecord[];
}

export type ComposeSendPlan =
	| { action: "error"; message: string }
	| { action: "confirm-missing-attachment"; fingerprint: string }
	| { action: "send"; attachmentRefs: AttachmentRef[] };

export function planComposeSend(input: {
	snapshot: ComposeDeliverySnapshot;
	scheduledFor?: string;
	confirmedMissingAttachmentFingerprint?: string;
}): ComposeSendPlan {
	const { snapshot, scheduledFor, confirmedMissingAttachmentFingerprint } = input;
	if (!snapshot.to.split(",").some((entry) => entry.trim())) {
		return { action: "error", message: "Add at least one recipient." };
	}

	const attachmentPolicy = evaluateComposeAttachments(
		snapshot.attachments,
		snapshot.body,
	);
	if (!attachmentPolicy.ok) {
		return { action: "error", message: attachmentPolicy.error };
	}

	if (scheduledFor) {
		const schedule = validateScheduledDate(new Date(scheduledFor));
		if (!schedule.ok) return { action: "error", message: schedule.error };
	}

	const fingerprint = composeMissingAttachmentFingerprint({
		to: snapshot.to,
		cc: snapshot.cc,
		bcc: snapshot.bcc,
		subject: snapshot.subject,
		bodyHtml: snapshot.body,
		scheduledFor: scheduledFor ?? null,
		attachments: snapshot.attachments,
	});
	if (
		shouldWarnMissingAttachment({
			subject: snapshot.subject,
			bodyHtml: snapshot.body,
			attachments: snapshot.attachments,
		}) &&
		confirmedMissingAttachmentFingerprint !== fingerprint
	) {
		return { action: "confirm-missing-attachment", fingerprint };
	}

	return { action: "send", attachmentRefs: attachmentPolicy.refs };
}

export function composeDeliveryPersistenceKey(input: {
	mailboxId: string;
	draftId: string;
	draftVersion: number;
	scheduledFor?: string;
	mode: string;
	originalEmailId?: string;
}) {
	return [
		"mail-send",
		input.mailboxId,
		input.draftId,
		input.draftVersion,
		input.scheduledFor ?? "now",
		input.mode,
		input.originalEmailId ?? "none",
	].join(":");
}
