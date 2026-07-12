import { Hono, type Context } from "hono";
import {
	MailboxAttachmentQueryError,
	normalizeMailboxAttachmentListQuery,
	type MailboxAttachmentItem,
	type MailboxAttachmentPage,
	type NormalizedMailboxAttachmentListOptions,
} from "../../shared/mailbox-attachments.ts";
import {
	hasLiveMailboxContentAccess,
	type MailboxContext,
} from "../lib/mailbox.ts";

type AppContext = Context<MailboxContext>;

export interface MailboxAttachmentOperations {
	list(options: NormalizedMailboxAttachmentListOptions): Promise<MailboxAttachmentPage>;
	detail(attachmentId: string): Promise<MailboxAttachmentItem | null>;
}

export interface MailboxAttachmentRouteDependencies {
	operations(c: AppContext): MailboxAttachmentOperations;
	revalidateAccess(c: AppContext): Promise<boolean>;
}

export function createMailboxAttachmentRoutes(
	dependencies: MailboxAttachmentRouteDependencies,
) {
	const routes = new Hono<MailboxContext>();
	routes.get("/api/v1/mailboxes/:mailboxId/attachments", async (c) => {
		try {
			const options = normalizeMailboxAttachmentListQuery(new URL(c.req.url).searchParams);
			const page = await dependencies.operations(c).list(options);
			if (!(await dependencies.revalidateAccess(c))) {
				return c.json({ error: "Forbidden" }, 403);
			}
			return c.json(page);
		} catch (error) {
			if (error instanceof MailboxAttachmentQueryError) {
				return c.json({ error: error.message, code: error.code }, 400);
			}
			throw error;
		}
	});
	routes.get("/api/v1/mailboxes/:mailboxId/attachments/:attachmentId", async (c) => {
		const attachmentId = c.req.param("attachmentId") ?? "";
		if (!attachmentId || attachmentId.length > 300) {
			return c.json({ error: "Attachment id is invalid", code: "INVALID_QUERY" }, 400);
		}
		const attachment = await dependencies.operations(c).detail(attachmentId);
		if (!(await dependencies.revalidateAccess(c))) {
			return c.json({ error: "Forbidden" }, 403);
		}
		return attachment
			? c.json(attachment)
			: c.json({ error: "Attachment not found" }, 404);
	});
	return routes;
}

export const mailboxAttachmentRoutes = createMailboxAttachmentRoutes({
	operations: (c) => ({
		list: (options) => c.var.mailboxStub.listMailboxAttachments(options),
		detail: (attachmentId) => c.var.mailboxStub.getMailboxAttachment(attachmentId),
	}),
	revalidateAccess: hasLiveMailboxContentAccess,
});
