import type { Context } from "hono";
import { z } from "zod";
import { Folders } from "../../shared/folders.ts";
import { actorFromSession } from "../lib/activity.ts";
import type { MailboxContext } from "../lib/mailbox.ts";

type AppContext = Context<MailboxContext>;

const FolderBody = z.object({ folderId: z.string().trim().min(1).max(200) });
const ReadBody = FolderBody.extend({ read: z.boolean() });

function isReadFolder(folderId: string) {
	return folderId !== Folders.OUTBOX &&
		folderId !== Folders.DRAFT &&
		folderId !== Folders.SENT;
}

function isArchiveSource(folderId: string) {
	return !new Set<string>([
		Folders.OUTBOX,
		Folders.DRAFT,
		Folders.SENT,
		Folders.TRASH,
		Folders.ARCHIVE,
	]).has(folderId);
}

function isTrashSource(folderId: string) {
	return folderId !== Folders.OUTBOX &&
		folderId !== Folders.DRAFT &&
		folderId !== Folders.TRASH;
}

function mutationResponse(c: AppContext, result: { status: string; affectedCount?: number }) {
	if (result.status === "not_found") {
		return c.json({ error: "Conversation not found in this folder" }, 404);
	}
	if (result.status === "outbound_delivery_active") {
		return c.json(
			{ error: "Cancel queued sends before moving this conversation." },
			409,
		);
	}
	return c.json(result);
}

export async function handleSetConversationRead(c: AppContext) {
	const parsed = ReadBody.safeParse(await c.req.json());
	if (!parsed.success) return c.json({ error: "Folder ID and read state required" }, 400);
	if (!isReadFolder(parsed.data.folderId)) {
		return c.json({ error: "Read state is unavailable in this folder" }, 409);
	}
	const result = await c.var.mailboxStub.setConversationRead(
		c.req.param("conversationId")!,
		parsed.data.folderId,
		parsed.data.read,
		actorFromSession(c.get("session")),
	);
	return mutationResponse(c, result);
}

export async function handleArchiveConversation(c: AppContext) {
	const parsed = FolderBody.safeParse(await c.req.json());
	if (!parsed.success) return c.json({ error: "Folder ID required" }, 400);
	if (!isArchiveSource(parsed.data.folderId)) {
		return c.json({ error: "Archive is unavailable in this folder" }, 409);
	}
	const result = await c.var.mailboxStub.archiveConversation(
		c.req.param("conversationId")!,
		parsed.data.folderId,
		actorFromSession(c.get("session")),
	);
	return mutationResponse(c, result);
}

export async function handleTrashConversation(c: AppContext) {
	const parsed = FolderBody.safeParse(await c.req.json());
	if (!parsed.success) return c.json({ error: "Folder ID required" }, 400);
	if (!isTrashSource(parsed.data.folderId)) {
		return c.json({ error: "Trash is unavailable in this folder" }, 409);
	}
	const result = await c.var.mailboxStub.trashConversation(
		c.req.param("conversationId")!,
		parsed.data.folderId,
		actorFromSession(c.get("session")),
	);
	return mutationResponse(c, result);
}
