// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import type { Context } from "hono";
import {
	classifyAttachmentPreparationFailure,
	completeAttachmentPromotion,
	outboundAttachmentByteIdentities,
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
import {
	outboundEnqueueOutcome,
	type OutboundEnqueueOutcome,
} from "../lib/outbound-delivery-service.ts";
import { validateResolvedInlineImages } from "../lib/inline-image-authority.ts";
import {
	outboundReplyIntentFingerprint,
	stableOutboundAttachmentReferences,
	withOutboundCommandFingerprint,
} from "../lib/outbound-command-fingerprint.ts";

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
	outcome: OutboundEnqueueOutcome = outboundEnqueueOutcome(
		delivery,
		replayed,
	),
) {
	return {
		deliveryId: delivery.id,
		id: delivery.emailId,
		emailId: delivery.emailId,
		status: delivery.status,
		undoUntil: delivery.undoUntil,
		scheduledFor: delivery.scheduledFor ?? null,
		replayed,
		outcome,
	};
}

function isSourceDraftConflict(error: unknown): boolean {
	return error instanceof Error &&
		(error.name === "SourceDraftConflictError" ||
			error.message.startsWith("Source draft "));
}

export async function handleReplyEmail(c: AppContext) {
	const mailboxId = c.var.authorizedMailboxId;
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
	let fromEmail: string, fromDomain: string;
	try {
		({ fromEmail, fromDomain } = validateSender(to, from, mailboxId));
	} catch (e) {
		if (e instanceof SenderValidationError) return c.json({ error: e.message }, 400);
		throw e;
	}
	const sourceDraft = source_draft_id
		? { draftId: source_draft_id, draftVersion: source_draft_version! }
		: undefined;
	const actor = actorFromSession(c.get("session"));
	const attachmentReferences = stableOutboundAttachmentReferences(attachments);
	const intentCommand = {
			idempotencyKey: idempotency_key,
			source: "ui" as const,
			actor,
			snapshot: {
				mailboxId: mailboxId.toLowerCase(),
				...sourceDraft,
				kind: "reply" as const,
				to: recipientList(to),
				cc: recipientList(cc),
				bcc: recipientList(bcc),
				from: fromEmail,
				subject,
				...(html !== undefined ? { html } : {}),
				...(text !== undefined ? { text } : {}),
				threadId: "",
				attachmentIds: [],
				attachmentByteIdentities: [],
				...(source_draft_id
					? {
							sourceDraftAttachmentIds: sourceDraftAttachmentIds(
								source_draft_id,
								attachments,
							),
						}
					: {}),
			},
			requestedAt: "1970-01-01T00:00:00.000Z",
			undoUntil: "1970-01-01T00:00:00.000Z",
			...(scheduled_for ? { scheduledFor: scheduled_for } : {}),
		};
	const intentFingerprint = await outboundReplyIntentFingerprint(
		intentCommand,
		attachmentReferences,
		id,
	);
	const replay = await stub.resolveOutboundReplay({
		idempotencyKey: idempotency_key,
		commandFingerprint: intentFingerprint,
		...(sourceDraft ? { sourceDraft } : {}),
	});
	if (replay.status === "exact") {
		return c.json(deliveryResponse(replay.delivery, true), 202);
	}
	const rawOriginal = (await stub.getEmail(id)) as EmailFull | null;
	if (!rawOriginal) {
		return c.json(
			replay.status === "conflict"
				? {
						error: "This legacy send identity cannot be verified without its source message.",
						code: "legacy_idempotency_unverifiable",
					}
				: { error: "Original email not found" },
			replay.status === "conflict" ? 409 : 404,
		);
	}
	const originalEmail = await resolveOriginalEmail(stub, rawOriginal);
	const { originalMsgId, references, threadId: thread_id } = buildReferencesChain(originalEmail);
	const legacyCommand = await withOutboundCommandFingerprint(
		{
			...intentCommand,
			snapshot: {
				...intentCommand.snapshot,
				inReplyTo: originalMsgId,
				references,
				threadId: thread_id,
			},
		},
		attachmentReferences,
		{ sourceEmailId: id },
	);
	if (replay.status === "conflict") {
		const legacyReplay = await stub.resolveOutboundReplay({
			idempotencyKey: idempotency_key,
			commandFingerprint: legacyCommand.commandFingerprint,
			...(sourceDraft ? { sourceDraft } : {}),
		});
		if (legacyReplay.status === "exact") {
			return c.json(deliveryResponse(legacyReplay.delivery, true), 202);
		}
		return c.json(
			{
				error: "This send identity is already bound to another command.",
				code: replay.reason,
			},
			409,
		);
	}
	const replayCommand = {
		...legacyCommand,
		commandFingerprint: intentFingerprint,
	};
	const schedulePreflight = validateOutboundSchedule(scheduled_for);
	if (!schedulePreflight.ok) {
		return c.json({ error: schedulePreflight.error }, 400);
	}

	const { messageId } = generateMessageId(fromDomain);

	const rateLimitError = await (stub as unknown as RateLimitStub)
		.checkSendRateLimit();
	if (rateLimitError) {
		return c.json({ error: rateLimitError }, 429);
	}

	const resolved = await resolveAndPromoteAttachments(
		c.env.BUCKET,
		stub,
		mailboxId,
		messageId,
		attachments,
		actor,
		{
			promotionOwner: messageId,
			recordDestinationIntent: async (keys) => {
				await stub.recordOutboundPromotionIntent(messageId, keys);
			},
		},
	).then(
		(r) => ({ ok: true as const, ...r }),
		(error) => ({
			ok: false as const,
			failure: classifyAttachmentPreparationFailure(error),
		}),
	);
	if (!resolved.ok) {
		return c.json(
			{ error: resolved.failure.message, code: resolved.failure.code },
			resolved.failure.status,
		);
	}
	const inlineMapping = validateResolvedInlineImages(html ?? "", resolved.storedMetadata);
	if (!inlineMapping.ok) {
		await rollbackAttachmentPromotion(
			c.env.BUCKET,
			stub,
			messageId,
			resolved,
			actor,
		);
		return c.json(
			{ error: inlineMapping.error, code: inlineMapping.code },
			400,
		);
	}
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
				...replayCommand,
				snapshot: {
					...replayCommand.snapshot,
					attachmentIds: resolved.storedMetadata.map(
						(attachment) => attachment.id,
					),
					attachmentByteIdentities: outboundAttachmentByteIdentities(
						resolved.storedMetadata,
					),
				},
				requestedAt,
				undoUntil,
				...(timing.scheduledFor ? { scheduledFor: timing.scheduledFor } : {}),
			},
			resolved.storedMetadata,
			messageId,
			resolved.stagingKeys,
		);
	} catch (error) {
		const reconciliation = await reconcileAmbiguousOutboundEnqueue({
			bucket: c.env.BUCKET,
			stub,
			idempotencyKey: idempotency_key,
			commandFingerprint: replayCommand.commandFingerprint,
			...(sourceDraft ? { sourceDraft } : {}),
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
		if (reconciliation.status === "conflict") {
			return c.json(
				{
					error: "This send identity is already bound to another command.",
					code: reconciliation.reason,
				},
				409,
			);
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
		try {
			await completeAttachmentPromotion(c.env.BUCKET, stub, messageId, resolved, actor);
		} catch (error) {
			console.error("Committed reply staging cleanup deferred", error);
		}
	}

	try {
		await stub.markThreadRead(thread_id, actor);
	} catch (error) {
		console.error("Committed reply thread read-state update deferred", error);
	}

	return c.json(
		deliveryResponse(result.delivery, result.replayed, result.outcome),
		202,
	);
}

export async function handleForwardEmail(c: AppContext) {
	const mailboxId = c.var.authorizedMailboxId;
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
	let fromEmail: string, fromDomain: string;
	try {
		({ fromEmail, fromDomain } = validateSender(to, from, mailboxId));
	} catch (e) {
		if (e instanceof SenderValidationError) return c.json({ error: e.message }, 400);
		throw e;
	}
	const sourceDraft = source_draft_id
		? { draftId: source_draft_id, draftVersion: source_draft_version! }
		: undefined;
	const actor = actorFromSession(c.get("session"));
	const replayCommand = await withOutboundCommandFingerprint(
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
				threadId: "generated",
				attachmentIds: [],
				attachmentByteIdentities: [],
				...(source_draft_id
					? {
							sourceDraftAttachmentIds: sourceDraftAttachmentIds(
								source_draft_id,
								attachments,
							),
						}
					: {}),
			},
			requestedAt: "1970-01-01T00:00:00.000Z",
			undoUntil: "1970-01-01T00:00:00.000Z",
			...(scheduled_for ? { scheduledFor: scheduled_for } : {}),
		},
		stableOutboundAttachmentReferences(attachments),
		{ sourceEmailId: id },
	);
	const replay = await stub.resolveOutboundReplay({
		idempotencyKey: idempotency_key,
		commandFingerprint: replayCommand.commandFingerprint,
		...(sourceDraft ? { sourceDraft } : {}),
	});
	if (replay.status === "exact") {
		return c.json(deliveryResponse(replay.delivery, true), 202);
	}
	if (replay.status === "conflict") {
		return c.json(
			{
				error: "This send identity is already bound to another command.",
				code: replay.reason,
			},
			409,
		);
	}
	const schedulePreflight = validateOutboundSchedule(scheduled_for);
	if (!schedulePreflight.ok) {
		return c.json({ error: schedulePreflight.error }, 400);
	}
	const rawOriginal = (await stub.getEmail(id)) as EmailFull | null;

	if (!rawOriginal) {
		return c.json({ error: "Original email not found" }, 404);
	}

	await resolveOriginalEmail(stub, rawOriginal);

	const { messageId } = generateMessageId(fromDomain);

	const rateLimitError = await (stub as unknown as RateLimitStub)
		.checkSendRateLimit();
	if (rateLimitError) {
		return c.json({ error: rateLimitError }, 429);
	}

	const resolved = await resolveAndPromoteAttachments(
		c.env.BUCKET,
		stub,
		mailboxId,
		messageId,
		attachments,
		actor,
		{
			promotionOwner: messageId,
			recordDestinationIntent: async (keys) => {
				await stub.recordOutboundPromotionIntent(messageId, keys);
			},
		},
	).then(
		(r) => ({ ok: true as const, ...r }),
		(error) => ({
			ok: false as const,
			failure: classifyAttachmentPreparationFailure(error),
		}),
	);
	if (!resolved.ok) {
		return c.json(
			{ error: resolved.failure.message, code: resolved.failure.code },
			resolved.failure.status,
		);
	}
	const inlineMapping = validateResolvedInlineImages(html ?? "", resolved.storedMetadata);
	if (!inlineMapping.ok) {
		await rollbackAttachmentPromotion(
			c.env.BUCKET,
			stub,
			messageId,
			resolved,
			actor,
		);
		return c.json(
			{ error: inlineMapping.error, code: inlineMapping.code },
			400,
		);
	}
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
				...replayCommand,
				snapshot: {
					...replayCommand.snapshot,
				threadId: messageId,
				attachmentIds: resolved.storedMetadata.map((attachment) => attachment.id),
				attachmentByteIdentities: outboundAttachmentByteIdentities(
					resolved.storedMetadata,
				),
				},
				requestedAt,
				undoUntil,
				...(timing.scheduledFor ? { scheduledFor: timing.scheduledFor } : {}),
			},
			resolved.storedMetadata,
			messageId,
			resolved.stagingKeys,
		);
	} catch (error) {
		const reconciliation = await reconcileAmbiguousOutboundEnqueue({
			bucket: c.env.BUCKET,
			stub,
			idempotencyKey: idempotency_key,
			commandFingerprint: replayCommand.commandFingerprint,
			...(sourceDraft ? { sourceDraft } : {}),
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
		if (reconciliation.status === "conflict") {
			return c.json(
				{
					error: "This send identity is already bound to another command.",
					code: reconciliation.reason,
				},
				409,
			);
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
		try {
			await completeAttachmentPromotion(c.env.BUCKET, stub, messageId, resolved, actor);
		} catch (error) {
			console.error("Committed forward staging cleanup deferred", error);
		}
	}

	return c.json(
		deliveryResponse(result.delivery, result.replayed, result.outcome),
		202,
	);
}
