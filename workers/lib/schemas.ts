// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Shared types and Zod schemas for email data.
 *
 * Types (from email-types.ts): used by the agent, MCP server, and route
 * handlers to avoid `as any` casting.
 *
 * Zod schemas: used across route handlers to eliminate duplication.
 */
import { z } from "zod";
import { ATTACHMENT_LIMITS } from "../../shared/attachments.ts";
import { decodeBase64Url } from "../../shared/base64url.ts";

// ── TypeScript Interfaces ──────────────────────────────────────────

export interface EmailMetadata {
	id: string;
	subject: string;
	sender: string;
	recipient: string;
	cc?: string | null;
	bcc?: string | null;
	date: string;
	read: boolean;
	starred: boolean;
	in_reply_to?: string | null;
	email_references?: string | null;
	thread_id?: string | null;
	folder_id?: string | null;
	snippet?: string | null;
}

export interface EmailFull extends EmailMetadata {
	body?: string | null;
	message_id?: string | null;
	raw_headers?: string | null;
	attachments?: AttachmentInfo[];
}

export interface AttachmentInfo {
	id: string;
	filename: string;
	mimetype: string;
	size: number;
	content_id?: string | null;
	disposition?: string | null;
}

// ── Zod Schemas ────────────────────────────────────────────────────

const RecipientFieldSchema = z.union([
	z.string().email(),
	z.array(z.string().email()).min(1),
]);

export const ErrorResponseSchema = z.object({
	error: z.string(),
});

/**
 * A reference to a file to attach (the upload-first model). The client sends
 * these instead of the bytes; the server resolves them from R2 at send time.
 */
export const AttachmentRefSchema = z.discriminatedUnion("kind", [
	z.object({
		kind: z.literal("upload"),
		uploadId: z.string().min(1),
		disposition: z.enum(["attachment", "inline"]).optional(),
	}),
	z.object({
		kind: z.literal("existing"),
		emailId: z.string().min(1),
		attachmentId: z.string().min(1),
		disposition: z.enum(["attachment", "inline"]).optional(),
	}),
]);

export const SaveDraftRequestSchema = z
	.object({
		to: z.string().optional(),
		cc: z.string().optional(),
		bcc: z.string().optional(),
		subject: z.string().optional(),
		body: z.string(),
		in_reply_to: z.string().optional(),
		thread_id: z.string().optional(),
		draft_id: z.string().optional(),
		draft_version: z.number().int().min(1).optional(),
		attachments: z
			.array(AttachmentRefSchema)
			.max(ATTACHMENT_LIMITS.maxFiles)
			.optional(),
	})
	.refine(
		(data) =>
			(data.draft_id === undefined) ===
			(data.draft_version === undefined),
		{
			message: "Draft ID and version must be provided together",
			path: ["draft_version"],
		},
	);

export const SendEmailRequestSchema = z
	.object({
		to: RecipientFieldSchema,
		cc: RecipientFieldSchema.optional(),
		bcc: RecipientFieldSchema.optional(),
		from: z.union([
			z.string().email(),
			z.object({ email: z.string().email(), name: z.string() }),
		]),
		subject: z.string(),
		html: z.string().optional(),
		text: z.string().optional(),
		attachments: z.array(AttachmentRefSchema).max(ATTACHMENT_LIMITS.maxFiles).optional(),
		in_reply_to: z.string().optional(),
		references: z.array(z.string()).optional(),
		thread_id: z.string().optional(),
		source_draft_id: z.string().optional(),
		source_draft_version: z.number().int().min(1).optional(),
		idempotency_key: z.string().min(8),
		scheduled_for: z.string().datetime().optional(),
	})
	.refine((data) => data.html || data.text, {
		message: "Either 'html' or 'text' must be provided",
	})
	.refine(
		(data) =>
			(data.source_draft_id === undefined) ===
			(data.source_draft_version === undefined),
		{
			message: "Source draft ID and version must be provided together",
			path: ["source_draft_version"],
		},
	);

export const SendEmailResponseSchema = z.object({
	deliveryId: z.string(),
	id: z.string(),
	emailId: z.string(),
	status: z.string(),
	undoUntil: z.string().datetime(),
	scheduledFor: z.string().datetime().nullable(),
	replayed: z.boolean(),
});

const P256dhSchema = z.string().refine(
	(value) => {
		const bytes = decodeBase64Url(value);
		return bytes?.byteLength === 65 && bytes[0] === 0x04;
	},
	{ message: "p256dh must be a 65-byte uncompressed P-256 public key" },
);

const PushAuthSecretSchema = z.string().refine(
	(value) => decodeBase64Url(value)?.byteLength === 16,
	{ message: "auth must be a 16-byte Web Push authentication secret" },
);

const PushEndpointSchema = z.string().url().refine(
	(value) => {
		try {
			return new URL(value).protocol === "https:";
		} catch {
			return false;
		}
	},
	{ message: "endpoint must use HTTPS" },
);

/**
 * A device push subscription as the browser's PushManager serialises it
 * (`subscription.toJSON()`). userAgent + deviceLabel are derived server-side
 * from the request, never trusted from the client (WISER-240).
 */
export const PushSubscriptionSchema = z.object({
	endpoint: PushEndpointSchema,
	keys: z.object({
		p256dh: P256dhSchema,
		auth: PushAuthSecretSchema,
	}),
});
