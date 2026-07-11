// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Shared tool business logic for the Agent and MCP server.
 *
 * Each function takes an `env: Env` (or a DO stub) and tool-specific params,
 * performs the business logic (DO calls, data fetching, formatting), and
 * returns a plain object. The Agent and MCP server wrap these results in
 * their own response formats.
 *
 * Functions that already exist in email-helpers.ts (getFullEmail, getFullThread)
 * are reused directly — this module covers the remaining shared operations.
 */

import type { EmailFull } from "./schemas.ts";
import {
	getMailboxStub,
	getFullEmail,
	getFullThread,
	buildQuotedReplyBlock,
	textToHtml,
	listMailboxes,
	generateMessageId,
	buildReferencesChain,
} from "./email-helpers.ts";
import { verifyDraft } from "./ai.ts";
import { Folders } from "../../shared/folders.ts";
import type { Env } from "../types.ts";
import type { ActivityActor } from "./activity.ts";
import { attachmentKey } from "./attachments.ts";
import type {
	EnqueueOutboundCommand,
	OutboundDeliveryStatus,
	OutboundDeliverySource,
} from "./outbound-delivery-contract.ts";

// ── Type casts for DO methods not on the base stub type ────────────
type MailboxSearchStub = {
	searchEmails: (options: {
		query: string;
		folder?: string;
	}) => Promise<unknown>;
};

type RateLimitStub = {
	checkSendRateLimit: () => Promise<string | null>;
};

type OutboundEnqueueStub = {
	getOutboundDeliveryByIdempotencyKey: (
		idempotencyKey: string,
	) => Promise<{
		id: string;
		emailId: string;
		status: OutboundDeliveryStatus;
		undoUntil: string;
	} | null>;
	enqueueOutbound: (
		command: EnqueueOutboundCommand,
		attachments: readonly [],
		emailId: string,
	) => Promise<{
		delivery: {
			id: string;
			emailId: string;
			status: OutboundDeliveryStatus;
			undoUntil: string;
		};
		replayed: boolean;
	}>;
};

function outboundSource(actor: ActivityActor): OutboundDeliverySource {
	if (actor.kind === "mcp") return "mcp";
	if (actor.kind === "agent") return "agent";
	if (actor.kind === "rule") return "rule";
	return "api";
}

function outboundTiming() {
	const requestedAt = new Date().toISOString();
	return {
		requestedAt,
		undoUntil: new Date(Date.parse(requestedAt) + 10_000).toISOString(),
	};
}

type ToolOutboundResult = {
	status: OutboundDeliveryStatus;
	deliveryId: string;
	messageId: string;
	undoUntil: string;
	replayed: boolean;
	message: string;
};

function replayedOutboundResult(
	delivery: {
		id: string;
		emailId: string;
		status: OutboundDeliveryStatus;
		undoUntil: string;
	},
): ToolOutboundResult {
	return {
		status: delivery.status,
		deliveryId: delivery.id,
		messageId: delivery.emailId,
		undoUntil: delivery.undoUntil,
		replayed: true,
		message: `This send action already exists with status ${delivery.status}.`,
	};
}

// ── list_mailboxes ─────────────────────────────────────────────────

export async function toolListMailboxes(env: Env) {
	return listMailboxes(env.BUCKET);
}

// ── list_emails ────────────────────────────────────────────────────

export async function toolListEmails(
	env: Env,
	mailboxId: string,
	params: { folder: string; limit: number; page: number },
) {
	const stub = getMailboxStub(env, mailboxId);
	return stub.getEmails({
		folder: params.folder,
		limit: params.limit,
		page: params.page,
		sortColumn: "date",
		sortDirection: "DESC",
	});
}

// ── get_email ──────────────────────────────────────────────────────

export async function toolGetEmail(
	env: Env,
	mailboxId: string,
	emailId: string,
) {
	const stub = getMailboxStub(env, mailboxId);
	const email = await getFullEmail(stub, emailId);
	if (!email) return { error: "Email not found" };
	return email;
}

// ── get_thread ─────────────────────────────────────────────────────

export async function toolGetThread(
	env: Env,
	mailboxId: string,
	threadId: string,
) {
	const stub = getMailboxStub(env, mailboxId);
	return getFullThread(stub, threadId);
}

// ── search_emails ──────────────────────────────────────────────────

export async function toolSearchEmails(
	env: Env,
	mailboxId: string,
	params: { query: string; folder?: string },
) {
	const stub = getMailboxStub(env, mailboxId);
	return (stub as unknown as MailboxSearchStub).searchEmails({
		query: params.query,
		folder: params.folder,
	});
}

// ── draft_reply ────────────────────────────────────────────────────

/**
 * Shared draft-reply logic.
 *
 * @param bodyInput - The reply body text. Can be plain text or HTML.
 * @param options.isPlainText - If true, body is treated as plain text and
 *   converted to HTML. If false, body is treated as HTML.
 * @param options.runVerifyDraft - If true, deterministically scrubs assistant artifacts.
 *   The agent and MCP both do this, but the agent does it on plain text
 *   while MCP does it on HTML.
 */
export async function toolDraftReply(
	env: Env,
	mailboxId: string,
	params: {
		originalEmailId: string;
		to: string;
		subject: string;
		body: string;
		isPlainText?: boolean;
		runVerifyDraft?: boolean;
	},
	actor: ActivityActor = { kind: "system" },
): Promise<
	| { status: "draft_saved"; draftId: string; message: string; draft: Record<string, string> }
	| { error: string }
> {
	const stub = getMailboxStub(env, mailboxId);

	// Verify/sanitize if requested
	let processedBody = params.body.trim();
	if (params.runVerifyDraft) {
		const sanitized = await verifyDraft(processedBody);
		if (!sanitized) {
			return { error: "Draft verification failed — body could not be verified. Please try again." };
		}
		processedBody = sanitized;
	}

	// Convert plain text to HTML if needed
	if (params.isPlainText) {
		processedBody = textToHtml(processedBody);
	}

	const draftId = crypto.randomUUID();

	// Get the original email for thread_id and quoted text
	const original = (await stub.getEmail(params.originalEmailId)) as EmailFull | null;
	const threadId = original?.thread_id || params.originalEmailId;

	// Append quoted original message
	const quotedBlock = original
		? buildQuotedReplyBlock({
				date: original.date,
				sender: original.sender || params.to,
				body: original.body ?? undefined,
			})
		: "";
	const bodyHtml = processedBody + quotedBlock;

	await stub.createEmail(
		Folders.DRAFT,
		{
			id: draftId,
			subject: params.subject,
			sender: mailboxId.toLowerCase(),
			recipient: params.to.toLowerCase(),
			date: new Date().toISOString(),
			body: bodyHtml,
			in_reply_to: params.originalEmailId,
			email_references: null,
			thread_id: threadId,
		},
		[],
		actor,
	);

	return {
		status: "draft_saved",
		draftId,
		message: "Draft saved to Drafts folder. Review it and confirm to send.",
		draft: {
			originalEmailId: params.originalEmailId,
			to: params.to,
			subject: params.subject,
			body: params.isPlainText ? params.body.trim() : bodyHtml,
		},
	};
}

// ── draft_email (new email, not a reply) ───────────────────────────

export async function toolDraftEmail(
	env: Env,
	mailboxId: string,
	params: {
		to: string;
		subject: string;
		body: string;
		isPlainText?: boolean;
		runVerifyDraft?: boolean;
		/** Optional in_reply_to for create_draft style */
		in_reply_to?: string;
		/** Optional thread_id for create_draft style */
		thread_id?: string;
	},
	actor: ActivityActor = { kind: "system" },
): Promise<
	| { status: string; draftId: string; threadId?: string; message: string; draft?: Record<string, string> }
	| { error: string }
> {
	const stub = getMailboxStub(env, mailboxId);

	let processedBody = params.body.trim();
	if (params.runVerifyDraft) {
		const sanitized = await verifyDraft(processedBody);
		if (!sanitized) {
			return { error: "Draft verification failed — body could not be verified. Please try again." };
		}
		processedBody = sanitized;
	}

	if (params.isPlainText) {
		processedBody = textToHtml(processedBody);
	}

	const draftId = crypto.randomUUID();

	// Resolve thread ID
	let resolvedThreadId = params.thread_id;
	if (!resolvedThreadId && params.in_reply_to) {
		const original = (await stub.getEmail(params.in_reply_to)) as EmailFull | null;
		resolvedThreadId = original?.thread_id || params.in_reply_to;
	}
	if (!resolvedThreadId) {
		resolvedThreadId = draftId;
	}

	await stub.createEmail(
		Folders.DRAFT,
		{
			id: draftId,
			subject: params.subject,
			sender: mailboxId.toLowerCase(),
			recipient: (params.to || "").toLowerCase(),
			date: new Date().toISOString(),
			body: processedBody,
			in_reply_to: params.in_reply_to || null,
			email_references: null,
			thread_id: resolvedThreadId,
		},
		[],
		actor,
	);

	return {
		status: "draft_saved",
		draftId,
		threadId: resolvedThreadId,
		message: "Draft saved to Drafts folder. Review it and confirm to send.",
		draft: {
			to: params.to,
			subject: params.subject,
			body: params.isPlainText ? params.body.trim() : processedBody,
		},
	};
}

// ── update_draft ───────────────────────────────────────────────────

export async function toolUpdateDraft(
	env: Env,
	mailboxId: string,
	params: {
		draftId: string;
		draftVersion: number;
		to?: string;
		subject?: string;
		bodyHtml?: string;
	},
	actor: ActivityActor = { kind: "system" },
): Promise<
	| { status: string; newDraftId: string; oldDraftId: string; message: string }
	| { error: string; currentVersion?: number }
> {
	const stub = getMailboxStub(env, mailboxId);

	const oldDraft = (await stub.getEmail(params.draftId)) as EmailFull | null;
	if (!oldDraft) {
		return { error: "Draft not found" };
	}

	// Verify before applying the in-place update so rejected output leaves the
	// source draft and its attachments untouched.
	const rawBody = params.bodyHtml ?? oldDraft.body ?? "";
	const verifiedBody = await verifyDraft(rawBody);

	if (!verifiedBody) {
		return { error: "Draft verification failed — keeping existing draft unchanged. Please try again." };
	}

	const result = await stub.updateDraft(
		params.draftId,
		params.draftVersion,
		{
			subject: params.subject ?? oldDraft.subject,
			recipient: params.to ?? oldDraft.recipient,
			body: verifiedBody,
		},
		actor,
	);
	if (result?.status === "version_conflict") {
		return {
			error: "Draft changed in another session. Reload it before updating.",
			currentVersion: result.currentVersion,
		};
	}
	if (!result || result.status !== "updated") {
		return { error: "Draft could not be updated safely" };
	}

	return {
		status: "draft_updated",
		newDraftId: params.draftId,
		oldDraftId: params.draftId,
		message: "Draft updated in Drafts folder.",
	};
}

// ── mark_email_read ────────────────────────────────────────────────

export async function toolMarkEmailRead(
	env: Env,
	mailboxId: string,
	emailId: string,
	read: boolean,
	actor: ActivityActor = { kind: "system" },
) {
	const stub = getMailboxStub(env, mailboxId);
	await stub.updateEmail(emailId, { read }, actor);
	return { status: "updated", emailId, read };
}

// ── move_email ─────────────────────────────────────────────────────

export async function toolMoveEmail(
	env: Env,
	mailboxId: string,
	emailId: string,
	folderId: string,
	actor: ActivityActor = { kind: "system" },
) {
	const stub = getMailboxStub(env, mailboxId);
	const success = await stub.moveEmail(emailId, folderId, actor);
	if (
		typeof success === "object" &&
		success?.status === "outbound_delivery_active"
	) {
		return {
			error: "Cancel the queued send before moving its Outbox message.",
			code: "active_outbound_delivery_requires_cancel",
			deliveryId: success.deliveryId,
		};
	}
	if (success) {
		return { status: "moved", emailId, folder: folderId };
	}
	return { error: "Failed to move email" };
}

// ── discard_draft ──────────────────────────────────────────────────

export async function toolDiscardDraft(
	env: Env,
	mailboxId: string,
	draftId: string,
	actor: ActivityActor = { kind: "system" },
) {
	const stub = getMailboxStub(env, mailboxId);
	const result = await stub.discardDraft(draftId, actor);
	if (result === null) {
		return { error: "Draft not found" };
	}
	if (result.status === "not_draft") {
		return { error: "Cannot discard: email is not a draft" };
	}
	if (result.attachments.length > 0) {
		const keys = result.attachments.map((attachment) =>
			attachmentKey(draftId, attachment.id, attachment.filename),
		);
		try {
			await env.BUCKET.delete(keys);
		} catch (error) {
			console.error("[draft-discard] failed to remove orphaned attachment objects", {
				draftId,
				error: error instanceof Error ? error.message : String(error),
			});
			await stub.queueAttachmentCleanup(draftId, keys, actor);
		}
	}
	return { status: "discarded", draftId };
}

// ── delete_email ───────────────────────────────────────────────────

export async function toolDeleteEmail(
	env: Env,
	mailboxId: string,
	emailId: string,
	actor: ActivityActor = { kind: "system" },
) {
	const stub = getMailboxStub(env, mailboxId);
	const result = await stub.trashEmail(emailId, actor);
	if (result === null) {
		return { error: "Email not found", emailId };
	}
	if (result.status === "outbound_delivery_active") {
		return {
			error: "Cancel the queued send before moving its Outbox message.",
			code: "active_outbound_delivery_requires_cancel",
			deliveryId: result.deliveryId,
			emailId,
		};
	}
	return { status: result.status, emailId };
}

// ── send_reply ─────────────────────────────────────────────────────

export async function toolSendReply(
	env: Env,
	mailboxId: string,
	params: {
		originalEmailId: string;
		to: string;
		subject: string;
		bodyHtml: string;
		idempotencyKey: string;
	},
	actor: ActivityActor = { kind: "system" },
): Promise<
	| ToolOutboundResult
	| { error: string }
> {
	const stub = getMailboxStub(env, mailboxId);
	const existing = await (
		stub as unknown as OutboundEnqueueStub
	).getOutboundDeliveryByIdempotencyKey(params.idempotencyKey);
	if (existing) return replayedOutboundResult(existing);

	// Check send rate limit
	const rateLimitError = await (stub as unknown as RateLimitStub).checkSendRateLimit();
	if (rateLimitError) {
		return { error: rateLimitError };
	}

	const originalEmail = (await stub.getEmail(params.originalEmailId)) as EmailFull | null;
	if (!originalEmail) {
		return { error: "Original email not found" };
	}

	const { originalMsgId, references, threadId } = buildReferencesChain(originalEmail);
	const fromDomain = mailboxId.split("@")[1];
	if (!fromDomain) throw new Error("Invalid mailbox email address");
	const { messageId } = generateMessageId(fromDomain);

	// Verify and append quoted original message
	const sanitizedBody = await verifyDraft(params.bodyHtml);
	if (!sanitizedBody) {
		return { error: "Draft verification failed — refusing to send unverified content. Please try again." };
	}
	const quotedBlock = buildQuotedReplyBlock({
		date: originalEmail.date,
		sender: originalEmail.sender || params.to,
		body: originalEmail.body ?? undefined,
	});
	const fullBodyHtml = sanitizedBody + quotedBlock;

	const { requestedAt, undoUntil } = outboundTiming();
	const result = await (stub as unknown as OutboundEnqueueStub).enqueueOutbound(
		{
			idempotencyKey: params.idempotencyKey,
			source: outboundSource(actor),
			actor,
			snapshot: {
				mailboxId: mailboxId.toLowerCase(),
				kind: "reply",
				to: [params.to.toLowerCase()],
				cc: [],
				bcc: [],
				from: mailboxId.toLowerCase(),
				subject: params.subject,
				html: fullBodyHtml,
				inReplyTo: originalMsgId,
				references,
				threadId,
				attachmentIds: [],
			},
			requestedAt,
			undoUntil,
		},
		[],
		messageId,
	);

	return {
		status: "queued",
		deliveryId: result.delivery.id,
		messageId: result.delivery.emailId,
		undoUntil: result.delivery.undoUntil,
		replayed: result.replayed,
		message: `Reply queued for ${params.to}`,
	};
}

// ── send_email ─────────────────────────────────────────────────────

export async function toolSendEmail(
	env: Env,
	mailboxId: string,
	params: {
		to: string;
		subject: string;
		bodyHtml: string;
		idempotencyKey: string;
	},
	actor: ActivityActor = { kind: "system" },
): Promise<
	| ToolOutboundResult
	| { error: string }
> {
	const stub = getMailboxStub(env, mailboxId);
	const existing = await (
		stub as unknown as OutboundEnqueueStub
	).getOutboundDeliveryByIdempotencyKey(params.idempotencyKey);
	if (existing) return replayedOutboundResult(existing);

	// Check send rate limit
	const rateLimitError = await (stub as unknown as RateLimitStub).checkSendRateLimit();
	if (rateLimitError) {
		return { error: rateLimitError };
	}

	const fromDomain = mailboxId.split("@")[1];
	if (!fromDomain) throw new Error("Invalid mailbox email address");
	const { messageId } = generateMessageId(fromDomain);

	const sanitizedBody = await verifyDraft(params.bodyHtml);
	if (!sanitizedBody) {
		return { error: "Draft verification failed — refusing to send unverified content. Please try again." };
	}

	const { requestedAt, undoUntil } = outboundTiming();
	const result = await (stub as unknown as OutboundEnqueueStub).enqueueOutbound(
		{
			idempotencyKey: params.idempotencyKey,
			source: outboundSource(actor),
			actor,
			snapshot: {
				mailboxId: mailboxId.toLowerCase(),
				kind: "compose",
				to: [params.to.toLowerCase()],
				cc: [],
				bcc: [],
				from: mailboxId.toLowerCase(),
				subject: params.subject,
				html: sanitizedBody,
				threadId: messageId,
				attachmentIds: [],
			},
			requestedAt,
			undoUntil,
		},
		[],
		messageId,
	);

	return {
		status: "queued",
		deliveryId: result.delivery.id,
		messageId: result.delivery.emailId,
		undoUntil: result.delivery.undoUntil,
		replayed: result.replayed,
		message: `Email queued for ${params.to}`,
	};
}
