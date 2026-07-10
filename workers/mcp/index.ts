// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { resolveBrand, type BrandConfig } from "../routes/brand";
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
import {
	listQuizzes,
	getQuizById,
	getQuizByKey,
	attemptCounts,
	listResults,
	getAttemptById,
	getQuestion,
	listQuestions,
	listQuestionSubmissions,
	getAnswers,
	gradeAnswer,
	parseOptions,
	parseCorrect,
	parseSelected,
} from "../quiz/queries";
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

/** MCP server identity for a brand — name, title, marketing URL, connector icons. */
function mcpServerInfo(b: BrandConfig) {
	return {
		name: `${b.id}-mail`,
		version: "1.0.0",
		title: b.appName,
		websiteUrl: b.websiteUrl,
		// MCP-native server icons (spec 2025-11-25). Best-effort connector branding:
		// clients that honor serverInfo.icons show the brand mark. Absolute https URLs
		// on the brand's prod host; PNG first (universally supported) then SVG fallback.
		icons: [
			{
				src: `${b.mailOrigin}${b.pwaIcon512}`,
				mimeType: "image/png",
				sizes: ["512x512"],
			},
			{
				src: `${b.mailOrigin}${b.mark}`,
				mimeType: "image/svg+xml",
				sizes: ["any"],
			},
		],
	};
}

/**
 * EmailMCP — exposes email tools over the Model Context Protocol, scoped per
 * authenticated user (locked-decisions D-64). Identity arrives as `this.props`,
 * set from the bearer token by the /mcp auth handler:
 *   - Reads:  ADMIN may target any mailbox; AGENT is confined to their own.
 *   - Writes/sends: every role acts only on their own mailbox.
 */
export class EmailMCP extends McpAgent<Env, unknown, McpProps> {
	// Brand-aware connector identity. `this.env` is set by the McpAgent base
	// constructor before this field initializes; resolveBrand fails safe to
	// whispyr if the BRAND var is ever absent.
	server = new McpServer(mcpServerInfo(resolveBrand(this.env.BRAND)));

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

		// ── Quiz tools (ADMIN only) ────────────────────────────────
		// Read all reps' quiz answers and grade them (partial credit, "accept anyway",
		// short-answer marks). Every tool requires an ADMIN token — quiz data spans the
		// whole team, so AGENT sessions get nothing here. Writes reuse the same clamp +
		// recompute path as the admin UI (workers/quiz/queries.ts).
		const requireAdmin = () =>
			this.props?.role === "ADMIN"
				? null
				: mcpError("Quiz tools require an ADMIN token.");

		/** Resolve a quiz by its id or its key ('real-estate-market' | 'whispyr-system'). */
		const resolveQuiz = async (ref: string) =>
			(await getQuizById(env, ref)) ?? (await getQuizByKey(env, ref));

		// ── quiz_overview ──────────────────────────────────────────
		this.server.tool(
			"quiz_overview",
			"ADMIN: list every quiz with its status and attempt counts (submitted / graded). Start here to find a quiz's id/key.",
			{},
			async () => {
				const denied = requireAdmin();
				if (denied) return denied;
				const quizzes = await listQuizzes(env);
				const out = await Promise.all(
					quizzes.map(async (q) => ({
						id: q.id,
						key: q.key,
						title_en: q.title_en,
						title_ar: q.title_ar,
						status: q.status,
						...(await attemptCounts(env, q.id)),
					})),
				);
				return mcpText(out);
			},
		);

		// ── quiz_results ───────────────────────────────────────────
		this.server.tool(
			"quiz_results",
			"ADMIN: the results table for one quiz — every rep with their MCQ / short / total scores, status, and attemptId (pass attemptId to quiz_attempt for the full breakdown).",
			{ quiz: z.string().describe("Quiz id or key (real-estate-market | whispyr-system)") },
			async ({ quiz }) => {
				const denied = requireAdmin();
				if (denied) return denied;
				const q = await resolveQuiz(quiz);
				if (!q) return mcpError(`Quiz "${quiz}" not found. Use quiz_overview to list quizzes.`);
				return mcpText({ quiz: { id: q.id, key: q.key, status: q.status }, results: await listResults(env, q.id) });
			},
		);

		// ── quiz_attempt ───────────────────────────────────────────
		this.server.tool(
			"quiz_attempt",
			"ADMIN: one rep's full attempt — every question with its correct answer, the rep's selected/typed answer, the awarded points, auto-correctness, and any note. This is how you read the answers to grade them.",
			{ attemptId: z.string().describe("The attempt id (from quiz_results)") },
			async ({ attemptId }) => {
				const denied = requireAdmin();
				if (denied) return denied;
				const attempt = await getAttemptById(env, attemptId);
				if (!attempt) return mcpError(`Attempt "${attemptId}" not found.`);
				const questions = await listQuestions(env, attempt.quiz_id);
				const answers = await getAnswers(env, attempt.id);
				const ansByQ = new Map(answers.map((a) => [a.question_id, a]));
				const rep = (await listResults(env, attempt.quiz_id)).find((r) => r.attemptId === attempt.id);

				const detail = questions.map((q) => {
					const a = ansByQ.get(q.id);
					const base = {
						questionId: q.id,
						answerId: a?.id ?? null,
						position: q.position,
						type: q.type,
						points: q.points,
						prompt_en: q.prompt_en,
						prompt_ar: q.prompt_ar,
						awarded: a?.awarded_points ?? null,
						grader_note: a?.grader_note ?? null,
					};
					if (q.type === "short") {
						return { ...base, rubric_en: q.rubric_en, rubric_ar: q.rubric_ar, text_answer: a?.text_answer ?? null };
					}
					return {
						...base,
						options: parseOptions(q),
						correct: parseCorrect(q),
						selected: a ? parseSelected(a) : [],
						is_correct: a?.is_correct ?? null,
						explanation_en: q.explanation_en,
						explanation_ar: q.explanation_ar,
					};
				});

				return mcpText({
					attempt: {
						id: attempt.id,
						quiz_id: attempt.quiz_id,
						status: attempt.status,
						mcq_score: attempt.mcq_score,
						mcq_max: attempt.mcq_max,
						short_score: attempt.short_score,
						short_max: attempt.short_max,
						total_score: attempt.total_score,
						total_max: attempt.total_max,
					},
					rep: rep ? { userId: rep.userId, email: rep.email, mailbox: rep.mailbox } : null,
					questions: detail,
				});
			},
		);

		// ── quiz_question ──────────────────────────────────────────
		this.server.tool(
			"quiz_question",
			"ADMIN: one question with every rep's answer to it, for grading the same question across the whole team. Each submission includes its answerId (pass to quiz_grade_answer).",
			{ questionId: z.string().describe("The question id (from quiz_attempt)") },
			async ({ questionId }) => {
				const denied = requireAdmin();
				if (denied) return denied;
				const q = await getQuestion(env, questionId);
				if (!q) return mcpError(`Question "${questionId}" not found.`);
				return mcpText({
					question: {
						id: q.id,
						quiz_id: q.quiz_id,
						position: q.position,
						type: q.type,
						points: q.points,
						prompt_en: q.prompt_en,
						prompt_ar: q.prompt_ar,
						options: parseOptions(q),
						correct: parseCorrect(q),
						rubric_en: q.rubric_en,
						rubric_ar: q.rubric_ar,
					},
					submissions: await listQuestionSubmissions(env, q.id),
				});
			},
		);

		// ── quiz_grade_answer ──────────────────────────────────────
		this.server.tool(
			"quiz_grade_answer",
			"ADMIN: set the awarded points (+ optional note) for ONE answer — partial credit or accepting a wrong answer. Points are clamped to [0, the question's max] in 0.5 steps; the owning attempt's totals are recomputed automatically.",
			{
				answerId: z.string().describe("The answer id (from quiz_attempt or quiz_question)"),
				points: z.number().describe("Points to award (0 to the question's max; 0.5 steps)"),
				note: z.string().optional().describe("Optional note shown to the rep after grading"),
			},
			async ({ answerId, points, note }) => {
				const denied = requireAdmin();
				if (denied) return denied;
				const res = await gradeAnswer(env, answerId, points, note ?? "");
				if (!res.ok) return mcpError(`Answer "${answerId}" not found.`);
				return mcpText({
					ok: true,
					questionId: res.question.id,
					attempt: {
						id: res.attempt.id,
						status: res.attempt.status,
						mcq_score: res.attempt.mcq_score,
						short_score: res.attempt.short_score,
						total_score: res.attempt.total_score,
						total_max: res.attempt.total_max,
					},
				});
			},
		);
	}
}
