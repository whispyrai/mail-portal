import { Hono, type Context } from "hono";
import { attachmentKey } from "../lib/attachments.ts";
import {
	hasLiveMailboxContentAccess,
	type MailboxContext,
} from "../lib/mailbox.ts";

type AppContext = Context<MailboxContext>;

export interface MailboxAttachmentByteMetadata {
	id: string;
	email_id: string;
	filename: string;
	mimetype: string;
	size: number;
	content_id?: string | null;
	disposition?: string | null;
}

export interface MailboxAttachmentByteOperations {
	exact(emailId: string, attachmentId: string): Promise<MailboxAttachmentByteMetadata | null>;
}

export interface MailboxAttachmentByteBucket {
	get(key: string): Promise<{ body: BodyInit } | null>;
}

export interface MailboxAttachmentByteRouteDependencies {
	operations(c: AppContext): MailboxAttachmentByteOperations;
	bucket(c: AppContext): MailboxAttachmentByteBucket;
	revalidateAccess(c: AppContext): Promise<boolean>;
}

export function safeAttachmentResponseMimeType(value: string): string {
	const normalized = value.trim().toLowerCase();
	return /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/.test(normalized)
		? normalized
		: "application/octet-stream";
}

export function encodeAttachmentFilenameStar(filename: string): string {
	return encodeURIComponent(filename).replace(/[!'()*]/g, (character) =>
		`%${character.charCodeAt(0).toString(16).toUpperCase()}`,
	);
}

export function createMailboxAttachmentByteRoutes(
	dependencies: MailboxAttachmentByteRouteDependencies,
) {
	const routes = new Hono<MailboxContext>();
	routes.get(
		"/api/v1/mailboxes/:mailboxId/emails/:emailId/attachments/:attachmentId",
		async (c) => {
			const emailId = c.req.param("emailId") ?? "";
			const attachmentId = c.req.param("attachmentId") ?? "";
			if (!emailId || !attachmentId || emailId.length > 300 || attachmentId.length > 300) {
				return c.json({ error: "Attachment not found" }, 404);
			}
			const attachment = await dependencies.operations(c).exact(emailId, attachmentId);
			const exactAttachment = attachment &&
				attachment.email_id === emailId &&
				attachment.id === attachmentId
				? attachment
				: null;
			const object = exactAttachment
				? await dependencies.bucket(c).get(
					attachmentKey(
						exactAttachment.email_id,
						exactAttachment.id,
						exactAttachment.filename,
					),
				)
				: null;
			if (!(await dependencies.revalidateAccess(c))) {
				return c.json({ error: "Forbidden" }, 403);
			}
			if (!exactAttachment) return c.json({ error: "Attachment not found" }, 404);
			if (!object) return c.json({ error: "Attachment file not found" }, 404);
			const headers = new Headers({
				"Cache-Control": "private, no-store",
				"Content-Type": safeAttachmentResponseMimeType(exactAttachment.mimetype),
				"Cross-Origin-Resource-Policy": "same-origin",
				"X-Content-Type-Options": "nosniff",
			});
			const sanitized = exactAttachment.filename.replace(/[\x00-\x1f"\\]/g, "_");
			headers.set(
				"Content-Disposition",
				`attachment; filename="${sanitized}"; filename*=UTF-8''${encodeAttachmentFilenameStar(exactAttachment.filename)}`,
			);
			return new Response(object.body, { headers });
		},
	);
	return routes;
}

export const mailboxAttachmentByteRoutes = createMailboxAttachmentByteRoutes({
	operations: (c) => ({
		exact: (emailId, attachmentId) =>
			c.var.mailboxStub.getAttachmentForEmail(emailId, attachmentId),
	}),
	bucket: (c) => ({
		get: (key) => c.env.BUCKET.get(key),
	}),
	revalidateAccess: hasLiveMailboxContentAccess,
});
