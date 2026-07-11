import type { Context } from "hono";
import { Folders } from "../../shared/folders.ts";
import { actorFromSession } from "../lib/activity.ts";
import {
	cleanupStoredAttachmentObjects,
	completeAttachmentPromotion,
	resolveAndPromoteAttachments,
	rollbackAttachmentPromotion,
} from "../lib/attachments.ts";
import type { MailboxContext } from "../lib/mailbox.ts";
import { SaveDraftRequestSchema } from "../lib/schemas.ts";
import { reconcileAmbiguousDraftSave } from "../lib/draft-save-recovery.ts";

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
		draft_id,
		draft_version,
		attachments,
	} = parsed.data;
	const mailboxId = c.req.param("mailboxId") ?? "";
	const stub = c.var.mailboxStub;
	const actor = actorFromSession(c.get("session"));
	const id = draft_id ?? crypto.randomUUID();
	const priorDraft = draft_id ? await stub.getEmail(draft_id) : null;
	const promotion = await resolveAndPromoteAttachments(
		c.env.BUCKET,
		stub,
		mailboxId,
		id,
		attachments,
		actor,
	).catch((error: Error) => error);
	if (promotion instanceof Error) {
		return c.json({ error: promotion.message }, 400);
	}

	let result;
	try {
		result = await stub.upsertDraft(
			{
				id,
				expectedVersion: draft_version,
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
			replacedAttachments: priorDraft?.attachments ?? [],
			actor,
		});
		if (reconciliation.status === "committed") {
			return c.json(reconciliation.draft, 201);
		}
		throw error;
	}

	if (result.status !== "saved") {
		await rollbackAttachmentPromotion(c.env.BUCKET, stub, id, promotion, actor);
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
		result.replacedAttachments,
		actor,
	);
	const saved = await stub.getEmail(id);
	if (!saved || saved.folder_id !== Folders.DRAFT) {
		throw new Error(`Saved draft ${id} could not be read back`);
	}
	return c.json(saved, 201);
}
