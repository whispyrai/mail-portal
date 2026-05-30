// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
	toolListMailboxes,
	toolListEmails,
	toolGetEmail,
	toolGetThread,
	toolSearchEmails,
	toolDraftReply,
	toolDraftEmail,
	toolUpdateDraft,
	toolDeleteEmail,
	toolSendReply,
	toolSendEmail,
	toolMarkEmailRead,
	toolMoveEmail,
} from "../lib/tools";
import { Folders, FOLDER_TOOL_DESCRIPTION, MOVE_FOLDER_TOOL_DESCRIPTION } from "../../shared/folders";
import type { UserRole } from "../db/users-schema";
import type { Env } from "../types";

/** Per-connection identity, injected via ctx.props by the /mcp auth handler. */
interface McpProps {
	userId: string;
	role: UserRole;
	mailbox: string;
	// McpAgent's props generic requires an index signature (Record<string, unknown>).
	[key: string]: unknown;
}

/** Wrap a plain result object into MCP content format. */
function mcpText(result: unknown) {
	return {
		content: [
			{ type: "text" as const, text: JSON.stringify(result, null, 2) },
		],
	};
}

/** Wrap an error string into MCP error format. */
function mcpError(message: string) {
	return {
		content: [{ type: "text" as const, text: JSON.stringify({ error: message }) }],
		isError: true as const,
	};
}

/**
 * Wrap a result that may contain an `error` field into MCP format,
 * automatically setting isError when appropriate.
 */
function mcpResult(result: Record<string, unknown>) {
	if ("error" in result) {
		return {
			content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
			isError: true as const,
		};
	}
	return mcpText(result);
}

const MAILBOX_ARG_DESCRIPTION =
	"The mailbox email address. Omit to use your own mailbox; ADMIN sessions may target another mailbox for read operations.";

/**
 * EmailMCP — exposes email tools over the Model Context Protocol, scoped per
 * authenticated user (locked-decisions D-64). Identity arrives as `this.props`,
 * set from the bearer token by the /mcp auth handler:
 *   - Reads:  ADMIN may target any mailbox; AGENT is confined to their own.
 *   - Writes/sends: every role acts only on their own mailbox.
 */
export class EmailMCP extends McpAgent<Env, unknown, McpProps> {
	server = new McpServer({
		name: "whispyr-mail",
		version: "1.0.0",
		title: "Whispyr Mail",
		websiteUrl: "https://whispyrai.com",
		// MCP-native server icons (spec 2025-11-25). Best-effort connector branding:
		// clients that honor serverInfo.icons show the Whispyr mark. Absolute https
		// URLs on the prod host; PNG first (universally supported) then SVG fallback.
		icons: [
			{
				src: "https://mail.whispyrcrm.com/icon-512.png",
				mimeType: "image/png",
				sizes: ["512x512"],
			},
			{
				src: "https://mail.whispyrcrm.com/whispyr-mark.svg",
				mimeType: "image/svg+xml",
				sizes: ["any"],
			},
		],
	});

	/**
	 * Resolve the effective mailbox for a request, enforcing scope. Returns the
	 * mailbox id to act on, or an error message if the caller is not allowed.
	 */
	#resolveMailbox(
		requested: string | undefined,
		mode: "read" | "write",
	): { mailboxId: string } | { error: string } {
		const props = this.props;
		if (!props?.mailbox) return { error: "Unauthenticated MCP session." };
		const own = props.mailbox.toLowerCase();
		const req = requested?.toLowerCase();

		if (mode === "write") {
			if (req && req !== own) {
				return { error: "Forbidden: you can only act on your own mailbox." };
			}
			return { mailboxId: props.mailbox };
		}
		// read
		if (props.role === "ADMIN") return { mailboxId: requested || props.mailbox };
		if (req && req !== own) {
			return { error: "Forbidden: you can only access your own mailbox." };
		}
		return { mailboxId: props.mailbox };
	}

	async init() {
		const env = this.env;

		/** Verify a mailbox exists in R2; returns an MCP error response or null. */
		const verifyMailbox = async (mailboxId: string) => {
			const obj = await env.BUCKET.head(`mailboxes/${mailboxId}.json`);
			if (!obj) {
				return mcpError(`Mailbox "${mailboxId}" not found. Use list_mailboxes to see available mailboxes.`);
			}
			return null;
		};

		// ── list_mailboxes ─────────────────────────────────────────
		this.server.tool(
			"list_mailboxes",
			"List the mailboxes you can access (your own; all of them for ADMIN).",
			{},
			async () => {
				const all = (await toolListMailboxes(env)) as { id: string }[];
				const own = this.props?.mailbox?.toLowerCase() ?? "";
				const visible =
					this.props?.role === "ADMIN"
						? all
						: all.filter((m) => m.id.toLowerCase() === own);
				return mcpText(visible);
			},
		);

		// ── list_emails ────────────────────────────────────────────
		this.server.tool(
			"list_emails",
			"List emails in a mailbox folder. Returns email metadata (id, subject, sender, recipient, date, read/starred status, thread_id).",
			{
				mailboxId: z.string().optional().describe(MAILBOX_ARG_DESCRIPTION),
				folder: z
					.string()
					.default(Folders.INBOX)
					.describe(FOLDER_TOOL_DESCRIPTION),
				limit: z
					.number()
					.default(20)
					.describe("Maximum number of emails to return"),
				page: z
					.number()
					.default(1)
					.describe("Page number for pagination"),
			},
			async ({ mailboxId, folder, limit, page }) => {
				const scoped = this.#resolveMailbox(mailboxId, "read");
				if ("error" in scoped) return mcpError(scoped.error);
				const denied = await verifyMailbox(scoped.mailboxId);
				if (denied) return denied;
				const result = await toolListEmails(env, scoped.mailboxId, { folder, limit, page });
				return mcpText(result);
			},
		);

		// ── get_email ──────────────────────────────────────────────
		this.server.tool(
			"get_email",
			"Get a single email with its full body content. Use this to read the actual content of an email.",
			{
				mailboxId: z.string().optional().describe(MAILBOX_ARG_DESCRIPTION),
				emailId: z.string().describe("The email ID to retrieve"),
			},
			async ({ mailboxId, emailId }) => {
				const scoped = this.#resolveMailbox(mailboxId, "read");
				if ("error" in scoped) return mcpError(scoped.error);
				const denied = await verifyMailbox(scoped.mailboxId);
				if (denied) return denied;
				const result = await toolGetEmail(env, scoped.mailboxId, emailId);
				if ("error" in result) {
					return {
						content: [{ type: "text" as const, text: "Email not found" }],
						isError: true,
					};
				}
				return mcpText(result);
			},
		);

		// ── get_thread ─────────────────────────────────────────────
		this.server.tool(
			"get_thread",
			"Get all emails in a conversation thread. Returns all messages sorted chronologically.",
			{
				mailboxId: z.string().optional().describe(MAILBOX_ARG_DESCRIPTION),
				threadId: z
					.string()
					.describe("The thread_id to retrieve all messages for"),
			},
			async ({ mailboxId, threadId }) => {
				const scoped = this.#resolveMailbox(mailboxId, "read");
				if ("error" in scoped) return mcpError(scoped.error);
				const denied = await verifyMailbox(scoped.mailboxId);
				if (denied) return denied;
				const result = await toolGetThread(env, scoped.mailboxId, threadId);
				return mcpText(result);
			},
		);

		// ── search_emails ──────────────────────────────────────────
		this.server.tool(
			"search_emails",
			"Search for emails matching a query across subject and body fields.",
			{
				mailboxId: z.string().optional().describe(MAILBOX_ARG_DESCRIPTION),
				query: z.string().describe("Search query to match against subject and body"),
				folder: z
					.string()
					.optional()
					.describe("Optional folder to restrict search to"),
			},
			async ({ mailboxId, query, folder }) => {
				const scoped = this.#resolveMailbox(mailboxId, "read");
				if ("error" in scoped) return mcpError(scoped.error);
				const denied = await verifyMailbox(scoped.mailboxId);
				if (denied) return denied;
				const result = await toolSearchEmails(env, scoped.mailboxId, { query, folder });
				return mcpText(result);
			},
		);

		// ── draft_reply ────────────────────────────────────────────
		this.server.tool(
			"draft_reply",
			"Draft a reply to an email and save it to the Drafts folder. Does NOT send — saves a draft for review.",
			{
				mailboxId: z.string().optional().describe(MAILBOX_ARG_DESCRIPTION),
				originalEmailId: z
					.string()
					.describe("The ID of the email being replied to"),
				to: z.string().email().describe("Recipient email address"),
				subject: z.string().describe("Subject line (usually 'Re: ...')"),
				bodyHtml: z
					.string()
					.describe("The HTML body of the reply"),
			},
			async ({ mailboxId, originalEmailId, to, subject, bodyHtml }) => {
				const scoped = this.#resolveMailbox(mailboxId, "write");
				if ("error" in scoped) return mcpError(scoped.error);
				const denied = await verifyMailbox(scoped.mailboxId);
				if (denied) return denied;
				const result = await toolDraftReply(env, scoped.mailboxId, {
					originalEmailId,
					to,
					subject,
					body: bodyHtml,
					isPlainText: false,
					runVerifyDraft: true,
				});
				return mcpResult(result);
			},
		);

		// ── create_draft ───────────────────────────────────────────
		this.server.tool(
			"create_draft",
			"Create a new draft email. Can be a new email or a reply draft.",
			{
				mailboxId: z.string().optional().describe(MAILBOX_ARG_DESCRIPTION),
				to: z
					.string()
					.optional()
					.describe("Recipient email address (optional for early drafts)"),
				subject: z.string().describe("Subject line"),
				bodyHtml: z.string().describe("The HTML body of the draft"),
				in_reply_to: z
					.string()
					.optional()
					.describe("The ID of the email this draft is replying to (optional)"),
				thread_id: z
					.string()
					.optional()
					.describe("Thread ID to attach this draft to (optional)"),
			},
			async ({ mailboxId, to, subject, bodyHtml, in_reply_to, thread_id }) => {
				const scoped = this.#resolveMailbox(mailboxId, "write");
				if ("error" in scoped) return mcpError(scoped.error);
				const denied = await verifyMailbox(scoped.mailboxId);
				if (denied) return denied;
				const result = await toolDraftEmail(env, scoped.mailboxId, {
					to: to || "",
					subject,
					body: bodyHtml,
					isPlainText: false,
					runVerifyDraft: true,
					in_reply_to,
					thread_id,
				});
				if ("error" in result) {
					return mcpResult(result);
				}
				return mcpText({
					status: "draft_created",
					draftId: result.draftId,
					threadId: result.threadId,
					message: "Draft created in Drafts folder.",
				});
			},
		);

		// ── update_draft ───────────────────────────────────────────
		this.server.tool(
			"update_draft",
			"Update an existing draft email's content.",
			{
				mailboxId: z.string().optional().describe(MAILBOX_ARG_DESCRIPTION),
				draftId: z.string().describe("The ID of the draft to update"),
				to: z
					.string()
					.optional()
					.describe("Updated recipient email address"),
				subject: z.string().optional().describe("Updated subject line"),
				bodyHtml: z.string().optional().describe("Updated HTML body"),
			},
			async ({ mailboxId, draftId, to, subject, bodyHtml }) => {
				const scoped = this.#resolveMailbox(mailboxId, "write");
				if ("error" in scoped) return mcpError(scoped.error);
				const denied = await verifyMailbox(scoped.mailboxId);
				if (denied) return denied;
				const result = await toolUpdateDraft(env, scoped.mailboxId, {
					draftId,
					to,
					subject,
					bodyHtml,
				});
				if ("error" in result) {
					if (result.error === "Draft not found") {
						return {
							content: [{ type: "text" as const, text: "Draft not found" }],
							isError: true,
						};
					}
					return mcpResult(result);
				}
				return mcpText(result);
			},
		);

		// ── delete_email ───────────────────────────────────────────
		this.server.tool(
			"delete_email",
			"Permanently delete an email by ID.",
			{
				mailboxId: z.string().optional().describe(MAILBOX_ARG_DESCRIPTION),
				emailId: z.string().describe("The email ID to delete"),
			},
			async ({ mailboxId, emailId }) => {
				const scoped = this.#resolveMailbox(mailboxId, "write");
				if ("error" in scoped) return mcpError(scoped.error);
				const denied = await verifyMailbox(scoped.mailboxId);
				if (denied) return denied;
				const result = await toolDeleteEmail(env, scoped.mailboxId, emailId);
				return mcpResult(result);
			},
		);

		// ── send_reply ─────────────────────────────────────────────
		this.server.tool(
			"send_reply",
			"Send a reply to an email. Only call after drafting and getting confirmation.",
			{
				mailboxId: z.string().optional().describe(MAILBOX_ARG_DESCRIPTION),
				originalEmailId: z
					.string()
					.describe("The ID of the email being replied to"),
				to: z.string().email().describe("Recipient email address"),
				subject: z.string().describe("Subject line"),
				bodyHtml: z.string().describe("The HTML body of the reply"),
			},
			async ({ mailboxId, originalEmailId, to, subject, bodyHtml }) => {
				const scoped = this.#resolveMailbox(mailboxId, "write");
				if ("error" in scoped) return mcpError(scoped.error);
				const denied = await verifyMailbox(scoped.mailboxId);
				if (denied) return denied;
				const result = await toolSendReply(env, scoped.mailboxId, {
					originalEmailId,
					to,
					subject,
					bodyHtml,
				});
				if ("error" in result) {
					if (typeof result.error === "string" && result.error.startsWith("Failed to send")) {
						return {
							content: [{ type: "text" as const, text: result.error }],
							isError: true,
						};
					}
					if (result.error === "Original email not found") {
						return {
							content: [{ type: "text" as const, text: "Original email not found" }],
							isError: true,
						};
					}
					return mcpResult(result);
				}
				return mcpText(result);
			},
		);

		// ── send_email ─────────────────────────────────────────────
		this.server.tool(
			"send_email",
			"Send a new email (not a reply). Only call after getting confirmation.",
			{
				mailboxId: z.string().optional().describe(MAILBOX_ARG_DESCRIPTION),
				to: z.string().email().describe("Recipient email address"),
				subject: z.string().describe("Subject line"),
				bodyHtml: z.string().describe("The HTML body of the email"),
			},
			async ({ mailboxId, to, subject, bodyHtml }) => {
				const scoped = this.#resolveMailbox(mailboxId, "write");
				if ("error" in scoped) return mcpError(scoped.error);
				const denied = await verifyMailbox(scoped.mailboxId);
				if (denied) return denied;
				const result = await toolSendEmail(env, scoped.mailboxId, {
					to,
					subject,
					bodyHtml,
				});
				if ("error" in result) {
					if (typeof result.error === "string" && result.error.startsWith("Failed to send")) {
						return {
							content: [{ type: "text" as const, text: result.error }],
							isError: true,
						};
					}
					return mcpResult(result);
				}
				return mcpText(result);
			},
		);

		// ── mark_email_read ────────────────────────────────────────
		this.server.tool(
			"mark_email_read",
			"Mark an email as read or unread.",
			{
				mailboxId: z.string().optional().describe(MAILBOX_ARG_DESCRIPTION),
				emailId: z.string().describe("The email ID"),
				read: z.boolean().describe("true to mark as read, false for unread"),
			},
			async ({ mailboxId, emailId, read }) => {
				const scoped = this.#resolveMailbox(mailboxId, "write");
				if ("error" in scoped) return mcpError(scoped.error);
				const denied = await verifyMailbox(scoped.mailboxId);
				if (denied) return denied;
				const result = await toolMarkEmailRead(env, scoped.mailboxId, emailId, read);
				return mcpText(result);
			},
		);

		// ── move_email ─────────────────────────────────────────────
		this.server.tool(
			"move_email",
			"Move an email to a different folder (inbox, sent, draft, archive, trash).",
			{
				mailboxId: z.string().optional().describe(MAILBOX_ARG_DESCRIPTION),
				emailId: z.string().describe("The email ID"),
				folderId: z
					.string()
					.describe(MOVE_FOLDER_TOOL_DESCRIPTION),
			},
			async ({ mailboxId, emailId, folderId }) => {
				const scoped = this.#resolveMailbox(mailboxId, "write");
				if ("error" in scoped) return mcpError(scoped.error);
				const denied = await verifyMailbox(scoped.mailboxId);
				if (denied) return denied;
				const result = await toolMoveEmail(env, scoped.mailboxId, emailId, folderId);
				if ("error" in result) {
					return {
						content: [
							{
								type: "text" as const,
								text: JSON.stringify({ error: "Failed to move email" }),
							},
						],
						isError: true,
					};
				}
				return mcpText(result);
			},
		);
	}
}
