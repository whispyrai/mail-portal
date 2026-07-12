import type { Context } from "hono";
import {
	completeAttachmentPromotion,
	resolveAndPromoteAttachments,
	rollbackAttachmentPromotion,
	sourceDraftAttachmentIds,
} from "../lib/attachments.ts";
import { actorFromSession } from "../lib/activity.ts";
import {
	generateMessageId,
	SenderValidationError,
	validateSender,
} from "../lib/email-helpers.ts";
import type { MailboxContext } from "../lib/mailbox.ts";
import { reconcileAmbiguousOutboundEnqueue } from "../lib/outbound-enqueue-recovery.ts";
import { SendEmailRequestSchema } from "../lib/schemas.ts";
import { validateOutboundSchedule } from "../../shared/outbound-schedule.ts";
import { outboundEnqueueOutcome } from "../lib/outbound-delivery-service.ts";
import { validateResolvedInlineImages } from "../lib/inline-image-authority.ts";

type AppContext = Context<MailboxContext>;

export async function handleSendEmail(c: AppContext) {
	const mailboxId = c.req.param("mailboxId")!;
	const parsed = SendEmailRequestSchema.safeParse(await c.req.json());
	if (!parsed.success) {
		return c.json(
			{ error: parsed.error.issues[0]?.message ?? "Invalid send request" },
			400,
		);
	}
	const {
		to,
		cc,
		bcc,
		from,
		subject,
		html,
		text,
		attachments,
		in_reply_to,
		references,
		thread_id,
		source_draft_id,
		source_draft_version,
		idempotency_key,
		scheduled_for,
	} = parsed.data;
	const stub = c.var.mailboxStub;
	const existing = await stub.getOutboundDeliveryByIdempotencyKey(
		idempotency_key,
	);
	if (existing) {
		return c.json(
			{
				deliveryId: existing.id,
				id: existing.emailId,
				emailId: existing.emailId,
				status: existing.status,
				undoUntil: existing.undoUntil,
				scheduledFor: existing.scheduledFor ?? null,
				replayed: true,
				outcome: outboundEnqueueOutcome(existing, true),
			},
			202,
		);
	}
	const schedulePreflight = validateOutboundSchedule(scheduled_for);
	if (!schedulePreflight.ok) {
		return c.json({ error: schedulePreflight.error }, 400);
	}

	let fromEmail: string;
	let fromDomain: string;
	try {
		({ fromEmail, fromDomain } = validateSender(to, from, mailboxId));
	} catch (error) {
		if (error instanceof SenderValidationError) {
			return c.json({ error: error.message }, 400);
		}
		throw error;
	}

	const { messageId } = generateMessageId(fromDomain);
	const storedThreadId = thread_id || in_reply_to || messageId;
	const rateLimitError = await stub.checkSendRateLimit();
	if (rateLimitError) return c.json({ error: rateLimitError }, 429);

	const sourceDraft = source_draft_id
		? { draftId: source_draft_id, draftVersion: source_draft_version! }
		: undefined;
	const actor = actorFromSession(c.get("session"));
	const resolved = await resolveAndPromoteAttachments(
		c.env.BUCKET,
		stub,
		mailboxId,
		messageId,
		attachments,
		actor,
	).then(
		(result) => ({ ok: true as const, ...result }),
		(error) => ({ ok: false as const, error: (error as Error).message }),
	);
	if (!resolved.ok) return c.json({ error: resolved.error }, 400);
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
					kind: "compose",
					to: Array.isArray(to)
						? to.map((address) => address.toLowerCase())
						: [to.toLowerCase()],
					cc: cc
						? Array.isArray(cc)
							? cc.map((address) => address.toLowerCase())
							: [cc.toLowerCase()]
						: [],
					bcc: bcc
						? Array.isArray(bcc)
							? bcc.map((address) => address.toLowerCase())
							: [bcc.toLowerCase()]
						: [],
					from: fromEmail,
					subject,
					...(html !== undefined ? { html } : {}),
					...(text !== undefined ? { text } : {}),
					...(in_reply_to ? { inReplyTo: in_reply_to } : {}),
					...(references ? { references } : {}),
					threadId: storedThreadId,
					attachmentIds: resolved.storedMetadata.map(
						(attachment) => attachment.id,
					),
					...(source_draft_id
						? {
								sourceDraftAttachmentIds: sourceDraftAttachmentIds(
									source_draft_id,
									attachments,
								),
							}
						: {}),
				},
				requestedAt: timing.requestedAt,
				undoUntil: timing.undoUntil,
				...(timing.scheduledFor
					? { scheduledFor: timing.scheduledFor }
					: {}),
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
		if (
			reconciliation.status === "not_committed" &&
			error instanceof Error &&
			(error.name === "SourceDraftConflictError" ||
				error.message.startsWith("Source draft "))
		) {
			return c.json(
				{ error: "Source draft changed. Review it before sending." },
				409,
			);
		}
		if (reconciliation.status === "not_committed") throw error;
	}
	if (!promotionFinalized) {
		await completeAttachmentPromotion(
			c.env.BUCKET,
			stub,
			messageId,
			resolved,
			actor,
		);
	}

	return c.json(
		{
			deliveryId: result.delivery.id,
			id: result.delivery.emailId,
			emailId: result.delivery.emailId,
			status: result.delivery.status,
			undoUntil: result.delivery.undoUntil,
			scheduledFor: result.delivery.scheduledFor ?? null,
			replayed: result.replayed,
			outcome: result.outcome,
		},
		202,
	);
}
