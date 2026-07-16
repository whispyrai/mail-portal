import type { Context } from "hono";
import { Folders } from "../../shared/folders.ts";
import { actorFromSession } from "../lib/activity.ts";
import {
	classifyAttachmentPreparationFailure,
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
import {
	draftCreateFingerprint,
	draftIdForSaveKey,
	draftSaveFingerprint,
} from "../lib/draft-create-idempotency.ts";

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
		draft_save_key,
		draft_id,
		draft_version,
		attachments,
	} = parsed.data;
	const mailboxId = c.var.authorizedMailboxId;
	const stub = c.var.mailboxStub;
	const actor = actorFromSession(c.get("session"));
	const saveKey = draft_save_key ?? draft_create_key ?? crypto.randomUUID();
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
			const attachmentIdentityScope = await stub
				.getCommittedDraftAttachmentScope(
					replay.draftId,
					replay.draft.draft_version,
				)
				.catch(() => null);
			return c.json({
				...replay.draft,
				replayed: true,
				attachment_save_scope: attachmentIdentityScope ?? saveKey,
			});
		}
	}
	const id = draft_id ?? await draftIdForSaveKey(mailboxId, saveKey);
	const claimToken = crypto.randomUUID();
	const saveFingerprint = await draftSaveFingerprint({
		...parsed.data,
		draft_id: id,
		draft_version: draft_version ?? 0,
	});
	const claim = await stub.claimDraftSave({
		saveKey,
		fingerprint: saveFingerprint,
		draftId: id,
		expectedVersion: draft_version ?? 0,
		claimToken,
		claimExpiresAt: Date.now() + 5 * 60_000,
	});
	if (claim.status === "committed") {
		const committedDraft = claim.draft ?? await stub.getEmail(id);
		if (!committedDraft || committedDraft.folder_id !== Folders.DRAFT) {
			return c.json(
				{ error: "The committed draft save is no longer available." },
				409,
			);
		}
		if (committedDraft.draft_version !== claim.committedVersion) {
			return c.json(
				{
					error: "This draft save was superseded by a newer revision.",
					code: "draft_save_superseded",
					draftId: committedDraft.id,
					currentVersion: committedDraft.draft_version,
				},
				409,
			);
		}
		return c.json({
			...committedDraft,
			replayed: true,
			attachment_save_scope: claim.claimToken ?? saveKey,
		}, 201);
	}
	if (claim.status === "key_conflict") {
		return c.json(
			{
				error: "Draft save key was already used for different content.",
				code: "draft_save_conflict",
			},
			409,
		);
	}
	if (claim.status === "in_progress" || claim.status === "revision_in_progress") {
		return c.json(
			{
				error: "This draft revision is already being saved. Retry shortly.",
				code: "draft_save_in_progress",
				retryAfterMs: 500,
			},
			409,
		);
	}
	if (claim.status === "version_conflict") {
		return c.json(
			{
				error: "Draft changed in another session. Reload it before saving.",
				currentVersion: claim.currentVersion,
			},
			409,
		);
	}
	if (claim.status === "not_found") {
		return c.json({ error: "Draft not found" }, 404);
	}
	if (claim.status === "not_draft") {
		return c.json({ error: "Only a draft can be overwritten" }, 409);
	}
	for (const stalePromotion of claim.stalePromotions) {
		await rollbackAttachmentPromotion(
			c.env.BUCKET,
			stub,
			id,
			{
				sesAttachments: [],
				storedMetadata: [],
				stagingKeys: [],
				destinationKeys: stalePromotion.destinationKeys,
				promotionOwner: stalePromotion.promotionOwner,
			},
			actor,
		);
	}
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
		{
			identityScope: claimToken,
			promotionOwner: claimToken,
			recordDestinationIntent: async (keys) => {
				const recorded = await stub.recordDraftSavePromotion(
					saveKey,
					saveFingerprint,
					claimToken,
					keys,
				);
				if (!recorded) throw new Error("Draft save claim was lost before promotion.");
			},
		},
	).catch((error: Error) => error);
	if (newPromotion instanceof Error) {
		await stub.abortDraftSave(saveKey, saveFingerprint, claimToken);
		const failure = classifyAttachmentPreparationFailure(newPromotion);
		return c.json(
			{ error: failure.message, code: failure.code },
			failure.status,
		);
	}
	const promotion = {
		...newPromotion,
		storedMetadata: [...retainedAttachments, ...newPromotion.storedMetadata],
	};
	const inlineMapping = validateResolvedInlineImages(body, promotion.storedMetadata);
	if (!inlineMapping.ok) {
		await rollbackAttachmentPromotion(c.env.BUCKET, stub, id, promotion, actor);
		await stub.abortDraftSave(saveKey, saveFingerprint, claimToken);
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
				saveKey,
				saveFingerprint,
				saveClaimToken: claimToken,
				stagingCleanupKeys: promotion.stagingKeys,
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
			saveKey,
			saveFingerprint,
			promotion,
			replacedAttachments,
			actor,
		});
		if (reconciliation.status === "committed") {
			return c.json({
				...reconciliation.draft,
				attachment_save_scope: reconciliation.attachmentIdentityScope,
			}, 201);
		}
		throw error;
	}

	if (result.status !== "saved") {
		if (result.status === "creation_replay") {
			await Promise.allSettled([
				rollbackAttachmentPromotion(c.env.BUCKET, stub, id, promotion, actor),
				stub.abortDraftSave(saveKey, saveFingerprint, claimToken),
			]);
			const attachmentIdentityScope = await stub
				.getCommittedDraftAttachmentScope(
					result.draftId,
					result.draft.draft_version,
				)
				.catch(() => null);
			return c.json({
				...result.draft,
				replayed: true,
				attachment_save_scope: attachmentIdentityScope ?? saveKey,
			});
		}
		await rollbackAttachmentPromotion(c.env.BUCKET, stub, id, promotion, actor);
		await stub.abortDraftSave(saveKey, saveFingerprint, claimToken);
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

	await Promise.allSettled([
		completeAttachmentPromotion(c.env.BUCKET, stub, id, promotion, actor),
		cleanupStoredAttachmentObjects(
			c.env.BUCKET,
			stub,
			id,
			result.replacedAttachments.filter(
				(attachment) => !retainedAttachmentIds.has(attachment.id),
			),
			actor,
		),
	]);
	const authoritativeDraft = result.draft ?? await stub.getEmail(id);
	if (!authoritativeDraft || authoritativeDraft.folder_id !== Folders.DRAFT) {
		throw new Error(`Saved draft ${id} could not be materialized`);
	}
	return c.json({ ...authoritativeDraft, attachment_save_scope: claimToken }, 201);
}
