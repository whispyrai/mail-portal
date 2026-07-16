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
import type {
	EnqueueOutboundCommand,
	OutboundDeliveryStatus,
	OutboundDeliverySource,
} from "./outbound-delivery-contract.ts";
import { validateResolvedInlineImages } from "./inline-image-authority.ts";
import {
	outboundReplyIntentFingerprint,
	withOutboundCommandFingerprint,
} from "./outbound-command-fingerprint.ts";
import {
	draftCreateFingerprint,
	draftToolCreateKey,
	draftToolUpdateFingerprint,
	draftToolUpdateKey,
	type DraftToolInvocation,
	type DraftToolUpdateInvocation,
} from "./draft-create-idempotency.ts";

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
	resolveOutboundReplay: (input: {
		idempotencyKey: string;
		commandFingerprint: string;
	}) => Promise<
		| { status: "none" }
		| {
				status: "exact";
				delivery: {
					id: string;
					emailId: string;
					status: OutboundDeliveryStatus;
					undoUntil: string;
				};
		  }
		| {
				status: "conflict";
				reason: "command_mismatch" | "legacy_idempotency_unverifiable";
			  }
	>;
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

function outboundConflictResult(
	reason: "command_mismatch" | "legacy_idempotency_unverifiable",
) {
	return {
		error: "This send identity is already bound to another command.",
		code: reason,
	};
}

async function reconcileToolOutboundEnqueueFailure(
	stub: OutboundEnqueueStub,
	idempotencyKey: string,
	commandFingerprint: string,
	originalError: unknown,
) {
	let resolution: Awaited<
		ReturnType<OutboundEnqueueStub["resolveOutboundReplay"]>
	>;
	try {
		resolution = await stub.resolveOutboundReplay({
			idempotencyKey,
			commandFingerprint,
		});
	} catch {
		throw originalError;
	}
	if (resolution.status === "exact") {
		return replayedOutboundResult(resolution.delivery);
	}
	if (resolution.status === "conflict") {
		return outboundConflictResult(resolution.reason);
	}
	throw originalError;
}

type ToolDraftCreateError = {
	error: string;
	code?: "draft_create_conflict" | "draft_create_superseded" | "draft_create_replay_unavailable";
	draftId?: string;
	currentVersion?: number;
};

type ToolDraftCreateResult =
	| {
			draftId: string;
			threadId: string;
			body: string;
			replayed: boolean;
		}
	| ToolDraftCreateError;

function readToolDraftReplay(
	draft: { id: string; thread_id: string | null; body: string | null },
): ToolDraftCreateResult {
	return {
		draftId: draft.id,
		threadId: draft.thread_id || draft.id,
		body: draft.body ?? "",
		replayed: true,
	};
}

async function prepareToolDraftCreation(
	stub: ReturnType<typeof getMailboxStub>,
	mailboxId: string,
	input: {
		subject: string;
		recipient: string;
		body: string;
		inReplyTo: string | null;
		threadId?: string;
	},
	actor: ActivityActor,
	invocation: DraftToolInvocation,
): Promise<
	| { createKey: string; createFingerprint: string }
	| { result: ToolDraftCreateResult }
> {
	const [createKey, createFingerprint] = await Promise.all([
		draftToolCreateKey({ mailboxId, actor, invocation }),
		draftCreateFingerprint({
			to: input.recipient,
			subject: input.subject,
			body: input.body,
			in_reply_to: input.inReplyTo ?? undefined,
			thread_id: input.threadId,
			attachments: [],
		}),
	]);
	const replay = await stub.getDraftCreateReplay(createKey, createFingerprint);
	if (replay.status === "missing") return { createKey, createFingerprint };
	if (replay.status === "replay") {
		return { result: readToolDraftReplay(replay.draft) };
	}
	if (replay.status === "conflict") {
		return {
			result: {
				error: "This Draft invocation was already used for different content.",
				code: "draft_create_conflict",
				draftId: replay.draftId,
				currentVersion: replay.currentVersion,
			},
		};
	}
	if (replay.status === "unavailable") {
		return {
			result: {
				error: "The original Draft is no longer available for replay.",
				code: "draft_create_replay_unavailable",
				draftId: replay.draftId,
				currentVersion: replay.currentVersion,
			},
		};
	}
	return {
		result: {
			error: "The original Draft was changed after this invocation created it.",
			code: "draft_create_superseded",
			draftId: replay.draftId,
			currentVersion: replay.currentVersion,
		},
	};
}

async function persistToolDraft(
	stub: ReturnType<typeof getMailboxStub>,
	mailboxId: string,
	input: {
		subject: string;
		recipient: string;
		body: string;
		inReplyTo: string | null;
		threadId?: string;
	},
	identity: { createKey: string; createFingerprint: string },
	actor: ActivityActor,
): Promise<ToolDraftCreateResult> {
	const draftId = crypto.randomUUID();
	const threadId = input.threadId ?? draftId;

	// Per Cloudflare's SQLite Durable Object storage docs (api/sqlite-storage-api),
	// transactionSync is one synchronous transaction. The Mailbox RPC, not this
	// Worker preflight, elects the only concurrent retry winner.
	const result = await stub.upsertDraft(
		{
			id: draftId,
			createKey: identity.createKey,
			createFingerprint: identity.createFingerprint,
			subject: input.subject,
			sender: mailboxId.toLowerCase(),
			recipient: input.recipient.toLowerCase(),
			cc: null,
			bcc: null,
			body: input.body,
			in_reply_to: input.inReplyTo,
			thread_id: threadId,
		},
		[],
		actor,
	);

	if (result.status === "saved") {
		return {
			draftId: result.draftId,
			threadId,
			body: input.body,
			replayed: false,
		};
	}
	if (result.status === "creation_replay") {
		return readToolDraftReplay(result.draft);
	}
	if (result.status === "creation_conflict") {
		return {
			error: "This Draft invocation was already used for different content.",
			code: "draft_create_conflict",
			draftId: result.draftId,
			currentVersion: result.currentVersion,
		};
	}
	if (result.status === "creation_superseded") {
		return {
			error: "The original Draft was changed after this invocation created it.",
			code: "draft_create_superseded",
			draftId: result.draftId,
			currentVersion: result.currentVersion,
		};
	}
	if (result.status === "creation_unavailable") {
		return {
			error: "The original Draft is no longer available for replay.",
			code: "draft_create_replay_unavailable",
			draftId: result.draftId,
			currentVersion: result.currentVersion,
		};
	}
	return { error: "Draft creation could not be completed safely." };
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
	actor: ActivityActor,
	invocation: DraftToolInvocation,
): Promise<
	| {
			status: "draft_saved";
			draftId: string;
			replayed: boolean;
			message: string;
			draft: Record<string, string>;
		}
	| ToolDraftCreateError
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
	const inlineMapping = validateResolvedInlineImages(processedBody, []);
	if (!inlineMapping.ok) return { error: inlineMapping.error };
	const prepared = await prepareToolDraftCreation(
		stub,
		mailboxId,
		{
			subject: params.subject,
			recipient: params.to,
			body: processedBody,
			inReplyTo: params.originalEmailId,
		},
		actor,
		invocation,
	);
	let persisted: ToolDraftCreateResult;

	if ("result" in prepared) {
		persisted = prepared.result;
	} else {
		// Get the original email for thread_id and quoted text only after an exact
		// replay has been ruled out from durable state.
		const original = (await stub.getEmail(params.originalEmailId)) as EmailFull | null;
		const threadId = original?.thread_id || params.originalEmailId;
		const quotedBlock = original
			? buildQuotedReplyBlock({
					date: original.date,
					sender: original.sender || params.to,
					body: original.body ?? undefined,
				})
			: "";
		persisted = await persistToolDraft(
			stub,
			mailboxId,
			{
				subject: params.subject,
				recipient: params.to,
				body: processedBody + quotedBlock,
				inReplyTo: params.originalEmailId,
				threadId,
			},
			prepared,
			actor,
		);
	}
	if ("error" in persisted) return persisted;

	return {
		status: "draft_saved",
		draftId: persisted.draftId,
		replayed: persisted.replayed,
		message: persisted.replayed
			? "The existing Draft was recovered from this exact invocation. Review it and confirm to send."
			: "Draft saved to Drafts folder. Review it and confirm to send.",
		draft: {
			originalEmailId: params.originalEmailId,
			to: params.to,
			subject: params.subject,
			body: params.isPlainText ? params.body.trim() : persisted.body,
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
	actor: ActivityActor,
	invocation: DraftToolInvocation,
): Promise<
	| {
			status: "draft_saved";
			draftId: string;
			threadId: string;
			replayed: boolean;
			message: string;
			draft: Record<string, string>;
		}
	| ToolDraftCreateError
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
	const inlineMapping = validateResolvedInlineImages(processedBody, []);
	if (!inlineMapping.ok) return { error: inlineMapping.error };
	const prepared = await prepareToolDraftCreation(
		stub,
		mailboxId,
		{
			subject: params.subject,
			recipient: params.to || "",
			body: processedBody,
			inReplyTo: params.in_reply_to || null,
			threadId: params.thread_id,
		},
		actor,
		invocation,
	);
	let persisted: ToolDraftCreateResult;

	if ("result" in prepared) {
		persisted = prepared.result;
	} else {
		let resolvedThreadId = params.thread_id;
		if (!resolvedThreadId && params.in_reply_to) {
			const original = (await stub.getEmail(params.in_reply_to)) as EmailFull | null;
			resolvedThreadId = original?.thread_id || params.in_reply_to;
		}
		persisted = await persistToolDraft(
			stub,
			mailboxId,
			{
				subject: params.subject,
				recipient: params.to || "",
				body: processedBody,
				inReplyTo: params.in_reply_to || null,
				threadId: resolvedThreadId,
			},
			prepared,
			actor,
		);
	}
	if ("error" in persisted) return persisted;

	return {
		status: "draft_saved",
		draftId: persisted.draftId,
		threadId: persisted.threadId,
		replayed: persisted.replayed,
		message: persisted.replayed
			? "The existing Draft was recovered from this exact invocation. Review it and confirm to send."
			: "Draft saved to Drafts folder. Review it and confirm to send.",
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
	invocation?: DraftToolUpdateInvocation,
): Promise<
	| {
			status: string;
			newDraftId: string;
			oldDraftId: string;
			draftVersion?: number;
			replayed?: boolean;
			message: string;
		}
	| { error: string; currentVersion?: number; code?: string }
> {
	const stub = getMailboxStub(env, mailboxId);
	const updateIdentity = invocation
		? {
				updateKey: await draftToolUpdateKey({ mailboxId, actor, invocation }),
				fingerprint: await draftToolUpdateFingerprint(params),
			}
		: null;
	if (updateIdentity) {
		const outcome = await stub.getDraftUpdateOutcome(
			updateIdentity.updateKey,
			updateIdentity.fingerprint,
		);
		if (outcome.status === "replay") {
			return {
				status: "draft_updated",
				newDraftId: outcome.draftId,
				oldDraftId: outcome.draftId,
				draftVersion: outcome.resultVersion,
				replayed: true,
				message: "This exact Draft update already committed. Read the Draft before making another update.",
			};
		}
		if (outcome.status === "conflict") {
			return {
				error: "This MCP request ID was already used for different Draft update data.",
				code: "draft_update_idempotency_conflict",
			};
		}
	}

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
	const inlineMapping = validateResolvedInlineImages(
		verifiedBody,
		oldDraft.attachments ?? [],
	);
	if (!inlineMapping.ok) return { error: inlineMapping.error };

	const changes = {
		subject: params.subject ?? oldDraft.subject,
		recipient: params.to ?? oldDraft.recipient,
		body: verifiedBody,
	};
	const result = updateIdentity
		? await stub.updateDraftIdempotently({
				...updateIdentity,
				draftId: params.draftId,
				expectedVersion: params.draftVersion,
				changes,
				actor,
			})
		: await stub.updateDraft(
				params.draftId,
				params.draftVersion,
				changes,
				actor,
			);
	if (result?.status === "idempotency_conflict") {
		return {
			error: "This MCP request ID was already used for different Draft update data.",
			code: "draft_update_idempotency_conflict",
		};
	}
	if (result?.status === "version_conflict") {
		return {
			error: "Draft changed in another session. Reload it before updating.",
			currentVersion: result.currentVersion,
		};
	}
	if (!result || (result.status !== "updated" && result.status !== "replay")) {
		return { error: "Draft could not be updated safely" };
	}

	return {
		status: "draft_updated",
		newDraftId: params.draftId,
		oldDraftId: params.draftId,
		draftVersion: result.draftVersion,
		replayed: result.status === "replay",
		message: result.status === "replay"
			? "This exact Draft update already committed. Read the Draft before making another update."
			: "Draft updated in Drafts folder.",
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
	const draft = await stub.getEmail(draftId);
	if (!draft) return { error: "Draft not found" };
	if (draft.folder_id !== Folders.DRAFT) {
		return { error: "Cannot discard: email is not a draft" };
	}
	const result = await stub.discardDraft(
		draftId,
		draft.draft_version ?? 1,
		actor,
	);
	if (result === null) {
		return { error: "Draft not found" };
	}
	if (result.status === "not_draft") {
		return { error: "Cannot discard: email is not a draft" };
	}
	if (result.status === "version_conflict") {
		return {
			error: "Draft changed before it could be discarded. Retry with the latest draft.",
			currentVersion: result.currentVersion,
		};
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
	| { error: string; code?: string }
> {
	const stub = getMailboxStub(env, mailboxId);
	const fromDomain = mailboxId.split("@")[1];
	if (!fromDomain) throw new Error("Invalid mailbox email address");
	const { requestedAt, undoUntil } = outboundTiming();
	const intentCommand = {
		idempotencyKey: params.idempotencyKey,
		source: outboundSource(actor),
		actor,
		snapshot: {
			mailboxId: mailboxId.toLowerCase(),
			kind: "reply" as const,
			to: [params.to.toLowerCase()],
			cc: [],
			bcc: [],
			from: mailboxId.toLowerCase(),
			subject: params.subject,
			html: params.bodyHtml,
			threadId: "",
			attachmentIds: [],
			attachmentByteIdentities: [],
		},
		requestedAt,
		undoUntil,
	};
	const intentFingerprint = await outboundReplyIntentFingerprint(
		intentCommand,
		[],
		params.originalEmailId,
	);
	const replay = await (stub as unknown as OutboundEnqueueStub).resolveOutboundReplay({
		idempotencyKey: params.idempotencyKey,
		commandFingerprint: intentFingerprint,
	});
	if (replay.status === "exact") return replayedOutboundResult(replay.delivery);

	const originalEmail = (await stub.getEmail(params.originalEmailId)) as EmailFull | null;
	if (!originalEmail) {
		return replay.status === "conflict"
			? {
					error: "This legacy send identity cannot be verified without its source message.",
					code: "legacy_idempotency_unverifiable",
				}
			: { error: "Original email not found" };
	}

	const { originalMsgId, references, threadId } = buildReferencesChain(originalEmail);

	// Verify and append quoted original message
	const sanitizedBody = await verifyDraft(params.bodyHtml);
	if (!sanitizedBody) {
		return { error: "Draft verification failed — refusing to send unverified content. Please try again." };
	}
	const inlineMapping = validateResolvedInlineImages(sanitizedBody, []);
	if (!inlineMapping.ok) return { error: inlineMapping.error };
	const quotedBlock = buildQuotedReplyBlock({
		date: originalEmail.date,
		sender: originalEmail.sender || params.to,
		body: originalEmail.body ?? undefined,
	});
	const fullBodyHtml = sanitizedBody + quotedBlock;

	const legacyCommand = await withOutboundCommandFingerprint({
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
			attachmentByteIdentities: [],
		},
		requestedAt,
		undoUntil,
	}, [], { sourceEmailId: params.originalEmailId });
	if (replay.status === "conflict") {
		const legacyReplay = await (
			stub as unknown as OutboundEnqueueStub
		).resolveOutboundReplay({
			idempotencyKey: params.idempotencyKey,
			commandFingerprint: legacyCommand.commandFingerprint,
		});
		if (legacyReplay.status === "exact") {
			return replayedOutboundResult(legacyReplay.delivery);
		}
		return outboundConflictResult(replay.reason);
	}
	const command = { ...legacyCommand, commandFingerprint: intentFingerprint };
	const rateLimitError = await (stub as unknown as RateLimitStub)
		.checkSendRateLimit();
	if (rateLimitError) return { error: rateLimitError };
	const { messageId } = generateMessageId(fromDomain);
	const outboundStub = stub as unknown as OutboundEnqueueStub;
	let result;
	try {
		result = await outboundStub.enqueueOutbound(command, [], messageId);
	} catch (error) {
		return reconcileToolOutboundEnqueueFailure(
			outboundStub,
			params.idempotencyKey,
			command.commandFingerprint,
			error,
		);
	}
	if (result.replayed) return replayedOutboundResult(result.delivery);

	return {
		status: result.delivery.status,
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
	| { error: string; code?: string }
> {
	const stub = getMailboxStub(env, mailboxId);

	const fromDomain = mailboxId.split("@")[1];
	if (!fromDomain) throw new Error("Invalid mailbox email address");

	const sanitizedBody = await verifyDraft(params.bodyHtml);
	if (!sanitizedBody) {
		return { error: "Draft verification failed — refusing to send unverified content. Please try again." };
	}
	const inlineMapping = validateResolvedInlineImages(sanitizedBody, []);
	if (!inlineMapping.ok) return { error: inlineMapping.error };

	const { requestedAt, undoUntil } = outboundTiming();
	const command = await withOutboundCommandFingerprint({
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
			threadId: "generated",
			attachmentIds: [],
			attachmentByteIdentities: [],
		},
		requestedAt,
		undoUntil,
	}, []);
	const replay = await (
		stub as unknown as OutboundEnqueueStub
	).resolveOutboundReplay({
		idempotencyKey: params.idempotencyKey,
		commandFingerprint: command.commandFingerprint,
	});
	if (replay.status === "exact") return replayedOutboundResult(replay.delivery);
	if (replay.status === "conflict") {
		return outboundConflictResult(replay.reason);
	}
	const rateLimitError = await (stub as unknown as RateLimitStub)
		.checkSendRateLimit();
	if (rateLimitError) return { error: rateLimitError };
	const { messageId } = generateMessageId(fromDomain);
	const outboundStub = stub as unknown as OutboundEnqueueStub;
	let result;
	try {
		result = await outboundStub.enqueueOutbound(
			{
				...command,
				snapshot: { ...command.snapshot, threadId: messageId },
			},
			[],
			messageId,
		);
	} catch (error) {
		return reconcileToolOutboundEnqueueFailure(
			outboundStub,
			params.idempotencyKey,
			command.commandFingerprint,
			error,
		);
	}
	if (result.replayed) return replayedOutboundResult(result.delivery);

	return {
		status: result.delivery.status,
		deliveryId: result.delivery.id,
		messageId: result.delivery.emailId,
		undoUntil: result.delivery.undoUntil,
		replayed: result.replayed,
		message: `Email queued for ${params.to}`,
	};
}
