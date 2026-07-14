import type { Context } from "hono";
import { Folders } from "../../shared/folders.ts";
import { actorFromSession } from "../lib/activity.ts";
import {
	cleanupStoredAttachmentObjects,
	completeAttachmentPromotion,
	resolveAndPromoteAttachments,
	rollbackAttachmentPromotion,
	type StoredAttachment,
} from "../lib/attachments.ts";
import type { MailboxContext } from "../lib/mailbox.ts";
import { SaveDraftRequestSchema } from "../lib/schemas.ts";
import { reconcileAmbiguousDraftSave } from "../lib/draft-save-recovery.ts";
import { contentIdForDisposition } from "../../shared/content-id.ts";
import { validateResolvedInlineImages } from "../lib/inline-image-authority.ts";
import { draftCreateFingerprint } from "../lib/draft-create-idempotency.ts";

type AppContext = Context<MailboxContext>;

export async function handleSaveDraft(c: AppContext) {
	const parsed = SaveDraftRequestSchema.safeParse(await c.req.json());
	if (!parsed.success) {
		return c.json({ error: parsed.error.issues[0]?.message ?? "Invalid draft" }, 400);
	}
	const {
		to,
		cc,
		bcc,
		subject,
		body,
		in_reply_to,
		thread_id,
		draft_create_key,
		draft_id,
		draft_version,
		attachments,
	} = parsed.data;
	const mailboxId = c.req.param("mailboxId") ?? "";
	const stub = c.var.mailboxStub;
	const actor = actorFromSession(c.get("session"));
	const createFingerprint = draft_create_key
		? await draftCreateFingerprint(parsed.data)
		: undefined;
	if (draft_create_key && createFingerprint) {
		const replay = await stub.getDraftCreateReplay(
			draft_create_key,
			createFingerprint,
		);
		if (replay.status === "superseded") {
			return c.json(
				{
					error: "The original draft save was superseded by a newer revision.",
					code: "draft_create_superseded",
					draftId: replay.draftId,
					currentVersion: replay.currentVersion,
				},
				409,
			);
		}
		if (replay.status === "conflict") {
			return c.json(
				{
					error: "Draft create key was already used for different content.",
					code: "draft_create_conflict",
					draftId: replay.draftId,
					currentVersion: replay.currentVersion,
				},
				409,
			);
		}
		if (replay.status === "unavailable") {
			return c.json(
				{
					error: "The original draft is no longer available for replay.",
					code: "draft_create_replay_unavailable",
					draftId: replay.draftId,
					currentVersion: replay.currentVersion,
				},
				409,
			);
		}
		if (replay.status === "replay") {
			return c.json({ ...replay.draft, replayed: true });
		}
	}
	const id = draft_id ?? crypto.randomUUID();
	const priorDraft = draft_id ? await stub.getEmail(draft_id) : null;
	const priorAttachments = new Map(
		(priorDraft?.attachments ?? []).map((attachment) => [attachment.id, attachment]),
	);
	const retainedAttachments: StoredAttachment[] = [];
	const retainedAttachmentIds = new Set<string>();
	const attachmentsToPromote = (attachments ?? []).filter((ref) => {
		if (ref.kind !== "existing" || ref.emailId !== id) return true;
		const existing = priorAttachments.get(ref.attachmentId);
		if (!existing) return true;
		const disposition =
			existing.disposition === "inline" ? "inline" : "attachment";
		retainedAttachmentIds.add(existing.id);
		retainedAttachments.push({
			id: existing.id,
			email_id: id,
			filename: existing.filename,
			mimetype: existing.mimetype,
			size: existing.size,
			content_id: contentIdForDisposition(disposition, existing.content_id),
			disposition,
		});
		return false;
	});
	const newPromotion = await resolveAndPromoteAttachments(
		c.env.BUCKET,
		stub,
		mailboxId,
		id,
		attachmentsToPromote,
		actor,
	).catch((error: Error) => error);
	if (newPromotion instanceof Error) {
		return c.json({ error: newPromotion.message }, 400);
	}
	const promotion = {
		...newPromotion,
		storedMetadata: [...retainedAttachments, ...newPromotion.storedMetadata],
	};
	const inlineMapping = validateResolvedInlineImages(body, promotion.storedMetadata);
	if (!inlineMapping.ok) {
		await rollbackAttachmentPromotion(c.env.BUCKET, stub, id, promotion, actor);
		return c.json(
			{ error: inlineMapping.error, code: inlineMapping.code },
			400,
		);
	}
	const replacedAttachments = (priorDraft?.attachments ?? []).filter(
		(attachment) => !retainedAttachmentIds.has(attachment.id),
	);

	let result;
	try {
		result = await stub.upsertDraft(
			{
				id,
				expectedVersion: draft_version,
				createKey: draft_create_key,
				createFingerprint,
				subject: subject ?? "",
				sender: mailboxId.toLowerCase(),
				recipient: (to ?? "").toLowerCase(),
				cc: cc?.toLowerCase() ?? null,
				bcc: bcc?.toLowerCase() ?? null,
				body,
				in_reply_to: in_reply_to ?? null,
				thread_id: thread_id ?? in_reply_to ?? id,
			},
			promotion.storedMetadata,
			actor,
		);
	} catch (error) {
		const reconciliation = await reconcileAmbiguousDraftSave({
			bucket: c.env.BUCKET,
			stub,
			draftId: id,
			expectedCommittedVersion: (draft_version ?? 0) + 1,
			promotion,
				replacedAttachments,
			actor,
		});
		if (reconciliation.status === "committed") {
			return c.json(reconciliation.draft, 201);
		}
		throw error;
	}

	if (result.status !== "saved") {
		await rollbackAttachmentPromotion(c.env.BUCKET, stub, id, promotion, actor);
		if (result.status === "creation_superseded") {
			return c.json(
				{
					error: "The original draft save was superseded by a newer revision.",
					code: "draft_create_superseded",
					draftId: result.draftId,
					currentVersion: result.currentVersion,
				},
				409,
			);
		}
		if (result.status === "creation_replay") {
			return c.json({ ...result.draft, replayed: true });
		}
		if (result.status === "creation_conflict") {
			return c.json(
				{
					error: "Draft create key was already used for different content.",
					code: "draft_create_conflict",
					draftId: result.draftId,
					currentVersion: result.currentVersion,
				},
				409,
			);
		}
		if (result.status === "creation_unavailable") {
			return c.json(
				{
					error: "The original draft is no longer available for replay.",
					code: "draft_create_replay_unavailable",
					draftId: result.draftId,
					currentVersion: result.currentVersion,
				},
				409,
			);
		}
		if (result.status === "version_conflict") {
			return c.json(
				{
					error: "Draft changed in another session. Reload it before saving.",
					currentVersion: result.currentVersion,
				},
				409,
			);
		}
		if (result.status === "not_found") {
			return c.json({ error: "Draft not found" }, 404);
		}
		return c.json({ error: "Only a draft can be overwritten" }, 409);
	}

	await completeAttachmentPromotion(c.env.BUCKET, stub, id, promotion, actor);
	await cleanupStoredAttachmentObjects(
		c.env.BUCKET,
		stub,
		id,
		result.replacedAttachments.filter(
			(attachment) => !retainedAttachmentIds.has(attachment.id),
		),
		actor,
	);
	const saved = await stub.getEmail(id);
	if (!saved || saved.folder_id !== Folders.DRAFT) {
		throw new Error(`Saved draft ${id} could not be read back`);
	}
	return c.json(saved, 201);
}
