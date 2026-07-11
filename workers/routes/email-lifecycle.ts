import type { Context } from "hono";
import type { MailboxContext } from "../lib/mailbox.ts";
import { attachmentKey } from "../lib/attachments.ts";
import { actorFromSession } from "../lib/activity.ts";

type AppContext = Context<MailboxContext>;

/** User-facing delete is always a reversible move to Trash. */
export async function handleDeleteEmail(c: AppContext) {
	const id = c.req.param("id")!;
	const result = await c.var.mailboxStub.trashEmail(
		id,
		actorFromSession(c.get("session")),
	);
	if (result === null) return c.json({ error: "Not found" }, 404);
	if (result.status === "outbound_delivery_active") {
		return c.json(
			{
				error: "Cancel the queued send before moving its Outbox message.",
				code: "active_outbound_delivery_requires_cancel",
				deliveryId: result.deliveryId,
			},
			409,
		);
	}
	return c.json({ status: result.status });
}

/** Restore a trashed email to its previous folder, or Inbox as fallback. */
export async function handleRestoreEmail(c: AppContext) {
	const id = c.req.param("id")!;
	const result = await c.var.mailboxStub.restoreEmail(
		id,
		actorFromSession(c.get("session")),
	);
	if (result === null) return c.json({ error: "Not found" }, 404);
	if (result.status === "not_trashed") {
		return c.json({ error: "Email is not in Trash" }, 409);
	}
	return c.json(result);
}

/** Permanently remove a draft only through the explicit discard action. */
export async function handleDiscardDraft(c: AppContext) {
	const id = c.req.param("id")!;
	const actor = actorFromSession(c.get("session"));
	const result = await c.var.mailboxStub.discardDraft(
		id,
		actor,
	);
	if (result === null) return c.json({ error: "Draft not found" }, 404);
	if (result.status === "not_draft") {
		return c.json({ error: "Email is not a draft" }, 409);
	}
	if (result.attachments.length > 0) {
		const keys = result.attachments.map((attachment) =>
			attachmentKey(id, attachment.id, attachment.filename),
		);
		try {
			await c.env.BUCKET.delete(keys);
		} catch (error) {
			console.error("[draft-discard] failed to remove orphaned attachment objects", {
				draftId: id,
				error: error instanceof Error ? error.message : String(error),
			});
			await c.var.mailboxStub.queueAttachmentCleanup(id, keys, actor);
		}
	}
	return c.json({ status: result.status });
}

/** Route every folder move through the attributed mailbox lifecycle. */
export async function handleMoveEmail(c: AppContext) {
	const { folderId } = (await c.req.json()) as { folderId?: string };
	if (!folderId) return c.json({ error: "Folder ID required" }, 400);
	const moved = await c.var.mailboxStub.moveEmail(
		c.req.param("id")!,
		folderId,
		actorFromSession(c.get("session")),
	);
	if (typeof moved === "object" && moved.status === "outbound_delivery_active") {
		return c.json(
			{
				error: "Cancel the queued send before moving its Outbox message.",
				code: "active_outbound_delivery_requires_cancel",
				deliveryId: moved.deliveryId,
			},
			409,
		);
	}
	return moved
		? c.json({ status: "moved" })
		: c.json({ error: "Email or folder not found" }, 404);
}
