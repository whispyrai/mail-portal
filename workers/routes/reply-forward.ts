// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import type { Context } from "hono";
import {
	completeAttachmentPromotion,
	resolveAndPromoteAttachments,
	rollbackAttachmentPromotion,
	sourceDraftAttachmentIds,
} from "../lib/attachments.ts";
import type { EmailFull } from "../lib/schemas.ts";
import {
	validateSender,
	SenderValidationError,
	generateMessageId,
	buildReferencesChain,
	resolveOriginalEmail,
} from "../lib/email-helpers.ts";
import { SendEmailRequestSchema } from "../lib/schemas.ts";
import type { MailboxContext } from "../lib/mailbox.ts";
import { actorFromSession } from "../lib/activity.ts";
import { reconcileAmbiguousOutboundEnqueue } from "../lib/outbound-enqueue-recovery.ts";
import { validateOutboundSchedule } from "../../shared/outbound-schedule.ts";

type AppContext = Context<MailboxContext>;
type RateLimitStub = { checkSendRateLimit: () => Promise<string | null> };

function recipientList(value: string | string[] | undefined): string[] {
	if (!value) return [];
	return (Array.isArray(value) ? value : [value]).map((address) =>
		address.toLowerCase(),
	);
}

function deliveryResponse(
	delivery: {
		id: string;
		emailId: string;
		status: string;
		undoUntil: string;
		scheduledFor?: string;
	},
	replayed: boolean,
) {
	return {
		deliveryId: delivery.id,
		id: delivery.emailId,
		emailId: delivery.emailId,
		status: delivery.status,
		undoUntil: delivery.undoUntil,
		scheduledFor: delivery.scheduledFor ?? null,
		replayed,
	};
}

function isSourceDraftConflict(error: unknown): boolean {
	return error instanceof Error &&
		(error.name === "SourceDraftConflictError" ||
			error.message.startsWith("Source draft "));
}

export async function handleReplyEmail(c: AppContext) {
	const mailboxId = c.req.param("mailboxId") ?? "";
	const id = c.req.param("id") ?? "";
	const parsed = SendEmailRequestSchema.safeParse(await c.req.json());
	if (!parsed.success) {
		return c.json(
			{ error: parsed.error.issues[0]?.message ?? "Invalid send request" },
			400,
		);
	}
	const body = parsed.data;
	const {
		to,
		cc,
		bcc,
		from,
		subject,
		html,
		text,
		attachments,
		source_draft_id,
		source_draft_version,
		idempotency_key,
		scheduled_for,
	} = body;

	const stub = c.var.mailboxStub;
	const existing = await stub.getOutboundDeliveryByIdempotencyKey(
		idempotency_key,
	);
	if (existing) return c.json(deliveryResponse(existing, true), 202);
	const schedulePreflight = validateOutboundSchedule(scheduled_for);
	if (!schedulePreflight.ok) {
		return c.json({ error: schedulePreflight.error }, 400);
	}
	const rawOriginal = (await stub.getEmail(id)) as EmailFull | null;

	if (!rawOriginal) {
		return c.json({ error: "Original email not found" }, 404);
	}

	const originalEmail = await resolveOriginalEmail(stub, rawOriginal);
	const { originalMsgId, references, threadId: thread_id } = buildReferencesChain(originalEmail);

	let fromEmail: string, fromDomain: string;
	try {
		({ fromEmail, fromDomain } = validateSender(to, from, mailboxId));
	} catch (e) {
		if (e instanceof SenderValidationError) return c.json({ error: e.message }, 400);
		throw e;
	}

	const { messageId } = generateMessageId(fromDomain);

	const rateLimitError = await (stub as unknown as RateLimitStub)
		.checkSendRateLimit();
	if (rateLimitError) {
		return c.json({ error: rateLimitError }, 429);
	}

	let sourceDraft: { draftId: string; draftVersion: number } | undefined;
	if (source_draft_id) {
		sourceDraft = {
			draftId: source_draft_id,
			draftVersion: source_draft_version!,
		};
	}
	const actor = actorFromSession(c.get("session"));

	const resolved = await resolveAndPromoteAttachments(
		c.env.BUCKET, stub, mailboxId, messageId, attachments, actor,
	).then(
		(r) => ({ ok: true as const, ...r }),
		(e) => ({ ok: false as const, error: (e as Error).message }),
	);
	if (!resolved.ok) return c.json({ error: resolved.error }, 400);
	const timing = validateOutboundSchedule(scheduled_for);
	if (!timing.ok) {
		await rollbackAttachmentPromotion(
			c.env.BUCKET,
			stub,
			messageId,
			resolved,
			actor,
		);
		return c.json({ error: timing.error }, 400);
	}
	const { requestedAt, undoUntil } = timing;
	let result;
	let promotionFinalized = false;
	try {
		result = await stub.enqueueOutbound(
			{
				idempotencyKey: idempotency_key,
				source: "ui",
				actor,
				snapshot: {
				mailboxId: mailboxId.toLowerCase(),
				...sourceDraft,
				kind: "reply",
				to: recipientList(to),
				cc: recipientList(cc),
				bcc: recipientList(bcc),
				from: fromEmail,
				subject,
				...(html !== undefined ? { html } : {}),
				...(text !== undefined ? { text } : {}),
				inReplyTo: originalMsgId,
				references,
				threadId: thread_id,
				attachmentIds: resolved.storedMetadata.map((attachment) => attachment.id),
				...(source_draft_id
					? { sourceDraftAttachmentIds: sourceDraftAttachmentIds(source_draft_id, attachments) }
					: {}),
				},
				requestedAt,
				undoUntil,
				...(timing.scheduledFor ? { scheduledFor: timing.scheduledFor } : {}),
			},
			resolved.storedMetadata,
			messageId,
		);
	} catch (error) {
		const reconciliation = await reconcileAmbiguousOutboundEnqueue({
			bucket: c.env.BUCKET,
			stub,
			idempotencyKey: idempotency_key,
			attemptedEmailId: messageId,
			promotion: resolved,
			actor,
		});
		if (reconciliation.status === "committed") {
			result = reconciliation;
			promotionFinalized = true;
		} else if (reconciliation.status === "indeterminate") {
			throw error;
		}
		if (reconciliation.status === "not_committed" && isSourceDraftConflict(error)) {
			return c.json(
				{ error: "Source draft changed. Review it before sending." },
				409,
			);
		}
		if (reconciliation.status === "not_committed") throw error;
	}
	if (!promotionFinalized) {
		await completeAttachmentPromotion(c.env.BUCKET, stub, messageId, resolved, actor);
	}

	await stub.markThreadRead(thread_id, actor);

	return c.json(deliveryResponse(result.delivery, result.replayed), 202);
}

export async function handleForwardEmail(c: AppContext) {
	const mailboxId = c.req.param("mailboxId") ?? "";
	const id = c.req.param("id") ?? "";
	const parsed = SendEmailRequestSchema.safeParse(await c.req.json());
	if (!parsed.success) {
		return c.json(
			{ error: parsed.error.issues[0]?.message ?? "Invalid send request" },
			400,
		);
	}
	const body = parsed.data;
	const {
		to,
		cc,
		bcc,
		from,
		subject,
		html,
		text,
		attachments,
		source_draft_id,
		source_draft_version,
		idempotency_key,
		scheduled_for,
	} = body;

	const stub = c.var.mailboxStub;
	const existing = await stub.getOutboundDeliveryByIdempotencyKey(
		idempotency_key,
	);
	if (existing) return c.json(deliveryResponse(existing, true), 202);
	const schedulePreflight = validateOutboundSchedule(scheduled_for);
	if (!schedulePreflight.ok) {
		return c.json({ error: schedulePreflight.error }, 400);
	}
	const rawOriginal = (await stub.getEmail(id)) as EmailFull | null;

	if (!rawOriginal) {
		return c.json({ error: "Original email not found" }, 404);
	}

	await resolveOriginalEmail(stub, rawOriginal);

	let fromEmail: string, fromDomain: string;
	try {
		({ fromEmail, fromDomain } = validateSender(to, from, mailboxId));
	} catch (e) {
		if (e instanceof SenderValidationError) return c.json({ error: e.message }, 400);
		throw e;
	}

	const { messageId } = generateMessageId(fromDomain);

	const rateLimitError = await (stub as unknown as RateLimitStub)
		.checkSendRateLimit();
	if (rateLimitError) {
		return c.json({ error: rateLimitError }, 429);
	}

	let sourceDraft: { draftId: string; draftVersion: number } | undefined;
	if (source_draft_id) {
		sourceDraft = {
			draftId: source_draft_id,
			draftVersion: source_draft_version!,
		};
	}
	const actor = actorFromSession(c.get("session"));

	const resolved = await resolveAndPromoteAttachments(
		c.env.BUCKET, stub, mailboxId, messageId, attachments, actor,
	).then(
		(r) => ({ ok: true as const, ...r }),
		(e) => ({ ok: false as const, error: (e as Error).message }),
	);
	if (!resolved.ok) return c.json({ error: resolved.error }, 400);
	const timing = validateOutboundSchedule(scheduled_for);
	if (!timing.ok) {
		await rollbackAttachmentPromotion(
			c.env.BUCKET,
			stub,
			messageId,
			resolved,
			actor,
		);
		return c.json({ error: timing.error }, 400);
	}
	const { requestedAt, undoUntil } = timing;
	let result;
	let promotionFinalized = false;
	try {
		result = await stub.enqueueOutbound(
			{
				idempotencyKey: idempotency_key,
				source: "ui",
				actor,
				snapshot: {
				mailboxId: mailboxId.toLowerCase(),
				...sourceDraft,
				kind: "forward",
				to: recipientList(to),
				cc: recipientList(cc),
				bcc: recipientList(bcc),
				from: fromEmail,
				subject,
				...(html !== undefined ? { html } : {}),
				...(text !== undefined ? { text } : {}),
				threadId: messageId,
				attachmentIds: resolved.storedMetadata.map((attachment) => attachment.id),
				...(source_draft_id
					? { sourceDraftAttachmentIds: sourceDraftAttachmentIds(source_draft_id, attachments) }
					: {}),
				},
				requestedAt,
				undoUntil,
				...(timing.scheduledFor ? { scheduledFor: timing.scheduledFor } : {}),
			},
			resolved.storedMetadata,
			messageId,
		);
	} catch (error) {
		const reconciliation = await reconcileAmbiguousOutboundEnqueue({
			bucket: c.env.BUCKET,
			stub,
			idempotencyKey: idempotency_key,
			attemptedEmailId: messageId,
			promotion: resolved,
			actor,
		});
		if (reconciliation.status === "committed") {
			result = reconciliation;
			promotionFinalized = true;
		} else if (reconciliation.status === "indeterminate") {
			throw error;
		}
		if (reconciliation.status === "not_committed" && isSourceDraftConflict(error)) {
			return c.json(
				{ error: "Source draft changed. Review it before sending." },
				409,
			);
		}
		if (reconciliation.status === "not_committed") throw error;
	}
	if (!promotionFinalized) {
		await completeAttachmentPromotion(c.env.BUCKET, stub, messageId, resolved, actor);
	}

	return c.json(deliveryResponse(result.delivery, result.replayed), 202);
}
